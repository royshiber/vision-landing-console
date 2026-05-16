#!/usr/bin/env node
/**
 * Why: keep APP_VERSION in sync across version.js, package.json and package-lock.json
 *      with a single command. Called manually (`npm run bump`) or automatically by the
 *      pre-commit git hook so the version never falls behind again.
 *
 * What: reads APP_VERSION from ./version.js, bumps patch (default) / minor / major,
 *       writes it back to version.js, package.json, and package-lock.json (top-level
 *       "version" only). Preserves zero-padding of the minor segment (e.g. "1.02.60").
 *       Also prepends a smart changelog entry based on staged files or a provided message.
 *
 * Usage:
 *   node scripts/bump-version.mjs                          # patch, auto-detect from staged
 *   node scripts/bump-version.mjs "תיאור השינוי"           # patch, custom description
 *   node scripts/bump-version.mjs --patch "..."
 *   node scripts/bump-version.mjs --minor "..."
 *   node scripts/bump-version.mjs --major "..."
 *   node scripts/bump-version.mjs --set 1.03.00
 *   node scripts/bump-version.mjs --silent
 *   node scripts/bump-version.mjs --from-staged            # auto-generate from staged files
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');

const VERSION_FILE   = path.join(repoRoot, 'version.js');
const PKG_FILE       = path.join(repoRoot, 'package.json');
const LOCK_FILE      = path.join(repoRoot, 'package-lock.json');
const CHANGELOG_FILE = path.join(repoRoot, 'public', 'changelog.json');

const args = process.argv.slice(2);
const silent = args.includes('--silent');
const fromStaged = args.includes('--from-staged');
const log = (...a) => { if (!silent) console.log('[bump]', ...a); };

// ── Staged-file → smart changelog generation ─────────────────────────────

const FILE_RULES = [
  { pattern: /^lib\/advisor-actions/,   type: 'feat',  label: 'Advisor safety gates (allowlist/denylist)' },
  { pattern: /^lib\/advisor-apply/,     type: 'feat',  label: 'Advisor Apply/Rollback/Audit' },
  { pattern: /^lib\/advisor-/,          type: 'feat',  label: 'Advisor module' },
  { pattern: /^lib\/gemini-advisor/,    type: 'feat',  label: 'Gemini advisor logic' },
  { pattern: /^lib\/session-baseline/,  type: 'feat',  label: 'Session baseline & pending-changes' },
  { pattern: /^lib\/mavlink/,           type: 'feat',  label: 'MAVLink connection' },
  { pattern: /^lib\/chat-memory/,       type: 'feat',  label: 'Chat memory' },
  { pattern: /^lib\/db/,               type: 'feat',  label: 'DB schema' },
  { pattern: /^lib\//,                 type: 'feat',  label: 'Server library' },
  { pattern: /^public\/app\.js/,       type: 'feat',  label: 'UI / app.js' },
  { pattern: /^public\/styles\.css/,   type: 'ui',    label: 'Styles' },
  { pattern: /^public\/index\.html/,   type: 'ui',    label: 'HTML layout' },
  { pattern: /^public\/changelog/,     type: 'chore', label: null },
  { pattern: /^public\//,             type: 'feat',  label: 'Frontend' },
  { pattern: /^server\.js/,           type: 'feat',  label: 'Server routes' },
  { pattern: /^tests\//,              type: 'test',  label: 'Tests' },
  { pattern: /^scripts\//,            type: 'chore', label: 'Build scripts' },
  { pattern: /^docs\/COMMERCIAL/,      type: 'docs', label: 'Commercial capabilities overview' },
  { pattern: /^docs\//,               type: 'docs',  label: 'Documentation' },
  { pattern: /^\.env/,                type: 'chore', label: 'Config' },
];

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMRD', { encoding: 'utf8' });
    return out.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Returns an array of { type, title, detail } — one entry per significant category.
 * Merges small categories together if there are more than 4.
 */
function generateChangelogFromStaged(files) {
  const typePriority = { feat: 0, fix: 1, ui: 2, test: 3, docs: 4, chore: 5 };
  // Map: label → { type, files[] }
  const cats = new Map();
  for (const file of files) {
    for (const rule of FILE_RULES) {
      if (rule.pattern.test(file) && rule.label) {
        if (!cats.has(rule.label)) cats.set(rule.label, { type: rule.type, files: [] });
        cats.get(rule.label).files.push(file);
        break;
      }
    }
  }
  if (cats.size === 0) return null;
  // Build one changelog entry per category (limit to 5 most important)
  const sorted = [...cats.entries()].sort((a, b) => (typePriority[a[1].type] ?? 9) - (typePriority[b[1].type] ?? 9));
  const result = sorted.slice(0, 5).map(([label, { type, files: catFiles }]) => ({
    type,
    title: label,
    detail: catFiles.map((f) => f.split('/').pop()).join(', '),
  }));
  return result;
}

