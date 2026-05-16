# Jetson Agent — ניווט ויזואלי Dual-Camera (VIO + Optical Flow)

## סקירה ארכיטקטורה

הג'טסון מריץ **שתי צינורות עיבוד מקביליים**:

| צינור | מצלמה | זווית עצב | אלגוריתם | MAVLink ל-ArduPilot |
|-------|--------|-----------|-----------|---------------------|
| **VIO** | CAM1 — קדמית | 0° pan / −10° pitch | Lucas-Kanade Feature Tracking + Scale Estimation | `VISION_POSITION_ESTIMATE` (msg 102) |
| **Optical Flow** | CAM2 — מטה | 0° pan / −75° pitch (15° מהאנכי לכיוון קדמי) | Dense Optical Flow (Farneback) → angular rate | `OPTICAL_FLOW_RAD` (msg 106) |

ArduPilot משלב את שני המקורות ב-**EKF3** לניווט ללא GPS.

---

## חיווט מצלמות לג'טסון Orin Super

```
Jetson Orin Super
├── CSI0  ──►  CAM1 (קדמית)   — IMX219 / IMX477 — כיוון: 0° pan, −10° pitch
└── CSI1  ──►  CAM2 (מטה)     — IMX219 / IMX477 — כיוון: 0° pan, −75° pitch
```

> **המלצה:** שתי מצלמות עם **FOV ≥ 120°** ורזולוציה **640×480 @ 30fps** לפחות.  
> ניתן להשתמש ב-USB cameras (UVC) עם שינוי מזהי המכשיר בקוד.

---

## פרמטרי ArduPilot הדרושים

הגדר פרמטרים אלה ב-Mission Planner **לפני** הטיסה הראשונה:

```
# EKF3 כאומד ראשי
AHRS_EKF_TYPE   = 3

# מקור מיקום ומהירות אופקית: External Nav (VIO)
EK3_SRC1_POSXY  = 6
EK3_SRC1_VELXY  = 6

# מקור גובה: ברומטר (בטוח יותר מ-VIO יחידה)
EK3_SRC1_POSZ   = 1
EK3_SRC1_VELZ   = 0

# Optical Flow: מגיע דרך MAVLink (לא חיישן ישיר)
FLOW_TYPE       = 6

# כבה GPS ראשי בניסוי ניווט ויזואלי (0 = GPS, 3 = ללא GPS)
EK3_GPS_TYPE    = 3

# מהירות שידור VIO (Hz)
EK3_VISO_DELAY  = 70
```

> ⚠ לבדיקות ראשונות: אל תכבה GPS לגמרי. השאר `EK3_GPS_TYPE = 0`  
> והפעל GPS כגיבוי. כבה רק כשהמערכת מוכחת.

---

## התקנת תלויות על הג'טסון

```bash
sudo apt update
sudo apt install -y python3-pip python3-opencv libopencv-dev

pip3 install pymavlink numpy opencv-python-headless requests

# לאחר הורדת JetPack — GStreamer כלול. אמת:
python3 -c "import cv2; print(cv2.getBuildInformation())" | grep GStreamer
```

---

## קוד Python — Agent שלם

