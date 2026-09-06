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

function sliceConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('});', start);
  expect(end, `unclosed const ${name}`).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

function loadRunCard() {
  const src = [
    sliceConst(js, 'ASSIST_AGENT_STATE_HE'),
    sliceConst(js, 'ASSIST_RUN_KICKER_HE'),
    sliceFunction(js, 'assistEscape'),
    sliceFunction(js, 'assistStatusKind'),
    sliceFunction(js, 'assistStatusOutcome'),
    sliceFunction(js, 'assistRunKicker'),
    sliceFunction(js, 'assistOperatorProgress'),
    sliceFunction(js, 'assistSafePrUrl'),
    sliceFunction(js, 'assistBuildStatusHtml'),
    `return {
      assistStatusKind,
      assistStatusOutcome,
      assistRunKicker,
      assistOperatorProgress,
      assistSafePrUrl,
      assistBuildStatusHtml,
    };`,
  ].join('\n');
  return new Function(src)();
}

describe('Assist connected run result card', () => {
  const card = loadRunCard();

  it('keeps NOT_STARTED and missing agent as unavailable, never a healthy run', () => {
    expect(card.assistStatusKind('NOT_STARTED', true, null)).toBe('unavailable');
    expect(card.assistStatusKind('RUNNING', false, null)).toBe('unavailable');
    expect(card.assistStatusKind('RUNNING', true, 'הסוכן מנותק.')).toBe('unavailable');
    expect(card.assistStatusKind('', true, null)).toBe('unavailable');
    expect(card.assistStatusKind('RUNNING', true, null)).toBe('run');
    expect(card.assistStatusKind('SUCCEEDED', true, null)).toBe('result');
  });

  it('renders a Hebrew running card with real branch/progress only', () => {
    const kind = card.assistStatusKind('RUNNING', true, null);
    const outcome = card.assistStatusOutcome('RUNNING', kind);
    const markup = card.assistBuildStatusHtml({
      headline: 'הסוכן רץ על הענף המבודד.',
      progress: 0.4,
      branch: 'development/tasks/landing-confidence',
      prUrl: null,
      outcome,
    });
    expect(outcome).toBe('running');
    expect(markup).toMatch(/class="assist-run-kicker">רץ</);
    expect(markup).toMatch(/הסוכן רץ על הענף המבודד/);
    expect(markup).toMatch(/ענף/);
    expect(markup).toMatch(/development\/tasks\/landing-confidence/);
    expect(markup).toMatch(/התקדמות/);
    expect(markup).toMatch(/40%/);
    expect(markup).toMatch(/id="assistRunDismissBtn">סגירה</);
    expect(markup).not.toMatch(/מזהה משימה/);
    expect(markup).not.toMatch(/הודעה אחרונה/);
    expect(markup).not.toMatch(/Analyzing task context/);
    expect(markup).not.toMatch(/פתיחת בקשה/);
  });

  it('renders a finished Hebrew card with an obvious PR action', () => {
    const kind = card.assistStatusKind('SUCCEEDED', true, null);
    const outcome = card.assistStatusOutcome('SUCCEEDED', kind);
    const markup = card.assistBuildStatusHtml({
      headline: 'הסוכן סיים על הענף המבודד.',
      progress: null,
      branch: 'development/tasks/landing-confidence',
      prUrl: 'https://example.invalid/development/pull/mock',
      outcome,
    });
    expect(outcome).toBe('succeeded');
    expect(markup).toMatch(/class="assist-run-kicker">הסתיים</);
    expect(markup).toMatch(/הסוכן סיים על הענף המבודד/);
    expect(markup).toMatch(/href="https:\/\/example\.invalid\/development\/pull\/mock"/);
    expect(markup).toMatch(/>פתיחת בקשה</);
    expect(markup).toMatch(/id="assistRunDismissBtn">סגירה</);
    expect(markup).not.toMatch(/התקדמות/);
    expect(markup).not.toMatch(/javascript:/i);
  });

  it('does not invent progress or accept a non-https PR link', () => {
    expect(card.assistOperatorProgress(null)).toBe(null);
    expect(card.assistOperatorProgress('Agent completed requested coding task')).toBe(null);
    expect(card.assistOperatorProgress(0.25)).toBe('25%');
    expect(card.assistSafePrUrl('javascript:alert(1)')).toBe(null);
    expect(card.assistSafePrUrl('http://example.invalid/x')).toBe(null);
    const failed = card.assistBuildStatusHtml({
      headline: 'הסוכן נכשל על הענף המבודד.',
      progress: 'Provider reported execution failure',
      branch: null,
      prUrl: 'javascript:alert(1)',
      outcome: 'failed',
    });
    expect(failed).toMatch(/class="assist-run-kicker">נכשל</);
    expect(failed).not.toMatch(/התקדמות/);
    expect(failed).not.toMatch(/פתיחת בקשה/);
    expect(failed).not.toMatch(/javascript:/i);
  });

  it('ships first-class card chrome instead of a debug dump', () => {
    expect(html).toMatch(/id="assistRunPanel"[^>]*data-kind="unavailable"/);
    expect(html).toMatch(/id="assistRunPanel"[^>]*aria-live="polite"/);
    expect(js).toMatch(/function assistClearRunPanel/);
    expect(js).toMatch(/assistRunDismissBtn/);
    expect(js).toMatch(/פתיחת בקשה/);
    expect(js).not.toMatch(/row\('מזהה משימה'/);
    expect(js).not.toMatch(/row\('הודעה אחרונה'/);
    expect(css).toMatch(/\.assist-run-kicker\b/);
    expect(css).toMatch(/\.assist-run-actions\b/);
    expect(css).toMatch(/\.assist-run-panel\[data-kind="unavailable"\]/);
    expect(css).toMatch(/\.assist-run-panel\[data-outcome="failed"\]/);
    expect(css).toMatch(/\.assist-messages:empty\b/);
  });
});
