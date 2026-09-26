# Jetson flight logger (Part A)

Separate service `airvix-flightlog`. It reads the companion relay as a local TCP client (`127.0.0.1:5770`) and never writes to that socket. It does not open a flight-controller serial port. Part B (dataflash download) is not in this service: `fc_log.state` stays `not_implemented`.

Deploying or enabling the unit on a Jetson is a Human Gate.

## Enable

Default is off. `AIRVIX_FLIGHTLOG_ENABLED` unset or `0` writes a status file with `enabled: false` and the process exits 0.

`install.sh --enable-flightlog` copies `airvix-flightlog.service` only when combined with `--apply`. Dry-run does not copy it. The script never starts the unit.

Rollback:

```
systemctl disable --now airvix-flightlog
```

## Environment

| Key | Default | Role |
| --- | --- | --- |
| AIRVIX_FLIGHTLOG_ENABLED | 0 | Master switch |
| AIRVIX_FLIGHTLOG_RELAY | 127.0.0.1:5770 | Local tap |
| AIRVIX_FLIGHTLOG_DIR | /var/lib/airvix/flightlog | Spool. Falls back to ~/airvix-flightlog |
| AIRVIX_FLIGHTLOG_STATUS_FILE | /run/airvix/flightlog.json | Status. Falls back to spool/status.json |
| AIRVIX_FLIGHTLOG_TLOG_QUOTA_MB | 2048 | Disk cap |
| AIRVIX_FLIGHTLOG_RETENTION_DAYS | 14 | Age cap |
| AIRVIX_FLIGHTLOG_PREROLL_S | 60 | Window before arm |
| AIRVIX_FLIGHTLOG_POSTROLL_S | 30 | Window after close |
| AIRVIX_FLIGHTLOG_JOURNAL_UNITS | companion, flightlog, modem, NetworkManager, tailscaled | journalctl -u list |
| AIRVIX_VEHICLE_ID | hostname | Key prefix |
| AIRVIX_FD_* | design §3 | Detector thresholds |
| AIRVIX_S3_ENDPOINT | empty | S3 endpoint. GCS: `https://storage.googleapis.com` |
| AIRVIX_S3_REGION | empty | SigV4 region. GCS: `auto` |
| AIRVIX_S3_BUCKET | empty | Bucket. Provisioned name: `airvix-flight-logs-489409` |
| AIRVIX_S3_KEY_ID | empty | HMAC access id. Status reports present or absent only |
| AIRVIX_S3_SECRET | empty | HMAC secret. Never logged |
| AIRVIX_UPLOAD_ENABLED | unset | Unset follows credentials. `0` forces idle |
| AIRVIX_UPLOAD_* | empty | Aliases for the `AIRVIX_S3_*` names. `AIRVIX_UPLOAD_APP_KEY` aliases the secret |
| AIRVIX_UPLOAD_PREFIX | v1 | Key prefix. `AIRVIX_S3_PREFIX` wins when set |
| AIRVIX_UPLOAD_CELLULAR | all | all, core, or never |
| AIRVIX_UPLOAD_CELL_DAILY_MB | 500 | Non-control cellular cap |
| AIRVIX_UPLOAD_WHILE_ARMED | control_only | control_only or none |
| AIRVIX_UPLOAD_BW_KBPS | 256 | Landed throttle |

Copy `scripts/jetson-companion/flightlog.env.example` to `/etc/airvix/flightlog.env`.

The Jetson file is `~/vlc-companion/flightlog-storage.env`, mode 600. The unit loads it with `EnvironmentFile=-%h/vlc-companion/flightlog-storage.env` and the absolute path `/home/royshiber/vlc-companion/flightlog-storage.env`. A missing file does not stop the unit. The process also reads that file when the variables are still unset.

If endpoint, region, bucket, key id, or secret is empty, upload stays disabled: `uploader.enabled` false, `reason` `no_credential`, `credential` `absent`. When all five `AIRVIX_S3_*` values are set and `AIRVIX_UPLOAD_ENABLED` is unset, upload turns on. `AIRVIX_UPLOAD_ENABLED=0` forces idle. The process does not crash. Packages remain in the spool. Segments that overlap a flight whose upload is not complete are kept. Other segments follow the 14-day / 2048 MB cap. Setting the variables later and restarting drains the SQLite queue.

