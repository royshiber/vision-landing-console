/**
 * Report Hebrew UI calques. Prints offenders and exits 0.
 * Exits 1 only when a banned term appears that is not in the baseline.
 *
 *   node scripts/hebrew-copy-scan.mjs
 *   node scripts/hebrew-copy-scan.mjs --write-baseline tests/hebrew-copy-baseline.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Stems, longest first. A single Hebrew proclitic may precede a stem. */
export const BANNED_STEMS = [
  { stem: 'בקשת מיזוג', approved: 'PR', concept: 'pull request', phrase: true },
  { stem: 'נקודות קצה', approved: 'endpoints', concept: 'endpoint', phrase: true },
  { stem: 'נקודת קצה', approved: 'endpoint', concept: 'endpoint', phrase: true },
  { stem: 'תצורת', approved: 'הגדרות', devApproved: 'קונפיגורציית', concept: 'configuration' },
  { stem: 'תצורה', approved: 'הגדרות', devApproved: 'קונפיגורציה', concept: 'configuration' },
  { stem: 'קונפיגורציה', approved: 'הגדרות', devApproved: null, concept: 'configuration' },
  { stem: 'קצה', approved: 'endpoint', concept: 'endpoint' },
  { stem: 'אסימון', approved: 'טוקן', concept: 'token' },
  { stem: 'קושחה', approved: 'פירמוור', concept: 'firmware' },
  { stem: 'מחרוזת', approved: 'טקסט', concept: 'text' },
  { stem: 'פריסה', approved: 'דיפלוי', concept: 'deploy' },
  { stem: 'ענף', approved: 'בראנץ׳', concept: 'branch' },
];

/** Prompts and intent keywords. קונפיגורציה is allowed here. UI copy is not. */
const DEV_FILES = new Set([
  'lib/auto-config-recipes.mjs',
  'lib/gemini-advisor.mjs',
  'lib/assist/assist-intent-resolver.mjs',
  'lib/assist/assist-routes.mjs',
]);

function approvedFor(entry, rel) {
  if (DEV_FILES.has(rel) && Object.prototype.hasOwnProperty.call(entry, 'devApproved')) return entry.devApproved;
  return entry.approved;
}

const PROCLITIC = 'בהוכלמש';
const HE = '\\u0590-\\u05FF';

const SCAN_ROOTS = ['public', 'lib'];
const SCAN_FILES = ['server.js'];
const SKIP_DIRS = new Set(['node_modules', 'vendor']);
const SKIP_FILES = new Set(['changelog.json']);
const EXTS = new Set(['.js', '.mjs', '.html', '.css']);

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(name))) out.push(full);
  }
}

export function uiSourceFiles(root = repoRoot) {
  const files = [];
  for (const rel of SCAN_ROOTS) walk(path.join(root, rel), files);
  for (const rel of SCAN_FILES) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) files.push(full);
  }
  return files.sort();
}

function stemPattern(entry) {
  const body = entry.stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?<![${HE}])([${PROCLITIC}])?(${body})(?![${HE}])`, 'g');
}

function joinPrefix(prefix, approved) {
  if (!prefix) return approved;
  if (/^[A-Za-z]/.test(approved)) return `${prefix}-${approved}`;
  return `${prefix}${approved}`;
}

const PATTERNS = BANNED_STEMS.map((entry) => ({ ...entry, re: stemPattern(entry) }));

const PHRASE_OVERRIDES = [
  ['חסרה מחרוזת חיפוש', 'חסר טקסט לחיפוש'],
  ['לא תוחל תצורת מחשב משימה.', 'לא יוחלו הגדרות של מחשב המשימה.'],
  ['Jetson אינו נקודת קצה רדיו', 'Jetson אינו endpoint רדיו'],
  ['גררו קצה לשינוי גודל', 'גררו את הפינה לשינוי גודל'],
];

export function suggest(text, rel = '') {
  let next = text;
  for (const [from, to] of PHRASE_OVERRIDES) next = next.split(from).join(to);
  for (const entry of PATTERNS) {
    const approved = approvedFor(entry, rel);
    if (approved == null) continue;
    next = next.replace(entry.re, (...args) => joinPrefix(args[1] || '', approved));
  }
  return next;
}

function readable(raw, matched) {
  let text = raw;
  if (text.includes('<')) {
    const titles = [...text.matchAll(/\btitle="([^"]*)"/g)].map((m) => m[1]);
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const bits = [];
    for (const title of titles) {
      if (matched.some((term) => title.includes(term))) bits.push(title);
    }
    if (matched.some((term) => plain.includes(term))) bits.push(plain);
    if (bits.length) text = bits.join(' | ');
  }
  return text.trim();
}

function visibleText(line, matched) {
  const chunks = [];
  const quoted = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  for (const m of line.matchAll(quoted)) {
    const body = m[2].replace(/\\n/g, '\n');
    if (matched.some((term) => body.includes(term))) chunks.push(body);
  }
  const raw = chunks.length ? chunks.join(' | ') : line.trim();
  let text = readable(raw, matched);
  const he = text.search(/[\u0590-\u05FF]/);
  if (he > 0 && /[=`{]/.test(text.slice(0, he))) text = text.slice(he).trim();
  return text;
}

