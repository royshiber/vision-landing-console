import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';
import {
  ASK_NO_GEMINI_HE,
  answerAskStatus,
  answerAskWithGemini,
  askStatusFacts,
  classifyAskStatusQuestion,
  fcLinkPhrase,
} from '../lib/assist/ask-status-answer.mjs';
import { buildAssistContext } from '../lib/assist/assist-context.mjs';

const LIVE = {
  current_tab: 'terrain',
  current_workspace: 'MISSION',
  current_capability: 'mission',
  aircraft_state: {
    connected: true,
    link_path: 'cellular',
    flight_mode: 'MANUAL',
    armed: false,
    gps_ok: true,
    gps_sats: 12,
    ekf_ok: true,
    battery_v: 16.4,
    battery_pct: 82,
    link_quality: 74,
    status_texts: [
      'PreArm: Waiting for RC',
      'PreArm: AHRS: waiting for home',
      'EKF3 waiting for GPS config data',
    ],
  },
  ops_signals: {
    cameras: { cam0: true, cam1: false },
    jetson: 'reachable',
  },
};

function makeService(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-ask-status-'));
  const service = createAssistService({
    repoRoot: root,
    persistence: createAssistPersistence(root),
    ...extra,
  });
  return { root, service };
}

async function ask(service, text, snapshot = LIVE) {
  return service.processInput({ text, context_snapshot: snapshot });
}

