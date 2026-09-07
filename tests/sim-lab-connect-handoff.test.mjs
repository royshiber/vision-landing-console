import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAssistRoute } from '../lib/assist/assist-routes.mjs';
import { resolveAssistIntent } from '../lib/assist/assist-intent-resolver.mjs';
import { hebrewOpenRouteAnswer } from '../lib/assist/assist-hebrew.mjs';
import {
  SITL_CONNECT_PRESETS,
  fallbackFillGlobalConnectFields,
  getConnectWidgetApi,
  handoffSitlConnect,
} from '../public/sitl-connect-handoff.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const simLab = fs.readFileSync(path.join(repoRoot, 'public', 'sim-lab.mjs'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

describe('SITL Lab connect handoff — shared path', () => {
  it('exposes one topbar connect API and Sim Lab drives it', () => {
    expect(appJs).toContain('window.__vlcConnectWidget');
    expect(appJs).toContain('function applySitlPreset');
    expect(appJs).toContain('function connectNow');
    expect(appJs).toMatch(/fetch\('\/api\/connections\/quick-connect'/);
    expect(simLab).toContain('handoffSitlConnect');
    expect(simLab).toContain('getConnectWidgetApi');
    expect(simLab).toContain('SITL_CONNECT_PRESETS');
    expect(simLab).not.toMatch(/\/api\/connections\/quick-connect/);
    expect(simLab).not.toMatch(/\/api\/connections\/auto-connect/);
  });

  it('keeps SITL wizard teaching steps and spoken-Hebrew topbar handoff', () => {
    expect(html).toContain('id="simLabConnectHandoffHint"');
    expect(html).toContain('אותו חיבור כמו בשורת המצב למעלה.');
    expect(html).toContain('חברו למעלה');
    expect(html).toContain('id="simLabWizard"');
    expect(html).toContain('data-step="1"');
    expect(html).toContain('הפעל SITL');
    expect(html).toContain('id="simLabQsUdp"');
    expect(html).toContain('id="simLabQsTcp"');
    expect(html).toContain('id="simLabQsUdpBind"');
    expect(html).toContain('id="simLabCopyCmd"');
    expect(html).toContain('id="simLabPresetUdp14550"');
    expect(html).toContain('id="connectWidget"');
    expect(html).toContain('id="connectBtn"');
    expect(html).toContain('id="connectAutoBtn"');
  });

  it('hands presets to the shared widget API instead of a second stack', () => {
    const calls = [];
    const api = {
      applySitlPreset(p) { calls.push(['apply', p]); },
      connectNow() { calls.push(['connect']); },
    };
    const udp = handoffSitlConnect(api, SITL_CONNECT_PRESETS.udp14550);
    expect(udp).toEqual({ ok: true, type: 'udp', hostPort: '127.0.0.1:14550' });
    const tcp = handoffSitlConnect(api, { ...SITL_CONNECT_PRESETS.tcp5760, connect: true });
    expect(tcp.ok).toBe(true);
    expect(handoffSitlConnect(null, SITL_CONNECT_PRESETS.udpBind).reason).toBe('missing-connect-widget');
    expect(handoffSitlConnect(api, { type: 'serial', hostPort: 'COM3' }).reason).toBe('invalid-preset');
    expect(calls).toEqual([
      ['apply', { type: 'udp', hostPort: '127.0.0.1:14550' }],
      ['connect'],
      ['apply', { type: 'tcp', hostPort: '127.0.0.1:5760' }],
      ['connect'],
    ]);
    expect(getConnectWidgetApi({ __vlcConnectWidget: api })).toBe(api);
    expect(getConnectWidgetApi({})).toBe(null);
  });

  it('falls back to the same #connectBtn path without inventing TCP/UDP logic', () => {
    const events = [];
    const typeSel = {
      value: '',
      dispatchEvent(ev) { events.push(ev.type); return true; },
    };
    const portInput = { value: '' };
    const connectBtn = {
      dataset: { connected: '0' },
      click() { events.push('connectBtn'); },
    };
    const out = fallbackFillGlobalConnectFields({
      typeSel,
      portInput,
      connectBtn,
      ...SITL_CONNECT_PRESETS.udpBind,
    });
    expect(out.via).toBe('connectBtn');
    expect(typeSel.value).toBe('udp');
    expect(portInput.value).toBe('0.0.0.0:14550');
    expect(events).toEqual(['change', 'connectBtn']);
  });

  it('does not click CONNECT when already connected', () => {
    let clicks = 0;
    fallbackFillGlobalConnectFields({
      connectBtn: { dataset: { connected: '1' }, click() { clicks += 1; } },
      ...SITL_CONNECT_PRESETS.tcp5760,
    });
    expect(clicks).toBe(0);
  });
});

describe('SITL Lab connect handoff — Assist route', () => {
  it('maps סימולציה and SITL to the existing lab tab', () => {
    expect(findAssistRoute('סימולציה')?.id).toBe('lab');
    expect(findAssistRoute('סימולציה')?.tab).toBe('simLab');
    expect(findAssistRoute('sitl')?.tab).toBe('simLab');
    expect(findAssistRoute('SITL')?.tab).toBe('simLab');
    expect(findAssistRoute('simulation')?.tab).toBe('simLab');
    expect(findAssistRoute('מעבדה')?.tab).toBe('simLab');
    expect(hebrewOpenRouteAnswer('lab')).toBe('פותחים את הסימולציה.');
  });

  it('opens Sim Lab from Assist without stealing development or flight intents', () => {
    const openHe = resolveAssistIntent('פתח סימולציה');
    expect(openHe.intent).toBe('UI_ACTION');
    expect(openHe.slots.route_id).toBe('lab');
    expect(resolveAssistIntent('sitl').slots.route_id).toBe('lab');
    expect(resolveAssistIntent('סימולציה').slots.route_id).toBe('lab');
    expect(resolveAssistIntent('Add a tab for landing confidence.').intent).toBe('DEVELOPMENT');
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
  });
});

describe('SITL Lab connect handoff — version pin', () => {
  it('pins APP_VERSION at 1.02.256', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.256'");
    expect(pkg.version).toBe('1.02.256');
  });
});
