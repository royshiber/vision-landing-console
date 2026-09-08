import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { COMPANION_HE } from '../lib/companion-connection.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

describe('Operator chrome voice and lab chrome gone', () => {
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
    expect(html).toMatch(/id="pulseTalkBtn"[^>]*>שאלו את המסייע</);
    expect(html).toMatch(/data-first-action="params">פרמטרים</);
    expect(html).toMatch(/data-first-action="companion">חברו Jetson</);
    expect(html).toMatch(/id="connectPillLabel"[^>]*>מנותק</);
    expect(html).toMatch(/class="pulse-version-line">קונסולה <span id="pulseVersion"/);
  });

  it('keeps ops tabs and deletes every user-visible Lab shelf', () => {
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="platform"[^>]*>פלטפורמה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="control"[^>]*>פרמטרים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="recordings"[^>]*>תחקור</);
    expect(html).toMatch(/data-tab="telemetry"[^>]*>אבחונים</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="maintenance"[^>]*>תחזוקה</);
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="development"[^>]*>פיתוח</);
    expect(html).toMatch(/class="tab tab-fly[^"]*"[^>]*data-tab="terrain"[^>]*>הטסה</);
    expect(html).not.toContain('id="tabLabMenu"');
    expect(html).not.toContain('id="tabLabToggle"');
    expect(html).not.toContain('מעבדה');
    expect(html).not.toMatch(/class="tab"[^>]*data-tab="simLab"/);
    expect(html).not.toContain('id="simLab"');
    expect(html).not.toContain('sim-lab.mjs');
    expect(html).toContain('id="advisor"');
    expect(html).toContain('id="featureDesigner"');
    expect(html).toContain('id="flightEngineer"');
    expect(js).toContain('function isAssistShelfPanel(');
    expect(js).toMatch(/ASSIST_SHELF_PANELS = new Set\(\['advisor', 'featureDesigner', 'flightEngineer'\]\)/);
    expect(js).toMatch(/function applyMainTab\([\s\S]*?isAssistShelfPanel\(tabId\)/);
    expect(js).not.toContain('function initLabTabGroup(');
    expect(js).not.toContain('function syncLabTabGroup(');
  });

  it('uses spoken Companion connect and disconnected next-step copy', () => {
    expect(html).toMatch(/id="companionConnectHint"[^>]*>צריך כתובת ואסימון\. כתובת לבד לא מספיקה\.</);
    expect(html).toMatch(/id="teleNextStep"[^>]*>חברו מחשב משימה\. כתובת לבד לא מספיקה\.</);
    expect(html).toMatch(/id="maintNextStep"[^>]*>חברו מחשב משימה\. כתובת לבד לא מספיקה\.</);
    expect(COMPANION_HE.hint).toBe('צריך כתובת ואסימון. כתובת לבד לא מספיקה.');
    expect(COMPANION_HE.bothGate).toMatch(/כתובת לבד לא מספיקה/);
    expect(js).not.toContain('כתובת לבד לא מחברת');
    expect(html).not.toContain('כתובת לבד לא מחברת');
  });

  it('opens Assist-shelf panels without a Lab tab button', () => {
    const helper = [
      'const ASSIST_SHELF_PANELS = new Set(["advisor", "featureDesigner", "flightEngineer"]);',
      sliceFunction(js, 'isAssistShelfPanel'),
      'return { sim: isAssistShelfPanel("simLab"), pulse: isAssistShelfPanel("pulse"), advisor: isAssistShelfPanel("advisor") };',
    ].join('\n');
    const result = new Function(helper)();
    expect(result.sim).toBe(false);
    expect(result.advisor).toBe(true);
    expect(result.pulse).toBe(false);
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const chrome = [
      sliceFunction(js, 'isAssistShelfPanel'),
      sliceFunction(js, 'pulseBuildAttention'),
    ].join('\n');
    expect(chrome).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });
});
