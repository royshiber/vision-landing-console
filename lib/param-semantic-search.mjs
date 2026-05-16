/**
 * Semantic (embedding-based) search over ArduPlane parameters.
 *
 * How it works:
 *  1. At startup: loads pre-computed Gemini embeddings from
 *     data/arduplane-param-embeddings.json (built by: npm run build-param-embeddings).
 *  2. At query time: embeds the user's question with the same Gemini model,
 *     then ranks all params by cosine similarity → top-N results.
 *
 * This approach understands any language and any phrasing without manual maps,
 * because it uses the same semantic space that Gemini understands.
 *
 * Falls back gracefully when:
 *  - Embeddings file doesn't exist → returns null (caller can fall back to keyword search)
 *  - GEMINI_API_KEY not set → returns null
 *  - Gemini API error → returns null (never throws)
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMB_PATH = path.join(__dirname, '..', 'data', 'arduplane-param-embeddings.json');
// gemini-embedding-001 is available in v1beta (the SDK default).
const EMBEDDING_MODEL = 'gemini-embedding-001';

// ── In-memory index ──────────────────────────────────────────────────────────

let _loaded = false;
let _keys = null;       // string[]
let _matrix = null;     // Float32Array — flattened [key0_dim0, key0_dim1, ..., keyN_dimD]
let _dims = 0;
let _meta = null;

function loadIndex() {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(EMB_PATH)) {
    process.stderr.write(
      '[param-semantic-search] Embeddings not found. Run: npm run build-param-embeddings\n',
    );
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(EMB_PATH, 'utf8'));
    _meta = raw._meta || {};
    const metaDims = Number(_meta.dims || 0) || 0;
    const emb = raw.embeddings || {};
    const decodedRaw = [];
    const dimCounts = new Map();
    let skipped = 0;
    for (const key of Object.keys(emb)) {
      const buf = Buffer.from(emb[key], 'base64');
      if (buf.byteLength % 4 !== 0) {
        skipped += 1;
        continue;
      }
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      decodedRaw.push([key, vec]);
      dimCounts.set(vec.length, (dimCounts.get(vec.length) || 0) + 1);
    }
    const dominantDims = [...dimCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || metaDims || 256;
    _dims = dimCounts.get(metaDims) ? metaDims : dominantDims;
    const decoded = decodedRaw.filter(([, vec]) => {
      if (vec.length === _dims) return true;
      skipped += 1;
      return false;
    });
    const keys = decoded.map(([key]) => key);
    // Build a flat Float32Array matrix for fast dot-product computation
    const matrix = new Float32Array(keys.length * _dims);
    for (let i = 0; i < decoded.length; i++) {
      const [, vec] = decoded[i];
      matrix.set(vec, i * _dims);
    }
    _keys = keys;
    _matrix = matrix;
    process.stderr.write(
      `[param-semantic-search] Loaded ${keys.length} embeddings (${_dims}d) from ${EMB_PATH}${skipped ? `; skipped ${skipped} invalid vectors` : ''}\n`,
    );
  } catch (err) {
    _keys = null;
    _matrix = null;
    process.stderr.write(`[param-semantic-search] Failed to load embeddings: ${err.message}\n`);
  }
}

/** Whether the embedding index is available and ready. */
export function isSemanticSearchAvailable() {
  loadIndex();
  return !!(_keys && _keys.length && _matrix);
}

/** Metadata about the current embedding index. */
export function getSemanticSearchMeta() {
  loadIndex();
  return _meta;
}

// ── Core math ─────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between a query vector and all param vectors.
 * Returns indices sorted by descending similarity.
 */
function rankBySimilarity(queryVec) {
  const n = _keys.length;
  const scores = new Float32Array(n);
  // Compute dot products in one tight loop — JS engines optimize this well
  const qNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < n; i++) {
    const off = i * _dims;
    let dot = 0;
    let rowNorm = 0;
    for (let d = 0; d < _dims; d++) {
      const v = _matrix[off + d];
      dot += queryVec[d] * v;
      rowNorm += v * v;
    }
    scores[i] = dot / (qNorm * (Math.sqrt(rowNorm) || 1));
  }
  // Argsort descending
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => scores[b] - scores[a]);
  return { indices, scores };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed the user's query and find the most semantically similar params.
 *
 * @param {string} query - User's question in any language
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ param_key: string, similarity: number }> | null>}
 *   null if semantic search is unavailable (no embeddings / no API key).
 */
export async function semanticSearch(query, { limit = 20 } = {}) {
  loadIndex();
  if (!_keys || !_matrix) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent({
      content: { role: 'user', parts: [{ text: String(query || '') }] },
      taskType: 'RETRIEVAL_QUERY',
    });
    const queryVec = result.embedding.values;
    if (!queryVec || queryVec.length !== _dims) return null;

    const { indices, scores } = rankBySimilarity(queryVec);
    return indices.slice(0, limit).map((idx) => ({
      param_key: _keys[idx],
      similarity: scores[idx],
    }));
  } catch {
    return null;
  }
}
