/**
 * Pure helpers for USB serial «auto-connect» (MAVLink) — usable from routes and tests.
 * Why: keep scoring / error taxonomy / baud ordering testable outside Express handlers.
 */

/** Common MAVLink/USB-FC baud rates — 115200 and 57600 first; slower rates last for legacy boards. */
export const AUTO_CONNECT_BAUD_ORDER = Object.freeze([
  115200, 57600, 921600, 460800, 38400, 230400,
]);

/** Well-known USB-UART vendor IDs (hex, no 0x prefix — matches serialport `.list()` shape). */
const FC_UART_VID_WEIGHT = Object.freeze({
  '0403': 28, /* FTDI */
  '10c4': 28, /* Silicon Labs CP210x */
  '1a86': 24, /* Qinheng CH340/CH341 */
  '0483': 26, /* STMicroelectronics STM32 VCP */
  '2341': 18, /* Arduino SA */
});

/**
 * Prefer ports that look like flight-controller UART bridges over random USB devices.
 * @param {object} portInfo serialport descriptor
 * @returns {number}
 */
export function scoreUsbFcHint(portInfo) {
  const man = String(portInfo?.manufacturer || '').toLowerCase();
  let score = 0;
  if (/silicon|silabs|cp210|ftdi|stm|st micro|ch340|ch341|arduino|ardupilot|cube|px4|3dr|mrobot|holybro/i.test(man))
    score += 40;
  if (/jetson|camera|modem|android|printer|bulk/i.test(man)) score -= 25;

  const vidRaw = portInfo?.vendorId;
  const vid =
    vidRaw == null ? '' : String(vidRaw).toLowerCase().replace(/^0x/i, '').padStart(4, '0');
  if (vid && FC_UART_VID_WEIGHT[vid]) score += FC_UART_VID_WEIGHT[vid];

  return score;
}

/** @param {string} msg */
function normErr(msg) {
  return String(msg || '')
    .toLowerCase()
    .replace(/\r/g, '')
    .trim();
}

/**
 * Classify OS / serialport open failures (especially Windows COM exclusivity).
 * @param {string|undefined|null} rawMessage original Error.message (English from Node/driver).
 * @returns {{ code: 'port_busy' | 'generic', heMessage?: string }}
 */
export function classifySerialAccessError(rawMessage) {
  const m = normErr(rawMessage);
  const src = rawMessage?.toLowerCase() || '';
  const isWinComPath = /\b(com\d+)\b/i.test(rawMessage || '') || m.includes('\\.\\com');
  const looksBusy =
    m.includes('access denied') ||
    m.includes('eacces') ||
    /\bebusy\b/.test(m) ||
    m.includes('resource busy') ||
    m.includes('device is exclusively opened') ||
    m.includes('operation not permitted') ||
    (/cannot open/i.test(m) && /port|serial|com\d+/i.test(src)) ||
    ((m.includes('eagain') || m.includes('resource temporarily unavailable')) &&
      /\b(open|opening|tty|serial|com\d+)/i.test(src));
  /* Windows COM "in use" is usually "Access denied" from serialport opening COMn */
  const portBusyHint = looksBusy || (isWinComPath && m.includes('permission'));
  if (portBusyHint) {
    return {
      code: 'port_busy',
      heMessage:
        'היציאה תפוסה (גישה נחסמה) — סגור את Mission Planner, QGroundControl, מסוף ארדופילוט או כל תוכנה שפתוחה על אותה יציאת COM, ונסה שוב.',
    };
  }
  return { code: 'generic' };
}

/**
 * @param {{ ok?:boolean, phase?: string, code?: string }[]} attempts
 * @returns {{ headline: string, checklist: string[], primaryCode?: string }}
 */
export function buildAutoConnectFailureSuggestion(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const hadBusy = list.some((a) => a && a.code === 'port_busy');
  const hadHeartbeatMiss = list.some((a) => a && !a.ok && a.phase === 'heartbeat');
  /** @type {string[]} */
  const checklist = [];
  if (hadBusy) {
    checklist.push(
      'סגרו תוכנות GCS שמחזיקות את ה-COM באופן בלעדי (Mission Planner, QGroundControl, מסוכים ארדופילוט).',
    );
  }
  checklist.push(
    'בוחרים ידנית את אותה יציאה ובוד מתאים (115200 הפופולרי; לפעמים 57600 או מהירות גבוהה ב-UDP בלבד).',
  );
  checklist.push('מוודאים כבל נתונים יציב והבקר והרדיו דולקים לפני ניסוי.');
  checklist.push('מנסים יציאת USB אחרת במחשב (בעיה נפוצה במהבים ובנתבי USB).');

  let headline =
    'לא זוהה heartbeat מהבקר — ודאו שהטיסן דולק, המקלט מקושר, והבוד מתאים לחיבור הזה.';
  if (hadBusy) {
    headline =
      'לפחות אחת מהיציאות נחסמה ע"י תוכנה אחרת — זה הגורם השכיח בווינדוס.';
  } else if (hadHeartbeatMiss && !hadBusy) {
    headline =
      'פתיחת היציאות הצליחה אך לא הגיע MAVLink heartbeat — בדקו במיוחד בוד והאם הגדרת SERIAL בבקר מתאימה.';
  }

  return {
    headline,
    checklist,
    primaryCode: hadBusy ? 'port_busy' : undefined,
  };
}
