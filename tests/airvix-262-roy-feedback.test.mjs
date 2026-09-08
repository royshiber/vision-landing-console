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

function publicUiFiles() {
  return [
    ['public/index.html', html],
    ['public/app.js', js],
    ['public/styles.css', css],
    ['public/changelog.json', fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8')],
  ];
}

describe('AIRVIX 1.02.262 Roy Mission chrome', () => {
  it('pins APP_VERSION at 1.02.262', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.262'");
    expect(pkg.version).toBe('1.02.262');
  });

  it('grows the Mission Assist composer on focus and keeps typed text visible', () => {
    expect(html).toMatch(/<textarea id="assistInput" class="assist-input"/);
    expect(html).not.toMatch(/<input id="assistInput"/);
    expect(css).toMatch(/#missionTalkHost \.assist-input:focus/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\.assist-input--grown/);
    expect(css).toMatch(/#missionTalkHost \.assist-input\.assist-input--grown \{[\s\S]*?min-height:\s*6\.4em/);
    expect(css).toMatch(/#missionTalkHost \.assist-input:not\(:focus\):not\(\.assist-input--grown\)\s*\{[^}]*min-height:\s*2\.2em/);
    expect(js).toContain('function syncAssistComposerSize(');
    const grow = sliceFunction(js, 'syncAssistComposerSize');
    expect(grow).toContain("input.tagName !== 'TEXTAREA'");
    expect(grow).toContain('assist-input--grown');
    expect(grow).toMatch(/focused \? 92 : 72/);
    expect(js).toContain("e.key !== 'Enter' || e.shiftKey");
    expect(grow).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET/);
  });

  it('labels the microphone as interface Assist, not flight radio', () => {
    expect(html).toMatch(/id="assistMicBtn"[^>]*title="שיחה עם המסייע של הממשק\. לא פקודות טיסה\."/);
    expect(html).toMatch(/id="assistMicBtn"[^>]*aria-label="שיחה עם המסייע של הממשק\. לא פקודות טיסה\."/);
    expect(html).toMatch(/class="assist-mic-label">שיחה עם המסייע</);
    expect(html).toMatch(/class="assist-mic-caption">שיחה עם הממשק</);
    expect(js).toContain('function assistMicTalkLabel(');
    const mic = sliceFunction(js, 'assistMicTalkLabel');
    expect(mic).toContain('שיחה עם המסייע של הממשק. לא פקודות טיסה.');
    expect(mic).not.toMatch(/רדיו|טייס|מטוס/);
    expect(mic).not.toMatch(/\bARM\b|\bDISARM\b|\bLAND\b/);
    expect(css).toMatch(/\.assist-mic-caption\s*\{/);
  });

  it('makes aircraft messages discoverable without enlarging the collapsed strip', () => {
    expect(html).toMatch(/data-mission-region="messages"[^>]*aria-label="הודעות מטוס"/);
    expect(html).toMatch(/class="mission-region-title">הודעות מטוס</);
    expect(html).toMatch(/class="pfc-msg-label">הודעות מטוס</);
    expect(html).toMatch(/id="missionMessagesToggle"[^>]*>הצג ▾</);
    expect(css).toMatch(/\.mission-region-messages\[data-messages-expanded="0"\]\s*\{[^}]*max-height:\s*40px/);
    expect(css).toMatch(/\.mission-region-messages\s*\{[^}]*background:\s*#1d4ed8/);
    expect(css).toMatch(/\.mission-messages-toggle\s*\{[^}]*background:\s*#f8fafc/);
    const apply = sliceFunction(js, 'applyMissionMessagesExpanded');
    expect(apply).toContain('הצג ▾');
    expect(apply).toContain('הסתר ▴');
    expect(css).toMatch(/minmax\(132px, min\(22%, var\(--mission-ah-col\)\)\)/);
    expect(css).toMatch(/\.mission-region-horizon \.flight-hud \{\s*max-height:\s*min\(260px, var\(--mission-ah-row/);
  });

  it('keeps מלווה out of public UI strings', () => {
    for (const [name, src] of publicUiFiles()) {
      expect(src.includes('מלווה'), `user-visible מלווה in ${name}`).toBe(false);
    }
    expect(html).toContain('מחשב משימה');
    expect(html).toContain('Jetson');
  });

  it('softens the Assist empty well and does not change Develop concept', () => {
    expect(css).toMatch(/#missionTalkHost \.assist-transcript-well\s*\{[^}]*background:\s*#243044/);
    expect(css).toMatch(/#missionTalkHost \.assist-empty-stage[^{]*\{[^}]*background:\s*#2a3648/);
    expect(html).toContain('class="devtasks-panel evolve-shell"');
    expect(html).toContain('class="evolve-intent"');
    expect(html).toContain('class="evolve-preview"');
    expect(js).not.toMatch(/FLIGHT_ACTION/);
  });
});
