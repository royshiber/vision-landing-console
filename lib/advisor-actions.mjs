/**
 * Advisor Actions — Canonical schema + safety gates.
 *
 * This is the SOLE trust boundary between LLM output / client requests
 * and any live parameter write (Jetson-side or FC-side). Every proposed
 * action passes through:
 *   1. schema validation (kind + required fields + type checks)
 *   2. denylist (hard reject)
 *   3. allowlist (hard reject if not present)
 *   4. safe-range check (per-param, narrower than ArduPilot native)
 *   5. firmware check (when min_firmware present) — phase 4
 *   6. armed-state gate — applied at apply-time for Tier B (FC ground-only)
 *
 * Safety doc: docs/ADVISOR_SAFETY.md
 */
import { JETSON_NUMERIC_SCHEMA, FC_ADVISOR_WRITE_BOUNDS } from './param-schema.mjs';

// --- current phase gate ---------------------------------------------------
/**
 * Action kinds that are currently enabled end-to-end.
 * Phase 3 (current): no_action + param_change (Tier A Jetson-side free / Tier B FC disarmed-only).
 * Phase 4 will add: param_change_group, read_log, ask_version.
 *
 * DO NOT extend this without (a) filling in the allowlist/ranges below,
 * (b) writing the apply handler, (c) updating the safety doc.
 */
export const ENABLED_ACTION_KINDS = new Set(['no_action', 'param_change']);

/**
 * Emergency kill-switch — when false, no param_change option is ever returned
 * from the validator regardless of allowlist. Defaults true but operator can
 * disable via env to degrade the feature without a code change.
 */
export const ADVISOR_WRITES_ENABLED = process.env.ADVISOR_WRITES_ENABLED !== 'false';

// --- limits ---------------------------------------------------------------
const MAX_TITLE = 80;
const MAX_DETAIL = 500;
const MAX_OPTIONS = 6;
const EPSILON_EQ = 1e-6;

// --- allowlists -----------------------------------------------------------
/** Tier 0 — NEVER writable from the advisor. */
export const PARAM_DENYLIST = new Set([
  'ARMING_CHECK',
  'ARMING_REQUIRE',
  'BRD_SAFETYENABLE',
  'FS_THR_ENABLE',
  'FS_THR_VALUE',
  'FS_GCS_ENABLE',
  'FS_EKF_ACTION',
  'FS_SHORT_ACTN',
  'FS_LONG_ACTN',
  'GPS_TYPE',
]);

/**
 * Tier A — Jetson-side profile. These live in the Vision Landing Console
 * profile (server-side canonical store `jetson_profile` table). FC has never
 * heard of them; switching to FBWA/MANUAL/RTL makes Jetson inert. Low risk.
 *
 * Shape: Map<param, { min, max, risk, unit, inflightSafe, note }>
 */
function jetsonSpec(key, risk, unit, inflightSafe, note) {
  const spec = JETSON_NUMERIC_SCHEMA[key];
  if (!spec) throw new Error(`JETSON_NUMERIC_SCHEMA missing key: ${key}`);
  return [key, { min: spec.min, max: spec.max, risk, unit, inflightSafe, note }];
}

/** FC advisor allowlist row — min/max from FC_ADVISOR_WRITE_BOUNDS only. */
function fcAdvisorSpec(param, risk, unit, inflightSafe, note) {
  const spec = FC_ADVISOR_WRITE_BOUNDS[param];
  if (!spec) throw new Error(`FC_ADVISOR_WRITE_BOUNDS missing key: ${param}`);
  return [param, { min: spec.min, max: spec.max, risk, unit, inflightSafe, note }];
}

export const JETSON_PARAM_ALLOWLIST = new Map([
  jetsonSpec('flare_alt_m', 'med', 'm', false, 'גובה תחילת flare'),
  jetsonSpec('flare_pitch_up_deg', 'med', '°', false, 'זווית הרמת אף ב-flare'),
  jetsonSpec('approach_speed_ms', 'med', 'm/s', false, 'מהירות גישה'),
  jetsonSpec('sink_rate_ms', 'med', 'm/s', false, 'קצב ירידה'),
  jetsonSpec('abort_conf_min', 'low', '', true, 'סף ביטחון ל-abort'),
  jetsonSpec('abort_conf_hold_s', 'low', 's', true, 'זמן החזקה לפני abort'),
  jetsonSpec('vision_conf_min', 'low', '', true, 'סף ביטחון Vision'),
  jetsonSpec('vision_enable_alt_m', 'low', 'm', false, 'גובה הפעלת Vision'),
  jetsonSpec('xtrack_gain', 'med', '', false, 'יישור מסלול רוחב (xtrack) — עוצמת התיקון לצד'),
  jetsonSpec('yaw_align_gain', 'med', '', false, 'יישור כיוון עדין סביב final'),
  jetsonSpec('max_roll_deg', 'med', '°', false, 'מגבלת הטיה בתיקוני ניווט'),
]);

