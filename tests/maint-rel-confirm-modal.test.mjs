import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

function firstRuleBody(src, selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`);
  const m = src.match(re);
  expect(m, `missing CSS rule ${selector}`).toBeTruthy();
  return m[1];
}

function runOpenConfirm(title, htmlBody, { busy = false } = {}) {
  const modal = { hidden: true };
  const titleEl = { textContent: '—' };
  const bodyEl = { innerHTML: '' };
  const document = {
    getElementById(id) {
      if (id === 'maintRelConfirmModal') return modal;
      if (id === 'maintRelConfirmTitle') return titleEl;
      if (id === 'maintRelConfirmBody') return bodyEl;
      return null;
    },
  };
  const src = [
    'let _maintRelBusy = busy;',
    'let _maintRelPendingAction = null;',
    sliceFunction(js, 'maintRelConfirmHasCopy'),
    sliceFunction(js, 'maintRelOpenConfirm'),
    'maintRelOpenConfirm(title, htmlBody, onOk);',
    'return { hidden: document.getElementById("maintRelConfirmModal").hidden, title: document.getElementById("maintRelConfirmTitle").textContent, body: document.getElementById("maintRelConfirmBody").innerHTML, pending: _maintRelPendingAction };',
  ].join('\n');
  const onOk = () => {};
  return new Function('document', 'busy', 'title', 'htmlBody', 'onOk', src)(
    document,
    busy,
    title,
    htmlBody,
    onOk,
  );
}

describe('Maintenance release confirm modal visibility', () => {
  it('ships with HTML hidden on #maintRelConfirmModal', () => {
    const tag = html.match(/<div\b[^>]*\bid="maintRelConfirmModal"[^>]*>/);
    expect(tag, 'missing #maintRelConfirmModal').toBeTruthy();
    expect(tag[0]).toMatch(/\bhidden\b/);
    expect(tag[0]).toMatch(/\bclass="[^"]*\bmaint-rel-modal\b/);
  });

  it('keeps [hidden] winning over .maint-rel-modal { display:flex }', () => {
    const flexBody = firstRuleBody(css, '.maint-rel-modal');
    expect(flexBody).toMatch(/display:\s*flex/);
    const hiddenBody = firstRuleBody(css, '.maint-rel-modal[hidden]');
    expect(hiddenBody).toMatch(/display:\s*none\s*!important/);
    expect(css.indexOf('.maint-rel-modal[hidden]')).toBeGreaterThan(css.indexOf('.maint-rel-modal {'));
  });

  it('does not open the confirm without a real title and body', () => {
    const emptyTitle = runOpenConfirm('', '<p>גוף</p>');
    expect(emptyTitle.hidden).toBe(true);
    expect(emptyTitle.pending).toBeNull();

    const placeholderTitle = runOpenConfirm('—', '<p>גוף</p>');
    expect(placeholderTitle.hidden).toBe(true);

    const emptyBody = runOpenConfirm('כותרת', '');
    expect(emptyBody.hidden).toBe(true);

    const tagOnlyBody = runOpenConfirm('כותרת', '<p></p>');
    expect(tagOnlyBody.hidden).toBe(true);

    const opened = runOpenConfirm('התקנת גרסה', '<p>להתקין את הגרסה הזו?</p>');
    expect(opened.hidden).toBe(false);
    expect(opened.title).toBe('התקנת גרסה');
    expect(opened.body).toContain('להתקין את הגרסה הזו?');
    expect(typeof opened.pending).toBe('function');
  });

  it('uses Hebrew deploy/rollback confirm copy and keeps אישור / ביטול', () => {
    const deployFn = sliceFunction(js, 'maintRelOpenDeployConfirm');
    expect(deployFn).toMatch(/התקנת גרסה/);
    expect(deployFn).toMatch(/להתקין את הגרסה הזו\?/);
    expect(deployFn).not.toMatch(/Install this release\?/);
    expect(deployFn).not.toMatch(/Deploy release/);

    const rollbackFn = sliceFunction(js, 'maintRelOpenRollbackConfirm');
    expect(rollbackFn).toMatch(/שחזור לגרסה קודמת/);
    expect(rollbackFn).toMatch(/לחזור לגרסה הקודמת\?/);
    expect(rollbackFn).not.toMatch(/Rollback to previous release\?/);
    expect(rollbackFn).not.toMatch(/maintRelOpenConfirm\('Rollback'/);

    expect(html).toMatch(/id="maintRelConfirmCancel"[^>]*>ביטול</);
    expect(html).toMatch(/id="maintRelConfirmOk"[^>]*>אישור</);
  });

  it('still closes on cancel and overlay click', () => {
    expect(js).toMatch(/maintRelConfirmCancel[\s\S]{0,80}maintRelCloseConfirm\(\)/);
    expect(js).toMatch(/getElementById\('maintRelConfirmModal'\)[\s\S]{0,160}maintRelCloseConfirm\(\)/);
    const closeFn = sliceFunction(js, 'maintRelCloseConfirm');
    expect(closeFn).toMatch(/modal\.hidden\s*=\s*true/);
  });
});
