/**
 * Why: the advisor needs persistent memory of issues the pilot encountered, with the versions
 *      (console / Jetson agent / FC firmware) that were active at the time, so it can correlate
 *      a new question with a similar past case and ask about versions when relevant.
 * What: small CRUD + similarity helpers over chat_issues + chat_messages. Similarity uses simple
 *       token-overlap scoring (same approach used elsewhere in retrieval.mjs — no external deps).
 */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
}

/** Why: very-short auto title from the first user question. What: trims to ~60 chars, strips newlines. */
function deriveTitle(question) {
  const t = String(question || '').replace(/\s+/g, ' ').trim();
  if (!t) return '(ללא כותרת)';
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

/** Why: quick heuristic tags so issues can be filtered / matched by theme. What: returns csv of keywords present in the text. */
function deriveTags(text) {
  const q = String(text || '').toLowerCase();
  const tagMap = [
    ['נדנוד|oscillat', 'oscillation'],
    ['flare|הצפה', 'flare'],
    ['confidence|ביטחון', 'confidence'],
    ['speed|מהירות|approach', 'speed'],
    ['gps', 'gps'],
    ['mavlink|heartbeat|חיבור', 'mavlink'],
    ['jetson|agent', 'jetson'],
    ['gemini|api.?key|מפתח', 'gemini'],
    ['abort|בטיחות', 'abort'],
    ['hebrew|utf|קידוד|עברית|encoding', 'encoding'],
    ['param|פרמטר', 'params'],
    ['yaw', 'yaw'],
    ['slam|vio|pose', 'slam'],
  ];
  const out = new Set();
  for (const [pat, tag] of tagMap) if (new RegExp(pat, 'i').test(q)) out.add(tag);
  return Array.from(out).join(',');
}

function jaccard(aText, bText) {
  const a = new Set(tokenize(aText));
  const b = new Set(tokenize(bText));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Why: tie a new question to the freshest relevant open issue to keep the thread coherent. What: returns id of best match or null. */
function findOpenIssueToContinue(db, question, { since = 30 * 60 * 1000 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, title, summary, last_question, updated_at FROM chat_issues
       WHERE status = 'open'
       AND (strftime('%s','now') - strftime('%s', updated_at)) * 1000 <= ?
       ORDER BY updated_at DESC LIMIT 10`,
    )
    .all(since);
  let best = null;
  for (const r of rows) {
    const sc = Math.max(
      jaccard(question, r.last_question || ''),
      jaccard(question, r.summary || ''),
      jaccard(question, r.title || ''),
    );
    if (!best || sc > best.sc) best = { id: r.id, sc };
  }
  return best && best.sc >= 0.2 ? best.id : null;
}

/** Why: persist one user-advisor exchange, grouping into an existing or new issue.
 *  What: inserts two chat_messages rows (user + advisor), updates or creates a chat_issue.
 *  versions: { app, agent, internalFw, fc } all optional strings. */
export function recordExchange(
  db,
  { question, reply, source, versions = {}, paramsSnapshot = null, issueId: preferredIssueId = null },
) {
  const now = new Date().toISOString();
  const app = versions.app || null;
  const agent = versions.agent || null;
  const internalFw = versions.internalFw || null;
  const fc = versions.fc || null;

  let issueId = Number.isInteger(Number(preferredIssueId)) && Number(preferredIssueId) > 0
    ? Number(preferredIssueId)
    : findOpenIssueToContinue(db, question);
  if (issueId) {
    const exists = db.prepare(`SELECT id FROM chat_issues WHERE id = ?`).get(issueId);
    if (!exists) issueId = null;
  }
  if (issueId) {
    db.prepare(
      `UPDATE chat_issues SET
         updated_at = ?,
         last_question = ?,
         last_reply = ?,
         hit_count = hit_count + 1,
         app_version = COALESCE(?, app_version),
         agent_version = COALESCE(?, agent_version),
         internal_fw_version = COALESCE(?, internal_fw_version),
         fc_firmware_version = COALESCE(?, fc_firmware_version),
         params_snapshot = COALESCE(?, params_snapshot)
       WHERE id = ?`,
    ).run(now, question, reply, app, agent, internalFw, fc, paramsSnapshot, issueId);
  } else {
    const info = db
      .prepare(
        `INSERT INTO chat_issues
           (title, summary, tags, app_version, agent_version, internal_fw_version, fc_firmware_version,
            params_snapshot, last_question, last_reply)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        deriveTitle(question),
        question.slice(0, 2000),
        deriveTags(`${question}\n${reply}`),
        app,
        agent,
        internalFw,
        fc,
        paramsSnapshot,
        question,
        reply,
      );
    issueId = info.lastInsertRowid;
  }

  const ins = db.prepare(
    `INSERT INTO chat_messages
       (issue_id, role, message, source, app_version, agent_version, internal_fw_version, fc_firmware_version)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const userInfo = ins.run(issueId, 'user', question, null, app, agent, internalFw, fc);
  const advisorInfo = ins.run(issueId, 'advisor', reply, source || null, app, agent, internalFw, fc);
  return { issueId, userMessageId: Number(userInfo.lastInsertRowid), advisorMessageId: Number(advisorInfo.lastInsertRowid) };
}

/** Why: surface the N most relevant past issues for the advisor's system preamble.
 *  What: token-overlap against (title + summary + last_question). Prefers issues whose versions
 *        match current versions; open issues weighted slightly above resolved ones. */
export function findSimilarIssues(db, question, { versions = {}, limit = 5 } = {}) {
  const rows = db
    .prepare(
      `SELECT id, title, summary, resolution, status, tags, hit_count,
              app_version, agent_version, internal_fw_version, fc_firmware_version,
              last_question, last_reply, created_at, updated_at
       FROM chat_issues ORDER BY updated_at DESC LIMIT 400`,
    )
    .all();
  const scored = rows
    .map((r) => {
      const text = `${r.title || ''}\n${r.summary || ''}\n${r.last_question || ''}\n${r.tags || ''}`;
      let sc = jaccard(question, text);
      if (versions.app && r.app_version === versions.app) sc += 0.05;
      if (versions.agent && r.agent_version === versions.agent) sc += 0.05;
      if (versions.fc && r.fc_firmware_version === versions.fc) sc += 0.05;
      if (r.status === 'open') sc += 0.02;
      if (r.resolution && r.status === 'resolved') sc += 0.03;
      return { r, sc };
    })
    .filter((x) => x.sc > 0.08)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .map((x) => x.r);
  return scored;
}

/** Why: build a compact markdown block of past issues for the system preamble. */
export function formatIssuesForPrompt(issues) {
  if (!issues || issues.length === 0) {
    return '(אין בעיות קודמות דומות בזיכרון — הניסיון הזה יישמר להמשך.)';
  }
  const lines = ['### בעיות דומות מהעבר (זיכרון מתמשך של היועץ)'];
  for (const it of issues) {
    const vers = [];
    if (it.app_version) vers.push(`Console ${it.app_version}`);
    if (it.agent_version) vers.push(`Agent ${it.agent_version}`);
    if (it.fc_firmware_version) vers.push(`FC ${it.fc_firmware_version}`);
    if (it.internal_fw_version) vers.push(`FW ${it.internal_fw_version}`);
    const v = vers.length ? ` | גרסאות בעת האירוע: ${vers.join(', ')}` : '';
    const status = it.status === 'resolved' ? '✓ נפתר' : it.status === 'wont_fix' ? '✗ לא רלוונטי' : '◯ פתוח';
    const resolution = it.resolution ? `\n  פתרון: ${String(it.resolution).slice(0, 400)}` : '';
    const tags = it.tags ? ` [${it.tags}]` : '';
    lines.push(
      `- #${it.id} ${status} "${it.title || '(ללא כותרת)'}" (${it.updated_at}, ${it.hit_count} פניות)${tags}${v}\n  תקציר: ${String(it.summary || '').slice(0, 280)}${resolution}`,
    );
  }
  return lines.join('\n');
}

