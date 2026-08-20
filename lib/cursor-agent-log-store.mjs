import fs from 'fs';
import path from 'path';

export const AGENT_LOG_MAX_BYTES = 256 * 1024;
export const AGENT_LOG_MAX_FILES = 64;

function nowIso() {
  return new Date().toISOString();
}

export function createCursorAgentLogStore(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const logDir = path.resolve(opts.logDir || path.join(repoRoot, 'var', 'development', 'agent-logs'));
  const maxBytes = Number(opts.maxBytes || AGENT_LOG_MAX_BYTES);
  const maxFiles = Number(opts.maxFiles || AGENT_LOG_MAX_FILES);

  function ensureDir() {
    fs.mkdirSync(logDir, { recursive: true });
  }

  function logRefFor(sessionId) {
    const safe = String(sessionId || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
    return path.join('var', 'development', 'agent-logs', `${safe}.log`).replaceAll('\\', '/');
  }

  function absPathFor(sessionId) {
    return path.join(logDir, `${String(sessionId || 'session').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)}.log`);
  }

  function pruneOldLogs() {
    ensureDir();
    const entries = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const full = path.join(logDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(maxFiles)) {
      try { fs.unlinkSync(entry.full); } catch { /* ignore */ }
    }
  }

  function append(sessionId, chunk) {
    if (!chunk) return { log_ref: logRefFor(sessionId), bytes: 0 };
    ensureDir();
    const file = absPathFor(sessionId);
    const text = String(chunk);
    let existing = '';
    if (fs.existsSync(file)) {
      existing = fs.readFileSync(file, 'utf8');
    }
    let combined = existing + text;
    if (Buffer.byteLength(combined, 'utf8') > maxBytes) {
      combined = combined.slice(-maxBytes);
    }
    fs.writeFileSync(file, combined, 'utf8');
    pruneOldLogs();
    return {
      log_ref: logRefFor(sessionId),
      bytes: Buffer.byteLength(combined, 'utf8'),
    };
  }

  function readExcerpt(sessionId, maxChars = 240) {
    const file = absPathFor(sessionId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars);
  }

  return {
    logDir,
    logRefFor,
    append,
    readExcerpt,
    pruneOldLogs,
    createdAt: nowIso(),
  };
}
