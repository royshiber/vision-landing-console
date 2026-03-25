/** Why: ground Gemini answers in stored logs and pilot notes. What: picks short excerpts from SQLite using simple token overlap (no embeddings in v1). */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
}

/** What: returns markdown-ish bullets for system prompt from DB rows. */
export function buildRetrievalContext(db, question, { limitNotes = 6, limitLogs = 6, flightId = null } = {}) {
  const terms = new Set(tokenize(question));
  if (terms.size === 0) return { block: '(אין מילות מפתח לחיפוש במאגר.)', meta: { notes: 0, logs: 0 } };

  const fid = Number.isInteger(Number(flightId)) && Number(flightId) > 0 ? Number(flightId) : null;
  const notes = fid
    ? db.prepare(`SELECT id, flight_id, body, created_at FROM flight_notes WHERE flight_id = ? ORDER BY id DESC LIMIT 200`).all(fid)
    : db.prepare(`SELECT id, flight_id, body, created_at FROM flight_notes ORDER BY id DESC LIMIT 200`).all();

  const logs = fid
    ? db.prepare(`SELECT id, flight_id, source, original_name, text_excerpt, created_at FROM log_artifacts WHERE flight_id = ? ORDER BY id DESC LIMIT 200`).all(fid)
    : db.prepare(`SELECT id, flight_id, source, original_name, text_excerpt, created_at FROM log_artifacts ORDER BY id DESC LIMIT 200`).all();

  const scoreNote = (row) => {
    const ws = tokenize(row.body);
    let s = 0;
    for (const w of ws) if (terms.has(w)) s += 1;
    return s / Math.max(1, ws.length);
  };
  const scoreLog = (row) => {
    const blob = `${row.original_name} ${row.text_excerpt || ''}`;
    const ws = tokenize(blob);
    let s = 0;
    for (const w of ws) if (terms.has(w)) s += 1;
    return s / Math.max(1, ws.length);
  };

  const topNotes = notes
    .map((r) => ({ r, sc: scoreNote(r) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limitNotes)
    .map((x) => x.r);

  const topLogs = logs
    .map((r) => ({ r, sc: scoreLog(r) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limitLogs)
    .map((x) => x.r);

  const parts = [];
  if (topNotes.length) {
    parts.push('### הערות טייס (נבחרו לפי המשאלה)');
    for (const n of topNotes) {
      const excerpt = String(n.body).slice(0, 500);
      parts.push(`- טיסה #${n.flight_id} (${n.created_at}): ${excerpt}`);
    }
  }
  if (topLogs.length) {
    parts.push('### קטעים מלוגים (נבחרו לפי המשאלה)');
    for (const l of topLogs) {
      const ex = String(l.text_excerpt || '').slice(0, 400);
      parts.push(`- [${l.source}] טיסה #${l.flight_id} ${l.original_name}: ${ex}`);
    }
  }

  const block = parts.length ? parts.join('\n') : '(לא נמצאו התאמות במאגר לשאלה הנוכחית — ענה לפי הפרמטרים והידע הכללי.)';
  return { block, meta: { notes: topNotes.length, logs: topLogs.length } };
}

export function getLatestCodeDigest(db) {
  return db.prepare(`SELECT commit_sha, branch, files_changed_text, received_at, payload_json FROM code_digest ORDER BY id DESC LIMIT 1`).get();
}
