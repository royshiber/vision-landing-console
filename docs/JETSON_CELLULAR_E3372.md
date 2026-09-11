# Jetson cellular (Huawei E3372) — software before hardware

The console dual-link model is already on master: **radio** + **cellular**, both MAVLink. Annotated vision is **cellular only**. The Huawei E3372 stick is not required for the console to run.

This document points at the **Jetson host pack** that can be copied later. It does not enable a live modem from a Cloud Agent VM.

## Pack

`scripts/jetson-cellular/`

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
| `probeHuaweiE3372` | `present: false`, `reason: unplugged` | `CELLULAR_MODEM_MOCK=present` |
| `GET /api/links` | `cellular: modem_absent` | loopback connect allowed |
| Remote cellular host | refused `422` | not used |
| Jetson `e3372-status.sh` | `modem_absent` | `AIRVIX_CELLULAR_MOCK=present` |

Do not treat Companion-HTTP as the cellular command path.

## Safety

- No flight commands.
- No Companion apply / restart.
- No secrets, APN, or machine addresses in the pack.
- Cloud Agent: dry-run only. Do not SSH to a Jetson.
