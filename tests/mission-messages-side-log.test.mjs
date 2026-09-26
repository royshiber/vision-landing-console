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
const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');

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

describe('Mission aircraft messages — side print-log', () => {
  it('pins APP_VERSION at 1.02.352', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.352'");
    expect(pkg.version).toBe('1.02.352');
  });

  it('places the live feed inside the AH / video stage, not a centered box', () => {
    const stageIdx = html.indexOf('id="pfdHorizonStage"');
    const logIdx = html.indexOf('id="pfdHorizonMsgLog"');
    const canvasIdx = html.indexOf('id="horizonCanvas"');
    const stageEnd = html.indexOf('</div>', canvasIdx);
    expect(stageIdx).toBeGreaterThan(0);
    expect(logIdx).toBeGreaterThan(canvasIdx);
    expect(logIdx).toBeLessThan(stageEnd);
    expect(html).toMatch(/id="pfdHorizonMsgLog"[^>]*dir="rtl"/);
    expect(html).toMatch(/id="pfdHorizonMsgLog"[^>]*aria-label="הודעות מטוס"/);
    expect(html).toMatch(/id="pfcMsgPrimaryHe"/);
    expect(html).not.toContain('מסייע');
    const log = cssBlock(css, '.pfd-horizon-msg-log');
    expect(log).toMatch(/display:\s*none/);
    expect(log).toMatch(/position:\s*absolute/);
    expect(log).toMatch(/inset-inline-start:\s*6px/);
    expect(log).toMatch(/inset-inline-end:\s*auto/);
    expect(log).toMatch(/flex-direction:\s*column/);
    expect(log).toMatch(/background:\s*none/);
    expect(log).toMatch(/border:\s*0/);
    expect(log).toMatch(/box-shadow:\s*none/);
    expect(log).toMatch(/pointer-events:\s*none/);
    expect(log).not.toMatch(/left:\s*50%/);
    expect(log).not.toMatch(/margin:\s*auto/);
    expect(log).not.toMatch(/text-align:\s*center/);
    expect(log).not.toMatch(/border-radius:\s*[1-9]/);
  });

  it('keeps high-contrast frameless stacked lines for sky / dirt / video', () => {
    const line = cssBlock(css, '.pfd-horizon-msg-log .pfd-horizon-msg-line,\n.pfd-horizon-msg-log .pfc-msg-primary');
    expect(line).toMatch(/color:\s*#ffffff/);
    expect(line).toMatch(/text-shadow:/);
    expect(line).toMatch(/background:\s*none/);
    expect(line).toMatch(/border:\s*0/);
    expect(line).not.toMatch(/border-radius:\s*[1-9]/);
    expect(cssBlock(css, '.pfd-horizon-msg-log .pfd-horizon-msg-line--warn')).toMatch(/color:\s*#ff2a2a/);
  });

  it('demotes the bottom messages region to slim history', () => {
    expect(html).toMatch(/data-mission-region="messages"[^>]*data-messages-expanded="0"/);
    expect(html).toMatch(/id="missionMessagesToggle"/);
    expect(html).toMatch(/class="mission-messages-toggle-label">הודעות</);
    expect(html).toMatch(/id="missionMessagesBadge"/);
    expect(html).toMatch(/id="pfcMsgScroll" hidden/);
    expect(html).not.toMatch(/class="pfc-msg-head"/);
    expect(html).not.toMatch(/class="pfc-msg-label"/);
    const collapsed = cssBlock(css, '.mission-region-messages[data-messages-expanded="0"]');
    expect(collapsed).toMatch(/max-height:\s*min\(40px,\s*var\(--mission-msg-collapsed-max,\s*72px\)\)/);
    const expanded = cssBlock(css, '.mission-region-messages[data-messages-expanded="1"]');
    expect(expanded).toMatch(/max-height:\s*min\(18%, 96px\)/);
    expect(expanded).not.toMatch(/280px/);
    expect(css).toMatch(/--mission-msg-h:\s*min\(18%, 96px\)/);
    expect(cssBlock(css, '.mission-region-horizon > .mission-region-messages')).toMatch(/background:\s*transparent/);
    expect(cssBlock(css, '.mission-region-horizon > .mission-region-messages')).toMatch(/border:\s*0/);
  });

  it('paints live STATUSTEXT as stacked overlay lines plus secondary history', () => {
    expect(js).toContain('function paintFcStatustextOverlay(');
    expect(js).toContain('function paintFcStatustextHistory(');
    expect(js).toContain('function statusTextLineWarn(');
    const apply = sliceFunction(js, 'applyFcStatustextHud');
    expect(apply).toMatch(/pfcMsgPrimaryHe\.textContent = first/);
    expect(apply).toContain('paintFcStatustextOverlay(ordered.slice(0, 8))');
    expect(apply).toContain('paintFcStatustextHistory(_missionMessagesRows)');
    expect(apply).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
    expect(apply).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
    const overlay = sliceFunction(js, 'paintFcStatustextOverlay');
    expect(overlay).toContain('pfd-horizon-msg-line');
    expect(overlay).toContain('data-horizon-msg-extra');
    expect(overlay).toContain("p.dir = 'auto'");
    const extras = [];
    const primary = { textContent: '', classList: { toggle() {} } };
    const log = {
      querySelectorAll() { return extras.splice(0); },
      appendChild(node) { extras.push(node); },
      ownerDocument: {
        createElement() {
          return { dataset: {}, className: '', dir: '', textContent: '' };
        },
      },
    };
    const history = [];
    const scroll = {
      innerHTML: 'x',
      appendChild(node) { history.push(node); },
      ownerDocument: {
        createElement() {
          return { className: '', dir: '', textContent: '' };
        },
      },
    };
    const src = [
      'const pfcMsgPrimaryHe = primary;',
      'const pfdHorizonMsgLog = log;',
      'const pfcMsgScroll = scroll;',
      sliceFunction(js, 'statusTextLineWarn'),
      sliceFunction(js, 'paintFcStatustextOverlay'),
      sliceFunction(js, 'paintFcStatustextHistory'),
      `paintFcStatustextOverlay([
        { text: 'EKF3 IMU0 is using GPS', severity: 6 },
        { text: 'PreArm: Compass not healthy', severity: 2 },
        { text: 'ArduPlane V4.5.0', severity: 6 },
      ]);`,
      'paintFcStatustextHistory([{ text: "a", severity: 6 }, { text: "b", severity: 2 }]);',
      'return { first: primary.textContent, extras: extras.map((n) => n.textContent), warn: extras[0] && extras[0].className, extraCount: extras.length, history: history.map((n) => n.textContent), histWarn: history[1] && history[1].className };',
    ].join('\n');
    const result = new Function('primary', 'log', 'scroll', 'extras', 'history', src)(primary, log, scroll, extras, history);
    expect(result.first).toBe('EKF3 IMU0 is using GPS');
    expect(result.extras).toEqual(['PreArm: Compass not healthy', 'ArduPlane V4.5.0']);
    expect(result.warn).toContain('pfd-horizon-msg-line--warn');
    expect(result.extraCount).toBe(2);
    expect(result.history).toEqual(['a', 'b']);
    expect(result.histWarn).toContain('pfc-msg-line--warn');
  });

  it('keeps commercial copy aligned with side-line messages', () => {
    expect(commercial).toContain('הודעות הבקר מוסתרות כברירת מחדל מאחורי כפתור קטן');
    expect(commercial).toContain('בלי לכסות את המפה או את האופק');
    expect(commercial).not.toContain('אזור **הודעות** הוא פס נמוך כברירת מחדל');
    expect(commercial).not.toContain('מסייע');
    expect(html).not.toContain('מסייע');
    expect(js).not.toContain('מסייע');
  });
});
