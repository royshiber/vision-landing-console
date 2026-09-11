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
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

describe('SITL connect handoff — shared connect widget only', () => {
  it('keeps one floating connect API and removes the Sim Lab UI', () => {
    expect(appJs).toContain('window.__vlcConnectWidget');
    expect(appJs).toContain('function applySitlPreset');
    expect(appJs).toContain('function connectNow');
    expect(appJs).toMatch(/fetch\('\/api\/connections\/quick-connect'/);
    expect(html).not.toContain('id="simLab"');
    expect(html).not.toContain('sim-lab.mjs');
    expect(html).toContain('id="connectWidget"');
    expect(html).toContain('id="connectBtn"');
    expect(html).toContain('id="connectAutoBtn"');
  });

  it('does not ship a Sim Lab wizard or PARAM_SET form', () => {
    expect(html).not.toContain('id="simLabConnectHandoffHint"');
    expect(html).not.toContain('id="simLabWizard"');
    expect(html).not.toContain('id="simLabParamSend"');
    expect(html).not.toContain('id="simLabRcSendToggle"');
    expect(html).not.toContain('id="simLabCanvas"');
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

describe('SITL connect handoff — no Assist lab route', () => {
  it('does not map סימולציה or מעבדה to a lab panel', () => {
    expect(findAssistRoute('סימולציה')).toBeNull();
    expect(findAssistRoute('sitl')).toBeNull();
    expect(findAssistRoute('SITL')).toBeNull();
    expect(findAssistRoute('simulation')).toBeNull();
    expect(findAssistRoute('מעבדה')).toBeNull();
    expect(findAssistRoute('lab')).toBeNull();
    expect(hebrewOpenRouteAnswer('lab')).not.toBe('פותחים את הסימולציה.');
  });

  it('does not open a lab panel from Assist speech', () => {
    expect(resolveAssistIntent('פתח סימולציה').slots?.route_id).not.toBe('lab');
    expect(resolveAssistIntent('sitl').slots?.route_id).not.toBe('lab');
    expect(resolveAssistIntent('סימולציה').slots?.route_id).not.toBe('lab');
    expect(resolveAssistIntent('Add a tab for landing confidence.').intent).toBe('DEVELOPMENT');
    expect(resolveAssistIntent('Change param LAND_SPEED to 5').prohibited).toBe(true);
  });
});

describe('SITL Lab connect handoff — version pin', () => {
  it('pins APP_VERSION at 1.02.271', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.271'");
    expect(pkg.version).toBe('1.02.271');
  });
});
