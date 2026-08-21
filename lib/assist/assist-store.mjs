import fs from 'fs';
import path from 'path';
import { nowIso } from './assist-types.mjs';

const NOTES_REL = path.join('var', 'assist', 'notes.json');
const OBS_REL = path.join('var', 'assist', 'observations.json');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function notesPath(repoRoot) {
  return path.join(repoRoot, NOTES_REL);
}

function obsPath(repoRoot) {
  return path.join(repoRoot, OBS_REL);
}

export function createAssistPersistence(repoRoot) {
  return {
    listRecentNotes(limit = 10) {
      const store = readJson(notesPath(repoRoot), { notes: [] });
      return (store.notes || []).slice(-limit).reverse();
    },
    createNote({ text, context_snapshot }) {
      const store = readJson(notesPath(repoRoot), { notes: [] });
      const note = {
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        created_at: nowIso(),
        text: String(text || '').trim(),
        workspace: context_snapshot?.current_workspace || null,
        capability: context_snapshot?.current_capability || null,
        tab: context_snapshot?.current_ui_state?.tab || null,
      };
      store.notes = [...(store.notes || []), note].slice(-200);
      writeJson(notesPath(repoRoot), store);
      return note;
    },
    listRecentObservations(limit = 10) {
      const store = readJson(obsPath(repoRoot), { observations: [] });
      return (store.observations || []).slice(-limit).reverse();
    },
    createObservation({ text, context_snapshot }) {
      const store = readJson(obsPath(repoRoot), { observations: [] });
      const obs = {
        id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: nowIso(),
        text: String(text || '').trim(),
        workspace: context_snapshot?.current_workspace || null,
        capability: context_snapshot?.current_capability || null,
        mission: context_snapshot?.current_mission || null,
        aircraft_state: context_snapshot?.aircraft_state || null,
        ui: context_snapshot?.current_ui_state || null,
      };
      store.observations = [...(store.observations || []), obs].slice(-200);
      writeJson(obsPath(repoRoot), store);
      return obs;
    },
  };
}
