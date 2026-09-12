import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_VERSION } from '../version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const versionSrc = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');

describe('index.html cache-bust always matches version.js', () => {
  it('uses __APP_VERSION__ placeholders and never pins app.js to 1.02.273', () => {
    expect(versionSrc).toContain(`export const APP_VERSION = '${APP_VERSION}'`);
    expect(html).toContain('src="./app.js?v=__APP_VERSION__"');
    expect(html).toContain('content="__APP_VERSION__"');
    expect(html).not.toMatch(/app\.js\?v=1\.02\.273/);
    expect(html).not.toMatch(/app\.js\?v=\d+\.\d+\.\d+/);
    const rendered = html.replace(/__APP_VERSION__/g, APP_VERSION);
    expect(rendered).toContain(`app.js?v=${APP_VERSION}`);
    expect(rendered).toContain(`content="${APP_VERSION}"`);
    expect(rendered).not.toContain('__APP_VERSION__');
  });

  it('server injects getAppVersion() and does not serve raw static index.html', () => {
    expect(server).toMatch(/raw\.replace\(\/__APP_VERSION__\/g,\s*runtimeVersion\)/);
    expect(server).toMatch(/const runtimeVersion = getAppVersion\(\)/);
    expect(server).toMatch(/Cache-Control',\s*'no-store/);
    expect(server).toContain("express.static(path.join(__dirname, 'public'), { index: false })");
    expect(server).toMatch(/app\.get\(\['\/', '\/index\.html'\]/);
  });

  it('shows a banner when app.js query or meta lags /api/meta (no silent stale tab)', () => {
    expect(js).toContain('function syncHtmlCacheBustToServerVersion');
    expect(js).toContain('function readLoadedAppJsQueryVersion');
    expect(js).toContain('function showAppVersionMismatchBanner');
    expect(js).toContain("fetch('/api/meta', { cache: 'no-store' })");
    expect(js).toContain('app.js?v=');
    expect(html).toContain('id="appVersionMismatchBanner"');
    expect(html).toContain('id="appVersionMismatchReload"');
    expect(js).not.toContain('vlc.html-version-reload');
  });
});

describe('SSE boot identifiers are declared before use (no TDZ)', () => {
  it('declares assistPendingProposalId, terrainMap, latestJetsonFromServer at the top with var', () => {
    const head = js.slice(0, js.indexOf('function initGlobalViewportScaleGuard'));
    expect(head).toMatch(/var latestJetsonFromServer = null;/);
    expect(head).toMatch(/var terrainMap = null;/);
    expect(head).toMatch(/var assistPendingProposalId = null;/);
    expect(head).toMatch(/var lastSseTerrainPayload = null;/);
    const start = js.indexOf('(function startSseStream()');
    expect(start).toBeGreaterThan(head.length);
  });

  it('does not redeclare those names with let later in the classic script', () => {
    expect(js).not.toMatch(/\blet latestJetsonFromServer\b/);
    expect(js).not.toMatch(/\blet terrainMap\b/);
    expect(js).not.toMatch(/\blet assistPendingProposalId\b/);
    expect(js).not.toMatch(/\blet _assistPendingProposalId\b/);
    expect(js).not.toMatch(/\blet lastSseTerrainPayload\b/);
  });

  it('opens EventSource only after the script finishes parsing, and never swallows apply errors', () => {
    const marker = '(function startSseStream()';
    const start = js.indexOf(marker);
    const end = js.indexOf('})();', start);
    const boot = js.slice(start, end);
    expect(boot).toContain('queueMicrotask(boot)');
    expect(boot).toContain("new EventSource('/api/stream')");
    expect(boot).toMatch(/console\.warn\('SSE telemetry apply failed'/);
    expect(boot).not.toMatch(/catch \{\s*\}/);
  });
});
