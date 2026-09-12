# Jetson dual-camera ingest (observe-only)

Prepare the mission computer so **CAM1 קדמית** and **CAM2 מטה** can report honest
`camera_ok` / fps / frame age, and so Mission can show a live JPEG when frames exist.

This pack does **not** send flight commands, write the flight controller, apply Companion,
run an optical estimator, or detect a runway.

## Roles

| Id | Role | Hebrew | Typical mount |
|---|---|---|---|
| `cam1` | forward | קדמית | USB or CSI facing forward |
| `cam2` | down | מטה | USB or CSI facing down |

Different camera models are fine. Operator confirm on the console checklist never invents `camera_ok`.

## Plug in (when hardware arrives)

1. Mount CAM1 forward and CAM2 down (checklist #124).
2. Plug USB cameras into the Jetson **or** seat CSI modules on CSI0 / CSI1.
3. On the Jetson, confirm nodes (example):

```
ls -l /dev/video0 /dev/video1
```

4. Copy this folder (`companion_agent.py` + `camera_ingest.py`) to `~/vlc-companion`.
5. Export devices if they are not the defaults:

```
export VLC_CAM1_DEVICE=/dev/video0
export VLC_CAM2_DEVICE=/dev/video1
export VLC_CAM1_ROLE=forward
export VLC_CAM2_ROLE=down
```

CSI example: `VLC_CAM1_DEVICE=csi:0` (needs Jetson OpenCV / GStreamer later).

6. Start the existing 2.3.4 agent (UART fan-out unchanged):

```
python3 companion_agent.py
```

7. Verify:

```
curl -s http://127.0.0.1:8081/api/v1/status/cameras
curl -s -o /tmp/cam1.jpg -w '%{http_code}\n' http://127.0.0.1:8081/api/v1/cameras/cam1/frame
```

Absent device → `camera_ok: false`, no JPEG, Hebrew empty state **אין פריים**.
Live frames → fps + `last_frame_age_ms` + JPEG. Annotated vision stays **cellular-only**.

## Dry-run (no cameras)

```
./scripts/jetson-companion/install.sh --dry-run
python3 scripts/jetson-companion/camera_ingest.py --dry-run --json
python3 scripts/jetson-companion/camera_ingest.py --dry-run-synthetic --seconds 0.3 --json
```

| Env | Meaning |
|---|---|
| `VLC_CAMERA_DRY_RUN=1` | Absent. Honest `camera_ok` false. |
| `VLC_CAMERA_DRY_RUN=synthetic` | Synthetic JPEG + fps/age. `source=synthetic`. Never `real`. |
| `VLC_CAMERA_DRY_RUN_MODE=synthetic` | Used when `VLC_CAMERA_DRY_RUN=1`. |

Console: `npm run camera:dry-run`.

## Hebrew operator notes

- בלי מצלמה אין פריים.
- אישור מפעיל אינו דיווח מצלמה.
- תרגיל יבש אינו מצלמה אמיתית.
- ראייה מסומנת נשארת רק בסלולר.
