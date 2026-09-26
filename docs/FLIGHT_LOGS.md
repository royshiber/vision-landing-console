# Flight book (console)

The console reads flights that the mission computer uploads to a private S3-compatible bucket. The laptop key is **read-only**. This document is the console side. The uploader lives on the Jetson (`docs/FLIGHT_LOGS_JETSON.md`).

The flight page shows the list, timeline, plots, map, and a Hebrew Gemini debrief. The debrief may cite only that flight's fact sheet. The server checks every number, time, and mode. A sentence that fails the check stays on screen greyed, with לא אומת. No `GEMINI_API_KEY` returns the Hebrew not-configured line and the automatic insights only.

## Modes

`FLIGHT_LOGS_MODE` is `off` (default), `mock`, or `cloud`.

| Mode | When | What the UI shows |
| --- | --- | --- |
| `off` | Unset or anything other than `mock` / `cloud` | No flights. Hebrew not-configured state. |
| `mock` | Local fixtures under `tests/fixtures/flight-logs` | Those fixtures only. Never used as a stand-in for a real bucket. |
| `cloud` | All five `AIRVIX_S3_*` values below are set (`FLIGHT_CLOUD_*` still works as aliases) | Read-only bucket. A URL or a partial key set stays **not configured**. |

Mock and off never invent flights in the production UI. If the bucket is not configured, the list is empty even when older rows are still in SQLite.

Not configured (exact copy):

> אחסון הטיסות בענן לא הוגדר. הוסיפו מפתח קריאה בקובץ ‎.env‎ (ראו docs/FLIGHT_LOGS.md)

No flights yet:

> עדיין אין טיסות. אחרי טיסה מחשב המשימה יעלה אותה אוטומטית.

## Read-only key

The console key can GET and LIST objects in this bucket only. It cannot PUT, overwrite, or delete. The Jetson uploader key is a different HMAC key and is create-only.

Google Cloud Storage (S3 interoperability). Same variable names as the Jetson file, with the read-only key in the console `.env`:

- `AIRVIX_S3_ENDPOINT` = `https://storage.googleapis.com`
- `AIRVIX_S3_REGION` = `auto`
- `AIRVIX_S3_BUCKET` = `airvix-flight-logs-489409`
- `AIRVIX_S3_KEY_ID` = HMAC access id
- `AIRVIX_S3_SECRET` = HMAC secret

`FLIGHT_CLOUD_ENDPOINT`, `FLIGHT_CLOUD_REGION`, `FLIGHT_CLOUD_BUCKET`, `FLIGHT_CLOUD_KEY_ID`, `FLIGHT_CLOUD_APP_KEY`, and `FLIGHT_CLOUD_SECRET` remain aliases. `AIRVIX_S3_PREFIX` or `FLIGHT_CLOUD_PREFIX` defaults to `v1`. `AIRVIX_S3_VEHICLES` or `FLIGHT_CLOUD_VEHICLES` is an optional comma list; otherwise the console lists vehicle prefixes. The secret is never logged and never sent to the browser.

The reader lists `v1/<vehicle>/index/` and keeps one object per flight. `…/<flight_id>.json` wins over `…/<flight_id>--in_flight.json` and `--processing.json`. It does not HEAD an object to decide. Downloads use GET. Chunked artifacts are GET of `.parts.json` and each `.partNNNN`.

Object layout: `v1/<vehicle_id>/index/<flight_id>.json` and `v1/<vehicle_id>/flights/<flight_id>/…`. Schemas are in `docs/schemas/flight-log/`.

Downloads are proxied by the console (`Content-Disposition: attachment`). Presigned GET URLs (300 s) exist in the signer for tests; the browser does not receive them, so the secret stays on the server.

## Sync

1. List index objects.
2. GET an index only when its ETag changed (or events are not loaded yet).
3. Upsert `flights` (`origin = cloud`) and ingest `events.jsonl.gz` so search works across flights.
4. On first open of a flight, cache `manifest.json`, `summary.json`, `series.json.gz`, and `track.geojson.gz` under `data/flights/cloud/<flight_uid>/` (next to the SQLite file) and check sha256. A mismatch marks that artifact `corrupt` and the UI shows "אין נתונים" instead of a fake line.
5. Chunked objects (`.parts.json` + `.partNNNN`) are reassembled only for download. A bad part hash is `corrupt`.

Triggers: non-blocking sync at server boot, when the flight book opens, every 60 s while that sub-tab stays open, and the רענון button. One bad flight does not abort the rest. `server_config.flightLogs` stores `lastSyncAt` and `lastError`. A sync failure stays on screen in Hebrew and keeps the last success time.

Design §6.1 says every small artifact is fetched on first open. This console ingests events during sync so the list search box can see them. Series, track, and summary stay lazy and sha-checked.

## UI tour

תחקור → **טיסות** (first sub-tab). With no stored sub-tab, opening תחקור lands here. הקלטות and לוגים are unchanged. A stored legacy `flights` main tab still opens לוגים.

The list is the right column (RTL). Each card is "טיסה N" for that vehicle (oldest is 1), Asia/Jerusalem time, air time, max altitude, max airspeed and groundspeed, distance, mode chips, a warnings badge, upload state (✓ הושלם / ממתין ללוג בקר / חלקי / פגום), and a debrief badge (אין תחקיר / יש תחקיר).

Filters: date range, only flights with warnings, mode, event text, and "הצג סשנים קרקעיים" (bench / ground sessions stay hidden until that is on).

The flight page order is: KPI and time-source badge and downloads (Hebrew reason when a file is missing), the debrief card, timeline | map, then stacked plots (altitude, air/ground speed, throttle, roll/pitch, battery, GPS). Choosing an event or a citation moves the plot cursor and the map marker. Numbers, units, times, and mode names sit in `bdi dir=ltr`.

## Debrief

`GET /api/flight-logs/flights/:uid/debrief` returns a cached debrief when the fact-sheet digest and `prompt_version` (`flight-debrief/1`) match. `POST` with `{ "force": true }` writes a new row.

No `GEMINI_API_KEY` (exact copy):

> אין מפתח Gemini. מוצגות תובנות אוטומטיות בלבד.

The model is the existing `getGeminiModelChain()` path (`GEMINI_API_KEY`, temperature 0.2, JSON schema). It may use only fact-sheet IDs. Advice never includes apply, arm, disarm, parameter changes, or commands. More than 20% of sentences failing the check triggers one retry, then status `partial` and the banner חלק מהמשפטים לא אומתו מול עובדות הטיסה.

`FLIGHT_DEBRIEF_MOCK` (`ok`, `partial`, `nokey`) is honored only when `FLIGHT_LOGS_MODE=mock`, for tests. It does not call Gemini.

Arrow keys move in the list. Enter opens the highlighted flight.

Cloud flights also get a title in the existing לוגים flight select so a manual upload can attach to them. Local rename and hide (`user_label`, `hidden`) are stored only in SQLite.

## Empty and error states

- Not configured: the sentence above. No sample flights.
- Configured, nothing uploaded yet: the "עדיין אין טיסות" sentence.
- Sync error: Hebrew inline message plus the last successful sync time.
- Missing series or track: "אין נתונים" / "אין נתוני מסלול". No flat stand-in line.
- Map library missing: "המפה לא זמינה".
- File not uploaded: the Hebrew reason from the manifest (`fc_off`, `no_journal_permission`, …).

## TODO

A live "in flight" chip from the companion `GET /api/v1/flight-log/status` is not wired. Companion client files are owned elsewhere. Do not call that route from this UI until that client is the place to add it.