export function scanText(rel, text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (!/[\u0590-\u05FF]/.test(line)) return;
    const found = [];
    for (const entry of PATTERNS) {
      if (approvedFor(entry, rel) == null) continue;
      entry.re.lastIndex = 0;
      if (!entry.re.test(line)) continue;
      if (found.some((longer) => longer !== entry.stem && longer.includes(entry.stem))) continue;
      found.push(entry.stem);
    }
    if (!found.length) return;
    const current = visibleText(line, found);
    hits.push({
      file: rel,
      line: index + 1,
      term: found.join(', '),
      text: current,
      suggested: suggest(current, rel),
    });
  });
  return hits;
}

export function scanUi(root = repoRoot) {
  const hits = [];
  for (const full of uiSourceFiles(root)) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    hits.push(...scanText(rel, fs.readFileSync(full, 'utf8')));
  }
  return hits;
}

export function offenderKey(hit) {
  return `${hit.file}\n${hit.text}`;
}

export function countKeys(hits) {
  const counts = new Map();
  for (const hit of hits) {
    const key = offenderKey(hit);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function newOffenders(hits, baselineHits) {
  const allowed = countKeys(baselineHits);
  const seen = new Map();
  const added = [];
  for (const hit of hits) {
    const key = offenderKey(hit);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > (allowed.get(key) || 0)) added.push(hit);
  }
  return added;
}

export function formatReport(hits) {
  const lines = [`hebrew-copy report: ${hits.length} offender${hits.length === 1 ? '' : 's'}`];
  for (const hit of hits) {
    lines.push(`${hit.file}:${hit.line} [${hit.term}]`);
    lines.push(`  current: ${hit.text.replace(/\n/g, ' / ')}`);
    lines.push(`  suggested: ${hit.suggested.replace(/\n/g, ' / ')}`);
  }
  return lines.join('\n');
}

export function loadBaseline(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.offenders || [];
}

function baselinePayload(hits) {
  return {
    note: 'Known calques. The scanner fails only when a banned term shows up beyond this list. Removing a row is safe.',
    offenders: hits.map(({ file, line, term, text, suggested }) => ({ file, line, term, text, suggested })),
  };
}

function main() {
  const writeIdx = process.argv.indexOf('--write-baseline');
  const hits = scanUi();
  if (writeIdx !== -1) {
    const out = path.resolve(process.argv[writeIdx + 1] || path.join(repoRoot, 'tests/hebrew-copy-baseline.json'));
    fs.writeFileSync(out, `${JSON.stringify(baselinePayload(hits), null, 2)}\n`);
    console.log(`wrote ${hits.length} offenders to ${out}`);
    return;
  }
  console.log(formatReport(hits));
  const baselinePath = path.join(repoRoot, 'tests/hebrew-copy-baseline.json');
  if (!fs.existsSync(baselinePath)) return;
  const added = newOffenders(hits, loadBaseline(baselinePath));
  if (added.length) {
    console.error(`\nnew banned terms (${added.length}):`);
    console.error(formatReport(added));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
