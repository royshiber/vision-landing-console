import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

function innerText(markup) {
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function maintPanel() {
  return capture(
    html,
    /<section\b[^>]*\bid="maintenance"[^>]*>([\s\S]*?)<\/section>\s*<section\b[^>]*\bid="development"/,
    'missing #maintenance panel',
  )[1];
}

function devPanel() {
  return capture(
    html,
    /<section\b[^>]*\bid="development"[^>]*>([\s\S]*?)<\/section>\s*<section\b[^>]*\bid="simLab"/i,
    'missing #development panel',
  )[1];
}

describe('C10.4c-a Maintenance release handoff', () => {
  it('ships a spoken-Hebrew handoff CTA that is always on Maintenance', () => {
    const maint = maintPanel();
    const handoff = capture(
      maint,
      /<div\b[^>]*\bid="maintRelHandoff"[^>]*>([\s\S]*?)<\/div>/,
      'missing #maintRelHandoff',
    )[0];
    expect(maint.indexOf('id="maintRelHandoff"')).toBeLessThan(maint.indexOf('id="maintLiveSections"'));
    expect(innerText(capture(handoff, /id="maintRelHandoffNote"[^>]*>([\s\S]*?)<\/p>/, 'missing handoff note')[1])).toBe('התקנה ושחזור נעשים בפיתוח.');
    expect(innerText(capture(handoff, /id="maintRelOpenDevReleaseBtn"[^>]*>([\s\S]*?)<\/button>/, 'missing handoff CTA')[1])).toBe('פיתוח — גרסה');
    expect(handoff).not.toMatch(/\bGo to Development\b/i);
    expect(handoff).not.toMatch(/\bRelease section\b/i);
    expect(handoff).not.toMatch(/לחצו כאן/);
    expect(handoff).not.toMatch(/כאן תוכלו/);
  });

  it('removes duplicate product-release authoring CTAs from Maintenance', () => {
    const maint = maintPanel();
    expect(maint).not.toMatch(/id="maintRelRollbackBtn"/);
    expect(maint).not.toMatch(/maint-rel-deploy-btn/);
    expect(maint).not.toMatch(/>\s*שחזור\s*</);
    expect(maint).not.toMatch(/>\s*התקנה\s*</);
    expect(maint).not.toMatch(/>\s*התקנת גרסה\s*</);
    expect(maint).not.toMatch(/id="devReleaseApproveBtn"/);
    expect(maint).not.toMatch(/id="devReleaseCreateBtn"/);
    expect(maint).not.toMatch(/id="devReleaseDeployBtn"/);
    expect(sliceFunction(js, 'maintRelRenderInventory')).not.toMatch(/maint-rel-deploy-btn/);
    expect(sliceFunction(js, 'maintRelRenderInventory')).not.toMatch(/>התקנה</);
  });

  it('keeps read-only active/previous plus backups/health on Maintenance', () => {
    const maint = maintPanel();
    expect(maint).toContain('id="maintRelActiveId"');
    expect(maint).toContain('id="maintRelActiveVersion"');
    expect(maint).toContain('id="maintRelActiveStatus"');
    expect(maint).toContain('id="maintRelPrevId"');
    expect(maint).toContain('id="maintRelPrevVersion"');
    expect(maint).toContain('id="maintRelPrevStatus"');
    expect(maint).toContain('id="maintRelAvailableTable"');
    expect(maint).toContain('id="maintRelBackupsTable"');
    expect(maint).toMatch(/id="maintRelBackupBtn"[^>]*>גיבוי תצורה</);
    expect(maint).toContain('id="maintCpu"');
    expect(maint).toContain('id="maintDiagTable"');
    expect(maint).toContain('<h4 class="maint-group-title">גרסאות</h4>');
  });

  it('leaves Development as the sole approve/create/deploy authoring owner', () => {
    const dev = devPanel();
    expect(dev).toMatch(/id="devReleaseSection"[^>]*>גרסה</);
    expect(innerText(capture(dev, /id="devReleaseApproveBtn"[^>]*>([\s\S]*?)<\/button>/, 'missing #devReleaseApproveBtn')[1])).toBe('אישור לגרסה');
    expect(innerText(capture(dev, /id="devReleaseCreateBtn"[^>]*>([\s\S]*?)<\/button>/, 'missing #devReleaseCreateBtn')[1])).toBe('יצירת גרסה');
    expect(innerText(capture(dev, /id="devReleaseDeployBtn"[^>]*>([\s\S]*?)<\/button>/, 'missing #devReleaseDeployBtn')[1])).toBe('התקנת גרסה');
    expect(js).toMatch(/devReleaseApproveBtn[\s\S]{0,80}devApproveForRelease\(\)/);
    expect(js).toMatch(/devReleaseCreateBtn[\s\S]{0,80}devCreateRelease\(\)/);
    expect(js).toMatch(/devReleaseDeployBtn[\s\S]{0,80}devDeployRelease\(\)/);
  });

  it('opens Development and focuses the existing release section', () => {
    const openFn = sliceFunction(js, 'maintRelOpenDevelopmentRelease');
    expect(openFn).toMatch(/applyMainTab\(\s*'development'\s*\)/);
    expect(openFn).toMatch(/#development/);
    expect(openFn).toMatch(/devReleaseSection/);
    expect(openFn).toMatch(/scrollIntoView/);
    expect(js).toMatch(/maintRelOpenDevReleaseBtn[\s\S]{0,80}maintRelOpenDevelopmentRelease\(\)/);

    const calls = [];
    const section = {
      id: 'devReleaseSection',
      offsetParent: {},
      attributes: {},
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus(opts) { calls.push(['focus', opts]); },
      scrollIntoView(opts) { calls.push(['scroll', opts]); },
    };
    const panel = { id: 'development', scrollIntoView() { calls.push(['panel-scroll']); } };
    const history = { replaceState(_a, _b, url) { calls.push(['hash', url]); } };
    const document = {
      getElementById(id) {
        if (id === 'devReleaseSection') return section;
        if (id === 'development') return panel;
        return null;
      },
    };
    const applyMainTab = (tabId) => { calls.push(['tab', tabId]); };
    const src = `${openFn}\nmaintRelOpenDevelopmentRelease();\nreturn { tabindex: document.getElementById('devReleaseSection').attributes.tabindex };`;
    const result = new Function('applyMainTab', 'document', 'history', src)(applyMainTab, document, history);
    expect(calls).toContainEqual(['tab', 'development']);
    expect(calls).toContainEqual(['hash', '#development']);
    expect(calls.some((c) => c[0] === 'scroll')).toBe(true);
    expect(calls.some((c) => c[0] === 'focus')).toBe(true);
    expect(result.tabindex).toBe('-1');
    expect(calls).not.toContainEqual(['panel-scroll']);
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const openFn = sliceFunction(js, 'maintRelOpenDevelopmentRelease');
    expect(openFn).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(openFn).not.toMatch(/maintenance\/deploy|maintenance\/rollback/);
  });
});
