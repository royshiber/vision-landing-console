# Jetson camera ingest (observe-only)

Prepare the mission computer so **CAM1 קדמית**, **CAM2 מטה**, and optional **CAM3 גימבל** can report honest state / fps / frame age.

This pack does **not** send flight commands, write the flight controller, apply Companion, run an optical estimator, or detect a runway. Gimbal UDP control is off unless `VLC_GIMBAL_CONTROL_ENABLED=1`.

## Roles

| Id | Role | Hebrew | Default device |
|---|---|---|---|
| `cam1` | forward | קדמית | `auto` |
| `cam2` | down | מטה | `auto` |
| `cam3` | gimbal | גימבל | `rtsp://192.168.144.25:8554/main.264` (off until enabled) |

`auto` uses `/dev/v4l/by-id/*-video-index0`, then capture-capable `/dev/video*`. Explicit `VLC_CAM*_DEVICE` always wins. Specs: path, by-id, by-path, index, `csi:N`, `rtsp://`, `auto`.

A supervisor thread per slot reopens on plug-in or read failure and does not restart the MAVLink relay.

Operator confirm on the console checklist never invents `camera_ok`. Each enabled camera needs its own live frame.

## Plug in

1. Mount CAM1 forward and CAM2 down.
2. Plug USB cameras. Two UVC cameras usually show up as `/dev/video0` and `/dev/video2` (the odd nodes are metadata).
3. On the Jetson:

```
python3 camera_ingest.py --resolve
```

4. Copy this folder to `~/vlc-companion` (or `install.sh --apply` on a Jetson).
5. Optional gimbal: `docs/SIYI_A8_GIMBAL.md` and `./siyi-net.sh`.
6. Start the 2.5.0 agent (UART fan-out unchanged):

```
python3 companion_agent.py
```

7. Verify:

```
curl -s http://127.0.0.1:8081/api/v1/status/cameras
curl -s http://127.0.0.1:8081/api/v1/status/gimbal
curl -s -o /tmp/cam1.jpg -w '%{http_code}\n' http://127.0.0.1:8081/api/v1/cameras/cam1/frame.jpg
```

Absent device → `camera_ok: false`, no JPEG, Hebrew empty state **אין פריים**.
Live frames → `state: streaming`, fps, `last_frame_age_ms`, JPEG.

CSI without a GStreamer OpenCV build reports `csi_requires_gstreamer_opencv`.

## Env defaults

| Env | Default |
|---|---|
| `VLC_CAM1_DEVICE` / `VLC_CAM2_DEVICE` | `auto` |
| `VLC_CAM3_DEVICE` | `rtsp://192.168.144.25:8554/main.264` |
| `VLC_CAM3_ENABLED` | `0` |
| `VLC_CAM3_CODEC` | `auto` (`h264`, `h265`, or `auto`) |
| `VLC_CAMERA_WIDTH` / `HEIGHT` / `FPS` | `640` / `480` / `10` |
| `VLC_CAM1_WIDTH` (and cam2/cam3, plus HEIGHT/FPS) | fall back to the globals |
| `VLC_CAMERA_DISCOVER_S` | `2` |
| `VLC_CAMERA_DRY_RUN` | unset (hardware). `1` absent. `synthetic` frames |
| `VLC_GIMBAL_CONTROL_ENABLED` | `0` (POST returns 403) |
| `VLC_SIYI_HOST` / `VLC_SIYI_PORT` | `192.168.144.25` / `37260` |
| `VLC_SIYI_ANGLE_CMD` | `0x0E` |
| `VLC_SIYI_TIMEOUT_S` / `VLC_SIYI_POLL_S` / `VLC_SIYI_STALE_S` | `0.4` / `0.5` / `2` |
| `VLC_GIMBAL_POLL` | on with the relay; off when `VLC_SKIP_RELAY=1` unless set to `1` |
| `VLC_HTTP_IDLE_S` | `30` (keep-alive idle timeout; HTTP/1.1, Content-Length on every response) |
| `VLC_FC_SERIAL_NAME` | `SERIAL4` (Matek pads TX3/RX3, `SERIAL4_PROTOCOL=2`) |
| `VLC_E3372_HILINK_URL` | unset (probe `http://192.168.8.1` only when a Huawei `enx*` iface exists) |
| `VLC_WIFI_IFACE` | `wlP1p1s0` |
| `VLC_CELL_IFACE` | unset (auto: `enx*` whose USB parent is vendor `12d1`) |
| `VLC_CELL_NM_CONNECTION` | `Wired connection 2` (APN profile `uinternet`, not rewritten) |
| `VLC_UPLINKS_STATE` | `/var/lib/airvix/uplinks.json` |
| `VLC_UPLINK_REACH_HOST` | `1.1.1.1` (ping `-I` the link that would remain) |
| `VLC_UPLINK_NM_BIN` | `/opt/airvix/jetson-companion/uplink-nm.sh` (sudo target) |
| `VLC_UPLINK_NM` | unset (tests only: run this program instead of `sudo -n`) |

