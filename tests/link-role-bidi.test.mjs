import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarizeCommLinks } from '../lib/comm-links.mjs';
import { collectTextFitFailures } from './text-fit-audit.mjs';
import { startTestServer } from './test-server.mjs';

const sizes = [
  { name: '360x740', width: 360, height: 740 },
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

const serialSavedCellular = {
  id: 2,
  type: 'serial',
  serialPort: '/dev/ttyUSB0',
  linkRole: 'cellular',
  connected: true,
  heartbeatCount: 3,
  lastHeartbeatAgeMs: 100,
};

const tcpRelay = {
  id: 9,
  name: 'Jetson MAVLink relay (jetson.example:5770)',
  type: 'tcp',
  host: 'jetson.example',
  port: 5770,
  linkRole: 'radio',
  connected: true,
  heartbeatCount: 4,
  lastHeartbeatAgeMs: 120,
};

function row(summary, id) {
  return summary.rows.find((item) => item.id === id);
}

describe('link role Hebrew order', () => {
  let browser;
  let serverProc;
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
    try { serverProc?.kill('SIGTERM'); } catch { /* already gone */ }
  });

  it('keeps RF inside the Hebrew sentence at five screen sizes, including 360', async () => {
    const summary = summarizeCommLinks({
      radio: 'connected',
      cellular: 'disconnected',
      modemPresent: false,
      radioLive: serialSavedCellular,
    });
    const radio = row(summary, 'radio');
    expect(radio.roleNoticeHe).toContain('<bdi dir="ltr">RF</bdi>');
    expect(radio.roleSaveRadio).not.toBe(false);
    const page = await browser.newPage();
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightLinkRoleRadio', { state: 'attached' });
      for (const vp of sizes) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const seen = await page.evaluate((linkRow) => {
          globalThis.flightLinksSnapshot = { comm: { rows: [linkRow] } };
          openFlightLinkMenu('radio');
          const note = document.getElementById('flightLinkRoleNote');
          const actions = document.getElementById('flightLinkRoleActions');
          const button = document.getElementById('flightLinkRoleRadio');
          const heading = document.querySelector('#flightLinkMenu .conn-link-title');
          function orderOf(host) {
            const mark = host.querySelector('bdi');
            const range = document.createRange();
            range.setStart(host, 0);
            range.setEndBefore(mark);
            const before = range.getBoundingClientRect();
            const rf = mark.getBoundingClientRect();
            return {
              dir: host.getAttribute('dir') || getComputedStyle(host).direction,
              markDir: mark.getAttribute('dir'),
              markText: mark.textContent,
              sameLine: Math.abs(before.top - rf.top) < 6,
              prefixRightOfRf: before.left >= rf.right - 2 && before.right > rf.right,
              rfWidth: rf.width,
              prefixWidth: before.width,
            };
          }
          return {
            heading: heading?.textContent || '',
            noteDir: note.getAttribute('dir'),
            actionsDir: actions.getAttribute('dir'),
            note: orderOf(note),
            button: orderOf(button),
          };
        }, radio);
        const fit = await page.evaluate(collectTextFitFailures, 1);
        const fails = fit.fails.filter((item) => /flightLinkRole|conn-link-title/.test(item.who || ''));
        expect(seen.heading, vp.name).toBe('קישור');
        expect(seen.noteDir, vp.name).toBe('rtl');
        expect(seen.actionsDir, vp.name).toBe('rtl');
        expect(seen.note.markDir, vp.name).toBe('ltr');
        expect(seen.note.markText, vp.name).toBe('RF');
        expect(seen.note.sameLine, vp.name).toBe(true);
        expect(seen.note.prefixRightOfRf, `${vp.name} ${JSON.stringify(seen.note)}`).toBe(true);
        expect(seen.button.markDir, vp.name).toBe('ltr');
        expect(seen.button.markText, vp.name).toBe('RF');
        expect(seen.button.sameLine, vp.name).toBe(true);
        expect(seen.button.prefixRightOfRf, `${vp.name} ${JSON.stringify(seen.button)}`).toBe(true);
        expect(fails, vp.name).toEqual([]);
      }
    } finally {
      await page.close();
    }
  }, 60000);

  it('hides the RF save on a TCP relay row', async () => {
    const summary = summarizeCommLinks({
      radio: 'disconnected',
      cellular: 'connected',
      modemPresent: false,
      cellularLive: tcpRelay,
    });
    const cell = row(summary, 'cellular');
    expect(cell.roleSaveRadio).toBe(false);
    expect(cell.hintHe).toBe('קישור סלולרי דרך מחשב המשימה');
    expect(cell.hintHe).not.toContain(cell.roleNoticeHe);
    const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#flightLinkRoleRadio', { state: 'attached' });
      const seen = await page.evaluate((linkRow) => {
        globalThis.flightLinksSnapshot = { comm: { rows: [linkRow] } };
        openFlightLinkMenu('cellular');
        const radio = document.getElementById('flightLinkRoleRadio');
        const box = radio.getBoundingClientRect();
        return {
          hidden: radio.hidden,
          display: getComputedStyle(radio).display,
          width: box.width,
          height: box.height,
        };
      }, cell);
      expect(seen.hidden).toBe(true);
      expect(seen.display).toBe('none');
      expect(seen.width).toBe(0);
      expect(seen.height).toBe(0);
      expect(await page.locator('#flightLinkRoleRadio').isVisible()).toBe(false);
      expect(await page.locator('#flightLinkRoleCellular').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }, 60000);
});
