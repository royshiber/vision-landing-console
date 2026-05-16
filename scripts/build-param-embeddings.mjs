/**
 * One-time script: generate Gemini text embeddings for all ArduPlane parameters.
 *
 * Usage:
 *   npm run build-param-embeddings
 *
 * Requires: GEMINI_API_KEY in .env
 * Output:   data/arduplane-param-embeddings.json
 *
 * Each embedding is stored as a base64-encoded Float32Array.
 * Re-running resumes from where it left off — already-computed keys are skipped.
 */
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'arduplane-params.json');
const OUT_PATH = path.join(__dirname, '..', 'data', 'arduplane-param-embeddings.json');

// gemini-embedding-001 is available in v1beta and supports embedContent (single call).
// asyncBatchEmbedContent is also supported but requires a different SDK path.
// We use individual embedContent calls with concurrency for maximum compatibility.
const EMBEDDING_MODEL = 'gemini-embedding-001';
const CONCURRENCY = 8;     // parallel requests per round
const ROUND_DELAY_MS = 300; // delay between rounds to avoid 429
const SAVE_EVERY = 50;      // save partial results every N completions

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function encodeEmbedding(values) {
  const f32 = new Float32Array(values);
  return Buffer.from(f32.buffer).toString('base64');
}

async function embedOne(model, text, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await model.embedContent({
        content: { role: 'user', parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
      });
      return result.embedding.values;
    } catch (err) {
      const isRate = /429|quota|rate.?limit/i.test(String(err?.message || ''));
      if (isRate && attempt < retries - 1) {
        await sleep(5000 * (attempt + 1));
      } else if (attempt >= retries - 1) {
        throw err;
      } else {
        await sleep(500);
      }
    }
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[build-param-embeddings] ERROR: GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  const rawDb = JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  const params = Object.entries(rawDb.params || {});
  console.log(`[build-param-embeddings] ${params.length} params to embed using ${EMBEDDING_MODEL}`);

  // Load any previously completed embeddings for resumption.
  let existing = {};
  let existingDims = null;
  if (existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'));
      existing = prev.embeddings || {};
      existingDims = prev._meta?.dims;
      const done = Object.keys(existing).length;
      if (done > 0) console.log(`[build-param-embeddings] Resuming — ${done} already done`);
    } catch { /* start fresh */ }
  }

  const todo = params.filter(([k]) => !existing[k]);
  if (!todo.length) {
    console.log('[build-param-embeddings] All params already embedded!');
    return;
  }
  console.log(`[build-param-embeddings] ${todo.length} params remaining...`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

  let done = 0;
  let firstDims = existingDims;

  const saveProgress = async () => {
    const count = Object.keys(existing).length;
    await fs.writeFile(OUT_PATH, JSON.stringify({
      _meta: {
        built_at: new Date().toISOString(),
        model: EMBEDDING_MODEL,
        dims: firstDims,
        count,
        total_params: params.length,
      },
      embeddings: existing,
    }), 'utf8');
  };

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const round = todo.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      round.map(async ([key, info]) => {
        const desc = (info.description || '').slice(0, 300);
        const name = info.display_name || key;
        const text = `${key}: ${name}. ${desc}`;
        const values = await embedOne(model, text);
        return { key, values };
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.values) {
        const { key, values } = r.value;
        if (!firstDims) firstDims = values.length;
        existing[key] = encodeEmbedding(values);
        done++;
      }
    }

    const total = Object.keys(existing).length;
    const pct = ((total / params.length) * 100).toFixed(1);
    process.stdout.write(`\r  ${total}/${params.length} (${pct}%)   `);

    if (done % SAVE_EVERY === 0 || i + CONCURRENCY >= todo.length) {
      await saveProgress();
    }

    if (i + CONCURRENCY < todo.length) await sleep(ROUND_DELAY_MS);
  }

  await saveProgress();
  const finalCount = Object.keys(existing).length;
  console.log(`\n[build-param-embeddings] Done — ${finalCount}/${params.length} params embedded → ${OUT_PATH}`);
  if (firstDims) console.log(`[build-param-embeddings] Vector dimensions: ${firstDims}`);
}

main().catch((err) => {
  console.error('[build-param-embeddings] FATAL:', err.message);
  process.exit(1);
});
