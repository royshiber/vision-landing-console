# Vision Landing Console

נפרד, נקי — ממשק לניסוי נחיתה מבוססת מצלמה, Jetson כ־companion, ArduPilot, ויועץ Gemini עם זיכרון טיסות/לוגים.

## פרויקט נפרד מ־GitHub ומ־Cursor

- ריפו Git נפרד מתוכנות אחרות (למשל "תוכנת לוגים"). שכפול/דחיפה רק מתוך תיקיית **`VisionLandingConsole`**.
- ב-Cursor: **File → Open Folder** על התיקייה הזו כשורש workspace — כדי שלא יתערבבו כללים, גרסאות ונתיבים מפרויקטים אחרים.
- GitHub אינו שומר קבצים לבד: השינויים מגיעים לשם רק אחרי **commit + push** מהמחשב שלך.

## הרצה

```powershell
cd "C:\Users\shibe\VisionLandingConsole"
npm install
copy .env.example .env
# ערוך .env: GEMINI_API_KEY, GITHUB_INGEST_SECRET
npm run start
```

אם נשאר תהליך `node` ישן על פורט 4010 (רואים ב־`/api/health` גרסה ישנה או מודל ישן), הרץ:

```powershell
npm run start:clean
```

פתח: [http://localhost:4010](http://localhost:4010)

## משתני סביבה (`.env`)

| משתנה | משמעות |
|--------|--------|
| `GEMINI_API_KEY` | מפתח מ-Google AI Studio (בשרת בלבד) |
| `GEMINI_MODEL` | אופציונלי, ברירת מחדל `gemini-2.5-flash`. מזהים ישנים (למשל ‎1.5‎ / ‎2.0-flash‎) ממופים אוטומטית ל־2.5 כשה-API מחזיר 404 / לא זמין לחשבון חדש. |
| `GITHUB_INGEST_SECRET` | סוד שחייב להתאים ל־`CONSOLE_INGEST_TOKEN` ב-GitHub Secrets |
| `PORT` | אופציונלי, ברירת מחדל `4010` |

## נתונים מקומיים

- SQLite: `data/vision-landing.sqlite`
- העלאות לוגים: `data/uploads/` (לא לשבות ב-git)

## GitHub Actions → עדכון קוד אוטומטי

ראה [docs/GITHUB_SYNC.md](docs/GITHUB_SYNC.md) וה-workflow [`.github/workflows/notify-console.yml`](.github/workflows/notify-console.yml).

## Jetson ותאימות

- API עדכני: `GET/POST /api/jetson/*`
- תאימות לאחור: `GET/POST /api/rpi/*` מזוהה לאותו מצב בשרת.

## קיצור דסקטופ

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\shibe\VisionLandingConsole\scripts\create-desktop-shortcut.ps1"
```
