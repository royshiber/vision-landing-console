# Hebrew copy glossary

Rules for console Hebrew. The voice is a normal Israeli app, not a word-for-word translation from English.

Surveyed on current `master`: every Hebrew string in `public/` (except `changelog.json` and `vendor/`), `lib/`, and `server.js`. There is no `src/` tree. That is 164 files and 4,430 Hebrew lines. The scanner below gates only the banned calques. It does not edit UI strings.

## Voice

Address the user in the plural imperative.

| say | do not say |
| --- | --- |
| שאלו | שאל |
| הזינו | הזן |
| בחרו | בחר |
| בדקו | בדוק |
| פתחו | פתח |
| נסו | נסה |

Already in this voice: `הזינו אותו במתקדם`, `בדקו כתובת`, `נסו שוב`.

Still singular, and not gated yet (fix in the copy sweep, not by this scanner):

- `public/app.js` — `בצע «READ — מהרחפן»`
- `lib/auto-config-recipes.mjs` — `ודא שהמשדר`
- `lib/auto-connect-utils.mjs` — `סגור את Mission Planner` and `נסה שוב`

## Terms that stay in English or as a transliteration

GPS, RC, API, EKF, PR, worktree. FC in a Hebrew sentence is `בקר טיסה`. A serial port is `פורט`. Firmware is `פירמוור`. A token is `טוקן`. A git branch is `בראנץ׳`. A commit is `קומיט`. A module is `מודול`. A parameter is `פרמטר`. Telemetry is `טלמטריה`. Deploy is `דיפלוי`. Configuration is `קונפיגורציה`.

One Hebrew term per concept. Do not also use the academy calque.

## Concept table

Built from the strings in the survey. Approved is the term to write. Banned is what the scanner rejects (empty when the survey already uses only the approved term).

| concept | approved | banned variants |
| --- | --- | --- |
| token | טוקן | אסימון, האסימון, ואסימון |
| flight controller | בקר טיסה | |
| GPS | GPS | |
| RC | RC | |
| API | API | |
| EKF | EKF | |
| endpoint | קצה | נקודת קצה |
| configuration | קונפיגורציה | תצורה, תצורת |
| settings | הגדרות | |
| git branch | בראנץ׳ | ענף, הענף, בענף, לענף |
| merge | מיזוג | |
| pull request | PR | בקשת מיזוג |
| deploy | דיפלוי | פריסה |
| firmware | פירמוור | קושחה, הקושחה, בקושחה |
| commit | קומיט | |
| module | מודול | |
| serial port | פורט | |
| exit code or PWM output | יציאה | |
| user-visible text | טקסט | מחרוזת |
| data store | מאגר | |
| loop closure | סגירת לולאה | |
| parameter | פרמטר | |
| telemetry | טלמטריה | |
| mission computer | מחשב משימה | |

`יציאה` stays for an exit code and for a PWM output. A COM port is `פורט`, not `יציאה`. `מאגר` stays for a flight log store or a version catalog. `מיזוג` stays for the merge action. The calque is only `בקשת מיזוג`.

## Banned calques

The scanner reads these stems. One Hebrew proclitic (`ב ה ו כ ל מ ש`) may sit on the front. `האסימון` is the `אסימון` stem.

| banned | write instead |
| --- | --- |
| אסימון | טוקן |
| נקודת קצה | קצה |
| תצורה | קונפיגורציה |
| תצורת | קונפיגורציית |
| ענף | בראנץ׳ |
| בקשת מיזוג | PR |
| פריסה | דיפלוי |
| קושחה | פירמוור |
| מחרוזת | טקסט |

Known full-line replacements the scanner applies before the stem swap:

- `חסר אסימון. הזינו אותו במתקדם.` → `חסר טוקן. הזינו אותו במתקדם.`
- `חסרה מחרוזת חיפוש` → `חסר טקסט לחיפוש`
- `לא תוחל תצורת מחשב משימה.` → `לא תוחל קונפיגורציה של מחשב המשימה.`
- `Jetson אינו נקודת קצה רדיו` → `Jetson אינו קצה הרדיו`

## Scanner

`node scripts/hebrew-copy-scan.mjs` prints every current hit and exits 0 while each hit is listed in `tests/hebrew-copy-baseline.json`.

A hit that is not in that file fails the script and `tests/hebrew-copy-glossary.test.mjs`. Deleting a baseline row after the copy is fixed does not fail. Adding `אסימון` (or any stem above) in `public/`, `lib/`, or `server.js` does.

The baseline is the input list for the copy sweep. It is file, current text, and suggested text. This change does not rewrite those strings.
