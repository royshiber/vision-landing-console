import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function developmentTasksJs() {
  const start = js.indexOf('/* ── Development Tasks (C9.1)');
  const end = js.indexOf('/* ── ASSIST (C10.2)');
  expect(start, 'missing Development Tasks section').toBeGreaterThanOrEqual(0);
  expect(end, 'missing ASSIST section after Development Tasks').toBeGreaterThan(start);
  return js.slice(start, end);
}

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

const ENGLISH_LEFTOVERS = [
  'ALL</option>',
  'failed to load task detail',
  'failed to load tasks',
  'failed to refresh agent',
  'failed to start agent',
  'failed to refresh tests',
  'failed to cancel tests',
  'failed to approve for release',
  'failed to create release',
  'failed to deploy release',
  'failed to cancel agent',
  'worktree creation failed',
  'test run failed to start',
  'task creation failed',
  'task update failed',
  'Start development agent?',
  'Create isolated worktree?',
  'Run approved test profile',
  'Cancel active test run?',
  'Approve task for release readiness?',
  'Create release artifact from tested task worktree?',
  'Deploy this release via maintenance pipeline?',
  'Cancel development agent session?',
  'Development agent started',
  'Development agent cancelled',
  'Worktree created',
  'Tests started (',
  'Test run cancelled',
  'Task approved for release',
  'Release ready:',
  'Deploy result:',
  'Task created:',
  'Task updated',
  'Provider cancellation is not supported',
];

