import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absentAutolandStatus, normalizeAutolandStatus } from '../lib/autoland-status.mjs';
import { registerAutolandApi } from '../lib/routes/autoland-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function panelHtml() {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('id="autoLandPanel"');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

describe('auto-land console panel', () => {
  it('is a disabled Hebrew panel with no enable control', () => {
    const slice = panelHtml();
    expect(slice).toContain('dir="rtl"');
    expect(slice).toContain('מושבת');
    expect(slice).toContain('נחיתה אוטומטית');
    expect(slice).not.toMatch(/<button/i);
    expect(slice).not.toMatch(/enable/i);
    const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    expect(app).toContain('function renderAutoLandPanel');
    expect(app).toContain("fetch('/api/autoland/status'");
    const fn = app.slice(app.indexOf('function renderAutoLandPanel'), app.indexOf('async function refreshAutoLandPanel'));
    expect(fn).not.toContain('createElement(\'button\'');
  });

  it('leaves an absent companion unreported', () => {
    const absent = absentAutolandStatus();
    expect(absent.enabled).toBe(false);
    expect(absent.reported).toBe(false);
    expect(absent.labelHe).toBe('מושבת');
    expect(absent.state).toBeNull();
    expect(absent.gates).toBeNull();
    expect(absent.commands).toBeNull();
    expect(normalizeAutolandStatus(null)).toEqual(absent);
    expect(normalizeAutolandStatus({ reported: false, state: 'APPROACH', gates: [{ id: 'link', ok: true }] }).state).toBeNull();
  });

  it('keeps a real snapshot and does not invent a passing gate', () => {
    const body = normalizeAutolandStatus({
      reported: true,
      enabled: false,
      shadow: true,
      state: 'IDLE',
      stateHe: 'המתנה',
      gates: [
        { id: 'config_enabled', ok: false, reasonHe: 'מושבת' },
        { id: 'position', ok: false, reasonHe: 'אין מיקום תקין' },
      ],
      commands: [],
      commandsSent: 0,
    });
    expect(body.reported).toBe(true);
    expect(body.labelHe).toBe('מושבת');
    expect(body.state).toBe('IDLE');
    expect(body.gates).toHaveLength(2);
    expect(body.gates.every((gate) => gate.ok === false)).toBe(true);
    expect(body.commands).toEqual([]);
  });

  it('serves the disabled report when the companion client is off', async () => {
    const app = express();
    registerAutolandApi(app, {});
    const server = await new Promise((resolve) => {
      const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
    });
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/autoland/status`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        enabled: false,
        reported: false,
        labelHe: 'מושבת',
        state: null,
        gates: null,
        commands: null,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
