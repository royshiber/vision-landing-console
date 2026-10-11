import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { qaShotDir } from './shot-dir.mjs';
import { startTestServer } from './test-server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/tmp/flightbook-shots';
const artifactDir = qaShotDir('flightbook-shots');
const UID_B = '20260921T080000Z-airvix01-c3d4';
const NO_KEY = 'אין מפתח Gemini. מוצגות תובנות אוטומטיות בלבד.';

async function saveShot(page, name) {
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(shotDir, name);
  await page.locator('[data-fb="debrief"]').screenshot({ path: file, type: 'png' });
  fs.copyFileSync(file, path.join(artifactDir, name));
  return file;
}

describe('Flight book debrief panel', () => {
  let browser = null;
  const procs = [];

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    for (const proc of procs) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  });

  async function openFlight(mock) {
    const started = await startTestServer({
      env: (port) => {
        const sqlite = path.join(os.tmpdir(), `airvix-fb-debrief-${port}.sqlite`);
        fs.rmSync(sqlite, { force: true });
        return {
          SQLITE_PATH: sqlite,
          FLIGHT_LOGS_MODE: 'mock',
          FLIGHT_DEBRIEF_MOCK: mock,
          GEMINI_API_KEY: '',
          GEMINI_MIN_INTERVAL_MS: '0',
        };
      },
    });
    procs.push(started.child);
    const base = started.base;
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => sessionStorage.clear());
    await page.click('[data-tab="recordings"]');
    await page.waitForSelector(`#fbListScroll .fb-card[data-uid="${UID_B}"]`, { timeout: 20000 });
    await page.click(`#fbListScroll .fb-card[data-uid="${UID_B}"]`);
    await page.waitForSelector('#fbTimeline .fb-event', { timeout: 20000 });
    return page;
  }

  it('shows a verified verdict and a citation that moves the cursor', async () => {
    const page = await openFlight('ok');
    await page.waitForSelector('[data-fb="debrief"][data-state="ready"]', { timeout: 20000 });
    const text = await page.locator('[data-fb="debrief"]').innerText();
    expect(text).toContain('בעיה');
    expect(text).toContain('מה קרה');
    expect(text).toContain('למה');
    expect(text).toContain('מה לעשות');
    expect(text).toContain('לא ידוע');
    expect(text).not.toContain('לא אומת');
    expect(await page.locator('.fb-verdict').count()).toBe(1);
    await page.locator('[data-fb="debrief"] .fb-cite').first().click();
    await page.waitForFunction(() => (document.querySelector('#fbPlotStack')?.dataset.fbCursor || '') !== '');
    const cursor = await page.locator('#fbPlotStack').getAttribute('data-fb-cursor');
    const mapSel = await page.locator('#fbMap').getAttribute('data-fb-map-sel');
    expect(mapSel).toBe(cursor);
    expect(await page.locator('#fbListScroll .fb-card.is-on').innerText()).toContain('יש תחקיר');
    const file = await saveShot(page, 'debrief-ok.png');
    expect(fs.existsSync(file)).toBe(true);
    await page.close();
  }, 60000);

  it('marks unverifiable sentences לא אומת', async () => {
    const page = await openFlight('partial');
    await page.waitForSelector('[data-fb="debrief"][data-status="partial"]', { timeout: 20000 });
    const text = await page.locator('[data-fb="debrief"]').innerText();
    expect(text).toContain('לא אומת');
    expect(text).toContain('חלק מהמשפטים לא אומתו');
    expect(await page.locator('.fb-sentence.is-unverified').count()).toBeGreaterThan(0);
    const file = await saveShot(page, 'debrief-partial.png');
    expect(fs.existsSync(file)).toBe(true);
    await page.close();
  }, 60000);

  it('shows the Hebrew not-configured line when Gemini is off', async () => {
    const page = await openFlight('nokey');
    await page.waitForSelector('[data-fb="debrief"][data-state="nokey"]', { timeout: 20000 });
    const text = await page.locator('[data-fb="debrief"]').innerText();
    expect(text).toContain(NO_KEY);
    expect(await page.locator('.fb-verdict').count()).toBe(0);
    expect(text).toContain('תובנות אוטומטיות');
    const file = await saveShot(page, 'debrief-nokey.png');
    expect(fs.existsSync(file)).toBe(true);
    await page.close();
  }, 60000);
});
