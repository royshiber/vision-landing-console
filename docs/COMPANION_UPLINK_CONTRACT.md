# Companion uplink contract (console wired for companion 2.3.9)

The console stores radio enablement in `commLinks.enabled.radio` and exposes `GET` / `POST /api/links/prefs`.

Cellular and home (Wi-Fi) connect / disconnect buttons do not use that preference to claim the Jetson switched. They call `POST /api/links/uplink` with `{ role: "cellular" | "home", enabled }`. The console maps `home` to companion `wifi` and calls `setNetworkUplink(link, { enabled })`, which posts `POST /api/v1/network/uplinks/{wifi|cellular}` with `{ "enabled": true | false }`.

Feature detection is `health.capabilities.uplinkControl === true`. When that flag is missing, both buttons stay disabled. The tooltip is exactly `גרסת ה-Jetson לא תומכת בשליטה בערוץ`. The console does not save a preference and does not report that the channel changed.

Row state for those two links comes from `GET /api/v1/network/uplinks`:

- `enabled: false` — grey `מושבת`, button `התחבר`
- `enabled: true` and `up: true` — green `מחובר`, button `התנתק` (red)
- `enabled: true` and `up: false` — yellow `לא עלה`, button `התנתק`

A 409 from the companion is shown in Hebrew. Companion 2.3.9 sends `message: "אי אפשר לכבות את הקישור האחרון"` with `reason: "last_uplink"`, and that message is shown as-is. A non-Hebrew last-link refusal becomes `אי אפשר לנתק את הערוץ הפעיל האחרון`. Anything else is `הפעולה נדחתה`.

Wi-Fi `signal_dbm` fills the home bars. Missing signal stays empty with `אין נתונים`.

Radio stays the companion MAVLink relay. The Wi-Fi button does not close that relay and does not wipe the stored token.

Do not implement these routes inside `scripts/jetson-companion/` from the console change. Companion 2.3.9 (PR #139 follow-up) owns the Jetson side:

## `GET /api/v1/network/uplinks`

Per uplink (`wifi`, `cellular`):

- `enabled` — the switch
- `up` — the iface is actually up
- `ip`, default route
- Wi-Fi SSID and `signal_dbm`

## `POST /api/v1/network/uplinks/{wifi|cellular}`

Body: `{ "enabled": true | false }`.

Advertise support with `health.capabilities.uplinkControl = true`.

Safety: refuse to disable the last active uplink. The console surfaces that 409 in Hebrew and does not pretend the link went down.

## `GET /api/v1/status/modem`

Still the cellular signal source when the uplink report has no dBm:

- RSRP at or above -80 is 4 bars, -90 is 3, -100 is 2, -110 is 1, otherwise 0
- RSSI dBm uses -65 / -75 / -85 / -95

No invented percent.
