import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = '/opt/cursor/artifacts/screenshots';
const PORT = '4052';
const BASE = `http://127.0.0.1:${PORT}`;
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

const VIEWPORTS = [
  ['1024x576', 1024, 576],
  ['1280x720', 1280, 720],
  ['1366x768', 1366, 768],
  ['1440x900', 1440, 900],
  ['1920x1080', 1920, 1080],
  ['360x740', 360, 740],
];

const FAKE_EVENTS = [
  'Vision lock acquired',
  'Cross-track correction started',
  'Laser altitude valid',
  'Flare phase entered',
  'Pitch-up command applied',
  'Motor hold window started',
  'Confidence dropped below abort threshold',
  'Runway spool phase started',
];

describe('Optics debrief tab — source', () => {
  it('renames the top tab, hides development, and drops sample events', () => {
    expect(html).toMatch(/data-tab="recordings"[^>]*>אופטיקה ותחקור</);
    expect(html).toMatch(/data-tab="development"[^>]*hidden|hidden[^>]*data-tab="development"/);
    expect(html).not.toMatch(/data-tab="recordings"[^>]*>תחקור</);
    expect(js).not.toContain('eventSamples');
    for (const line of FAKE_EVENTS) expect(js).not.toContain(line);
    expect(js).toContain('אין אירועים');
    expect(html).toContain('dir="rtl"');
  });
});

