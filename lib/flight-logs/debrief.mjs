/**
 * Grounded Gemini debrief for one cloud flight.
 * The model may only use fact-sheet IDs. The validator marks the rest לא אומת.
 */
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { getGeminiModelChain } from '../gemini-model.mjs';
import { throttleGemini } from '../gemini-throttle.mjs';
import { buildFactSheet } from './fact-sheet.mjs';
import { validateDebrief } from './debrief-validate.mjs';
import { listEvents, openFlightBundle } from './sync.mjs';
import { formatTPlus } from './time.mjs';

export const PROMPT_VERSION = 'flight-debrief/1';

export const NO_GEMINI_KEY_HE = 'אין מפתח Gemini. מוצגות תובנות אוטומטיות בלבד.';

export const PARTIAL_BANNER_HE = 'חלק מהמשפטים לא אומתו מול עובדות הטיסה.';

export const DEBRIEF_SYSTEM_PROMPT = [
  'You write a Hebrew post-flight debrief for one aircraft flight.',
  'Use ONLY IDs that appear in the fact sheet. Never invent an ID.',
  'Every sentence that contains a number, a time, a mode name, or an event must cite at least 1 ID from the sheet.',
  'Never invent values or parameters. If data is missing, write "אין נתונים" and add that gap to unknowns_he.',
  'Advice only: never offer to apply, arm, disarm, change parameters, or send commands.',
  'Explain why using cause_id and insights, then what to do next.',
  'Output Hebrew. Keep mode names and T+ times as written in the sheet.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    verdict: { type: SchemaType.STRING, format: 'enum', enum: ['ok', 'attention', 'problem'] },
    summary_he: { type: SchemaType.STRING },
    what_happened: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text_he: { type: SchemaType.STRING },
          cite: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ['text_he', 'cite'],
      },
    },
    why: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text_he: { type: SchemaType.STRING },
          cite: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ['text_he', 'cite'],
      },
    },
    what_to_do: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text_he: { type: SchemaType.STRING },
          cite: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          confidence: { type: SchemaType.STRING, format: 'enum', enum: ['high', 'medium', 'low'] },
        },
        required: ['text_he', 'cite', 'confidence'],
      },
    },
    unknowns_he: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['verdict', 'summary_he', 'what_happened', 'why', 'what_to_do', 'unknowns_he'],
};

function parseModelJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(raw);
}

export async function callGeminiDebrief({ system, user }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('no gemini key');
    err.code = 'NO_KEY';
    throw err;
  }
  const chain = getGeminiModelChain();
  let lastErr = null;
  for (const modelName of chain) {
    await throttleGemini();
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: system,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      });
      const result = await model.generateContent(user);
      return { model: modelName, json: parseModelJson(result.response.text()) };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (/404|503|not found|unavailable|overload/i.test(msg)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('gemini unavailable');
}

function userPrompt(sheet, errors) {
  const lines = [JSON.stringify(sheet)];
  if (errors?.length) {
    lines.push('The previous draft failed validation. Fix only these errors. Do not add new numbers:');
    lines.push(errors.slice(0, 40).join('\n'));
  }
  return lines.join('\n\n');
}

function notesForFlight(db, flightRow) {
  if (!flightRow?.id) return [];
  return db.prepare(`SELECT body, created_at FROM flight_notes WHERE flight_id = ? ORDER BY id`).all(flightRow.id);
}

function chipsFor(sheet, cite) {
  const byId = new Map([
    ...(sheet.facts || []).map((f) => [f.id, f]),
    ...(sheet.insights || []).map((f) => [f.id, f]),
    ...(sheet.events || []).map((f) => [f.id, f]),
  ]);
  return (cite || []).map((id) => {
    const item = byId.get(id);
    const t = item?.t_rel_s ?? item?.from_rel_s ?? null;
    return {
      id,
      t_rel_s: t,
      label: t == null ? id : formatTPlus(t),
    };
  });
}

function decorateOutput(sheet, output) {
  const copy = { ...output };
  for (const key of ['what_happened', 'why', 'what_to_do']) {
    copy[key] = (output[key] || []).map((row) => ({ ...row, chips: chipsFor(sheet, row.cite) }));
  }
  return copy;
}

function rowToPublic(row, sheet) {
  const output = JSON.parse(row.output_json);
  const validation = JSON.parse(row.validation_json || '{}');
  return {
    ok: true,
    available: true,
    cached: true,
    status: row.status,
    model: row.model,
    created_at: row.created_at,
    prompt_version: row.prompt_version,
    input_digest: row.input_digest,
    debrief: decorateOutput(sheet, output),
    bannerHe: row.status === 'partial' ? PARTIAL_BANNER_HE : null,
    insights: sheet.insights || [],
    validation,
  };
}

