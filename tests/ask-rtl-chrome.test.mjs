import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BIDI_FSI, rtlSafeAskText } from '../lib/rtl-bidi.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

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

describe('AIRVIX Ask RTL / BiDi chrome', () => {
  it('pins APP_VERSION at 1.02.329', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.329'");
    expect(pkg.version).toBe('1.02.329');
  });

  it('keeps the Mission grid LTR while isolating Ask as RTL', () => {
    const workspace = cssBlock(css, '.mission-workspace[data-mission-layout="ops-v1"]');
    expect(workspace).toMatch(/direction:\s*ltr/);
    expect(html).toMatch(/id="assistRail"[^>]*\bdir="rtl"/);
    expect(html).toMatch(/data-mission-region="talk"[^>]*\bdir="rtl"/);
    expect(html).toMatch(/id="missionTalkHost"[^>]*\bdir="rtl"/);
    expect(cssBlock(css, '.mission-region-talk')).toMatch(/direction:\s*rtl/);
    expect(css).toMatch(/\.assist-rail \{\n[^}]*direction:\s*rtl/);
    expect(css).toMatch(/\.assist-rail \{\n[^}]*unicode-bidi:\s*isolate/);
  });

  it('isolates locked English tokens in Ask chrome', () => {
    expect(html).toMatch(/class="assist-rail-title"[^>]*>\s*<bdi dir="ltr">AIRVIX Ask<\/bdi>/);
    expect(html).toMatch(/id="assistEmptyInvite"[^>]*>שאלו את <bdi dir="ltr">AIRVIX Ask<\/bdi>\./);
    expect(html).toMatch(/class="assist-mic-label">שיחה עם <bdi dir="ltr">AIRVIX Ask<\/bdi>/);
    expect(html).toMatch(/id="assistVoiceGoBtn"[^>]*\bdir="ltr"[^>]*>GO</);
    expect(html).toMatch(/id="assistVoiceGoEndBtn"[^>]*>סיום <bdi dir="ltr">GO<\/bdi>/);
    expect(html).not.toContain('מסייע');
    expect(js).not.toContain('מסייע');
  });

  it('applies the same RTL helper in the Ask rail as the tested module', () => {
    expect(js).toContain('function isolateLtrToken(');
    expect(js).toContain('function rtlSafeAskText(');
    expect(js).toContain("invite.textContent = rtlSafeAskText(");
    expect(js).toContain('statusEl.textContent = rtlSafeAskText(');
    expect(js).toContain("hintEl.textContent = rtlSafeAskText('חברו מפתח כדי לאשר שינוי.')");
    expect(js).toContain('assistEscape(rtlSafeAskText(text))');
    expect(rtlSafeAskText('שאלו את AIRVIX Ask.')).toContain(BIDI_FSI);
  });

  it('lets the Mission invite wrap on a narrow Ask column', () => {
    expect(css).toMatch(/#missionTalkHost \.assist-empty-invite \{\n[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/#missionTalkHost \.assist-empty-invite \{\n[^}]*white-space:\s*nowrap/);
  });
});