function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`בלתי אפשרי לפרש גרסה: "${v}" (ציפינו לפורמט major.minor.patch)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), minorPad: m[2].length, patchPad: m[3].length };
}

function formatVersion({ major, minor, patch, minorPad = 2, patchPad = 2 }) {
  const p = Math.max(patchPad, String(patch).length);
  return `${major}.${String(minor).padStart(minorPad, '0')}.${String(patch).padStart(p, '0')}`;
}

function bump(current, kind) {
  const p = parseVersion(current);
  if (kind === 'major') return formatVersion({ major: p.major + 1, minor: 0, patch: 0, minorPad: p.minorPad, patchPad: p.patchPad });
  if (kind === 'minor') return formatVersion({ major: p.major, minor: p.minor + 1, patch: 0, minorPad: p.minorPad, patchPad: p.patchPad });
  return formatVersion({ ...p, patch: p.patch + 1 });
}

function readAppVersion() {
  if (!existsSync(VERSION_FILE)) throw new Error(`לא נמצא ${VERSION_FILE}`);
  const text = readFileSync(VERSION_FILE, 'utf8');
  const m = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error(`version.js לא מכיל APP_VERSION = '...'`);
  return { text, version: m[1] };
}

function writeAppVersion(text, oldV, newV) {
  const updated = text.replace(/APP_VERSION\s*=\s*['"][^'"]+['"]/, `APP_VERSION = '${newV}'`);
  writeFileSync(VERSION_FILE, updated, 'utf8');
  log(`version.js: ${oldV} → ${newV}`);
}

function prependChangelogEntry(newV, customDesc = null) {
  if (!existsSync(CHANGELOG_FILE)) { log(`דילוג: changelog.json לא קיים`); return false; }
  try {
    const raw = readFileSync(CHANGELOG_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) { log(`אזהרה: changelog.json אינו מערך`); return false; }
    if (arr.length > 0 && arr[0] && arr[0].version === newV) {
      log(`changelog.json: רשומה לגרסה ${newV} כבר קיימת`);
      return false;
    }
    const today = new Date().toISOString().slice(0, 10);

    // Priority: explicit description > auto-detect from staged > skeleton
    let change;
    if (customDesc && typeof customDesc === 'string' && customDesc.trim()) {
      const txt = customDesc.trim();
      // Allow "TYPE: title" prefix e.g. "feat: added X" or "FIX: fixed Y"
      const m = txt.match(/^(feat|fix|ui|test|docs|chore|refac|perf):\s*/i);
      if (m) {
        change = { type: m[1].toLowerCase(), title: txt.slice(m[0].length).trim(), detail: '' };
      } else {
        change = { type: 'feat', title: txt, detail: '' };
      }
    } else if (fromStaged || !customDesc) {
      const staged = getStagedFiles();
      const auto = staged.length > 0 ? generateChangelogFromStaged(staged) : null;
      if (auto) {
        // auto is now an array of changes
        const changes = Array.isArray(auto) ? auto : [auto];
        const entry = { version: newV, date: today, changes };
        arr.unshift(entry);
        writeFileSync(CHANGELOG_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
        log(`changelog.json: auto-generated ${changes.length} entries from ${staged.length} staged files`);
        log(`changelog.json: נוספה רשומה לגרסה ${newV}: ${changes.map((c) => `[${c.type}] ${c.title}`).join(' | ')}`);
        return true;
      } else {
        change = { type: 'chore', title: 'עדכון', detail: 'ערוך רשומה זו עם פירוט השינויים.' };
      }
    } else {
      change = { type: 'chore', title: 'עדכון', detail: 'ערוך רשומה זו עם פירוט השינויים.' };
    }

    const entry = { version: newV, date: today, changes: [change] };
    arr.unshift(entry);
    writeFileSync(CHANGELOG_FILE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    log(`changelog.json: נוספה רשומה לגרסה ${newV}: [${change.type}] ${change.title}`);
    return true;
  } catch (err) {
    log(`אזהרה: עדכון changelog.json נכשל — ${err.message}`);
    return false;
  }
}

function updateJsonVersion(file, newV) {
  if (!existsSync(file)) { log(`דילוג: ${path.basename(file)} לא קיים`); return false; }
  const raw = readFileSync(file, 'utf8');
  const before = raw.match(/"version"\s*:\s*"([^"]+)"/);
  if (!before) { log(`אזהרה: אין שדה "version" ב-${path.basename(file)}`); return false; }

  const obj = JSON.parse(raw);
  const oldV = obj.version;
  obj.version = newV;

  if (file === LOCK_FILE && obj.packages && obj.packages[''] && typeof obj.packages[''].version === 'string') {
    obj.packages[''].version = newV;
  }

  const indentMatch = raw.match(/\n(\s+)"/);
  const indent = indentMatch ? indentMatch[1].length : 2;
  const out = JSON.stringify(obj, null, indent) + (raw.endsWith('\n') ? '\n' : '');
  writeFileSync(file, out, 'utf8');
  log(`${path.basename(file)}: ${oldV} → ${newV}`);
  return true;
}

let mode = 'patch';
let explicit = null;
let customDesc = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--major' || a === '--minor' || a === '--patch') mode = a.slice(2);
  else if (a === '--set') explicit = args[++i];
  else if (a === '--silent' || a === '--from-staged') { /* handled above */ }
  else if (!a.startsWith('--')) {
    if (/^\d+\.\d+\.\d+$/.test(a)) explicit = a;
    else customDesc = a; // treat non-flag non-version arg as description
  }
}

try {
  const { text, version: current } = readAppVersion();
  const next = explicit ? explicit : bump(current, mode);
  if (next === current) { log(`גרסה לא השתנתה (${current}) — יוצא`); process.exit(0); }

  writeAppVersion(text, current, next);
  updateJsonVersion(PKG_FILE, next);
  updateJsonVersion(LOCK_FILE, next);
  prependChangelogEntry(next, customDesc);

  if (!silent) console.log(`✓ גרסה עודכנה: ${current} → ${next}`);
  else console.log(next);
} catch (err) {
  console.error('[bump] שגיאה:', err.message);
  process.exit(1);
}