/**
 * Tier B — FC-side (ArduPilot) landing-phase parameters. DISARMED-only.
 * Safe ranges are intentionally NARROWER than ArduPilot's native bounds.
 */
export const FC_PARAM_ALLOWLIST_GROUND = new Map([
  fcAdvisorSpec('LAND_SPEED', 'med', 'cm/s', false, 'מהירות שקיעה סופית'),
  fcAdvisorSpec('LAND_PITCH_DEG', 'med', '°', false, 'זווית pitch בנחיתה'),
  fcAdvisorSpec('LAND_FLARE_ALT', 'med', 'm', false, 'גובה flare FC'),
  fcAdvisorSpec('LAND_FLARE_SEC', 'med', 's', false, 'משך flare FC'),
]);

/** Tier 3 — expert (future). Currently empty. */
export const FC_PARAM_ALLOWLIST_EXPERT = new Map();

// --- helpers --------------------------------------------------------------

/**
 * Resolve a param to its target and safety spec.
 * Known Jetson/FC params get pre-defined safe ranges.
 * Unknown (but non-denied) FC params are allowed with no pre-defined range
 * so the advisor can suggest any ArduPilot parameter — user still must approve.
 * @param {string} param
 * @returns {{target:'jetson'|'fc', spec:{min,max,risk,unit,inflightSafe,note}, isOpen?:boolean} | null}
 */
export function resolveParam(param) {
  if (typeof param !== 'string' || !param) return null;
  if (PARAM_DENYLIST.has(param)) return null;
  if (JETSON_PARAM_ALLOWLIST.has(param)) {
    return { target: 'jetson', spec: JETSON_PARAM_ALLOWLIST.get(param) };
  }
  if (FC_PARAM_ALLOWLIST_GROUND.has(param)) {
    return { target: 'fc', spec: FC_PARAM_ALLOWLIST_GROUND.get(param) };
  }
  if (FC_PARAM_ALLOWLIST_EXPERT.has(param)) {
    return { target: 'fc', spec: FC_PARAM_ALLOWLIST_EXPERT.get(param) };
  }
  // Open param — any ArduPilot parameter not explicitly denied.
  // No pre-defined safe range; LLM is expected to use a sensible value.
  // Risk defaults to 'high' so the UI shows an extra confirmation step.
  return {
    target: 'fc',
    isOpen: true,
    spec: { min: -1e9, max: 1e9, risk: 'high', unit: '', inflightSafe: false, note: 'פרמטר FC כללי — ודא ידנית שהערך בטוח לפי תיעוד ArduPilot' },
  };
}

