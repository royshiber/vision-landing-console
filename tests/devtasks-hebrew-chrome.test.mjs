import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function innerText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function capture(html, re, label) {
  const m = html.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

describe('Development Tasks Hebrew chrome', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

  it('uses Hebrew nav-tab label פיתוח instead of DEVELOPMENT', () => {
    const m = capture(
      html,
      /<button\b[^>]*\bdata-tab="development"[^>]*>([\s\S]*?)<\/button>/i,
      'missing nav tab data-tab="development"',
    );
    const label = innerText(m[1]);
    expect(label).toBe('פיתוח');
    expect(label).not.toBe('DEVELOPMENT');
    expect(m[0]).toContain('title="ניהול משימות פיתוח מקומיות"');
  });

  it('does not keep Create task / Start development / Deploy release as visible chrome', () => {
    const createBtn = capture(
      html,
      /<button\b[^>]*\bid="devTaskCreateBtn"[^>]*>([\s\S]*?)<\/button>/i,
      'missing #devTaskCreateBtn',
    );
    const startBtn = capture(
      html,
      /<button\b[^>]*\bid="devAgentStartBtn"[^>]*>([\s\S]*?)<\/button>/i,
      'missing #devAgentStartBtn',
    );
    const deployBtn = capture(
      html,
      /<button\b[^>]*\bid="devReleaseDeployBtn"[^>]*>([\s\S]*?)<\/button>/i,
      'missing #devReleaseDeployBtn',
    );
    expect(innerText(createBtn[1])).toBe('יצירת משימה');
    expect(innerText(startBtn[1])).toBe('התחלת פיתוח');
    expect(innerText(deployBtn[1])).toBe('התקנת גרסה');
    expect(html).not.toMatch(/>\s*Create task\s*</);
    expect(html).not.toMatch(/>\s*Start development\s*</);
    expect(html).not.toMatch(/>\s*Deploy release\s*</);
  });

  it('uses Hebrew headings and table headers on the Development Tasks screen', () => {
    const panel = capture(
      html,
      /<section\b[^>]*\bid="development"[^>]*>([\s\S]*?)<\/section>\s*<section\b[^>]*\bid="simLab"/i,
      'missing #development panel',
    )[1];
    expect(panel).toContain('<h3>משימות פיתוח</h3>');
    expect(panel).toContain('<h4 class="maint-group-title">יצירת משימה</h4>');
    expect(panel).toContain('<h4 class="maint-group-title">משימות פיתוח</h4>');
    expect(panel).toContain('<h4 class="maint-group-title">פרטי משימה</h4>');
    expect(panel).toContain('<th>מזהה</th>');
    expect(panel).toContain('<th>כותרת</th>');
    expect(panel).toContain('<th>סיווג</th>');
    expect(panel).toContain('<th>יעד</th>');
    expect(panel).toContain('<th>עדיפות</th>');
    expect(panel).toContain('<th>מצב</th>');
    expect(panel).toContain('<th>עודכן</th>');
    expect(panel).toContain('id="devTaskTaxonomy"');
    expect(panel).toContain('id="devTaskFilterTaxonomy"');
    expect(panel).toContain('id="devDetailTaxonomy"');
    expect(panel).toMatch(/<span>סיווג<\/span>/);
    expect(panel).toMatch(/<label>סיווג <select id="devTaskFilterTaxonomy"/);
    expect(panel).toMatch(/<label>סיווג <select id="devDetailTaxonomy"/);
    expect(panel).not.toContain('Development Tasks');
    expect(panel).not.toContain('Task Detail');
  });

  it('uses Hebrew labels on the Development evidence strip', () => {
    const strip = capture(
      html,
      /<div id="devEvidenceStrip"[^>]*>([\s\S]*?)<\/div>/,
      'missing #devEvidenceStrip',
    )[0];
    expect(strip).toContain('<span>מה</span>');
    expect(strip).toContain('<span>למה</span>');
    expect(strip).toContain('<span>מצב</span>');
    expect(strip).toContain('<span>בדיקות</span>');
    expect(strip).toContain('<span>גרסה</span>');
    expect(strip).toContain('<span>גרסה רצה</span>');
    expect(strip).not.toContain('ראיות');
    expect(strip).not.toContain('מה שחשוב');
    expect(strip).not.toContain('בלבד');
    expect(strip).not.toMatch(/>\s*What\s*</);
    expect(strip).not.toMatch(/>\s*Why\s*</);
    expect(strip).not.toMatch(/>\s*Release\s*</);
  });
});
