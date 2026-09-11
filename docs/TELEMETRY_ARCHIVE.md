# Telemetry archive

Dedicated store for **all flight MAVLink bytes** the console sees, separate from uploaded `log_artifacts`.

## Location

Relative to the console repo:

```
data/flights/archive/
```

Resolved at runtime from `lib/db.mjs` `dataDir` → `data/flights/archive/`. Session files are `*.tlog` (raw MAVLink). SQLite table `telemetry_archive` is the index (path, bytes, frames, link role, downlink state).

Do not put secrets or Jetson addresses in these files' names.

## Schema (index)

Table `telemetry_archive`:

| Column | Meaning |
|---|---|
| `id` | Session row |
| `flight_id` | Optional link to `flights` |
| `link_role` | `radio` or `cellular` |
| `stored_path` | Absolute path of the `.tlog` |
| `bytes` / `frames` | Counters |
| `started_at` / `ended_at` | Session window |
| `downlink_state` | `local` until a live modem sync exists |

## Priority and backpressure

Flight timing wins. The in-process queue (`lib/telemetry-archive.mjs`) has three levels:

0. **FLIGHT** — parse and send MAVLink. Never waits on disk or modem.
1. **ARCHIVE_WRITE** — local append. Dropped when the archive buffer is full.
2. **DOWNLINK_SYNC** — cellular export. Lowest. Capped so a slow modem cannot fill RAM.

A drain tick (HTTP module, ~250 ms, `unref`) writes queued archive jobs. The MAVLink parse path only **enqueues**; it does not `fs.write` inline.

## Cellular downlink (stub)

Huawei E3372 is **not** required for the archive to work. When the modem is unplugged:

- UI and `GET /api/telemetry-archive` report the modem as absent.
- `POST /api/telemetry-archive/downlink` still enqueues a stub job under the same backpressure rules.
- No Companion-HTTP is used as the telemetry or command path.

When a real modem is present, keep downlink on priority 2. Do not block the radio or cellular MAVLink sockets on export.

Jetson host files for a future Huawei E3372 USB stick live in `scripts/jetson-cellular/` (see `docs/JETSON_CELLULAR_E3372.md`). They are dry-run safe. The console mock / `modem_absent` path stays until that USB id appears. Do not SSH from a Cloud Agent VM.

## API

- `GET /api/telemetry-archive` — path, schema, queue stats, modem stub status
- `POST /api/telemetry-archive/downlink` — enqueue a low-priority sync stub
