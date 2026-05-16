/**
 * Downloads the official ArduPlane parameter definition file from ArduPilot's
 * autotest server and saves it to data/arduplane-params.json.
 *
 * Usage: npm run fetch-arduplane-params
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_URL = 'https://autotest.ardupilot.org/Parameters/ArduPlane/apm.pdef.json';
const OUT_PATH = path.join(__dirname, '..', 'data', 'arduplane-params.json');

async function main() {
  console.log(`[fetch-arduplane-params] Downloading from:\n  ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'VisionLandingConsole/param-fetch' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const raw = await res.json();

  // The .pdef.json has sections as top-level keys (empty string = root).
  // Flatten all sections into one map.
  const params = {};
  for (const [, sectionData] of Object.entries(raw)) {
    if (!sectionData || typeof sectionData !== 'object') continue;
    for (const [pName, pData] of Object.entries(sectionData)) {
      if (!pData || typeof pData !== 'object') continue;
      params[pName] = {
        display_name: pData.DisplayName || pName,
        description: pData.Description || '',
        units: pData.Units || null,
        range: pData.Range ? { low: String(pData.Range.low), high: String(pData.Range.high) } : null,
        values: pData.Values || null,
        bitmask: pData.Bitmask || null,
      };
    }
  }

  const count = Object.keys(params).length;
  const output = {
    _meta: {
      fetched_at: new Date().toISOString(),
      source_url: SOURCE_URL,
      vehicle: 'ArduPlane',
      count,
    },
    params,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[fetch-arduplane-params] Saved ${count} parameters → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[fetch-arduplane-params] FAILED:', err.message);
  process.exit(1);
});