## Spool

```
spool/tlog/YYYYMMDD/HHMMSSZ.tlog
spool/flights/<flight_id>/manifest.json
spool/flights/<flight_id>/summary.json
spool/flights/<flight_id>/events.jsonl.gz
spool/flights/<flight_id>/series.json.gz
spool/flights/<flight_id>/track.geojson.gz
spool/flights/<flight_id>/telemetry.tlog.gz
spool/flights/<flight_id>/jetson/journal.jsonl.gz
spool/flights/<flight_id>/jetson/system.jsonl.gz
spool/uploads.sqlite
spool/state.json
```

`flight_id` is `<arm UTC YYYYMMDDTHHMMSSZ>-<vehicle>-<4 hex sha256>`.

Bench and ground_run packages are `complete` (no dataflash in Part A). Flight and unknown_no_telemetry packages are `awaiting_fc_log`.

Object keys: `v1/<vehicle_id>/...`.

## Status file

`ok`, `present`, `enabled`, `reason`, `state` (`idle|armed_ground|airborne|landed_armed|packaging`), `current_flight_id`, `detector`, `tap`, `tlog`, `uploader` (`credential` is `present` or `absent` only), `fc_log` (`enabled: false`, `state: not_implemented`), `flights_local` (last 20), `updated_utc`, `version`.

The companion exposes the same document at `GET /api/flight-log/status` and `GET /api/v1/flight-log/status`, and under `flight_log` on health and status. Missing file: `present: false`, `state: absent`. No POST in Part A.

Local relay clients on `127.0.0.1` count as `local_tap_clients` when `VLC_LOCAL_TAP_SEPARATE=1` (default). They are still fanned out. They are not counted in `relay_clients`.

## Object storage (S3)

The uploader speaks path-style S3 (AWS Signature Version 4, `AWS4-HMAC-SHA256`, service `s3`, region `auto`). It does not send flight commands or write parameters.

The Jetson HMAC key is create-only. A new object PUT returns 200. GET, DELETE, LIST, and overwrite are denied. The uploader therefore uses a single PUT per object. It does not call HEAD, GET, or LIST to see if a key exists. Large files are split into separate part objects (`.partNNNN` plus `.parts.json`), each its own PUT, not an S3 multipart session. On Google Cloud Storage the PUT sends `x-goog-if-generation-match: 0`. A 412 means the object is already stored and the job is done. The uploader does not read it back.

Keys are unique per flight and per segment:

- `v1/<vehicle_id>/flights/<flight_id>/<artifact>`
- `v1/<vehicle_id>/index/<flight_id>.json` once, when the package is closed
- `v1/<vehicle_id>/index/<flight_id>--in_flight.json` and `--processing.json` for earlier states

Google Cloud Storage interoperability, file `~/vlc-companion/flightlog-storage.env` mode 600:

| Setting | Value |
| --- | --- |
| `AIRVIX_S3_ENDPOINT` | `https://storage.googleapis.com` |
| `AIRVIX_S3_REGION` | `auto` |
| `AIRVIX_S3_BUCKET` | `airvix-flight-logs-489409` |
| `AIRVIX_S3_KEY_ID` | HMAC access id |
| `AIRVIX_S3_SECRET` | HMAC secret |

Do not commit the secret. The status file and HTTP responses never include it. Use the global endpoint. The signer puts the bucket in the path (`/bucket/key`), not in the host. `AIRVIX_UPLOAD_*` names, including `AIRVIX_UPLOAD_APP_KEY`, remain aliases.

## Flight controller stream

Recommend `SR3_EXTRA3 >= 1` so the tap sees position. The Jetson does not write parameters. Roy sets that in Mission Planner.

## Human Gate checklist

1. Confirm Part A is still read-only toward the flight controller.
2. Copy files with `install.sh --apply` on the Jetson.
3. Install `/etc/airvix/flightlog.env` with placeholders first and confirm status `enabled: false`.
4. Only then set `AIRVIX_FLIGHTLOG_ENABLED=1` and enable the unit.
5. Put the create-only HMAC values in `~/vlc-companion/flightlog-storage.env` (mode 600). Endpoint `https://storage.googleapis.com`, region `auto`, bucket `airvix-flight-logs-489409`.
6. Rollback with `systemctl disable --now airvix-flightlog`.
