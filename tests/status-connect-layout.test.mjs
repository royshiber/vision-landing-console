import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

describe('status camera lines and connection popover layout', () => {
  it('paints the pulse camera lines on the dark card surface', () => {
    const line = cssBlock(css, '#pulse .cam0-status-line');
    expect(line).toMatch(/background:\s*#121826/);
    expect(line).toMatch(/color:\s*#e8edf6/);
    expect(line).not.toMatch(/var\(--surface\)/);
    expect(line).toMatch(/font-size:\s*clamp\(11px/);
    expect(line).toMatch(/white-space:\s*normal/);
    expect(html).toMatch(/id="cam0StatusLine"[^>]*class="cam0-status-line"/);
    expect(html).toMatch(/id="cam1StatusLine"[^>]*class="cam0-status-line"/);
  });

  it('scrolls the connection popover inside the viewport', () => {
    const panel = cssBlock(css, '.connect-widget-float .conn-panel');
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).toMatch(/overflow-x:\s*hidden/);
    expect(panel).not.toMatch(/overflow:\s*visible/);
    expect(panel).toMatch(/max-height:\s*calc\(100dvh - 72px\)/);
    expect(panel).toMatch(/width:\s*min\(320px,\s*calc\(100vw - 28px\)\)/);
  });

  it('stacks each link row and darkens the port and baud selects', () => {
    const copy = cssBlock(css, '.connect-widget-float .comm-link-copy');
    expect(copy).toMatch(/flex-direction:\s*column/);
    expect(copy).not.toMatch(/grid-template-areas/);
    const row = cssBlock(css, '.connect-widget-float .comm-link-row {');
    expect(row).toMatch(/min-height:\s*min-content/);
    expect(row).toMatch(/flex:\s*0 0 auto/);
    const fields = cssBlock(css, '.connect-widget-float .conn-panel :is(.conn-select, .conn-input)');
    expect(fields).toMatch(/background:\s*#0d1320/);
    expect(fields).toMatch(/color:\s*#f2f6fb/);
  });

  it('keeps RF as an isolated Latin token on the connect button', () => {
    expect(html).toMatch(/id="connectBtn"[^>]*>חיבור ל-<bdi dir="ltr">RF<\/bdi><\/button>/);
    expect(js).toContain("label === 'חיבור ל-RF'");
    expect(js).toContain("document.createElement('bdi')");
    expect(js).toContain("token.dir = 'ltr'");
    expect(js).toContain("token.textContent = 'RF'");
  });
});
