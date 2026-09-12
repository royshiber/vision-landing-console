# Flight telemetry store

Local MAVLink / flight logs for the Vision Landing Console.

- Index: SQLite table `telemetry_archive`
- Files: `archive/*.tlog` (gitignored)
- Design: `docs/TELEMETRY_ARCHIVE.md`

This directory is the dedicated persist path for **operator-armed** live downlink (Start → Stop on Mission). Connect alone does not write here. Uploaded operator logs remain in `log_artifacts`.
