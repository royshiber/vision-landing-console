/**
 * ElevenLabs voice list helpers: env presets + merge with API rows.
 * Voice IDs must match server-side validation (same rules as normalizeElevenLabsVoiceId).
 */

/** @param {unknown} raw */
function safeVoiceId(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(s)) return null;
  return s;
}

/**
 * Parse ELEVENLABS_VOICE_PRESETS JSON: [{ "id": "…", "label": "…" }]
 * @param {string|undefined|null} envValue
 * @returns {{ voice_id: string, name: string }[]}
 */
export function parseElevenLabsVoicePresets(envValue) {
  if (envValue == null || typeof envValue !== 'string') return [];
  const s = envValue.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const id = safeVoiceId(row.id);
      const label = String(row.label ?? '').trim();
      if (!id || !label) continue;
      out.push({ voice_id: id, name: label });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Curated presets first, then API voices; dedupe by voice_id (first wins).
 * @param {{ voice_id: string, name: string }[]} presets
 * @param {{ voice_id: string, name: string }[]} apiVoices
 */
export function mergeElevenLabsVoiceLists(presets, apiVoices) {
  const seen = new Set();
  const merged = [];
  for (const p of presets || []) {
    const id = p?.voice_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ voice_id: id, name: p.name || id });
  }
  for (const v of apiVoices || []) {
    const id = v?.voice_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ voice_id: id, name: v.name || id });
  }
  return merged;
}
