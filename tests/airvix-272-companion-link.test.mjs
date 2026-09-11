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

function connectPanel() {
  const start = html.indexOf('id="connectPanel"');
  expect(start, 'missing #connectPanel').toBeGreaterThanOrEqual(0);
  const end = html.indexOf('id="connectStatModal"', start);
  return html.slice(start, end > start ? end : start + 8000);
}

describe('AIRVIX 1.02.272 Jetson↔FC topbar connect', () => {
  it('pins APP_VERSION at 1.02.278', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.278'");
    expect(pkg.version).toBe('1.02.278');
    expect(changelog).toContain('"version": "1.02.272"');
  });

  it('puts מחשב משימה and בקר טיסה in the existing topbar connect panel', () => {
    const panel = connectPanel();
    expect(panel).toContain('id="jetsonLinkChip"');
    expect(panel).toContain('id="fcLinkChip"');
    expect(panel).toContain('id="companionLinkBtn"');
    expect(panel).toMatch(/מחשב משימה/);
    expect(panel).toMatch(/בקר טיסה/);
    expect(panel).toMatch(/id="companionLinkBtn"[^>]*>חיבור</);
    expect(panel).toContain('id="connectAdvanced"');
    expect(panel).toMatch(/מתקדם/);
    expect(html).not.toContain('מסייע');
    expect(js).not.toContain('מסייע');
  });

  it('hides address typing behind מתקדם and keeps dual-link ids', () => {
    const panel = connectPanel();
    const advanced = panel.indexOf('id="connectAdvanced"');
    const hostPort = panel.indexOf('id="connectPortInput"');
    const cellHost = panel.indexOf('id="cellularHostPort"');
    expect(advanced).toBeGreaterThan(0);
    expect(hostPort).toBeGreaterThan(advanced);
    expect(cellHost).toBeGreaterThan(advanced);
    expect(panel.indexOf('id="radioLinkChip"')).toBeGreaterThan(advanced);
    expect(panel.indexOf('id="cellularLinkChip"')).toBeGreaterThan(advanced);
    expect(panel).toContain('id="radioLinkChip"');
    expect(panel).toContain('id="cellularLinkChip"');
    expect(panel).toContain('id="activeLinkPicker"');
    expect(js).toContain("fetch('/api/companion/link'");
    expect(js).toContain("fetch('/api/companion/link/connect'");
    expect(js).toContain('applyCompanionLinkUi');
  });

  it('does not put the host:8081 form on the main connect path', () => {
    const panel = connectPanel();
    const main = panel.slice(0, panel.indexOf('id="connectAdvanced"'));
    expect(main).not.toMatch(/host:8081/);
    expect(main).not.toMatch(/companionBaseUrl/);
    expect(main).not.toMatch(/type="url"/);
    expect(html).toContain('id="companionConnectAdvanced"');
    expect(css).toContain('.conn-advanced');
    expect(css).toContain('.conn-companion-block');
  });

  it('documents one-click Jetson↔FC status as normal GCS connectivity', () => {
    expect(commercial).toMatch(/מחשב משימה/);
    expect(commercial).toMatch(/בקר טיסה/);
    expect(commercial).toMatch(/דופק/);
    expect(commercial).toMatch(/מתקדם/);
  });
});
