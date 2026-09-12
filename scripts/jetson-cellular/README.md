# Jetson Huawei E3372 — host software (before the stick arrives)

Prepare an NVIDIA Jetson (Orin / Xavier class) so a **Huawei E3372** USB stick can become the AIRVIX **cellular** path. The stick is not required to install or dry-run this pack.

Locked product:

- Cellular is a **MAVLink-like second path** (telemetry / commands over the cell link).
- **Annotated vision video is cellular only.** Radio never carries that video.
- Companion-HTTP is **not** the command path.
- Console dual-link stays `modem_absent` / loopback mock until USB is present.

This pack does **not** send flight commands, write the flight controller, apply Companion, or need secrets.

## What lands here

| Path | Role |
|---|---|
| `install.sh` | Default `--dry-run`. `--apply` only on a Jetson (or `--force-lab`). |
| `e3372-status.sh` | JSON snapshot. Unplugged → `modem_absent`. |
| `e3372-bringup.sh` | Called by systemd when a matching USB id appears. Missing stick exits 0. |
| `udev/99-huawei-e3372.rules` | usb_modeswitch + `SYSTEMD_WANTS` on HiLink net / stick tty. |
| `systemd/airvix-e3372-status.service` | Boot: write status (absent is success). |
| `systemd/airvix-e3372-bringup.service` | Device-triggered bring-up stub. |
| `usb-modeswitch/12d1:1f01` | HiLink first-id config (`HuaweiNewMode`). |
| `usb-modeswitch/12d1:14fe` | Alternate first-id config. |
| `conf/e3372.env.example` | Empty flags only. No APN, tokens, or hosts. |
| `pack.sh` | Tarball for later `scp`. Does not SSH. |

Install destination on the Jetson: `/opt/airvix/jetson-cellular`.

## usb_modeswitch / udev notes

Retail E3372 sticks usually enumerate first as USB storage (a Windows driver CD), then switch to a network or modem function.

| VID:PID | Typical meaning |
|---|---|
| `12d1:1f01` | First id — mass storage / CD-ROM (HiLink E3372h). |
| `12d1:14fe` | First id — some firmware. |
| `12d1:1446` | First id — some E3372s. |
| `12d1:14dc` / `14db` / `155e` | After switch — HiLink CDC ethernet (`usb0` / `enx…`). |
| `12d1:1506` / `1001` | After switch — stick / option (`ttyUSB*`, sometimes `cdc-wdm0`). |

Ubuntu / JetPack already ship `usb-modeswitch` + `usb-modeswitch-data`. This pack:

1. Installs those packages on `--apply`.
2. Drops a udev rule that calls `usb_modeswitch -J` (HuaweiNewMode) if the distro rule is missing.
3. Starts `airvix-e3372-bringup.service` when a **Huawei** net or tty node appears.

`--dry-run` and Cloud Agent tests never invoke `usb_modeswitch` against hardware.

HiLink after switch is a USB ethernet NIC. The Jetson gets a DHCP lease from the stick (often a `192.168.8.0/24` link-local to the modem). Do not put that address, an APN, or a SIM PIN in git.

Stick mode exposes AT/QMI nodes. This pack **does not** send AT commands or write an APN.

## Console `modem_absent` / mock (until USB is present)

On the **console** (this repo, any PC / VM):

- `lib/cellular-modem.mjs` `probeHuaweiE3372` defaults to `modem_absent`.
- Dual-link `GET /api/links` reports `cellular: modem_absent` and `modemPresent: false`.
- Remote cellular connect is refused (`422`). Loopback (`127.0.0.1`) may open a software socket (`loopback_mock`) but the honesty snapshot stays `modem_absent` — never an invented link-up.
- `CELLULAR_MODEM_MOCK=present` is only for UI demos of a plugged-in modem.
- Console dry-run: `npm run cellular:dry-run`.

On the **Jetson** (this pack):

- `e3372-status.sh` without USB prints `state: "modem_absent"`.
- `AIRVIX_CELLULAR_MOCK=present` (or `CELLULAR_MODEM_MOCK=present`) prints `mock_present` / `mock0`.
- systemd units treat absent as success so the image can be prepared days before the stick arrives.

Keep the console mock path until a real E3372 USB id is visible. Do not point a remote cellular socket at a Jetson that still reports `modem_absent`.

## Copy later (scp). Do not SSH from a Cloud Agent VM

From a machine that already has this repo (placeholder host only):

```
./scripts/jetson-cellular/pack.sh
scp scripts/airvix-jetson-cellular.tgz USER@JETSON-HOST:~/
```

On the Jetson:

```
tar xzf airvix-jetson-cellular.tgz
sudo ./jetson-cellular/install.sh --dry-run
sudo ./jetson-cellular/install.sh --apply
```

`--apply` refuses a non-Jetson host unless `--force-lab`. Cloud Agent VMs must stay on `--dry-run`.

## What this does not do

- No live vehicle, UART FC, or MAVLink send.
- No Companion apply / restart / GStreamer start.
- No annotated-video encoder bind (document-only: bind to cellular, never radio).
- No APN, SIM PIN, tokens, or Tailscale / Jetson addresses in files.

When the stick is on the bench, a later task can add DHCP wait, a cellular MAVLink bind on port `14560`, and annotated-video egress — each still gated by the constitution.
