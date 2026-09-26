import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { DEBRIEF_SYSTEM_PROMPT, NO_GEMINI_KEY_HE, PROMPT_VERSION, callGeminiDebrief, getFlightDebrief } from '../lib/flight-logs/debrief.mjs';
import { validateDebrief } from '../lib/flight-logs/debrief-validate.mjs';
import { buildFactSheet, collapseEvents } from '../lib/flight-logs/fact-sheet.mjs';
import { _resetFlightLogsMemory, syncFlightLogs } from '../lib/flight-logs/sync.mjs';
import { formatTPlus } from '../lib/flight-logs/time.mjs';
import { geminiMinIntervalMs } from '../lib/gemini-throttle.mjs';
import { registerFlightLogsApi } from '../lib/routes/flight-logs-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'flight-logs');
const UID_B = '20260921T080000Z-airvix01-c3d4';
const ENV_KEYS = [
  'FLIGHT_LOGS_MODE',
  'FLIGHT_LOGS_FIXTURE_ROOT',
  'FLIGHT_DEBRIEF_MOCK',
  'GEMINI_API_KEY',
  'GEMINI_MIN_INTERVAL_MS',
];

let savedEnv = null;

function saveEnv() {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _resetFlightLogsMemory();
}

beforeEach(() => {
  saveEnv();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GEMINI_MIN_INTERVAL_MS = '0';
  _resetFlightLogsMemory();
});

afterEach(() => {
  restoreEnv();
});

const sheet = {
  facts: [{ id: 'F1', key: 'max_rel_alt_m', value: 86, unit: 'm', t_rel_s: 240 }],
  insights: [{ id: 'I1', text_he: 'סיבה', from_rel_s: 208, to_rel_s: 212 }],
  events: [{ id: 'E1', t_rel_s: 125, sev: 'error', type: 'failsafe', msg_he: 'אובדן' }],
  modes: [{ mode: 'FBWA', from_rel_s: 0, to_rel_s: 210 }, { mode: 'RTL', from_rel_s: 210, to_rel_s: 480 }],
  stats: { max_rel_alt_m: 86 },
};

function baseDraft(over = {}) {
  return {
    verdict: 'problem',
    summary_he: 'הגובה המרבי היה 86 מטר.',
    what_happened: [{ text_he: 'האירוע סומן ב־T+02:05.', cite: ['E1'] }],
    why: [{ text_he: 'הסיבה מתועדת בתובנה של הטיסה.', cite: ['I1'] }],
    what_to_do: [{ text_he: 'לבדוק את הקישור לפני הטיסה הבאה.', cite: ['I1'], confidence: 'medium' }],
    unknowns_he: [],
    ...over,
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(server, url, opts = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

async function synced() {
  process.env.FLIGHT_LOGS_MODE = 'mock';
  process.env.FLIGHT_LOGS_FIXTURE_ROOT = fixtureRoot;
  const db = openDatabase(path.join(os.tmpdir(), `airvix-debrief-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`));
  const ctx = { db };
  await syncFlightLogs(ctx);
  return ctx;
}

function goodFromSheet(built) {
  const fact = built.facts.find((row) => typeof row.value === 'number');
  const event = built.events.find((row) => row.sev === 'error' || row.sev === 'warning');
  const insight = built.insights[0];
  return {
    verdict: 'problem',
    summary_he: `הגובה המרבי היה ${fact.value} מטר.`,
    what_happened: [{ text_he: `האירוע סומן ב־${formatTPlus(event.t_rel_s)}.`, cite: [event.id] }],
    why: [{ text_he: 'הסיבה מתועדת בתובנה של הטיסה.', cite: [insight.id] }],
    what_to_do: [{ text_he: 'לבדוק את הקישור לפני הטיסה הבאה.', cite: [insight.id], confidence: 'medium' }],
    unknowns_he: [],
  };
}

function badDraft() {
  const bad = { text_he: 'הגובה היה 99999 מטר במצב COPTER.', cite: ['NO_SUCH'] };
  return {
    verdict: 'ok',
    summary_he: 'הכל תקין ללא מספר.',
    what_happened: [bad, bad, bad],
    why: [bad],
    what_to_do: [{ ...bad, confidence: 'high' }],
    unknowns_he: [],
  };
}

describe('fact sheet', () => {
  it('is deterministic and records truncation', () => {
    const events = [
      { id: 'W1', type: 'fail', sev: 'warning', t_rel_s: 1, msg: 'warn' },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `N${i}`, type: `noise-${i}`, sev: 'info', t_rel_s: 10 + i, msg: 'note',
      })),
    ];
    const first = buildFactSheet({ flightId: 'flt', summary: { facts: [], insights: [], modes: [] }, events, maxEvents: 3 });
    const second = buildFactSheet({ flightId: 'flt', summary: { facts: [], insights: [], modes: [] }, events, maxEvents: 3 });
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.truncated).toBe(true);
    expect(first.events.some((row) => row.id === 'W1')).toBe(true);
    expect(first.events.length).toBe(3);

    const repeated = Array.from({ length: 6 }, (_, i) => ({
      id: `R${i}`, type: 'gps', sev: 'info', t_rel_s: i, msg: 'ping',
    }));
    const collapsed = collapseEvents(repeated, 400);
    expect(collapsed.events.map((row) => row.id)).toEqual(['R0', 'R5']);

    const bulky = Array.from({ length: 12 }, (_, i) => ({
      id: `B${i}`, type: `bulk-${i}`, sev: 'info', t_rel_s: i, msg: 'x'.repeat(4000),
    }));
    const trimmed = buildFactSheet({
      flightId: 'flt',
      summary: { facts: [], insights: [], modes: [] },
      events: bulky,
      maxTokens: 80,
    });
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.dropped).toBeGreaterThan(0);
    expect(trimmed.events.length).toBeLessThan(bulky.length);
  });
});

