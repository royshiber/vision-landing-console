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

function cssBlock(src, selector) {
  const start = src.indexOf(selector);
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed selector ${selector}`);
}

describe('AIRVIX dual-link connect + cellular infrastructure', () => {
  it('pins APP_VERSION at 1.02.299', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.299'");
    expect(pkg.version).toBe('1.02.299');
  });

  it('extends the מנותק connect panel with both link roles and an active picker', () => {
    expect(html).toMatch(/id="connectPillLabel"[^>]*>מנותק</);
    expect(html).toContain('רדיו טלמטריה');
    expect(html).toContain('סלולר');
    expect(html).toContain('id="cellularHostPort"');
    expect(html).toContain('id="cellularConnectBtn"');
    expect(html).toContain('id="activeLinkPicker"');
    expect(html).toContain('id="radioLinkChip"');
    expect(html).toContain('id="cellularLinkChip"');
    expect(html).toMatch(/מודם לא מחובר/);
    expect(html).toMatch(/id="cellularLinkChip"[^>]*data-state="absent"/);
    expect(html).toMatch(/id="annotatedVisionPanel"[^>]*data-reason="modem_absent"/);
    expect(js).toContain("fetch('/api/links'");
    expect(js).toContain("role: 'cellular'");
    expect(js).toContain("fetch('/api/links/active'");
    expect(html).not.toContain('מסייע');
    expect(js).not.toContain('מסייע');
  });

  it('keeps annotated vision as a Mission slot without changing the layout contract', () => {
    expect(html).toContain('id="annotatedVisionPanel"');
    expect(html).toContain('id="annotatedVisionEmpty"');
    expect(html).toMatch(/רק סלולר ממחשב משימה/);
    expect(html).toMatch(/data-mission-layout="ops-v1"/);
    const workspace = cssBlock(css, '.mission-workspace[data-mission-layout="ops-v1"]');
    expect(workspace).toMatch(/grid-template-areas:\s*"horizon map talk"/);
    expect(workspace).toMatch(/--mission-map-min:\s*65%/);
    expect(workspace).not.toMatch(/"video map talk"/);
    expect(html).toMatch(/data-mission-region="horizon"/);
    expect(html).toMatch(/data-mission-region="map"/);
    expect(html).toMatch(/data-mission-region="talk"/);
  });

  it('documents dual-link MAVLink and the dedicated telemetry archive', () => {
    expect(commercial).toMatch(/שני קישורים/);
    expect(commercial).toMatch(/data\/flights\/archive/);
    expect(fs.existsSync(path.join(repoRoot, 'docs', 'TELEMETRY_ARCHIVE.md'))).toBe(true);
    expect(html).not.toContain('Companion-HTTP');
  });
});
