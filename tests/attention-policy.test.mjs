import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

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

function loadPolicyLogic(store = {}) {
  const localStorage = {
    getItem(key) { return store[key] ?? null; },
    setItem(key, value) { store[key] = String(value); },
  };
  const src = [
    'const ATTENTION_POLICY_KEY = "visionLandingAttentionPolicyV1";',
    'const ATTENTION_POLICY_LEVELS = Object.freeze(["off", "attention", "critical"]);',
    sliceFunction(js, 'attentionPolicyDefaults'),
    sliceFunction(js, 'attentionNormalizePolicy'),
    sliceFunction(js, 'attentionReadPolicy'),
    sliceFunction(js, 'attentionWritePolicy'),
    sliceFunction(js, 'attentionItemLevel'),
    sliceFunction(js, 'attentionPolicyNotices'),
    sliceFunction(js, 'attentionHighestNoticedLevel'),
    sliceFunction(js, 'attentionShouldShowAssistBadge'),
    sliceFunction(js, 'attentionBadgeLabelHe'),
    sliceFunction(js, 'attentionMayChime'),
    sliceFunction(js, 'attentionMaySpeak'),
    sliceFunction(js, 'pulseBuildAttention'),
    `return {
      attentionPolicyDefaults,
      attentionNormalizePolicy,
      attentionReadPolicy,
      attentionWritePolicy,
      attentionItemLevel,
      attentionPolicyNotices,
      attentionHighestNoticedLevel,
      attentionShouldShowAssistBadge,
      attentionBadgeLabelHe,
      attentionMayChime,
      attentionMaySpeak,
      pulseBuildAttention,
    };`,
  ].join('\n');
  return new Function('localStorage', src)(localStorage);
}

describe('C10.7a Attention Policy', () => {
  it('defaults to quiet off and ignores unknown levels', () => {
    const logic = loadPolicyLogic();
    expect(logic.attentionPolicyDefaults()).toEqual({
      proactiveLevel: 'off',
      showAssistBadge: true,
    });
    expect(logic.attentionNormalizePolicy(null)).toEqual({
      proactiveLevel: 'off',
      showAssistBadge: true,
    });
    expect(logic.attentionNormalizePolicy({ proactiveLevel: 'chatty' })).toEqual({
      proactiveLevel: 'off',
      showAssistBadge: true,
    });
    expect(logic.attentionNormalizePolicy({
      proactiveLevel: 'critical',
      showAssistBadge: false,
    })).toEqual({
      proactiveLevel: 'critical',
      showAssistBadge: false,
    });
    expect(logic.attentionReadPolicy()).toEqual({
      proactiveLevel: 'off',
      showAssistBadge: true,
    });
  });

  it('persists the v1 policy shape only', () => {
    const store = {};
    const logic = loadPolicyLogic(store);
    const saved = logic.attentionWritePolicy({
      proactiveLevel: 'attention',
      showAssistBadge: false,
      extra: 'nope',
    });
    expect(saved).toEqual({
      proactiveLevel: 'attention',
      showAssistBadge: false,
    });
    expect(JSON.parse(store.visionLandingAttentionPolicyV1)).toEqual({
      proactiveLevel: 'attention',
      showAssistBadge: false,
    });
    expect(store.visionLandingAttentionPolicyV1).not.toMatch(/eleven|stt|api[_-]?key/i);
  });

  it('maps Pulse items and stays quiet unless policy allows a notice', () => {
    const logic = loadPolicyLogic();
    expect(logic.pulseBuildAttention({
      companionLive: false,
      assistConnected: false,
      evolveActive: false,
    })).toEqual([]);
    const items = [
      { id: 'companion', level: 'attention', text: 'Jetson מנותק' },
      { id: 'assist', level: 'info', text: 'AIRVIX Ask מנותק' },
    ];
    const quiet = logic.attentionPolicyDefaults();
    expect(logic.attentionShouldShowAssistBadge(quiet, items)).toBe(false);
    expect(logic.attentionHighestNoticedLevel(quiet, items)).toBeNull();
    expect(logic.attentionPolicyNotices({ proactiveLevel: 'attention' }, 'info')).toBe(false);
    expect(logic.attentionPolicyNotices({ proactiveLevel: 'attention' }, 'attention')).toBe(true);
    expect(logic.attentionPolicyNotices({ proactiveLevel: 'critical' }, 'attention')).toBe(false);
    expect(logic.attentionPolicyNotices({ proactiveLevel: 'critical' }, 'critical')).toBe(true);
    expect(logic.attentionShouldShowAssistBadge({
      proactiveLevel: 'attention',
      showAssistBadge: true,
    }, items)).toBe(true);
    expect(logic.attentionShouldShowAssistBadge({
      proactiveLevel: 'attention',
      showAssistBadge: false,
    }, items)).toBe(false);
    expect(logic.attentionShouldShowAssistBadge({
      proactiveLevel: 'critical',
      showAssistBadge: true,
    }, items)).toBe(false);
    expect(logic.attentionBadgeLabelHe('attention')).toBe('שימו לב');
    expect(logic.attentionBadgeLabelHe('critical')).toBe('דחוף');
  });

  it('never chimes or auto-speaks in this slice', () => {
    const logic = loadPolicyLogic();
    expect(logic.attentionMayChime()).toBe(false);
    expect(logic.attentionMaySpeak()).toBe(false);
    const refresh = sliceFunction(js, 'pulseRefresh');
    const assistChrome = sliceFunction(js, 'attentionSyncAssistChrome');
    const settings = sliceFunction(js, 'initAttentionPolicyControls');
    const write = sliceFunction(js, 'attentionWritePolicy');
    const combined = [refresh, assistChrome, settings, write].join('\n');
    expect(combined).not.toMatch(/speechSynthesis|elevenlabs|\/tts|new Audio|chime/i);
    expect(combined).not.toMatch(/attentionMayChime\(|attentionMaySpeak\(/);
    expect(combined).not.toMatch(/ELEVENLABS_|FE_STT_|CURSOR_API_KEY|JETSON_COMPANION/);
  });

  it('folds controls into the existing gear and Assist chrome', () => {
    expect(html).toMatch(/id="gsAttentionPolicy"/);
    expect(html).toMatch(/id="gsAttentionTitle"[^>]*>התערבות</);
    expect(html).toMatch(/data-attention-level="off"[^>]*>שקט</);
    expect(html).toMatch(/data-attention-level="attention"[^>]*>שימו לב</);
    expect(html).toMatch(/data-attention-level="critical"[^>]*>רק דחוף</);
    expect(html).toMatch(/id="gsAttentionBadge"/);
    expect(html).toMatch(/נקודה ב-AIRVIX Ask/);
    expect(html).toMatch(/id="assistAttentionDot"/);
    expect(html).toMatch(/id="assistAttentionBadge"/);
    expect(html).toContain('id="gsElevenVoice"');
    expect(html).toContain('id="gsSttLang"');
    expect(css).toMatch(/\.gs-attention-btn\b/);
    expect(css).toMatch(/\.assist-attention-dot\b/);
    expect(css).toMatch(/\.assist-attention-badge\b/);
    expect(js).toContain("ATTENTION_POLICY_KEY = 'visionLandingAttentionPolicyV1'");
    expect(js).toContain("proactiveLevel: 'off'");
    expect(version).toContain("export const APP_VERSION = '1.02.281'");
    expect(pkg.version).toBe('1.02.281');
  });
});
