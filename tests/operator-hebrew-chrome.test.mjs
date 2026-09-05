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

function innerText(markup) {
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

const PARKED_OR_LIVE_ENGLISH = [
  'Git commit',
  'Git branch',
  'Git clean',
  'Vision Confidence',
  'Auto Abort',
  'Loop Closures',
  'CPU Load',
  'Companion API',
  'גרסת Companion',
  'מצב Console',
  '>GPU<',
  '>MOCK<',
  '<th>SHA256</th>',
  'התקן / Rollback',
  'גרסה להתקנה / Rollback',
];

describe('Operator Hebrew leftover chrome', () => {
  it('replaces parked-visible telemetry English labels', () => {
    expect(html).toContain('ביטחון ראייה');
    expect(html).toContain('ביטול אוטומטי');
    expect(html).toContain('סגירות לולאה');
    expect(html).toContain('עומס מעבד');
    expect(html).toContain('ממשק מלווה');
    expect(html).toContain('גרסת מלווה');
    expect(html).not.toContain('Vision Confidence');
    expect(html).not.toContain('Auto Abort');
    expect(html).not.toContain('Loop Closures');
    expect(html).not.toContain('CPU Load');
    expect(html).not.toContain('Companion API');
  });

  it('replaces Maintenance live-wall Git / GPU / MOCK / SHA chrome', () => {
    const maint = capture(
      html,
      /<section\b[^>]*\bid="maintenance"[^>]*>([\s\S]*?)<\/section>\s*<section\b[^>]*\bid="development"/,
      'missing #maintenance panel',
    )[1];
    expect(maint).toContain('<span>קומיט</span>');
    expect(maint).toContain('<span>ענף</span>');
    expect(maint).toContain('<span>עץ נקי</span>');
    expect(maint).toContain('<span>מעבד גרפי</span>');
    expect(maint).toContain('<h4 class="maint-group-title">מלווה</h4>');
    expect(maint).toContain('<span>מצב מסוף</span>');
    expect(maint).toContain('>מדומה<');
    expect(maint).toContain('<th>חתימה</th>');
    expect(maint).not.toContain('Git commit');
    expect(maint).not.toContain('Git branch');
    expect(maint).not.toContain('Git clean');
    expect(maint).not.toContain('<span>GPU</span>');
    expect(maint).not.toContain('>MOCK<');
    expect(maint).not.toContain('<th>SHA256</th>');
    expect(maint).not.toContain('מצב Console');
  });

  it('does not keep leftover English phrases in parked or live operator chrome', () => {
    for (const leftover of PARKED_OR_LIVE_ENGLISH) {
      expect(html.includes(leftover), `leftover chrome: ${leftover}`).toBe(false);
    }
  });

  it('maps git-clean false and companion mode to Hebrew values', () => {
    const git = sliceFunction(js, 'maintFmtGitClean');
    expect(git).toContain("'נקי'");
    expect(git).toContain("'עם שינויים'");
    expect(git).not.toMatch(/return 'dirty'/);

    const mode = sliceFunction(js, 'companionModeText');
    expect(mode).toContain("mock: 'מדומה'");
    expect(mode).toContain("real: 'אמיתי'");
    expect(mode).toContain("off: 'כבוי'");
  });

  it('keeps deploy / rollback / backup operator results in Hebrew', () => {
    const known = sliceFunction(js, 'maintRelHeKnownMessage');
    expect(known).toContain("'ההתקנה הצליחה'");
    expect(known).toContain("'ההתקנה נכשלה'");
    expect(known).toContain("'השחזור הושלם'");
    expect(known).toContain("'הגיבוי נכשל'");
    expect(known).toContain("'פעולת תחזוקה אחרת כבר רצה'");

    const activate = sliceFunction(js, 'maintRelActivationMessage');
    expect(activate).toContain('ההתקנה הצליחה');
    expect(activate).not.toMatch(/return 'Deployment successful'/);
    expect(activate).not.toMatch(/return 'Deployment failed'/);

    const deploy = sliceFunction(js, 'maintRelExecuteDeploy');
    expect(deploy).toContain('ההתקנה הצליחה. גרסה רצה:');
    expect(deploy).toContain('ההתקנה נכשלה');
    expect(deploy).not.toMatch(/Deployment successful \|/);
    expect(deploy).not.toMatch(/Deploy failed/);

    const rollback = sliceFunction(js, 'maintRelExecuteRollback');
    expect(rollback).toContain('השחזור הושלם');
    expect(rollback).not.toMatch(/Rollback completed/);
    expect(rollback).not.toMatch(/Rollback failed/);

    const backup = sliceFunction(js, 'maintRelExecuteBackup');
    expect(backup).toContain('גיבוי הצליח. מזהה:');
    expect(backup).not.toMatch(/Backup failed/);

    const confirm = sliceFunction(js, 'maintRelOpenDeployConfirm');
    expect(confirm).toContain('חתימה:');
    expect(confirm).not.toMatch(/SHA256:/);

    const load = sliceFunction(js, 'maintRelLoadAll');
    expect(load).toContain('מצב מדומה. פעולות קבועות בלי מנוע התקנה אמיתי');
    expect(load).not.toMatch(/מצב MOCK/);
  });

  it('does not add apply, restart, flight-command, or token-invent paths', () => {
    const chrome = [
      sliceFunction(js, 'companionModeText'),
      sliceFunction(js, 'maintFmtGitClean'),
      sliceFunction(js, 'maintRelHeKnownMessage'),
      sliceFunction(js, 'maintRelActivationMessage'),
    ].join('\n');
    expect(chrome).not.toMatch(/\/apply|\/restart|ARM|DISARM|LAND|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });

  it('keeps development worktree clean values in Hebrew when a task exists', () => {
    expect(js).toMatch(/task\.worktree_meta\.clean \? 'נקי' : 'עם שינויים'/);
    expect(js).not.toMatch(/task\.worktree_meta\.clean \? 'CLEAN' : 'DIRTY'/);
    expect(innerText(capture(html, /<article class="tele-card"><span>חתימה<\/span><strong id="devReleaseSha256">/, 'missing release hash label')[0])).toContain('חתימה');
  });
});
