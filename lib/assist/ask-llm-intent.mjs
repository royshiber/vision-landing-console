/**
 * Free-form Ask intent classification.
 * Gemini (when GEMINI_API_KEY is set) maps natural Hebrew/English to the
 * same gated intents as the deterministic regex path.
 * Never invents telemetry. Never unlocks ARM / DISARM / nav-source.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiModelChain } from '../gemini-model.mjs';
import { resolveAssistIntent } from './assist-intent-resolver.mjs';
import { isAskBlockedParamKey, isAskSessionFlightOpKind } from './ask-safety.mjs';
import { ASSIST_PROHIBITED_ACTIONS } from './assist-types.mjs';
import { ARDUPILOT_PLANE_MODES } from '../arduplane-flight-modes.mjs';

const BLOCKED_KINDS = Object.freeze([
  'ARM',
  'DISARM',
  'NAV_SOURCE_SWITCH',
  'DEPLOY',
  'RESTART_SERVICE',
  'ROLLBACK',
  'SHELL',
  'CURSOR_AGENT_START',
  'FC_COMMAND',
]);

const QUESTION_TOPICS = Object.freeze([
  'altitude',
  'speed',
  'climb',
  'distance',
  'mode',
  'battery',
  'gps',
  'link',
  'seeing',
  'param_get',
  'vision',
  'evolve',
  'context',
  'general',
]);

const CLASSIFY_SYSTEM = [
  'Classify AIRVIX Ask operator speech into one structured JSON intent.',
  'The operator may speak freely in Hebrew or English, simple or complex.',
  'Do not invent telemetry numbers, coordinates, or param values the operator did not say.',
  'Do not unlock safety gates.',
  '',
  'intent must be one of: FLIGHT_OP, FLIGHT_PARAM, QUESTION, BLOCKED, UI_ACTION, NOTE, OBSERVATION, DEVELOPMENT, UNRESOLVED.',
  '',
  'FLIGHT_OP kinds allowed: LAND, RTL, MODE_CHANGE.',
  'ARM, DISARM, חימוש, נטרול, motors on/off, spin up motors → BLOCKED with blocked_kind ARM or DISARM.',
  'EKF / nav source / optical inject / GPS_TYPE / EK3_ → BLOCKED NAV_SOURCE_SWITCH.',
  'deploy / restart service / shell → BLOCKED with matching blocked_kind.',
  'Landing-confidence questions are QUESTION, not LAND.',
  '',
  'FLIGHT_PARAM only when the operator names an ArduPilot param key and a numeric value to set.',
  'QUESTION topics: altitude, speed, climb, distance, mode, battery, gps, link, seeing, param_get, vision, evolve, context, general.',
  '',
  'JSON shape:',
  '{"intent":"...","blocked_kind":null,"kind":null,"mode":null,"key":null,"value":null,"topic":null,"confidence":0.0}',
].join('\n');

function blockedResult(kind, extraSlots = {}) {
  return {
    blocked: true,
    prohibited: true,
    prohibited_action: kind,
    blocked_kind: kind,
    intent: 'UNRESOLVED',
    confidence: 1,
    reason: `blocked early-flight action: ${kind}`,
    slots: extraSlots,
    resolver: 'llm',
  };
}

function flightOpResult(kind, slots = {}) {
  return {
    blocked: false,
    intent: 'FLIGHT_OP',
    confidence: 0.9,
    slots: { action: 'SEND_FLIGHT_OP', kind, ...slots },
    resolver: 'llm',
  };
}

function normalizeParamKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(key)) return '';
  return key;
}

const KNOWN_MODE_NAMES = new Set(Object.values(ARDUPILOT_PLANE_MODES).map((n) => String(n).toUpperCase()));

function normalizeMode(raw) {
  const mode = String(raw || '').trim().toUpperCase();
  if (!mode) return null;
  if (KNOWN_MODE_NAMES.has(mode)) return mode;
  if (/^[A-Z][A-Z0-9]{1,15}$/.test(mode)) return mode;
  return null;
}

/**
 * Validate LLM JSON into the same shape as resolveAskFlightIntent / resolveAssistIntent.
 * ARM / DISARM / nav-source never become applyable flight ops.
 */