```python
#!/usr/bin/env python3
"""
vision_agent.py — Dual-Camera VIO + Optical Flow for Jetson Orin Super
CAM1 (forward, -10° tilt): Visual Inertial Odometry → VISION_POSITION_ESTIMATE
CAM2 (downward, -75° tilt): Optical Flow → OPTICAL_FLOW_RAD
"""

import time
import math
import threading
import numpy as np
import cv2
import requests
import psutil
from pymavlink import mavutil

# ─── Configuration ────────────────────────────────────────────────────────────

CONSOLE_SERVER    = "http://192.168.1.100:4010"   # IP של המחשב עם הקונסולה
MAVLINK_DEVICE    = "/dev/ttyTHS0"                # UART לArduPilot (או "udp:127.0.0.1:14551")
MAVLINK_BAUD      = 115200
AGENT_VERSION     = "2.0.0"

# Camera indices (CSI או USB)
CAM1_INDEX        = 0   # קדמית (−10°)
CAM2_INDEX        = 1   # מטה (−75°)

# Camera intrinsics — נדרשים לVIO מדויק (כייל עם cv2.calibrateCamera)
CAM1_FX, CAM1_FY  = 600.0, 600.0   # focal length בפיקסלים
CAM1_CX, CAM1_CY  = 320.0, 240.0   # principal point
CAM2_FX, CAM2_FY  = 600.0, 600.0
CAM2_CX, CAM2_CY  = 320.0, 240.0

# CAM2 mount angle (−75° from horizontal = 15° forward from nadir)
CAM2_TILT_RAD     = math.radians(-75)

# ─── GStreamer pipeline for Jetson CSI cameras ─────────────────────────────────

def gst_pipeline(sensor_id, width=640, height=480, fps=30):
    return (
        f"nvarguscamerasrc sensor-id={sensor_id} ! "
        f"video/x-raw(memory:NVMM),width={width},height={height},framerate={fps}/1 ! "
        f"nvvidconv ! video/x-raw,format=BGRx ! "
        f"videoconvert ! video/x-raw,format=BGR ! appsink drop=1"
    )

def open_camera(index, use_gstreamer=True):
    if use_gstreamer:
        cap = cv2.VideoCapture(gst_pipeline(index), cv2.CAP_GSTREAMER)
    else:
        cap = cv2.VideoCapture(index)   # USB fallback
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cap.set(cv2.CAP_PROP_FPS, 30)
    return cap

# ─── MAVLink connection ────────────────────────────────────────────────────────

def connect_mavlink():
    mav = mavutil.mavlink_connection(MAVLINK_DEVICE, baud=MAVLINK_BAUD)
    mav.wait_heartbeat(timeout=10)
    print(f"[MAVLink] Connected — system {mav.target_system} component {mav.target_component}")
    return mav

# ─── VIO thread — CAM1 (forward, −10°) ────────────────────────────────────────

class VIOTracker:
    """Monocular visual odometry using sparse optical flow (Lucas-Kanade)."""

    FEATURE_PARAMS = dict(maxCorners=200, qualityLevel=0.01, minDistance=7, blockSize=7)
    LK_PARAMS      = dict(winSize=(21, 21), maxLevel=3,
                          criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))

    def __init__(self):
        self.pos_x = self.pos_y = self.pos_z = 0.0
        self.yaw   = 0.0
        self.prev_gray = None
        self.prev_pts  = None
        self.scale     = 1.0    # estimated metric scale (requires additional sensor or assumption)
        self.confidence = 0.0
        self.lock = threading.Lock()

    def update(self, frame_gray, dt):
        if self.prev_gray is None:
            self.prev_gray = frame_gray
            self.prev_pts  = cv2.goodFeaturesToTrack(frame_gray, mask=None, **self.FEATURE_PARAMS)
            return

        if self.prev_pts is None or len(self.prev_pts) < 10:
            self.prev_pts = cv2.goodFeaturesToTrack(frame_gray, mask=None, **self.FEATURE_PARAMS)
            self.prev_gray = frame_gray
            return

        next_pts, status, _ = cv2.calcOpticalFlowPyrLK(
            self.prev_gray, frame_gray, self.prev_pts, None, **self.LK_PARAMS)

        good_prev = self.prev_pts[status == 1]
        good_next = next_pts[status == 1]

        if len(good_prev) < 8:
            self.prev_pts = cv2.goodFeaturesToTrack(frame_gray, mask=None, **self.FEATURE_PARAMS)
            self.prev_gray = frame_gray
            return

        # Essential matrix → rotation + translation
        E, mask = cv2.findEssentialMat(
            good_next, good_prev,
            cameraMatrix=np.array([[CAM1_FX, 0, CAM1_CX],[0, CAM1_FY, CAM1_CY],[0,0,1]]),
            method=cv2.RANSAC, prob=0.999, threshold=1.0)

        if E is None:
            return

        _, R, t, _ = cv2.recoverPose(E, good_next, good_prev,
                                      cameraMatrix=np.array([[CAM1_FX,0,CAM1_CX],[0,CAM1_FY,CAM1_CY],[0,0,1]]))

        # Update pose (scale is unknown for monocular — use barometer altitude for Z scaling)
        dx = float(t[0]) * self.scale
        dy = float(t[1]) * self.scale
        dz = float(t[2]) * self.scale

        yaw_delta = math.atan2(R[1, 0], R[0, 0])

        with self.lock:
            self.pos_x   += dx
            self.pos_y   += dy
            self.pos_z   += dz
            self.yaw     += yaw_delta
            self.confidence = len(good_next) / 200.0   # normalized 0..1

        self.prev_gray = frame_gray
        self.prev_pts  = good_next.reshape(-1, 1, 2)

    def get_pose(self):
        with self.lock:
            return (self.pos_x, self.pos_y, self.pos_z, self.yaw, self.confidence)


def send_vision_position_estimate(mav, tracker):
    px, py, pz, yaw, conf = tracker.get_pose()
    if conf < 0.05:
        return
    usec = int(time.time() * 1e6)
    mav.mav.vision_position_estimate_send(
        usec,
        px, py, pz,
        0.0, 0.0, float(yaw)   # roll=0, pitch=0, yaw
    )


def vio_loop(mav, console_server):
    cap = open_camera(CAM1_INDEX)
    tracker = VIOTracker()
    prev_t  = time.time()
    fps_count = 0
    fps_display = 0.0
    fps_timer = time.time()

    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.1)
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        now  = time.time()
        dt   = now - prev_t
        prev_t = now

        tracker.update(gray, dt)
        send_vision_position_estimate(mav, tracker)

        fps_count += 1
        if now - fps_timer >= 1.0:
            fps_display = fps_count / (now - fps_timer)
            fps_count = 0
            fps_timer = now

        # Report to console
        px, py, pz, yaw, conf = tracker.get_pose()
        try:
            requests.post(f"{console_server}/api/vision/vio-pose", json={
                "posX": round(px, 3), "posY": round(py, 3), "posZ": round(pz, 3),
                "yawDeg": round(math.degrees(yaw), 1),
                "confidence": round(conf, 3),
                "fps": round(fps_display, 1),
                "cam": "CAM1",
            }, timeout=1)
        except Exception:
            pass

        time.sleep(max(0, 1/30 - (time.time() - now)))

    cap.release()


# ─── Optical Flow thread — CAM2 (downward, −75°) ──────────────────────────────

class OpticalFlowEstimator:
    """Dense optical flow (Farneback) → angular velocity for OPTICAL_FLOW_RAD."""

    def __init__(self, fx, fy, tilt_rad):
        self.fx       = fx
        self.fy       = fy
        self.tilt_rad = tilt_rad   # mount angle (negative = below horizontal)
        self.prev_gray = None
        self.flow_x = self.flow_y = 0.0
        self.quality = 0
        self.lock = threading.Lock()

    def update(self, frame_gray, dt):
        if self.prev_gray is None:
            self.prev_gray = frame_gray
            return

        flow = cv2.calcOpticalFlowFarneback(
            self.prev_gray, frame_gray, None,
            pyr_scale=0.5, levels=3, winsize=15,
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0)

        # Mean flow in pixels/frame → angular rate (rad/s)
        mean_flow_x = float(np.mean(flow[..., 0]))
        mean_flow_y = float(np.mean(flow[..., 1]))

        ang_x = (mean_flow_x / self.fx) / max(dt, 0.001)   # rad/s around Y axis
        ang_y = (mean_flow_y / self.fy) / max(dt, 0.001)   # rad/s around X axis

        # Quality = percentage of pixels with significant motion
        mag = np.sqrt(flow[...,0]**2 + flow[...,1]**2)
        qual = int(np.mean(mag > 0.5) * 255)

        with self.lock:
            self.flow_x  = ang_x
            self.flow_y  = ang_y
            self.quality = qual

        self.prev_gray = frame_gray

    def get_flow(self):
        with self.lock:
            return self.flow_x, self.flow_y, self.quality


def send_optical_flow_rad(mav, estimator, distance_m=1.0):
    fx, fy, qual = estimator.get_flow()
    time_usec = int(time.time() * 1e6)
    mav.mav.optical_flow_rad_send(
        time_usec,
        1,             # sensor_id = 1 (downward camera)
        int(1e6 / 30), # integration_time_us (30fps → ~33333µs)
        float(fx),     # integrated_x (rad)
        float(fy),     # integrated_y (rad)
        0.0,           # integrated_xgyro (if no IMU available)
        0.0,           # integrated_ygyro
        0.0,           # integrated_zgyro
        int(40),       # temperature (°C * 100 = not available → 0)
        qual,          # quality 0..255
        int(1e6 / 30), # time_delta_distance_us
        float(distance_m),  # distance — provide from rangefinder if available
    )


def flow_loop(mav, console_server):
    cap = open_camera(CAM2_INDEX)
    estimator = OpticalFlowEstimator(CAM2_FX, CAM2_FY, CAM2_TILT_RAD)
    prev_t = time.time()
    fps_count = 0
    fps_display = 0.0
    fps_timer = time.time()

    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.1)
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        now  = time.time()
        dt   = now - prev_t
        prev_t = now

        estimator.update(gray, dt)
        send_optical_flow_rad(mav, estimator)

        fps_count += 1
        if now - fps_timer >= 1.0:
            fps_display = fps_count / (now - fps_timer)
            fps_count = 0
            fps_timer = now

        fx, fy, qual = estimator.get_flow()
        try:
            requests.post(f"{console_server}/api/vision/flow", json={
                "flowX": round(fx, 4), "flowY": round(fy, 4),
                "quality": qual,
                "fps": round(fps_display, 1),
                "cam": "CAM2",
            }, timeout=1)
        except Exception:
            pass

        time.sleep(max(0, 1/30 - (time.time() - now)))

    cap.release()


# ─── Heartbeat thread ──────────────────────────────────────────────────────────

def heartbeat_loop(console_server):
    while True:
        try:
            requests.post(f"{console_server}/api/jetson/heartbeat", json={
                "cpuLoadPct":        psutil.cpu_percent(interval=0.5),
                "tempC":             _read_temp(),
                "memPct":            psutil.virtual_memory().percent,
                "agentVersion":      AGENT_VERSION,
                "navMode":           "dual-camera-vio",
            }, timeout=3)
        except Exception:
            pass
        time.sleep(5)

def _read_temp():
    try:
        with open("/sys/devices/virtual/thermal/thermal_zone0/temp") as f:
            return int(f.read()) / 1000.0
    except Exception:
        return None

# ─── Landing assist thread (existing — unchanged) ─────────────────────────────

def landing_loop(console_server):
    """Forward camera frame analysis for precision landing — POST to /api/vision/frame."""
    # (unchanged from v1 — CAM1 is also used for landing detect during approach)
    pass


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[Vision Agent {AGENT_VERSION}] Starting dual-camera pipeline…")
    mav = connect_mavlink()

    threading.Thread(target=heartbeat_loop, args=(CONSOLE_SERVER,), daemon=True).start()
    threading.Thread(target=vio_loop,       args=(mav, CONSOLE_SERVER), daemon=True).start()
    threading.Thread(target=flow_loop,      args=(mav, CONSOLE_SERVER), daemon=True).start()

    print("[Vision Agent] All threads running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[Vision Agent] Stopped.")
```

