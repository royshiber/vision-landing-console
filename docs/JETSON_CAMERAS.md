# Dual-camera ingest — install notes

Observe-only. Experiment #1 later adds runway detect. This ship is **camera ingest + status honesty**.

Hebrew checklist in the console (מוכנות / התקנת מצלמות) stays the operator path. This file is the Jetson side.

## What Roy plugs in

1. **CAM1 קדמית** — forward-facing USB or CSI.
2. **CAM2 מטה** — downward-facing USB or CSI. Different models are OK.
3. Confirm roles on the console checklist. Operator **אישור ביצעתי** does **not** mark `camera_ok`.

Suggested first USB mapping:

| Camera | Default device | Role env |
|---|---|---|
| CAM1 קדמית | `/dev/video0` | `VLC_CAM1_ROLE=forward` |
| CAM2 מטה | `/dev/video1` | `VLC_CAM2_ROLE=down` |

If `ls /dev/video*` shows different nodes, set `VLC_CAM1_DEVICE` / `VLC_CAM2_DEVICE`.

CSI (later, on the Jetson with OpenCV / GStreamer): `VLC_CAM1_DEVICE=csi:0`.

## Agent

Companion **2.3.4** (`scripts/jetson-companion/`):

- `companion_agent.py` — same UART fan-out as 2.3.1 / 2.3.3
- `camera_ingest.py` — open two devices, capture, honest status + optional JPEG

Copy both files to `~/vlc-companion` (or `./scripts/jetson-companion/install.sh --apply` on a Jetson). Cloud Agent VMs stay `--dry-run`.

```
export VLC_CAMERA_DRY_RUN=1          # absent honesty
export VLC_CAMERA_DRY_RUN=synthetic  # CI frames; never real
```

Verify on the Jetson:

```
curl -s http://127.0.0.1:8081/api/v1/status/cameras
curl -s http://127.0.0.1:8081/api/v1/status/vision
```

Console Mission **פריים** shows JPEGs from `/api/jetson/v1/cameras/cam1/frame` when Companion reports frames. Without frames: **אין פריים**.

**ראייה מסומנת** stays cellular-only. This preview is ingest JPEGs, not the annotated stream.

## Honesty

| Situation | `camera_ok` | Frames | `source` |
|---|---|---|---|
| No device | false | none | `absent` |
| Dry-run absent | false | none | `absent` (`dry_run`) |
| Dry-run synthetic | true (synthetic only) | JPEG + fps/age | `synthetic` (`real: false`) |
| Real USB/CSI capturing | true | JPEG + fps/age | `real` |

Optical-nav estimator stays off (`optical_nav.camera_ok` false, position null). No ARM / LAND / nav-source switch.