export function sanitizeLlmIntent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = String(raw.intent || '').trim().toUpperCase();
  const blockedKind = String(raw.blocked_kind || raw.prohibited_action || '').trim().toUpperCase();
  const kind = String(raw.kind || raw.slots?.kind || '').trim().toUpperCase();
  const key = normalizeParamKey(raw.key || raw.slots?.key);
  const valueRaw = raw.value ?? raw.slots?.value;
  const value = typeof valueRaw === 'number' ? valueRaw : Number(valueRaw);
  const topic = String(raw.topic || raw.slots?.topic || '').trim().toLowerCase();
  const confidence = Number(raw.confidence);
  const conf = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.82;

  if (BLOCKED_KINDS.includes(blockedKind) || ASSIST_PROHIBITED_ACTIONS.includes(blockedKind)) {
    return blockedResult(blockedKind, key ? { key, ...(Number.isFinite(value) ? { value } : {}) } : {});
  }
  if (kind === 'ARM' || kind === 'DISARM') {
    return blockedResult(kind);
  }
  if (intent === 'BLOCKED' || intent === 'PROHIBITED') {
    const guess = BLOCKED_KINDS.includes(kind) ? kind : 'FC_COMMAND';
    return blockedResult(guess);
  }

  if (intent === 'FLIGHT_OP') {
    if (!isAskSessionFlightOpKind(kind)) return null;
    const slots = {};
    if (kind === 'MODE_CHANGE') slots.mode = normalizeMode(raw.mode || raw.slots?.mode);
    return { ...flightOpResult(kind, slots), confidence: Math.max(conf, 0.86) };
  }

  if (intent === 'FLIGHT_PARAM' || intent === 'PARAM') {
    if (!key || !Number.isFinite(value)) return null;
    if (isAskBlockedParamKey(key)) {
      return blockedResult('NAV_SOURCE_SWITCH', { key, value });
    }
    return {
      blocked: false,
      intent: 'FLIGHT_PARAM',
      confidence: Math.max(conf, 0.86),
      slots: { action: 'PROPOSE_PARAM_CHANGE', key, value },
      resolver: 'llm',
    };
  }

  if (intent === 'QUESTION') {
    const t = QUESTION_TOPICS.includes(topic) ? topic : 'general';
    const slots = { topic: t };
    if (t === 'param_get') {
      if (!key) return null;
      if (isAskBlockedParamKey(key)) return blockedResult('NAV_SOURCE_SWITCH', { key });
      slots.key = key;
    }
    return {
      blocked: false,
      intent: 'QUESTION',
      confidence: Math.max(conf, 0.8),
      slots,
      resolver: 'llm',
    };
  }

  return null;
}

export function parseLlmIntentJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Regex already mapped a gated intent — skip the LLM hop. */
export function deterministicIsFastPath(resolved) {
  if (!resolved) return false;
  if (resolved.blocked || resolved.prohibited) return true;
  if (resolved.intent === 'FLIGHT_OP' || resolved.intent === 'FLIGHT_PARAM') return true;
  if (
    resolved.intent === 'QUESTION'
    && resolved.slots?.topic
    && resolved.slots.topic !== 'general'
    && Number(resolved.confidence) >= 0.88
  ) {
    return true;
  }
  if (
    ['UI_ACTION', 'NOTE', 'OBSERVATION', 'DEVELOPMENT', 'REQUEST'].includes(resolved.intent)
    && Number(resolved.confidence) >= 0.8
  ) {
    return true;
  }
  return false;
}

export async function classifyAskIntentWithGemini(text, _context = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  const q = String(text || '').trim();
  if (!q) return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  const chain = getGeminiModelChain();
  for (const modelId of chain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        systemInstruction: CLASSIFY_SYSTEM,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
        },
      });
      const result = await model.generateContent(q);
      const parsed = parseLlmIntentJson(result?.response?.text?.() || '');
      const sanitized = sanitizeLlmIntent(parsed);
      if (sanitized) return sanitized;
    } catch {
      /* try next model */
    }
  }
  return null;
}

export async function resolveAskIntentPreferringLlm(text, context = {}, { classifyAskIntent } = {}) {
  const fast = resolveAssistIntent(text, context);
  if (deterministicIsFastPath(fast)) {
    return { ...fast, resolver: fast.resolver || 'regex' };
  }
  if (typeof classifyAskIntent === 'function') {
    try {
      const llm = await classifyAskIntent(text, context);
      const sanitized = sanitizeLlmIntent(llm) || (llm?.resolver === 'llm' && llm.intent ? llm : null);
      if (sanitized) return sanitized;
      if (llm && llm.intent && llm.resolver === 'llm') return llm;
    } catch {
      /* fall through */
    }
  }
  return { ...fast, resolver: fast.resolver || 'regex' };
}

export function defaultClassifyAskIntent(text, context) {
  if (process.env.VITEST) return null;
  return classifyAskIntentWithGemini(text, context);
}
