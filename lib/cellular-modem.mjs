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
      reason: 'mock_present',
      reasonHe: 'מודם מדומה מחובר לבדיקה.',
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
        reason: 'device_node',
        reasonHe: 'מודם סלולר זוהה.',
      };
    }
  }
  return {
    present: false,
    model: CELLULAR_MODEM_MODEL,
    transport: null,
    iface: null,
    reason: 'modem_absent',
    reasonHe: 'מודם לא מחובר.',
  };
}
