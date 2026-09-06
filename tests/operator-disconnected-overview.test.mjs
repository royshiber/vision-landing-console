import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

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

function tag(id) {
  const re = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`);
  const m = html.match(re);
  expect(m, `missing #${id}`).toBeTruthy();
  return m[0];
}

describe('Disconnected-first operator overview', () => {
  it('renames Maintenance to תחזוקה and ships one status plus one next step', () => {
    expect(html).toMatch(/<section id="maintenance"[\s\S]*?<h3>תחזוקה<\/h3>/);
    expect(html).not.toMatch(/<h3>פיתוח ותחזוקה<\/h3>/);
    expect(tag('maintOperatorBanner')).toMatch(/data-state="disconnected"/);
    expect(html).toMatch(/id="maintStatusBadge"[^>]*>המלווה מנותק</);
    expect(html).toMatch(/id="maintNextStep"[^>]*>חברו מלווה בטלמטריה\. כתובת לבד לא מחברת\.</);
    expect(tag('maintLiveSections')).toMatch(/\bhidden\b/);
    expect(html).toMatch(/id="maintLiveParked"[^>]*>נתוני Jetson וגרסאות יופיעו אחרי חיבור מלווה\.</);
  });

  it('hides Companion live walls until connected and keeps the confirm modal hidden', () => {
    expect(tag('companionDashboardSummary')).toMatch(/\bhidden\b/);
    expect(tag('companionB2Grid')).toMatch(/\bhidden\b/);
    expect(html).toMatch(/id="companionLiveParked"[^>]*>סיכום המלווה יופיע אחרי חיבור/);
    expect(html).toMatch(/id="companionB2Parked"[^>]*>נתוני מלווה יופיעו אחרי חיבור/);
    expect(tag('maintRelConfirmModal')).toMatch(/\bhidden\b/);
    expect(css).toMatch(/#companionDashboardSummary\[hidden\]/);
    expect(css).toMatch(/#maintLiveSections\[hidden\]/);
    expect(css).toMatch(/#companionMockBar\[hidden\]/);
    expect(css).toMatch(/display:\s*none\s*!important/);
  });

  it('collapses Telemetry dash walls behind a parked STATUS plus NEXT overview', () => {
    expect(html).toMatch(/<section id="telemetry"[\s\S]*?<h3>טלמטריה<\/h3>/);
    expect(tag('teleOperatorBanner')).toMatch(/data-state="disconnected"/);
    expect(html).toMatch(/id="teleStatusBadge"[^>]*>המלווה מנותק</);
    expect(html).toMatch(/id="teleNextStep"[^>]*>חברו מלווה בטלמטריה\. כתובת לבד לא מחברת\.</);
    expect(html).toMatch(/id="teleLiveParked"[^>]*>נתוני טלמטריה יופיעו אחרי חיבור מלווה\.</);
    expect(tag('teleLiveSections')).toMatch(/\bhidden\b/);
    expect(html).toMatch(/id="teleLiveSections"[^>]*>[\s\S]*class="telemetry-dashboard"/);
    expect(css).toMatch(/#teleLiveSections\[hidden\]/);
    expect(css).toMatch(/#teleLiveParked\[hidden\]/);
    expect(css).toMatch(/#teleNextStep\[hidden\]/);
  });

  it('keeps Development empty list as the next step and hides unused detail chrome', () => {
    expect(html).toMatch(/id="devTaskListEmpty"[^>]*>אין משימות\. צרו משימה למעלה\.</);
    expect(tag('devTaskFilters')).toMatch(/\bhidden\b/);
    expect(tag('devTaskDetailSection')).toMatch(/\bhidden\b/);
    expect(tag('devTaskDetailEmpty')).toMatch(/\bhidden\b/);
  });

  it('uses the same Hebrew disconnected next-step tone across Assist, Companion, and Maintenance', () => {
    expect(html).toMatch(/id="assistAgentStatus"[^>]*>הסוכן מנותק\.</);
    expect(html).toMatch(/id="assistAgentHint"[^>]*>חברו מפתח כדי לאשר שינוי\.</);
    expect(html).toMatch(/id="companionConnectStatus"[^>]*>המלווה מנותק</);
    expect(html).toMatch(/id="companionConnectHint"[^>]*>חיבור דורש כתובת ואסימון יחד\. כתובת לבד לא מחברת\.</);
    expect(html).toMatch(/id="maintNextStep"[^>]*>חברו מלווה בטלמטריה\. כתובת לבד לא מחברת\.</);
    expect(html).toMatch(/id="teleNextStep"[^>]*>חברו מלווה בטלמטריה\. כתובת לבד לא מחברת\.</);
    expect(html).toMatch(/id="assistAgentConnect"[^>]*\boperator-state\b/);
    expect(html).toMatch(/id="companionConnect"[^>]*\boperator-state\b/);
  });

  it('treats mock or reachable real as live and keeps off disconnected', () => {
    const src = [
      sliceFunction(js, 'companionIsLive'),
      'return { off: companionIsLive({ mode: "off" }), mock: companionIsLive({ mode: "mock" }), realDown: companionIsLive({ mode: "real", reachable: false }), realUp: companionIsLive({ mode: "real", reachable: true }), connected: companionIsLive({ mode: "real", connected: true }) };',
    ].join('\n');
    const result = new Function(src)();
    expect(result.off).toBe(false);
    expect(result.mock).toBe(true);
    expect(result.realDown).toBe(false);
    expect(result.realUp).toBe(true);
    expect(result.connected).toBe(true);
  });

  it('collapses Maintenance live sections until a real wire arrives', () => {
    const liveEl = { hidden: true };
    const parked = { hidden: false };
    const next = { hidden: false, textContent: '' };
    const badge = { textContent: '', className: '' };
    const banner = { dataset: { state: 'disconnected' } };
    const ui = { textContent: '—' };
    const document = {
      getElementById(id) {
        if (id === 'maintOperatorBanner') return banner;
        if (id === 'maintStatusBadge') return badge;
        if (id === 'maintNextStep') return next;
        if (id === 'maintLiveParked') return parked;
        if (id === 'maintLiveSections') return liveEl;
        if (id === 'maintUiVersion') return ui;
        return null;
      },
      querySelector() { return { content: '1.02.255' }; },
    };
    const src = [
      'function maintSetEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = (val == null || val === "") ? "—" : String(val); }',
      sliceFunction(js, 'maintSetOverview'),
      'maintSetOverview({ live: false, statusHe: "המלווה מנותק", nextHe: "חברו מלווה בטלמטריה. כתובת לבד לא מחברת.", state: "disconnected" });',
      'const collapsed = { liveHidden: document.getElementById("maintLiveSections").hidden, parkedHidden: document.getElementById("maintLiveParked").hidden, next: document.getElementById("maintNextStep").textContent, ui: document.getElementById("maintUiVersion").textContent };',
      'maintSetOverview({ live: true, statusHe: "תקין", nextHe: "", state: "ok" });',
      'return { collapsed, liveHidden: document.getElementById("maintLiveSections").hidden, parkedHidden: document.getElementById("maintLiveParked").hidden, nextHidden: document.getElementById("maintNextStep").hidden, ui: document.getElementById("maintUiVersion").textContent };',
    ].join('\n');
    const result = new Function('document', src)(document);
    expect(result.collapsed.liveHidden).toBe(true);
    expect(result.collapsed.parkedHidden).toBe(false);
    expect(result.collapsed.next).toContain('חברו מלווה בטלמטריה');
    expect(result.liveHidden).toBe(false);
    expect(result.parkedHidden).toBe(true);
    expect(result.nextHidden).toBe(true);
    expect(result.ui).toBe('1.02.255');
  });

  it('hides Development filters and detail until a task exists', () => {
    const filters = { hidden: true };
    const section = { hidden: true };
    const card = { hidden: true };
    const detailEmpty = { hidden: true, textContent: '' };
    const listEmpty = { hidden: false, textContent: '' };
    const document = {
      getElementById(id) {
        if (id === 'devTaskFilters') return filters;
        if (id === 'devTaskDetailSection') return section;
        if (id === 'devTaskDetailCard') return card;
        if (id === 'devTaskDetailEmpty') return detailEmpty;
        if (id === 'devTaskListEmpty') return listEmpty;
        return null;
      },
    };
    const src = [
      'let _devTasks = [];',
      sliceFunction(js, 'devSyncEmptyOverview'),
      'devSyncEmptyOverview();',
      'const empty = { filters: document.getElementById("devTaskFilters").hidden, section: document.getElementById("devTaskDetailSection").hidden, list: document.getElementById("devTaskListEmpty").textContent };',
      '_devTasks = [{ id: "t1" }];',
      'devSyncEmptyOverview();',
      'return { empty, filters: document.getElementById("devTaskFilters").hidden, section: document.getElementById("devTaskDetailSection").hidden, detail: document.getElementById("devTaskDetailEmpty").textContent, detailHidden: document.getElementById("devTaskDetailEmpty").hidden };',
    ].join('\n');
    const result = new Function('document', src)(document);
    expect(result.empty.filters).toBe(true);
    expect(result.empty.section).toBe(true);
    expect(result.empty.list).toBe('אין משימות. צרו משימה למעלה.');
    expect(result.filters).toBe(false);
    expect(result.section).toBe(false);
    expect(result.detail).toBe('בחר משימה מהרשימה');
    expect(result.detailHidden).toBe(false);
  });

  it('collapses Telemetry walls until live and reveals them on the live path', () => {
    const teleLive = { hidden: true };
    const teleParked = { hidden: false };
    const next = { hidden: false, textContent: '' };
    const badge = { textContent: '', className: '' };
    const banner = { dataset: { state: 'disconnected' } };
    const summary = { hidden: true };
    const summaryParked = { hidden: false };
    const b2Grid = { hidden: true };
    const b2Parked = { hidden: false };
    const document = {
      getElementById(id) {
        if (id === 'teleOperatorBanner') return banner;
        if (id === 'teleStatusBadge') return badge;
        if (id === 'teleNextStep') return next;
        if (id === 'teleLiveParked') return teleParked;
        if (id === 'teleLiveSections') return teleLive;
        if (id === 'companionDashboardSummary') return summary;
        if (id === 'companionLiveParked') return summaryParked;
        if (id === 'companionB2Grid') return b2Grid;
        if (id === 'companionB2Parked') return b2Parked;
        return null;
      },
    };
    const src = [
      sliceFunction(js, 'companionSetLiveChrome'),
      sliceFunction(js, 'teleSetOverview'),
      'teleSetOverview({ live: false, statusHe: "המלווה מנותק", nextHe: "חברו מלווה בטלמטריה. כתובת לבד לא מחברת.", state: "disconnected" });',
      'companionSetLiveChrome(false);',
      'const collapsed = { liveHidden: document.getElementById("teleLiveSections").hidden, parkedHidden: document.getElementById("teleLiveParked").hidden, next: document.getElementById("teleNextStep").textContent, state: document.getElementById("teleOperatorBanner").dataset.state };',
      'teleSetOverview({ live: true, statusHe: "המלווה במצב מדומה", nextHe: "", state: "ok" });',
      'companionSetLiveChrome(true);',
      'return { collapsed, liveHidden: document.getElementById("teleLiveSections").hidden, parkedHidden: document.getElementById("teleLiveParked").hidden, nextHidden: document.getElementById("teleNextStep").hidden, status: document.getElementById("teleStatusBadge").textContent, summaryHidden: document.getElementById("companionDashboardSummary").hidden };',
    ].join('\n');
    const result = new Function('document', src)(document);
    expect(result.collapsed.liveHidden).toBe(true);
    expect(result.collapsed.parkedHidden).toBe(false);
    expect(result.collapsed.next).toContain('חברו מלווה בטלמטריה');
    expect(result.collapsed.state).toBe('disconnected');
    expect(result.liveHidden).toBe(false);
    expect(result.parkedHidden).toBe(true);
    expect(result.nextHidden).toBe(true);
    expect(result.status).toBe('המלווה במצב מדומה');
    expect(result.summaryHidden).toBe(false);
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const overview = [
      sliceFunction(js, 'companionIsLive'),
      sliceFunction(js, 'companionSetLiveChrome'),
      sliceFunction(js, 'operatorSyncFirstOpen'),
      sliceFunction(js, 'operatorOpenFirstAction'),
      sliceFunction(js, 'teleSetOverview'),
      sliceFunction(js, 'maintSetOverview'),
      sliceFunction(js, 'devSyncEmptyOverview'),
    ].join('\n');
    expect(overview).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('ships Hebrew-first Assist chrome and a calm first-open next action', () => {
    expect(html).toMatch(/class="assist-rail-title">מסייע</);
    expect(html).toMatch(/assist-toggle-he">מסייע</);
    expect(html).toMatch(/id="assistMessagesEmpty"[^>]*assist-empty-stage/);
    expect(html).toMatch(/כתבו שאלה או בקשה/);
    expect(html).toMatch(/שינוי דורש אישור/);
    expect(html).toMatch(/companion-connect--hero/);
    expect(html).toMatch(/data-first-action="assist"/);
    expect(html).toMatch(/data-first-action="params"/);
    expect(html).toMatch(/data-first-action="companion"/);
    expect(html).toMatch(/data-tab="simLab"[^>]*\btab-lab\b|class="tab tab-lab"[^>]*data-tab="simLab"/);
    expect(html).toMatch(/data-tab="advisor"[^>]*\btab-lab\b|class="tab tab-lab"[^>]*data-tab="advisor"/);
    expect(html).toMatch(/data-tab="featureDesigner"[^>]*\btab-lab\b|class="tab tab-lab"[^>]*data-tab="featureDesigner"/);
    expect(html).toMatch(/data-tab="flightEngineer"[^>]*\btab-lab\b|class="tab tab-lab"[^>]*data-tab="flightEngineer"/);
    expect(html).toMatch(/data-tab="telemetry"[^>]*\btab-ops\b|class="tab tab-ops"[^>]*data-tab="telemetry"/);
    expect(css).toMatch(/\.tab-lab\b/);
    expect(css).toMatch(/\.companion-connect--hero\b/);
    expect(css).toMatch(/\.assist-empty-stage\b/);
    expect(css).toMatch(/\.first-open-stage-fill\b/);
  });

  it('hides first-open actions when Companion is live', () => {
    const actions = { hidden: false };
    const body = { classList: { toggled: null, toggle(name, on) { this.toggled = { name, on }; } } };
    const document = {
      body,
      querySelectorAll(sel) {
        if (sel === '.first-open-actions') return [actions];
        return [];
      },
    };
    const src = [
      sliceFunction(js, 'operatorSyncFirstOpen'),
      'operatorSyncFirstOpen(true);',
      'const live = { hidden: document.querySelectorAll(".first-open-actions")[0].hidden, liveClass: document.body.classList.toggled };',
      'operatorSyncFirstOpen(false);',
      'return { live, idleHidden: document.querySelectorAll(".first-open-actions")[0].hidden };',
    ].join('\n');
    const result = new Function('document', src)(document);
    expect(result.live.hidden).toBe(true);
    expect(result.live.liveClass).toEqual({ name: 'operator-live', on: true });
    expect(result.idleHidden).toBe(false);
  });
});
