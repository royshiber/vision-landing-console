/**
 * Huawei E3372 probe for the cellular MAVLink path.
 *
 * The stick is not required at build time. Default in this VM / lab is absent.
 * Set CELLULAR_MODEM_MOCK=present only for UI demos of a plugged-in modem.
 * Never treats Companion-HTTP as the cellular command path.
 */

const DEFAULT_HINTS = Object.freeze([
  '/dev/ttyUSB0',
  '/dev/ttyUSB1',
  '/dev/cdc-wdm0',
]);

export const CELLULAR_MODEM_MODEL = 'Huawei E3372';

function envFlag(env, name) {
  return String(env?.[name] || '').trim().toLowerCase();
}

function absentModem() {
  return {
    present: false,
    model: CELLULAR_MODEM_MODEL,
    transport: null,
    iface: null,
    ip: null,
    error: null,
    reason: 'modem_absent',
    reasonHe: 'מודם לא מחובר.',
    source: 'local',
  };
}

export function probeHuaweiE3372({
  env = process.env,
  existsSync = null,
  deviceHints = DEFAULT_HINTS,
} = {}) {
  const mock = envFlag(env, 'CELLULAR_MODEM_MOCK');
  if (mock === 'present' || mock === '1' || mock === 'true') {
    return {
      present: true,
      model: CELLULAR_MODEM_MODEL,
      transport: 'mock',
      iface: 'mock0',
      ip: null,
      error: null,
      reason: 'mock_present',
      reasonHe: 'מודם מדומה מחובר לבדיקה.',
      source: 'local_mock',
    };
  }
  if (typeof existsSync === 'function') {
    const found = deviceHints.find((p) => {
      try { return existsSync(p); } catch { return false; }
    });
    if (found) {
      return {
        present: true,
        model: CELLULAR_MODEM_MODEL,
        transport: 'usb',
        iface: found,
        ip: null,
        error: null,
        reason: 'device_node',
        reasonHe: 'מודם סלולר זוהה.',
        source: 'local',
      };
    }
  }
  return absentModem();
}

/**
 * Companion overlay / health may carry the Jetson E3372 status file.
 * Jetson reachable alone is not a modem. Missing object → null (use local probe).
 */
export function companionModemReport(companion) {
  if (!companion || typeof companion !== 'object') return null;
  const overlay = companion.overlay && typeof companion.overlay === 'object'
    ? companion.overlay
    : companion;
  const health = companion.health && typeof companion.health === 'object'
    ? companion.health
    : {};
  const overlayHealth = overlay.health && typeof overlay.health === 'object'
    ? overlay.health
    : {};
  const candidates = [
    companion.modem,
    overlay.modem,
    health.modem,
    overlayHealth.modem,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    if ('present' in c || 'reason' in c || 'state' in c) return c;
  }
  return null;
}

function cleanIp(value) {
  const s = String(value || '').trim();
  if (!s || s === 'null' || s === '0.0.0.0' || s === '::') return null;
  return s;
}

function cleanError(value) {
  const s = String(value || '').trim();
  return s || null;
}

/**
 * Prefer an explicit Companion modem report (stick lives on the Jetson).
 * Never invent present from Companion HTTP reachability.
 */
export function resolveCellularModem({ local = null, companionModem = null } = {}) {
  const fallback = local && typeof local === 'object'
    ? {
        ip: null,
        error: null,
        source: 'local',
        ...local,
        present: local.present === true,
      }
    : absentModem();

  if (!companionModem || typeof companionModem !== 'object') {
    return fallback;
  }

  const present = companionModem.present === true;
  const reason = present
    ? String(companionModem.reason || companionModem.state || 'device_node')
    : String(companionModem.reason || companionModem.state || 'modem_absent');
  const isMock = reason === 'mock_present' || companionModem.transport === 'mock';
  return {
    present,
    model: companionModem.model || CELLULAR_MODEM_MODEL,
    transport: companionModem.transport || null,
    iface: companionModem.iface || null,
    ip: cleanIp(companionModem.ip),
    error: cleanError(companionModem.error),
    reason: present ? reason : 'modem_absent',
    reasonHe: present
      ? (isMock
        ? 'מודם מדומה ממחשב משימה.'
        : (companionModem.reasonHe || 'מודם סלולר זוהה במחשב משימה.'))
      : (companionModem.reasonHe || 'מודם לא מחובר.'),
    source: 'companion',
    mock: isMock,
  };
}
