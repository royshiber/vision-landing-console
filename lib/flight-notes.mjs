/**
 * Flight Engineer — session notes store.
 * Notes are keyed by session_id (a UUID the client generates per flight session).
 */

/** Save a note. Returns the new note id. */
export function saveNote(db, sessionId, content, category = 'general') {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO engineer_notes (session_id, content, category)
    VALUES (?, ?, ?)
  `).run(sessionId, content.trim(), category);
  return lastInsertRowid;
}

/** Return all notes for a session, oldest first. */
export function getNotes(db, sessionId) {
  return db.prepare(`
    SELECT id, ts, content, category
    FROM engineer_notes
    WHERE session_id = ?
    ORDER BY ts ASC
  `).all(sessionId);
}

/** Delete one note by id. */
export function deleteNote(db, noteId) {
  db.prepare(`DELETE FROM engineer_notes WHERE id = ?`).run(noteId);
}

/** Clear all notes for a session. */
export function clearNotes(db, sessionId) {
  db.prepare(`DELETE FROM engineer_notes WHERE session_id = ?`).run(sessionId);
}
