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

describe('AIRVIX 1.02.269 hardware-intent configuration wizard', () => {
  it('pins APP_VERSION at 1.02.269', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.269'");
    expect(pkg.version).toBe('1.02.269');
    expect(changelog).toContain('"version": "1.02.269"');
  });

  it('rebuilds the wizard around one component and three questions', () => {
    const panel = wizardPanel();
    expect(panel).toContain('data-ac-model="hardware-intent"');
    expect(panel).toContain('id="acIntentCard"');
    expect(panel).toContain('id="acWizPrev"');
    expect(panel).toContain('id="acWizNext"');
    expect(panel).toContain('id="acWizMark"');
    expect(panel).toContain('id="acPlanBtn"');
    expect(js).toContain('מה מחובר');
    expect(js).toContain('לאן מחובר');
    expect(js).toContain('מה אני מצפה שיקרה');
    expect(js).toContain('data-host=');
    expect(js).toContain('בקר טיסה');
    expect(js).toContain('מחשב משימה');
    expect(js).toContain('ac-expect-token');
    expect(js).toContain('hardwareIntent');
  });

  it('keeps FC and Jetson visually distinct and RTL-safe', () => {
    expect(css).toContain('.ac-wire-host[data-host="fc"]');
    expect(css).toContain('.ac-wire-host[data-host="jetson"]');
    expect(css).toContain('unicode-bidi: isolate');
    expect(css).toContain('.ac-intent-card');
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