/** Shallow string sanitizer. */
function cleanStr(s, max = 500) {
  if (typeof s !== 'string') return '';
  const trimmed = s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Rounds a numeric value for display/apply, based on the param’s safe range span.
 * @param {{ min: number, max: number }} spec
 * @param {number} v
 * @returns {number}
 */
export function roundParamValueForSpec(spec, v) {
  // Open params (min=-1e9, max=1e9) — don't clamp, just round sensibly.
  const isOpen = spec.min <= -1e8 && spec.max >= 1e8;
  const c = isOpen ? v : Math.max(spec.min, Math.min(spec.max, v));
  const span = isOpen ? Math.abs(v) * 2 + 1 : spec.max - spec.min;
  if (span >= 100) return Math.round(c * 10) / 10;
  if (span >= 20) return Math.round(c * 100) / 100;
  if (span >= 2) return Math.round(c * 1000) / 1000;
  return Math.round(c * 10000) / 10000;
}

/**
 * Build 2–3 graded toward/to values around the model’s primary recommendation.
 * The middle entry always matches `primaryTo` (the validated LLM "to").
 *
 * @param {{ from: number | null, primaryTo: number, spec: { min: number, max: number } }} p
 * @returns {Array<{ id: string, label: string, to: number, isPrimary: boolean }>}
 */
export function buildParamAlternatives(p) {
  const { from, primaryTo, spec } = p;
  const toN = roundParamValueForSpec(spec, primaryTo);
  const min = spec.min;
  const max = spec.max;
  if (!isFiniteNumber(toN)) return [];

  let fromN = isFiniteNumber(from) ? roundParamValueForSpec(spec, from) : null;
  if (fromN == null) {
    fromN = roundParamValueForSpec(spec, (min + max) / 2);
  }

  const delta = toN - fromN;
  if (Math.abs(delta) < EPSILON_EQ) {
    return [
      { id: 'primary', label: 'לפי ההמלצה', to: toN, isPrimary: true },
    ];
  }

  const cautiousT = roundParamValueForSpec(spec, fromN + delta * 0.38);
  const assertiveT = roundParamValueForSpec(spec, fromN + delta * 1.18);

  const raw = [
    { id: 'cautious', label: 'שמרני', to: cautiousT, isPrimary: false },
    { id: 'primary', label: 'לפי ההמלצה', to: toN, isPrimary: true },
    { id: 'assertive', label: 'נועז', to: assertiveT, isPrimary: false },
  ];

  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (seen.has(r.to)) continue;
    if (!r.isPrimary && Math.abs(r.to - fromN) < 1e-5) continue;
    if (!r.isPrimary && Math.abs(r.to - toN) < 1e-5) continue;
    seen.add(r.to);
    out.push(r);
  }
  if (!out.some((x) => x.isPrimary)) {
    out.push({ id: 'primary', label: 'לפי ההמלצה', to: toN, isPrimary: true });
  }
  return out;
}

/**
 * True if `value` matches the primary "to" or one of the graded alternatives.
 * Used to constrain POST apply body `valueTo` to the proposal family.
 */
export function isValueInParamProposalFamily(param, from, primaryTo, value) {
  const resolved = resolveParam(param);
  if (!resolved) return false;
  const t = roundParamValueForSpec(resolved.spec, Number(value));
  if (!isFiniteNumber(t)) return false;
  const alts = buildParamAlternatives({ from: from != null ? Number(from) : null, primaryTo, spec: resolved.spec });
  return alts.some((a) => Math.abs(a.to - t) < EPSILON_EQ * 10);
}

/**
 * If `param_change`, attach `paramHelp` (allowlist) + `alternatives` (graded steps).
 * Safe to run on any validated param_change option (with or without `id`).
 * @param {any} option
 * @returns {any}
 */
export function enrichParamChangeOption(option) {
  if (!option || option.kind !== 'param_change' || !option.change) return option;
  const ch = option.change;
  const resolved = resolveParam(ch.param);
  if (!resolved) return option;
  const specNote = typeof resolved.spec?.note === 'string' ? resolved.spec.note.trim() : '';
  const withHelp = {
    ...option,
    paramHelp: specNote ? `${ch.param} — ${specNote}` : String(ch.param),
  };
  if (withHelp.note == null && specNote) withHelp.note = specNote;
  const alts = buildParamAlternatives({
    from: ch.from != null && isFiniteNumber(Number(ch.from)) ? Number(ch.from) : null,
    primaryTo: Number(ch.to),
    spec: resolved.spec,
  });
  if (alts.length) {
    withHelp.alternatives = alts;
  }
  return withHelp;
}

export function enrichValidatedParamChangeOptions(options) {
  if (!Array.isArray(options)) return options;
  return options.map((o) => (o && o.kind === 'param_change' ? enrichParamChangeOption(o) : o));
}

// --- per-kind validators -------------------------------------------------
function validateNoAction(raw) {
  const title = cleanStr(raw?.title, MAX_TITLE);
  if (!title) return { ok: false, reason: 'no_action: missing title' };
  return {
    ok: true,
    option: {
      kind: 'no_action',
      id: '',
      title,
      detail: cleanStr(raw?.detail, MAX_DETAIL) || undefined,
    },
  };
}

