# Companion uplink contract (not implemented on companion 2.3.6)

The console stores per-link enablement in `commLinks.enabled.{cellular,home,radio}` and exposes `GET` / `POST /api/links/prefs`.

A disabled link is not auto-opened and is not auto-reopened. The row shows grey `מושבת`.

Turning Wi-Fi or cellular off on the Jetson needs endpoints that companion 2.3.6 does not ship. The console checks `health.capabilities.uplinkControl === true` or a successful probe of `GET /api/v1/network/uplinks`. When that capability is missing, the preference is still saved and the row says the Jetson cannot yet switch the uplink off remotely.

Do not implement these routes inside `scripts/jetson-companion/` from the console change. The companion follow-up is:

## `GET /api/v1/status/modem`

Add a real signal from HiLink `192.168.8.1`:

- `/api/device/signal`: `rssi`, `rsrp`, `rsrq`, `sinr`
- `/api/monitoring/status`: `ConnectionStatus`, `CurrentNetworkType`, `SignalIcon`
- WAN address
- `age_ms`

The console maps RSRP dBm to bars: at or above -80 is 4, -90 is 3, -100 is 2, -110 is 1, otherwise 0. RSSI dBm uses -65 / -75 / -85 / -95. The raw number is the tooltip. Missing fields stay empty bars and `אין נתונים`. No invented percent.

## `GET /api/v1/network/uplinks`

Per uplink (`wifi` on `wlan*`, `cellular` on `enx0c5b8f279a64`):

- `up`, `ip`, default-route / metric
- which uplink carries Tailscale
- Wi-Fi SSID and RSSI dBm
- `age_ms`

The console cannot tell which uplink carries Tailscale until this report exists. It must not claim cellular carries MAVLink without this evidence.

## `POST /api/v1/network/uplinks/{wifi|cellular}`

Body: `{ "enabled": true | false }`.

Persist the choice. Roy's policy: the Jetson auto-connects to both Wi-Fi and cellular unless one was disabled from the UI.

Safety: refuse to disable the uplink that currently carries the console session unless the body sets `force: true`.

Advertise support with `health.capabilities.uplinkControl = true`.

## Optional cellular MAVLink egress

If a separate cellular MAVLink path is wanted, the Jetson pushes to the console UDP port 14560 over the cell path. Until that exists, the console cellular row is modem state plus signal plus uplink honesty. A bare UDP listener is waiting, never connected.
