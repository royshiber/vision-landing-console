import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const shotDir = '/opt/cursor/artifacts/screenshots';

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function cssBlock(src, selector) {
  const start = src.indexOf(selector);
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed selector ${selector}`);
}

function interiorsIntersect(a, b, slack = 1) {
  if (!a || !b || a.width < 2 || b.width < 2 || a.height < 2 || b.height < 2) return false;
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

describe('Mission messages toggle — source contract', () => {
  it('pins APP_VERSION at 1.02.371', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.371'");
    expect(pkg.version).toBe('1.02.371');
  });

  it('keeps the message list readable and LTR inside the RTL column', () => {
    expect(html).toMatch(/data-mission-region="messages"[^>]*data-messages-expanded="0"/);
    expect(html).toMatch(/data-mission-region="messages"[^>]*dir="rtl"/);
    expect(html).toMatch(/id="pfcMsgFilterAll"[^>]*>הכל</);
    expect(html).toMatch(/id="pfcMsgFilterWarn"[^>]*>אזהרות</);
    expect(html).toMatch(/id="pfcMsgScroll"[^>]*dir="ltr"/);
    expect(html).toMatch(/data-mission-data-slot="batt"/);
    expect(html).toMatch(/class="mission-data-label">מתח</);
    expect(html).toMatch(/id="missionMessagesToggle"/);
    expect(html).toMatch(/id="missionMessagesSummary"/);
    expect(html).toMatch(/id="missionMessagesCount"/);
    expect(html).toMatch(/id="missionMessagesBadge"/);
    expect(html).not.toMatch(/id="hudAddSlotBtn"/);
    expect(html).toMatch(/id="pfdHorizonMsgLog"[^>]*hidden/);
    expect(html).not.toContain('Vision Landing Console');
    const messages = html.slice(html.indexOf('data-mission-region="messages"'), html.indexOf('data-mission-region="map"'));
    expect(messages).not.toMatch(/EKF|PreArm|ArduPlane|STATUSTEXT אחרון/);
    expect(js).toContain("const MISSION_MESSAGES_KEY = 'visionLandingMissionMessagesV1'");
    expect(js).toContain('function translateFcStatusText(');
    expect(js).toContain('function collapseConsecutiveFcStatus(');
    const open = cssBlock(css, '.mission-region-messages[data-messages-expanded="1"]');
    expect(open).toMatch(/max-height:\s*min\(160px, 32%\)/);
    expect(open).toMatch(/flex:\s*0 1 auto/);
    expect(open).not.toMatch(/min-height:\s*210px/);
    const closed = cssBlock(css, '.mission-region-messages[data-messages-expanded="0"]');
    expect(closed).toMatch(/max-height:\s*none/);
    expect(closed).toMatch(/flex:\s*0 0 auto/);
    const init = sliceFunction(js, 'initMissionMessages');
    expect(init).toContain('readMissionMessagesExpanded()');
    expect(init).not.toContain('writeMissionMessagesExpanded(true)');
    const scroll = cssBlock(css, '.mission-region-messages .pfc-msg-scroll');
    expect(scroll).toMatch(/font-family:\s*"Heebo"/);
    expect(scroll).toMatch(/font-size:\s*clamp\(13px/);
    expect(scroll).toMatch(/line-height:\s*1\.45/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(scroll).toMatch(/direction:\s*ltr/);
    expect(cssBlock(css, '.mission-region-messages .pfc-msg-line--warn')).toMatch(/color:\s*#fcd34d/);
    expect(cssBlock(css, '.mission-region-messages .pfc-msg-line--error')).toMatch(/color:\s*#fecaca/);
    expect(cssBlock(css, '.pfd-horizon-msg-log')).toMatch(/display:\s*none/);
  });

  it('collapses consecutive duplicates, translates common lines, and filters warnings', () => {
    const history = [];
    const scroll = {
      innerHTML: '',
      appendChild(node) { history.push(node); },
      ownerDocument: {
        createElement() {
          const node = {
            className: '',
            dir: '',
            title: '',
            textContent: '',
            dateTime: '',
            children: [],
            appendChild(child) { this.children.push(child); },
          };
          return node;
        },
      },
    };
    const src = [
      'let _fcMsgFilter = "all";',
      'let _missionMessagesRows = [];',
      sliceFunction(js, 'statusTextLineWarn'),
      sliceFunction(js, 'translatePrearmText'),
      sliceFunction(js, 'fcStatusTimeLabel'),
      sliceFunction(js, 'translateFcStatusText'),
      sliceFunction(js, 'collapseConsecutiveFcStatus'),
      sliceFunction(js, 'fcStatusSeverityClass'),
      sliceFunction(js, 'fcStatusShownText'),
      sliceFunction(js, 'paintFcStatustextHistory'),
      sliceFunction(js, 'setFcMsgFilter'),
      'const rows = [',
      "  { text: 'EKF3 waiting for GPS config data', severity: 4, receivedAt: '2026-09-26T12:00:04Z' },",
      "  { text: 'EKF3 waiting for GPS config data', severity: 4, receivedAt: '2026-09-26T12:00:03Z' },",
      "  { text: 'EKF3 waiting for GPS config data', severity: 4, receivedAt: '2026-09-26T12:00:02Z' },",
      "  { text: 'EKF3 waiting for GPS config data', severity: 4, receivedAt: '2026-09-26T12:00:01Z' },",
      "  { text: 'ArduPlane V4.5.0', severity: 6, receivedAt: '2026-09-26T11:59:00Z' },",
      '];',
      '_missionMessagesRows = rows;',
      'paintFcStatustextHistory(rows);',
      'const all = history.splice(0).map((n) => ({',
      '  title: n.title,',
      '  className: n.className,',
      '  text: n.children.map((c) => c.textContent).join(""),',
      '  time: (n.children.find((c) => c.className === "pfc-msg-time") || {}).textContent || "",',
      '}));',
      'setFcMsgFilter("warn");',
      'const warn = history.splice(0).map((n) => n.title);',
      'return { all, warn };',
    ].join('\n');
    const result = new Function('pfcMsgScroll', 'document', 'history', src)(scroll, {
      getElementById() { return { setAttribute() {} }; },
    }, history);
    expect(result.all).toHaveLength(2);
    expect(result.all[0].title).toBe('EKF3 waiting for GPS config data');
    expect(result.all[0].text).toContain('EKF3 ממתינים להגדרת GPS');
    expect(result.all[0].text).not.toContain('לוויין');
    expect(result.all[0].text).toContain('×4');
    expect(result.all[0].className).toContain('pfc-msg-line--warn');
    expect(result.all[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(result.all[1].title).toBe('ArduPlane V4.5.0');
    expect(result.warn).toEqual(['EKF3 waiting for GPS config data']);
    const translate = new Function(`${sliceFunction(js, 'translateFcStatusText')}; return translateFcStatusText;`)();
    expect(translate('Compass not healthy')).toBe('המצפן לא תקין');
    expect(translate('PreArm: Compass not healthy')).toBe('לא ניתן לחמש: המצפן לא תקין');
    expect(translate('EKF3 IMU0 is using GPS')).toBe('EKF משתמש ב-GPS');
    expect(translate('EKF3 waiting for GPS config data')).toBe('EKF3 ממתינים להגדרת GPS');
  });

  it('persists the toggle and paints severity only on the unread badge', () => {
    const store = new Map();
    const badge = { hidden: true, textContent: '', dataset: { severity: 'none' } };
    const region = { dataset: { messagesExpanded: '0' } };
    const scroll = { hidden: true };
    const log = { hidden: false };
    const toggle = {
      title: '',
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
    };
    const doc = {
      getElementById(id) {
        if (id === 'missionMessagesBadge') return badge;
        if (id === 'pfcMsgScroll') return scroll;
        if (id === 'pfdHorizonMsgLog') return log;
        if (id === 'missionMessagesToggle') return toggle;
        return null;
      },
      querySelector(sel) {
        if (sel === '[data-mission-region="messages"]') return region;
        return null;
      },
    };
    const src = [
      'const localStorage = {',
      '  getItem(k) { return store.has(k) ? store.get(k) : null; },',
      '  setItem(k, v) { store.set(k, String(v)); },',
      '};',
      'const document = doc;',
      "const MISSION_MESSAGES_KEY = 'visionLandingMissionMessagesV1';",
      "const MISSION_MESSAGES_SEEN_KEY = 'visionLandingMissionMessagesSeenV1';",
      'let _missionMessagesRows = [];',
      'let _missionMessagesSeenSig = null;',
      sliceFunction(js, 'statusTextLineWarn'),
      sliceFunction(js, 'missionLayoutStoreGet'),
      sliceFunction(js, 'missionLayoutStoreSet'),
      sliceFunction(js, 'missionMessagesSeveritySig'),
      sliceFunction(js, 'readMissionMessagesSeenSig'),
      sliceFunction(js, 'writeMissionMessagesSeenSig'),
      sliceFunction(js, 'readMissionMessagesExpanded'),
      sliceFunction(js, 'writeMissionMessagesExpanded'),
      sliceFunction(js, 'syncMissionMessagesBadge'),
      sliceFunction(js, 'applyMissionMessagesExpanded'),
      sliceFunction(js, 'toggleMissionMessages'),
      'const rows = [',
      "  { text: 'EKF3 IMU0 is using GPS', severity: 6 },",
      "  { text: 'PreArm: Compass not healthy', severity: 2 },",
      '];',
      '_missionMessagesRows = rows;',
      'syncMissionMessagesBadge(rows);',
      'const badge = document.getElementById("missionMessagesBadge");',
      'const region = document.querySelector("[data-mission-region=\\"messages\\"]");',
      'const toggle = document.getElementById("missionMessagesToggle");',
      'const scroll = document.getElementById("pfcMsgScroll");',
      'const log = document.getElementById("pfdHorizonMsgLog");',
      'const hiddenBadge = { text: badge.textContent, severity: badge.dataset.severity, hidden: badge.hidden };',
      'toggleMissionMessages();',
      'const opened = {',
      '  stored: localStorage.getItem(MISSION_MESSAGES_KEY),',
      '  expanded: region.dataset.messagesExpanded,',
      '  aria: toggle.attrs["aria-expanded"],',
      '  label: toggle.title,',
      '  badgeHidden: badge.hidden,',
      '  scrollHidden: scroll.hidden,',
      '  logHidden: log.hidden,',
      '};',
      'toggleMissionMessages();',
      'syncMissionMessagesBadge(rows);',
      'const reread = { text: badge.textContent, hidden: badge.hidden, stored: localStorage.getItem(MISSION_MESSAGES_KEY) };',
      'syncMissionMessagesBadge([{ text: "PreArm: Compass not healthy", severity: 2 }, { text: "Battery failsafe", severity: 3 }]);',
      'const fresh = { text: badge.textContent, severity: badge.dataset.severity, hidden: badge.hidden };',
      'return { hiddenBadge, opened, reread, fresh };',
    ].join('\n');
    const result = new Function('store', 'doc', src)(store, doc);
    expect(result.hiddenBadge).toEqual({ text: '1', severity: 'error', hidden: false });
    expect(result.opened.stored).toBe('1');
    expect(result.opened.expanded).toBe('1');
    expect(result.opened.aria).toBe('true');
    expect(result.opened.label).toBe('הודעות');
    expect(result.opened.badgeHidden).toBe(true);
    expect(result.opened.scrollHidden).toBe(false);
    expect(result.opened.logHidden).toBe(true);
    expect(result.reread.hidden).toBe(true);
    expect(result.reread.stored).toBe('0');
    expect(result.fresh).toEqual({ text: '2', severity: 'error', hidden: false });
    const badgeSrc = sliceFunction(js, 'syncMissionMessagesBadge') + sliceFunction(js, 'applyMissionMessagesExpanded');
    expect(badgeSrc).not.toMatch(/\/apply|\/restart|FLIGHT_ACTION|PARAM_SET|\bARM\b|\bDISARM\b|\bLAND\b/);
  });
});

describe('Mission messages toggle — live layout', () => {
  const PORT = '4025';
  const BASE = `http://127.0.0.1:${PORT}`;
  let serverProc = null;
  let browser = null;
  let page = null;

  function boxIntersectReport(regions, extra = []) {
    const names = Object.keys(regions);
    const failures = [];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        if (interiorsIntersect(regions[names[i]], regions[names[j]])) {
          failures.push(`${names[i]} overlaps ${names[j]}`);
        }
      }
    }
    for (const pair of extra) {
      if (interiorsIntersect(pair.a, pair.b)) failures.push(pair.label);
    }
    return failures;
  }

  async function measure(pageRef) {
    return pageRef.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const ws = document.querySelector('.mission-workspace');
      const msg = document.querySelector('[data-mission-region="messages"]');
      const scroll = document.getElementById('pfcMsgScroll');
      const scrollCs = scroll ? getComputedStyle(scroll) : null;
      const msgCs = msg ? getComputedStyle(msg) : null;
      const line = scroll?.querySelector('.pfc-msg-line');
      const lineCs = line ? getComputedStyle(line) : null;
      const badge = document.getElementById('missionMessagesBadge');
      const badgeCs = badge && !badge.hidden ? getComputedStyle(badge) : null;
      return {
        ws: box(ws),
        map: box(document.querySelector('[data-mission-region="map"]')),
        horizon: box(document.querySelector('[data-mission-region="horizon"]')),
        talk: box(document.querySelector('[data-mission-region="talk"]')),
        data: box(document.querySelector('[data-mission-region="data"]')),
        messages: box(msg),
        stage: box(document.getElementById('pfdHorizonStage')),
        tiles: [...document.querySelectorAll('.mission-data-tile')].map(box),
        expanded: msg?.dataset.messagesExpanded || '',
        dir: msg ? getComputedStyle(msg).direction : '',
        msgMax: msgCs?.maxHeight || '',
        msgDisplay: msgCs?.display || '',
        wsDisplay: getComputedStyle(ws).display,
        scrollFont: scrollCs?.fontFamily || '',
        scrollSize: scrollCs?.fontSize || '',
        scrollLine: scrollCs?.lineHeight || '',
        scrollDir: scrollCs?.direction || '',
        scrollOverflow: scrollCs?.overflowY || '',
        lineColor: lineCs?.color || '',
        lineCount: scroll ? scroll.querySelectorAll('.pfc-msg-line').length : 0,
        badgeText: badge?.textContent || '',
        badgeHidden: badge ? badge.hidden : true,
        badgeSeverity: badge?.dataset.severity || '',
        badgeBg: badgeCs?.backgroundColor || '',
        logDisplay: getComputedStyle(document.getElementById('pfdHorizonMsgLog')).display,
        stored: localStorage.getItem('visionLandingMissionMessagesV1'),
        scrollH: scroll ? scroll.clientHeight : 0,
        scrollFull: scroll ? scroll.scrollHeight : 0,
      };
    });
  }

  async function shot(name) {
    fs.mkdirSync(shotDir, { recursive: true });
    const file = path.join(shotDir, name);
    await page.screenshot({ path: file, type: 'png', fullPage: false });
    return file;
  }

  beforeAll(async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: repoRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
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
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('vlc-msg-test-ready')) return;
      localStorage.removeItem('visionLandingMissionMessagesV1');
      localStorage.removeItem('visionLandingMissionMessagesSeenV1');
      sessionStorage.setItem('vlc-msg-test-ready', '1');
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-mission-region="map"]');
    await page.waitForFunction(
      () => document.querySelectorAll('.leaflet-tile-loaded').length >= 1,
      { timeout: 15000 },
    ).catch(() => {});
  }, 45000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (serverProc && !serverProc.killed) {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  });

  it('collapses to one line by default and opens a compact LTR list', async () => {
    const shots = [];
    const collapsed = await measure(page);
    expect(collapsed.expanded).toBe('0');
    expect(collapsed.stored).toBeNull();
    expect(collapsed.messages.height).toBeGreaterThanOrEqual(24);
    expect(collapsed.messages.height).toBeLessThan(80);
    expect(collapsed.horizon.height).toBeGreaterThan(collapsed.messages.height);
    const summary0 = await page.locator('#missionMessagesSummary').innerText();
    expect(summary0).toContain('אין הודעות');

    async function check(label) {
      const measured = await measure(page);
      expect(measured.wsDisplay, label).toBe('grid');
      expect(measured.msgDisplay, label).toMatch(/flex/);
      expect(measured.dir, label).toBe('rtl');
      expect(measured.scrollDir, label).toBe('ltr');
      expect(measured.expanded, label).toBe('1');
      expect(measured.logDisplay, label).toBe('none');
      expect(measured.messages.height, label).toBeGreaterThanOrEqual(28);
      expect(measured.messages.height, label).toBeLessThanOrEqual(170);
      expect(measured.scrollH, label).toBeGreaterThanOrEqual(24);
      if (String(label).startsWith('mobile')) {
        expect(measured.map.height, label).toBeGreaterThanOrEqual(110);
        expect(measured.map.height / measured.ws.height, label).toBeGreaterThan(0.12);
        expect(measured.stage.height, label).toBeGreaterThanOrEqual(120);
        expect(measured.horizon.top, label).toBeGreaterThanOrEqual(measured.map.bottom - 2);
      } else {
        expect(measured.map.height / measured.ws.height, label).toBeGreaterThanOrEqual(0.55);
      }
      expect(measured.scrollFont, label).toMatch(/Heebo/);
      expect(Number.parseFloat(measured.scrollSize), label).toBeGreaterThanOrEqual(13);
      expect(Number.parseFloat(measured.scrollSize), label).toBeLessThanOrEqual(15);
      const lineRatio = Number.parseFloat(measured.scrollLine) / Number.parseFloat(measured.scrollSize);
      expect(lineRatio, label).toBeGreaterThan(1.3);
      expect(lineRatio, label).toBeLessThan(1.6);
      expect(measured.scrollOverflow, label).toMatch(/auto|scroll/);
      const regions = {
        map: measured.map,
        horizon: measured.horizon,
        talk: measured.talk,
      };
      const failures = boxIntersectReport(regions, [
        { a: measured.messages, b: measured.map, label: 'messages overlaps map' },
        { a: measured.messages, b: measured.talk, label: 'messages overlaps talk' },
        { a: measured.messages, b: measured.stage, label: 'messages overlaps AH' },
        { a: measured.messages, b: measured.data, label: 'messages overlaps data' },
        ...measured.tiles.map((tile, i) => ({ a: measured.messages, b: tile, label: `messages overlaps tile ${i}` })),
      ]);
      expect(failures, label).toEqual([]);
      return measured;
    }

    await page.click('#missionMessagesToggle');
    const desk = await check('desktop');
    expect(desk.stored).toBe('1');
    shots.push(await shot('mission-messages-open-1280x800.png'));

    await page.evaluate(() => {
      applyFcStatustextHud({
        connected: true,
        listening: true,
        heartbeatCount: 4,
        recentStatusTexts: [
          { severity: 4, text: 'EKF3 waiting for GPS config data', receivedAt: '2026-09-26T12:00:04Z' },
          { severity: 4, text: 'EKF3 waiting for GPS config data', receivedAt: '2026-09-26T12:00:03Z' },
          { severity: 4, text: 'EKF3 waiting for GPS config data', receivedAt: '2026-09-26T12:00:02Z' },
          { severity: 4, text: 'EKF3 waiting for GPS config data', receivedAt: '2026-09-26T12:00:01Z' },
          { severity: 2, text: 'PreArm: Compass not healthy', receivedAt: '2026-09-26T11:59:50Z' },
          { severity: 6, text: 'ArduPlane V4.5.0', receivedAt: '2026-09-26T11:59:00Z' },
        ],
      });
    });
    const painted = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('#pfcMsgScroll .pfc-msg-line')];
      return lines.map((line) => ({
        title: line.title,
        text: line.textContent,
        className: line.className,
        dir: getComputedStyle(line).direction,
      }));
    });
    expect(painted[0].title).toBe('EKF3 waiting for GPS config data');
    expect(painted[0].text).toContain('EKF3 ממתינים להגדרת GPS');
    expect(painted[0].text).not.toContain('לוויין');
    expect(painted[0].text).toContain('×4');
    expect(painted[0].className).toContain('pfc-msg-line--warn');
    expect(painted[0].dir).toBe('ltr');
    expect(painted.some((line) => line.title === 'PreArm: Compass not healthy')).toBe(true);
    const warned = await page.evaluate(() => {
      document.getElementById('pfcMsgFilterWarn').click();
      return [...document.querySelectorAll('#pfcMsgScroll .pfc-msg-line')].map((line) => line.title);
    });
    expect(warned).not.toContain('ArduPlane V4.5.0');
    expect(warned).toContain('EKF3 waiting for GPS config data');
    await page.click('#pfcMsgFilterAll');
    shots.push(await shot('mission-messages-shown-1280x800.png'));

    await page.setViewportSize({ width: 360, height: 800 });
    await check('mobile');
    shots.push(await shot('mission-messages-shown-360x800.png'));
    await page.click('#missionMessagesToggle');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#missionMessagesSummary');
    const kept = await measure(page);
    expect(kept.expanded).toBe('0');
    expect(kept.stored).toBe('0');
    expect(kept.messages.height).toBeLessThan(160);
    fs.writeFileSync(path.join(shotDir, 'mission-messages-shots.json'), JSON.stringify(shots, null, 2));
  }, 60000);
});