---

## זוויות הרכבה מומלצות

```
מטוס — מבט מהצד

    ▶ כיוון טיסה

    ╔═══════════════╗
    ║               ║──►  CAM1: קדמית, pitch = −10°
    ║    מטוס       ║         (מסתכל קצת מטה לכיסוי טוב יותר)
    ║               ║
    ╚═══════════╦═══╝
                ║
                ╠──►  CAM2: מטה, pitch = −75°
                         (75° מהאופק = 15° מהאנכי, לכיוון קדמי)
                         → שיפור optical flow בטיסה קדמית
```

---

## פרמטרי calibration מצלמה (חובה לVIO מדויק)

הרץ כיול מצלמה לפני שימוש ב-VIO:

```python
# calibrate_cam.py
import cv2
import numpy as np
import glob

CHECKERBOARD = (9, 6)   # מספר פינות לוח השחמט
images = glob.glob("calib_images/*.jpg")

objp = np.zeros((CHECKERBOARD[0]*CHECKERBOARD[1], 3), np.float32)
objp[:,:2] = np.mgrid[0:CHECKERBOARD[0], 0:CHECKERBOARD[1]].T.reshape(-1,2)

obj_pts, img_pts = [], []
for fname in images:
    img  = cv2.imread(fname)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ret, corners = cv2.findChessboardCorners(gray, CHECKERBOARD, None)
    if ret:
        obj_pts.append(objp)
        img_pts.append(corners)

ret, mtx, dist, rvecs, tvecs = cv2.calibrateCamera(obj_pts, img_pts, gray.shape[::-1], None, None)
print("Camera matrix:\n", mtx)
print("Distortion:\n", dist)
# → הכנס fx, fy, cx, cy מ-mtx לתוך vision_agent.py
```