describe('debrief validator', () => {
  it('accepts a grounded draft', () => {
    const result = validateDebrief(baseDraft(), sheet);
    expect(result.ok).toBe(true);
    expect(result.failureRatio).toBe(0);
    expect(result.output.what_happened[0].unverified).toBe(false);
  });

  it('flags an invented number, a wrong time, a wrong mode, and an unknown cite', () => {
    const invented = validateDebrief(baseDraft({
      what_happened: [{ text_he: 'הגובה היה 99999 מטר.', cite: ['E1'] }],
    }), sheet);
    expect(invented.output.what_happened[0].unverified).toBe(true);
    expect(invented.errors.some((line) => line.includes('number 99999'))).toBe(true);

    const wrongTime = validateDebrief(baseDraft({
      what_happened: [{ text_he: 'האירוע סומן ב־T+00:50.', cite: ['E1'] }],
    }), sheet);
    expect(wrongTime.output.what_happened[0].unverified).toBe(true);
    expect(wrongTime.errors.some((line) => line.includes('time'))).toBe(true);

    const wrongMode = validateDebrief(baseDraft({
      what_happened: [{ text_he: 'עבר למצב MANUAL.', cite: ['E1'] }],
    }), sheet);
    expect(wrongMode.output.what_happened[0].unverified).toBe(true);
    expect(wrongMode.errors.some((line) => line.includes('mode MANUAL'))).toBe(true);

    const unknown = validateDebrief(baseDraft({
      why: [{ text_he: 'הסיבה מתועדת בתובנה של הטיסה.', cite: ['NO_SUCH'] }],
    }), sheet);
    expect(unknown.output.why[0].unverified).toBe(true);
    expect(unknown.errors.some((line) => line.includes('unknown cite NO_SUCH'))).toBe(true);
  });

  it('recomputes a summary that invents a number', () => {
    const result = validateDebrief(baseDraft({ summary_he: 'הגובה היה 99999 מטר.' }), sheet);
    expect(result.output.summary_recomputed).toBe(true);
    expect(result.output.summary_he).not.toContain('99999');
    expect(result.output.summary_he).toContain('האירוע סומן');
  });
});

