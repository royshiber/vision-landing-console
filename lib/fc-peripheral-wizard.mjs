/**
 * Configuration wizard catalog for a fixed-wing ArduPlane.
 * Each row is an official param the existing FC write path can send.
 * Current values are never stored here.
 */

const SERIAL_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8];

export const WIZARD_SERIAL_PROTOCOLS = Object.freeze([0, 1, 2, 5, 9, 34]);
export const WIZARD_SERIAL_BAUD_CODES = Object.freeze([9, 19, 38, 57, 115, 230, 460, 921]);

const EXTRA_ENUMS = Object.freeze({
  GPS_TYPE: [0, 1, 2, 5, 9],
  ARSPD_TYPE: [0, 1, 2, 3, 6, 14],
  ARSPD_USE: [0, 1, 2],
  ARSPD_BUS: [0, 1, 2, 3],
  RNGFND1_TYPE: [0, 7, 8, 20, 25],
});

function serialWhere(index) {
  return { id: `serial${index}`, labelHe: `SERIAL${index}`, kind: 'serial', index };
}

function i2cWhere(index) {
  return { id: `i2c${index}`, labelHe: `אפיק I2C ${index}`, kind: 'i2c', index };
}

function row(key, value, meaningHe) {
  return { key, value, meaningHe };
}

function paramsFor(peripheralId, where) {
  const n = where.index;
  if (peripheralId === 'gps' && where.kind === 'serial') {
    return [
      row(`SERIAL${n}_PROTOCOL`, 5, 'פרוטוקול GPS'),
      row(`SERIAL${n}_BAUD`, 115, 'קצב 115200'),
      row('GPS_TYPE', 1, 'סוג GPS אוטומטי'),
    ];
  }
  if (peripheralId === 'gps' && where.kind === 'can') {
    return [row('GPS_TYPE', 9, 'סוג GPS על CAN')];
  }
  if (peripheralId === 'airspeed' && where.kind === 'i2c') {
    return [
      row('ARSPD_TYPE', 1, 'מד מהירות I2C-MS4525D0'),
      row('ARSPD_BUS', n, `אפיק I2C ${n}`),
      row('ARSPD_USE', 1, 'שימוש במד המהירות'),
    ];
  }
  if (peripheralId === 'airspeed' && where.kind === 'serial') {
    return [
      row(`SERIAL${n}_PROTOCOL`, 34, 'פרוטוקול מד מהירות'),
      row(`SERIAL${n}_BAUD`, 57, 'קצב 57600'),
      row('ARSPD_USE', 1, 'שימוש במד המהירות'),
    ];
  }
  if (peripheralId === 'rangefinder' && where.kind === 'serial') {
    return [
      row(`SERIAL${n}_PROTOCOL`, 9, 'פרוטוקול מד טווח'),
      row('RNGFND1_TYPE', 8, 'מד טווח LightWare טורי'),
    ];
  }
  if (peripheralId === 'rangefinder' && where.kind === 'i2c') {
    return [row('RNGFND1_TYPE', 7, 'מד טווח LightWare על I2C')];
  }
  if (peripheralId === 'camera' && where.kind === 'jetson') {
    return [
      row('PLND_ENABLED', 1, 'נחיתה מדויקת פעילה'),
      row('PLND_TYPE', 1, 'סוג נחיתה מדויקת MAVLink'),
    ];
  }
  if (peripheralId === 'telemetry' && where.kind === 'serial') {
    return [
      row(`SERIAL${n}_PROTOCOL`, 2, 'פרוטוקול MAVLink2'),
      row(`SERIAL${n}_BAUD`, 57, 'קצב 57600'),
    ];
  }
  if (peripheralId === 'companion' && where.kind === 'serial') {
    return [
      row(`SERIAL${n}_PROTOCOL`, 2, 'פרוטוקול MAVLink2'),
      row(`SERIAL${n}_BAUD`, 921, 'קצב 921600'),
    ];
  }
  return [];
}

