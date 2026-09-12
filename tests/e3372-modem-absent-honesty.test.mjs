import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHuaweiE3372 } from '../lib/cellular-modem.mjs';
import {
  annotatedVideoAvailability,
  cellularConnectGate,
  chipStateFromLink,
  liveStatusToLinkState,
  summarizeDualLink,
} from '../lib/dual-link.mjs';
import { buildVisionLandingReadiness } from '../lib/vision-landing-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');

function rowById(snapshot, id) {
  return snapshot.rows.find((r) => r.id === id);
}

describe('P3.1 E3372 modem_absent honesty', () => {
  it('pins APP_VERSION at 1.02.296', () => {
    const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(version).toContain("export const APP_VERSION = '1.02.296'");
    expect(pkg.version).toBe('1.02.296');
  });

  it('probes absent by default and never invents a cellular link-up', () => {
    const probe = probeHuaweiE3372({ env: {}, existsSync: () => false });
    expect(probe.present).toBe(false);
    expect(probe.reason).toBe('modem_absent');
    expect(liveStatusToLinkState(
      { connected: true, listening: true },
      { role: 'cellular', modemPresent: false },
    )).toBe('modem_absent');
    const snap = summarizeDualLink({
      radio: 'disconnected',
      cellular: 'connected',
      modemPresent: false,
    });
    expect(snap.cellular).toBe('modem_absent');
    expect(snap.modemPresent).toBe(false);
    expect(snap.active).toBeNull();
    expect(snap.video.available).toBe(false);
    expect(snap.video.reason).toBe('modem_absent');
    expect(snap.cellularStatusHe).toBe('מודם לא מחובר');
    expect(chipStateFromLink('modem_absent')).toBe('absent');
    expect(cellularConnectGate({ modemPresent: false, host: '8.8.8.8' }).state).toBe('modem_absent');
  });

  it('keeps the annotated-video gate honest when the modem is absent', () => {
    const gate = annotatedVideoAvailability({ cellular: 'connected', modemPresent: false });
    expect(gate.available).toBe(false);
    expect(gate.path).toBe('cellular');
    expect(gate.reason).toBe('modem_absent');
    const readiness = buildVisionLandingReadiness({
      video: { available: true, path: 'radio' },
      cellular: 'connected',
      modemPresent: false,
    });
    const row = rowById(readiness, 'annotated_video');
    expect(row.state).toBe('later');
    expect(row.requiredForExperiment1).toBe(false);
    expect(row.available).toBe(false);
    expect(row.path).toBe('cellular');
    expect(row.reason).toBe('modem_absent');
    expect(readiness.annotatedVideo.reason).toBe('modem_absent');
  });

  it('paints connect / readiness / vision slots as modem_absent in the UI source', () => {
    expect(html).toMatch(/id="cellularLinkChip"[^>]*data-state="absent"/);
    expect(html).toMatch(/id="cellularLinkChip"[^>]*data-reason="modem_absent"/);
    expect(html).toMatch(/id="cellularModemStatus"[^>]*data-reason="modem_absent"/);
    expect(html).toMatch(/id="annotatedVisionPanel"[^>]*data-state="modem_absent"/);
    expect(html).toMatch(/אין שידור\. מודם סלולר לא מחובר/);
    expect(js).toMatch(/if \(state === 'modem_absent'\) return 'absent'/);
    expect(js).toMatch(/function annotatedVisionIsLive/);
    expect(js).toMatch(/panel\.dataset\.path = 'cellular'/);
    expect(js).toMatch(/art\.dataset\.reason = String\(row\.reason \|\| ''\)/);
    expect(css).toMatch(/\.conn-link-chip\[data-state="absent"\]/);
    expect(css).toMatch(/\.mission-annotated-vision\[data-state="modem_absent"\]/);
  });

  it('dry-runs the console probe without hardware and stays modem_absent', () => {
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
    expect(snap.ok).toBe(true);
    expect(snap.dryRun).toBe(true);
    expect(snap.present).toBe(false);
    expect(snap.reason).toBe('modem_absent');
    expect(snap.cellular).toBe('modem_absent');
    expect(snap.video.available).toBe(false);
    expect(snap.video.reason).toBe('modem_absent');
    expect(snap.remoteConnect.allowed).toBe(false);
    expect(snap.remoteConnect.state).toBe('modem_absent');
    expect(snap.flightCommands).toBe(false);
    expect(snap.companionHttpCommandPath).toBe(false);
  });
});
