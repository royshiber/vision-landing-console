import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runParamSmartSearch } from '../lib/param-smart-search.mjs';
import { runParamSmartSearchV2 } from '../lib/param-smart-search-v2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalPath = path.join(__dirname, '..', 'data', 'smart-search-eval-queries.json');

function topKeys(out, n = 3) {
  const direct = Array.isArray(out?.results) ? out.results.map((r) => r.param_key) : [];
  const compat = Array.isArray(out?.keys) ? out.keys : [];
  const arr = direct.length ? direct : compat;
  return arr.slice(0, n);
}

function hit(expected, got) {
  return expected.some((k) => got.includes(k));
}

async function main() {
  const raw = await fs.readFile(evalPath, 'utf8');
  const cases = JSON.parse(raw);
  let v1Hit = 0;
  let v2Hit = 0;
  for (const c of cases) {
    const oldOut = await runParamSmartSearch(c.q);
    const newOut = await runParamSmartSearchV2(c.q, { maxResults: 5 });
    const k1 = topKeys(oldOut, 3);
    const k2 = topKeys(newOut, 3);
    if (hit(c.expected_top3_any, k1)) v1Hit += 1;
    if (hit(c.expected_top3_any, k2)) v2Hit += 1;
    console.log(`Q: ${c.q}`);
    console.log(`  V1 top3: ${k1.join(', ') || '(none)'}`);
    console.log(`  V2 top3: ${k2.join(', ') || '(none)'}`);
    console.log(`  expected_any: ${c.expected_top3_any.join(', ')}`);
  }
  const total = cases.length || 1;
  console.log('\n=== Summary ===');
  console.log(`Top3 recall V1: ${(100 * v1Hit / total).toFixed(1)}% (${v1Hit}/${total})`);
  console.log(`Top3 recall V2: ${(100 * v2Hit / total).toFixed(1)}% (${v2Hit}/${total})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

