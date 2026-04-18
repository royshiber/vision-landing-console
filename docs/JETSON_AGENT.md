# Jetson Agent — מדריך אינטגרציה עם Vision Landing Console

## סקירה

הג'טסון מתקשר עם הקונסולה דרך HTTP POST.  
הקונסולה **לא מתחברת ליזמה ל-Jetson** — הג'טסון הוא זה שמתחיל כל תקשורת.

**כתובת בסיסית:** `http://<IP-של-המחשב>:4010`

> טיפ: הכתובת מוצגת בטאב "חיבורים" עם QR code לסריקה נוחה.

---

## Endpoints נדרשים

### 1. Heartbeat (חובה — כל 5 שניות)

```
POST /api/jetson/heartbeat
Content-Type: application/json
```

**גוף הבקשה המינימלי:**
```json
{
  "cpuLoadPct": 45.2,
  "tempC": 52.0,
  "memPct": 63.1
}
```

**גוף מלא עם גרסאות (נדרש לבדיקת תאימות):**
```json
{
  "cpuLoadPct": 45.2,
  "tempC": 52.0,
  "memPct": 63.1,
  "agentVersion": "1.2.0",
  "internalFwVersion": "2.0.0",
  "fcFirmwareVersion": "ArduCopter V4.5.2"
}
```

| שדה | סוג | תיאור |
|-----|-----|-------|
| `cpuLoadPct` | float | עומס CPU באחוזים (0–100) |
| `tempC` | float | טמפרטורה בצלזיוס |
| `memPct` | float | שימוש RAM באחוזים (0–100) |
| `agentVersion` | string | גרסת הסקריפט הפנימי — `"1.2.0"` |
| `internalFwVersion` | string | גרסת ה-FW הפנימי של הג'טסון |
| `fcFirmwareVersion` | string | גרסת ArduPilot שקראת מה-FC — `"ArduCopter V4.5.2"` |

---

### 2. Vision Frame (כל פריים שמעבדים)

```
POST /api/vision/frame
Content-Type: application/json
```

```json
{
  "lateralOffsetM": 0.35,
  "headingErrorDeg": -2.1,
  "confidence": 0.87
}
```

| שדה | סוג | טווח | תיאור |
|-----|-----|------|-------|
| `lateralOffsetM` | float | חופשי | סטייה רוחבית ממרכז מטרת הנחיתה (מטר) |
| `headingErrorDeg` | float | −180..180 | שגיאת כיוון (מעלות) |
| `confidence` | float | 0..1 | רמת ביטחון הזיהוי |

---

### 3. SLAM Pose (כל פריים SLAM)

```
POST /api/vision/slam-pose
Content-Type: application/json
```

```json
{
  "posX": 1.23,
  "posY": -0.45,
  "posZ": 5.10,
  "yawDeg": 182.5,
  "mapQuality": 0.91,
  "loopClosures": 3
}
```

---

## דוגמת Python מינימלית

```python
import time
import requests
import subprocess

SERVER = "http://192.168.1.100:4010"  # עדכן לIP של המחשב

AGENT_VERSION    = "1.2.0"
INTERNAL_FW_VER  = "2.0.0"

def get_fc_firmware():
    """קרא גרסת ArduPilot מה-FC דרך MAVProxy / pymavlink."""
    try:
        # דוגמה — החלף בקריאה האמיתית שלך
        return "ArduCopter V4.5.2"
    except Exception:
        return None

def get_cpu_load():
    import psutil
    return psutil.cpu_percent(interval=0.5)

def get_temp():
    try:
        with open("/sys/devices/virtual/thermal/thermal_zone0/temp") as f:
            return int(f.read()) / 1000.0
    except Exception:
        return None

def get_mem():
    import psutil
    return psutil.virtual_memory().percent

FC_FW = get_fc_firmware()

while True:
    payload = {
        "cpuLoadPct":       get_cpu_load(),
        "tempC":            get_temp(),
        "memPct":           get_mem(),
        "agentVersion":     AGENT_VERSION,
        "internalFwVersion": INTERNAL_FW_VER,
    }
    if FC_FW:
        payload["fcFirmwareVersion"] = FC_FW

    try:
        requests.post(f"{SERVER}/api/jetson/heartbeat", json=payload, timeout=3)
    except requests.RequestException as e:
        print(f"Heartbeat failed: {e}")

    time.sleep(5)
```

---

## דוגמת Python מלאה — heartbeat + vision + SLAM

```python
import time
import threading
import requests
import cv2          # או כל מה שאתה משתמש

SERVER = "http://192.168.1.100:4010"
AGENT_VERSION = "1.2.0"

def heartbeat_loop():
    while True:
        try:
            requests.post(f"{SERVER}/api/jetson/heartbeat", json={
                "cpuLoadPct": get_cpu_load(),
                "tempC":      get_temp(),
                "memPct":     get_mem(),
                "agentVersion": AGENT_VERSION,
                "fcFirmwareVersion": "ArduCopter V4.5.2",
            }, timeout=3)
        except Exception:
            pass
        time.sleep(5)

def vision_loop():
    while True:
        # ... עיבוד פריים ...
        confidence      = 0.87   # מהאלגוריתם שלך
        lateral_offset  = 0.35
        heading_error   = -2.1
        try:
            requests.post(f"{SERVER}/api/vision/frame", json={
                "lateralOffsetM":  lateral_offset,
                "headingErrorDeg": heading_error,
                "confidence":      confidence,
            }, timeout=2)
        except Exception:
            pass
        time.sleep(0.1)  # 10Hz

def slam_loop():
    while True:
        # ... SLAM pose מה-VIO שלך ...
        try:
            requests.post(f"{SERVER}/api/vision/slam-pose", json={
                "posX": 1.2, "posY": -0.3, "posZ": 5.1,
                "yawDeg": 182.0,
                "mapQuality": 0.91,
                "loopClosures": 3,
            }, timeout=2)
        except Exception:
            pass
        time.sleep(0.1)

threading.Thread(target=heartbeat_loop, daemon=True).start()
threading.Thread(target=vision_loop,    daemon=True).start()
threading.Thread(target=slam_loop,      daemon=True).start()

while True:
    time.sleep(1)
```

---

## בדיקת תאימות גרסאות

הקונסולה בודקת תאימות **בכל heartbeat** ומציגה באנר אם יש בעיה.

| גרסה | מינימום | מומלץ |
|------|---------|-------|
| Jetson Agent | 1.0.0 | 1.2.0+ |
| ArduPilot | 4.3.x | 4.5.x |
| Node.js (שרת) | 18+ | 20+ |

בדיקה ידנית:
```
GET http://<IP>:4010/api/health/compatibility
```

---

## בדיקת קישוריות מהג'טסון

```bash
# Heartbeat בסיסי
curl -X POST http://192.168.1.100:4010/api/jetson/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"cpuLoadPct":30,"tempC":45,"memPct":60,"agentVersion":"1.2.0","fcFirmwareVersion":"ArduCopter V4.5.2"}'

# בדיקת בריאות
curl http://192.168.1.100:4010/api/health

# תאימות גרסאות
curl http://192.168.1.100:4010/api/health/compatibility
```

---

## שגיאות נפוצות

| שגיאה | פתרון |
|-------|-------|
| `Connection refused` | ודא שהקונסולה רצה ושה-IP נכון |
| `Network unreachable` | ודא שהג'טסון והמחשב באותה רשת WiFi |
| `Timeout` | הקונסולה עמוסה — הגדל `timeout` בקוד |
| באנר "גרסה לא דווחה" | הוסף `agentVersion` ל-heartbeat |
