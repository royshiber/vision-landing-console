/**
 * Hardware-intent catalog for the Configuration Wizard.
 *
 * Product lock (Concept B, Roy 2026-09-12): three numbered tall cards:
 *   1) מה חיברתי — hardware radio/select (e.g. Here3) + free text
 *   2) לאן חיברתי — FC vs מחשב משימה + pin/port grid + free text
 *   3) מה אני מצפה שיקרה — outcome checklist + live status + free text
 *
 * Free text on every card is first-class when presets do not cover the case.
 * Not a settings dump. Not address/URL entry.
 * Recommendation / display only. No flight commands. No Companion apply/restart.
 */

/** @typedef {'fc'|'jetson'} HardwareHost */

/**
 * @typedef {{
 *   host: HardwareHost,
 *   hostHe: string,
 *   port: string,
 *   pins: string[],
 *   noteHe: string,
 * }} HardwarePortTarget
 */

/**
 * @typedef {{
 *   id: string,
 *   recipeType: string,
 *   order: number,
 *   labelHe: string,
 *   connected: { titleHe: string, detailHe: string, modelHe: string },
 *   wiring: { fc: HardwarePortTarget|null, jetson: HardwarePortTarget|null },
 *   expected: { token: string, titleHe: string, observeHe: string },
 * }} HardwareIntentComponent
 */

/** @type {HardwareIntentComponent[]} */
export const HARDWARE_INTENT_COMPONENTS = [
  {
    id: 'GPS',
    recipeType: 'GPS',
    order: 1,
    labelHe: 'ניווט לווייני',
    connected: {
      titleHe: 'מקלט ניווט',
      detailHe: 'יחידת ניווט חיצונית עם אנטנה. דגם נפוץ בערכה.',
      modelHe: 'Here3',
    },
    wiring: {
      fc: {
        host: 'fc',
        hostHe: 'בקר טיסה',
        port: 'GPS',
        pins: ['GPS', 'CAN'],
        noteHe: 'שקע ניווט בלוח. דגם זה יכול גם על אוטובוס קאן.',
      },
      jetson: null,
    },
    expected: {
      token: '3D fix',
      titleHe: 'נעילה תלת ממדית',
      observeHe: 'סוג נעילה שלוש ומעלה. מספר לוויינים מספיק ליציבות.',
    },
  },
  {
    id: 'CompanionLink',
    recipeType: 'CompanionLink',
    order: 2,
    labelHe: 'קישור מחשב משימה',
    connected: {
      titleHe: 'קישור למחשב משימה',
      detailHe: 'כבל טורי בין בקר הטיסה למחשב המשימה. לא רדיו קרקע.',
      modelHe: 'Jetson',
    },
    wiring: {
      fc: {
        host: 'fc',
        hostHe: 'בקר טיסה',
        port: 'TELEM2',
        pins: ['TELEM2'],
        noteHe: 'שקע טלמטריה שני בלוח. פרוטוקול מחשב משימה.',
      },
      jetson: {
        host: 'jetson',
        hostHe: 'מחשב משימה',
        port: 'UART1',
        pins: ['UART1', 'ttyTHS1', 'ttyTHS0'],
        noteHe: 'שקע טורי ראשון. לוחות מסוימים משתמשים בשקע האפס.',
      },
    },
    expected: {
      token: 'heartbeat',
      titleHe: 'דופק חיים',
      observeHe: 'בריאות מחשב המשימה ירוקה. דופק מגיע לקונסולה.',
    },
  },
  {
    id: 'TelemetryRadio',
    recipeType: 'TelemetryRadio',
    order: 3,
    labelHe: 'רדיו טלמטריה',
    connected: {
      titleHe: 'רדיו קרקע',
      detailHe: 'מודול רדיו על הכלי. משדר זרם לבקר הקרקע.',
      modelHe: 'UART radio',
    },
    wiring: {
      fc: {
        host: 'fc',
        hostHe: 'בקר טיסה',
        port: 'TELEM1',
        pins: ['TELEM1'],
        noteHe: 'שקע טלמטריה ראשון בלוח. לא אותו שקע של מחשב המשימה.',
      },
      jetson: null,
    },
    expected: {
      token: 'telemetry stream',
      titleHe: 'זרם טלמטריה',
      observeHe: 'נתוני טיסה זורמים בקונסולה בלי ניתוקים חוזרים.',
    },
  },
  {
    id: 'LandingCamera',
    recipeType: 'LandingCamera',
    order: 4,
    labelHe: 'מצלמת נחיתה',
    connected: {
      titleHe: 'מצלמה כלפי מטה',
      detailHe: 'מצלמת נחיתה על מחשב המשימה. אין חוט ישיר לבקר.',
      modelHe: 'CSI / IMX',
    },
    wiring: {
      fc: null,
      jetson: {
        host: 'jetson',
        hostHe: 'מחשב משימה',
        port: 'CSI1',
        pins: ['CSI1'],
        noteHe: 'שקע מצלמה אחד. מצלמה קדמית יושבת בשקע האפס.',
      },
    },
    expected: {
      token: 'vision estimate',
      titleHe: 'אומדן ראייה',
      observeHe: 'אומדן מיקום מהתמונה מגיע. נעילת נחיתה אפשרית.',
    },
  },
  {
    id: 'Receiver',
    recipeType: 'Receiver',
    order: 5,
    labelHe: 'מקלט שלט',
    connected: {
      titleHe: 'מקלט שלט',
      detailHe: 'מקלט רדיו לשליטה ידנית. מחובר לבקר בלבד.',
      modelHe: 'SBUS / CRSF',
    },
    wiring: {
      fc: {
        host: 'fc',
        hostHe: 'בקר טיסה',
        port: 'RCIN',
        pins: ['RCIN', 'SBUS'],
        noteHe: 'שקע קלט שלט בלוח. פרוטוקול לפי המקלט.',
      },
      jetson: null,
    },
    expected: {
      token: 'RC input',
      titleHe: 'תנועת מקלות',
      observeHe: 'הזזת מקל מזיזה ערוץ בקונסולה. אין קלט מת.',
    },
  },
];

