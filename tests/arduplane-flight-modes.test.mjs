import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ARDUPILOT_PLANE_MODES,
  ARDUPLANE_QUADPLANE_MODES,
  arduPlaneModeName,
  arduPlaneModeInfo,
} from '../lib/arduplane-flight-modes.mjs';
import { ARDUPILOT_COPTER_MODES, arduCopterModeName } from '../lib/arducopter-flight-modes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ArduPlane/mode.h Mode::Number, verified against ArduPilot master 2026-09-25. */
const PLANE_MODE_H = {
  0: 'MANUAL',
  1: 'CIRCLE',
  2: 'STABILIZE',
  3: 'TRAINING',
  4: 'ACRO',
  5: 'FBWA',
  6: 'FBWB',
  7: 'CRUISE',
  8: 'AUTOTUNE',
  10: 'AUTO',
  11: 'RTL',
  12: 'LOITER',
  13: 'TAKEOFF',
  14: 'AVOID_ADSB',
  15: 'GUIDED',
  16: 'INITIALISING',
  17: 'QSTABILIZE',
  18: 'QHOVER',
  19: 'QLOITER',
  20: 'QLAND',
  21: 'QRTL',
  22: 'QAUTOTUNE',
  23: 'QACRO',
  24: 'THERMAL',
  25: 'LOITER_ALT_QLAND',
  26: 'AUTOLAND',
};

/** ArduCopter/mode.h Mode::Number, verified against ArduPilot master 2026-09-25. */
const COPTER_MODE_H = {
  0: 'STABILIZE',
  1: 'ACRO',
  2: 'ALT_HOLD',
  3: 'AUTO',
  4: 'GUIDED',
  5: 'LOITER',
  6: 'RTL',
  7: 'CIRCLE',
  9: 'LAND',
  11: 'DRIFT',
  13: 'SPORT',
  14: 'FLIP',
  15: 'AUTOTUNE',
  16: 'POSHOLD',
  17: 'BRAKE',
  18: 'THROW',
  19: 'AVOID_ADSB',
  20: 'GUIDED_NOGPS',
  21: 'SMART_RTL',
  22: 'FLOWHOLD',
  23: 'FOLLOW',
  24: 'ZIGZAG',
  25: 'SYSTEMID',
  26: 'AUTOROTATE',
  27: 'AUTO_RTL',
  28: 'TURTLE',
};

function extractConstObject(src, name) {
  const token = `const ${name} = {`;
  const start = src.indexOf(token);
  if (start < 0) throw new Error(`missing ${name}`);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return Function(`"use strict"; return (${src.slice(brace, i + 1)});`)();
      }
    }
  }
  throw new Error(`unclosed ${name}`);
}

describe('ArduPlane mode table', () => {
  it('matches ArduPlane/mode.h and does not call 14 LAND', () => {
    expect(ARDUPILOT_PLANE_MODES).toEqual(PLANE_MODE_H);
    expect(arduPlaneModeName(14)).toBe('AVOID_ADSB');
    expect(arduPlaneModeName(13)).toBe('TAKEOFF');
    expect(arduPlaneModeName(24)).toBe('THERMAL');
    expect(arduPlaneModeName(26)).toBe('AUTOLAND');
    expect(arduPlaneModeName(9)).toBe(null);
    expect(arduPlaneModeName(14)).not.toBe('LAND');
    expect(Object.values(ARDUPILOT_PLANE_MODES)).not.toContain('LAND');
  });

  it('marks quadplane-only modes', () => {
    for (const id of [17, 18, 19, 20, 21, 22, 23, 25]) {
      expect(arduPlaneModeInfo(id)?.quadplaneOnly).toBe(true);
    }
    expect(arduPlaneModeInfo(13)?.quadplaneOnly).toBe(false);
    expect(arduPlaneModeInfo(14)?.quadplaneOnly).toBe(false);
    expect(arduPlaneModeInfo(24)?.quadplaneOnly).toBe(false);
    expect(arduPlaneModeInfo(26)?.quadplaneOnly).toBe(false);
    expect(ARDUPLANE_QUADPLANE_MODES.has(22)).toBe(true);
  });

  it('keeps public/app.js and sim-lab on the same plane table', () => {
    const app = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
    const sim = fs.readFileSync(path.join(repoRoot, 'public/sim-lab.mjs'), 'utf8');
    expect(extractConstObject(app, 'ARDUPILOT_PLANE_MODES')).toEqual(ARDUPILOT_PLANE_MODES);
    expect(extractConstObject(app, 'ARDUPILOT_COPTER_MODES')).toEqual(ARDUPILOT_COPTER_MODES);
    expect(extractConstObject(sim, 'AP_MODES')).toEqual(ARDUPILOT_PLANE_MODES);
    expect(app).toContain("return '#' + (raw ?? '--')");
    expect(sim).toContain('?? `#${m.flightMode}`');
  });
});

describe('ArduCopter mode table', () => {
  it('matches ArduCopter/mode.h', () => {
    expect(ARDUPILOT_COPTER_MODES).toEqual(COPTER_MODE_H);
    expect(arduCopterModeName(9)).toBe('LAND');
    expect(arduCopterModeName(6)).toBe('RTL');
    expect(arduCopterModeName(14)).toBe('FLIP');
    expect(arduCopterModeName(19)).toBe('AVOID_ADSB');
  });
});
