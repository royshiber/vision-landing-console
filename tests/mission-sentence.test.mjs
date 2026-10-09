import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mapMissionSentence } from '../lib/assist/mission-sentence.mjs';
import { createAssistService } from '../lib/assist/assist-service.mjs';
import { createAssistPersistence } from '../lib/assist/assist-store.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { deterministicIsFastPath } from '../lib/assist/ask-llm-intent.mjs';
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
    expect(result.replyHe).toContain('מתריעים אם');
    expect(result.replyHe).not.toContain('ההתראה לא עוצרת');
    expect(result.replyHe).not.toMatch(/כמה זמן/);
    expect(result.sends).toBe(false);
    noTrack(result);
  });

  it('scans until a later command when no duration is spoken', () => {
    const result = mapMissionSentence('תסרוק');
    expect(modes(result)).toEqual(['SCAN']);
    expect(result.plan.steps[0].duration_s).toBe(null);
    expect(result.plan.steps[0].until).toBe('replaced');
    expect(result.replyHe).toBe('סורקים.');
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

  it('plans a plural lock and never sends it', () => {
    for (const [text, name] of [['נעלו על האדם', 'האדם'], ['נעלו על הרכב', 'הרכב']]) {
      const result = mapMissionSentence(text);
      expect(modes(result)).toEqual(['LOCK']);
      expect(result.replyHe).toBe(`נעילה על ${name} נוספה לתוכנית.`);
      expect(result.replyHe).not.toContain('לא נשלח דבר');
      expect(result.sends).toBe(false);
      expect(result.speech).toBe(true);
    }
    expect(mapMissionSentence('אל תנעלו על האדם')).toBe(null);
    expect(mapMissionSentence('לא לנעול')).toBe(null);
  });

  it('plans the next object and does not send it', () => {
    for (const text of ['עברו לאובייקט הבא', 'עברו לעצם הבא', 'תעברו לאובייקט הבא']) {
      const result = mapMissionSentence(text);
      expect(modes(result)).toEqual(['NEXT']);
      expect(result.replyHe).toBe('מעבר לאובייקט הבא נוסף לתוכנית.');
      expect(result.replyHe).not.toContain('לא נשלח דבר');
      expect(result.sends).toBe(false);
    }
  });

  it('treats release as harmless and says when nothing is locked', () => {
    for (const text of ['שחררו נעילה', 'בטלו נעילה']) {
      const result = mapMissionSentence(text);
      expect(result.replyHe).toBe('אין נעילה פעילה.');
      expect(result.sends).toBe(false);
      expect(modes(result)).toEqual(['UNLOCK']);
      const intent = resolveAssistIntent(text);
      expect(intent.prohibited).not.toBe(true);
      expect(intent.blocked).not.toBe(true);
      expect(deterministicIsFastPath(intent)).toBe(true);
    }
    const held = mapMissionSentence('שחררו נעילה', { lock: { id: 2 } });
    expect(held.replyHe).toBe('שחרור הנעילה בתוכנית.');
    expect(held.replyHe).not.toContain('לא נשלח דבר');
    expect(held.sends).toBe(false);
  });

  it('states detection from the given state and does not invent a count', () => {
    expect(mapMissionSentence('מה אתה מזהה').replyHe).toBe('אין נתון על זרם המצלמות.');
    expect(mapMissionSentence('כמה אנשים אתה רואה', { enabled: false }).replyHe).toBe('הזיהוי כבוי.');
    expect(mapMissionSentence('מה אתה מזהה', { enabled: true, model: false }).replyHe).toBe('אין מודל זיהוי.');
    expect(mapMissionSentence('כמה אנשים אתה רואה', { enabled: true, stream: false }).replyHe).toBe('אין נתון על זרם המצלמות.');
    const live = {
      enabled: true,
      stream: true,
      model: true,
      tracks: [
        { id: 1, class: 'person', label_he: 'אדם' },
        { id: 2, class: 'car', label_he: 'רכב' },
      ],
    };
    expect(mapMissionSentence('מה אתה מזהה', live).replyHe).toBe('מזהים אדם אחד ורכב אחד.');
    expect(mapMissionSentence('מה אתה מזהה', live).replyHe).not.toMatch(/אדום|ירוק|כחול/);
    expect(mapMissionSentence('כמה אנשים אתה רואה', live).replyHe).toBe('רואים אדם אחד.');
    expect(mapMissionSentence('כמה אנשים אתה רואה', { ...live, tracks: [] }).replyHe).toBe('אין אנשים בזיהוי.');
    const colored = {
      ...live,
      tracks: [
        { id: 1, class: 'person', label_he: 'אדם', color_he: 'אדום' },
        { id: 4, class: 'person', label_he: 'אדם', color_he: 'אדום' },
        { id: 2, class: 'car', label_he: 'רכב', color_he: 'ירוק' },
      ],
    };
    expect(mapMissionSentence('מה אתה מזהה', {
      ...live,
      tracks: [
        { id: 1, class: 'person', label_he: 'אדם' },
        { id: 5, class: 'person', label_he: 'אדם' },
        { id: 2, class: 'car', label_he: 'רכב' },
      ],
    }).replyHe).toBe('מזהים שני אנשים ורכב אחד.');
    expect(mapMissionSentence('מה אתה מזהה', colored).replyHe).toBe('מזהים שני אנשים אדומים ורכב ירוק אחד.');
    const split = {
      ...live,
      tracks: [
        { id: 1, class: 'person', label_he: 'אדם', color_he: 'אדום' },
        { id: 4, class: 'person', label_he: 'אדם', color_he: 'ירוק' },
      ],
    };
    expect(mapMissionSentence('מה אתה מזהה', split).replyHe).toBe('מזהים אדם אדום אחד ואדם ירוק אחד.');
    expect(mapMissionSentence('מה אתה מזהה', {
      ...live,
      tracks: [{ id: 9, class: 'truck', label_he: 'משאית', color_he: 'כחול' }],
    }).replyHe).toBe('מזהים משאית כחולה אחת.');
  });

  it('refuses cruise beside a release and still sends a bare cruise phrase', () => {
    const bare = mapMissionSentence('שחררו נעילה ותעבור לשיוט');
    expect(modes(bare)).toEqual(['UNLOCK']);
    expect(bare.plan.refused).toEqual(['CRUISE']);
    expect(bare.replyHe).toBe('אין נעילה פעילה. מעבר לשיוט נחסם. לא נשלח דבר.');
    expect(bare.sends).toBe(false);
    const held = mapMissionSentence('שחררו נעילה ותעבור לשיוט', { lock: { id: 2 } });
    expect(held.replyHe).toBe('שחרור הנעילה בתוכנית. מעבר לשיוט נחסם. לא נשלח דבר.');
    expect(held.plan.refused).toEqual(['CRUISE']);
    expect(held.sends).toBe(false);
    expect(mapMissionSentence('שיוט')).toBeNull();
  });

  it('counts any detected kind and spells the detection sentence', () => {
    const live = {
      enabled: true,
      stream: true,
      model: true,
      tracks: [
        { id: 1, class: 'person', label_he: 'אדם' },
        { id: 2, class: 'person', label_he: 'אדם' },
        { id: 3, class: 'car', label_he: 'רכב', color_he: 'לבן' },
        { id: 4, class: 'dog', label_he: 'כלב' },
      ],
    };
    expect(mapMissionSentence('מה אתה מזהה', live).replyHe).toBe('מזהים שני אנשים, רכב לבן אחד וכלב אחד.');
    expect(mapMissionSentence('כמה מכוניות יש', live).replyHe).toBe('רואים רכב אחד.');
    expect(mapMissionSentence('כמה רכבים יש', live).replyHe).toBe('רואים רכב אחד.');
    expect(mapMissionSentence('כמה כלבים יש', live).replyHe).toBe('רואים כלב אחד.');
    expect(mapMissionSentence('כמה כלבים יש', { ...live, tracks: live.tracks.filter((row) => row.class !== 'dog') }).replyHe).toBe('אין כלבים בזיהוי.');
    expect(mapMissionSentence('כמה מכוניות יש', { enabled: true, stream: true, model: true, tracks: [
      { id: 8, class: 'car', label_he: 'רכב' },
      { id: 9, class: 'car', label_he: 'רכב' },
    ] }).replyHe).toBe('רואים שני רכבים.');
    expect(mapMissionSentence('כמה כלבים יש', { enabled: false }).replyHe).toBe('הזיהוי כבוי.');
  });

  it('keeps the color and the follow on a lock plan', () => {
    const result = mapMissionSentence('נעלו על הרכב הלבן ועקבו אחריו');
    expect(modes(result)).toEqual(['LOCK', 'FOLLOW']);
    expect(result.plan.steps[0].target).toEqual({ color: 'לבן', object: 'מכונית' });
    expect(result.replyHe).toBe('נעילה ומעקב אחרי הרכב הלבן נוספו לתוכנית.');
    expect(result.replyHe).not.toContain('לא נשלח דבר');
    expect(result.sends).toBe(false);
  });

  it('keeps the lock plan and refuses the return-home clause', () => {
    const result = mapMissionSentence('נעל על האדם ותחזור הבית');
    expect(modes(result)).toEqual(['LOCK']);
    expect(result.plan.steps[0].target).toEqual({ object: 'אדם' });
    expect(result.plan.refused).toEqual(['RTL']);
    expect(result.replyHe).toBe('נעילה על האדם נוספה לתוכנית. חזרה הביתה נחסמה. לא נשלח דבר.');
    expect(result.sends).toBe(false);
    expect(result.replyHe).not.toMatch(/\d/);
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
    ['תסרוק', 'סורקים'],
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

  it('answers camera status questions instead of rejecting them', async () => {
    const calls = [];
    const live = {
      ops_signals: { cameras: { cam0: true, cam1: false } },
    };
    const questions = ['מה מצב המצלמות', 'האם יש וידאו', 'מה קורה עם המצלמות עכשיו'];
    for (const text of questions) {
      const result = await runVoiceFlightTranscript({
        text,
        goActive: true,
        operatorConfirmed: true,
        statusContext: live,
        applyFlightOp: async (args) => {
          calls.push(args);
          return { ok: true, sent: true };
        },
      });
      expect(result.sent).toBe(false);
      expect(result.decision).toBe('camera_status');
      expect(result.talkback.text).toBe('קדמית משדרת. מטה אינה משדרת. אין נתון על הגימבל.');
      expect(result.talkback.text).not.toContain('אינה ברשימה המותרת');
      expect(result.talkback.text).not.toContain('אתם במרחב');
    }
    const empty = await runVoiceFlightTranscript({ text: 'מה מצב המצלמות' });
    expect(empty.sent).toBe(false);
    expect(empty.talkback.text).toBe('אין נתון על זרם המצלמות.');
    expect(calls).toEqual([]);

    const remote = {
      connected: true,
      type: 'tcp',
      host: '10.1.1.1',
      simulator: true,
      simulatorDetection() {
        return { simulator: true, reason: 'preset' };
      },
    };
    const rtl = await runVoiceFlightTranscript({
      text: 'תחזור הביתה',
      goActive: true,
      operatorConfirmed: true,
      mavConn: remote,
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true };
      },
    });
    expect(rtl.sent).toBe(false);
    expect(rtl.decision).toBe('not_simulator');
    expect(rtl.kind).toBe('RTL');

    const negated = await runVoiceFlightTranscript({
      text: 'אל תחזור הביתה',
      goActive: true,
      operatorConfirmed: true,
      mavConn: remote,
      requestedMode: 'RTL',
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true };
      },
    });
    expect(negated.sent).toBe(false);
    expect(negated.kind).not.toBe('RTL');
    expect(negated.decision).not.toBe('sent');

    const arm = await runVoiceFlightTranscript({
      text: 'חמש',
      goActive: true,
      operatorConfirmed: true,
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true };
      },
    });
    expect(arm.sent).toBe(false);
    expect(arm.decision).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('keeps a lock plan beside a refused return home and does not send', async () => {
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
    const assist = service(async (args) => {
      calls.push(args);
      return { ok: true, sent: true };
    });
    await assist.processInput({ text: 'יאללה', context_snapshot: { current_workspace: 'MISSION' } });
    const asked = await assist.processInput({
      text: 'נעל על האדם ותחזור הבית',
      context_snapshot: { current_workspace: 'MISSION' },
    });
    expect(asked.sent).toBe(false);
    expect(asked.plan.modes).toEqual(['LOCK']);
    expect(asked.plan.refused).toEqual(['RTL']);
    expect(asked.answer).toContain('נעילה על האדם נוספה לתוכנית');
    expect(asked.answer).toContain('חזרה הביתה נחסמה');
    expect(asked.answer).toContain('לא נשלח דבר');

    const voiced = await runVoiceFlightTranscript({
      text: 'נעל על האדם ותחזור הבית',
      goActive: true,
      operatorConfirmed: true,
      mavConn: mav,
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true };
      },
    });
    expect(voiced.sent).toBe(false);
    expect(voiced.decision).toBe('mission_plan');
    expect(voiced.plan.modes).toEqual(['LOCK']);
    expect(voiced.plan.refused).toEqual(['RTL']);
    expect(voiced.talkback.text).toContain('לא נשלח דבר');

    const released = await assist.processInput({
      text: 'בטלו נעילה',
      context_snapshot: { current_workspace: 'MISSION' },
    });
    expect(released.sent).toBe(false);
    expect(released.blocked).not.toBe(true);
    expect(released.answer).toBe('אין נעילה פעילה.');

    const off = await assist.processInput({
      text: 'מה אתה מזהה',
      context_snapshot: { current_workspace: 'MISSION', vision: { enabled: false } },
    });
    expect(off.answer).toBe('הזיהוי כבוי.');
    expect(off.sent).toBe(false);

    const people = await assist.processInput({
      text: 'כמה אנשים אתה רואה',
      context_snapshot: {
        current_workspace: 'MISSION',
        vision: {
          enabled: true,
          stream: true,
          model: true,
          tracks: [{ id: 4, class: 'person', label_he: 'אדם' }],
        },
      },
    });
    expect(people.answer).toBe('רואים אדם אחד.');
    expect(people.sent).toBe(false);
    expect(calls).toEqual([]);
  });
});