/** Why: let the pilot mark an issue resolved and save the resolution so future chats surface it. */
export function markIssueResolved(db, id, { resolution, status = 'resolved' } = {}) {
  if (!Number.isInteger(Number(id))) throw new Error('bad id');
  const nid = Number(id);
  if (status === 'open') {
    const res = db
      .prepare(
        `UPDATE chat_issues SET status = 'open', resolution = NULL, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(nid);
    return res.changes > 0;
  }
  const res = db
    .prepare(
      `UPDATE chat_issues SET resolution = COALESCE(?, resolution), status = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(resolution || null, status, nid);
  return res.changes > 0;
}

/** Why: resolve state per user question inside a thread. */
export function markMessageResolved(db, id, { resolved = true } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('bad id');
  const res = db
    .prepare(`UPDATE chat_messages SET is_resolved = ? WHERE id = ? AND role = 'user'`)
    .run(resolved ? 1 : 0, n);
  return res.changes > 0;
}

/** Why: pilot requested "מחק" instead of wont_fix — remove the issue and its transcript.
 *  Note: `param_audit` has ON DELETE SET NULL from `chat_issues`, which would UPDATE param_audit — but
 *  `trg_param_audit_no_update` aborts any UPDATE. So we turn off foreign_keys only for the parent DELETE;
 *  param_audit rows may keep a stale `issue_id` (forensic rows stay valid; no FK check on old data).
 *  **Critical:** In SQLite, `PRAGMA foreign_keys` is unreliable *inside* a transaction — keep pragma outside. */
export function deleteIssue(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('bad id');
  const fkOn = db.pragma('foreign_keys', { simple: true });
  try {
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM chat_messages WHERE issue_id = ?`).run(n);
      db.prepare(`UPDATE chat_actions SET issue_id = NULL WHERE issue_id = ?`).run(n);
      return db.prepare(`DELETE FROM chat_issues WHERE id = ?`).run(n).changes > 0;
    });
    return tx();
  } finally {
    db.pragma(`foreign_keys = ${fkOn ? 'ON' : 'OFF'}`);
  }
}

/** Why: UI listing. */
export function listIssues(db, { status = null, limit = 50 } = {}) {
  if (status) {
    return db
      .prepare(
        `SELECT id, title, summary, resolution, status, tags, hit_count,
                app_version, agent_version, internal_fw_version, fc_firmware_version,
                created_at, updated_at
         FROM chat_issues WHERE status = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(status, limit);
  }
  return db
    .prepare(
      `SELECT id, title, summary, resolution, status, tags, hit_count,
              app_version, agent_version, internal_fw_version, fc_firmware_version,
              created_at, updated_at
       FROM chat_issues ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

/** Why: expose full conversation of an issue for review / detailed context. */
export function getIssueMessages(db, id) {
  return db
    .prepare(
      `SELECT id, role, message, source, app_version, agent_version, fc_firmware_version, created_at, is_resolved
       FROM chat_messages WHERE issue_id = ? ORDER BY id ASC`,
    )
    .all(Number(id));
}