const FORBIDDEN_UI_TERMS = ['מסייע', 'מלווה'];

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {HardwarePortTarget|null|undefined} target
 * @returns {boolean}
 */
function isPortTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.host !== 'fc' && target.host !== 'jetson') return false;
  if (!asText(target.hostHe) || !asText(target.port) || !asText(target.noteHe)) return false;
  return Array.isArray(target.pins) && target.pins.length > 0;
}

/**
 * Validate one hardware-intent card. Used by tests and the API.
 * @param {unknown} raw
 * @returns {{ ok: true, component: HardwareIntentComponent } | { ok: false, error: string }}
 */
export function validateHardwareIntent(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'missing component' };
  const c = /** @type {HardwareIntentComponent} */ (raw);
  if (!asText(c.id) || !asText(c.recipeType) || !asText(c.labelHe)) {
    return { ok: false, error: 'missing identity' };
  }
  if (!c.connected || !asText(c.connected.titleHe) || !asText(c.connected.detailHe)) {
    return { ok: false, error: 'missing connected' };
  }
  if (!c.wiring || (!c.wiring.fc && !c.wiring.jetson)) {
    return { ok: false, error: 'missing wiring' };
  }
  if (c.wiring.fc && !isPortTarget(c.wiring.fc)) return { ok: false, error: 'invalid fc wiring' };
  if (c.wiring.jetson && !isPortTarget(c.wiring.jetson)) return { ok: false, error: 'invalid jetson wiring' };
  if (c.wiring.fc && c.wiring.fc.host !== 'fc') return { ok: false, error: 'fc host mismatch' };
  if (c.wiring.jetson && c.wiring.jetson.host !== 'jetson') return { ok: false, error: 'jetson host mismatch' };
  if (!c.expected || !asText(c.expected.token) || !asText(c.expected.titleHe) || !asText(c.expected.observeHe)) {
    return { ok: false, error: 'missing expected' };
  }
  const blob = JSON.stringify(c);
  for (const term of FORBIDDEN_UI_TERMS) {
    if (blob.includes(term)) return { ok: false, error: `forbidden term ${term}` };
  }
  return { ok: true, component: c };
}

/**
 * Wizard walk order. Primary operator checklist.
 * @returns {HardwareIntentComponent[]}
 */
export function listHardwareIntentComponents() {
  return HARDWARE_INTENT_COMPONENTS
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const checked = validateHardwareIntent(c);
      if (!checked.ok) throw new Error(`hardware-intent ${c.id}: ${checked.error}`);
      return { ...c };
    });
}

/**
 * @param {string} id
 * @returns {HardwareIntentComponent|null}
 */
