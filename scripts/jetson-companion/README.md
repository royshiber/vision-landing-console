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
6. Start the 2.3.7 agent (UART fan-out unchanged):

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

## Hebrew operator notes

- בלי מצלמה אין פריים.
- אישור מפעיל אינו דיווח מצלמה.
- תרגיל יבש אינו מצלמה אמיתית.
- שליטת גימבל כבויה עד שמפעילים אותה.
- ראייה מסומנת נשארת רק בסלולר.

## Frame bus

`get_frame_bus()` keeps the newest packet per slot (`jpeg`, optional `bgr`, `frame_count`). A later tracker subscribes in-process. Packets are not queued.
