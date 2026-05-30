/**
 * Batch-generate Gemini SVG icons for ArduPlane parameters.
 * Usage: npm run build-param-icons [-- --limit N] [-- --force] [-- --common]
 */
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import {
  ARDU_PARAMS_PATH,
  PARAM_ICONS_PATH,
  COMMON_PARAM_KEYS,
  loadParamIconCache,
  saveParamIconCache,
  generateAndCacheParamIcon,
} from '../lib/param-icon-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DELAY_MS = 500;
const SAVE_EVERY = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = null;
  let force = false;
  let commonOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) { limit = Number(args[++i]); continue; }
    if (args[i] === '--force') { force = true; continue; }
    if (args[i] === '--common') { commonOnly = true; continue; }
  }
  return { limit, force, commonOnly };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[build-param-icons] GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  const { limit, force, commonOnly } = parseArgs();
  const rawDb = JSON.parse(await fs.readFile(ARDU_PARAMS_PATH, 'utf8'));
  const allParams = rawDb.params || {};

  let keys;
  if (commonOnly) {
    keys = COMMON_PARAM_KEYS.filter((k) => allParams[k]);
  } else {
    keys = Object.keys(allParams).sort();
  }
  if (limit > 0) keys = keys.slice(0, limit);

  const cache = await loadParamIconCache();
  if (!cache.icons) cache.icons = {};

  const todo = force ? keys : keys.filter((k) => !cache.icons[k]?.svg);
  console.log(`[build-param-icons] ${todo.length} params to generate (${keys.length} in scope)`);

  if (!todo.length) {
    console.log('[build-param-icons] Nothing to do.');
    return;
  }

  let done = 0;
  let failed = 0;

  for (const key of todo) {
    const info = allParams[key] || {};
    const label = info.display_name || key;
    const desc = (info.description || '').slice(0, 300);
    try {
      await generateAndCacheParamIcon(apiKey, key, label, desc);
      done++;
      process.stdout.write(`\r  OK ${done}/${todo.length} — ${key}          `);
    } catch (err) {
      failed++;
      console.error(`\n  FAIL ${key}: ${err?.message || err}`);
    }
    if ((done + failed) % SAVE_EVERY === 0) {
      const c = await loadParamIconCache();
      await saveParamIconCache(c);
    }
    if (todo.indexOf(key) < todo.length - 1) await sleep(DELAY_MS);
  }

  const final = await loadParamIconCache();
  await saveParamIconCache(final);
  console.log(`\n[build-param-icons] Done — ${done} ok, ${failed} failed → ${PARAM_ICONS_PATH}`);
}

main().catch((err) => {
  console.error('[build-param-icons] FATAL:', err.message);
  process.exit(1);
});
