import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'fs';
import net from 'node:net';
import os from 'node:os';
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
    expect(css).toMatch(/\.mission-data-picker\s*\{[^}]*z-index:\s*9600/);
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
    expect(open).toContain('placeMissionDataPicker(picker, x, y)');
    expect(open).not.toContain('innerHeight - 260');
    const place = sliceFunction(js, 'placeMissionDataPicker');
    expect(place).toContain('spaceAbove');
    expect(place).toContain('spaceBelow');
    expect(place).toContain("maxHeight = 'none'");
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
    expect(fns.formatMissionDataValue('mavlink.altitude', { mavlink: {} })).toBe('—');
    expect(fns.formatMissionDataValue('mavlink.airspeed', { mavlink: { airspeed: null } })).toBe('—');
    expect(fns.formatMissionDataValue('mavlink.pitchDeg', { mavlink: { connected: true } })).toBe('—');
    expect(fns.formatMissionDataValue('mavlink.gpsLat', { mavlink: { map: { gpsLat: 0, gpsLon: 0 } } })).toBe('—');
    expect(fns.formatMissionDataValue('mavlink.gpsLon', { mavlink: { map: {} } })).toBe('—');
    expect(fns.formatMissionDataValue('mavlink.gpsSats', { mavlink: { gpsSats: null } })).toBe('—');
    expect(fns.formatMissionDataValue('unknown.field', { mavlink: { altitude: 12 } })).toBe('—');
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe('mission data picker stays in the viewport', () => {
  let proc = null;
  let browser = null;

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });

  it('opens above a low click and keeps the whole list on screen', async () => {
    const port = await freePort();
    const dbPath = path.join(os.tmpdir(), `airvix-data-picker-${process.pid}.sqlite`);
    proc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        SQLITE_PATH: dbPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
      },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(up).toBe(true);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#missionDataGrid .mission-data-tile');
    await page.evaluate(() => {
      localStorage.removeItem('visionLandingFlightStackV1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#missionDataGrid .mission-data-tile');

    const openedLow = await page.evaluate(() => {
      openMissionDataPicker(1, 240, window.innerHeight - 36);
      const picker = document.getElementById('missionDataPicker');
      const chips = document.getElementById('missionDataPickerChips');
      const box = picker.getBoundingClientRect();
      const chipBoxes = [...chips.querySelectorAll('.mission-data-picker-chip')].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      });
      const actions = document.querySelector('.mission-data-picker-actions')?.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        height: box.height,
        vh: window.innerHeight,
        vw: window.innerWidth,
        chipCount: chipBoxes.length,
        chipBoxes,
        chipsOver: chips.scrollHeight - chips.clientHeight,
        actionsBottom: actions ? actions.bottom : 0,
        actionsTop: actions ? actions.top : 0,
        title: document.getElementById('missionDataPickerTitle')?.textContent || '',
      };
    });
    expect(openedLow.title).toBe('בחירת נתון');
    expect(openedLow.chipCount).toBeGreaterThanOrEqual(8);
    expect(openedLow.top).toBeGreaterThanOrEqual(0);
    expect(openedLow.left).toBeGreaterThanOrEqual(0);
    expect(openedLow.bottom).toBeLessThanOrEqual(openedLow.vh + 1);
    expect(openedLow.right).toBeLessThanOrEqual(openedLow.vw + 1);
    expect(openedLow.top).toBeLessThan(openedLow.vh - 36);
    expect(openedLow.chipsOver).toBeLessThanOrEqual(1);
    expect(openedLow.actionsBottom).toBeLessThanOrEqual(openedLow.vh + 1);
    expect(openedLow.actionsTop).toBeGreaterThanOrEqual(openedLow.top);
    for (const chip of openedLow.chipBoxes) {
      expect(chip.top).toBeGreaterThanOrEqual(openedLow.top - 1);
      expect(chip.bottom).toBeLessThanOrEqual(openedLow.bottom + 1);
      expect(chip.bottom).toBeLessThanOrEqual(openedLow.vh + 1);
      expect(chip.height).toBeGreaterThan(16);
    }

    const openedHigh = await page.evaluate(() => {
      openMissionDataPicker(0, 80, 48);
      const picker = document.getElementById('missionDataPicker');
      const box = picker.getBoundingClientRect();
      const chips = document.getElementById('missionDataPickerChips');
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        vh: window.innerHeight,
        vw: window.innerWidth,
        chipsOver: chips.scrollHeight - chips.clientHeight,
      };
    });
    expect(openedHigh.top).toBeGreaterThanOrEqual(48);
    expect(openedHigh.bottom).toBeLessThanOrEqual(openedHigh.vh + 1);
    expect(openedHigh.left).toBeGreaterThanOrEqual(0);
    expect(openedHigh.right).toBeLessThanOrEqual(openedHigh.vw + 1);
    expect(openedHigh.chipsOver).toBeLessThanOrEqual(1);

    await page.click('#flightDockActionsTab');
    const row = await page.evaluate(() => {
      closeMissionDataPicker();
      const data = document.querySelector('[data-mission-region="data"]');
      const hud = document.querySelector('.mission-region-horizon > .flight-hud');
      const messages = document.querySelector('[data-mission-region="messages"]');
      const rtl = document.getElementById('flightDockModeRtl');
      const tiles = [...document.querySelectorAll('.mission-data-tile')].map((el) => {
        const label = el.querySelector('.mission-data-label');
        const readout = el.querySelector('.mission-data-readout');
        return {
          h: el.getBoundingClientRect().height,
          text: (label?.getBoundingClientRect().height || 0) + (readout?.getBoundingClientRect().height || 0),
        };
      });
      return {
        dataH: data.getBoundingClientRect().height,
        hudH: hud.getBoundingClientRect().height,
        msgH: messages.getBoundingClientRect().height,
        rtlH: rtl.getBoundingClientRect().height,
        tiles,
      };
    });
    const tallest = Math.max(...row.tiles.map((tile) => tile.text));
    expect(row.dataH).toBeGreaterThanOrEqual(tallest);
    expect(row.dataH).toBeLessThanOrEqual(tallest + 28);
    expect(row.dataH).toBeLessThan(88);
    expect(row.hudH).toBeGreaterThanOrEqual(156);
    expect(row.hudH).toBeLessThanOrEqual(164);
    expect(row.msgH).toBeGreaterThan(row.hudH);
    expect(row.rtlH).toBeGreaterThanOrEqual(42);
  }, 40000);
});