---

## Endpoints שהג'טסון שולח לקונסולה

| Endpoint | תדירות | תיאור |
|----------|--------|-------|
| `POST /api/jetson/heartbeat` | כל 5 שניות | CPU, RAM, טמפ |
| `POST /api/vision/vio-pose` | כל פריים (~30Hz) | Position estimate מCAM1 |
| `POST /api/vision/flow` | כל פריים (~30Hz) | Optical flow מCAM2 |
| `POST /api/vision/frame` | בנחיתה בלבד | זיהוי נקודת נחיתה מCAM1 |

---

## בדיקת קישוריות

```bash
# בדיקת heartbeat
curl -X POST http://192.168.1.100:4010/api/jetson/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"cpuLoadPct":30,"tempC":45,"memPct":60,"agentVersion":"2.0.0","navMode":"dual-camera-vio"}'

# בדיקת VIO
curl -X POST http://192.168.1.100:4010/api/vision/vio-pose \
  -H "Content-Type: application/json" \
  -d '{"posX":0,"posY":0,"posZ":1.2,"yawDeg":0,"confidence":0.85,"fps":28.5,"cam":"CAM1"}'

# בדיקת Optical Flow
curl -X POST http://192.168.1.100:4010/api/vision/flow \
  -H "Content-Type: application/json" \
  -d '{"flowX":0.002,"flowY":-0.001,"quality":180,"fps":29.1,"cam":"CAM2"}'
```

---

## שגיאות נפוצות

| שגיאה | פתרון |
|-------|-------|
| `GStreamer pipeline failed` | ודא JetPack עם `nvarguscamerasrc` מותקן |
| `MAVLink: no heartbeat` | בדוק חיבור UART ומהירות baud |
| `confidence < 0.05` — VIO לא שולח | תאורה חלשה / תנועה איטית מדי → הוסף תאורה |
| `OPTICAL_FLOW_RAD` לא מגיע לEKF | ודא `FLOW_TYPE=6` וש-ArduPilot מקבל MAVLink על הפורט הנכון |
| טיסה לא יציבה ללא GPS | כייל מצלמות, ודא `EK3_VISO_DELAY` מוגדר נכון |

---

## גרסאות תאימות

| רכיב | מינימום | מומלץ |
|------|---------|-------|
| Jetson Agent | 2.0.0 | 2.0.0+ |
| ArduPilot | 4.4.x | 4.5.x (EKF3 stable) |
| JetPack | 5.x | 6.x |
| OpenCV | 4.5 | 4.8+ |
| pymavlink | 2.4.x | 2.4.40+ |
