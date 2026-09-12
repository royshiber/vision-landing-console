# Telemetry archive

Dedicated store for flight MAVLink bytes the console is **explicitly asked to keep**, separate from uploaded `log_artifacts`.

Recording is **operator-armed**. Default is not recording. Connect, power-on, and idle MAVLink do **not** open a session file. Bytes are written only after **Start** and until **Stop**.

## Location

Relative to the console repo:

```
data/flights/archive/
```

Resolved at runtime from `lib/db.mjs` `dataDir` → `data/flights/archive/`. Session files are `*.tlog` (raw MAVLink). SQLite table `telemetry_archive` is the index (path, bytes, frames, link role, downlink state).

Do not put secrets or Jetson addresses in these files' names.

## Operator record gate

1. Default: archive sink disabled. No new `.tlog` on mere connect.
2. Mission chrome control **הקלטה** / **מקליט** (Start → Stop). Armed state is visible on the button.
3. While armed: same path and format as before (`.tlog` + `telemetry_archive` row).
4. **Stop** finalizes the session (`ended_at`, byte/frame counters). A zero-byte file still closes, and the API warns that nothing was recorded.
5. Optional **discard** (`POST /api/telemetry-archive/discard`) closes the session, deletes the file, and removes the index row.
6. Start/stop failures return Hebrew `messageHe` and must not look armed. Start while MAVLink is down is allowed, with a warn that the file stays empty until bytes arrive.
7. Process boot finalizes orphan rows (`ended_at` null) as `interrupted`.
8. GET exposes real session `bytes` / `frames`, optional `lastWriteError`, and `droppedWrites`. No invented bandwidth.

The in-process raw-byte sink still receives every MAVLink chunk the console sees. It **returns immediately** unless recording is armed.

## Schema (index)

Table `telemetry_archive`:

| Column | Meaning |
|---|---|
| `id` | Session row |
| `flight_id` | Optional link to `flights` |
| `link_role` | `radio` or `cellular` |
| `stored_path` | Absolute path of the `.tlog` |
| `bytes` / `frames` | Counters |
| `started_at` / `ended_at` | Session window (`ended_at` set on Stop) |
| `downlink_state` | `local` until a live modem sync exists. Process-boot orphans are marked `interrupted`. |

## Priority and backpressure

Flight timing wins. The in-process queue (`lib/telemetry-archive.mjs`) has three levels:

0. **FLIGHT** — parse and send MAVLink. Never waits on disk or modem.
1. **ARCHIVE_WRITE** — local append. Dropped when the archive buffer is full. Enqueued only while recording is armed.
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

- `GET /api/telemetry-archive` — path, schema, queue stats, modem stub status, **`recording`** (`armed`, `session` bytes/frames, `lastWriteError`, `droppedWrites`), `linkUp`
- `POST /api/telemetry-archive/start` — arm recording only after the session file opens. Soft-warns in Hebrew when the MAVLink link is down.
- `POST /api/telemetry-archive/stop` — disarm and finalize (`ended_at`). Zero-byte stop still succeeds and warns that nothing was recorded.
- `POST /api/telemetry-archive/discard` — disarm, delete the current file and index row
- `POST /api/telemetry-archive/downlink` — enqueue a low-priority sync stub