describe('debrief generation with a mocked model', () => {
  it('keeps the grounding rules in the system prompt', () => {
    expect(DEBRIEF_SYSTEM_PROMPT).toContain('Hebrew');
    expect(DEBRIEF_SYSTEM_PROMPT).toContain('ONLY IDs');
    expect(DEBRIEF_SYSTEM_PROMPT).toContain('cite at least 1 ID');
    expect(DEBRIEF_SYSTEM_PROMPT).toContain('אין נתונים');
    expect(DEBRIEF_SYSTEM_PROMPT).toContain('never offer to apply, arm');
    expect(DEBRIEF_SYSTEM_PROMPT).toContain('cause_id');
    expect(PROMPT_VERSION).toBe('flight-debrief/1');
    expect(geminiMinIntervalMs()).toBe(0);
  });

  it('refuses Gemini when the key is missing', async () => {
    await expect(callGeminiDebrief({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'NO_KEY' });
  });

  it('stores a successful debrief and serves the cache until force', async () => {
    const ctx = await synced();
    let calls = 0;
    const generate = async (built) => {
      calls += 1;
      return goodFromSheet(built);
    };
    const first = await getFlightDebrief(ctx, UID_B, { generate });
    const second = await getFlightDebrief(ctx, UID_B, { generate });
    expect(calls).toBe(1);
    expect(first.available).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.status).toBe('ok');
    expect(first.debrief.verdict).toBe('problem');
    expect(first.debrief.what_happened[0].unverified).toBe(false);
    expect(first.debrief.what_happened[0].chips[0].label).toMatch(/^T[+-]/);
    expect(second.cached).toBe(true);
    expect(second.input_digest).toBe(first.input_digest);
    const forced = await getFlightDebrief(ctx, UID_B, { force: true, generate });
    expect(calls).toBe(2);
    expect(forced.cached).toBe(false);
    ctx.db.close();
  });

  it('retries once when more than a fifth of the sentences fail', async () => {
    const ctx = await synced();
    let calls = 0;
    const generate = async (built, errors) => {
      calls += 1;
      if (!errors) return badDraft();
      expect(errors.length).toBeGreaterThan(0);
      return goodFromSheet(built);
    };
    const result = await getFlightDebrief(ctx, UID_B, { generate });
    expect(calls).toBe(2);
    expect(result.status).toBe('ok');
    expect(result.debrief.what_happened[0].unverified).toBe(false);
    ctx.db.close();
  });

  it('keeps partial status when the retry is still mostly unverified', async () => {
    const ctx = await synced();
    let calls = 0;
    const generate = async () => {
      calls += 1;
      return badDraft();
    };
    const result = await getFlightDebrief(ctx, UID_B, { generate });
    expect(calls).toBe(2);
    expect(result.status).toBe('partial');
    expect(result.bannerHe).toContain('לא אומתו');
    expect(result.debrief.what_happened.some((row) => row.unverified)).toBe(true);
    const cached = await getFlightDebrief(ctx, UID_B, { generate });
    expect(calls).toBe(2);
    expect(cached.status).toBe('partial');
    ctx.db.close();
  });

  it('returns the Hebrew not-configured state without calling a model', async () => {
    const ctx = await synced();
    let calls = 0;
    const result = await getFlightDebrief(ctx, UID_B);
    expect(calls).toBe(0);
    expect(result.available).toBe(false);
    expect(result.messageHe).toBe(NO_GEMINI_KEY_HE);
    expect(result.debrief).toBeNull();
    expect(result.insights.length).toBeGreaterThan(0);
    ctx.db.close();
  });

  it('serves mock, partial, no-key, and missing flights over HTTP', async () => {
    const ctx = await synced();
    const app = express();
    app.use(express.json());
    registerFlightLogsApi(app, ctx);
    const server = await listen(app);
    try {
      process.env.FLIGHT_DEBRIEF_MOCK = 'nokey';
      process.env.GEMINI_API_KEY = 'should-not-be-used';
      const nokey = await request(server, `/api/flight-logs/flights/${UID_B}/debrief`);
      expect(nokey.status).toBe(200);
      expect(nokey.json.available).toBe(false);
      expect(nokey.json.messageHe).toBe(NO_GEMINI_KEY_HE);
      expect(JSON.stringify(nokey.json)).not.toContain('should-not-be-used');

      process.env.FLIGHT_DEBRIEF_MOCK = 'ok';
      const ok = await request(server, `/api/flight-logs/flights/${UID_B}/debrief`);
      expect(ok.status).toBe(200);
      expect(ok.json.available).toBe(true);
      expect(ok.json.status).toBe('ok');
      expect(ok.json.model).toBe('mock-ok');
      const again = await request(server, `/api/flight-logs/flights/${UID_B}/debrief`);
      expect(again.json.cached).toBe(true);

      process.env.FLIGHT_DEBRIEF_MOCK = 'partial';
      const partial = await request(server, `/api/flight-logs/flights/${UID_B}/debrief`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      expect(partial.status).toBe(200);
      expect(partial.json.status).toBe('partial');
      expect(partial.json.debrief.what_happened.some((row) => row.unverified)).toBe(true);

      const missing = await request(server, '/api/flight-logs/flights/missing-flight/debrief');
      expect(missing.status).toBe(404);

      const listed = await request(server, '/api/flight-logs/flights');
      const card = listed.json.flights.find((row) => row.flight_uid === UID_B);
      expect(card.debriefBadgeHe).toBe('יש תחקיר');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      ctx.db.close();
    }
  });
});
