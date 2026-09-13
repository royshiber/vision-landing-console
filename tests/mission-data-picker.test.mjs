import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FLIGHT_HUD_CATALOG, suggestMissionDataFields } from '../lib/flight-hud-resolve.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function sliceConst(src, name) {
  const start = src.indexOf(`const ${name} = Object.freeze([`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 2);
    }
  }
  throw new Error(`unclosed const ${name}`);
}

function loadSlotFns() {
  const catalog = sliceConst(js, 'MISSION_DATA_CATALOG');
  const defaults = sliceConst(js, 'DEFAULT_MISSION_DATA_SLOTS');
  const src = [
    'const MISSION_DATA_SLOTS_KEY = "visionLandingMissionDataSlotsV1";',
    catalog,
    defaults,
    sliceFunction(js, 'missionLayoutStoreGet'),
    sliceFunction(js, 'missionLayoutStoreSet'),
    sliceFunction(js, 'defaultMissionDataSlots'),
    sliceFunction(js, 'readMissionDataSlots'),
    sliceFunction(js, 'writeMissionDataSlots'),
    sliceFunction(js, 'suggestMissionDataFields'),
    'const GPS_FIX_LABELS = ["אין GPS", "אין Fix", "2D Fix", "3D Fix", "DGPS", "RTK Float", "RTK Fixed"];',
    'const ARDUPILOT_PLANE_MODES = { 0: "MANUAL" };',
    sliceFunction(js, 'shortMissionLinkReadout'),
    sliceFunction(js, 'getPayloadValue'),
    'function gpsVisionDeltaMeters() { return null; }',
    sliceFunction(js, 'formatMissionDataValue'),
    'return { suggestMissionDataFields, readMissionDataSlots, writeMissionDataSlots, defaultMissionDataSlots, formatMissionDataValue, MISSION_DATA_CATALOG };',
  ].join('\n');
  const store = {};
  const localStorage = {
    getItem(key) { return store[key] ?? null; },
    setItem(key, value) { store[key] = String(value); },
  };
  const document = { getElementById() { return null; } };
  return new Function('localStorage', 'document', src)(localStorage, document);
}

describe('Mission data-slot field picker', () => {
  it('opens from right-click and long-press with a Hebrew search popover', () => {
    expect(html).toContain('id="missionDataPicker"');
    expect(html).toContain('id="missionDataPickerTitle"');
    expect(html).toContain('>בחירת נתון<');
    expect(html).toContain('id="missionDataPickerInput"');
    expect(html).toContain('id="missionDataPickerChips"');
    expect(html).toContain('id="missionDataPickerApply"');
    expect(html).toContain('id="missionDataPickerClose"');
    expect(html).toContain('>ביטול<');
    expect(html).toContain('data-mission-data-slot="0"');
    expect(html).toContain('קליק ימני או לחיצה ארוכה על אריח לבחירת שדה');
    expect(css).toMatch(/\.mission-data-picker\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.mission-data-picker\s*\{[^}]*direction:\s*rtl/);
    expect(css).toMatch(/\.mission-data-picker-chip-mav\s*\{[^}]*direction:\s*ltr/);
    const init = sliceFunction(js, 'initMissionDataPicker');
    const bind = sliceFunction(js, 'bindMissionDataSlotPress');
    const open = sliceFunction(js, 'openMissionDataPicker');
    expect(bind).toContain("addEventListener('contextmenu'");
    expect(bind).toContain('e.preventDefault()');
    expect(bind).toContain("addEventListener('touchstart'");
    expect(bind).toContain('520');
    expect(open).toContain("classList.remove('hidden')");
    expect(open).toContain('data-open-slot');
    expect(open).toContain('document.body.appendChild(picker)');
    expect(html).not.toMatch(/id="missionDataGrid"[\s\S]{0,800}id="missionDataPicker"/);
    expect(init).toContain('missionDataPickerApply');
    expect(init + bind + open).not.toMatch(/FLIGHT_ACTION|PARAM_SET|\/apply|\/restart/);
    expect(init + bind).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });

  it('persists a catalog choice per slot', () => {
    const fns = loadSlotFns();
    const slots = fns.defaultMissionDataSlots();
    slots[1] = { key: 'mavlink.pitchDeg', label: 'פיץ׳', unit: '°', mav: 'ATTITUDE.pitch' };
    fns.writeMissionDataSlots(slots);
    const saved = fns.readMissionDataSlots();
    expect(saved[1].key).toBe('mavlink.pitchDeg');
    expect(saved[1].mav).toBe('ATTITUDE.pitch');
    expect(saved[0].key).toBe('mavlink.flightMode');
    expect(saved[2].key).toBe('mavlink.airspeed');
  });

  it('keeps empty and unknown fields honest', () => {
    const fns = loadSlotFns();
    expect(fns.formatMissionDataValue('mavlink.altitude', { mavlink: {} })).toBe('--');
    expect(fns.formatMissionDataValue('mavlink.airspeed', { mavlink: { airspeed: null } })).toBe('--');
    expect(fns.formatMissionDataValue('mavlink.pitchDeg', { mavlink: { connected: true } })).toBe('--');
    expect(fns.formatMissionDataValue('mavlink.gpsLat', { mavlink: { map: { gpsLat: 0, gpsLon: 0 } } })).toBe('--');
    expect(fns.formatMissionDataValue('mavlink.gpsLon', { mavlink: { map: {} } })).toBe('--');
    expect(fns.formatMissionDataValue('mavlink.gpsSats', { mavlink: { gpsSats: null } })).toBe('--');
    expect(fns.formatMissionDataValue('unknown.field', { mavlink: { altitude: 12 } })).toBe('--');
    expect(fns.formatMissionDataValue('mavlink.altitude', { mavlink: { altitude: 41.5 } })).toBe('41.5');
    const bogus = fns.suggestMissionDataFields('קו רוחב 32.1');
    expect(JSON.stringify(bogus)).not.toMatch(/32\.1/);
    expect(fns.MISSION_DATA_CATALOG.some((e) => e.key === 'mavlink.gpsLat')).toBe(false);
  });

  it('reuses the HUD catalog including technical MAVLink keys', () => {
    const fns = loadSlotFns();
    const clientKeys = fns.MISSION_DATA_CATALOG.map((e) => e.key).sort();
    const hudKeys = FLIGHT_HUD_CATALOG.map((e) => e.key).sort();
    expect(clientKeys).toEqual(hudKeys);
    expect(fns.MISSION_DATA_CATALOG.find((e) => e.key === 'mavlink.altitude')?.mav).toBe('VFR_HUD.alt');
    expect(fns.MISSION_DATA_CATALOG.find((e) => e.key === 'mavlink.pitchDeg')?.mav).toBe('ATTITUDE.pitch');
    const alt = fns.suggestMissionDataFields('VFR_HUD.alt');
    expect(alt.exact?.key).toBe('mavlink.altitude');
    const pitch = suggestMissionDataFields('ATTITUDE.pitch');
    expect(pitch.exact?.key).toBe('mavlink.pitchDeg');
    expect(sliceFunction(js, 'renderMissionDataPickerChips')).toContain('mission-data-picker-chip-mav');
  });
});
