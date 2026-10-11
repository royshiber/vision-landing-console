import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { remoteUpdateCheckPaused } from '../lib/qa-mode.mjs';

describe('QA mode', () => {
  it('does not boot the GitHub update check during QA or tests', () => {
    expect(remoteUpdateCheckPaused({ VLC_QA: '1' })).toBe(true);
    expect(remoteUpdateCheckPaused({ VITEST: 'true' })).toBe(true);
    expect(remoteUpdateCheckPaused({ VLC_TEST: 'yes' })).toBe(true);
    expect(remoteUpdateCheckPaused({})).toBe(false);
    const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(server).toContain('if (!remoteUpdateCheckPaused()) updateService.start()');
  });
});
