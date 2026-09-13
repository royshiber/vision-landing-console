import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../lib/db.mjs';
import { registerVisionLandingReadinessApi } from '../lib/routes/vision-landing-readiness-api.mjs';
import {
  FIELD_PREFLIGHT_IDS,
  UPDATE_READINESS_IDS,
  FIELD_PREFLIGHT_TONES,
  buildFieldPreflight,
  buildUpdateReadinessChecklist,
  resolveAskGoState,
  resolveFieldCameraHonesty,
  resolveTailscaleHonesty,
} from '../lib/field-preflight.mjs';
import { resolveCellularModem } from '../lib/cellular-modem.mjs';
import { VISION_LANDING_READINESS_IDS } from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Exp#1 field preflight honesty', () => {
  it('keeps a fixed row set and never invents camera GPS or modem', () => {
    const empty = buildFieldPreflight({});
    expect(empty.rows.map((r) => r.id)).toEqual([...FIELD_PREFLIGHT_IDS]);
    expect(empty.invented).toEqual({ camera: false, gps: false, modem: false });
    expect(empty.sendFlightCommands).toBe(false);
    expect(empty.liveNavSwitch).toBe(false);
    expect(empty.autoFlash).toBe(false);
    expect(empty.flashHumanGate).toBe(true);
    expect(JSON.stringify(empty)).not.toMatch(/"lat"\s*:\s*-?\d/);
    expect(JSON.stringify(empty)).not.toMatch(/"lon"\s*:\s*-?\d/);
    expect(rowById(empty, 'link_cellular').state).toBe('modem_absent');
    expect(rowById(empty, 'link_cellular').tone).toBe('absent');
    expect(rowById(empty, 'modem').state).toBe('modem_absent');
    expect(rowById(empty, 'modem').tone).toBe('absent');
    expect(rowById(empty, 'annotated_video').reason).toBe('modem_absent');
    expect(rowById(empty, 'annotated_video').available).toBe(false);
    expect(rowById(empty, 'annotated_video').neverRadio).toBe(true);
    expect(rowById(empty, 'cameras').state).toBe('unknown');
    expect(rowById(empty, 'cameras').stateHe).not.toBe('חי');
    expect(rowById(empty, 'companion').state).toBe('off');
    expect(rowById(empty, 'mavlink').state).toBe('unknown');
    expect(rowById(empty, 'archive').tone).toBe('warn');
    expect(rowById(empty, 'tailscale').tone).toBe('absent');
    expect(rowById(empty, 'ask_go').state).toBe('unknown');
    expect(rowById(empty, 'arm_land_blocked').tone).toBe('blocked');
    expect(rowById(empty, 'arm_land_blocked').send).toBe(false);
    expect(rowById(empty, 'nav_switch_blocked').tone).toBe('blocked');
    expect(rowById(empty, 'nav_switch_blocked').liveNavSwitch).toBe(false);
    expect(rowById(empty, 'plnd_observe').missingHe).toMatch(/תצוגה בלבד/);
    expect(empty.rows.every((r) => FIELD_PREFLIGHT_TONES.includes(r.tone))).toBe(true);
  });

  it('keeps cameras dry-run and absent honest and never live from Companion reachability', () => {
    expect(resolveFieldCameraHonesty({ companionReachable: true })).toBe('unknown');
    expect(resolveFieldCameraHonesty({
      companionReachable: true,
      cameraOk: true,
      dryRun: true,
    })).toBe('dry_run');
    expect(resolveFieldCameraHonesty({
      companionReachable: true,
      cameraOk: true,
      source: 'synthetic',
    })).toBe('dry_run');
    expect(resolveFieldCameraHonesty({
      companionReachable: true,
      cameraOk: false,
    })).toBe('absent');
    expect(resolveFieldCameraHonesty({
      companionReachable: true,
      cameraOk: true,
    })).toBe('live');
    const dry = buildFieldPreflight({
      companion: { jetson: 'reachable', reachable: true },
      overlay: { extras: { dry_run: true, camera_ok: true } },
    });
    expect(rowById(dry, 'cameras').state).toBe('dry_run');
    expect(rowById(dry, 'cameras').tone).toBe('warn');
    expect(rowById(dry, 'cameras').stateHe).toBe('הרצה יבשה');
    const absent = buildFieldPreflight({
      companion: { jetson: 'reachable', reachable: true },
      overlay: { vision: { camera_ok: false } },
    });
    expect(rowById(absent, 'cameras').state).toBe('absent');
    expect(rowById(absent, 'cameras').tone).toBe('absent');
    const reachableOnly = buildFieldPreflight({
      companion: { jetson: 'reachable', reachable: true },
    });
    expect(rowById(reachableOnly, 'cameras').state).not.toBe('live');
  });

  it('surfaces status-file missing as modem_absent without claiming a stick', () => {
    const merged = resolveCellularModem({
      local: { present: false, reason: 'modem_absent' },
      companionModem: { present: false, reason: 'modem_absent', statusFileMissing: true },
    });
    expect(merged.present).toBe(false);
    expect(merged.reason).toBe('modem_absent');
    expect(merged.statusFileMissing).toBe(true);
    expect(merged.reasonHe).toMatch(/אין קובץ סטטוס/);
    const snap = buildFieldPreflight({
      modemPresent: false,
      modem: merged,
    });
    expect(rowById(snap, 'modem').state).toBe('modem_absent');
    expect(rowById(snap, 'modem').statusFileMissing).toBe(true);
    expect(rowById(snap, 'modem').missingHe).toMatch(/אין קובץ סטטוס/);
    expect(rowById(snap, 'link_cellular').tone).toBe('absent');
  });

  it('keeps ARM / LAND and live nav switch blocked after Ask GO', () => {
    expect(resolveAskGoState(true)).toBe('on');
    expect(resolveAskGoState(false)).toBe('off');
    const go = buildFieldPreflight({ askGoActive: true });
    expect(rowById(go, 'ask_go').state).toBe('on');
    expect(rowById(go, 'ask_go').missingHe).toMatch(/חימוש ונחיתה חסומים/);
    expect(rowById(go, 'arm_land_blocked').tone).toBe('blocked');
    expect(rowById(go, 'arm_land_blocked').tokens).toEqual(['ARM', 'LAND', 'auto-land']);
    expect(rowById(go, 'nav_switch_blocked').tone).toBe('blocked');
    expect(go.sendFlightCommands).toBe(false);
    expect(go.liveNavSwitch).toBe(false);
  });

  it('does not treat Companion reachability as Tailscale up', () => {
    expect(resolveTailscaleHonesty({ companionReachable: true })).toBe('unknown');
    expect(resolveTailscaleHonesty({ companionReachable: false })).toBe('absent');
    expect(resolveTailscaleHonesty({ companionReachable: true, tailscaleUp: true })).toBe('up');
    const home = buildFieldPreflight({
      companion: { jetson: 'reachable', reachable: true },
    });
    expect(rowById(home, 'companion').tone).toBe('ok');
    expect(rowById(home, 'tailscale').state).toBe('unknown');
    expect(rowById(home, 'tailscale').tone).toBe('warn');
    expect(rowById(home, 'modem').state).toBe('modem_absent');
  });

  it('keeps update readiness staged and never offers a flash path', () => {
    const update = buildUpdateReadinessChecklist({});
    expect(update.steps.map((s) => s.id)).toEqual([...UPDATE_READINESS_IDS]);
    expect(update.autoFlash).toBe(false);
    expect(update.fcFirmwareHumanGate).toBe(true);
    expect(update.steps.find((s) => s.id === 'fc_flash_gate')).toMatchObject({
      ok: false,
      humanGate: true,
      tone: 'blocked',
    });
    expect(update.steps.find((s) => s.id === 'backup_rollback').humanGate).toBe(true);
    expect(update.steps.find((s) => s.id === 'link_quality').ok).toBe(false);
    expect(update.steps.find((s) => s.id === 'fc_version').ok).toBe(false);
    const known = buildUpdateReadinessChecklist({
      consoleVersion: '1.02.317',
      jetsonVersion: '2.3.5',
      fcVersion: 'ArduPlane 4.5',
      linkQuality: { known: true, percent: 50, bars: 2 },
    });
    expect(known.steps.find((s) => s.id === 'console_version').ok).toBe(true);
    expect(known.steps.find((s) => s.id === 'jetson_version').ok).toBe(true);
    expect(known.steps.find((s) => s.id === 'fc_version').ok).toBe(true);
    expect(known.steps.find((s) => s.id === 'link_quality').ok).toBe(true);
    expect(known.autoFlash).toBe(false);
  });
});

