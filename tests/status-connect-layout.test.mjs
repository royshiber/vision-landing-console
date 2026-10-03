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
  it('paints the pulse camera cards on the dark card surface', () => {
    const card = cssBlock(css, '#pulse .pulse-cam-card');
    expect(card).toMatch(/background:\s*#121826/);
    expect(card).toMatch(/color:\s*#e8edf6/);
    expect(card).not.toMatch(/var\(--surface\)/);
    expect(card).not.toMatch(/overflow:\s*hidden/);
    const name = cssBlock(css, '#pulse .pulse-cam-name {');
    expect(name).toMatch(/font-size:\s*clamp\(11px/);
    expect(name).toMatch(/color:\s*#f2f6fb/);
    expect(name).toMatch(/white-space:\s*normal/);
    const fact = cssBlock(css, '#pulse .pulse-cam-fact {');
    expect(fact).toMatch(/color:\s*#d7e0ee/);
    expect(html).toMatch(/id="pulseCameraCards"[^>]*class="pulse-cam-row"/);
    expect(html).toContain('מצלמות');
    expect(html).not.toContain('id="cam0StatusLine"');
    expect(html).not.toContain('id="cam1StatusLine"');
  });

  it('scrolls the connection popover inside the viewport', () => {
    const panel = cssBlock(css, '.connect-widget-float .conn-panel');
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).toMatch(/overflow-x:\s*hidden/);
    expect(panel).not.toMatch(/overflow:\s*visible/);
    expect(panel).toMatch(/max-height:\s*calc\(100dvh - 72px\)/);
    expect(panel).toMatch(/width:\s*min\(320px,\s*calc\(100vw - 28px\)\)/);
  });

  it('pins the connection pill and panel to the physical left', () => {
    const float = cssBlock(css, '.connect-widget.connect-widget-float');
    expect(float).toMatch(/left:\s*12px/);
    expect(float).toMatch(/right:\s*auto/);
    expect(float).not.toMatch(/inset-inline-/);
    const panel = cssBlock(css, '.connect-widget-float .conn-panel');
    expect(panel).toMatch(/left:\s*0/);
    expect(panel).toMatch(/right:\s*auto/);
    expect(panel).not.toMatch(/inset-inline-/);
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
