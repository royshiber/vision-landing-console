import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/assist/ask-llm-intent.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    classifyAskIntentWithGemini: vi.fn(async () => {
      throw new Error('gemini should not classify a local flight phrase');
    }),
  };
});

import {
  VOICE_SEND_MODES,
  matchVoiceFlightPhrase,
  mockGeminiRawIntent,
  resolveVoiceFlightIntent,
  runVoiceFlightTranscript,
  voiceFlightLinkAllowsSend,
} from '../lib/voice-flight-pipeline.mjs';
import { sanitizeLlmIntent } from '../lib/assist/ask-llm-intent.mjs';

const pipelineSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/voice-flight-pipeline.mjs'),
  'utf8',
);

const saved = {
  gemini: process.env.GEMINI_API_KEY,
  eleven: process.env.ELEVENLABS_API_KEY,
};

afterEach(() => {
  if (saved.gemini == null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved.gemini;
  if (saved.eleven == null) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = saved.eleven;
});

function simTcp() {
  return {
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
}

describe('voice flight transcript pipeline', () => {
  it('mocks Gemini and ElevenLabs when keys are absent', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const raw = mockGeminiRawIntent('עבור למצב RTL');
    expect(sanitizeLlmIntent(raw)?.slots?.kind).toBe('RTL');
    const resolved = await resolveVoiceFlightIntent('עבור למצב RTL');
    expect(resolved.resolver).toBe('mock-gemini');
    expect(resolved.intent?.slots?.kind).toBe('RTL');
  });

  it('sends RTL only on a local simulator after GO', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const mav = simTcp();
    const calls = [];
    const result = await runVoiceFlightTranscript({
      text: 'עבור למצב RTL',
      goActive: true,
      mavConn: mav,
      applyFlightOp: async (args) => {
        calls.push(args);
        mav.lastCustomMode = 11;
        return { ok: true, sent: true, customMode: 11, kind: 'RTL' };
      },
    });
    expect(calls).toEqual([{ kind: 'RTL', mode: null, reason: 'עבור למצב RTL' }]);
    expect(result.sent).toBe(true);
    expect(result.customMode).toBe(11);
    expect(result.talkback.provider).toBe('client');
    expect(result.talkback.spoken).toBe(false);
    expect(result.talkback.text).toContain('אושר');
    expect(result.talkback.text).toContain('RTL');
  });

  it('refuses ARM and does not call the flight op', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    let called = false;
    const result = await runVoiceFlightTranscript({
      text: 'חמש את המטוס',
      goActive: true,
      mavConn: simTcp(),
      applyFlightOp: async () => {
        called = true;
        return { ok: true, sent: true };
      },
    });
    expect(called).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe('ARM');
    expect(result.talkback.text).toContain('נדחה');
    expect(result.talkback.text).toContain('לא נשלח דבר');
  });

  it('refuses a phrase outside the allowlist', async () => {
    delete process.env.GEMINI_API_KEY;
    const result = await runVoiceFlightTranscript({
      text: 'תעיף את המטוס לחלל',
      goActive: true,
      mavConn: simTcp(),
      applyFlightOp: async () => ({ ok: true, sent: true }),
    });
    expect(result.sent).toBe(false);
    expect(result.decision).toBe('not_allowlisted');
    expect(result.talkback.text).toContain('אינה ברשימה המותרת');
  });

  it('does not send on a non-loopback link even if a simulator flag is set', async () => {
    const mav = {
      connected: true,
      type: 'tcp',
      host: '10.1.1.1',
      simulator: true,
      simulatorDetection() {
        return { simulator: true, reason: 'preset' };
      },
    };
    expect(voiceFlightLinkAllowsSend(mav)).toBe(false);
    let called = false;
    const result = await runVoiceFlightTranscript({
      text: 'עבור למצב RTL',
      goActive: true,
      mavConn: mav,
      applyFlightOp: async () => {
        called = true;
        return { ok: true, sent: true, customMode: 11 };
      },
    });
    expect(called).toBe(false);
    expect(result.decision).toBe('not_simulator');
    expect(result.talkback.text).toContain('אינו סימולטור מקומי');
  });

  it('sends LOITER from a confirmed dock button while voice GO is off', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const mav = simTcp();
    const calls = [];
    const result = await runVoiceFlightTranscript({
      text: 'עבור למצב loiter',
      goActive: false,
      operatorConfirmed: true,
      mavConn: mav,
      applyFlightOp: async (args) => {
        calls.push(args);
        mav.lastCustomMode = 12;
        return { ok: true, sent: true, customMode: 12, kind: 'MODE_CHANGE' };
      },
    });
    expect(calls[0].kind).toBe('MODE_CHANGE');
    expect(calls[0].mode).toBe('LOITER');
    expect(result.sent).toBe(true);
    expect(result.decision).toBe('sent');
    expect(result.talkback.text).not.toContain('שיחת הקול סגורה');
  });

  it('sends a dock mode by name and keeps ACRO off the list', async () => {
    delete process.env.GEMINI_API_KEY;
    const calls = [];
    const fbwa = await runVoiceFlightTranscript({
      text: 'עבור למצב FBWA',
      requestedMode: 'FBWA',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true, customMode: 5, kind: 'MODE_CHANGE' };
      },
    });
    expect(calls).toEqual([{ kind: 'MODE_CHANGE', mode: 'FBWA', reason: 'עבור למצב FBWA' }]);
    expect(fbwa.sent).toBe(true);
    expect(fbwa.resolver).toBe('sentence');
    const takeoff = await runVoiceFlightTranscript({
      text: 'עבור למצב TAKEOFF',
      requestedMode: 'TAKEOFF',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true, customMode: 13 };
      },
    });
    expect(takeoff.sent).toBe(true);
    expect(calls.at(-1).mode).toBe('TAKEOFF');
    let armed = false;
    const acro = await runVoiceFlightTranscript({
      text: 'עבור למצב ACRO',
      requestedMode: 'ACRO',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => {
        armed = true;
        return { ok: true, sent: true };
      },
    });
    expect(armed).toBe(false);
    expect(acro.sent).toBe(false);
    expect(acro.talkback.text).toContain('אינו ברשימה');
    const refused = await runVoiceFlightTranscript({
      text: 'עבור למצב FBWB',
      requestedMode: 'FBWB',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => ({ ok: false, sent: false, note: 'הבקר סירב למצב. לא נשלח דבר.' }),
    });
    expect(refused.sent).toBe(false);
    expect(refused.talkback.text).toContain('הבקר סירב');
  });

  it('maps stable and takeoff phrases and does not arm', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'present-but-unused';
    const calls = [];
    const stable = await runVoiceFlightTranscript({
      text: 'עבור למצב יציב',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true, customMode: 2 };
      },
    });
    expect(stable.resolver).toBe('sentence');
    expect(calls[0]).toMatchObject({ kind: 'MODE_CHANGE', mode: 'STABILIZE' });
    const takeoff = await runVoiceFlightTranscript({
      text: 'תמריא',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true, customMode: 13 };
      },
    });
    expect(takeoff.sent).toBe(true);
    expect(calls.at(-1).mode).toBe('TAKEOFF');
    let called = false;
    const arm = await runVoiceFlightTranscript({
      text: 'חמש',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => {
        called = true;
        return { ok: true, sent: true };
      },
    });
    expect(called).toBe(false);
    expect(arm.blocked).toBe(true);
    expect(arm.talkback.text).toContain('לא נשלח דבר');
    delete process.env.GEMINI_API_KEY;
  });

  it('does not send before GO', async () => {
    let called = false;
    const result = await runVoiceFlightTranscript({
      text: 'עבור למצב RTL',
      goActive: false,
      mavConn: simTcp(),
      applyFlightOp: async () => {
        called = true;
        return { ok: true, sent: true };
      },
    });
    expect(called).toBe(false);
    expect(result.decision).toBe('no_go');
  });

  it('returns talkback text and does not drain ElevenLabs', async () => {
    process.env.ELEVENLABS_API_KEY = 'present-but-unused';
    process.env.GEMINI_API_KEY = 'present-but-unused';
    expect(pipelineSrc).not.toContain('streamTts');
    expect(pipelineSrc).not.toContain('for await');
    expect(pipelineSrc).not.toContain('classifyAskIntentWithGemini');
    const result = await runVoiceFlightTranscript({
      text: 'שיוט',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => ({ ok: true, sent: true, customMode: 7 }),
    });
    expect(result.sent).toBe(true);
    expect(result.resolver).toBe('sentence');
    expect(result.talkback.provider).toBe('client');
    expect(result.talkback.spoken).toBe(false);
    expect(result.talkback.text).toContain('CRUISE');
    expect(result.talkback.text).toContain('אושר');
  });

  it('resolves natural allowlist phrases locally and keeps arm blocked', async () => {
    process.env.GEMINI_API_KEY = 'present-but-unused';
    const phrases = [
      ['עבור למצב יציב', 'STABILIZE'],
      ['מצב ידני', 'MANUAL'],
      ['שיוט', 'CRUISE'],
      ['חזרה הביתה', 'RTL'],
      ['תמריא', 'TAKEOFF'],
      ['stabilize', 'STABILIZE'],
      ['manual', 'MANUAL'],
      ['rtl', 'RTL'],
    ];
    for (const [text, mode] of phrases) {
      const match = matchVoiceFlightPhrase(text);
      expect(match?.sendable, text).toBe(true);
      expect(match?.mode, text).toBe(mode);
      const resolved = await resolveVoiceFlightIntent(text);
      expect(resolved.resolver, text).toBe('mock-gemini');
      const calls = [];
      const result = await runVoiceFlightTranscript({
        text,
        operatorConfirmed: true,
        mavConn: simTcp(),
        applyFlightOp: async (args) => {
          calls.push(args);
          return { ok: true, sent: true, customMode: 1 };
        },
      });
      expect(result.sent, text).toBe(true);
      expect(result.talkback.spoken, text).toBe(false);
      expect(calls[0].mode, text).toBe(mode === 'RTL' ? null : mode);
      expect(calls[0].kind, text).toBe(mode === 'RTL' ? 'RTL' : 'MODE_CHANGE');
    }
    for (const text of ['חמש', 'חימוש', 'נטרול', 'arm', 'disarm']) {
      let called = false;
      const blocked = await runVoiceFlightTranscript({
        text,
        operatorConfirmed: true,
        mavConn: simTcp(),
        applyFlightOp: async () => {
          called = true;
          return { ok: true, sent: true };
        },
      });
      expect(called, text).toBe(false);
      expect(blocked.blocked, text).toBe(true);
      expect(blocked.talkback.text, text).toContain('חימוש ונטרול חסומים');
      expect(blocked.talkback.text, text).toContain('לא נשלח דבר');
    }
    const acro = await runVoiceFlightTranscript({
      text: 'acro',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => ({ ok: true, sent: true }),
    });
    expect(acro.sent).toBe(false);
    expect(acro.talkback.text).toContain('אינו ברשימה');
    delete process.env.GEMINI_API_KEY;
    const unknown = await runVoiceFlightTranscript({
      text: 'תעיף את המטוס לחלל',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => ({ ok: true, sent: true }),
    });
    expect(unknown.decision).toBe('not_allowlisted');
    expect(unknown.talkback.text).toContain('אינה ברשימה המותרת');
    for (const mode of ['AUTOTUNE', 'QSTABILIZE', 'QHOVER', 'QLOITER', 'QRTL', 'ACRO']) {
      expect(VOICE_SEND_MODES.has(mode), mode).toBe(false);
    }
    delete process.env.GEMINI_API_KEY;
  });

  it('refuses negation and a stale mode, and ignores mode words inside a sentence', async () => {
    delete process.env.GEMINI_API_KEY;
    const noSend = async (text, requestedMode) => {
      let called = false;
      const result = await runVoiceFlightTranscript({
        text,
        requestedMode,
        operatorConfirmed: true,
        mavConn: simTcp(),
        applyFlightOp: async () => {
          called = true;
          return { ok: true, sent: true, customMode: 11 };
        },
      });
      expect(called, text).toBe(false);
      expect(result.sent, text).toBe(false);
      expect(result.talkback.text, text).toContain('לא נשלח דבר');
      expect(result.talkback.text, text).not.toContain('אושר');
      return result;
    };

    const negated = await noSend('אל תחזור הביתה', 'RTL');
    expect(negated.decision).toBe('not_allowlisted');
    expect(matchVoiceFlightPhrase('אל תחזור הביתה')?.negated).toBe(true);
    await noSend('שיוט', 'RTL');
    await noSend('עבור למצב ACRO', 'STABILIZE');
    await noSend('autotune', 'AUTOTUNE');
    await noSend('qhover', 'QHOVER');
    await noSend('set the cruise altitude', 'CRUISE');
    await noSend('ready for takeoff', 'TAKEOFF');
    await noSend('then rtl later', 'RTL');
    await noSend('עבור למצב שיוט עכשיו', 'CRUISE');

    const minutes = await noSend('חמש דקות', 'ARM');
    expect(minutes.blocked).toBe(false);
    expect(minutes.talkback.text).not.toContain('חימוש ונטרול חסומים');
    expect(minutes.talkback.text).toContain('אינה ברשימה המותרת');

    let armed = false;
    const arm = await runVoiceFlightTranscript({
      text: 'חמש',
      requestedMode: 'CRUISE',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async () => {
        armed = true;
        return { ok: true, sent: true };
      },
    });
    expect(armed).toBe(false);
    expect(arm.blocked).toBe(true);
    expect(arm.talkback.text).toContain('חימוש ונטרול חסומים');

    const calls = [];
    const agreed = await runVoiceFlightTranscript({
      text: 'שיוט',
      requestedMode: 'CRUISE',
      operatorConfirmed: true,
      mavConn: simTcp(),
      applyFlightOp: async (args) => {
        calls.push(args);
        return { ok: true, sent: true, customMode: 7 };
      },
    });
    expect(agreed.sent).toBe(true);
    expect(calls[0]).toMatchObject({ kind: 'MODE_CHANGE', mode: 'CRUISE' });
    expect(matchVoiceFlightPhrase('פתח יועץ')).toBeNull();
    expect(matchVoiceFlightPhrase('מה הגובה')).toBeNull();
    expect(matchVoiceFlightPhrase('שלום')).toBeNull();
  });
});