describe('offline Ask status answers', () => {
  let root;
  let service;
  let prevKey;

  beforeEach(() => {
    prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    ({ root, service } = makeService());
  });

  afterEach(() => {
    if (prevKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers whether the FC is connected and by which path', async () => {
    const resp = await ask(service, 'אתה מחובר לבקר?');
    expect(resp.intent).toBe('QUESTION');
    expect(resp.answer).toBe('בקר הטיסה מחובר דרך סלולר.');
    expect(resp.answer).not.toMatch(/המטוס|הרחפן|אתם במרחב/);
    expect(resp.action_proposal).toBe(null);

    const rf = await ask(service, 'האם הבקר מחובר?', {
      ...LIVE,
      aircraft_state: { ...LIVE.aircraft_state, link_path: 'rf' },
    });
    expect(rf.answer).toBe('בקר הטיסה מחובר דרך RF.');

    const sitl = await ask(service, 'אתה מחובר לבקר?', {
      ...LIVE,
      aircraft_state: {
        ...LIVE.aircraft_state,
        link_path: 'rf',
        link_role: 'radio',
        simulator: true,
        link_type: 'tcp',
        link_host: '127.0.0.1',
        link_port: 5760,
      },
    });
    expect(sitl.answer).toBe('בקר הטיסה מחובר דרך סימולטור.');

    const down = await ask(service, 'אתה מחובר לבקר?', {
      ...LIVE,
      aircraft_state: { ...LIVE.aircraft_state, connected: false, link_path: null },
    });
    expect(down.answer).toBe('בקר הטיסה אינו מחובר.');

    const nopath = await ask(service, 'אתה מחובר לבקר?', {
      ...LIVE,
      aircraft_state: { ...LIVE.aircraft_state, link_path: null },
    });
    expect(nopath.answer).toBe('בקר הטיסה מחובר. אין נתון על המסלול.');
    expect(fcLinkPhrase({
      connected: true,
      link_path: 'rf',
      link_type: 'tcp',
      link_host: '127.0.0.1',
      link_port: 5760,
    })).toBe('סימולטור');
  });

  it('answers mode, armed, GPS, EKF, battery, and link quality from telemetry', async () => {
    expect((await ask(service, 'מה מצב הטיסה?')).answer).toContain('מצב הטיסה הוא');
    expect((await ask(service, 'מה מצב הטיסה?')).answer).toContain('MANUAL');
    expect((await ask(service, 'האם חמוש?')).answer).toBe('בקר הטיסה אינו חמוש.');
    expect((await ask(service, 'is it armed?', {
      ...LIVE,
      aircraft_state: { ...LIVE.aircraft_state, armed: true },
    })).answer).toBe('בקר הטיסה חמוש.');
    expect((await ask(service, 'מה מצב ה-GPS?')).answer).toBe('GPS תקין, 12 לוויינים. EKF תקין.');
    expect((await ask(service, 'מה מצב הסוללה?')).answer).toBe('הסוללה 16.4 וולט, 82 אחוז.');
    expect((await ask(service, 'מה איכות הקישור?')).answer).toBe('איכות הקישור 74 אחוז.');
  });

  it('keeps the short GPS sentence when only gps_ok is known', async () => {
    const resp = await ask(service, 'מה מצב ה-GPS', {
      current_tab: 'telemetry',
      aircraft_state: { gps_ok: true, connected: true },
    });
    expect(resp.answer).toBe(ASSIST_HE.gpsOk);
    expect(resp.answer).not.toMatch(/המטוס|לוויינים/);
  });

  it('lists active PreArm blockers in Hebrew', async () => {
    const resp = await ask(service, 'למה אי אפשר לחמש?');
    expect(resp.answer).toBe(
      'לא ניתן לחמש: נדרש שלט RC. לא ניתן לחמש: ממתינים לנקודת בית. לא ניתן לחמש: EKF3 ממתינים להגדרת GPS.',
    );
    expect(resp.answer).not.toMatch(/Waiting for RC|המטוס/);
    const clear = await ask(service, 'למה אי אפשר לחמש?', {
      ...LIVE,
      aircraft_state: { ...LIVE.aircraft_state, status_texts: ['ArduPilot ready'] },
    });
    expect(clear.answer).toBe('אין הודעות שחוסמות חימוש.');
    expect((await ask(service, "why can't I arm?")).answer).toContain('לא ניתן לחמש: נדרש שלט RC');
  });

  it('answers cameras and Jetson from ops signals', async () => {
    expect((await ask(service, 'האם המצלמות משדרות?')).answer).toBe('קדמית משדרת. מטה אינה משדרת.');
    expect((await ask(service, 'מה מצב ה-Jetson?')).answer).toBe('מחשב משימה (Jetson) מחובר.');
    expect(answerAskStatus('jetson', buildAssistContext({ ops_signals: { jetson: 'mock' } }))).toBe('מחשב משימה (Jetson) במצב הדמיה.');
    expect(answerAskStatus('jetson', buildAssistContext({ ops_signals: { jetson: 'unreachable' } }))).toBe('מחשב משימה (Jetson) אינו מגיב.');
    expect(answerAskStatus('jetson', buildAssistContext({ ops_signals: { jetson: 'off' } }))).toBe('מחשב משימה (Jetson) כבוי.');
    expect(answerAskStatus('cameras', buildAssistContext({}))).toBe('אין נתון על זרם המצלמות.');
  });

  it('answers the FC question on the vision tab instead of a generic template', async () => {
    const resp = await ask(service, 'אתה מחובר לבקר?', {
      ...LIVE,
      current_capability: 'vision',
      current_tab: 'visionNavParams',
    });
    expect(resp.answer).toBe('בקר הטיסה מחובר דרך סלולר.');
    expect(resp.answer).not.toMatch(/ראייה|אתם במרחב/);
  });

  it('says there is no Gemini key for a question that is not a status question', async () => {
    const resp = await ask(service, 'למה השמיים כחולים?');
    expect(resp.intent).toBe('QUESTION');
    expect(resp.answer).toBe(ASK_NO_GEMINI_HE);
    expect(resp.answer).not.toMatch(/\n|המטוס|אתם במרחב|QUESTION|conf/);
    expect(classifyAskStatusQuestion('למה השמיים כחולים?')).toBe(null);
  });

  it('does not replace an evolve question or an unresolved phrase', async () => {
    const bananas = await ask(service, 'purple bananas dance tomorrow', { current_tab: 'development' });
    expect(bananas.intent).toBe('UNRESOLVED');
    expect(bananas.answer).toBe(ASSIST_HE.unresolvedAnswer);
  });

  it('passes the same telemetry facts to Gemini and does not call the network in tests', async () => {
    const seen = [];
    const hooked = makeService({
      answerWithGemini: async ({ question, facts }) => {
        seen.push({ question, facts });
        return 'תשובה מהמודל.';
      },
    });
    try {
      const open = await ask(hooked.service, 'למה השמיים כחולים?');
      expect(open.answer).toBe('תשובה מהמודל.');
      expect(seen).toHaveLength(1);
      expect(seen[0].facts.fc_connected).toBe(true);
      expect(seen[0].facts.link_path).toBe('cellular');
      expect(seen[0].facts.flight_mode).toBe('MANUAL');
      expect(seen[0].facts.armed).toBe(false);
      expect(seen[0].facts.gps_sats).toBe(12);
      expect(seen[0].facts.battery_v).toBe(16.4);
      expect(seen[0].facts.prearm.length).toBe(3);
      expect(seen[0].facts.cameras).toEqual({ cam0: true, cam1: false });
      expect(seen[0].facts.jetson).toBe('reachable');
      expect(askStatusFacts(buildAssistContext(LIVE))).toEqual(seen[0].facts);

      const status = await ask(hooked.service, 'אתה מחובר לבקר?');
      expect(status.answer).toBe('בקר הטיסה מחובר דרך סלולר.');
      expect(seen).toHaveLength(1);
    } finally {
      fs.rmSync(hooked.root, { recursive: true, force: true });
    }

    process.env.GEMINI_API_KEY = 'test-key-not-used';
    expect(await answerAskWithGemini({ question: 'למה?', facts: { fc_connected: false } })).toBe(null);
  });

  it('hides the debug footer and sends live fields from the client snapshot', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8');
    const send = app.slice(app.indexOf('async function assistSendText'), app.indexOf('async function assistConfirm'));
    expect(send).not.toMatch(/conf /);
    expect(send).not.toMatch(/assist-msg-meta/);
    const snap = app.slice(app.indexOf('function assistBuildContextSnapshot'), app.indexOf('function assistBuildOpsSignals'));
    expect(snap).toMatch(/link_path: assistLinkPath/);
    expect(snap).toMatch(/simulator: mav\.simulator === true/);
    const linkFn = app.slice(app.indexOf('function assistLinkPath'), app.indexOf('function assistLinkQuality'));
    expect(linkFn.indexOf('simulator === true')).toBeLessThan(linkFn.indexOf("return 'rf'"));
    expect(linkFn).toContain('5760');
    expect(snap).toMatch(/status_texts: assistStatusTexts/);
    expect(snap).toMatch(/battery_v:/);
    expect(snap).toMatch(/gps_sats:/);
    expect(app).toMatch(/function assistJetsonState/);
    const css = fs.readFileSync(path.join(process.cwd(), 'public/styles.css'), 'utf8');
    expect(css).toMatch(/#missionTalkHost \.assist-msg-body[\s\S]{0,120}white-space:\s*normal/);
    expect(css).toMatch(/\.assist-msg-meta\s*\{[^}]*display:\s*none/);
    const gemini = fs.readFileSync(path.join(process.cwd(), 'lib/assist/ask-status-answer.mjs'), 'utf8');
    expect(gemini).toMatch(/Telemetry JSON/);
    expect(gemini).toMatch(/בקר הטיסה/);
    expect(gemini).toMatch(/if \(process\.env\.VITEST\) return null/);
  });
});
