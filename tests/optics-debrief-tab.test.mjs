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

  async function openOptics(page) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.click('[data-tab="recordings"]', { timeout: 8000 });
    await page.click('#debriefRecBtn', { timeout: 8000 });
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
      return {
        dir: document.documentElement.getAttribute('dir'),
        tab: tab ? tab.textContent.trim() : '',
        devHidden: !dev || dev.hidden || getComputedStyle(dev).display === 'none',
        eventsText: events ? events.innerText : '',
        fakes: fakes.filter((line) => (events?.innerText || '').includes(line)),
        textFit,
        overlaps,
      };
    }, FAKE_EVENTS);
  }

  for (const [name, width, height] of VIEWPORTS) {
    it(`fits the optics tab at ${name}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
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
      } finally {
        await page.close();
      }
    }, 30000);
  }
});
