import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_OFF_HE,
  LINK_DOWN_HE,
  LOCKED_HE,
  NO_REPLY_HE,
  UNLOCKED_HE,
  gimbalMoveBody,
  gimbalPadView,
  gimbalStopBody,
  gimbalZoomBody,
} from '../public/modules/gimbal-pad.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const mod = fs.readFileSync(path.join(root, 'public/modules/gimbal-pad.mjs'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

const live = {
  reachable: true,
  mode: 'real',
  health: { gimbal: { present: true, error: null, mode: 'follow', control_enabled: true } },
};

describe('gimbal pad state', () => {
  it('disables the pad when the link is down', () => {
    expect(gimbalPadView(null)).toMatchObject({ enabled: false, reasonHe: LINK_DOWN_HE, locked: false });
    expect(gimbalPadView({ reachable: false, mode: 'real' })).toMatchObject({
      enabled: false,
      reasonHe: LINK_DOWN_HE,
    });
    expect(gimbalPadView({ reachable: true, mode: 'off', health: live.health })).toMatchObject({
      enabled: false,
      reasonHe: LINK_DOWN_HE,
    });
  });

  it('disables the pad when the gimbal does not reply', () => {
    const view = gimbalPadView({
      reachable: true,
      mode: 'real',
      health: { gimbal: { present: false, error: 'no_reply', mode: null } },
    });
    expect(view).toMatchObject({ enabled: false, reasonHe: NO_REPLY_HE, locked: false });
    expect(view.reasonHe).not.toMatch(/\.env|docs\/|ARM|DISARM/);
  });

  it('shows locked and unlocked in Hebrew when the gimbal replies', () => {
    expect(gimbalPadView(live)).toMatchObject({ enabled: true, reasonHe: '', locked: false });
    expect(gimbalPadView({
      ...live,
      health: { gimbal: { ...live.health.gimbal, mode: 'lock' } },
    })).toMatchObject({ enabled: true, locked: true });
    expect(LOCKED_HE).toBe('נעול');
    expect(UNLOCKED_HE).toBe('משוחרר');
    expect(gimbalPadView({
      ...live,
      health: { gimbal: { ...live.health.gimbal, control_enabled: false } },
    })).toMatchObject({ enabled: false, reasonHe: CONTROL_OFF_HE });
  });

  it('maps hold to speed and zoom, and release to stop', () => {
    expect(gimbalMoveBody('up')).toEqual({ yaw: 0, pitch: 40 });
    expect(gimbalMoveBody('down')).toEqual({ yaw: 0, pitch: -40 });
    expect(gimbalMoveBody('left')).toEqual({ yaw: -40, pitch: 0 });
    expect(gimbalMoveBody('right')).toEqual({ yaw: 40, pitch: 0 });
    expect(gimbalStopBody()).toEqual({ yaw: 0, pitch: 0 });
    expect(gimbalZoomBody('in')).toEqual({ zoom: 1 });
    expect(gimbalZoomBody('out')).toEqual({ zoom: -1 });
    expect(gimbalZoomBody('stop')).toEqual({ zoom: 0 });
  });

  it('places the pad on the cameras view and stops on release or blur', () => {
    const panel = html.slice(html.indexOf('id="debriefRecordingsPanel"'), html.indexOf('id="debriefLogsPanel"'));
    expect(panel).toContain('id="gimbalPad"');
    for (const dir of ['up', 'down', 'left', 'right', 'zoom-in', 'zoom-out', 'lock']) {
      expect(panel).toContain(`data-gimbal="${dir}"`);
    }
    expect(panel).toContain('משוחרר');
    expect(mod).toContain("addEventListener('pointerup', release)");
    expect(mod).toContain("addEventListener('blur', release)");
    expect(mod).toContain('/api/jetson/v1/gimbal/rate');
    expect(mod).toContain('/api/jetson/v1/gimbal/zoom');
    expect(mod).toContain("/api/jetson/v1/gimbal/mode");
    expect(mod).toContain("mode: next");
    expect(mod).toContain("'lock'");
    expect(mod).toContain("'follow'");
    expect(mod).not.toMatch(/ARM|DISARM|\/land|flight command/i);
    expect(css).toMatch(/\.gimbal-pad-btn \{[\s\S]*font-size:\s*clamp\(11px/);
    expect(css).toContain('.gimbal-pad-lock[aria-pressed="true"]');
  });
});