export const WIZARD_PERIPHERALS = Object.freeze([
  {
    id: 'gps',
    labelHe: 'GPS',
    detailHe: 'מקלט ניווט על יציאת SERIAL או על CAN.',
    wheres: Object.freeze([
      ...SERIAL_INDEXES.map(serialWhere),
      { id: 'can', labelHe: 'CAN', kind: 'can', index: 1 },
    ]),
  },
  {
    id: 'airspeed',
    labelHe: 'מד מהירות אוויר',
    detailHe: 'צינור פיטו על אפיק I2C או על יציאת SERIAL.',
    wheres: Object.freeze([
      ...[0, 1, 2, 3].map(i2cWhere),
      ...SERIAL_INDEXES.map(serialWhere),
    ]),
  },
  {
    id: 'rangefinder',
    labelHe: 'מד טווח',
    detailHe: 'ליידר או מד טווח על יציאת SERIAL או על I2C.',
    wheres: Object.freeze([
      ...SERIAL_INDEXES.map(serialWhere),
      { id: 'i2c', labelHe: 'אפיק I2C', kind: 'i2c', index: 0 },
    ]),
  },
  {
    id: 'camera',
    labelHe: 'מצלמה',
    detailHe: 'מצלמת נחיתה על מחשב המשימה. הפרמטרים נכתבים לבקר הטיסה.',
    wheres: Object.freeze([
      { id: 'jetson', labelHe: 'מחשב משימה (Jetson)', kind: 'jetson', index: 0 },
    ]),
  },
  {
    id: 'telemetry',
    labelHe: 'רדיו טלמטריה',
    detailHe: 'רדיו קרקע על יציאת SERIAL של בקר הטיסה.',
    wheres: Object.freeze(SERIAL_INDEXES.map(serialWhere)),
  },
  {
    id: 'companion',
    labelHe: 'טורי מחשב משימה',
    detailHe: 'כבל טורי בין בקר הטיסה למחשב המשימה.',
    wheres: Object.freeze(SERIAL_INDEXES.map(serialWhere)),
  },
]);

function finite(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Accept a wizard param on the existing write validator.
 * Returns null when the key is not a wizard extra (caller keeps its own rules).
 * @returns {{ ok: true, value: number } | { ok: false, reason: string } | null}
 */
export function coercePeripheralWriteValue(key, rawValue) {
  const name = String(key || '');
  const n = finite(rawValue);
  const proto = /^SERIAL([1-8])_PROTOCOL$/.exec(name);
  if (proto) {
    if (n == null || !WIZARD_SERIAL_PROTOCOLS.includes(n)) return { ok: false, reason: 'invalid_enum' };
    return { ok: true, value: n };
  }
  const baud = /^SERIAL([1-8])_BAUD$/.exec(name);
  if (baud) {
    if (n == null || !WIZARD_SERIAL_BAUD_CODES.includes(n)) return { ok: false, reason: 'invalid_enum' };
    return { ok: true, value: n };
  }
  if (Object.prototype.hasOwnProperty.call(EXTRA_ENUMS, name)) {
    if (n == null || !EXTRA_ENUMS[name].includes(n)) return { ok: false, reason: 'invalid_enum' };
    return { ok: true, value: n };
  }
  return null;
}

export function listPeripheralWizardCatalog() {
  return {
    peripherals: WIZARD_PERIPHERALS.map((peripheral) => ({
      id: peripheral.id,
      labelHe: peripheral.labelHe,
      detailHe: peripheral.detailHe,
      wheres: peripheral.wheres.map((where) => ({
        id: where.id,
        labelHe: where.labelHe,
        kind: where.kind,
        params: paramsFor(peripheral.id, where),
      })),
    })),
  };
}

export function wizardAssignment(peripheralId, whereId) {
  const catalog = listPeripheralWizardCatalog();
  const peripheral = catalog.peripherals.find((item) => item.id === peripheralId);
  if (!peripheral) return null;
  const where = peripheral.wheres.find((item) => item.id === whereId);
  if (!where || !where.params.length) return null;
  return {
    peripheralId: peripheral.id,
    peripheralLabelHe: peripheral.labelHe,
    whereId: where.id,
    whereLabelHe: where.labelHe,
    params: where.params.map((item) => ({ ...item })),
  };
}
