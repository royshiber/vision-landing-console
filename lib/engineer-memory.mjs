/**
 * Flight Engineer persistent memory.
 *
 * Why: make the voice engineer feel like a real engineer who knows the pilot,
 * vehicle, and prior incidents. What: small SQLite helpers for stable profile
 * facts, dated events, debriefs, and relevance-ranked prompt context.
 */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1);
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

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactValue(value) {
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

function deriveEventTags(text) {
  const q = String(text || '').toLowerCase();
  const tagMap = [
    ['gps|פיקס|לוויין|לווין', 'gps'],
    ['רעיד|vibration|מנוע|motor', 'vibration'],
    ['vio|vision|מצלמ|confidence|ביטחון', 'vision'],
    ['ekf|קלמן|estimate|estimator', 'ekf'],
    ['נחית|landing|flare|הצפה', 'landing'],
    ['מהירות|speed|airspeed', 'speed'],
    ['גובה|alt|altitude', 'altitude'],
    ['פרמטר|param|כוונון|tuning', 'params'],
    ['jetson|orin|cpu|טמפ|temperature', 'jetson'],
    ['advisor|יועץ', 'advisor'],
  ];
  const tags = new Set();
  for (const [pat, tag] of tagMap) if (new RegExp(pat, 'i').test(q)) tags.add(tag);
  return [...tags].join(',');
}

export function upsertProfileFact(db, key, value, { confidence = 0.8, source = 'engineer' } = {}) {
  const k = String(key || '').trim();
  const v = compactValue(value);
  if (!k || !v) throw new Error('profile key/value required');
  db.prepare(`
    INSERT INTO engineer_profile (key, value, confidence, source, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      confidence = MAX(engineer_profile.confidence, excluded.confidence),
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(k, v, Number(confidence) || 0.8, source || 'engineer');
  return { key: k, value: v };
}

export function listProfileFacts(db, { limit = 40 } = {}) {
  return db.prepare(`
    SELECT key, value, confidence, source, updated_at
    FROM engineer_profile
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

export function recordEngineerEvent(
  db,
  { sessionId = null, eventType = 'general', summary, tags = null, telemetry = null, params = null } = {},
) {
  const text = String(summary || '').trim();
  if (!text) throw new Error('event summary required');
  const finalTags = tags || deriveEventTags(`${eventType} ${text}`);
  const info = db.prepare(`
    INSERT INTO engineer_events
      (session_id, event_type, summary, tags, telemetry_json, params_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId || null,
    String(eventType || 'general'),
    text,
    finalTags || null,
    telemetry ? JSON.stringify(telemetry) : null,
    params ? JSON.stringify(params) : null,
  );
  return Number(info.lastInsertRowid);
}

export function listRecentEvents(db, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT id, session_id, event_type, summary, tags, telemetry_json, params_json, created_at
    FROM engineer_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

export function createSessionDebrief(db, sessionId, turns = [], notes = [], context = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) throw new Error('sessionId required');
  const userTurns = turns.filter((t) => t?.role === 'user').map((t) => t.content || '').filter(Boolean);
  const engineerTurns = turns.filter((t) => t?.role !== 'user').map((t) => t.content || '').filter(Boolean);
  const noteTexts = notes.map((n) => n.content || n.body || '').filter(Boolean);
  const keyFacts = [];

  const allText = [...userTurns, ...engineerTurns, ...noteTexts].join('\n');
  if (/נחית.*רכ|soft landing|רכה/i.test(allText)) keyFacts.push('הטייס הזכיר העדפה או צורך בנחיתות רכות.');
  if (/התרא|alert|אזהר/i.test(allText)) keyFacts.push('נדונו העדפות או אירועי התראות קוליות.');
  if (/gps|פיקס|לוויין|לווין/i.test(allText)) keyFacts.push('נדון אירוע או חשש סביב GPS.');
  if (/רעיד|vibration|מנוע/i.test(allText)) keyFacts.push('נדון אירוע רעידות או מנוע.');
  if (/vio|vision|מצלמ|confidence/i.test(allText)) keyFacts.push('נדון נושא VIO / ראייה ממוחשבת.');

  const summary = [
    `סשן ${sid}: ${userTurns.length} פניות טייס, ${noteTexts.length} פתקים.`,
    keyFacts.length ? keyFacts.join(' ') : 'לא זוהו תובנות חריגות; נשמרה היסטוריית שיחה בסיסית.',
    context?.telemetry?.armed === true ? 'הסשן התרחש בזמן ARM.' : null,
  ].filter(Boolean).join(' ');

  const lessons = keyFacts.map((text) => ({ text, confidence: 0.65 }));
  db.prepare(`
    INSERT INTO engineer_session_debriefs (session_id, summary, lessons_json, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      summary = excluded.summary,
      lessons_json = excluded.lessons_json,
      created_at = excluded.created_at
  `).run(sid, summary, JSON.stringify(lessons));

  if (keyFacts.length) {
    recordEngineerEvent(db, {
      sessionId: sid,
      eventType: 'session_debrief',
      summary,
      tags: deriveEventTags(summary),
      telemetry: context?.telemetry || null,
      params: context?.fcParams || null,
    });
  }

  return { sessionId: sid, summary, lessons };
}

export function findRelevantEngineerMemory(db, question, context = {}) {
  const q = String(question || '');
  const profile = listProfileFacts(db, { limit: 30 });
  const eventRows = db.prepare(`
    SELECT id, session_id, event_type, summary, tags, telemetry_json, params_json, created_at
    FROM engineer_events
    ORDER BY created_at DESC
    LIMIT 300
  `).all();

  const ctxText = [
    q,
    context?.telemetry?.flightMode,
    context?.jetson?.agentVersion,
    context?.vision?.confidence != null ? 'vision confidence' : '',
  ].filter(Boolean).join(' ');

  const events = eventRows
    .map((r) => {
      const hay = `${r.event_type || ''} ${r.summary || ''} ${r.tags || ''}`;
      let score = jaccard(ctxText, hay);
      if (/קרה|עבר|שוב|כבר|before|again|דומה/i.test(q)) score += 0.08;
      if (r.tags && q && tokenize(r.tags).some((t) => tokenize(q).includes(t))) score += 0.04;
      return { ...r, telemetry: safeJson(r.telemetry_json), params: safeJson(r.params_json), score };
    })
    .filter((r) => r.score > 0.04)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const debriefs = db.prepare(`
    SELECT session_id, summary, lessons_json, created_at
    FROM engineer_session_debriefs
    ORDER BY created_at DESC
    LIMIT 5
  `).all().map((r) => ({ ...r, lessons: safeJson(r.lessons_json, []) }));

  return { profile, events, debriefs };
}

export function formatEngineerMemoryForPrompt(memory) {
  if (!memory) return 'No engineer memory loaded.';
  const lines = [];
  if (memory.profile?.length) {
    lines.push('PROFILE FACTS:');
    for (const f of memory.profile.slice(0, 20)) {
      lines.push(`- ${f.key}=${f.value} (confidence ${Number(f.confidence ?? 0).toFixed(2)}, source ${f.source || 'unknown'})`);
    }
  } else {
    lines.push('PROFILE FACTS: none yet.');
  }

  if (memory.events?.length) {
    lines.push('RELEVANT PAST EVENTS:');
    for (const e of memory.events) {
      const tags = e.tags ? ` [${e.tags}]` : '';
      lines.push(`- #${e.id} ${e.created_at} ${e.event_type}${tags}: ${String(e.summary).slice(0, 420)}`);
    }
  } else {
    lines.push('RELEVANT PAST EVENTS: none found for this question.');
  }

  if (memory.debriefs?.length) {
    lines.push('RECENT SESSION DEBRIEFS:');
    for (const d of memory.debriefs.slice(0, 3)) {
      lines.push(`- ${d.created_at} session ${d.session_id}: ${String(d.summary).slice(0, 360)}`);
    }
  }
  return lines.join('\n');
}
