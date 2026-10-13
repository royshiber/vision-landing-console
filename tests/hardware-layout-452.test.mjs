import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectTextFitFailures } from './text-fit-audit.mjs';
import { startTestServer } from './test-server.mjs';

const viewports = [
  { name: '360x640', width: 360, height: 640 },
  { name: '360x800', width: 360, height: 800 },
  { name: '1024x470', width: 1024, height: 470 },
  { name: '1366x630', width: 1366, height: 630 },
  { name: '1536x730', width: 1536, height: 730 },
];

const watched = /flightArm|flight-arm|missionDataPicker|mission-data-picker/;

describe('hardware bug layout', () => {
  let serverProc = null;
  let browser = null;
  let base = '';

  beforeAll(async () => {
    const started = await startTestServer({ env: { CURSOR_API_KEY: '' } });
    serverProc = started.child;
    base = started.base;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    try { serverProc?.kill('SIGTERM'); } catch { /* ignore */ }
  });

  it('fits the arm hold, confirm facts, and data picker at the required viewports', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightArmBtn');
      await page.evaluate(() => document.fonts?.ready);
      await page.evaluate(() => {
        const arm = document.getElementById('flightArmBtn');
        if (arm) arm.disabled = false;
      });
      await page.focus('#flightArmBtn');
      await page.keyboard.down(' ');
      await page.waitForTimeout(120);
      await page.keyboard.up(' ');
      const afterHold = await page.evaluate(() => ({
        dialogHidden: document.getElementById('flightArmDialog')?.hidden !== false,
        text: document.getElementById('flightArmRefusal')?.textContent || '',
        inQuick: !!document.getElementById('flightArmRefusal')?.closest('#horizonQuick'),
        box: document.getElementById('flightArmRefusal')?.getBoundingClientRect(),
      }));
      expect(afterHold.dialogHidden).toBe(true);
      expect(afterHold.inQuick).toBe(true);
      expect(afterHold.text).toContain('החזיקו 1.5 שניות לחימוש');
      expect(afterHold.box?.width || 0).toBeGreaterThan(8);
      expect(afterHold.box?.height || 0).toBeGreaterThan(8);
      await page.evaluate(() => {
        const dialog = document.getElementById('flightArmDialog');
        if (dialog) dialog.hidden = false;
      });
      await page.keyboard.press('Escape');
      const afterEsc = await page.evaluate(() => document.getElementById('flightArmDialog')?.hidden !== false);
      expect(afterEsc).toBe(true);
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.evaluate(() => {
          if (typeof applyMainTab === 'function') applyMainTab('terrain');
          const arm = document.getElementById('flightArmBtn');
          arm?.classList.add('is-holding');
          const refusal = document.getElementById('flightArmRefusal');
          if (refusal) {
            refusal.hidden = false;
            refusal.classList.add('is-open');
            refusal.textContent = 'החזיקו 1.5 שניות לחימוש';
          }
          const dialog = document.getElementById('flightArmDialog');
          const facts = document.getElementById('flightArmDialogFacts');
          if (facts) {
            facts.replaceChildren();
            const mode = document.createElement('p');
            mode.className = 'flight-arm-fact';
            mode.append('מצב ');
            const rawMode = document.createElement('span');
            rawMode.className = 'flight-arm-warn-raw';
            rawMode.dir = 'ltr';
            rawMode.textContent = 'RTL';
            mode.appendChild(rawMode);
            const block = document.createElement('p');
            block.className = 'flight-arm-fact';
            block.textContent = 'מצב RTL לא מאפשר חימוש';
            const pre = document.createElement('p');
            pre.className = 'flight-arm-fact';
            pre.append('לא ניתן לחמש: נדרש מיקום GPS');
            const raw = document.createElement('span');
            raw.className = 'flight-arm-warn-raw';
            raw.dir = 'ltr';
            raw.textContent = 'PreArm: Need GPS 3D Fix before arming this vehicle in RTL mode not armable';
            pre.appendChild(raw);
            const ack = document.createElement('p');
            ack.className = 'flight-arm-fact flight-arm-ack';
            ack.textContent = 'הבקר דחה את החימוש (DENIED)';
            facts.append(mode, block, pre, ack);
          }
          if (dialog) dialog.hidden = false;
          if (typeof openMissionDataPicker === 'function') openMissionDataPicker(0, 24, 80);
          const input = document.getElementById('missionDataPickerInput');
          if (input) input.value = 'כמות לוויינים';
          if (typeof renderMissionDataPickerChips === 'function' && typeof suggestMissionDataFields === 'function') {
            renderMissionDataPickerChips(suggestMissionDataFields('כמות לוויינים'));
          }
          const hint = document.getElementById('missionDataPickerHint');
          if (hint) hint.textContent = 'מחפש…';
          const suggest = document.getElementById('missionDataPickerSuggest');
          if (suggest) {
            suggest.classList.add('is-busy');
            suggest.setAttribute('aria-busy', 'true');
          }
        });
        await page.waitForTimeout(80);
        const report = await page.evaluate(collectTextFitFailures, 1);
        const fails = report.fails.filter((row) => watched.test(`${row.who || ''} ${row.text || ''}`));
        const fonts = await page.evaluate(() => {
          const nodes = [
            document.getElementById('flightArmRefusal'),
            document.querySelector('.flight-arm-fact'),
            document.querySelector('.flight-arm-warn-raw'),
            document.getElementById('missionDataPickerHint'),
            document.querySelector('.mission-data-picker-chip'),
            document.getElementById('missionDataPickerSuggest'),
          ].filter(Boolean);
          return nodes.map((el) => ({
            id: el.id || el.className,
            px: parseFloat(getComputedStyle(el).fontSize),
          }));
        });
        expect(fonts.every((row) => row.px >= 11), JSON.stringify(fonts)).toBe(true);
        expect(fails, `${vp.name}\n${JSON.stringify(fails.slice(0, 8), null, 2)}`).toEqual([]);
        const ring = await page.locator('#flightArmBtn .flight-arm-hold-ring').count();
        expect(ring).toBeGreaterThan(0);
        expect(await page.locator('#flightArmRefusal').innerText()).toContain('החזיקו 1.5 שניות לחימוש');
        const facts = await page.locator('#flightArmDialogFacts').innerText();
        expect(facts).toContain('מצב RTL לא מאפשר חימוש');
        expect(facts).toContain('הבקר דחה את החימוש (DENIED)');
        const noteBox = await page.locator('#horizonQuick #flightArmRefusal').boundingBox();
        expect(noteBox?.width || 0).toBeGreaterThan(8);
        expect(noteBox?.height || 0).toBeGreaterThan(8);
        expect(await page.locator('#flightArmRow #flightArmRefusal').count()).toBe(0);
        expect(await page.locator('#missionDataPickerChips').innerText()).toContain('לוויינים');
      }
    } finally {
      await page.close();
    }
  }, 120000);
});
