/**
 * Hardware-intent catalog for the Configuration Wizard.
 *
 * Product lock: every step/card is ONE connected component and answers:
 *   1) מה מחובר — component identity
 *   2) לאן מחובר — FC and/or Jetson at pin/port level
 *   3) מה אני מצפה שיקרה — observable outcome (e.g. 3D fix)
 *
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
