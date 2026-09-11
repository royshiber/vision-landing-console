import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function capture(src, re, label) {
  const m = src.match(re);
  expect(m, label).toBeTruthy();
  return m;
}

describe('AIRVIX 1.02.259 Roy feedback (still holds on 1.02.269)', () => {
  it('pins APP_VERSION at 1.02.269', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.269'");
    expect(pkg.version).toBe('1.02.269');
  });

  it('keeps Mission chrome and titles out of the instrument', () => {
    expect(css).toMatch(/\.mission-ops-chrome\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.mission-region-title\s*\{[^}]*position:\s*static/);
    expect(css).toMatch(/\.mission-region\s*\{[^}]*overflow:\s*hidden/);
    expect(html).toContain('id="missionAskDataBtn"');
    expect(html).toMatch(/id="missionAskDataBtn"[^>]*>שאלו על הנתונים</);
  });

  it('renames the Pulse tab to סטטוס מחשבים and keeps בית as an alias', () => {
    const chrome = capture(html, /<header class="app-chrome"[^>]*>([\s\S]*?)<\/header>/, 'missing app-chrome')[1];
    expect(chrome).toMatch(/data-tab="pulse"[^>]*>סטטוס מחשבים</);
    expect(chrome).not.toMatch(/>בית</);
    expect(html).toMatch(/id="pulse"[^>]*aria-label="סטטוס מחשבים"/);
    expect(findAssistRoute('סטטוס מחשבים')?.tab).toBe('pulse');
    expect(findAssistRoute('בית')?.tab).toBe('pulse');
  });

  it('makes the Assist microphone large and inviting', () => {
    expect(html).toMatch(/class="assist-mic-btn assist-mic-btn--invite"/);
    expect(html).toMatch(/class="assist-toggle-mic"/);
    expect(css).toMatch(/\.assist-mic-btn\s*\{[^}]*min-height:\s*56px/);
    expect(css).toMatch(/\.assist-toggle-btn\.assist-toggle-float\s*\{[^}]*min-height:\s*64px/);
    expect(css).toMatch(/\.assist-mic-icon \{ font-size: 1\.6rem/);
  });

  it('restyles leftover ops tabs into the dark AIRVIX language', () => {
    expect(css).toMatch(/body:has\(#control\.panel\.visible\),\s*body:has\(#development\.panel\.visible\)/);
    expect(css).toMatch(/#development\.panel\.visible \.devtasks-create/);
    expect(css).toMatch(/#maintenance\.panel\.visible:has\(#maintLiveSections\[hidden\]\)/);
    expect(css).toMatch(/#recordings\.panel\.visible \.events-list/);
    expect(html).not.toContain('Vision Landing Console');
  });

  it('does not add flight writes from the version offer or ask chip', () => {
    expect(js).toContain("action === 'jetson-version'");
    expect(js).toContain("getElementById('missionAskDataBtn')");
    expect(js).not.toMatch(/id="pulseJetsonUpdateBtn"[\s\S]{0,200}\/api\/jetson\/install/);
  });
});
