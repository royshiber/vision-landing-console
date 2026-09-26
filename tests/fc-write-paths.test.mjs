import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyFcWrite, FC_NO_LINK_HE } from '../public/modules/fc-write-ack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('FC write acknowledgement', () => {
  const requested = { EK3_ENABLE: 0, EK3_SRC1_POSXY: 1 };

  it('blocks before a write when there is no link', () => {
    const out = classifyFcWrite({ linked: false, requested, httpOk: false, data: null });
    expect(out.text).toBe(FC_NO_LINK_HE);
    expect(out.posted).toBe(false);
    expect(out.history).toBe(false);
    expect(out.clear).toEqual([]);
    expect(out.keep).toEqual(['EK3_ENABLE', 'EK3_SRC1_POSXY']);
    expect(out.level).not.toBe('ok');
  });

  it('does not succeed on a partial read-back', () => {
    const out = classifyFcWrite({
      linked: true,
      requested,
      httpOk: true,
      data: {
        ok: false,
        simulated: false,
        via: 'mavlink',
        verified: { EK3_ENABLE: 0 },
        message: 'WRITE SUCCESS',
      },
    });
    expect(out.level).toBe('partial');
    expect(out.history).toBe(true);
    expect(out.clear).toEqual(['EK3_ENABLE']);
    expect(out.keep).toEqual(['EK3_SRC1_POSXY']);
    expect(out.text).not.toMatch(/WRITE/);
  });

  it('succeeds only when every key matches', () => {
    const out = classifyFcWrite({
      linked: true,
      requested,
      httpOk: true,
      data: { ok: true, simulated: false, via: 'mavlink', verified: { EK3_ENABLE: 0, EK3_SRC1_POSXY: 1 } },
    });
    expect(out.level).toBe('ok');
    expect(out.clear).toEqual(['EK3_ENABLE', 'EK3_SRC1_POSXY']);
  });

  it('treats an offline success payload as no link', () => {
    const out = classifyFcWrite({
      linked: true,
      requested,
      httpOk: true,
      data: { ok: true, simulated: true, via: 'offline', message: 'WRITE SUCCESS', verified: {} },
    });
    expect(out.level).toBe('fail');
    expect(out.history).toBe(false);
    expect(out.text).toBe(FC_NO_LINK_HE);
    expect(out.clear).toEqual([]);
  });
});

function startServer(port) {
  const sqlite = path.join(os.tmpdir(), `airvix-fc-write-${port}.sqlite`);
  fs.rmSync(sqlite, { force: true });
  return spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_PATH: sqlite,
      GEMINI_API_KEY: '',
      COMPANION_MODE: 'off',
    },
    stdio: 'ignore',
  });
}

async function waitHealth(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`fc write server did not become healthy at ${base}`);
}

