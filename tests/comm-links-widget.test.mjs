import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

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

function connectPanel() {
  const start = html.indexOf('id="connectPanel"');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf('id="connectStatModal"', start));
}

describe('four-row communications widget', () => {
  it('keeps exactly four locked rows on the normal path', () => {
    const panel = connectPanel();
    const main = panel.slice(0, panel.indexOf('id="connectAdvanced"'));
    const rows = [...main.matchAll(/class="comm-link-row"[^>]*data-link="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(['cellular', 'radio', 'home', 'rc']);
    expect(main).toContain('סלולר');
    expect(main).toContain('רדיו טלמטריה');
    expect(main).toContain('רשת בית');
    expect(main).toMatch(/data-link="rc"/);
    expect(main).not.toMatch(/host:8081/);
    expect(main).not.toContain('id="connectPortInput"');
    expect(main).not.toContain('id="cellularHostPort"');
    expect(panel.indexOf('id="connectPortInput"')).toBeGreaterThan(panel.indexOf('id="connectAdvanced"'));
    expect(panel.indexOf('id="cellularHostPort"')).toBeGreaterThan(panel.indexOf('id="connectAdvanced"'));
  });

  it('labels actions התחבר or התנתק by state, and RC stays סטטוס', () => {
    expect(html).toMatch(/id="cellularConnectBtn"[^>]*>התחבר</);
    expect(html).toMatch(/id="connectBtn"[^>]*>התחבר</);
    expect(html).toMatch(/id="companionLinkBtn"[^>]*>התחבר</);
    expect(html).toMatch(/id="rcStatusBtn"[^>]*>סטטוס</);
    expect(js).toContain("cellularConnectBtn.textContent = cellUp ? 'התנתק' : 'התחבר'");
    expect(js).toContain("connBtn.textContent = 'התנתק'");
    expect(js).toContain("companionLinkBtn.textContent = connected ? 'התנתק' : 'התחבר'");
    expect(js).not.toMatch(/cellularConnectBtn\.textContent = cellUp \? 'ניתוק' : 'חיבור'/);
    expect(html).not.toMatch(/id="connectBtn"[^>]*>CONNECT</);
  });

  it('does not clip the collapsed pill under chrome', () => {
    const float = cssBlock(css, '.connect-widget.connect-widget-float');
    expect(float).toMatch(/max-width:\s*min\(280px/);
    const pill = cssBlock(css, '.conn-pill-label');
    expect(pill).toMatch(/white-space:\s*nowrap/);
    expect(pill).toMatch(/max-width:\s*240px/);
    expect(html).toMatch(/id="connectPillLabel"[^>]*>מנותק</);
  });

  it('keeps quality bars and hides percent unless a trusted metric exists', () => {
    expect(html).toContain('id="cellularQualityBars"');
    expect(html).toContain('id="radioQualityBars"');
    expect(html).toContain('id="homeQualityBars"');
    expect(html).toContain('id="rcQualityBars"');
    expect(html).toMatch(/id="cellularQualityPct"[^>]*hidden/);
    expect(js).toContain('function paintQuality(');
    expect(js).toContain('pctEl.hidden = true');
    expect(js).toContain('quality.sourceHe');
    expect(css).toContain('.comm-link-bars');
    expect(css).toContain('[data-quality="known"]');
  });

  it('adds a compact Mission strip that does not steal AH or map', () => {
    expect(html).toContain('id="missionLinkStrip"');
    expect(html).toMatch(/class="mission-ops-chrome"/);
    const strip = cssBlock(css, '.mission-link-strip');
    expect(strip).toMatch(/flex-wrap:\s*nowrap/);
    expect(cssBlock(css, '.mission-ops-chrome')).toMatch(/max-height:\s*26px/);
    expect(html).toMatch(/data-mission-layout="ops-v1"/);
  });

  it('keeps modem-absent honesty and does not invent telemetry', () => {
    expect(html).toMatch(/id="cellularLinkHint"[^>]*>מודם לא מחובר</);
    expect(html).toMatch(/id="cellularLinkChip"[^>]*data-state="absent"/);
    expect(html).toContain('מודם סלולר לא מחובר');
    expect(js).not.toMatch(/Math\.random\(\).*percent/);
    expect(js).not.toMatch(/bandwidth|utilization|capacityMbps/);
  });
});
