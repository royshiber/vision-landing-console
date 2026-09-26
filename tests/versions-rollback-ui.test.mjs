import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotRoot = path.join(repoRoot, 'versions-qa');
const shotDir = path.join(shotRoot, 'shots');

const VIEWPORTS = [
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '360x740', width: 360, height: 740 },
];

const STATES = ['normal', 'no-companion', 'confirm', 'progress', 'failed'];

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function viewPayload(linked) {
  return {
    ok: true,
    console: {
      version: '1.02.338',
      installedAt: linked ? '2026-09-26T08:15:00Z' : '2026-09-26T08:15:00Z',
      previousVersion: '1.02.335',
      rollbackAvailable: true,
      rollbackUnavailableReason: null,
    },
    companion: linked
      ? {
          linked: true,
          version: '2.6.0',
          deployedAt: '2026-09-26T09:40:00Z',
          gitSha: 'abc123def456',
          knownGood: false,
          backups: [
            {
              id: '20260926T100000Z',
              version: '2.5.0',
              deployedAt: '2026-09-25T18:00:00Z',
              gitSha: 'bbb222',
              knownGood: true,
            },
          ],
        }
      : {
          linked: false,
          version: null,
          deployedAt: null,
          gitSha: null,
          backups: [],
          message: 'אין קישור למחשב המשימה',
        },
    fcParams: { snapshotAt: linked ? '2026-09-20 08:30:00' : null },
    knownGood: linked
      ? {
          at: '2026-09-26T11:00:00Z',
          source: 'manual',
          consoleVersion: '1.02.338',
          companionVersion: '2.6.0',
        }
      : null,
    rollback: { state: 'idle', kind: null, from: null, to: null, error: null },
  };
}