describe('Optics debrief tab — live layout', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    fs.mkdirSync(shotDir, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-optics-${PORT}.sqlite` },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(up).toBe(true);
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  });

  async function openDebrief(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator('[data-tab="recordings"]').evaluate((el) => el.click());
    await page.waitForSelector('#recordings.panel.visible #debriefFlightbookPanel.visible .fb-empty', { timeout: 8000 });
  }

  async function shellReport(page) {
    return page.evaluate(() => {
      const rec = document.getElementById('recordings');
      const empty = document.querySelector('#debriefFlightbookPanel .fb-empty');
      const visual = (el, token) => {
        if (!el) return '';
        const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes(token));
        if (!node) return '';
        const s = node.textContent;
        const i = s.indexOf(token);
        const range = document.createRange();
        const parts = [];
        for (let k = 0; k < token.length; k += 1) {
          range.setStart(node, i + k);
          range.setEnd(node, i + k + 1);
          const r = range.getBoundingClientRect();
          parts.push({ ch: token[k], x: r.x + r.width / 2 });
        }
        return parts.sort((a, b) => a.x - b.x).map((p) => p.ch).join('');
      };
      const spaced = [];
      for (const el of document.querySelectorAll('#recordings button, #recordings .fb-empty, #recordings .tele-subtab, .app-chrome-brand, #assistToggleBtn')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const ls = cs.letterSpacing;
        if (ls !== 'normal' && parseFloat(ls) > 0.3) {
          spaced.push(`${(el.innerText || el.className || '').trim().slice(0, 24)}:${ls}`);
        }
      }
      const box = empty ? empty.getBoundingClientRect() : { height: 0, top: 0, bottom: 0 };
      return {
        panelH: rec ? rec.clientHeight : 0,
        emptyH: Math.round(box.height),
        emptyOnScreen: box.height > 20 && box.top < window.innerHeight && box.bottom > 0,
        envVisual: visual(empty, '.env'),
        docsVisual: visual(empty, 'docs/FLIGHT_LOGS.md'),
        spaced,
      };
    });
  }

  async function openOptics(page) {
    await openDebrief(page);
    await page.locator('#debriefRecBtn').evaluate((el) => el.click());
    await page.waitForSelector('#eventsList .event-empty', { timeout: 8000 });
  }

  async function audit(page) {
    return page.evaluate((fakes) => {
      const visible = (el) => {
        if (!el || el.closest('[hidden]')) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      const boxOf = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const dev = document.querySelector('[data-tab="development"]');
      const tab = document.querySelector('[data-tab="recordings"]');
      const events = document.getElementById('eventsList');
      const textFit = [];
      const selectors = [
        '.app-chrome .tab',
        '.app-chrome-brand',
        '#versionBtn',
        '#recordings .tele-subtab',
        '#recordings .file-btn',
        '#selectedRecordingLabel',
        '#debriefRecordingsPanel h3',
        '#eventsList .event-empty',
        '.debrief-cam-toggle',
        '.debrief-cam-nosignal',
        '.debrief-cam-label',
        '.debrief-player-kicker',
        '.debrief-player-empty',
        '#cam0StatusText',
        '.cam0-title',
        '#cam0Reason',
        '.cam0-hist-label',
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (!visible(el)) continue;
          const cs = getComputedStyle(el);
          const label = (el.innerText || el.textContent || sel).trim().slice(0, 40);
          if (cs.textOverflow === 'ellipsis') textFit.push(`${label}: ellipsis`);
          if (el.scrollWidth > el.clientWidth + 2) textFit.push(`${label}: overflow-x ${el.scrollWidth}>${el.clientWidth}`);
          if (el.scrollHeight > el.clientHeight + 2 && /(hidden|clip)/.test(`${cs.overflow} ${cs.overflowY}`)) {
            textFit.push(`${label}: overflow-y`);
          }
        }
      }
      const nodes = [];
      for (const sel of ['.app-chrome .tab', '.app-chrome-tools > *', '#recordings .tele-subtab', '#recordings .file-btn', '#selectedRecordingLabel', '#debriefRecordingsPanel h3', '#eventsList .event-empty', '.debrief-cam-toggle']) {
        for (const el of document.querySelectorAll(sel)) {
          if (!visible(el)) continue;
          nodes.push({ name: (el.innerText || el.id || sel).trim().slice(0, 32), box: boxOf(el) });
        }
      }
      const overlaps = [];
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          if (!interiors(a.box, b.box)) continue;
          overlaps.push(`${a.name} ∩ ${b.name}`);
        }
      }
      function interiors(a, b) {
        return a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top - 2;
      }
      const hit = (a, b) => a && b && a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top - 2;
      const pill = document.getElementById('connectToggleBtn')?.getBoundingClientRect();
      const badge = document.getElementById('versionBtn')?.getBoundingClientRect();
      const gear = document.getElementById('globalSettingsBtn')?.getBoundingClientRect();
      const tabBox = tab?.getBoundingClientRect();
      const video = document.getElementById('flightVideo');
      const panel = document.getElementById('cam0Panel');
      const notes = [...document.querySelectorAll('.debrief-cam-tile:not([hidden]) .debrief-cam-nosignal')].map((el) => el.textContent.trim());
      return {
        dir: document.documentElement.getAttribute('dir'),
        tab: tab ? tab.textContent.trim() : '',
        devHidden: !dev || dev.hidden || getComputedStyle(dev).display === 'none',
        eventsText: events ? events.innerText : '',
        fakes: fakes.filter((line) => (events?.innerText || '').includes(line)),
        textFit,
        overlaps,
        pillOnBadge: hit(pill, badge),
        pillOnGear: hit(pill, gear),
        pillOnTab: hit(pill, tabBox),
        videoInPlayer: video?.closest('#debriefPlayer') != null,
        videoInTile: video?.closest('.debrief-cam-tile') != null,
        clones: document.querySelectorAll('.debrief-cam-clone').length,
        notes,
        lockHidden: document.getElementById('lockIndicator')?.hidden === true,
        cam0InOptics: panel?.closest('#recordings') != null,
        cam0InPulse: panel?.closest('#pulse') != null,
        statusInPulse: document.getElementById('cam0StatusLine')?.closest('#pulse') != null,
      };
    }, FAKE_EVENTS);
  }

  for (const [name, width, height] of VIEWPORTS) {
    it(`fits the optics tab at ${name}`, async () => {
      const page = await browser.newPage({
        viewport: { width, height },
        isMobile: width <= 360,
        hasTouch: width <= 360,
      });
      try {
        await openDebrief(page);
        const shell = await shellReport(page);
        expect(shell.panelH, `panel ${shell.panelH}px`).toBeGreaterThan(200);
        expect(shell.emptyOnScreen, `empty ${shell.emptyH}px`).toBe(true);
        expect(shell.envVisual).toBe('.env');
        expect(shell.docsVisual.startsWith('docs/')).toBe(true);
        expect(shell.spaced, shell.spaced.join('\n')).toEqual([]);
        await openOptics(page);
        const report = await audit(page);
        await page.screenshot({ path: path.join(shotDir, `optics-debrief-${name}.png`), fullPage: false });
        expect(report.dir).toBe('rtl');
        expect(report.tab).toBe('אופטיקה ותחקור');
        expect(report.devHidden).toBe(true);
        expect(report.eventsText).toContain('אין אירועים');
        expect(report.fakes).toEqual([]);
        expect(report.textFit, report.textFit.join('\n')).toEqual([]);
        expect(report.overlaps, report.overlaps.join('\n')).toEqual([]);
        expect(report.pillOnBadge).toBe(false);
        expect(report.pillOnGear).toBe(false);
        expect(report.pillOnTab).toBe(false);
        expect(report.videoInPlayer).toBe(true);
        expect(report.videoInTile).toBe(false);
        expect(report.clones).toBe(0);
        expect(report.notes).toEqual(['אין אות']);
        expect(report.lockHidden).toBe(true);
        expect(report.cam0InOptics).toBe(true);
        expect(report.cam0InPulse).toBe(false);
        expect(report.statusInPulse).toBe(true);
      } finally {
        await page.close();
      }
    }, 30000);
  }

  it('keeps the logs archive clickable at 1024 and explains a dead camera', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
    try {
      await openOptics(page);
      const offline = await page.evaluate(() => ({
        disabled: ['cam0Ae', 'cam0Exposure', 'cam0Gain', 'cam0Res', 'cam0FpsSet', 'cam0Record', 'cam0Snap'].every((id) => document.getElementById(id)?.disabled),
        reason: document.getElementById('cam0Reason')?.textContent || '',
        status: document.getElementById('cam0StatusText')?.textContent || '',
      }));
      expect(offline.disabled).toBe(true);
      expect(offline.reason).toContain('אין קישור');
      expect(offline.status).toContain('לא מחובר');
      await page.locator('#cam0Exposure').evaluate((el) => { el.disabled = false; el.value = '5000'; });
      await page.locator('#cam0Exposure').evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForFunction(() => (document.getElementById('cam0Error')?.textContent || '').includes('לא נשמרה'));
      const reverted = await page.locator('#cam0Exposure').inputValue();
      expect(reverted).not.toBe('5000');

      await page.locator('#debriefLogsBtn').evaluate((el) => el.click());
      await page.waitForSelector('#debriefLogsPanel.visible #refreshArchiveSessionsBtn');
      await page.locator('#refreshArchiveSessionsBtn').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const logs = await page.evaluate(() => {
        const btn = document.getElementById('refreshArchiveSessionsBtn');
        const card = document.querySelector('.log-upload-card');
        const arch = document.getElementById('archiveSessionsCard');
        const title = document.querySelector('.log-upload-title');
        const r = btn.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const cr = card.getBoundingClientRect();
        const ar = arch.getBoundingClientRect();
        const overlap = cr.left < ar.right - 2 && cr.right > ar.left + 2 && cr.top < ar.bottom - 2 && cr.bottom > ar.top - 2;
        const cs = getComputedStyle(title);
        return {
          hit: top?.id || '',
          overlap,
          titleColor: cs.color,
          titleBg: getComputedStyle(card).backgroundColor,
        };
      });
      expect(logs.hit).toBe('refreshArchiveSessionsBtn');
      expect(logs.overlap).toBe(false);
      const contrast = await page.evaluate(() => {
        const parse = (c) => c.match(/\d+/g).map(Number);
        const title = document.querySelector('.log-upload-title');
        const card = document.querySelector('.log-upload-card');
        const [tr, tg, tb] = parse(getComputedStyle(title).color);
        const [br, bg, bb] = parse(getComputedStyle(card).backgroundColor);
        const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const a = L(tr, tg, tb);
        const b = L(br, bg, bb);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        return ratio;
      });
      expect(contrast).toBeGreaterThan(4);
      await page.screenshot({ path: path.join(shotDir, 'optics-logs-1024.png'), fullPage: false });
    } finally {
      await page.close();
    }
  }, 30000);
});