function validateParamChange(raw) {
  if (!ADVISOR_WRITES_ENABLED) return { ok: false, reason: 'param_change globally disabled (ADVISOR_WRITES_ENABLED=false)' };
  const title = cleanStr(raw?.title, MAX_TITLE);
  if (!title) return { ok: false, reason: 'param_change: missing title' };

  const ch = raw?.change;
  if (!ch || typeof ch !== 'object') return { ok: false, reason: 'param_change: missing change object' };
  const param = typeof ch.param === 'string' ? ch.param.trim() : '';
  if (!param) return { ok: false, reason: 'param_change: missing param name' };
  if (PARAM_DENYLIST.has(param)) return { ok: false, reason: `param_change: denylisted param ${param}` };

  const resolved = resolveParam(param);
  if (!resolved) return { ok: false, reason: `param_change: ${param} is in denylist` };

  const from = Number(ch.from);
  const to = Number(ch.to);
  if (!isFiniteNumber(to)) return { ok: false, reason: 'param_change: non-finite "to"' };
  if (ch.from != null && !isFiniteNumber(from)) return { ok: false, reason: 'param_change: non-finite "from"' };
  const { min, max, risk, unit, inflightSafe, note } = resolved.spec;
  // For open params (no pre-defined range) skip range check — user must approve anyway.
  if (!resolved.isOpen && (to < min - EPSILON_EQ || to > max + EPSILON_EQ)) {
    return { ok: false, reason: `param_change: ${param} value ${to} out of safe range [${min}, ${max}]` };
  }
  // Permit `from` slightly outside safe range (existing state may be wide),
  // but sanity-check it's finite. If LLM sends `from === to` we reject as no-op.
  if (ch.from != null && Math.abs(from - to) < EPSILON_EQ) {
    return { ok: false, reason: 'param_change: no-op (from == to)' };
  }

  const option = {
    kind: 'param_change',
    id: '',
    title,
    detail: cleanStr(raw?.detail, MAX_DETAIL) || undefined,
    change: {
      param,
      from: isFiniteNumber(from) ? from : null,
      to,
    },
    target: resolved.target,
    risk: (raw && (raw.risk === 'low' || raw.risk === 'med' || raw.risk === 'high')) ? raw.risk : risk,
    reversible: true,
    inflightSafe: !!inflightSafe,
    unit: unit || '',
    note: note || undefined,
  };
  return { ok: true, option: enrichParamChangeOption(option) };
}

function validateParamChangeGroup(_raw) {
  return { ok: false, reason: 'param_change_group not enabled (phase 4)' };
}
function validateReadLog(_raw) {
  return { ok: false, reason: 'read_log not enabled (phase 4)' };
}
function validateAskVersion(_raw) {
  return { ok: false, reason: 'ask_version not enabled (phase 4)' };
}

const VALIDATORS = {
  no_action: validateNoAction,
  param_change: validateParamChange,
  param_change_group: validateParamChangeGroup,
  read_log: validateReadLog,
  ask_version: validateAskVersion,
};

// --- public API -----------------------------------------------------------

/**
 * Validate a list of proposed options.
 * @param {any[]} rawOptions
 * @returns {{accepted: any[], rejected: {raw:any, reason:string}[]}}
 */
export function validateOptions(rawOptions) {
  const accepted = [];
  const rejected = [];
  if (!Array.isArray(rawOptions)) return { accepted, rejected };
  const slice = rawOptions.slice(0, MAX_OPTIONS);
  for (const raw of slice) {
    if (!raw || typeof raw !== 'object') { rejected.push({ raw, reason: 'not an object' }); continue; }
    const kind = raw.kind;
    if (typeof kind !== 'string' || !ENABLED_ACTION_KINDS.has(kind)) {
      rejected.push({ raw, reason: `disabled or unknown kind: ${kind}` });
      continue;
    }
    const validator = VALIDATORS[kind];
    if (!validator) { rejected.push({ raw, reason: `no validator for kind: ${kind}` }); continue; }
    const result = validator(raw);
    if (!result.ok) { rejected.push({ raw, reason: result.reason }); continue; }
    accepted.push(result.option);
  }
  return { accepted, rejected };
}

/**
 * Re-validate a SINGLE action at apply-time. This is defensive — the client
 * never gets to bypass validation, even if it replays an old action ID.
 */
export function validateSingleForApply(action) {
  if (!action || typeof action !== 'object') return { ok: false, reason: 'invalid action object' };
  if (!ENABLED_ACTION_KINDS.has(action.kind)) return { ok: false, reason: `kind not enabled: ${action.kind}` };
  const validator = VALIDATORS[action.kind];
  if (!validator) return { ok: false, reason: `no validator: ${action.kind}` };
  return validator(action);
}

export function assignActionIds(options, issueId) {
  const now = Date.now();
  return options.map((opt, i) => ({
    ...opt,
    id: `a-${issueId || 'x'}-${now}-${i}`,
  }));
}

/**
 * LLM-facing schema prompt. Describes only the currently-enabled kinds.
 * Includes a short human-readable allowlist so the LLM doesn't propose params
 * that would be rejected at validation time.
 */