describe('Exp#1 field preflight API and UI', () => {
  it('extends landing-readiness without duplicating vision rows', async () => {
    const tmpPath = path.join(os.tmpdir(), `test-vlc-field-${Date.now()}.sqlite`);
    const db = openDatabase(tmpPath);
    const app = express();
    app.use(express.json());
    registerVisionLandingReadinessApi(app, {
      db,
      env: {},
      companionService: {
        mode: 'off',
        getSseOverlay() {
          return { companion: { mode: 'off', reachable: false } };
        },
      },
    });
    const server = await listen(app);
    const addr = server.address();
    const r = await fetch(`http://127.0.0.1:${addr.port}/api/vision/landing-readiness`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.rows.map((row) => row.id)).toEqual([...VISION_LANDING_READINESS_IDS]);
    expect(j.fieldPreflight.kind).toBe('exp1_field_preflight');
    expect(j.fieldPreflight.rows.map((row) => row.id)).toEqual([...FIELD_PREFLIGHT_IDS]);
    expect(j.fieldPreflight.invented.modem).toBe(false);
    expect(rowById(j.fieldPreflight, 'modem').state).toBe('modem_absent');
    expect(rowById(j.fieldPreflight, 'arm_land_blocked').tone).toBe('blocked');
    expect(j.fieldPreflight.update.autoFlash).toBe(false);
    await new Promise((resolve) => server.close(resolve));
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('paints the Hebrew field checklist and update gate without a flash button', () => {
    expect(html).toContain('id="fieldPreflight"');
    expect(html).toContain('id="fieldPreflightList"');
    expect(html).toContain('id="updateReadinessChecklist"');
    expect(html).toMatch(/מוכנות שדה · ניסוי אחד/);
    expect(html).toMatch(/הבזקה דורשת אישור/);
    expect(html).not.toMatch(/id="fcFlashBtn"|id="cellularFlashBtn"/);
    expect(css).toMatch(/data-tone="blocked"/);
    expect(css).toMatch(/data-tone="absent"/);
    expect(css).toMatch(/data-tone="fail"/);
    expect(js).toContain('function renderFieldPreflightRows');
    expect(js).toContain('function paintFieldPreflight');
    expect(js).toContain('function renderUpdateReadinessSteps');
    expect(js).toContain('dataset.statusFile');
    expect(js).toContain('FIELD_PREFLIGHT_COMPACT_IDS');
    expect(js).toContain('arm_land_blocked');
    expect(js).toContain('nav_switch_blocked');
  });

  it('keeps the cellular endpoint status path honest when the file is missing', () => {
    const result = spawnSync(path.join(repoRoot, 'scripts', 'jetson-cellular', 'cellular-mavlink-endpoint.sh'), [
      '--dry-run',
      '--status',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIRVIX_E3372_STATUS_FILE: path.join(os.tmpdir(), `missing-e3372-${Date.now()}.status`),
      },
      cwd: repoRoot,
    });
    expect(result.status, result.stderr).toBe(0);
    const snap = JSON.parse(result.stdout);
    expect(snap.bound).toBe(false);
    expect(snap.port).toBe(14560);
    expect(snap.modemPresent).toBe(false);
    expect(snap.statusFileMissing).toBe(true);
    expect(snap.reason).toBe('modem_absent');
    expect(snap.companionHttpCommandPath).toBe(false);
    expect(snap.flightCommands).toBe(false);
  });
});