export function getHardwareIntent(id) {
  const found = HARDWARE_INTENT_COMPONENTS.find((c) => c.id === id);
  return found ? { ...found } : null;
}

/** First-class free-text sentinel on every Concept B card. */
export const CONCEPT_B_FREE_ID = '__free__';
export const CONCEPT_B_STORAGE_KEY = 'vlc.ac.conceptB.v1';

/**
 * @typedef {{
 *   id: string,
 *   labelHe: string,
 *   detailHe: string,
 *   modelHe: string,
 *   componentId: string,
 *   suggestHost: 'fc'|'jetson',
 *   suggestPort: string,
 *   suggestOutcomes: string[],
 * }} ConceptBHardwareOption
 */

/**
 * @typedef {{
 *   id: string,
 *   host: 'fc'|'jetson',
 *   label: string,
 * }} ConceptBPortOption
 */

/**
 * @typedef {{
 *   id: string,
 *   token: string,
 *   titleHe: string,
 *   observeHe: string,
 *   liveKey: 'gps3d'|'heartbeat'|'telemetry'|'vision'|'rc',
 * }} ConceptBOutcomeOption
 */

/**
 * @typedef {{
 *   hardwareId: string,
 *   hardwareFree: string,
 *   host: 'fc'|'jetson',
 *   portId: string,
 *   portFree: string,
 *   outcomeIds: string[],
 *   outcomeFree: string,
 * }} ConceptBStep
 */

/** @type {ConceptBHardwareOption[]} */
export const CONCEPT_B_HARDWARE = [
  {
    id: 'here3',
    labelHe: 'Here3',
    detailHe: 'מקלט ניווט חיצוני עם אנטנה.',
    modelHe: 'Here3',
    componentId: 'GPS',
    suggestHost: 'fc',
    suggestPort: 'GPS',
    suggestOutcomes: ['fix-3d'],
  },
  {
    id: 'companion-link',
    labelHe: 'קישור מחשב משימה',
    detailHe: 'כבל טורי בין בקר הטיסה למחשב המשימה.',
    modelHe: 'Jetson',
    componentId: 'CompanionLink',
    suggestHost: 'fc',
    suggestPort: 'TELEM2',
    suggestOutcomes: ['heartbeat'],
  },
  {
    id: 'uart-radio',
    labelHe: 'רדיו UART',
    detailHe: 'מודול רדיו על הכלי. משדר זרם לבקר הקרקע.',
    modelHe: 'UART radio',
    componentId: 'TelemetryRadio',
    suggestHost: 'fc',
    suggestPort: 'TELEM1',
    suggestOutcomes: ['telemetry'],
  },
  {
    id: 'landing-camera',
    labelHe: 'מצלמת נחיתה',
    detailHe: 'מצלמה כלפי מטה על מחשב המשימה.',
    modelHe: 'CSI / IMX',
    componentId: 'LandingCamera',
    suggestHost: 'jetson',
    suggestPort: 'CSI1',
    suggestOutcomes: ['vision'],
  },
  {
    id: 'receiver',
    labelHe: 'מקלט שלט',
    detailHe: 'מקלט רדיו לשליטה ידנית. מחובר לבקר בלבד.',
    modelHe: 'SBUS / CRSF',
    componentId: 'Receiver',
    suggestHost: 'fc',
    suggestPort: 'RCIN',
    suggestOutcomes: ['rc'],
  },
];

/** @type {ConceptBPortOption[]} */
export const CONCEPT_B_FC_PORTS = [
  { id: 'GPS', host: 'fc', label: 'GPS' },
  { id: 'CAN', host: 'fc', label: 'CAN' },
  { id: 'TELEM1', host: 'fc', label: 'TELEM1' },
  { id: 'TELEM2', host: 'fc', label: 'TELEM2' },
  { id: 'RCIN', host: 'fc', label: 'RCIN' },
  { id: 'SBUS', host: 'fc', label: 'SBUS' },
  { id: 'SERIAL4', host: 'fc', label: 'SERIAL4' },
];

/** @type {ConceptBPortOption[]} */
export const CONCEPT_B_JETSON_PORTS = [
  { id: 'UART1', host: 'jetson', label: 'UART1' },
  { id: 'UART0', host: 'jetson', label: 'UART0' },
  { id: 'ttyTHS1', host: 'jetson', label: 'ttyTHS1' },
  { id: 'ttyTHS0', host: 'jetson', label: 'ttyTHS0' },
  { id: 'CSI1', host: 'jetson', label: 'CSI1' },
  { id: 'CSI0', host: 'jetson', label: 'CSI0' },
  { id: 'USB', host: 'jetson', label: 'USB' },
];

