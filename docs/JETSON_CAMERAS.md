# Camera ingest — install notes

Observe-only. This ship is the companion camera supervisor (hot-plug, stable V4L map, CSI, RTSP) plus an optional third gimbal slot. It does not send flight commands.

Hebrew checklist in the console stays the operator path. Gimbal wiring for Roy is in `docs/SIYI_A8_GIMBAL.md`.

## Slots

| Id | Default role | Default device | Enabled |
|---|---|---|---|
| `cam1` | forward / קדמית | `auto` | yes |
| `cam2` | down / מטה | `auto` | yes |
| `cam3` | gimbal / גימבל | `rtsp://192.168.144.25:8554/main.264` | only when `VLC_CAM3_ENABLED=1` |

`auto` lists `/dev/v4l/by-id/*-video-index0` (the capture node, not the metadata node). If that directory is empty it falls back to `/dev/video*` that actually advertise video capture, in index order. The first free node goes to cam1, the second to cam2. An explicit env value always wins and is not given to another `auto` slot.

Each slot has its own supervisor thread. It looks again about every 2 seconds, opens when the device appears, and reopens with backoff after a bad read or unplug. That thread never touches the MAVLink UART relay.

## States

`camera_ok` is true only while frames are actually arriving (`state: streaming`). Dry-run synthetic frames are `source: synthetic` and `real: false`.

| `state` | Meaning |
|---|---|
| `absent` | No device for this slot |
| `opening` | Device is there; no frame yet |
| `streaming` | A frame was just read |
| `read_failed` | Open or read failed; supervisor will retry |
| `opencv_unavailable` | Python has no cv2 |
| `csi_requires_gstreamer_opencv` | `csi:N` needs OpenCV built with GStreamer |
| `disabled` | Slot is off (`cam3` until enabled) |

## Agent

Companion **2.5.0** (`scripts/jetson-companion/`):

- `companion_agent.py` — same UART fan-out as 2.3.1
- `camera_ingest.py` — supervisor, device plan, JPEG, in-process frame bus
- `siyi_sdk.py` — gimbal UDP client (control off by default)
- `siyi-net.sh` — Ethernet profile for the gimbal, not Wi-Fi

```
export VLC_CAMERA_DRY_RUN=1          # absent honesty
export VLC_CAMERA_DRY_RUN=synthetic  # CI frames; never real
```

Verify on the Jetson:

```
python3 camera_ingest.py --resolve
curl -s http://127.0.0.1:8081/api/v1/status/cameras
curl -s -o /tmp/cam1.jpg -w '%{http_code}\n' http://127.0.0.1:8081/api/v1/cameras/cam1/frame.jpg
```

`--resolve` prints the device each slot actually got. Absent device → `camera_ok: false`, no JPEG.

## USB bandwidth

USB cameras are asked for MJPG, then YUYV if MJPG does not stick. Per slot:

```
VLC_CAM1_WIDTH=1280
VLC_CAM1_HEIGHT=720
VLC_CAM1_FPS=15
```

Globals `VLC_CAMERA_WIDTH` / `HEIGHT` / `FPS` apply when the slot value is unset (default 640×480 @ 10).

## OV9281 on CAM0

The OmniVision OV9281 (1MP global-shutter mono) is not an Argus sensor. `nvarguscamerasrc` and `VLC_CAM1_DEVICE=csi:N` do not apply. The out-of-tree driver and the CAM0 overlay live in `scripts/jetson-camera-drivers/ov9281/`. Capture is V4L2 (`/dev/video0`, pixelformat `RG10`, read as mono). That pack does not send flight commands and does not apply or restart Companion.

## CSI and RTSP

`VLC_CAM1_DEVICE=csi:0` opens `nvarguscamerasrc` only when `cv2.getBuildInformation()` reports GStreamer. Otherwise the state is `csi_requires_gstreamer_opencv`, not `absent`.

`rtsp://...` (cam3, the SIYI A8 mini) uses the same newest-frame shape as the fixed cameras. The pipeline is UDP first (`VLC_CAM3_RTSP_TRANSPORT=udp|tcp|auto`, default `udp`, then TCP if UDP fails), `latency=0`, `drop-on-latency=true`, `do-retransmission=false`, hardware `nvv4l2decoder` with `enable-max-performance=1` and `disable-dpb=true`, and `appsink drop=true max-buffers=1 sync=false`. The JPEG is scaled to the tile (`VLC_CAM3_JPEG_WIDTH` / `HEIGHT`, default 640×360, quality 55) before encode. On a Jetson with GStreamer introspection the first attempt is `nvjpegenc`; otherwise OpenCV encodes the scaled frame. `VLC_CAM3_CODEC=h264|h265|auto` (default `auto`). Open gives up in about 2.5 seconds when no stream is present. A transport that opens and then produces no frame is skipped for a short retry so a stuck `opening` does not keep serving an old JPEG. If GStreamer cannot open the stream, the slot falls back to FFmpeg with a one-frame buffer and the same scale.

Measure on the Jetson (the gimbal has to be plugged in; this repo does not measure it):

```
python3 scripts/jetson-companion/measure_camera_latency.py --camera cam0 --seconds 5
python3 scripts/jetson-companion/measure_camera_latency.py --camera cam3 --seconds 5
```

A tracker in the same process can call `get_frame_bus().subscribe(...)` or `latest(cam_id)`. Only the newest packet per slot is kept.

Optical-nav estimator stays off. No flight-command send.