describe('versions and rollback view', () => {
  let server;
  let base;
  let browser;
  const shots = [];

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    const app = express();
    app.use(express.static(path.join(repoRoot, 'public')));
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}/index.html`;
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (shots.length) composeSheet(shots);
  });

  async function openPage(viewport, state) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      locale: 'he-IL',
    });
    const linked = state !== 'no-companion';
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/.test(url)) return route.abort();
      return route.continue();
    });
    await page.route('**/api/**', (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (method === 'POST' && url.includes('/api/versions/rollback/')) {
        if (state === 'failed') {
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, message: 'השחזור נכשל. השירות לא עלה.' }),
          });
        }
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            state: 'restarting',
            from: '1.02.338',
            to: '1.02.335',
          }),
        });
      }
      if (url.includes('/api/versions')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(viewPayload(linked)),
        });
      }
      if (url.includes('/api/v1/update/status')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            available: false,
            current: '1.02.338',
            latest: '1.02.338',
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const node = document.getElementById('vrConsoleVersion');
      return node && node.textContent && node.textContent.includes('1.02.338');
    });
    await page.click('#globalSettingsBtn');
    await page.waitForSelector('#globalSettingsModal:not([hidden])');
    await page.locator('#gsVersions').scrollIntoViewIfNeeded();
    if (state === 'confirm' || state === 'progress' || state === 'failed') {
      await page.click('#vrConsoleRollbackBtn');
      await page.waitForSelector('#vrConfirm:not([hidden])');
    }
    if (state === 'progress') {
      await page.click('#vrConfirmYes');
      await page.waitForSelector('#vrProgress:not([hidden])');
    }
    if (state === 'failed') {
      await page.click('#vrConfirmYes');
      await page.waitForSelector('#vrError:not([hidden])');
    }
    return page;
  }

  async function assertFit(page, label) {
    const dir = await page.locator('html').getAttribute('dir');
    expect(dir, label).toBe('rtl');
    const phase = await page.locator('#gsVersions').getAttribute('data-vr-state');
    const report = await page.evaluate(() => {
      const root = document.getElementById('gsVersions');
      const card = document.querySelector('.global-settings-card');
      const problems = [];
      const cardRect = card.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      if (rootRect.left < cardRect.left - 1 || rootRect.right > cardRect.right + 1) {
        problems.push({ kind: 'section-outside-card', left: rootRect.left, right: rootRect.right, cardLeft: cardRect.left, cardRight: cardRect.right });
      }
      if (cardRect.left < -1 || cardRect.right > window.innerWidth + 1) {
        problems.push({ kind: 'card-outside-viewport', left: cardRect.left, right: cardRect.right, vw: window.innerWidth });
      }
      const nodes = [root, ...root.querySelectorAll('*')];
      for (const el of nodes) {
        if (el.hidden || el.closest('[hidden]')) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const size = parseFloat(style.fontSize);
        const hasText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        if (hasText && size < 11) {
          problems.push({ kind: 'font', id: el.id, cls: el.className, size, text: el.textContent.trim().slice(0, 40) });
        }
        if (style.textOverflow === 'ellipsis') {
          problems.push({ kind: 'ellipsis', id: el.id, cls: String(el.className) });
        }
        if (el.scrollWidth > el.clientWidth + 2) {
          problems.push({
            kind: 'overflow-x',
            id: el.id,
            cls: String(el.className).slice(0, 60),
            delta: el.scrollWidth - el.clientWidth,
            text: (el.textContent || '').trim().slice(0, 40),
          });
        }
        const clipsY = style.overflowY === 'hidden' || style.overflow === 'hidden';
        if (clipsY && el.scrollHeight > el.clientHeight + 2) {
          problems.push({
            kind: 'clip-y',
            id: el.id,
            cls: String(el.className).slice(0, 60),
            delta: el.scrollHeight - el.clientHeight,
          });
        }
      }
      return { problems, phase: root.dataset.vrState };
    });
    expect(report.problems, `${label} ${JSON.stringify(report.problems)}`).toEqual([]);
    expect(phase, label).toBeTruthy();
    return phase;
  }

  it('fits Hebrew RTL at every viewport and state', async () => {
    for (const viewport of VIEWPORTS) {
      for (const state of STATES) {
        const label = `${state}-${viewport.name}`;
        const page = await openPage(viewport, state);
        try {
          const phase = await assertFit(page, label);
          if (state === 'normal') expect(phase).toBe('normal');
          const textOf = async (selector) => (await page.locator(selector).textContent()) || '';
          if (state === 'no-companion') {
            expect(phase).toBe('no-companion');
            expect(await textOf('#vrCompanionVersion')).toBe('גרסה לא ידועה');
            expect(await textOf('#vrFcSnapshot')).toBe('תאריך לא ידוע');
          }
          if (state === 'confirm') {
            expect(phase).toBe('confirm');
            expect(await textOf('#vrConfirmTitle')).toContain('קונסולה');
            expect(await textOf('#vrConfirmFrom')).toContain('1.02.338');
            expect(await textOf('#vrConfirmTo')).toContain('1.02.335');
            expect(await textOf('#vrConfirm')).not.toContain('אל אין מידע');
            const box = await page.locator('#vrConfirmYes').boundingBox();
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
            expect(await page.evaluate(() => document.activeElement?.id)).toBe('vrConfirmYes');
            const ltr = await page.locator('#vrConfirmFrom bdi').getAttribute('dir');
            expect(ltr).toBe('ltr');
          }
          if (state === 'progress') {
            expect(phase).toBe('progress');
            expect(await textOf('#vrProgress')).toContain('1.02.338');
            expect(await textOf('#vrProgress')).toContain('1.02.335');
            expect(await page.locator('#vrProgress').getAttribute('role')).toBe('status');
            expect(await page.locator('#vrProgress').getAttribute('aria-live')).toBe('polite');
            expect(await page.evaluate(() => document.activeElement?.id)).toBe('vrProgress');
            expect(await page.locator('#vrConsoleRollbackBtn').isDisabled()).toBe(true);
            expect(await page.locator('.vr-backup-btn').first().isDisabled()).toBe(true);
          }
          if (state === 'failed') {
            expect(phase).toBe('failed');
            expect(await textOf('#vrError')).toContain('השחזור נכשל');
            expect(await page.locator('#vrDismiss').isVisible()).toBe(true);
            expect(await page.locator('#vrError').getAttribute('aria-live')).toBe('assertive');
            expect(await page.evaluate(() => document.activeElement?.id)).toBe('vrError');
          }
          if (state === 'no-companion') {
            expect(await textOf('#vrKnownGoodStatus')).toBe('לא סומן');
          }
          const file = path.join(shotDir, `${label}.png`);
          await page.locator('#gsVersions').screenshot({ path: file });
          expect(fs.statSync(file).size).toBeGreaterThan(1000);
          shots.push({ file, state, viewport: viewport.name });
        } finally {
          await page.close();
        }
      }
    }
  }, 180000);

  it('traps confirm focus, names an unversioned backup, and shows the known-good error', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: 'he-IL' });
    let versionCalls = 0;
    await page.route('**/api/**', (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.includes('/api/versions/known-good') && method === 'POST') {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, message: 'אסור לסמן' }),
        });
      }
      if (url.includes('/api/versions')) {
        versionCalls += 1;
        const payload = viewPayload(true);
        payload.knownGood = null;
        payload.companion.backups.push({
          id: '20260918T080000Z',
          version: null,
          deployedAt: '2026-09-18T08:00:00Z',
          gitSha: null,
          knownGood: false,
        });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, current: '1.02.338', latest: '1.02.338' }) });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const before = versionCalls;
    const nextLoad = page.waitForResponse((res) => res.url().includes('/api/versions') && res.request().method() === 'GET');
    await page.click('#globalSettingsBtn');
    await nextLoad;
    expect(versionCalls).toBeGreaterThan(before);
    await page.click('#vrKnownGoodBtn');
    await page.waitForSelector('#vrKnownGoodError:not([hidden])');
    expect(await page.locator('#vrKnownGoodError').textContent()).toBe('אסור לסמן');
    await page.locator('.vr-backup-btn').nth(1).click();
    await page.waitForSelector('#vrConfirm:not([hidden])');
    const confirmText = await page.locator('#vrConfirm').textContent();
    expect(confirmText).toContain('מחשב המשימה');
    expect(confirmText).toContain('גרסה לא ידועה');
    expect(confirmText).toContain('תאריך');
    expect(confirmText).not.toContain('אל אין מידע');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('vrConfirmNo');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('vrConfirmYes');
    await page.keyboard.press('Escape');
    expect(await page.locator('#vrConfirm').isHidden()).toBe(true);
    expect(await page.locator('#globalSettingsModal').isVisible()).toBe(true);
    await page.close();
  }, 60000);
});

function composeSheet(items) {
  const manifest = path.join(shotRoot, 'shots.json');
  fs.writeFileSync(manifest, JSON.stringify(items, null, 2));
  const script = `
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
items = json.loads(Path(sys.argv[1]).read_text())
states = ${JSON.stringify(STATES)}
views = ${JSON.stringify(VIEWPORTS.map((v) => v.name))}
cell_w, label_h, pad = 280, 28, 8
thumbs = {}
for item in items:
    im = Image.open(item["file"]).convert("RGB")
    ratio = cell_w / im.width
    thumbs[(item["state"], item["viewport"])] = im.resize((cell_w, max(1, int(im.height * ratio))), Image.Resampling.LANCZOS)
row_h = {}
for state in states:
    heights = [thumbs[(state, view)].height for view in views if (state, view) in thumbs]
    if not heights:
        continue
    row_h[state] = max(heights)
states = [state for state in states if state in row_h]
width = pad + len(views) * (cell_w + pad)
height = pad + label_h + sum(label_h + row_h[s] + pad for s in states)
sheet = Image.new("RGB", (width, height), (246, 244, 239))
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default()
for i, view in enumerate(views):
    draw.text((pad + i * (cell_w + pad), 6), view, fill=(20, 20, 20), font=font)
y = pad + label_h
for state in states:
    draw.text((pad, y), state, fill=(20, 20, 20), font=font)
    y += label_h
    for i, view in enumerate(views):
        im = thumbs.get((state, view))
        if im is None:
            continue
        x = pad + i * (cell_w + pad)
        sheet.paste(im, (x, y))
    y += row_h[state] + pad
out = Path(sys.argv[2])
sheet.save(out, "PNG")
print(out)
`;
  const py = path.join(shotRoot, '_sheet.py');
  fs.writeFileSync(py, script);
  const out = path.join(shotRoot, 'contact-sheet.png');
  const result = spawnSync('python3', [py, manifest, out], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'contact sheet failed');
  }
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.copyFileSync(out, '/opt/cursor/artifacts/versions-contact-sheet.png');
}