function goodDraft(sheet) {
  const fact = (sheet.facts || []).find((row) => typeof row.value === 'number') || null;
  const event = (sheet.events || []).find((row) => row.sev === 'error')
    || (sheet.events || []).find((row) => row.sev === 'warning')
    || (sheet.events || [])[0];
  const insight = (sheet.insights || [])[0];
  const cite = insight ? [insight.id] : (event ? [event.id] : []);
  return {
    verdict: event?.sev === 'error' ? 'problem' : (event ? 'attention' : 'ok'),
    summary_he: fact ? `הגובה המרבי היה ${fact.value} מטר.` : 'אין נתונים',
    what_happened: event ? [{
      text_he: `האירוע סומן ב־${formatTPlus(event.t_rel_s)}.`,
      cite: [event.id],
    }] : [],
    why: insight ? [{ text_he: 'הסיבה מתועדת בתובנה של הטיסה.', cite: [insight.id] }] : [],
    what_to_do: [{
      text_he: 'לבדוק את הקישור לפני הטיסה הבאה.',
      cite,
      confidence: 'medium',
    }],
    unknowns_he: [],
  };
}

function badSentence() {
  return { text_he: 'הגובה היה 99999 מטר במצב COPTER.', cite: ['NO_SUCH'] };
}

function mockDraft(sheet, priorErrors, mode) {
  if (mode === 'ok') return goodDraft(sheet);
  const bad = badSentence();
  if (!priorErrors) {
    return {
      verdict: 'ok',
      summary_he: 'הכל תקין ללא מספר.',
      what_happened: [bad, bad, bad],
      why: [bad],
      what_to_do: [{ ...bad, confidence: 'high' }],
      unknowns_he: [],
    };
  }
  const good = goodDraft(sheet);
  return {
    ...good,
    what_happened: [...(good.what_happened || []), bad, bad],
    why: [bad],
  };
}

function activeMock() {
  if (process.env.FLIGHT_LOGS_MODE !== 'mock') return '';
  const mock = String(process.env.FLIGHT_DEBRIEF_MOCK || '');
  return mock === 'ok' || mock === 'partial' || mock === 'nokey' ? mock : '';
}

async function produceDraft(sheet, errors, generate) {
  const mock = activeMock();
  if (!generate && (mock === 'ok' || mock === 'partial')) {
    return { model: `mock-${mock}`, json: mockDraft(sheet, errors, mock) };
  }
  if (generate) {
    const json = await generate(sheet, errors);
    return { model: 'mock', json };
  }
  const result = await callGeminiDebrief({
    system: DEBRIEF_SYSTEM_PROMPT,
    user: userPrompt(sheet, errors),
  });
  return result;
}

export async function getFlightDebrief(ctx, uid, { force = false, generate = null } = {}) {
  const mock = activeMock();
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (mock === 'nokey' || (!key && !generate && mock !== 'ok' && mock !== 'partial')) {
    const bundle = await openFlightBundle(ctx, uid).catch(() => null);
    return {
      ok: true,
      available: false,
      messageHe: NO_GEMINI_KEY_HE,
      insights: bundle?.summary?.insights || [],
      debrief: null,
    };
  }
  const bundle = await openFlightBundle(ctx, uid);
  if (!bundle) return null;
  const events = listEvents(ctx, uid, {});
  const sheet = buildFactSheet({
    flightId: uid,
    summary: bundle.summary,
    events,
    manifest: bundle.manifest,
    notes: notesForFlight(ctx.db, bundle.flight),
  });
  if (!force) {
    const cached = ctx.db.prepare(`
      SELECT * FROM flight_debriefs
      WHERE flight_uid = ? AND input_digest = ? AND prompt_version = ?
      ORDER BY id DESC LIMIT 1
    `).get(uid, sheet.digest, PROMPT_VERSION);
    if (cached) return { ...rowToPublic(cached, sheet), cached: true };
  }

  let produced = await produceDraft(sheet, null, generate);
  let validation = validateDebrief(produced.json, sheet);
  if (validation.failureRatio > 0.2) {
    produced = await produceDraft(sheet, validation.errors, generate);
    validation = validateDebrief(produced.json, sheet);
  }
  const status = validation.failureRatio > 0.2 ? 'partial' : 'ok';
  const info = ctx.db.prepare(`
    INSERT INTO flight_debriefs (
      flight_uid, model, prompt_version, input_digest, output_json, validation_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uid,
    produced.model,
    PROMPT_VERSION,
    sheet.digest,
    JSON.stringify(validation.output),
    JSON.stringify({ errors: validation.errors, failureRatio: validation.failureRatio, unverifiedCount: validation.unverifiedCount }),
    status,
  );
  const row = ctx.db.prepare('SELECT * FROM flight_debriefs WHERE id = ?').get(info.lastInsertRowid);
  return { ...rowToPublic(row, sheet), cached: false };
}
