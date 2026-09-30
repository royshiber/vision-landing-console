import { afterEach, describe, expect, it } from 'vitest';
import {
  mockGeminiRawIntent,
  resolveVoiceFlightIntent,
  runVoiceFlightTranscript,
  voiceFlightLinkAllowsSend,
} from '../lib/voice-flight-pipeline.mjs';
import { sanitizeLlmIntent } from '../lib/assist/ask-llm-intent.mjs';

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
    expect(result.talkback.provider).toBe('mock');
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
    expect(fbwa.resolver).toBe('mode');
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
    expect(stable.resolver).toBe('mock-gemini');
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
});
