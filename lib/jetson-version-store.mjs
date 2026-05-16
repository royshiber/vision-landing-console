import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_RELEASES } from './jetson-releases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'data', 'jetson-version-state.json');

const DEFAULT_STATE = {
  installedVersion: DEFAULT_RELEASES[0].version,
  installState: 'idle',
  lastAction: 'מוכן',
  history: [],
};

/** Why: operators need install/rollback state to survive server restarts. What: reads JSON from data/ or returns defaults. */
export function readJetsonVersionState() {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.installedVersion) return { ...DEFAULT_STATE };
    return parsed;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Why: install API updates the single source of truth for “what is installed” in lab workflows. What: writes JSON under data/. */
export function writeJetsonVersionState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}
