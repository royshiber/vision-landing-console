/**
 * Why: bump client version history with UTF-8 Hebrew without mojibake.
 * What: prepends 1.01.50 to VERSION_HISTORY and sets APP_VERSION_NEW (idempotent).
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJs = join(__dirname, '..', 'public', 'app.js');

let raw = readFileSync(appJs, 'utf8');
const useCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

if (s.includes("version: '1.01.50'")) {
  console.log('already has 1.01.50 in VERSION_HISTORY — skipping insert');
} else {
  s = s.replace(
    "const APP_VERSION_NEW = '1.01.27';",
    "const APP_VERSION_NEW = '1.01.50';"
  );
  const needle = `const VERSION_HISTORY = [
  {
    version: '1.01.27',
    date: '2026-03-26',
    changes: [
      'הסרת כל כפתורי וקוד הסימולציה/דמו מהממשק ומהשרת — הכלי מציג נתונים אמיתיים בלבד (Jetson + Vision + SLAM).',
      'Removed all mock/simulation/demo buttons and server routes; UI now shows only real hardware data.',
    ],
  },`;
  const insert = `const VERSION_HISTORY = [
  {
    version: '1.01.50',
    date: '2026-03-27',
    changes: [
      'טלמטריה וסטטוסים: פחות דחיסות — כרטיסי מדדים גדולים יותר, ריווח נוח, שתי שורות שוות בגובה שממלאות את גובה המסך; גלילה פנימית רק אם יש הרבה מדדים.',
      'Telemetry: roomier metrics grid, equal-height rows, larger type; inner scroll only when needed.',
    ],
  },
  {
    version: '1.01.27',
    date: '2026-03-26',
    changes: [
      'הסרת כל כפתורי וקוד הסימולציה/דמו מהממשק ומהשרת — הכלי מציג נתונים אמיתיים בלבד (Jetson + Vision + SLAM).',
      'Removed all mock/simulation/demo buttons and server routes; UI now shows only real hardware data.',
    ],
  },`;
  if (!s.includes(needle)) {
    console.error('apply-version-1050: anchor block not found (file changed?)');
    process.exit(1);
  }
  s = s.replace(needle, insert);
}

const out = useCRLF ? s.replace(/\n/g, '\r\n') : s;
writeFileSync(appJs, out, 'utf8');
console.log('ok', appJs);
