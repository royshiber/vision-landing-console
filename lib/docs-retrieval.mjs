/**
 * Tier A retrieval: Markdown under docs/ (project root). Token overlap scoring
 * (same tokenizer as lib/retrieval.mjs). See docs/RAG_TRUST.md.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import { tokenize } from './retrieval.mjs';

const DOCS_RAG_ENABLED = process.env.DOCS_RAG_ENABLED !== 'false';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCS_ROOT = join(__dirname, '..', 'docs');

/** @type {{ chunks: { relPath: string, text: string }[], loadedAt: number } | null} */
let cache = null;

function walkMarkdownFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.')) continue;
      walkMarkdownFiles(p, acc);
    } else if (ent.isFile() && extname(ent.name).toLowerCase() === '.md') {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Split file into chunks (heading-aware when possible).
 * @param {string} absPath
 * @param {string} relPath
 * @returns {{ relPath: string, text: string }[]}
 */
function chunkMarkdownFile(absPath, relPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const normalized = raw.replace(/\r\n/g, '\n');
  const parts = normalized.split(/\n(?=#{1,3}\s)/g);
  const out = [];
  const maxLen = 900;
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (part.length <= maxLen) {
      out.push({ relPath, text: part });
      continue;
    }
    for (let i = 0; i < part.length; i += maxLen) {
      out.push({ relPath, text: part.slice(i, i + maxLen) });
    }
  }
  return out;
}

function loadAllChunks() {
  const files = walkMarkdownFiles(DOCS_ROOT);
  /** @type {{ relPath: string, text: string }[]} */
  const chunks = [];
  for (const abs of files) {
    const rel = relative(DOCS_ROOT, abs).replace(/\\/g, '/');
    chunks.push(...chunkMarkdownFile(abs, rel));
  }
  return { chunks, loadedAt: Date.now() };
}

function getChunks() {
  if (!cache) cache = loadAllChunks();
  return cache.chunks;
}

/**
 * @param {string} question
 * @param {{ limit?: number }} [opts]
 * @returns {{ block: string, meta: { files: number, chunks: number, used: number } }}
 */
export function buildDocsRetrievalContext(question, { limit = 8 } = {}) {
  if (!DOCS_RAG_ENABLED) {
    return {
      block: '(אינדוקס מסמכי docs/ כבוי — DOCS_RAG_ENABLED=false.)',
      meta: { files: 0, chunks: 0, used: 0 },
    };
  }

  const chunks = getChunks();
  if (!chunks.length) {
    return {
      block: '(לא נמצאו קבצי .md בתיקיית docs/.)',
      meta: { files: 0, chunks: 0, used: 0 },
    };
  }

  const terms = new Set(tokenize(question));
  if (terms.size === 0) {
    return {
      block: '(אין מילות מפתח לחיפוש במסמכי docs/.)',
      meta: { files: new Set(chunks.map((c) => c.relPath)).size, chunks: chunks.length, used: 0 },
    };
  }

  const scored = chunks
    .map((c) => {
      const ws = tokenize(c.text);
      let s = 0;
      for (const w of ws) if (terms.has(w)) s += 1;
      const sc = s / Math.max(1, ws.length);
      return { c, sc };
    })
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit);

  if (!scored.length) {
    return {
      block: '(לא נמצאו התאמות במסמכי docs/ לשאלה הנוכחית.)',
      meta: { files: new Set(chunks.map((x) => x.relPath)).size, chunks: chunks.length, used: 0 },
    };
  }

  const lines = ['### מסמכי פרויקט (docs/ — Tier A, trusted internal)', 'ציטוטים קצרים לפי חפיפת מילות מפתח; אם אין כאן תשובה — אמור שאין במסמכים.'];
  for (const { c } of scored) {
    const excerpt = c.text.replace(/\s+/g, ' ').trim().slice(0, 520);
    lines.push(`- **${c.relPath}**: ${excerpt}${c.text.length > 520 ? '…' : ''}`);
  }

  return {
    block: lines.join('\n'),
    meta: {
      files: new Set(chunks.map((x) => x.relPath)).size,
      chunks: chunks.length,
      used: scored.length,
    },
  };
}

/** Test hook: reset in-memory index. */
export function resetDocsIndexForTests() {
  cache = null;
}
