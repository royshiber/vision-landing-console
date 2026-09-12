# Jetson cellular (Huawei E3372) — software before hardware

The console dual-link model is already on master: **radio** + **cellular**, both MAVLink. Annotated vision is **cellular only**. The Huawei E3372 stick is not required for the console to run.

This document points at the **Jetson host pack** that can be copied later. It does not enable a live modem from a Cloud Agent VM.

## Pack

`scripts/jetson-cellular/`

- `npm run cellular:dry-run` — console honesty JSON. Unplugged → `modem_absent`. No sockets.
- `install.sh --dry-run` — default. Validates files. No apt, no systemd, no USB switch.
- `e3372-status.sh` — JSON. Unplugged → `modem_absent`.
- `e3372-bringup.sh` — systemd oneshot when udev sees a Huawei id. Missing stick exits 0.
- `udev/99-huawei-e3372.rules` + `usb-modeswitch/12d1:1f01` + `12d1:14fe`.
- `systemd/airvix-e3372-status.service` + `airvix-e3372-bringup.service`.
- `pack.sh` — tarball for `scp`. Does not SSH.

Operator README (IDs, mock path, scp): `scripts/jetson-cellular/README.md`.

## Console mock until USB

| Surface | Unplugged default | Software mock |
|---|---|---|
| `probeHuaweiE3372` | `present: false`, `reason: modem_absent` | `CELLULAR_MODEM_MOCK=present` |
| `GET /api/links` | `cellular: modem_absent` | mock env may show a plugged-in modem |
| Remote cellular host | refused `422` | not used |
| Loopback connect | socket may open (`loopback_mock`) but snapshot stays `modem_absent` | not a live cell link |
| `GET /api/links/annotated-video` | `available: false`, `reason: modem_absent`, `neverRadio: true` | still cellular-only; no fake live stream |
| Readiness `annotated_video` | later / not required + `reason: modem_absent` | still not required for Experiment 1 |
| No annotated stream | `reason: stream_absent` when modem is present and cellular is up | radio never satisfies |
| `npm run cellular:dry-run` | JSON `modem_absent`, exit 0 | `CELLULAR_MODEM_MOCK=present` |
| Jetson `e3372-status.sh` | `modem_absent` | `AIRVIX_CELLULAR_MOCK=present` |

Do not treat Companion-HTTP as the cellular command path.

## Safety

- No flight commands.
- No Companion apply / restart.
- No secrets, APN, or machine addresses in the pack.
- Cloud Agent: dry-run only. Do not SSH to a Jetson.
