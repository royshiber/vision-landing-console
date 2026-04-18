/**
 * Why: UTF-8-safe version bump after telemetry visual polish.
 * What: prepends 1.01.52 to VERSION_HISTORY; handles CRLF.
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJs = join(__dirname, '..', 'public', 'app.js');

let raw = readFileSync(appJs, 'utf8');
const useCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

if (!s.includes("version: '1.01.52'")) {
  s = s.replace(
    "const APP_VERSION_NEW = '1.01.51';",
    "const APP_VERSION_NEW = '1.01.52';"
  );
  const needle = `const VERSION_HISTORY = [
  {
    version: '1.01.51',`;
  const insert = `const VERSION_HISTORY = [
  {
    version: '1.01.52',
    date: '2026-03-27',
    changes: [
      'טלמטריה: מראה מקצועי יותר — פינות מעוגלות, צללים עדינים, כותרות בצבע ראשי; גרידים קבועים לפי פאנל (Vision 3+2 ממורכז, Jetson 4+1, קישוריות 4×2, SLAM 2×2) ליישור אחיד.',
      'Telemetry dashboard: refined cards/panels, fixed per-panel metric grids for aligned rows; no layout change to data bindings.',
    ],
  },
  {
    version: '1.01.51',`;
  if (!s.includes(needle)) {
    console.error('bump-version-1052: anchor not found');
    process.exit(1);
  }
  s = s.replace(needle, insert);
}

writeFileSync(appJs, useCRLF ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('ok', appJs);
