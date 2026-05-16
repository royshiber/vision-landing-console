/**
 * Why: isolate all DB access for custom_features / custom_params so route handlers,
 * search injection, and tests can import just the functions they need without touching
 * any other part of the database layer.
 */

// ── Feature CRUD ─────────────────────────────────────────────────────────────

/**
 * List all features (summary only — no cpp_code, to keep the payload small).
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id, name, description, status, created_at, updated_at, param_count}>}
 */
export function listFeatures(db) {
  return db.prepare(`
    SELECT cf.id, cf.name, cf.description, cf.status, cf.created_at, cf.updated_at,
           COUNT(cp.id) AS param_count
    FROM custom_features cf
    LEFT JOIN custom_params cp ON cp.feature_id = cf.id
    GROUP BY cf.id
    ORDER BY cf.updated_at DESC
  `).all();
}

/**
 * Get one feature with full cpp_code and all its params.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {object|null}
 */
export function getFeature(db, id) {
  const feature = db.prepare('SELECT * FROM custom_features WHERE id = ?').get(id);
  if (!feature) return null;
  try {
    feature.conversation = JSON.parse(feature.conversation_json || '[]');
  } catch {
    feature.conversation = [];
  }
  feature.params = db.prepare(
    'SELECT * FROM custom_params WHERE feature_id = ? ORDER BY id',
  ).all(id);
  return feature;
}

/**
 * Insert a new feature (status='draft') together with its initial params.
 * @param {import('better-sqlite3').Database} db
 * @param {{ name: string, description: string, cpp_code: string, params: Array, conversation?: Array }} data
 * @returns {number} new feature id
 */
export function createFeature(db, { name, description, cpp_code, params, conversation = [] }) {
  const result = db.prepare(`
    INSERT INTO custom_features (name, description, cpp_code, conversation_json, status)
    VALUES (?, ?, ?, ?, 'draft')
  `).run(
    String(name || 'Unnamed Feature'),
    String(description || ''),
    String(cpp_code || ''),
    JSON.stringify(conversation),
  );
  const featureId = result.lastInsertRowid;
  if (Array.isArray(params) && params.length > 0) {
    _upsertParams(db, featureId, params);
  }
  return featureId;
}

/**
 * Partially update a feature's fields and/or replace its params.
 * Only fields present in `data` are updated; undefined fields are left unchanged.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {{ name?: string, description?: string, cpp_code?: string, params?: Array, conversation?: Array }} data
 */
export function updateFeature(db, id, data) {
  const setClauses = [];
  const values = [];

  if (data.name !== undefined)        { setClauses.push('name = ?');              values.push(String(data.name)); }
  if (data.description !== undefined) { setClauses.push('description = ?');       values.push(String(data.description)); }
  if (data.cpp_code !== undefined)    { setClauses.push('cpp_code = ?');          values.push(String(data.cpp_code)); }
  if (data.conversation !== undefined){ setClauses.push('conversation_json = ?'); values.push(JSON.stringify(data.conversation)); }

  if (setClauses.length > 0) {
    setClauses.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE custom_features SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }

  if (Array.isArray(data.params)) {
    // Drop and re-insert so key renames are handled correctly.
    db.prepare('DELETE FROM custom_params WHERE feature_id = ?').run(id);
    _upsertParams(db, id, data.params);
  }
}

/**
 * Set status: 'draft' | 'active' | 'archived'
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {string} status
 */
export function setFeatureStatus(db, id, status) {
  db.prepare(
    `UPDATE custom_features SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, id);
}

/**
 * Delete a feature (cascades to custom_params via FK).
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 */
export function deleteFeature(db, id) {
  db.prepare('DELETE FROM custom_features WHERE id = ?').run(id);
}

// ── Param value editing ───────────────────────────────────────────────────────

/**
 * Update the current_value of a single custom param by key (case-insensitive).
 * @param {import('better-sqlite3').Database} db
 * @param {string} paramKey
 * @param {number} value
 * @returns {boolean} true if the param was found and updated
 */
export function setCustomParamValue(db, paramKey, value) {
  const result = db.prepare(
    `UPDATE custom_params SET current_value = ? WHERE param_key = ?`,
  ).run(value, String(paramKey).toUpperCase());
  return result.changes > 0;
}

// ── Search / KB injection ─────────────────────────────────────────────────────

/**
 * Returns all params from ACTIVE features in a shape compatible with param-kb entries.
 * These are injected into smart-search and the ArduParams form.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array}
 */
export function getActiveCustomParams(db) {
  return db.prepare(`
    SELECT cp.*, cf.name AS feature_name
    FROM custom_params cp
    JOIN custom_features cf ON cf.id = cp.feature_id
    WHERE cf.status = 'active'
    ORDER BY cp.param_key
  `).all();
}

/**
 * Format active custom params as KB-compatible entries for search injection.
 * Each entry mirrors the shape returned by buildArduPlaneSearchKb().
 * @param {import('better-sqlite3').Database} db
 * @returns {Array}
 */
export function formatCustomParamsForKb(db) {
  const rows = getActiveCustomParams(db);
  return rows.map((p) => ({
    param_key: p.param_key,
    display_name: p.display_name || p.param_key,
    description_en: p.description || '',
    description_he: p.description_he || p.description || '',
    units: p.units || null,
    range: (p.min_val != null && p.max_val != null)
      ? { low: p.min_val, high: p.max_val }
      : null,
    enum_values: null,
    editable_here: true,
    available_on_fc: false,
    source: 'custom',
    feature_name: p.feature_name,
    current_value: p.current_value,
    default_value: p.default_value,
    param_type: p.param_type,
  }));
}

/**
 * Simple text search over active custom params.
 * Used by core-api.mjs smart-search to append custom matches.
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @returns {Array}
 */
export function searchCustomParams(db, query) {
  const all = formatCustomParamsForKb(db);
  if (!all.length) return [];
  const q = String(query).toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return [];

  const scored = all.map((entry) => {
    const blob = [
      entry.param_key,
      entry.display_name,
      entry.description_en,
      entry.feature_name,
    ].join(' ').toLowerCase();

    let score = 0;
    for (const t of tokens) {
      if (entry.param_key.toLowerCase() === t) score += 14;
      else if (entry.param_key.toLowerCase().includes(t)) score += 7;
      if (blob.includes(t)) score += 3;
    }
    return { ...entry, _score: score };
  }).filter((e) => e._score > 0);

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _upsertParams(db, featureId, params) {
  const stmt = db.prepare(`
    INSERT INTO custom_params
      (feature_id, param_key, display_name, description, description_he, param_type,
       default_value, current_value, units, min_val, max_val)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(param_key) DO UPDATE SET
      display_name   = excluded.display_name,
      description    = excluded.description,
      description_he = excluded.description_he,
      param_type     = excluded.param_type,
      default_value  = excluded.default_value,
      units          = excluded.units,
      min_val        = excluded.min_val,
      max_val        = excluded.max_val
  `);

  for (const p of params) {
    const key = String(p.key || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16);
    if (!key) continue;
    const defVal = Number(p.default_value ?? 0);
    stmt.run(
      featureId,
      key,
      String(p.display_name || p.key || key),
      String(p.description || ''),
      String(p.description_he || ''),
      String(p.type || 'FLOAT'),
      defVal,
      defVal, // current_value starts at default
      p.units != null ? String(p.units) : null,
      p.min_val != null ? Number(p.min_val) : null,
      p.max_val != null ? Number(p.max_val) : null,
    );
  }
}
