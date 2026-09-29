/**
 * Every completed cloud log gets its own download link.
 * The closed list stays one row so the debrief panel does not grow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4197';
const BASE = `http://127.0.0.1:${PORT}`;

const NAMES = ['qa_a.tlog', 'qa_b.tlog', 'qa_c.tlog', 'qa_d.tlog'];

function items() {
  return [
    ...NAMES.map((name, i) => ({
      key: `v1/gcs/lab/${name}`,
      name,
      size: (i + 1) * 2048,
      bytesTotal: (i + 1) * 2048,
      state: 'complete',
      messageHe: 'הלוג עלה.',
      updatedAt: `2026-09-29T07:0${i}:00.000Z`,
    })),
    {
      key: 'v1/gcs/lab/qa_open.tlog',
      name: 'qa_open.tlog',
      size: 100,
      state: 'uploading',
      messageHe: 'מעלים לוג.',
      updatedAt: '2026-09-29T07:09:00.000Z',
    },
  ];
}

describe('GCS completed logs each have a download', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT,
        SQLITE_PATH: `/tmp/airvix-gcs-list-${PORT}.sqlite`,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        FOLLOW_TARGET_SITL: '',
        AIRVIX_GCS_LOG_UPLOAD: '',
      },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function openLogs(page) {
    await page.route('**/api/gcs-logs', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          enabled: true,
          configured: true,
          state: 'ready',
          messageHe: 'יש לוגים מוכנים להעלאה לענן.',
          pendingCount: 0,
          pendingSessionIds: [],
          items: items(),
        }),
      });
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => document.querySelectorAll('#gcsLogList a[href*="/api/gcs-logs/download"]').length === n, NAMES.length);
    await page.click('[data-tab="recordings"]');
    await page.click('#debriefLogsBtn');
    await page.waitForSelector('#debriefLogsPanel.debrief-logs-panel.visible');
  }

  it('renders one download link for each completed object', async () => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await openLogs(page);
    const links = await page.locator('#gcsLogList a[href*="/api/gcs-logs/download"]').evaluateAll((nodes) => nodes.map((a) => ({
      href: a.getAttribute('href'),
      label: a.getAttribute('aria-label'),
      text: a.textContent,
    })));
    expect(links).toHaveLength(NAMES.length);
    for (const name of NAMES) {
      expect(links.some((link) => link.href.includes(encodeURIComponent(`v1/gcs/lab/${name}`)))).toBe(true);
      expect(links.some((link) => link.label === `הורידו ${name}`)).toBe(true);
    }
    expect(links.every((link) => link.text === 'הורידו')).toBe(true);
    expect(await page.locator('#gcsLogList a[href*="qa_open"]').count()).toBe(0);
    const rowText = await page.locator('#gcsLogList .gcs-log-row').evaluateAll((nodes) => nodes.map((n) => n.textContent));
    expect(rowText.some((text) => text.includes('qa_d.tlog') && text.includes('הלוג עלה.') && text.includes('KB'))).toBe(true);
    const moreText = await page.locator('#gcsLogList .gcs-log-more').innerText();
    expect(moreText).toContain('עוד');
    expect(moreText).toContain('3');

    const fit = await page.evaluate(() => {
      const panel = document.getElementById('debriefLogsPanel');
      const btn = document.getElementById('uploadLogBtn').getBoundingClientRect();
      return {
        scrolls: panel.scrollHeight > panel.clientHeight + 1,
        scroll: panel.scrollHeight,
        client: panel.clientHeight,
        btnBottom: btn.bottom,
        viewH: window.innerHeight,
      };
    });
    expect(fit.scrolls, `${fit.scroll}/${fit.client}`).toBe(false);

    await page.setViewportSize({ width: 1024, height: 600 });
    await page.waitForTimeout(200);
    const narrow = await page.evaluate(() => {
      const panel = document.getElementById('debriefLogsPanel');
      const btn = document.getElementById('uploadLogBtn').getBoundingClientRect();
      return {
        scrolls: panel.scrollHeight > panel.clientHeight + 1,
        btnBottom: btn.bottom,
        btnTop: btn.top,
        viewH: window.innerHeight,
      };
    });
    expect(narrow.scrolls).toBe(false);
    expect(narrow.btnBottom).toBeLessThanOrEqual(600);
    expect(narrow.btnTop).toBeGreaterThanOrEqual(0);
    await page.close();
  }, 30000);
});
