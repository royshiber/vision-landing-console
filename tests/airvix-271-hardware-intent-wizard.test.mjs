import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');
const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');

function wizardPanel() {
  const start = html.indexOf('id="autoConfig"');
  expect(start, 'missing #autoConfig').toBeGreaterThanOrEqual(0);
  const custom = html.indexOf('id="customParams"', start);
  expect(custom, 'missing #customParams after autoConfig').toBeGreaterThan(start);
  return html.slice(start, custom);
}

describe('AIRVIX hardware-intent lock still holds on Concept B (1.02.283)', () => {
  it('pins APP_VERSION at 1.02.283', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.283'");
    expect(pkg.version).toBe('1.02.283');
    expect(changelog).toContain('"version": "1.02.277"');
  });

  it('keeps the three locked questions and the recommendation fold', () => {
    const panel = wizardPanel();
    expect(panel).toContain('data-ac-model="concept-b"');
    expect(panel).toContain('מה חיברתי');
    expect(panel).toContain('לאן חיברתי');
    expect(panel).toContain('מה אני מצפה שיקרה');
    expect(panel).toContain('id="acPlanBtn"');
    expect(js).toContain('בקר טיסה');
    expect(js).toContain('מחשב משימה');
    expect(js).toContain('conceptB');
  });

  it('keeps FC and Jetson visually distinct and RTL-safe', () => {
    expect(css).toContain('.ac-b-seg-btn[data-host="fc"]');
    expect(css).toContain('.ac-b-seg-btn[data-host="jetson"]');
    expect(css).toContain('unicode-bidi: isolate');
    expect(css).toContain('.ac-b-card');
  });

  it('does not turn Develop into Mission polish and keeps Mission contract markers', () => {
    expect(html).toContain('data-layout-contract="v2"');
    expect(html).toContain('data-cap-runway="f2"');
    expect(html).toContain('data-cap-intake="f1"');
    expect(js).not.toMatch(/function initAutoConfigWizard[\s\S]*applyMainTab\('terrain'\)/);
  });

  it('uses AIRVIX Ask and Jetson / מחשב משימה naming only', () => {
    const panel = wizardPanel();
    expect(panel).not.toContain('מסייע');
    expect(panel).not.toContain('מלווה');
    expect(js).toContain('מחשב משימה');
    expect(commercial).toContain('אשף קונפיגורציה לפי כוונת חומרה');
  });

  it('does not add companion apply/restart or flight-command chrome in the wizard', () => {
    const panel = wizardPanel();
    expect(panel).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
    expect(panel).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});
