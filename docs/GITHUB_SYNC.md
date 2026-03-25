# סנכרון אוטומטי GitHub → Vision Landing Console

## למה זה קיים

היועץ (Gemini) צריך **תמיד** לדעת אילו קבצים השתנו בקומיט האחרון. **לא מסתמכים על זיכרון או על עדכון ידני** — רק על workflow שרץ אחרי כל `push`.

## מה צריך להגדיר

1. **בשרת הקונסול** (קובץ `.env` ליד `server.js`):
   - `GITHUB_INGEST_SECRET` — מחרוזת סודית ארוכה (אותה תדביק ב-GitHub).
   - `GEMINI_API_KEY` — מפתח מ-Google AI Studio.

2. **חשוף את הנתיב לרשת**  
   ה-URL ש-GitHub Actions קורא אליו חייב להיות נגיש מהאינטרנט (למשל tunnel כמו Cloudflare/ngrok, או שרת VPS).  
   הערך יהיה: `https://YOUR_HOST/api/integrations/github/ingest`

3. **ב-GitHub → Settings → Secrets and variables → Actions**
   - `CONSOLE_INGEST_URL` — האדרס המלא לעיל.
   - `CONSOLE_INGEST_TOKEN` — **בדיוק** אותו ערך כמו `GITHUB_INGEST_SECRET` בשרת.

## איך לוודא שזה עובד

1. דחוף קומיט ל-`main` או `master`.
2. בכרטיסייה **Actions** בריפו — workflow **Notify Vision Landing Console** צריך להיות ירוק.
3. אם האדום — לחץ על ה-job וראה את שגיאת `curl` (לרוב 401 = טוקן לא תואם, connection = URL לא נגיש).

## אם אין tunnel

עד שיש URL ציבורי, ה-workflow ייכשל בכוונה (עדיף אדום בגיטהאב מלבלבול שקט). אפשר להשבית זמנית את הקובץ ב-`.github/workflows/` או להסיר את ה-secrets כדי לא לרוץ — **אבל** אז יש לזכור להחזיר כשיש תשתית.
