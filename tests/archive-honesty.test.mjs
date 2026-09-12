import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import { collectVisionLandingReadinessInput } from '../lib/routes/vision-landing-readiness-api.mjs';
import { registerVisionLandingReadinessApi } from '../lib/routes/vision-landing-readiness-api.mjs';
import { getTelemetryArchive, resetDualLinkRuntimeForTests } from '../lib/dual-link-runtime.mjs';
import { buildVisionLandingReadiness } from '../lib/vision-landing-readiness.mjs';
import { operatorArchiveFeedback, ARCHIVE_COPY_HE } from '../lib/telemetry-archive.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'vision-landing-readiness-api.mjs'), 'utf8');

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

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('archive honesty — Mission and readiness wiring', () => {
  beforeEach(() => {
    resetDualLinkRuntimeForTests();
  });
  afterEach(() => {
    resetDualLinkRuntimeForTests();
  });

  it('Mission start/stop surfaces messageHe and does not paint success on failure', () => {
    const fn = sliceFunction(js, 'initFlightArchiveRecord');
    expect(fn).toContain('messageHe');
    expect(fn).toContain('warnHe');
    expect(fn).toContain('archiveOperatorFeedback');
    expect(fn).toContain('paintRecording');
    expect(fn).toMatch(/r\.ok/);
    expect(fn).toContain('אין תשובה מהשרת. ההקלטה לא השתנתה.');
    expect(fn).toContain('לא הצלחנו לפתוח קובץ הקלטה.');
    expect(fn).toContain('לא הצלחנו לעצור את ההקלטה.');
    expect(html).toContain('id="missionRecordCue"');
    expect(html).toContain('id="missionRecordStatus"');
    expect(fn).toContain('missionRecordCue');
    expect(fn).toContain('אין קישור');
    expect(fn).toContain('תקוע');
  });

  it('error helper refuses to paint a failed start as armed', () => {
    const painted = operatorArchiveFeedback({
      ok: false,
      httpOk: false,
      messageHe: ARCHIVE_COPY_HE.startFail,
    });
    expect(painted.paintRecording).toBe(false);
    expect(painted.kind).toBe('error');
  });

  it('readiness manualRecordApi follows live archive.isRecording()', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-ready-'));
    const db = openDatabase(path.join(tmp, 'index.sqlite'));
    const archive = getTelemetryArchive({ db, dataDir: tmp });
    expect(archive.isRecording()).toBe(false);
    const idle = await collectVisionLandingReadinessInput({ db, dataDir: tmp });
    expect(idle.manualRecordApi).toEqual({ recording: false });
    expect(buildVisionLandingReadiness(idle).rows.find((r) => r.id === 'telemetry_recording').state)
      .toBe('not-recording');

    const started = archive.startRecording({ linkRole: 'radio' });
    expect(started.ok).toBe(true);
    expect(archive.isRecording()).toBe(true);
    const armed = await collectVisionLandingReadinessInput({ db, dataDir: tmp });
    expect(armed.manualRecordApi).toEqual({ recording: true });
    expect(buildVisionLandingReadiness(armed).rows.find((r) => r.id === 'telemetry_recording').state)
      .toBe('recording');

    archive.stopRecording();
    const after = await collectVisionLandingReadinessInput({ db, dataDir: tmp });
    expect(after.manualRecordApi).toEqual({ recording: false });
    db.close();
  });

  it('GET /api/vision/landing-readiness reports recording after a live arm', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-archive-ready-http-'));
    const db = openDatabase(path.join(tmp, 'index.sqlite'));
    const app = express();
    app.use(express.json());
    registerVisionLandingReadinessApi(app, { db, dataDir: tmp, env: {} });
    const server = await listen(app);
    const addr = server.address();
    const base = `http://127.0.0.1:${addr.port}`;
    const before = await (await fetch(`${base}/api/vision/landing-readiness`)).json();
    expect(before.rows.find((r) => r.id === 'telemetry_recording').state).toBe('not-recording');
    getTelemetryArchive({ db, dataDir: tmp }).startRecording({ linkRole: 'radio' });
    const after = await (await fetch(`${base}/api/vision/landing-readiness`)).json();
    expect(after.rows.find((r) => r.id === 'telemetry_recording').state).toBe('recording');
    getTelemetryArchive({ db, dataDir: tmp }).stopRecording();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('does not hardcode readiness recording to null', () => {
    expect(apiSrc).toContain('liveManualRecordApi');
    expect(apiSrc).toContain('isRecording()');
    expect(apiSrc).not.toMatch(/manualRecordApi:\s*null/);
  });
});
