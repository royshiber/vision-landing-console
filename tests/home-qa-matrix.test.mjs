import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.VLC_HOME_QA_PORT || '4031';
const BASE = `http://127.0.0.1:${PORT}`;
const shots = '/opt/cursor/artifacts/home-qa';

const viewports = [
  { name: '1024x576', width: 1024, height: 576 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '360x740', width: 360, height: 740 },
];
const swaps = ['map-horizon', 'horizon-map'];
const chips = ['horizon', 'video', 'vision', 'frame'];
const flags = [false, true];

function stateCount() {
  return viewports.length * swaps.length * chips.length * (2 ** 5) + viewports.length * swaps.length;
}

describe('Home screen QA matrix', () => {
  let serverProc = null;
  let browser = null;
  const tested = [];

  async function waitHealth(maxMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('home qa server did not become healthy');
  }

  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, CURSOR_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth();
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    try { await browser?.close(); } catch { /* the matrix can exhaust fds on close */ }
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    fs.writeFileSync(path.join(shots, 'summary.json'), JSON.stringify({
      states: tested.length,
      expected: stateCount(),
    }, null, 2));
  }, 30000);

  async function audit(page) {
    return page.evaluate(() => {
      const visible = (el) => {
        if (!el || el.closest('[hidden]')) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      const violations = [];
      const interactive = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], .leaflet-control a')]
        .filter(visible);
      for (let i = 0; i < interactive.length; i += 1) {
        for (let j = i + 1; j < interactive.length; j += 1) {
          const a = interactive[i];
          const b = interactive[j];
          if (a.contains(b) || b.contains(a)) continue;
          if (hit(box(a), box(b))) {
            violations.push(`overlap ${a.id || a.className} × ${b.id || b.className}`);
          }
        }
      }
      const regions = [...document.querySelectorAll('[data-mission-region]')].filter(visible);
      for (const el of interactive) {
        const r = box(el);
        const cs = getComputedStyle(el);
        if (r.left < -1 || r.right > window.innerWidth + 1) violations.push(`viewport-x ${el.id || el.className}`);
        if (cs.position === 'fixed' && (r.top < -1 || r.bottom > window.innerHeight + 1)) {
          violations.push(`viewport-fixed ${el.id || el.className}`);
        }
        const region = el.closest('[data-mission-region]');
        if (region && visible(region)) {
          const host = box(region);
          if (r.left < host.left - 2 || r.right > host.right + 2 || r.top < host.top - 2 || r.bottom > host.bottom + 2) {
            violations.push(`tile-overflow ${el.id || el.className} in ${region.dataset.missionRegion}`);
          }
        }
      }
      const labels = [...document.querySelectorAll('.mission-data-label, .mission-data-value, .pfd-video-toggle, .terrain-layer-btn, .mission-link-chip, #missionLink')]
        .filter(visible);
      for (const el of labels) {
        if (el.scrollWidth > el.clientWidth + 1) violations.push(`clip ${el.id || el.textContent}`);
      }
      const stage = box(document.getElementById('pfdHorizonStage'));
      const ias = document.querySelector('.pfd-side-tape--left');
      const alt = document.querySelector('.pfd-side-tape--right');
      for (const el of document.querySelectorAll('.pfd-video-toggle')) {
        if (!visible(el)) continue;
        const b = box(el);
        if (hit(b, stage)) violations.push(`chip-on-stage ${el.id}`);
        if (ias && visible(ias) && hit(b, box(ias))) violations.push(`chip-on-ias ${el.id}`);
        if (alt && visible(alt) && hit(b, box(alt))) violations.push(`chip-on-alt ${el.id}`);
      }
      const views = ['annotatedVisionPanel', 'liveCameraPanel', 'instrumentVideoFrame', 'horizonVideoEmpty']
        .map((id) => document.getElementById(id))
        .filter((el) => el && !el.hidden && visible(el));
      const mode = document.getElementById('pfdHorizonShell')?.dataset.instrumentView || 'horizon';
      if (mode === 'horizon' && views.length) violations.push(`stacked ${views.map((el) => el.id).join(',')}`);
      if (mode !== 'horizon' && views.length > 3) violations.push(`stacked-count ${views.length}`);
      const map = box(document.querySelector('[data-mission-region="map"]'));
      const horizon = box(document.querySelector('[data-mission-region="horizon"]'));
      return {
        violations: violations.slice(0, 12),
        map,
        horizon,
        mode,
        dir: document.documentElement.dir,
      };
    });
  }

  async function setSwap(page, swap) {
    await page.evaluate((next) => {
      if (document.querySelector('.mission-workspace')?.dataset.missionSwap !== next) {
        document.getElementById('missionSwapHorizonMapBtn')?.click();
      }
    }, swap);
    await page.waitForFunction((next) => document.querySelector('.mission-workspace')?.dataset.missionSwap === next, swap);
  }

  async function setChip(page, chip) {
    await page.evaluate((next) => {
      const map = { video: 'horizonVideoToggle', vision: 'annotatedVisionToggle', frame: 'liveCameraToggle' };
      const current = document.getElementById('pfdHorizonShell')?.dataset.instrumentView || 'horizon';
      if (current === next) return;
      if (next === 'horizon') {
        const id = map[current];
        if (id) document.getElementById(id)?.click();
        return;
      }
      if (current !== 'horizon') {
        const back = map[current];
        if (back) document.getElementById(back)?.click();
      }
      document.getElementById(map[next])?.click();
    }, chip);
    await page.waitForFunction((next) => (document.getElementById('pfdHorizonShell')?.dataset.instrumentView || 'horizon') === next, chip);
  }

  async function setPressed(page, selector, want) {
    const pressed = await page.getAttribute(selector, 'aria-pressed');
    if ((pressed === 'true') === want) return;
    await page.click(selector);
    await page.waitForFunction(([sel, on]) => {
      const el = document.querySelector(sel);
      return !!el && (el.getAttribute('aria-pressed') === 'true') === on && !el.disabled;
    }, [selector, want], { timeout: 8000 });
  }

  it('covers every home-screen combination without overlap or clipping', async () => {
    expect(stateCount()).toBeGreaterThan(1500);
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('visionLandingMissionSwapV1', 'map-horizon');
      localStorage.setItem('vlc.instrumentView.v1', 'horizon');
      localStorage.removeItem('vlc.horizon.videoOn');
    });
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dir === 'rtl' && document.getElementById('horizonCanvas')?.width > 10);
      const thumbs = [];
      for (const swap of swaps) {
        await setSwap(page, swap);
        let baseline = null;
        for (const chip of chips) {
          await setChip(page, chip);
          for (const voice of flags) {
            await setPressed(page, '#assistVoiceGoToggle', voice);
            for (const record of flags) {
              await setPressed(page, '#missionRecordBtn', record);
              for (const ready of flags) {
                const readyOpen = await page.evaluate(() => !document.getElementById('pfdReadinessPopover')?.classList.contains('hidden'));
                if (readyOpen !== ready) await page.click('#missionReadinessGlance');
                await page.waitForFunction((on) => !document.getElementById('pfdReadinessPopover')?.classList.contains('hidden') === on, ready);
                for (const layer of ['street', 'sat']) {
                  await page.click(layer === 'sat' ? '#terrainLayerSatBtn' : '#terrainLayerStreetBtn');
                  for (const route of flags) {
                    await setPressed(page, '#terrainShowLoadedPathBtn', route);
                    const id = `${viewport.name}-${swap}-${chip}-v${voice ? 1 : 0}-r${record ? 1 : 0}-y${ready ? 1 : 0}-l${layer}-p${route ? 1 : 0}`;
                    const report = await audit(page);
                    expect(report.dir, id).toBe('rtl');
                    expect(report.mode, id).toBe(chip);
                    expect(report.violations, `${id} ${report.violations.join(' | ')}`).toEqual([]);
                    if (!baseline) baseline = { map: report.map, horizon: report.horizon };
                    expect(Math.abs(report.map.width - baseline.map.width), id).toBeLessThan(6);
                    expect(Math.abs(report.map.height - baseline.map.height), id).toBeLessThan(6);
                    expect(Math.abs(report.horizon.width - baseline.horizon.width), id).toBeLessThan(6);
                    expect(Math.abs(report.horizon.height - baseline.horizon.height), id).toBeLessThan(6);
                    const file = path.join(shots, `${id}.jpg`);
                    await page.screenshot({ path: file, type: 'jpeg', quality: 32 });
                    thumbs.push(file);
                    tested.push(id);
                  }
                }
              }
            }
          }
        }
        await page.evaluate(() => {
          const order = [
            'horizonVideoToggle', 'horizonVideoToggle',
            'annotatedVisionToggle', 'annotatedVisionToggle',
            'liveCameraToggle', 'liveCameraToggle',
          ];
          for (const id of order) document.getElementById(id)?.click();
        });
        const afterRapid = await audit(page);
        expect(afterRapid.mode, `${viewport.name}-${swap}-rapid`).toBe('horizon');
        expect(afterRapid.violations, `${viewport.name}-${swap}-rapid`).toEqual([]);
        expect(Math.abs(afterRapid.horizon.width - baseline.horizon.width)).toBeLessThan(6);
        const rapidFile = path.join(shots, `${viewport.name}-${swap}-rapid.jpg`);
        await page.screenshot({ path: rapidFile, type: 'jpeg', quality: 32 });
        thumbs.push(rapidFile);
        tested.push(`${viewport.name}-${swap}-rapid`);
      }
      await makeSheet(thumbs, path.join(shots, `contact-${viewport.name}.jpg`));
    }
    expect(tested.length).toBe(stateCount());
    await page.close();
  }, 1500000);
});

function makeSheet(files, dest) {
  const list = path.join(path.dirname(dest), `.sheet-${path.basename(dest)}.txt`);
  fs.writeFileSync(list, files.join('\n'));
  const py = `
import pathlib
from PIL import Image
files = pathlib.Path(${JSON.stringify(list)}).read_text().splitlines()
files = [f for f in files if f]
cols, tw, th = 16, 80, 45
rows = max(1, (len(files) + cols - 1) // cols)
sheet = Image.new('RGB', (cols * tw, rows * th), (17, 17, 17))
for i, name in enumerate(files):
    im = Image.open(name).convert('RGB')
    im.thumbnail((tw, th))
    x = (i % cols) * tw
    y = (i // cols) * th
    sheet.paste(im, (x + (tw - im.width) // 2, y + (th - im.height) // 2))
sheet.save(${JSON.stringify(dest)}, quality=60)
`;
  execFileSync('python3', ['-c', py], { stdio: 'inherit' });
  fs.unlinkSync(list);
}