export function buildLLMActionSchemaBlock() {
  const jetsonList = [...JETSON_PARAM_ALLOWLIST.entries()]
    .map(([p, s]) => `  - ${p} (Jetson, טווח מוגדר ${s.min}–${s.max}${s.unit}) — ${s.note || ''}`)
    .join('\n');
  const fcKnownList = [...FC_PARAM_ALLOWLIST_GROUND.entries()]
    .map(([p, s]) => `  - ${p} (FC, טווח מוגדר ${s.min}–${s.max}${s.unit}) — ${s.note || ''}`)
    .join('\n');
  const deniedList = [...PARAM_DENYLIST].map((p) => `  - ${p}`).join('\n');

  return `### פורמט תשובה מובנה (JSON)

ענה **אך ורק** כ-JSON עם הצורה:

\`\`\`json
{
  "reply": "התשובה המילולית שלך בעברית, ללא markdown",
  "options": [
    { "kind": "param_change", "title": "LAND_SPEED: 150 → 130 cm/s", "detail": "הורדת מהירות שקיעה סופית", "change": { "param": "LAND_SPEED", "from": 150, "to": 130 }, "risk": "med" },
    { "kind": "no_action", "title": "שאלת המשך / רעיון", "detail": "הסבר קצר" }
  ]
}
\`\`\`

## חוקי תשובה — חובה לפעול לפיהם:

### הצעת param_change — PROACTIVE (חשוב ביותר)
- **כל תשובה שיש בה אבחנה של בעיה חייבת לכלול לפחות param_change אחד ספציפי** — עם "from" ו-"to" מדויקים.
- אל תכתוב "שקול לשנות X ל-Y" בטקסט — **הכנס card של param_change במקום**. הטקסט ישמש להסבר בלבד.
- אם אתה מציע שינוי ל-ArduPilot — כלול תמיד ערכי from/to מספריים. המשתמש יצטרך ללחוץ על אישור.
- תציע עד 4 param_change + עד 2 no_action בכל תשובה.

### title של param_change
- פורמט קבוע: "PARAM_NAME: current → new unit" (לדוגמה: "RLL2SRV_P: 0.4 → 0.35")

### "from" ו-"to"
- "from" = הערך הנוכחי. אם לא ידוע — כתוב ערך ברירת מחדל סביר לפי תיעוד ArduPilot.
- "to" = הערך המומלץ. חייב להיות מספר סופי ובטווח הגיוני לפרמטר.

### פרמטרים מותרים
- **כל פרמטר ArduPilot מותר** — הערך ייאומת ידנית על ידי המשתמש לפני כתיבה.
- פרמטרים עם טווח מוגדר (עדיף להשתמש בהם — אין סיכון range):
${jetsonList}
${fcKnownList}
- **פרמטרים אסורים לחלוטין (DENYLIST — יידחו תמיד):**
${deniedList}

### חוק ARMED (בטיסה)
פרמטרים מותרים בטיסה בלבד: abort_conf_min, abort_conf_hold_s, vision_conf_min.
כל שאר הפרמטרים — DISARMED בלבד.

### no_action — מתי להשתמש
לשאלות תיאורטיות, בדיקות לוג, מידע ללא שינוי ספציפי.

אם ממש אין הצעה — החזר "options": [].
`;
}

/** Parse LLM JSON reply. */
export function parseStructuredReply(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  let obj = null;
  try { obj = JSON.parse(trimmed); } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { obj = JSON.parse(match[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const reply = typeof obj.reply === 'string' ? obj.reply : '';
  const options = Array.isArray(obj.options) ? obj.options : [];
  if (!reply && options.length === 0) return null;
  return { reply, options };
}

/**
 * Public read-only view of what the advisor can touch. Useful for:
 *   - UI "what params can the advisor change?" tooltip
 *   - Server-side diagnostics
 *   - Future expansion (safe ranges displayed next to live FC values)
 */
export function describeAllowlists() {
  return {
    jetson: [...JETSON_PARAM_ALLOWLIST.entries()].map(([param, spec]) => ({ param, ...spec })),
    fcGround: [...FC_PARAM_ALLOWLIST_GROUND.entries()].map(([param, spec]) => ({ param, ...spec })),
    fcExpert: [...FC_PARAM_ALLOWLIST_EXPERT.entries()].map(([param, spec]) => ({ param, ...spec })),
    denylist: [...PARAM_DENYLIST],
    writesEnabled: ADVISOR_WRITES_ENABLED,
  };
}
