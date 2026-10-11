import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteUpdateCheckPaused } from '../lib/qa-mode.mjs';
import { startTestServer } from './test-server.mjs';

describe('QA mode', () => {
  it('does not boot the GitHub update check during QA or tests', () => {
    expect(remoteUpdateCheckPaused({ VLC_QA: '1' })).toBe(true);
    expect(remoteUpdateCheckPaused({ VITEST: 'true' })).toBe(true);
    expect(remoteUpdateCheckPaused({ VLC_TEST: 'yes' })).toBe(true);
    expect(remoteUpdateCheckPaused({})).toBe(false);
    const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(server).toContain('if (!remoteUpdateCheckPaused()) updateService.start()');
    const update = readFileSync(new URL('../lib/app-update.mjs', import.meta.url), 'utf8');
    expect(update).toContain("state.error = 'skipped in QA mode'");
  });

  it('loads the page in QA mode without check() fetching GitHub', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vlc-qa-update-'));
    const logPath = path.join(dir, 'fetches.log');
    const hookPath = path.join(dir, 'fetch-hook.mjs');
    writeFileSync(hookPath, [
      "import { appendFileSync } from 'node:fs';",
      'const orig = globalThis.fetch;',
      'globalThis.fetch = function qaFetch(input, init) {',
      '  const url = typeof input === "string" ? input : (input && input.url) || String(input);',
      '  appendFileSync(process.env.VLC_FETCH_LOG, `${url}\\n`);',
      '  return orig.call(this, input, init);',
      '};',
      '',
    ].join('\n'));
    const started = await startTestServer({
      execArgv: ['--import', hookPath],
      unset: ['VITEST', 'VLC_TEST'],
      stdio: 'ignore',
      env: {
        VLC_QA: '1',
        VLC_FETCH_LOG: logPath,
        COMPANION_MODE: 'off',
        JETSON_COMPANION_BASE_URL: '',
        SQLITE_PATH: path.join(dir, 'qa.sqlite'),
      },
    });
    const proc = started.child;
    const base = started.base;
    let browser = null;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const refresh = page.waitForResponse(
        (res) => res.url().includes('/api/v1/update/status') && res.url().includes('refresh=1'),
        { timeout: 10000 },
      );
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      const response = await refresh;
      const body = await response.json();
      expect(body.error).toBe('skipped in QA mode');
      expect(body.lastChecked).toBeNull();
      const fetches = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      expect(fetches).not.toContain('raw.githubusercontent.com');
      expect(fetches).not.toContain('api.github.com');
    } finally {
      try { await browser?.close(); } catch { /* ignore */ }
      if (proc && !proc.killed) proc.kill('SIGTERM');
    }
  }, 30000);
});
