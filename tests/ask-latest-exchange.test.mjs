import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '4077';
const BASE = `http://127.0.0.1:${PORT}`;
const shots = '/opt/cursor/artifacts/ask-latest';

function intersects(a, b) {
  if (!a || !b || a.width < 2 || b.width < 2 || a.height < 2 || b.height < 2) return false;
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
}

describe('Ask latest exchange', () => {
  let serverProc = null;
  let browser = null;

  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT, SQLITE_PATH: `/tmp/airvix-ask-latest-${PORT}.sqlite` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
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

  for (const [width, height] of [[1280, 800], [1024, 640]]) {
    it(`shows the open field and the latest exchange under it at ${width}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#assistInput');
        const open = await page.evaluate(() => {
          const input = document.getElementById('assistInput');
          const mic = document.getElementById('assistMicBtn');
          const toggle = document.getElementById('missionAskToggleBtn');
          const rail = document.getElementById('assistRail');
          const mics = [...document.querySelectorAll('.assist-mic-btn')].filter((el) => getComputedStyle(el).display !== 'none');
          return {
            input: getComputedStyle(input).display,
            inputHidden: input.hidden,
            expanded: toggle.getAttribute('aria-expanded'),
            railHidden: rail.hidden,
            askOpen: document.getElementById('terrain')?.dataset.askOpen,
            micCount: mics.length,
            micText: (mic?.innerText || '').replace(/\s+/g, ' ').trim(),
          };
        });
        expect(open.input).not.toBe('none');
        expect(open.inputHidden).toBe(false);
        expect(open.expanded).toBe('true');
        expect(open.railHidden).toBe(false);
        expect(open.askOpen).toBe('1');
        expect(open.micCount).toBe(1);
        expect(open.micText).toContain('האזינו');

        await page.evaluate(() => {
          assistAppendMessage({ role: 'user', text: 'מה גובה הטיסה' });
          assistAppendMessage({ role: 'assist', text: 'אין חיבור לבקר הטיסה. הגובה לא ידוע.' });
        });
        await page.waitForSelector('#askLatest:not([hidden])');
        const boxes = await page.evaluate(() => {
          const rect = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
          };
          const chips = [...document.querySelectorAll('.mission-link-chip')].map(rect);
          return {
            input: rect(document.getElementById('assistInput')),
            latest: rect(document.getElementById('askLatest')),
            question: rect(document.getElementById('askLatestQuestion')),
            answer: rect(document.getElementById('askLatestAnswer')),
            horizon: rect(document.querySelector('[data-mission-region="horizon"]')),
            chips,
            questionText: document.getElementById('askLatestQuestion')?.textContent,
            answerText: document.getElementById('askLatestAnswer')?.textContent,
          };
        });
        expect(boxes.questionText).toBe('מה גובה הטיסה');
        expect(boxes.answerText).toBe('אין חיבור לבקר הטיסה. הגובה לא ידוע.');
        expect(boxes.latest.top).toBeGreaterThanOrEqual(boxes.input.bottom - 1);
        expect(boxes.question.top).toBeGreaterThanOrEqual(boxes.input.bottom - 1);
        expect(boxes.answer.top).toBeGreaterThanOrEqual(boxes.question.bottom - 1);
        for (const chip of boxes.chips) {
          expect(intersects(boxes.latest, chip)).toBe(false);
          expect(intersects(boxes.input, chip)).toBe(false);
        }
        expect(intersects(boxes.latest, boxes.horizon)).toBe(false);
        expect(intersects(boxes.input, boxes.horizon)).toBe(false);
        await page.screenshot({ path: path.join(shots, `ask-${width}x${height}.png`) });
      } finally {
        await page.close();
      }
    }, 30000);
  }
});