/** @type {ConceptBOutcomeOption[]} */
export const CONCEPT_B_OUTCOMES = [
  {
    id: 'fix-3d',
    token: 'FIX 3D',
    titleHe: 'נעילה תלת ממדית',
    observeHe: 'סוג נעילה שלוש ומעלה. מספר לוויינים מספיק ליציבות.',
    liveKey: 'gps3d',
  },
  {
    id: 'heartbeat',
    token: 'heartbeat',
    titleHe: 'דופק חיים',
    observeHe: 'בריאות מחשב המשימה ירוקה. דופק מגיע לקונסולה.',
    liveKey: 'heartbeat',
  },
  {
    id: 'telemetry',
    token: 'telemetry stream',
    titleHe: 'זרם טלמטריה',
    observeHe: 'נתוני טיסה זורמים בקונסולה בלי ניתוקים חוזרים.',
    liveKey: 'telemetry',
  },
  {
    id: 'vision',
    token: 'vision estimate',
    titleHe: 'אומדן ראייה',
    observeHe: 'אומדן מיקום מהתמונה מגיע. נעילת נחיתה אפשרית.',
    liveKey: 'vision',
  },
  {
    id: 'rc',
    token: 'RC input',
    titleHe: 'תנועת מקלות',
    observeHe: 'הזזת מקל מזיזה ערוץ בקונסולה. אין קלט מת.',
    liveKey: 'rc',
  },
];

/**
 * @returns {ConceptBStep}
 */
export function emptyConceptBStep() {
  return {
    hardwareId: '',
    hardwareFree: '',
    host: 'fc',
    portId: '',
    portFree: '',
    outcomeIds: [],
    outcomeFree: '',
  };
}

/**
 * @param {unknown} raw
 * @returns {ConceptBStep}
 */
export function normalizeConceptBStep(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const host = src.host === 'jetson' ? 'jetson' : 'fc';
  const outcomeIds = Array.isArray(src.outcomeIds)
    ? src.outcomeIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  return {
    hardwareId: asText(src.hardwareId).trim(),
    hardwareFree: asText(src.hardwareFree).trim(),
    host,
    portId: asText(src.portId).trim(),
    portFree: asText(src.portFree).trim(),
    outcomeIds,
    outcomeFree: asText(src.outcomeFree).trim(),
  };
}

/**
 * Typing or choosing אחר is first-class: the card switches to free text.
 * @param {ConceptBStep} step
 * @param {'hardware'|'where'|'expect'} field
 * @param {string} text
 * @returns {ConceptBStep}
 */
export function applyConceptBFreeText(step, field, text) {
  const next = normalizeConceptBStep(step);
  const value = asText(text);
  if (field === 'hardware') {
    next.hardwareId = CONCEPT_B_FREE_ID;
    next.hardwareFree = value;
    return next;
  }
  if (field === 'where') {
    next.portId = CONCEPT_B_FREE_ID;
    next.portFree = value;
    return next;
  }
  if (field === 'expect') {
    next.outcomeFree = value;
    return next;
  }
  return next;
}

/**
 * Selecting a hardware preset fills suggested host / port / outcome.
 * @param {ConceptBStep} step
 * @param {string} hardwareId
 * @returns {ConceptBStep}
 */
export function applyConceptBHardwarePreset(step, hardwareId) {
  const next = normalizeConceptBStep(step);
  const preset = CONCEPT_B_HARDWARE.find((h) => h.id === hardwareId);
  if (!preset) {
    next.hardwareId = CONCEPT_B_FREE_ID;
    return next;
  }
  next.hardwareId = preset.id;
  next.hardwareFree = '';
  next.host = preset.suggestHost;
  next.portId = preset.suggestPort;
  next.portFree = '';
  next.outcomeIds = [...preset.suggestOutcomes];
  return next;
}

/**
 * @param {ConceptBStep} step
 * @returns {string}
 */
export function conceptBHardwareLabel(step) {
  const s = normalizeConceptBStep(step);
  if (s.hardwareId === CONCEPT_B_FREE_ID || s.hardwareFree) {
    return s.hardwareFree || 'אחר';
  }
  const preset = CONCEPT_B_HARDWARE.find((h) => h.id === s.hardwareId);
  return preset?.labelHe || '';
}