describe('FC write paths in the parameters tab', () => {
  const PORT = '4038';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;
  let page = null;
  let linked = false;
  let partial = false;
  let posts = 0;

  async function confirmWrite() {
    await page.waitForSelector('#applyConfirmModal:not(.hidden)');
    await page.click('#applyConfirmOkBtn');
  }

  beforeAll(async () => {
    serverProc = startServer(PORT);
    await waitHealth(BASE);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.addInitScript(() => {
      try {
        sessionStorage.clear();
        localStorage.removeItem('vlc.fcWizard.runs.v1');
      } catch { /* ignore */ }
    });
    await page.route(/\/api\/ardu\/params(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(linked
          ? {
            ok: true,
            connected: true,
            mavlinkConnected: true,
            armed: false,
            paramCount: 2,
            current: { EK3_ENABLE: 1, EK3_SRC1_POSXY: 0 },
          }
          : {
            ok: true,
            connected: true,
            mavlinkConnected: false,
            armed: false,
            paramCount: 1,
            current: { EK3_ENABLE: 9 },
          }),
      });
    });
    await page.route(/\/api\/ardu\/params\/write$/, async (route) => {
      posts += 1;
      const body = route.request().postDataJSON() || {};
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const keys = Object.keys(params);
      const verified = {};
      if (partial && keys[0]) verified[keys[0]] = Number(params[keys[0]]);
      else if (!partial) Object.assign(verified, params);
      await route.fulfill({
        status: partial ? 207 : 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: !partial,
          simulated: false,
          via: 'mavlink',
          written: Object.keys(verified).length,
          failed: partial ? keys.slice(1).map((param) => ({ param })) : [],
          verified,
          message: 'WRITE SUCCESS',
        }),
      });
    });
    await page.route(/\/api\/ardu\/param-files/, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/param-files/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            file: {
              id: '1700000000000-read-abcd1234',
              source: 'read',
              savedAt: '2026-09-26T08:00:00.000Z',
              count: 2,
              params: { EK3_ENABLE: 0, EK3_SRC1_POSXY: 3 },
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          files: [{ id: '1700000000000-read-abcd1234', source: 'read', savedAt: '2026-09-26T08:00:00.000Z', count: 2 }],
        }),
      });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
  }, 40000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function openGroup() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('vlc.fcWizard.runs.v1'));
    await page.click('[data-tab="control"]');
    await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
    await page.waitForSelector('#fcGroupList [data-param-key="EK3_ENABLE"]');
    await page.waitForSelector('#fcGroupList [data-param-key="EK3_SRC1_POSXY"]');
  }

  it('reads a disconnected controller as a Hebrew failure, not the stored copy', async () => {
    linked = false;
    partial = false;
    posts = 0;
    await openGroup();
    expect(await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-now').innerText()).toBe('לא ידוע');
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => (document.getElementById('arduWriteStatus')?.textContent || '').includes('אין חיבור לבקר הטיסה'));
    expect(await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-now').innerText()).toBe('לא ידוע');
    expect(await page.locator('#arduWriteStatus').getAttribute('class')).toContain('fail');
    expect(posts).toBe(0);
  }, 60000);

  it('blocks group apply with no link and keeps the draft', async () => {
    linked = false;
    partial = false;
    posts = 0;
    await openGroup();
    await page.fill('[data-param-key="EK3_ENABLE"] .fc-group-next', '0');
    await page.fill('[data-param-key="EK3_SRC1_POSXY"] .fc-group-next', '1');
    await page.click('#fcGroupApply');
    await confirmWrite();
    await page.waitForFunction(() => (document.getElementById('fcGroupStatus')?.textContent || '').includes('אין חיבור לבקר הטיסה'));
    expect(posts).toBe(0);
    expect(await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-next').inputValue()).toBe('0');
    expect(await page.locator('[data-param-key="EK3_SRC1_POSXY"] .fc-group-next').inputValue()).toBe('1');
    expect(await page.locator('#fcChangeList').innerText()).toContain('ממתין');
    expect(await page.locator('#fcChangeList').innerText()).not.toContain('הבקר אישר');
    expect(await page.locator('#fcGroupStatus').getAttribute('class') || '').not.toContain('success');
  }, 60000);

  it('keeps the unacknowledged group draft after a partial failure', async () => {
    linked = true;
    partial = true;
    posts = 0;
    await openGroup();
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => document.querySelector('[data-param-key="EK3_ENABLE"] .fc-group-now')?.textContent === '1');
    await page.fill('[data-param-key="EK3_ENABLE"] .fc-group-next', '0');
    await page.fill('[data-param-key="EK3_SRC1_POSXY"] .fc-group-next', '1');
    await page.click('#fcGroupApply');
    await confirmWrite();
    await page.waitForFunction(() => (document.getElementById('fcGroupStatus')?.textContent || '').includes('חלקית'));
    expect(posts).toBe(1);
    expect(await page.locator('#fcGroupStatus').innerText()).not.toMatch(/WRITE/);
    const kept = [
      await page.locator('[data-param-key="EK3_ENABLE"] .fc-group-next').inputValue(),
      await page.locator('[data-param-key="EK3_SRC1_POSXY"] .fc-group-next').inputValue(),
    ].filter((value) => value !== '');
    expect(kept).toHaveLength(1);
    expect(await page.locator('#fcChangeList').innerText()).toContain('נכשל');
  }, 60000);

  async function openWizard() {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('vlc.fcWizard.runs.v1'));
    await page.click('[data-tab="control"]');
    await page.click('[data-subtab="autoConfig"]');
    await page.waitForSelector('#acWhatList .ac-choice[data-peripheral-id="gps"]');
    await page.click('#acWhatList .ac-choice[data-peripheral-id="gps"]');
    await page.waitForSelector('#acWhereList .ac-choice[data-where-id="serial3"]');
    await page.click('#acWhereList .ac-choice[data-where-id="serial3"]');
    await page.waitForSelector('#acApplyBtn:not([disabled])');
  }

  it('leaves the wizard run pending when there is no link', async () => {
    linked = false;
    partial = false;
    posts = 0;
    await openWizard();
    await page.click('#acApplyBtn');
    await confirmWrite();
    await page.waitForFunction(() => (document.getElementById('acApplyStatus')?.textContent || '').includes('אין חיבור לבקר הטיסה'));
    expect(posts).toBe(0);
    const runs = await page.evaluate(() => localStorage.getItem('vlc.fcWizard.runs.v1'));
    expect(runs == null || runs === '[]' || !JSON.parse(runs).some((run) => run.ok)).toBe(true);
    expect(await page.locator('#acSavedList').innerText()).not.toContain('נכתב');
  }, 60000);

  it('does not mark the wizard written on a partial failure', async () => {
    linked = true;
    partial = true;
    posts = 0;
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="control"]');
    await page.selectOption('#paramSubtabSelect', 'ardu-ekf');
    await page.click('#arduReadBtn');
    await openWizard();
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => (document.getElementById('arduWriteStatus')?.textContent || '').includes('הושלמה'));
    await page.click('#acApplyBtn');
    await confirmWrite();
    await page.waitForFunction(() => (document.getElementById('acApplyStatus')?.textContent || '').includes('חלקית'));
    expect(posts).toBe(1);
    const runs = await page.evaluate(() => JSON.parse(localStorage.getItem('vlc.fcWizard.runs.v1') || '[]'));
    expect(runs.some((run) => run.ok)).toBe(false);
    expect(await page.locator('#acSavedList').innerText()).not.toContain('נכתב');
  }, 60000);

  it('blocks restore with no link and adds no history entry', async () => {
    linked = false;
    partial = false;
    posts = 0;
    await openGroup();
    await page.waitForSelector('.fc-file-restore');
    await page.click('.fc-file-restore');
    await confirmWrite();
    await page.waitForFunction(() => (document.getElementById('fcFileStatus')?.textContent || '').includes('אין חיבור לבקר הטיסה'));
    expect(posts).toBe(0);
    expect(await page.locator('#fcChangeList').innerText()).not.toContain('הבקר אישר');
    expect(await page.locator('#fcFileLatest').innerText()).not.toContain('כתיבה לבקר');
  }, 60000);

  it('does not report restore success on a partial failure', async () => {
    linked = true;
    partial = true;
    posts = 0;
    await openGroup();
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => document.querySelector('[data-param-key="EK3_ENABLE"] .fc-group-now')?.textContent === '1');
    await page.click('.fc-file-restore');
    await confirmWrite();
    await page.waitForFunction(() => (document.getElementById('fcFileStatus')?.textContent || '').includes('חלקית'));
    expect(posts).toBe(1);
    expect(await page.locator('#fcFileStatus').innerText()).not.toMatch(/WRITE|SUCCESS/);
    expect(await page.locator('#fcChangeList').innerText()).toContain('נכשל');
  }, 60000);

  it('blocks the toolbar write with no link', async () => {
    linked = false;
    partial = false;
    posts = 0;
    await openGroup();
    await page.evaluate(() => { document.getElementById('arduWriteBtn').disabled = false; });
    await page.click('#arduWriteBtn');
    await page.waitForFunction(() => (document.getElementById('paramToolFaultText')?.textContent || '') === 'אין חיבור לבקר הטיסה'
      || (document.getElementById('arduWriteStatus')?.textContent || '').includes('אין חיבור לבקר הטיסה'));
    expect(posts).toBe(0);
    expect(await page.locator('#arduWriteStatus').getAttribute('class')).toContain('fail');
    expect(await page.locator('#arduWriteStatus').getAttribute('class')).not.toContain('success');
  }, 60000);

  it('does not report toolbar success on a partial failure', async () => {
    linked = true;
    partial = true;
    posts = 0;
    await openGroup();
    await page.click('#arduReadBtn');
    await page.waitForFunction(() => (document.getElementById('arduWriteStatus')?.textContent || '').includes('הושלמה'));
    await page.selectOption('#paramSubtabSelect', 'ardu-jetson');
    await page.waitForSelector('#arduParamFormPanels [data-ardu-key="PLND_LAG"]', { state: 'attached' });
    await page.evaluate(() => {
      const keys = ['PLND_LAG', 'PLND_BUS'];
      for (const [index, key] of keys.entries()) {
        const el = document.querySelector(`#arduParamFormPanels [data-ardu-key="${key}"]`);
        const input = el?.matches('input,select') ? el : el?.querySelector('input,select');
        if (!input) throw new Error(key);
        input.value = index === 0 ? '0.4' : '2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.locator('#arduWriteBtn').scrollIntoViewIfNeeded();
    await page.click('#arduWriteBtn');
    await page.waitForFunction(() => {
      const text = document.getElementById('arduWriteStatus')?.textContent || '';
      return text.includes('חלקית') || text.includes('לא אושרו') || text.includes('אין שינוי');
    });
    const text = await page.locator('#arduWriteStatus').innerText();
    const cls = await page.locator('#arduWriteStatus').getAttribute('class');
    expect(text).not.toMatch(/WRITE|SUCCESS/);
    expect(cls).not.toContain('success');
    if (text.includes('חלקית') || text.includes('לא אושרו')) expect(posts).toBe(1);
  }, 60000);
});
