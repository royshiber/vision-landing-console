import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mapMissionSentence } from '../lib/assist/mission-sentence.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { runVoiceFlightTranscript } from '../lib/voice-flight-pipeline.mjs';

const mapperSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/assist/mission-sentence.mjs'),
  'utf8',
);

function modes(result) {
  return result?.plan?.modes || [];
}

function noTrack(result) {
  expect(JSON.stringify(result.plan)).not.toMatch(/track/i);
}

describe('mission sentence mapper', () => {
  it('does not send MAVLink or call the flight-op sender', () => {
    expect(mapperSrc).not.toMatch(/applyFlightOp\s*\(|from ['"][^'"]*mavlink/i);
  });

  it('plans a look and a keep for the green sign', () => {
    const result = mapMissionSentence('תסתכל על השלט הירוק ותשאיר אותו בפריים');
    expect(modes(result)).toEqual(['LOOK', 'KEEP_IN_FRAME']);
    expect(result.plan.steps[0].target).toEqual({ color: 'ירוק', object: 'שלט' });
    expect(result.replyHe).toBe('מסתכלים על השלט הירוק ושומרים אותו בפריים.');
    expect(result.sends).toBe(false);
    noTrack(result);
  });

  it('keeps orbit unsupported and unsent', () => {
    const result = mapMissionSentence('circle it and lock it');
    expect(modes(result)).toEqual(['ORBIT_TARGET', 'LOCK']);
    expect(result.plan.steps[0].supported).toBe(false);
    expect(result.plan.steps[0].target).toBe(null);
    expect(result.replyHe).toContain('אינה נתמכת');
    expect(result.replyHe).toContain('לא נשלח דבר');
    expect(result.sends).toBe(false);
    noTrack(result);
  });

  it('bounds a scan when a duration is spoken and keeps the alert running', () => {
    const result = mapMissionSentence('scan for ten minutes and alert if people, animals, or cars move');
    expect(modes(result)).toEqual(['SCAN', 'ALERT']);
    expect(result.plan.steps[0].duration_s).toBe(600);
    expect(result.plan.steps[1].stopsScan).toBe(false);
    expect(result.plan.steps[1].subjects).toEqual(['אנשים', 'חיות', 'מכוניות']);
    expect(result.replyHe).toContain('עשר דקות');
    expect(result.replyHe).toContain('ההתראה לא עוצרת את הסריקה');
    expect(result.replyHe).not.toMatch(/כמה זמן/);
    expect(result.sends).toBe(false);
    noTrack(result);
  });

  it('scans until a later command when no duration is spoken', () => {
    const result = mapMissionSentence('תסרוק');
    expect(modes(result)).toEqual(['SCAN']);
    expect(result.plan.steps[0].duration_s).toBe(null);
    expect(result.plan.steps[0].until).toBe('replaced');
    expect(result.replyHe).toBe('סורקים עד פקודה שעוצרת או מחליפה.');
    expect(result.replyHe).not.toMatch(/כמה זמן/);
    expect(result.sends).toBe(false);
  });

  it('answers a camera question with the optics names', () => {
    const result = mapMissionSentence('מה אני רואה במצלמות');
    expect(result.plan.cameras.map((row) => row.nameHe)).toEqual(['קדמית', 'מטה', 'גימבל']);
    expect(result.replyHe).toBe('המצלמות הן קדמית, מטה וגימבל.');
    expect(result.replyHe).not.toContain('אתם במרחב');
    expect(result.replyHe).not.toContain('אין נתון על זרם המצלמות');
    expect(result.sends).toBe(false);
  });

  it('leaves whole-phrase flight, negation, and arm near-misses alone', () => {
    expect(mapMissionSentence('circle')).toBe(null);
    expect(mapMissionSentence('אל תחזור הביתה')).toBe(null);
    expect(mapMissionSentence('חמש')).toBe(null);
    expect(mapMissionSentence('חמש דקות')).toBe(null);
    expect(mapMissionSentence('מה אני רואה')).toBe(null);
    const grab = mapMissionSentence('תפוס את השלט');
    expect(grab.plan.unsupported).toEqual(['grab']);
    expect(grab.plan.modes).toEqual([]);
    expect(grab.sends).toBe(false);
  });
});

describe('mission sentences through Ask and voice', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function service(applyFlightOp) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-mission-'));
    roots.push(root);
    return createAssistService({
      repoRoot: root,
      persistence: createAssistPersistence(root),
      applyFlightOp,
    });
  }

  const sentences = [
    ['תסתכל על השלט הירוק ותשאיר אותו בפריים', 'השלט הירוק'],
    ['circle it and lock it', 'אינה נתמכת'],
    ['scan for ten minutes and alert if people, animals, or cars move', 'עשר דקות'],
    ['תסרוק', 'עד פקודה'],
    ['מה אני רואה במצלמות', 'קדמית'],
  ];

  it('returns a plan and a Hebrew sentence without sending', async () => {
    const calls = [];
    const assist = service(async (args) => {
      calls.push(args);
      return { ok: true, sent: true };
    });
    for (const [text, needle] of sentences) {
      const resp = await assist.processInput({
        text,
        context_snapshot: { current_workspace: 'MISSION' },
      });
      expect(resp.intent).toBe('MISSION_PLAN');
      expect(resp.plan).toBeTruthy();
      expect(resp.sent).toBe(false);
      expect(resp.answer).toContain(needle);
      expect(resp.answer).not.toContain('אתם במרחב');
      expect(resp.answer).not.toContain('אין נתון על זרם המצלמות');
    }
    expect(calls).toEqual([]);

    const seeing = await assist.processInput({
      text: 'מה אני רואה',
      context_snapshot: { current_workspace: 'MISSION' },
    });
    expect(seeing.answer).toContain('אתם במרחב');
    expect(seeing.plan).toBeUndefined();
  });

  it('keeps voice send count at zero on a local simulator', async () => {
    const calls = [];
    const mav = {
      connected: true,
      type: 'tcp',
      host: '127.0.0.1',
      port: 5760,
      simulatorPreset: true,
      lastCustomMode: 0,
      simulatorDetection() {
        return { simulator: true, reason: 'preset' };
      },
    };
    for (const [text, needle] of sentences) {
      const result = await runVoiceFlightTranscript({
        text,
        goActive: true,
        operatorConfirmed: true,
        mavConn: mav,
        applyFlightOp: async (args) => {
          calls.push(args);
          return { ok: true, sent: true };
        },
      });
      expect(result.sent).toBe(false);
      expect(result.decision).toBe('mission_plan');
      expect(result.plan).toBeTruthy();
      expect(result.talkback.text).toContain(needle);
    }
    expect(calls).toEqual([]);
  });
});
