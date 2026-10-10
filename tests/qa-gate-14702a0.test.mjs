/**
 * QA gate for 14702a0 majors and the listed minors.
 * The four repros from pr199_repros are ported here. Loopback only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpsFixLabel } from '../public/modules/gps-quality.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const askTest = fs.readFileSync(path.join(repoRoot, 'tests/ask-latest-exchange.test.mjs'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function channel(color) {
  const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  const rgb = [1, 2, 3].map((i) => Number(m[i]));
  const alpha = m[4] == null ? 1 : Number(m[4]);
  return { rgb, alpha };
}

function lum(rgb) {
  const lin = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  const A = channel(a);
  const B = channel(b);
  if (!A || !B) return 0;
  const hi = Math.max(lum(A.rgb), lum(B.rgb));
  const lo = Math.min(lum(A.rgb), lum(B.rgb));
  return (hi + 0.05) / (lo + 0.05);
}

describe('QA gate 14702a0', () => {
  it('keeps the Ask screenshot dir off the VM-only path', () => {
    expect(askTest).not.toMatch(/['"]\/opt\/cursor\/artifacts/);
    expect(askTest).toMatch(/tmpdir|VLC_ASK_SHOTS/);
  });

  it('names a fixed RTK solution in Hebrew', () => {
    expect(gpsFixLabel(6)).toBe('RTK קבוע');
    expect(appJs).not.toContain('RTK Fixed');
    expect(indexHtml).toContain('טוסו לכאן');
    expect(appJs).toContain('התחילו הקלטה');
    expect(appJs).not.toContain("'התחל הקלטה'");
    expect(indexHtml).not.toContain('>טוס לכאן');
  });

  describe('console', () => {
    let proc = null;
    let browser = null;
    let page = null;
    let base = '';

    afterAll(async () => {
      try { await browser?.close(); } catch { /* ignore */ }
      if (proc && !proc.killed) proc.kill('SIGTERM');
    });

    it('starts', async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      proc = spawn(process.execPath, ['server.js'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          SQLITE_PATH: path.join(os.tmpdir(), `airvix-qa-14702-${port}.sqlite`),
          COMPANION_MODE: 'mock',
          JETSON_COMPANION_BASE_URL: '',
        },
        stdio: 'ignore',
      });
      const t0 = Date.now();
      let up = false;
      while (Date.now() - t0 < 20000) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) { up = true; break; }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: 'he-IL' });
      await page.route('**/api/ardu/params**', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          connected: true,
          mavlinkConnected: true,
          armed: false,
          paramCount: 2,
          current: { RLL2SRV_P: 1.2, ARSPD_FBW_MIN: 9 },
          target: {},
        }),
      }));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByText('אחר כך', { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
      await page.waitForSelector('#terrainMap');
    }, 30000);

    it('finds FC keys from the default group and says where', async () => {
      await page.locator('.tab[data-tab="control"]').click();
      await page.click('#arduReadBtn');
      await page.waitForFunction(() => {
        const line = document.getElementById('arduWriteStatus')?.textContent || '';
        return line.includes('נקראו') || line.includes('הקריאה הושלמה');
      });
      for (const key of ['RLL2SRV_P', 'ARSPD_FBW_MIN']) {
        await page.fill('#arduParamSearchInput', key);
        await page.waitForTimeout(200);
        const found = await page.evaluate((k) => {
          const cards = [...document.querySelectorAll('[data-key],[data-param],.param-card,.ardu-param-card')];
          return cards.some((el) => {
            const box = el.getBoundingClientRect();
            const marked = el.dataset.key === k || el.dataset.param === k;
            const text = (el.classList.contains('param-card') || el.classList.contains('ardu-param-card'))
              && el.offsetParent && el.textContent.includes(k);
            return box.height > 0 && (marked || text);
          });
        }, key);
        expect(found).toBe(true);
      }
      const status = await page.locator('#arduSearchStatus').textContent();
      expect(status).toContain('נמצא ב: כל הפרמטרים');
      await page.click('#arduParamSearchClearBtn');
    }, 20000);

    it('keeps one visible read/write pair and enough contrast', async () => {
      const counts = await page.evaluate(() => {
        const shown = (text) => [...document.querySelectorAll('button')].filter((el) => {
          if (el.offsetParent == null) return false;
          return el.textContent.replace(/\s+/g, ' ').trim() === text;
        }).length;
        const write = getComputedStyle(document.getElementById('arduWriteBtn'));
        const gear = getComputedStyle(document.getElementById('globalSettingsBtn'));
        return {
          read: shown('קריאה'),
          writeFc: shown('כתיבה לבקר'),
          backupWrite: shown('כתיבה'),
          writeColor: write.color,
          writeBg: write.backgroundColor,
          writeOpacity: write.opacity,
          gearColor: gear.color,
          gearBg: gear.backgroundColor,
        };
      });
      expect(counts.read).toBe(1);
      expect(counts.writeFc).toBe(1);
      expect(counts.backupWrite).toBe(0);
      expect(Number(counts.writeOpacity)).toBe(1);
      expect(contrast(counts.writeColor, counts.writeBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(counts.gearColor, counts.gearBg)).toBeGreaterThanOrEqual(4.5);
    });

    it('hides the floating Ask button on status and params', async () => {
      await page.locator('.tab[data-tab="pulse"]').click();
      const onStatus = await page.locator('#assistToggleBtn').evaluate((el) => getComputedStyle(el).display);
      expect(onStatus).toBe('none');
      await page.locator('.tab[data-tab="control"]').click();
      const onParams = await page.locator('#assistToggleBtn').evaluate((el) => getComputedStyle(el).display);
      expect(onParams).toBe('none');
    });

    it('shows a missing battery instead of a zero reading', async () => {
      await page.locator('.tab[data-tab="pulse"]').click();
      const text = await page.evaluate(() => {
        pulsePaintFcFacts(null, {
          connected: true,
          heartbeatCount: 3,
          lastHeartbeatAgeMs: 100,
          batteryV: 0,
          batteryPct: 0,
          batteryCurrentA: 0,
        });
        return document.querySelector('[data-metric="fc-battery"] [data-metric-pill]')?.textContent || '';
      });
      expect(text).not.toMatch(/0\.0/);
      expect(text).not.toMatch(/V/);
      expect(text).toMatch(/לא ידוע|—/);
    });

    it('centres once when follow is off, and a pan pauses follow', async () => {
      await page.evaluate(() => localStorage.setItem('visionLandingFlightFollowV2', '0'));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.getByText('אחר כך', { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
      await page.locator('.tab[data-tab="terrain"]').click({ timeout: 4000 });
      const mapReady = await page.waitForFunction(() => {
        const map = window.__airvixTerrainMap;
        const box = document.querySelector('#terrainMap')?.getBoundingClientRect();
        return !!(map && box && box.width > 20 && box.height > 20);
      }, { timeout: 8000 }).then(() => true).catch(() => false);
      if (!mapReady) {
        const info = await page.evaluate(() => ({
          tab: document.querySelector('.tab.active')?.dataset.tab,
          panel: document.querySelector('.panel.visible')?.id,
          map: !!window.__airvixTerrainMap,
          box: document.querySelector('#terrainMap')?.getBoundingClientRect(),
          follow: localStorage.getItem('visionLandingFlightFollowV2'),
        }));
        throw new Error(`map not ready ${JSON.stringify(info)}`);
      }
      const placed = await page.evaluate(() => {
        updateFlightOverlaysOnAllMaps({
          mavlink: {
            connected: true,
            gpsFixType: 6,
            gpsSats: 14,
            gpsHdop: 0.7,
            map: { gpsLat: 32.08, gpsLon: 34.78, globalHdgDeg: 90, gpsSource: 'GLOBAL_POS' },
          },
        });
        const map = window.__airvixTerrainMap;
        const c = map.getContainer().getBoundingClientRect();
        const pl = document.querySelector('.leaflet-marker-pane [class*=plane]')?.getBoundingClientRect();
        return {
          inside: !!pl && pl.left >= c.left - 4 && pl.right <= c.right + 4 && pl.top >= c.top - 4 && pl.bottom <= c.bottom + 4,
          follow: document.getElementById('terrainFollowBtn')?.textContent || '',
          chip: document.querySelector('.terrain-plane-fix')?.textContent || '',
        };
      });
      expect(placed.inside).toBe(true);
      expect(placed.follow).toContain('כבוי');
      expect(placed.chip).toBe('RTK');
      await page.setViewportSize({ width: 1280, height: 720 });
      const paused = await page.evaluate(() => {
        paintFlightFollow(true);
        const map = window.__airvixTerrainMap;
        const start = map.getCenter();
        map.fire('movestart', { originalEvent: new MouseEvent('mousedown') });
        map.panBy([120, 40], { animate: false });
        const moved = Math.abs(map.getCenter().lat - start.lat) + Math.abs(map.getCenter().lng - start.lng);
        return { label: document.getElementById('terrainFollowBtn').textContent, moved };
      });
      expect(paused.label).toContain('כבוי');
      expect(paused.moved).toBeGreaterThan(0);
    }, 30000);

    it('keeps the map menu and the horizon GPS detail on screen', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.locator('.tab[data-tab="terrain"]').click();
      const menu = await page.evaluate(() => {
        const map = window.__airvixTerrainMap;
        const origin = map.getContainer().getBoundingClientRect();
        showMapFlyToMenu(31.5, 34.8, origin.right - 20, origin.bottom - 8);
        const box = document.getElementById('mapFlyToMenu').getBoundingClientRect();
        const label = document.getElementById('mapFlyToBtn').textContent;
        const record = document.getElementById('terrainFlightRecordBtn').textContent;
        return { bottom: box.bottom, vh: window.innerHeight, label, record };
      });
      expect(menu.bottom).toBeLessThanOrEqual(menu.vh + 1);
      expect(menu.label).toContain('טוסו לכאן');
      expect(menu.record).toContain('התחילו הקלטה');
      await page.evaluate(() => {
        const fly = document.getElementById('mapFlyToMenu');
        if (fly) fly.hidden = true;
      });

      await page.evaluate(() => {
        applyFlightHud({
          connected: true,
          armedKnown: true,
          armed: false,
          gpsFixType: 6,
          gpsSats: 12,
          gpsHdop: 0.81,
          gpsAgeMs: 400,
        });
      });
      const stage = await page.locator('#pfdHorizonStage').boundingBox();
      await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2, { button: 'right' });
      const gps = await page.evaluate(() => {
        const root = document.getElementById('horizonCameraMenu');
        const m = root.getBoundingClientRect();
        const rows = [...root.querySelectorAll('*')].filter((el) => /HDOP/.test(el.textContent) && el.children.length < 4 && el.getBoundingClientRect().height > 0);
        return rows.map((el) => {
          const r = el.getBoundingClientRect();
          return { bottom: r.bottom, menuBottom: m.bottom, vh: window.innerHeight, text: el.textContent };
        });
      });
      expect(gps.length).toBeGreaterThan(0);
      expect(gps.every((row) => row.bottom <= row.menuBottom + 1 && row.bottom <= row.vh + 1)).toBe(true);
      expect(gps.some((row) => row.text.includes('RTK קבוע'))).toBe(true);
    });

    it('fits the data title and the speed label, and the comms menu does not scroll', async () => {
      await page.evaluate(() => {
        const menu = document.getElementById('horizonCameraMenu');
        if (menu) menu.hidden = true;
      });
      for (const [width, height] of [[1280, 720], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        await page.locator('.tab[data-tab="terrain"]').click();
        const fit = await page.evaluate(() => {
          const title = document.querySelector('.mission-region-data > .mission-region-title');
          const label = [...document.querySelectorAll('.mission-data-label')].find((el) => el.textContent.trim() === 'מהירות');
          const tile = label?.closest('.mission-data-tile');
          const tr = title.getBoundingClientRect();
          const parent = title.parentElement.getBoundingClientRect();
          const tiles = [...document.querySelectorAll('.mission-region-data .mission-data-tile')];
          const value = document.getElementById('hudFlightMode');
          const overlaps = tiles.some((node) => {
            const b = node.getBoundingClientRect();
            return tr.left < b.right - 1 && tr.right > b.left + 1 && tr.top < b.bottom - 1 && tr.bottom > b.top + 1;
          });
          return {
            title: title.textContent.trim(),
            titleInside: tr.left >= parent.left - 1 && tr.right <= parent.right + 1 && tr.top >= parent.top - 1 && tr.width > 20,
            readable: Number(getComputedStyle(title).zIndex) >= 3 && getComputedStyle(title).overflow !== 'hidden',
            overlaps,
            oneLine: label.getClientRects().length <= 1,
            fits: label.scrollWidth <= label.clientWidth + 1,
            valueLines: value ? value.getClientRects().length : 0,
          };
        });
        expect(fit.title).toBe('נתונים');
        expect(fit.titleInside).toBe(true);
        expect(fit.readable).toBe(true);
        expect(fit.overlaps).toBe(false);
        expect(fit.oneLine).toBe(true);
        expect(fit.fits).toBe(true);
      }
      for (const [width, height] of [[1280, 720], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        const scroll = await page.evaluate(() => {
          openFlightCommMenu('cellular');
          const menu = document.getElementById('flightCommMenu');
          return menu.scrollHeight - menu.clientHeight;
        });
        expect(scroll, `${width}x${height}`).toBeLessThan(8);
      }
    }, 30000);

    it('accepts the mock companion down-camera frame', async () => {
      const frame = await fetch(`${base}/api/jetson/v1/cameras/cam1/frame`, { signal: AbortSignal.timeout(8000) });
      expect(frame.status).toBe(200);
      const buf = Buffer.from(await frame.arrayBuffer());
      expect(buf.length).toBeGreaterThan(20);
      await page.evaluate(() => {
        localStorage.setItem('vlc.horizon.bgCamera.v1', 'cam1');
        sessionStorage.clear();
      });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.locator('.tab[data-tab="terrain"]').click({ timeout: 4000 });
      await page.waitForFunction(() => {
        const note = document.getElementById('horizonCameraNote');
        const img = document.getElementById('horizonCameraBg');
        return img && img.naturalWidth > 0 && note && note.hidden === true;
      }, null, { timeout: 8000 });
      const note = await page.locator('#horizonCameraNote').innerText();
      expect(note).not.toContain('אין אות');
    }, 30000);
  });
});
