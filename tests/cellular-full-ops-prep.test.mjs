import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  companionModemReport,
  probeHuaweiE3372,
  resolveCellularModem,
} from '../lib/cellular-modem.mjs';
import { mapCompanionStatus } from '../lib/companion-status.mjs';
import {
  annotatedStreamPresent,
  annotatedVideoAvailability,
  cellularConnectGate,
  cellularUpdateReadiness,
  commandLinkOpsPath,
  pickActiveLink,
  summarizeDualLink,
} from '../lib/dual-link.mjs';
import { qualityFromCompanionSignal } from '../lib/comm-links.mjs';
import { pickLiveMavlinkConnection } from '../lib/mavlink-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

describe('cellular full-ops prep honesty', () => {
  it('pins APP_VERSION at 1.02.347', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toMatch(/export const APP_VERSION = '1\.02\.\d+'/);
    expect(pkg.version).toMatch(/^1\.02\.\d+$/);
    expect(version).toContain(`export const APP_VERSION = '${pkg.version}'`);
  });

  it('never invents modem present from Companion reachability alone', () => {
    const local = probeHuaweiE3372({ env: {}, existsSync: () => false });
    expect(local.present).toBe(false);
    expect(companionModemReport({ jetson: 'reachable', overlay: {} })).toBeNull();
    const merged = resolveCellularModem({
      local,
      companionModem: companionModemReport({
        jetson: 'reachable',
        health: {},
      }),
    });
    expect(merged.present).toBe(false);
    expect(merged.reason).toBe('modem_absent');
    expect(cellularConnectGate({ modemPresent: merged.present, host: '10.0.0.8' }).state)
      .toBe('modem_absent');
  });

  it('maps Companion modem onto the overlay so the console can consume it', () => {
    const mapped = mapCompanionStatus({
      modem: { present: false, reason: 'modem_absent' },
      system: {},
      fc: {},
    });
    expect(mapped.modem.present).toBe(false);
    expect(mapped.modem.reason).toBe('modem_absent');
    const live = mapCompanionStatus({
      modem: { present: true, reason: 'device_node', ip: '192.168.8.100' },
      system: {},
      fc: {},
    });
    expect(live.modem.present).toBe(true);
    expect(companionModemReport({ overlay: live }).present).toBe(true);
  });

  it('uses an explicit Companion modem report when the Jetson status file says present', () => {
    const local = probeHuaweiE3372({ env: {}, existsSync: () => false });
    const report = companionModemReport({
      overlay: {
        modem: {
          present: true,
          reason: 'device_node',
          iface: 'usb0',
          ip: '192.168.8.100',
          transport: 'cdc_ether',
        },
      },
    });
    const merged = resolveCellularModem({ local, companionModem: report });
    expect(merged.present).toBe(true);
    expect(merged.source).toBe('companion');
    expect(merged.ip).toBe('192.168.8.100');
    expect(cellularConnectGate({ modemPresent: merged.present, host: '10.0.0.8' }).allowed)
      .toBe(true);
    const absentReport = resolveCellularModem({
      local,
      companionModem: { present: false, reason: 'modem_absent' },
    });
    expect(absentReport.present).toBe(false);
    expect(absentReport.source).toBe('companion');
  });

  it('keeps dual-link command pick unchanged and params follow that MAVLink link', () => {
    expect(pickActiveLink({ radio: 'connected', cellular: 'connected', preferred: 'cellular' }))
      .toBe('cellular');
    expect(pickActiveLink({ radio: 'connected', cellular: 'connected', preferred: 'radio' }))
      .toBe('radio');
    expect(pickActiveLink({ radio: 'connected', cellular: 'modem_absent' })).toBe('radio');
    const radio = { id: 1, connected: true, linkRole: 'radio' };
    const cell = { id: 2, connected: true, linkRole: 'cellular' };
    expect(pickLiveMavlinkConnection([radio, cell], 2)).toBe(cell);
    expect(pickLiveMavlinkConnection([radio, cell], 1)).toBe(radio);
    const ops = commandLinkOpsPath({
      active: 'cellular',
      commandLinkId: 2,
      modemPresent: true,
      companionReachable: true,
    });
    expect(ops.paramsFollowCommandLink).toBe(true);
    expect(ops.paramsVia).toBe('cellular_mavlink');
    expect(ops.companionHttpCommandPath).toBe(false);
    expect(ops.flightCommands).toBe(false);
  });

  it('never marks annotated video live on radio or without a modem / stream', () => {
    expect(annotatedStreamPresent({ overlay: { video: { annotated_pipeline: 'none' } } })).toBe(false);
    expect(annotatedStreamPresent({
      overlay: { video: { annotated_pipeline: 'encoder', annotated_fps: 12 } },
    })).toBe(true);
    const radioUp = annotatedVideoAvailability({
      cellular: 'disconnected',
      modemPresent: true,
      streamPresent: true,
    });
    expect(radioUp.available).toBe(false);
    expect(radioUp.neverRadio).toBe(true);
    const noModem = annotatedVideoAvailability({
      cellular: 'connected',
      modemPresent: false,
      streamPresent: true,
    });
    expect(noModem.available).toBe(false);
    expect(noModem.reason).toBe('modem_absent');
    const snap = summarizeDualLink({
      radio: 'connected',
      cellular: 'connected',
      modemPresent: false,
      streamPresent: true,
    });
    expect(snap.cellular).toBe('modem_absent');
    expect(snap.video.available).toBe(false);
  });

  it('shows quality percent only from a real metric and keeps update readiness gated', () => {
    expect(qualityFromCompanionSignal({ present: true }).known).toBe(false);
    expect(qualityFromCompanionSignal({ rsrp: -90 }).percent).toBeNull();
    expect(qualityFromCompanionSignal({ csq: 18 }).known).toBe(true);
    const update = cellularUpdateReadiness({ companionReachable: false });
    expect(update.autoDeployFc).toBe(false);
    expect(update.fcFirmwareHumanGate).toBe(true);
    expect(update.companionApplyRestart).toBe(false);
    expect(update.steps[2].id).toBe('fc_firmware');
    expect(update.steps[2].ok).toBe(false);
  });

  it('paints a Hebrew ops checklist without a flash button', () => {
    expect(html).toContain('id="cellularOpsChecklist"');
    expect(html).toContain('data-step="modem"');
    expect(html).toContain('data-step="update"');
    expect(html).toMatch(/עדכון בקר נשאר לאישור/);
    expect(html).not.toMatch(/id="fcFlashBtn"|id="cellularFlashBtn"/);
    expect(js).toContain('function paintCellularOpsChecklist');
    expect(js).toContain("התחבר");
  });

  it('dry-runs console honesty without inventing a cellular up-state', () => {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'cellular-modem-dry-run.mjs'),
      '--dry-run',
    ], {
      encoding: 'utf8',
      env: { ...process.env, CELLULAR_MODEM_MOCK: '' },
      cwd: repoRoot,
    });
    expect(result.status, result.stderr).toBe(0);
    const snap = JSON.parse(result.stdout);
    expect(snap.present).toBe(false);
    expect(snap.reason).toBe('modem_absent');
    expect(snap.cellular).toBe('modem_absent');
    expect(snap.video.available).toBe(false);
    expect(snap.ops.companionHttpCommandPath).toBe(false);
    expect(snap.update.autoDeployFc).toBe(false);
    expect(snap.autoDeployFc).toBe(false);
    expect(snap.flightCommands).toBe(false);
  });
});
