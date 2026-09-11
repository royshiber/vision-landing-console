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

describe('AIRVIX 1.02.264 flyable Mission layout', () => {
  it('pins APP_VERSION at 1.02.278', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.278'");
    expect(pkg.version).toBe('1.02.278');
  });

  it('keeps the map as the majority workspace and sizes the PFD in the readable band', () => {
    const workspace = cssBlock(css, '.mission-workspace[data-mission-layout="ops-v1"]');
    expect(workspace).toMatch(/--mission-map-min:\s*65%/);
    expect(workspace).toMatch(/--mission-ah-row:\s*40%/);
    expect(workspace).toMatch(/grid-template-areas:\s*"horizon map talk"/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*min-height:\s*35%/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*max-height:\s*42%/);
    expect(css).not.toMatch(/\.mission-region-horizon \.flight-hud \{[^}]*260px/);
    expect(cssBlock(css, '.pfd-horizon-instrument')).toMatch(/"ias horizon alt"/);
  });

  it('grows a horizontal Assist textarea without a vertical sliver', () => {
    expect(html).toMatch(/<textarea id="assistInput" class="assist-input"/);
    expect(html).not.toMatch(/<input id="assistInput"/);
    expect(css).toMatch(/#missionTalkHost \.assist-form\s*\{[^}]*flex-flow:\s*row nowrap/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\s*\{[^}]*min-width:\s*8rem/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\s*\{[^}]*writing-mode:\s*horizontal-tb/);
    expect(css).toMatch(/#missionTalkHost \.assist-composer\s*\{[^}]*max-height:\s*210px/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\.assist-input--grown \{[\s\S]*?max-height:\s*7\.5em/);
    expect(js).toContain('function syncAssistComposerSize(');
    const grow = sliceFunction(js, 'syncAssistComposerSize');
    expect(grow).toContain('assist-input--grown');
    expect(grow).toMatch(/132/);
    expect(grow).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
    expect(js).toContain("e.key !== 'Enter' || e.shiftKey");
  });

  it('labels the microphone as interface Assist, not flight radio', () => {
    expect(html).toMatch(/id="assistMicBtn"[^>]*title="שיחה עם AIRVIX Ask של הממשק\. לא פקודות טיסה\."/);
    expect(html).toMatch(/class="assist-mic-label">שיחה עם AIRVIX Ask</);
    expect(html).not.toContain('class="assist-mic-caption"');
    const mic = sliceFunction(js, 'assistMicTalkLabel');
    expect(mic).toContain('שיחה עם AIRVIX Ask של הממשק. לא פקודות טיסה.');
    expect(mic).not.toMatch(/רדיו|טייס|מטוס/);
    expect(mic).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
  });

  it('titles the collapsed aircraft-message strip without enlarging it', () => {
    expect(html).toMatch(/data-mission-region="messages"[^>]*aria-label="הודעות מטוס"/);
    expect(html).toMatch(/class="mission-region-title">הודעות מטוס</);
    expect(html).toMatch(/class="pfc-msg-label">הודעות מטוס</);
    expect(html).toMatch(/id="missionMessagesToggle"[^>]*>הצג</);
    expect(css).toMatch(/\.mission-region-messages\[data-messages-expanded="0"\]\s*\{[^}]*max-height:\s*40px/);
    const apply = sliceFunction(js, 'applyMissionMessagesExpanded');
    expect(apply).toContain('הצג');
    expect(apply).toContain('הסתר');
  });

  it('keeps leftover companion Hebrew out of public UI and commercial copy', () => {
    expect(html.includes('מלווה')).toBe(false);
    expect(js.includes('מלווה')).toBe(false);
    expect(css.includes('מלווה')).toBe(false);
    expect(commercial.includes('מלווה')).toBe(false);
    expect(html).toContain('מחשב משימה');
    expect(html).toContain('Jetson');
  });
});
