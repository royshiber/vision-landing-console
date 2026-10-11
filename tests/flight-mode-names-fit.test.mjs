import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARDUPILOT_PLANE_MODES } from '../lib/arduplane-flight-modes.mjs';
import { startTestServer } from './test-server.mjs';

const modes = Object.values(ARDUPILOT_PLANE_MODES);
const viewports = [
  { name: '360', width: 360, height: 740 },
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280', width: 1280, height: 720 },
];

describe('ArduPlane mode names fit on one line', () => {
  let server = null;
  let browser = null;
  let page = null;

  beforeAll(async () => {
    server = await startTestServer({ env: () => ({ CURSOR_API_KEY: '' }) });
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#hudFlightMode');
  });

  afterAll(async () => {
    await browser?.close();
    server?.child.kill('SIGTERM');
  });

  it('keeps every ArduPlane mode unbroken at 360, 1024x576, and 1280', async () => {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const name of modes) {
        const fit = await page.evaluate((mode) => {
          const el = document.getElementById('hudFlightMode');
          el.textContent = mode;
          const cs = getComputedStyle(el);
          const line = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize);
          return {
            text: el.textContent,
            white: cs.whiteSpace,
            wrap: cs.overflowWrap,
            font: Number.parseFloat(cs.fontSize),
            sw: el.scrollWidth,
            cw: el.clientWidth,
            sh: el.scrollHeight,
            line,
          };
        }, name);
        expect(fit.text, vp.name).toBe(name);
        expect(fit.white, `${vp.name} ${name}`).toBe('normal');
        expect(fit.wrap, `${vp.name} ${name}`).toBe('normal');
        expect(fit.font, `${vp.name} ${name}`).toBeGreaterThanOrEqual(11);
        expect(fit.sw, `${vp.name} ${name}`).toBeLessThanOrEqual(fit.cw + 1);
        expect(fit.sh, `${vp.name} ${name}`).toBeLessThanOrEqual(fit.line + 1);
      }
    }
  }, 60000);
});