describe('Development Tasks Hebrew leftover copy', () => {
  it('keeps filter value="" and shows הכל instead of ALL', () => {
    const fill = sliceFunction(js, 'devFillOptions');
    expect(fill).toContain('<option value="">הכל</option>');
    expect(fill).not.toContain('<option value="">ALL</option>');
    expect(fill).toMatch(/if \(includeAll\) opt\.push\('<option value="">הכל<\/option>'\)/);

    const statusOpt = capture(
      html,
      /<select\b[^>]*\bid="devTaskFilterStatus"[^>]*>\s*<option value="">([^<]*)<\/option>/,
      'missing #devTaskFilterStatus ALL option',
    );
    const targetOpt = capture(
      html,
      /<select\b[^>]*\bid="devTaskFilterTarget"[^>]*>\s*<option value="">([^<]*)<\/option>/,
      'missing #devTaskFilterTarget ALL option',
    );
    expect(statusOpt[1]).toBe('הכל');
    expect(targetOpt[1]).toBe('הכל');
  });

  it('does not keep leftover English user-visible strings in the Development Tasks flow', () => {
    const devJs = developmentTasksJs();
    for (const leftover of ENGLISH_LEFTOVERS) {
      expect(devJs.includes(leftover), `leftover English: ${leftover}`).toBe(false);
    }
    expect(html).not.toMatch(/id="devTaskFilterStatus"[^>]*>[\s\S]*?<option value="">ALL<\/option>/);
    expect(html).not.toMatch(/id="devTaskFilterTarget"[^>]*>[\s\S]*?<option value="">ALL<\/option>/);
  });

  it('uses Hebrew confirm prompts for start / worktree / tests / release / deploy / cancel', () => {
    const start = sliceFunction(js, 'devStartDevelopment');
    expect(start).toContain('להפעיל סוכן פיתוח?');
    expect(start).toContain('כותרת:');
    expect(start).toContain('תיאור:');
    expect(start).toContain('יעד:');
    expect(start).toContain('עדיפות:');
    expect(start).toContain('אזהרה:');
    expect(start).toContain('ענף:');
    expect(start).toContain('worktree:');
    expect(start).not.toMatch(/Start development agent\?/);
    expect(start).toContain('סוכן הפיתוח הופעל');
    expect(start).toContain('הפעלת סוכן הפיתוח נכשלה');

    const worktree = sliceFunction(js, 'devCreateWorktree');
    expect(worktree).toContain('ליצור worktree מבודד?');
    expect(worktree).not.toMatch(/Create isolated worktree\?/);
    expect(worktree).toContain('יצירת worktree נכשלה');
    expect(worktree).toContain('worktree נוצר');

    const runTests = sliceFunction(js, 'devRunTests');
    expect(runTests).toContain('להריץ פרופיל בדיקות מאושר');
    expect(runTests).not.toMatch(/Run approved test profile/);
    expect(runTests).toContain('הרצת הבדיקות נכשלה');
    expect(runTests).toContain('הבדיקות הופעלו —');

    const cancelTests = sliceFunction(js, 'devCancelTests');
    expect(cancelTests).toContain('לבטל את הרצת הבדיקות הפעילה?');
    expect(cancelTests).not.toMatch(/Cancel active test run\?/);
    expect(cancelTests).toContain('ביטול הרצת הבדיקות נכשל');
    expect(cancelTests).toContain('הרצת הבדיקות בוטלה');

    const approve = sliceFunction(js, 'devApproveForRelease');
    expect(approve).toContain('לאשר את המשימה למוכנות גרסה?');
    expect(approve).not.toMatch(/Approve task for release readiness\?/);
    expect(approve).toContain('אישור המשימה לגרסה נכשל');
    expect(approve).toContain('המשימה אושרה לגרסה');

    const createRelease = sliceFunction(js, 'devCreateRelease');
    expect(createRelease).toContain('ליצור קובץ גרסה מ-worktree המשימה שנבדק?');
    expect(createRelease).not.toMatch(/Create release artifact from tested task worktree\?/);
    expect(createRelease).toContain('יצירת הגרסה נכשלה');
    expect(createRelease).toContain('הגרסה מוכנה:');

    const deploy = sliceFunction(js, 'devDeployRelease');
    expect(deploy).toContain('להתקין את הגרסה דרך צינור התחזוקה?');
    expect(deploy).not.toMatch(/Deploy this release via maintenance pipeline\?/);
    expect(deploy).toContain('התקנת הגרסה נכשלה');
    expect(deploy).toContain('תוצאת התקנה:');

    const cancelAgent = sliceFunction(js, 'devCancelAgent');
    expect(cancelAgent).toContain('לבטל את סשן סוכן הפיתוח?');
    expect(cancelAgent).not.toMatch(/Cancel development agent session\?/);
    expect(cancelAgent).toContain('ביטול אצל הספק אינו נתמך');
    expect(cancelAgent).toContain('ביטול סוכן הפיתוח נכשל');
    expect(cancelAgent).toContain('סוכן הפיתוח בוטל');
  });

  it('uses Hebrew fallback load / create / update error and success copy', () => {
    const loadDetail = sliceFunction(js, 'devLoadTaskDetail');
    expect(loadDetail).toContain('טעינת פרטי המשימה נכשלה');
    expect(loadDetail).not.toMatch(/failed to load task detail/);

    const loadList = sliceFunction(js, 'devTasksLoadList');
    expect(loadList).toContain('טעינת המשימות נכשלה');
    expect(loadList).not.toMatch(/failed to load tasks/);

    const create = sliceFunction(js, 'devCreateTask');
    expect(create).toContain('יצירת המשימה נכשלה');
    expect(create).toContain('המשימה נוצרה:');
    expect(create).not.toMatch(/task creation failed/);
    expect(create).not.toMatch(/Task created:/);

    const save = sliceFunction(js, 'devSaveTaskChanges');
    expect(save).toContain('עדכון המשימה נכשל');
    expect(save).toContain('המשימה עודכנה');
    expect(save).not.toMatch(/task update failed/);
    expect(save).not.toMatch(/Task updated/);

    const provider = sliceFunction(js, 'devFormatAgentProvider');
    expect(provider).toContain('סוכן הפיתוח אינו זמין');
    expect(provider).not.toMatch(/Development agent unavailable'/);
  });

  it('keeps filter / profile / status enum values as the API contract', () => {
    const fill = sliceFunction(js, 'devFillOptions');
    expect(fill).toContain('value=""');
    expect(fill).toMatch(/<option value="\$\{v\}">\$\{v\}<\/option>/);

    const runTests = sliceFunction(js, 'devRunTests');
    expect(runTests).toContain("'DEVELOPMENT'");
    expect(runTests).toMatch(/body: JSON\.stringify\(\{ confirm: true, profile \}\)/);

    const start = sliceFunction(js, 'devStartDevelopment');
    expect(start).toMatch(/body: JSON\.stringify\(\{ confirm: true \}\)/);
  });
});
