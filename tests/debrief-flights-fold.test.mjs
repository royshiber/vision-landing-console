import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { hebrewLookingAtAnswer } from '../lib/assist/assist-hebrew.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const paren = src.indexOf('(', start);
  let depth = 0;
  let i = paren;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const brace = src.indexOf('{', i);
  depth = 0;
  for (i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

describe('C10.5a leftover #flights folds into תחקור', () => {
  it('keeps one debrief tab on the shelf and no leftover flights chrome', () => {
    expect(html).toMatch(/class="tab tab-ops"[^>]*data-tab="recordings"[^>]*>תחקור</);
    expect(html).not.toMatch(/data-tab="flights"/);
    expect(html).not.toContain('לוגים והעלאות');
    expect(html).not.toContain('openFlightsFromDebriefBtn');
    expect(html).not.toContain('debriefRecBtn2');
    expect(html).not.toContain('debriefLogsBtn2');
    expect(html).not.toContain('פתח לוגים והעלאות');
    expect(js).not.toContain("applyMainTab('flights')");
    expect(js).not.toContain('.tab[data-tab="flights"]');
  });

  it('hosts recordings and logs chrome inside תחקור', () => {
    const rec = capture(
      html,
      /<section\b[^>]*\bid="recordings"[^>]*>([\s\S]*?)<\/section>\s*<section\b[^>]*\bid="processes"/,
      'missing #recordings panel',
    )[1];
    expect(rec).toMatch(/id="debriefRecBtn"[^>]*data-debrief-tab="recordings"[^>]*>הקלטות</);
    expect(rec).toMatch(/id="debriefLogsBtn"[^>]*data-debrief-tab="logs"[^>]*>לוגים</);
    expect(rec).toContain('id="debriefRecordingsPanel"');
    expect(rec).toContain('id="flightVideo"');
    expect(rec).toContain('id="debriefLogsPanel"');
    expect(rec).toContain('id="flightSelect"');
    expect(rec).toContain('id="logDropZone"');
    expect(rec).toContain('id="flightListWrap"');
    expect(rec).toContain('id="allLogsArduTbody"');
    expect(rec).toContain('id="allLogsJetsonTbody"');
    expect(rec).toContain('העלאת לוג חדש');
    expect(rec).toContain('טיסות ולוגים');
    expect(rec).toContain('כל הלוגים');
    const leftover = capture(
      html,
      /<section\b[^>]*\bid="flights"[^>]*>/,
      'missing leftover #flights stub',
    )[0];
    expect(leftover).toMatch(/\bhidden\b/);
    expect(leftover).toMatch(/aria-hidden="true"/);
    expect(html).not.toMatch(/<section\b[^>]*\bid="flights"[^>]*>[\s\S]*id="flightSelect"/);
  });

  it('redirects leftover flights navigation into recordings + logs', () => {
    const applyDebrief = sliceFunction(js, 'applyDebriefSubtab');
    const applyMain = sliceFunction(js, 'applyMainTab');
    const restore = sliceFunction(js, 'restoreLastUiTab');
    const openLogs = sliceFunction(js, 'openDebriefLogs');
    expect(applyDebrief).not.toMatch(/applyMainTab\(\s*'flights'/);
    expect(applyDebrief).toMatch(/tabId === 'logs' \? 'logs' : 'recordings'/);
    expect(applyMain).toMatch(/if \(tabId === 'flights'\)/);
    expect(applyMain).toMatch(/openDebriefLogs\(/);
    expect(openLogs).toMatch(/applyMainTab\(\s*'recordings'/);
    expect(openLogs).toMatch(/applyDebriefSubtab\(\s*'logs'/);
    expect(restore).toMatch(/if \(main === 'flights'\)/);
    expect(restore).toMatch(/debriefSub = 'logs'/);
    expect(restore).toMatch(/applyDebriefSubtab\(debriefSub === 'logs' \? 'logs' : 'recordings'/);
    const simLab = fs.readFileSync(path.join(repoRoot, 'public', 'sim-lab.mjs'), 'utf8');
    expect(simLab).toContain("document.getElementById('debriefLogsBtn')?.click()");
    expect(simLab).not.toContain('.tab[data-tab="flights"]');
  });

  it('keeps leftover flights Assist labels on the תחקור route', () => {
    expect(findAssistRoute('תחקור')?.tab).toBe('recordings');
    expect(findAssistRoute('הקלטות')?.tab).toBe('recordings');
    expect(findAssistRoute('לוגים')?.tab).toBe('recordings');
    expect(findAssistRoute('טיסות')?.tab).toBe('recordings');
    expect(findAssistRoute('flights')?.tab).toBe('recordings');
    expect(hebrewLookingAtAnswer('PLATFORM', 'debrief', 'recordings')).toContain('מסך נוכחי: תחקור.');
    expect(hebrewLookingAtAnswer('PLATFORM', 'debrief', 'flights')).toContain('מסך נוכחי: תחקור.');
    expect(css).toMatch(/#debriefLogsPanel\.debrief-logs-panel\.visible/);
    expect(css).toMatch(/\.debrief-logs-grid\b/);
    expect(css).not.toMatch(/#flights\.panel\.visible\.flights-panel/);
  });

  it('pins APP_VERSION at 1.02.255', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.255'");
    expect(pkg.version).toBe('1.02.255');
  });
});
