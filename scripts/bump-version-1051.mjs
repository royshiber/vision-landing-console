/**
 * Why: single UTF-8-safe version bump for Vision Landing Console.
 * What: sets 1.01.51 and prepends VERSION_HISTORY entry (handles CRLF).
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJs = join(__dirname, '..', 'public', 'app.js');

let raw = readFileSync(appJs, 'utf8');
const useCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

if (!s.includes("version: '1.01.51'")) {
  s = s.replace(
    "const APP_VERSION_NEW = '1.01.50';",
    "const APP_VERSION_NEW = '1.01.51';"
  );
  const needle = `const VERSION_HISTORY = [
  {
    version: '1.01.50',`;
  const insert = `const VERSION_HISTORY = [
  {
    version: '1.01.51',
    date: '2026-03-27',
    changes: [
      'טלמטריה: בלי גלילה — כרטיסי המדדים מתמלאים בגובה הזמין (overflow נסתר, שורות גריד שוות).',
      'Telemetry: no inner scroll; metric cards stretch to available height with equal grid rows.',
    ],
  },
  {
    version: '1.01.50',`;
  if (!s.includes(needle)) {
    console.error('bump-version-1051: anchor not found');
    process.exit(1);
  }
  s = s.replace(needle, insert);
}

const out = useCRLF ? s.replace(/\n/g, '\r\n') : s;
writeFileSync(appJs, out, 'utf8');
console.log('ok', appJs);
