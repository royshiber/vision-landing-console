import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { hebrewReadbackAnswer, ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';
import {
  convertSpokenMeasure,
  formatSpokenMeasure,
  normalizeSpokenUnits,
  DEFAULT_SPOKEN_UNITS,
} from '../lib/assist/spoken-units.mjs';
import { sanitizeLlmIntent, parseLlmIntentJson, deterministicIsFastPath } from '../lib/assist/ask-llm-intent.mjs';
import { resolveAskFlightIntent } from '../lib/assist/ask-flight-intents.mjs';
import { registerFlightEngineerApi } from '../lib/routes/flight-engineer-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function makeAssist(extras = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ask-units-'));
  const service = createAssistService({
    repoRoot: root,
    persistence: createAssistPersistence(root),
    applyParamChange: async () => ({ ok: true, method: 'offline' }),
    applyFlightOp: extras.applyFlightOp || (async ({ kind }) => ({
      ok: true,
      sent: false,
      method: 'offline',
      kind,
      note: ASSIST_HE.flightOpOffline,
    })),
    classifyAskIntent: extras.classifyAskIntent,
  });
  return { root, service };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('spoken units conversion honesty', () => {
  it('keeps SI metric as the default', () => {
    expect(normalizeSpokenUnits(null)).toEqual(DEFAULT_SPOKEN_UNITS);
    expect(formatSpokenMeasure('altitude', 120, null)).toBe('120 מטר');
    expect(formatSpokenMeasure('speed', 18, null)).toBe('18 מטר לשנייה');
    expect(formatSpokenMeasure('verticalRate', 2.5, null)).toBe('2.5 מטר לשנייה');
    expect(formatSpokenMeasure('distance', 1500, { distance: 'km' })).toBe('1.5 קילומטר');
  });

  it('converts altitude / speed / vertical rate without inventing numbers', () => {
    const ft = convertSpokenMeasure('altitude', 100, { altitude: 'ft' });
    expect(ft.value).toBeCloseTo(328.084, 2);
    expect(formatSpokenMeasure('altitude', 100, { altitude: 'ft' })).toMatch(/רגל/);
    expect(formatSpokenMeasure('speed', 10, { speed: 'kmh' })).toBe('36 קילומטר לשעה');
    expect(formatSpokenMeasure('speed', 10, { speed: 'kn' })).toMatch(/קשר/);
    expect(formatSpokenMeasure('verticalRate', 1, { verticalRate: 'ftmin' })).toMatch(/רגל לדקה/);
    expect(formatSpokenMeasure('altitude', null, { altitude: 'ft' })).toBe('--');
    expect(formatSpokenMeasure('speed', Number.NaN, { speed: 'kn' })).toBe('--');
  });

  it('formats Ask readbacks in the chosen units', () => {
    const ac = { connected: true, altitude_m: 100, airspeed_ms: 10, groundspeed_ms: 8, climb_rate_ms: 1 };
    const metric = hebrewReadbackAnswer('altitude', ac, { altitude: 'm' });
    expect(metric).toBe('גובה\n100 מטר');
    const feet = hebrewReadbackAnswer('altitude', ac, { altitude: 'ft' });
    expect(feet).toMatch(/^גובה\n328 רגל$/);
    const speed = hebrewReadbackAnswer('speed', ac, { speed: 'kmh' });
    expect(speed).toContain('אוויר 36 קילומטר לשעה');
    expect(speed).toContain('קרקע 28.8 קילומטר לשעה');
    const climb = hebrewReadbackAnswer('climb', ac, { verticalRate: 'ftmin' });
    expect(climb).toMatch(/קצב אנכי/);
    expect(climb).toMatch(/רגל לדקה/);
    expect(hebrewReadbackAnswer('altitude', { connected: true }, { altitude: 'ft' })).toBe('גובה\n--');
  });

  it('uses spoken_units from the Ask context snapshot', async () => {
    const { root, service } = makeAssist();
    try {
      const resp = await service.processInput({
        text: 'מה הגובה',
        context_snapshot: {
          spoken_units: { altitude: 'ft' },
          aircraft_state: { connected: true, altitude_m: 50 },
        },
      });
      expect(resp.intent).toBe('QUESTION');
      expect(resp.answer).toMatch(/גובה/);
      expect(resp.answer).toMatch(/רגל/);
      expect(resp.answer).not.toMatch(/\n50 מטר/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('talk-back honesty when ElevenLabs key is missing', () => {
  it('shows דיבור-חזרה לא מחובר in settings, Ask, and Flight Engineer', () => {
    expect(html).toContain('id="gsSpokenUnits"');
    expect(html).toContain('id="gsSpokenAlt"');
    expect(html).toContain('id="gsSpokenSpeed"');
    expect(html).toContain('id="gsSpokenDist"');
    expect(html).toContain('id="gsSpokenVrate"');
    expect(html).toContain('id="gsTalkbackStatus"');
    expect(html).toContain('id="assistTalkbackStatus"');
    expect(html).toContain('יחידות דיבור');
    expect(js).toContain('דיבור-חזרה לא מחובר');
    expect(js).toContain('דיבור-חזרה מחובר');
    expect(js).toContain('setTtsMode(\'browser\', \'דיבור-חזרה לא מחובר\')');
    expect(js).toContain('window.__vlcSpeakAnswer');
    expect(js).toContain('window.__vlcGetSpokenUnits');
    expect(js).toContain('spoken_units');
    expect(ASSIST_HE.talkbackDisconnected).toBe('דיבור-חזרה לא מחובר');
  });

  it('returns elevenlabs false and TTS 204 without a key', async () => {
    const prev = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const app = express();
    app.use(express.json());
    registerFlightEngineerApi(app, { db: null, APP_VERSION: '1.02.325' });
    const server = await listen(app);
    const port = server.address().port;
    try {
      const status = await fetch(`http://127.0.0.1:${port}/api/flight-engineer/status`);
      const body = await status.json();
      expect(body.elevenlabs).toBe(false);
      expect(body.elevenlabsTts).toBeNull();
      const tts = await fetch(`http://127.0.0.1:${port}/api/flight-engineer/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'גובה 100 מטר' }),
      });
      expect(tts.status).toBe(204);
    } finally {
      server.close();
      if (prev == null) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prev;
    }
  });
});

describe('free-form Ask paraphrases via LLM then gated pipelines', () => {
  it('sanitizes LLM JSON and never invents telemetry', () => {
    const land = sanitizeLlmIntent(parseLlmIntentJson('{"intent":"FLIGHT_OP","kind":"LAND"}'));
    expect(land.intent).toBe('FLIGHT_OP');
    expect(land.slots.kind).toBe('LAND');
    const arm = sanitizeLlmIntent({ intent: 'FLIGHT_OP', kind: 'ARM' });
    expect(arm.blocked).toBe(true);
    expect(arm.blocked_kind).toBe('ARM');
    const alt = sanitizeLlmIntent({
      intent: 'QUESTION',
      topic: 'altitude',
      altitude_m: 999,
    });
    expect(alt.intent).toBe('QUESTION');
    expect(alt.slots.topic).toBe('altitude');
    expect(alt.slots.altitude_m).toBeUndefined();
    const nav = sanitizeLlmIntent({ intent: 'FLIGHT_PARAM', key: 'EK3_SRC1_POSXY', value: 5 });
    expect(nav.blocked_kind).toBe('NAV_SOURCE_SWITCH');
  });

  it('maps free-form LAND / RTL / param / altitude through the existing pipelines', async () => {
    const classifyAskIntent = async (text) => {
      const q = String(text);
      if (q.includes('נחיתה רכה')) return { intent: 'FLIGHT_OP', kind: 'LAND', confidence: 0.91 };
      if (q.includes('מקום ההמראה')) return { intent: 'FLIGHT_OP', kind: 'RTL', confidence: 0.91 };
      if (q.includes('LAND_SPEED') && q.includes('שמונים')) {
        return { intent: 'FLIGHT_PARAM', key: 'LAND_SPEED', value: 80, confidence: 0.9 };
      }
      if (/off the ground|AGL/i.test(q)) return { intent: 'QUESTION', topic: 'altitude', confidence: 0.9 };
      return { intent: 'UNRESOLVED' };
    };
    const flight = async ({ kind }) => ({
      ok: true,
      sent: false,
      method: 'offline',
      kind,
      note: ASSIST_HE.flightOpOffline,
    });
    const { root, service } = makeAssist({ classifyAskIntent, applyFlightOp: flight });
    try {
      service.setAskVoiceGo(true);
      const land = await service.processInput({
        text: 'אחי תוריד אותי עכשיו בנחיתה רכה בבקשה',
        channel: 'voice',
      });
      expect(land.intent).toBe('FLIGHT_OP');
      expect(land.flight_op.kind).toBe('LAND');
      expect(land.requires_confirmation).toBe(false);

      const rtl = await service.processInput({
        text: 'קח אותי הביתה למקום ההמראה',
        channel: 'voice',
      });
      expect(rtl.flight_op.kind).toBe('RTL');

      const param = await service.processInput({
        text: 'תוריד בבקשה את מהירות הנחיתה LAND_SPEED לשמונים',
        channel: 'voice',
      });
      expect(param.intent).toBe('FLIGHT_PARAM');
      expect(param.requires_confirmation).toBe(true);
      expect(param.action_proposal.payload.key).toBe('LAND_SPEED');
      expect(param.action_proposal.payload.value).toBe(80);

      const alt = await service.processInput({
        text: 'can you tell me how far we are off the ground right now',
        context_snapshot: {
          spoken_units: { altitude: 'm' },
          aircraft_state: { connected: true, altitude_m: 42 },
        },
      });
      expect(alt.intent).toBe('QUESTION');
      expect(alt.answer).toBe('גובה\n42 מטר');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks ARM even when paraphrased by the LLM', async () => {
    const classifyAskIntent = async () => ({ intent: 'FLIGHT_OP', kind: 'ARM' });
    const flight = async () => {
      throw new Error('must not send');
    };
    const { root, service } = makeAssist({ classifyAskIntent, applyFlightOp: flight });
    try {
      service.setAskVoiceGo(true);
      const arm = await service.processInput({
        text: 'please spin the props and give me motor power',
        channel: 'voice',
      });
      expect(arm.blocked).toBe(true);
      expect(arm.blocked_kind).toBe('ARM');
      expect(arm.answer).toBe(ASSIST_HE.blockedFlightCommandAnswer);
      expect(arm.action_proposal).toBe(null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still blocks ARM paraphrases on the regex safety net', () => {
    expect(resolveAskFlightIntent('תפעיל את המנועים').blocked_kind).toBe('ARM');
    expect(resolveAskFlightIntent('turn the motors on').blocked_kind).toBe('ARM');
    expect(resolveAskFlightIntent('תחמש').blocked_kind).toBe('ARM');
    expect(deterministicIsFastPath(resolveAskFlightIntent('תחמש'))).toBe(true);
  });
});
