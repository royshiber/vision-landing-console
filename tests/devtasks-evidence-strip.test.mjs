import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
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

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

function innerText(fragment) {
  return fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function makeEls() {
  const store = {};
  for (const id of [
    'devEvidenceWhat',
    'devEvidenceWhy',
    'devEvidenceState',
    'devEvidenceTests',
    'devEvidenceRelease',
    'devEvidenceRunning',
  ]) {
    store[id] = { id, textContent: '—' };
  }
  return store;
}

function bind(task, els = makeEls()) {
  const document = {
    getElementById(id) {
      return els[id] || null;
    },
  };
  const src = [
    sliceFunction(js, 'devText'),
    sliceFunction(js, 'devEvidenceJoin'),
    sliceFunction(js, 'devBindEvidenceStrip'),
    'devBindEvidenceStrip(task);',
    'return {',
    '  what: document.getElementById("devEvidenceWhat").textContent,',
    '  why: document.getElementById("devEvidenceWhy").textContent,',
    '  state: document.getElementById("devEvidenceState").textContent,',
    '  tests: document.getElementById("devEvidenceTests").textContent,',
    '  release: document.getElementById("devEvidenceRelease").textContent,',
    '  running: document.getElementById("devEvidenceRunning").textContent,',
    '};',
  ].join('\n');
  return new Function('document', 'task', src)(document, task);
}

describe('C10.4b Development evidence strip', () => {
  it('places a compact Hebrew strip at the top of #devTaskDetailCard above edit/actions', () => {
    const card = capture(
      html,
      /<div id="devTaskDetailCard"[^>]*>([\s\S]*?)<div class="devtasks-edit">/,
      'missing #devTaskDetailCard before edit',
    )[1];
    expect(card).toMatch(/id="devEvidenceStrip"/);
    expect(card.indexOf('id="devEvidenceStrip"')).toBeLessThan(card.indexOf('id="devDetailId"'));
    expect(html.indexOf('id="devEvidenceStrip"')).toBeLessThan(html.indexOf('id="devDetailSaveBtn"'));
    expect(html.indexOf('id="devEvidenceStrip"')).toBeLessThan(html.indexOf('id="devAgentStartBtn"'));

    const strip = capture(
      html,
      /<div id="devEvidenceStrip"[^>]*>([\s\S]*?)<\/div>/,
      'missing #devEvidenceStrip',
    )[0];
    expect(strip).toContain('dir="rtl"');
    expect(strip).toContain('aria-label="ראיות משימה"');
    expect(strip).toMatch(/<span>מה<\/span>/);
    expect(strip).toMatch(/<span>למה<\/span>/);
    expect(strip).toMatch(/<span>מצב<\/span>/);
    expect(strip).toMatch(/<span>בדיקות<\/span>/);
    expect(strip).toMatch(/<span>גרסה<\/span>/);
    expect(strip).toMatch(/<span>גרסה רצה<\/span>/);
    expect(strip).toContain('id="devEvidenceWhat"');
    expect(strip).toContain('id="devEvidenceWhy"');
    expect(strip).toContain('id="devEvidenceState"');
    expect(strip).toContain('id="devEvidenceTests"');
    expect(strip).toContain('id="devEvidenceRelease"');
    expect(strip).toContain('id="devEvidenceRunning"');
  });

  it('keeps strip chrome Hebrew with no English leftover labels', () => {
    const strip = capture(
      html,
      /<div id="devEvidenceStrip"[^>]*>([\s\S]*?)<\/div>/,
      'missing #devEvidenceStrip',
    )[0];
    const labels = [...strip.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(['מה', 'למה', 'מצב', 'בדיקות', 'גרסה', 'גרסה רצה']);
    expect(innerText(strip)).not.toMatch(/\bWhat\b/);
    expect(innerText(strip)).not.toMatch(/\bWhy\b/);
    expect(innerText(strip)).not.toMatch(/\bState\b/);
    expect(innerText(strip)).not.toMatch(/\bTests\b/);
    expect(innerText(strip)).not.toMatch(/\bRelease\b/);
    expect(innerText(strip)).not.toMatch(/running_version/i);
    expect(strip).not.toMatch(/>\s*What\s*</);
    expect(strip).not.toMatch(/>\s*Why\s*</);
    expect(strip).not.toMatch(/>\s*State\s*</);
    expect(strip).not.toMatch(/>\s*Tests\s*</);
    expect(strip).not.toMatch(/>\s*Release\s*</);
    expect(strip).not.toMatch(/>\s*running_version\s*</);
  });

  it('binds existing task JSON fields and stays honest when empty', () => {
    const empty = bind({
      taxonomy: 'FEATURE',
      title: '',
      target_area: '',
      description: '',
      notes: null,
      status: 'DRAFT',
    });
    expect(empty.what).toBe('FEATURE · — · —');
    expect(empty.why).toBe('—');
    expect(empty.state).toBe('DRAFT · NOT_STARTED');
    expect(empty.tests).toBe('NOT_STARTED');
    expect(empty.release).toBe('NOT_STARTED');
    expect(empty.running).toBe('— · NOT_STARTED');
    expect(empty.tests).not.toMatch(/0\/0/);
    expect(empty.release).not.toMatch(/1\.\d+/);
    expect(empty.running).not.toMatch(/1\.\d+/);
    expect(empty.why).not.toMatch(/GPS|originating|because/i);

    const filled = bind({
      taxonomy: 'BUG',
      title: 'תיקון נחיתה',
      target_area: 'LANDING',
      description: 'כישלון בנחיתה אוטומטית',
      notes: 'מהטיסה האחרונה',
      status: 'TESTING',
      agent: { state: 'SUCCEEDED' },
      tests: { state: 'PASSED', passed: 12, failed: 0, result: 'ok' },
      release: { state: 'READY', version: '1.02.255', release_id: 'rel-1' },
      deployment: { state: 'DEPLOYED', running_version: '1.02.255', result: 'ok' },
    });
    expect(filled.what).toBe('BUG · תיקון נחיתה · LANDING');
    expect(filled.why).toBe('כישלון בנחיתה אוטומטית · מהטיסה האחרונה');
    expect(filled.state).toBe('TESTING · SUCCEEDED');
    expect(filled.tests).toBe('PASSED · 12/0 · ok');
    expect(filled.release).toBe('READY · 1.02.255 · rel-1');
    expect(filled.running).toBe('1.02.255 · DEPLOYED · ok');

    const noTask = bind(null);
    expect(noTask.what).toBe('—');
    expect(noTask.why).toBe('—');
    expect(noTask.state).toBe('NOT_STARTED');
    expect(noTask.tests).toBe('NOT_STARTED');
    expect(noTask.release).toBe('NOT_STARTED');
    expect(noTask.running).toBe('NOT_STARTED');
  });

  it('refreshes the strip from the existing detail render path', () => {
    const render = sliceFunction(js, 'devRenderTaskDetail');
    expect(render).toContain('devBindEvidenceStrip(task)');
    const refreshTests = sliceFunction(js, 'devRefreshTests');
    expect(refreshTests).toContain('devRenderTaskDetail(r.data.task)');
    const refreshAgent = sliceFunction(js, 'devRefreshAgentState');
    expect(refreshAgent).toContain('devRenderTaskDetail(r.data.task)');
    expect(js).toMatch(/function devDeployRelease[\s\S]*devRenderTaskDetail\(r\.data\.task\)/);
    expect(js).toMatch(/function devCreateRelease[\s\S]*devRenderTaskDetail\(r\.data\.task\)/);
  });
});