USB open requests MJPG, then YUYV.

## Dry-run (no cameras)

```
./scripts/jetson-companion/install.sh --dry-run
python3 scripts/jetson-companion/camera_ingest.py --dry-run --json
python3 scripts/jetson-companion/camera_ingest.py --dry-run-synthetic --seconds 0.3 --json
```

Console: `npm run camera:dry-run`.

## Gimbal network

```
./scripts/jetson-companion/siyi-net.sh --dry-run
./scripts/jetson-companion/siyi-net.sh --status
```

Never changes Wi-Fi or the cellular profile. Details: `docs/SIYI_A8_GIMBAL.md`.

## Uplink control on the Jetson (2.3.11)

The agent runs as `royshiber` from `/home/royshiber/vlc-companion`.
NetworkManager changes use a root-owned script. The sudoers rule names that path only.

1. Copy the agent files into `/home/royshiber/vlc-companion`: `companion_agent.py`, `camera_ingest.py`, `siyi_sdk.py`, `siyi-net.sh`, `annotated_encoder.py`, `fc_telemetry.py`, `uplink_status.py`, `uplink_control.py`, `README.md`. Leave `uplink-nm.sh` out of that tree.
2. Install the privileged script as root:

```
sudo install -d -o root -g root -m 0755 /opt/airvix/jetson-companion
sudo install -o root -g root -m 0755 uplink-nm.sh /opt/airvix/jetson-companion/uplink-nm.sh
```

3. Install sudoers for `royshiber`:

```
sudo install -m 440 airvix-uplink.sudoers /etc/sudoers.d/airvix-uplink
sudo visudo -cf /etc/sudoers.d/airvix-uplink
```

4. If a unit file changed, reload systemd:

```
sudo systemctl daemon-reload
```

5. Skip udev. Do not run a global udev trigger. A modem-only nudge is optional and must name that one device; this runbook does not do it.
6. Restart the agent as `royshiber`. `GET /api/health` reports `agentVersion` `2.5.0`.

`wifi-up` and `cell-up` do nothing when that connection is already active. Startup does not take a live link down.

Rollback: put the 2.3.9 agent files back and remove `/etc/sudoers.d/airvix-uplink` if this install added it. Do not write an APN. No flight commands. No Companion apply from a cloud VM.

## Hebrew operator notes

- בלי מצלמה אין פריים.
- אישור מפעיל אינו דיווח מצלמה.
- תרגיל יבש אינו מצלמה אמיתית.
- שליטת גימבל כבויה עד שמפעילים אותה.
- ראייה מסומנת נשארת רק בסלולר.

## Frame bus

`get_frame_bus()` keeps the newest packet per slot (`jpeg`, optional `bgr`, `frame_count`). A later tracker subscribes in-process. Packets are not queued.

## Flight logger

Part A lives in `flightlog_service.py` and is off unless `AIRVIX_FLIGHTLOG_ENABLED=1`. It is a separate process. The companion only reads `/run/airvix/flightlog.json`. Install does not enable the unit unless `--enable-flightlog` is passed with `--apply`, and that flag only copies the unit. Upload is path-style S3 and stays idle without a secret. Google Cloud Storage uses endpoint `https://storage.googleapis.com` and region `auto` or `me-west1`. See `docs/FLIGHT_LOGS_JETSON.md`.
