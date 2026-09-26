/**
 * Reusable text-fit assertion. Runs in the page.
 * A visible text box passes only when:
 *   scrollWidth <= clientWidth
 *   scrollHeight <= clientHeight
 *   its border box lies inside the parent tile
 * Inline runs (no client box) must keep their line boxes inside the parent tile.
 * One pixel covers subpixel rounding. Hidden clip-rects and [hidden] subtrees are skipped.
 */
export function collectTextFitFailures(slack = 1) {
  const fails = [];
  const skipSel = [
    'script', 'style', 'svg', 'noscript', 'template', 'option', 'textarea', 'input', 'select',
    '.mission-region-title', '.visually-hidden', '.config-text-hidden', '.mission-sr-only',
    '.mission-identity', '.mission-layout-hint', '.mission-data-hint', '.mission-talk-hint',
    '.mission-ask-chip', '.pfc-opt-mini', '.comm-link-sr', '.pulse-purpose',
  ].join(',');

  function directText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function hidden(el) {
    if (!el || el.closest('[hidden]')) return true;
    if (el.closest(skipSel)) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    return false;
  }

  function tileOf(el) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') return null;
    if (cs.position === 'absolute' || cs.position === 'sticky') return el.offsetParent || el.parentElement;
    return el.parentElement;
  }

  function outside(el, tile) {
    if (!tile || tile === el || tile === document.body || tile === document.documentElement) return null;
    const a = el.getBoundingClientRect();
    const b = tile.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return null;
    const cs = getComputedStyle(tile);
    let left = b.left - a.left;
    let top = b.top - a.top;
    let right = a.right - b.right;
    let bottom = a.bottom - b.bottom;
    if (/(auto|scroll|overlay)/.test(cs.overflowX)) {
      const x = (a.left - b.left) + tile.scrollLeft;
      if (x >= -slack && x + a.width <= tile.scrollWidth + slack) {
        left = 0;
        right = 0;
      }
    }
    if (/(auto|scroll|overlay)/.test(cs.overflowY)) {
      const y = (a.top - b.top) + tile.scrollTop;
      if (y >= -slack && y + a.height <= tile.scrollHeight + slack) {
        top = 0;
        bottom = 0;
      }
    }
    const over = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.max(0, right),
      bottom: Math.max(0, bottom),
    };
    if (over.left > slack || over.top > slack || over.right > slack || over.bottom > slack) return over;
    return null;
  }

  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  function push(el, reason, extra) {
    fails.push({
      reason,
      who: describe(el),
      text: directText(el).slice(0, 48),
      ...extra,
    });
  }

  const leaves = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (hidden(el)) return;
    const text = directText(el);
    if (!text) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    leaves.push(el);
    const cs = getComputedStyle(el);
    const fontPx = Number.parseFloat(cs.fontSize) || 0;
    if (fontPx < 10.5) {
      push(el, 'small', { fontPx: Math.round(fontPx * 10) / 10 });
    }
    const clientW = el.clientWidth;
    const clientH = el.clientHeight;
    if (clientW < 1 || clientH < 1) {
      const tile = tileOf(el);
      const spill = outside(el, tile);
      if (spill) push(el, 'outside', { spill, box: 'inline' });
      return;
    }
    const widthOver = el.scrollWidth - clientW;
    const heightOver = el.scrollHeight - clientH;
    if (widthOver > slack) push(el, 'width', { widthOver, sw: el.scrollWidth, cw: clientW });
    if (heightOver > slack) push(el, 'height', { heightOver, sh: el.scrollHeight, ch: clientH });
    const spill = outside(el, tileOf(el));
    if (spill) push(el, 'outside', { spill });
  });

  const overlapRoots = document.querySelectorAll(
    '.mission-horizon-filler, .mission-data-tile, .pfd-top-bar, .mission-data-readout',
  );
  overlapRoots.forEach((root) => {
    if (hidden(root)) return;
    const nodes = leaves.filter((el) => root.contains(el));
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 4 && h > 4) {
          fails.push({
            reason: 'overlap',
            who: `${describe(a)} × ${describe(b)}`,
            text: `${directText(a).slice(0, 24)} | ${directText(b).slice(0, 24)}`,
            w: Math.round(w),
            h: Math.round(h),
          });
        }
      }
    }
  });

  return { checked: leaves.length, fails };
}
