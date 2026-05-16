#!/usr/bin/env node
/**
 * Why: install a pre-commit git hook that bumps APP_VERSION automatically,
 *      so no one needs to remember to bump by hand. Runs on every commit.
 *
 * What: writes .git/hooks/pre-commit with a small shell wrapper that calls
 *       `node scripts/bump-version.mjs --silent` and re-stages the touched files.
 *       Idempotent — safe to run multiple times. Only overwrites hooks created by
 *       this script (identified by a marker comment).
 *
 * Usage:
 *   node scripts/install-git-hooks.mjs
 *   node scripts/install-git-hooks.mjs --silent
 *   node scripts/install-git-hooks.mjs --uninstall
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');
const gitDir    = path.join(repoRoot, '.git');
const hooksDir  = path.join(gitDir, 'hooks');
const hookFile  = path.join(hooksDir, 'pre-commit');

const MARKER    = '# vision-landing-console:auto-bump-hook v1';

const silent     = process.argv.includes('--silent');
const uninstall  = process.argv.includes('--uninstall');
const log = (...a) => { if (!silent) console.log('[hooks]', ...a); };

const HOOK_BODY = `#!/bin/sh
${MARKER}
# Auto-bump APP_VERSION before each commit. See scripts/bump-version.mjs.

# Skip if the bump was just executed in this session (VLC_SKIP_BUMP env) — prevents
# loops when commits are triggered from other hooks.
if [ -n "$VLC_SKIP_BUMP" ]; then
  exit 0
fi

# Skip on merge commits to avoid double-bumping when merging branches.
if [ -f .git/MERGE_HEAD ] || [ -f .git/CHERRY_PICK_HEAD ]; then
  exit 0
fi

# Only bump when real source files are staged (skip docs-only / version-only commits).
STAGED=$(git diff --cached --name-only --diff-filter=ACMR | grep -vE '^(version\\.js|package\\.json|package-lock\\.json|public/changelog\\.json)$' || true)
if [ -z "$STAGED" ]; then
  exit 0
fi

node scripts/bump-version.mjs --silent || exit 1
git add version.js package.json package-lock.json public/changelog.json 2>/dev/null || true
exit 0
`;

try {
  if (!existsSync(gitDir)) {
    log('לא נמצא .git — מדלג (לא מאגר git).');
    process.exit(0);
  }
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  if (uninstall) {
    if (existsSync(hookFile)) {
      const current = readFileSync(hookFile, 'utf8');
      if (current.includes(MARKER)) { unlinkSync(hookFile); log('הוסר pre-commit hook.'); }
      else log('pre-commit לא נוצר ע"י סקריפט זה — לא נגעתי.');
    }
    process.exit(0);
  }

  if (existsSync(hookFile)) {
    const current = readFileSync(hookFile, 'utf8');
    if (!current.includes(MARKER)) {
      log('קיים pre-commit hook שנכתב ע"י כלי אחר — לא נדרס. הפעל עם --uninstall להסיר או העתק את התוכן ידנית.');
      process.exit(0);
    }
    if (current === HOOK_BODY) { log('ה-hook כבר מעודכן.'); process.exit(0); }
  }

  writeFileSync(hookFile, HOOK_BODY, { encoding: 'utf8' });
  try { chmodSync(hookFile, 0o755); } catch { /* Windows */ }
  log(`הותקן pre-commit hook ב-${hookFile}`);
  if (!silent) console.log('✓ בכל commit הגרסה תעלה אוטומטית ב-patch.');
} catch (err) {
  console.error('[hooks] שגיאה:', err.message);
  process.exit(0); // Don't fail postinstall on hook errors.
}
