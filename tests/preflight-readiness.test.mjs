import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAV_SYS_STATUS_SENSOR_3D_ACCEL,
  MAV_SYS_STATUS_SENSOR_3D_MAG,
  buildPreflightReadiness,
  sensorBitReady,
} from '../lib/preflight-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bits(bit) {
  return { present: bit, enabled: bit, health: bit };
}

describe('preflight readiness checklist', () => {
  it('ticks only live telemetry and leaves the procedure rows manual', () => {
    const ready = buildPreflightReadiness({
      sensors: {
        present: MAV_SYS_STATUS_SENSOR_3D_ACCEL | MAV_SYS_STATUS_SENSOR_3D_MAG,
        enabled: MAV_SYS_STATUS_SENSOR_3D_ACCEL | MAV_SYS_STATUS_SENSOR_3D_MAG,
        health: MAV_SYS_STATUS_SENSOR_3D_ACCEL | MAV_SYS_STATUS_SENSOR_3D_MAG,
      },
      gpsFixType: 3,
      batteryV: 12.4,
      radioConnected: true,
      radioSimulator: false,
      cellularConnected: true,
      cam0: true,
      cam1: false,
      recording: true,
      jetsonReachable: true,
    });
    const byId = Object.fromEntries(ready.items.map((item) => [item.id, item]));
    expect(byId.accel).toMatchObject({ source: 'auto', state: 'ok' });
    expect(byId.compass.state).toBe('ok');
    expect(byId.gps.state).toBe('ok');
    expect(byId.battery.state).toBe('ok');
    expect(byId.rf_link.state).toBe('ok');
    expect(byId.cellular.state).toBe('ok');
    expect(byId.cam0.state).toBe('ok');
    expect(byId.cam1.state).toBe('open');
    expect(byId.logs.state).toBe('ok');
    expect(byId.jetson.labelHe).toBe('מחשב משימה (Jetson)');
    expect(byId.jetson.state).toBe('ok');
    for (const id of ['rc_cal', 'fs_rc', 'fs_rf', 'fs_battery', 'geofence', 'rtl_alt', 'rf_verified']) {
      expect(byId[id].source).toBe('manual');
      expect(byId[id].ticked).toBe(false);
      expect(byId[id].state).not.toBe('ok');
    }
    expect(ready.openIds).toContain('rf_verified');
    expect(ready.openIds).toContain('cam1');
  });

  it('does not treat a simulator or a missing sample as a real radio', () => {
    const sim = buildPreflightReadiness({
      radioConnected: true,
      radioSimulator: true,
      gpsFixType: 1,
      batteryV: 0,
    });
    const byId = Object.fromEntries(sim.items.map((item) => [item.id, item]));
    expect(byId.rf_link.state).toBe('open');
    expect(byId.rf_link.detailHe).toContain('סימולטור');
    expect(byId.gps.state).toBe('open');
    expect(byId.battery.state).toBe('open');
    expect(byId.accel.state).toBe('open');
    expect(sensorBitReady(null, MAV_SYS_STATUS_SENSOR_3D_ACCEL)).toBeNull();
    expect(sensorBitReady(bits(MAV_SYS_STATUS_SENSOR_3D_ACCEL), MAV_SYS_STATUS_SENSOR_3D_MAG)).toBe(false);
  });

  it('is on the diagnostics screen with the required terms and no nested scroll', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(repoRoot, 'public/styles.css'), 'utf8');
    const js = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
    const doc = fs.readFileSync(path.join(repoRoot, 'docs/preflight-readiness.md'), 'utf8');
    expect(html).toContain('id="preflightReadiness"');
    expect(html).toContain('מחשב משימה (Jetson)');
    expect(html).toContain('שלט RC');
    expect(html).toContain('CAM0');
    expect(html).toContain('CAM1');
    expect(js).toContain("localStorage.setItem(PREFLIGHT_MANUAL_KEY");
    expect(js).not.toMatch(/preflightReadyList[\s\S]{0,400}fetch\('\/api\/param/);
    const block = css.slice(css.indexOf('.preflight-ready {'), css.indexOf('.preflight-ready-item input'));
    expect(block).toContain('clamp(11px');
    expect(block).not.toMatch(/overflow:\s*auto/);
    expect(block).not.toMatch(/overflow:\s*hidden/);
    expect(block).not.toMatch(/text-overflow:\s*ellipsis/);
    for (const term of ['מחשב משימה (Jetson)', 'FC', 'RF', 'שלט RC', 'CAM0', 'CAM1']) {
      expect(doc).toContain(term);
    }
    expect(doc).toContain('גדר גאוגרפית');
    expect(doc).toContain('גובה RTL');
    expect(doc).toContain('מה נשאר פתוח');
  });
});