/**
 * @param {ConceptBStep} step
 * @returns {string}
 */
export function conceptBPortLabel(step) {
  const s = normalizeConceptBStep(step);
  if (s.portId === CONCEPT_B_FREE_ID || s.portFree) {
    return s.portFree || 'שקע אחר';
  }
  const ports = s.host === 'jetson' ? CONCEPT_B_JETSON_PORTS : CONCEPT_B_FC_PORTS;
  return ports.find((p) => p.id === s.portId)?.label || s.portId || '';
}

/**
 * @param {ConceptBStep} step
 * @returns {string[]}
 */
export function conceptBOutcomeLabels(step) {
  const s = normalizeConceptBStep(step);
  const labels = [];
  for (const id of s.outcomeIds) {
    const o = CONCEPT_B_OUTCOMES.find((x) => x.id === id);
    if (o) labels.push(o.token);
  }
  if (s.outcomeFree) labels.push(s.outcomeFree);
  return labels;
}

/**
 * Footer summary sentence. Tokens stay isolated; body is Hebrew.
 * @param {unknown} raw
 * @returns {string}
 */
export function buildConceptBSummaryHe(raw) {
  const step = normalizeConceptBStep(raw);
  const what = conceptBHardwareLabel(step);
  const port = conceptBPortLabel(step);
  const outcomes = conceptBOutcomeLabels(step);
  const hostHe = step.host === 'jetson' ? 'מחשב משימה' : 'בקר טיסה';
  const hasWhat = Boolean(what && what !== 'אחר');
  const hasFreeWhat = step.hardwareId === CONCEPT_B_FREE_ID && Boolean(step.hardwareFree);
  const hasPort = Boolean(port && port !== 'שקע אחר');
  const hasFreePort = step.portId === CONCEPT_B_FREE_ID && Boolean(step.portFree);
  const hasExpect = outcomes.length > 0;
  if (!hasWhat && !hasFreeWhat && !hasPort && !hasFreePort && !hasExpect) {
    return 'בחרו מה חיברתם, לאן, ומה מצפים.';
  }
  const whatPart = what || 'רכיב';
  const wherePart = port ? ` ל${hostHe} בשקע ${port}` : ` ל${hostHe}`;
  const expectPart = hasExpect ? ` מצפה ל־${outcomes.join(' · ')}.` : '.';
  return `חיברתי ${whatPart}${wherePart}.${expectPart}`;
}

/**
 * A step is savable when any card has a preset or first-class free text.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isConceptBStepSavable(raw) {
  const step = normalizeConceptBStep(raw);
  const hasWhat = (step.hardwareId && step.hardwareId !== CONCEPT_B_FREE_ID) || Boolean(step.hardwareFree);
  const hasWhere = (step.portId && step.portId !== CONCEPT_B_FREE_ID) || Boolean(step.portFree);
  const hasExpect = step.outcomeIds.length > 0 || Boolean(step.outcomeFree);
  return hasWhat || hasWhere || hasExpect;
}

/**
 * Payload for GET /api/auto-config/components.
 * @returns {{
 *   hardware: ConceptBHardwareOption[],
 *   ports: { fc: ConceptBPortOption[], jetson: ConceptBPortOption[] },
 *   outcomes: ConceptBOutcomeOption[],
 *   emptyStep: ConceptBStep,
 * }}
 */
export function listConceptBCatalog() {
  const blob = JSON.stringify({
    hardware: CONCEPT_B_HARDWARE,
    ports: { fc: CONCEPT_B_FC_PORTS, jetson: CONCEPT_B_JETSON_PORTS },
    outcomes: CONCEPT_B_OUTCOMES,
  });
  for (const term of FORBIDDEN_UI_TERMS) {
    if (blob.includes(term)) throw new Error(`forbidden term ${term}`);
  }
  return {
    hardware: CONCEPT_B_HARDWARE.map((h) => ({ ...h, suggestOutcomes: [...h.suggestOutcomes] })),
    ports: {
      fc: CONCEPT_B_FC_PORTS.map((p) => ({ ...p })),
      jetson: CONCEPT_B_JETSON_PORTS.map((p) => ({ ...p })),
    },
    outcomes: CONCEPT_B_OUTCOMES.map((o) => ({ ...o })),
    emptyStep: emptyConceptBStep(),
  };
}
