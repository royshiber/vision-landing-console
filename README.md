# Vision Landing Console

נפרד, נקי — ממשק לניסוי נחיתה מבוססת מצלמה, Jetson כ־companion, ArduPilot, ויועץ Gemini עם זיכרון טיסות/לוגים.  
**חזון ארוך טווח (בלי להסתיר את השלב הנוכחי):** להביא לפיתוח כטב״מים ורובוטיקה את מה שכלי סוג Cursor הביא לעולם פיתוח הקוד — **סביבה אחת** שמרכזת קוד, פרמטרים, חומרה ובינה, ומתאימה גם למהנדסים וגם למי שאינו מהנדס.

## תקציר עסקי ויכולות מוצר

ראה **[`docs/COMMERCIAL_CAPABILITIES.he.md`](docs/COMMERCIAL_CAPABILITIES.he.md)** — מיפוי מלא (מאות שורות) של טאבים, בינה, Jetson, MAVLink, מאגר נתונים, API, בטיחות Apply, ופריסה. **מומלץ לעדכן אותו בהתאם ל־`public/changelog.json` כשמתפרסמת יכולת מוצר משמעותית.**

## פרויקט נפרד מ־GitHub ומ־Cursor

- ריפו Git נפרד מתוכנות אחרות (למשל "תוכנת לוגים"). שכפול/דחיפה רק מתוך תיקיית **`VisionLandingConsole`**.
- ב-Cursor: **File → Open Folder** על התיקייה הזו כשורש workspace — כדי שלא יתערבבו כללים, גרסאות ונתיבים מפרויקטים אחרים.
- GitHub אינו שומר קבצים לבד: השינויים מגיעים לשם רק אחרי **commit + push** מהמחשב שלך.

## הרצה

```powershell
cd "C:\Users\shibe\VisionLandingConsole"
npm install
npm run vendor:sync
copy .env.example .env
# ערוך .env: GEMINI_API_KEY, GITHUB_INGEST_SECRET
npm run start
```

**Air-gap / סגור רשת:** התיקייה `public/vendor/` נוצרת על ידי `vendor:sync` ומופיעה ב־`.gitignore` — העתק אותה יחד עם הקוד לסביבה מנותקת אחרי הרצה חד־פעמית במחשב מחובר. טאבי מפה עם Leaflet עדיין טוענים ספריות מ־CDN; להשלמת air-gap מלא לאחסון מקומי של Leaflet יידרש צעד דומה נפרד.

אם נשאר תהליך `node` ישן על פורט 4010 (רואים ב־`/api/health` גרסה ישנה או מודל ישן), הרץ:

```powershell
npm run start:clean
```

פתח: [http://localhost:4010](http://localhost:4010)

## סימולטור על ווינדוס

ההפעלה היא על המחשב הנייד של המפעיל. לא על לינוקס ולא על שרת. אין צורך בהרשאת מנהל.

1. לחצו פעמיים על הקובץ:

```bat
scripts\windows\Start-AIRVIX-SITL.bat
```

2. הסקריפט מוריד פעם אחת את בניין המטוס היציב מאתר הקושחה הרשמי, שומר אותו בתיקיית המשתמש, ובודק שהתהליך באמת רץ.
3. פתחו את הקונסולה. בפאנל החיבור לחצו על הכפתור:

```text
סימולטור
```

4. החיבור הוא אל המחשב המקומי בפורט

```text
5760
```

5. תג בכותרת מופיע רק כשהכלי המחובר הוא סימולטור. מטוס אמיתי לא מקבל את התג.

מיקום הבית ברירת המחדל הוא ליד תל אביב. אפשר לשנות אותו בהפעלה, למשל:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Start-AIRVIX-SITL.ps1 -HomeLat 32.0853 -HomeLon 34.7818 -HomeAlt 15 -HomeHdg 90
```

תחנה נוספת, כמו מתכנן משימה או תחנת קרקע, יכולה להאזין במקביל על פורט

```text
14550
```

כדי לבטל את היציאה הנוספת:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Start-AIRVIX-SITL.ps1 -NoGcsUdp
```

### ריאלפלייט

אפשר להשתמש בריאלפלייט כמנוע הפיזיקה. קודם פותחים את המשחק ומפעילים את קישור פלייטאקסיס. אחר כך:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Start-AIRVIX-SITL.ps1 -Physics flightaxis
```

בלי הקישור במשחק הסימולטור נסגר, והחלון כותב למה. אין כשל שקט.

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
