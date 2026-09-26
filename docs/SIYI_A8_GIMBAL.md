# SIYI A8 mini — חיבור ל־Jetson

הגימבל יושב על אתרנט של ה־Jetson. זה לא פקודת טיסה. שליטה (זום, היגוי, צילום) כבויה עד שמפעילים אותה במפורש.

המצלמה עצמה: `192.168.144.25`. ה־Jetson בצד הזה: `192.168.144.20/24`. פורט הפקודות: `37260` UDP. זרם הווידאו: `rtsp://192.168.144.25:8554/main.264`.

## חיווט

לפי המדריך של A8 mini: הזנה ישירה מהסוללה, 4S, בלי וסת באמצע. אל תחברו את הגימבל דרך וסת של מנוע.

כבל הרשת מהגימבל נכנס לשקע האתרנט של ה־Jetson (ב־Orin Nano הכרטיס הוא `enP8p1s0`). אל תגעו ב־Wi-Fi ובפרופיל הסלולר.

## רשת

על ה־Jetson, מתוך תיקיית companion:

```
./siyi-net.sh --dry-run
./siyi-net.sh
./siyi-net.sh --status
```

הסקריפט יוצר פרופיל NetworkManager בשם `airvix-siyi` בלבד:

- כתובת `192.168.144.20/24`
- `ipv4.never-default yes` — הרשת הזו לא הופכת למסלול ברירת המחדל
- בלי DNS
- IPv6 כבוי
- autoconnect עם עדיפות 10

`--remove` מוחק רק את `airvix-siyi`.

## מצלמה שלישית

ברירת המחדל של cam3 כבויה. אחרי שהרשת עולה:

```
export VLC_CAM3_ENABLED=1
export VLC_CAM3_DEVICE=rtsp://192.168.144.25:8554/main.264
export VLC_CAM3_CODEC=auto
```

בדיקה:

```
curl -s http://127.0.0.1:8081/api/v1/status/cameras
curl -s -o /tmp/cam3.jpg -w '%{http_code}\n' http://127.0.0.1:8081/api/v1/cameras/cam3/frame.jpg
curl -s http://127.0.0.1:8081/api/v1/status/gimbal
```

בלי פריים חוזר `404` והטקסט אין פריים. בלי מענה מהגימבל, `present` הוא false ואין זווית מומצאת.

## שליטה

כבוי כברירת מחדל. בקשת POST חוזרת `403` עם הסיבה בעברית, ובלי לשלוח חבילה.

```
export VLC_GIMBAL_CONTROL_ENABLED=1
```

נתיבים: `POST /api/v1/gimbal/rate|angle|center|zoom|mode|photo|record`.

גבולות A8: יאו בין מינוס 135 ל־135 מעלות, פיץ' בין מינוס 90 ל־25. קצב בין מינוס 100 ל־100. ערך חורג נחתך לגבול, לא נשלח כמו שהוא.

פקודת הזווית היא `0x0E` (במדריך הישן כתוב בטעות `0x0D`, שזה גם קריאת מצב). לשנות רק אם צריך:

```
export VLC_SIYI_ANGLE_CMD=0x0D
```

## רשימת בדיקה לרועי

1. חברו הזנת 4S ישר מהסוללה, והרשת לשקע האתרנט.
2. הריצו את סקריפט הרשת ובדקו ש־`--status` מראה את הכתובת `192.168.144.20/24`. בלי הכתובת — אין חיבור.
3. הפעילו את cam3 ובדקו JPEG. בלי קובץ תמונה אמיתי אל תסמנו שהמצלמה חיה.
4. בדקו `status/gimbal`. רק `present: true` עם גיל פריים קצר הוא מענה אמיתי.
5. השאירו את השליטה כבויה עד שאתם רוצים להזיז. `403` הוא המצב הנכון.
6. Wi-Fi והסלולר נשארים כמו שהיו.

## תקלות

| מה רואים | מה לבדוק |
|---|---|
| `present: false` ו־`no_reply` | הזנה, כבל רשת, ושהפרופיל על האתרנט ולא על ה־Wi-Fi |
| `state: disabled` ב־cam3 | חסר `VLC_CAM3_ENABLED=1` |
| `read_failed` על RTSP | הכתובת, והאם OpenCV נבנה עם GStreamer. בלי זה יש נפילה ל־FFmpeg |
| `opencv_unavailable` | אין חבילת cv2 ב־venv |
| `403` על שליטה | `VLC_GIMBAL_CONTROL_ENABLED` עדיין 0 |

התקנת OpenCV על ה־Jetson, בתוך `~/mavlink-env`:

```
~/mavlink-env/bin/pip install opencv-python-headless
```

אם יש OpenCV מערכת עם GStreamer (נדרש ל־CSI ולפענוח חומרה של RTSP), העדיפו אותו על חבילת pip בלי GStreamer.
