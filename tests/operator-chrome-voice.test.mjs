import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { COMPANION_HE } from '../lib/companion-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

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

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

describe('Operator chrome voice and lab shelf', () => {
  it('removes Pulse filler and uses spoken chrome on first-open CTAs', () => {
    expect(html).not.toContain('מה שחשוב עכשיו בלבד');
    expect(html).not.toContain('מה קורה עכשיו');
    expect(html).not.toContain('pulse-lede');
    expect(html).not.toContain('pulse-kicker');
    expect(html).not.toContain('מוכנים');
    expect(html).not.toContain('שכבת ניהול מקומית מבוקרת');
    expect(html).not.toContain('ממשק ניסוי מהיר');
    expect(html).not.toContain('פתיחת מסייע');
    expect(html).not.toContain('פתיחת פרמטרים');
    expect(html).toMatch(/data-first-action="assist">מסייע</);
    expect(html).toMatch(/data-first-action="params">פרמטרים</);
    expect(html).toMatch(/data-first-action="companion">חברו מלווה</);
    expect(html).toMatch(/id="connectPillLabel"[^>]*>מנותק</);
    expect(html).toMatch(/<dt>גרסה<\/dt>/);
  });

  it('keeps ops tabs on the shelf and groups lab/fly tabs under מעבדה', () => {
    expect(html).toMatch(/class="tab tab-ops active"[^>]*data-tab="pulse"[^>]*>סקירה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="control"[^>]*>פרמטרים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="recordings"[^>]*>תחקור</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="telemetry"[^>]*>טלמטריה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="maintenance"[^>]*>תחזוקה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="development"[^>]*>פיתוח</);
    const menu = capture(html, /<div id="tabLabMenu"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/, 'missing #tabLabMenu')[1];
    expect(menu).toMatch(/class="tab tab-lab"[^>]*data-tab="simLab"[^>]*>סימולציה</);
    expect(menu).toMatch(/class="tab tab-lab"[^>]*data-tab="advisor"[^>]*>יועץ</);
    expect(menu).toMatch(/class="tab tab-lab"[^>]*data-tab="featureDesigner"[^>]*>ArduLab</);
    expect(menu).toMatch(/class="tab tab-lab"[^>]*data-tab="flightEngineer"[^>]*>מהנדס</);
    expect(menu).toMatch(/class="tab tab-fly"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(html).toMatch(/id="tabLabToggle"[^>]*>מעבדה</);
    expect(html).toMatch(/id="tabLabMenu"[^>]*\bhidden\b/);
    expect(css).toMatch(/\.tab-lab-menu\[hidden\]/);
    expect(css).toMatch(/\.tab-lab-toggle\b/);
    expect(css).toMatch(/\.tabs:has\(\.tab-lab-group\.is-open\)/);
    expect(js).toContain('function initLabTabGroup(');
    expect(js).toContain('function syncLabTabGroup(');
    expect(js).toMatch(/function applyMainTab\([\s\S]*?syncLabTabGroup\(tabId\)/);
  });

  it('uses spoken Companion connect and disconnected next-step copy', () => {
    expect(html).toMatch(/id="companionConnectHint"[^>]*>צריך כתובת ואסימון\. כתובת לבד לא מספיקה\.</);
    expect(html).toMatch(/id="teleNextStep"[^>]*>חברו מלווה\. כתובת לבד לא מספיקה\.</);
    expect(html).toMatch(/id="maintNextStep"[^>]*>חברו מלווה\. כתובת לבד לא מספיקה\.</);
    expect(COMPANION_HE.hint).toBe('צריך כתובת ואסימון. כתובת לבד לא מספיקה.');
    expect(COMPANION_HE.bothGate).toMatch(/כתובת לבד לא מספיקה/);
    expect(js).not.toContain('כתובת לבד לא מחברת');
    expect(html).not.toContain('כתובת לבד לא מחברת');
  });

  it('syncs the lab toggle label to the open lab tab and resets on ops', () => {
    const toggle = { textContent: 'מעבדה', classList: { current: false, toggle(name, on) { if (name === 'is-current') this.current = on; } }, setAttribute() {} };
    const group = { classList: { lab: false, open: false, toggle(name, on) { if (name === 'is-lab-active') this.lab = on; if (name === 'is-open') this.open = on; } } };
    const menu = { hidden: true };
    const simBtn = { textContent: 'סימולציה' };
    const document = {
      getElementById(id) {
        if (id === 'tabLabToggle') return toggle;
        if (id === 'tabLabGroup') return group;
        if (id === 'tabLabMenu') return menu;
        return null;
      },
      querySelector(sel) {
        if (sel === '.tab-lab-menu .tab[data-tab="simLab"]') return simBtn;
        return null;
      },
    };
    const src = [
      'const LAB_SHELF_TABS = new Set(["simLab", "advisor", "featureDesigner", "flightEngineer", "terrain"]);',
      sliceFunction(js, 'isLabShelfTab'),
      sliceFunction(js, 'labTabLabel'),
      sliceFunction(js, 'setLabMenuOpen'),
      sliceFunction(js, 'syncLabTabGroup'),
      'syncLabTabGroup("simLab");',
      'const lab = { label: document.getElementById("tabLabToggle").textContent, current: document.getElementById("tabLabToggle").classList.current, group: document.getElementById("tabLabGroup").classList.lab, menuHidden: document.getElementById("tabLabMenu").hidden };',
      'syncLabTabGroup("pulse");',
      'return { lab, opsLabel: document.getElementById("tabLabToggle").textContent, opsCurrent: document.getElementById("tabLabToggle").classList.current };',
    ].join('\n');
    const result = new Function('document', src)(document);
    expect(result.lab.label).toBe('סימולציה');
    expect(result.lab.current).toBe(true);
    expect(result.lab.group).toBe(true);
    expect(result.lab.menuHidden).toBe(true);
    expect(result.opsLabel).toBe('מעבדה');
    expect(result.opsCurrent).toBe(false);
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const chrome = [
      sliceFunction(js, 'initLabTabGroup'),
      sliceFunction(js, 'syncLabTabGroup'),
      sliceFunction(js, 'pulseBuildAttention'),
    ].join('\n');
    expect(chrome).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });
});
