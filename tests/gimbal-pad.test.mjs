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
  GIMBAL_PITCH_MAX,
  GIMBAL_PITCH_MIN,
  GIMBAL_YAW_MAX,
  GIMBAL_YAW_MIN,
  gimbalKeyAction,
  gimbalMoveBody,
  gimbalPadView,
  gimbalZoomBody,
  setGimbalMoveSpeed,
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

  it('steps absolute angle, raises the picture on up, and keeps zoom on its route', () => {
    setGimbalMoveSpeed(40);
    expect(gimbalMoveBody('up')).toEqual({ yaw: 0, pitch: -40 });
    expect(gimbalMoveBody('down')).toEqual({ yaw: 0, pitch: GIMBAL_PITCH_MAX });
    expect(gimbalMoveBody('left')).toEqual({ yaw: -40, pitch: 0 });
    expect(gimbalMoveBody('right')).toEqual({ yaw: 40, pitch: 0 });
    expect(gimbalMoveBody('up', { yaw: 40, pitch: -12 })).toEqual({ yaw: 40, pitch: -52 });
    expect(gimbalMoveBody('right', { yaw: 120, pitch: -12 })).toEqual({ yaw: GIMBAL_YAW_MAX, pitch: -12 });
    expect(gimbalMoveBody('left', { yaw: -120, pitch: 10 })).toEqual({ yaw: GIMBAL_YAW_MIN, pitch: 10 });
    expect(gimbalMoveBody('up', { yaw: 0, pitch: -80 })).toEqual({ yaw: 0, pitch: GIMBAL_PITCH_MIN });
    expect(gimbalMoveBody('down', { yaw: 0, pitch: 20 })).toEqual({ yaw: 0, pitch: GIMBAL_PITCH_MAX });
    setGimbalMoveSpeed(12);
    expect(gimbalMoveBody('up')).toEqual({ yaw: 0, pitch: -12 });
    setGimbalMoveSpeed(40);
    expect(gimbalZoomBody('in')).toEqual({ zoom: 1 });
    expect(gimbalZoomBody('out')).toEqual({ zoom: -1 });
    expect(gimbalZoomBody('stop')).toEqual({ zoom: 0 });
  });

  it('places the pad on the optics view and stops on release or blur', () => {
    const panel = html.slice(html.indexOf('id="optics"'), html.indexOf('id="recordings"'));
    expect(panel).toContain('id="gimbalPad"');
    for (const dir of ['up', 'down', 'left', 'right', 'center', 'zoom-in', 'zoom-out', 'lock']) {
      expect(panel).toContain(`data-gimbal="${dir}"`);
    }
    expect(panel).toContain('משוחרר');
    expect(panel).toContain('id="gimbalYaw"');
    expect(panel).toContain('id="gimbalZoomValue"');
    expect(mod).toContain("addEventListener('pointerup', release)");
    expect(mod).toContain("addEventListener('blur', release)");
    expect(mod).toContain('/api/jetson/v1/gimbal/angle');
    expect(mod).not.toContain('/api/jetson/v1/gimbal/rate');
    expect(mod).toContain('/api/jetson/v1/gimbal/zoom');
    expect(mod).toContain('/api/jetson/v1/gimbal/center');
    expect(mod).toContain("/api/jetson/v1/gimbal/mode");
    expect(mod).toContain('gimbalMoveBody(dir, aim)');
    expect(mod).toContain("held.startsWith('zoom')");
    expect(mod).not.toContain('gimbalStopBody');
    expect(mod).toContain('ArrowUp');
    expect(mod).toContain("getElementById('optics')");
    expect(mod).toContain("mode: next");
    expect(mod).toContain("'lock'");
    expect(mod).toContain("'follow'");
    expect(mod).not.toMatch(/ARM|DISARM|\/land|flight command/i);
    expect(css).toMatch(/\.gimbal-pad-btn \{[\s\S]*font-size:\s*clamp\(11px/);
    expect(css).toContain('.gimbal-pad-lock[aria-pressed="true"]');
  });

  it('maps arrow keys to motion and plus or minus to zoom', () => {
    expect(gimbalKeyAction('ArrowUp')).toEqual({ hold: 'up', kind: 'angle' });
    expect(gimbalKeyAction('ArrowLeft')).toEqual({ hold: 'left', kind: 'angle' });
    expect(gimbalKeyAction('+')).toEqual({ hold: 'zoom-in', kind: 'zoom' });
    expect(gimbalKeyAction('-')).toEqual({ hold: 'zoom-out', kind: 'zoom' });
    expect(gimbalKeyAction('a')).toBeNull();
  });

  it('keeps live angles when the gimbal answers and hides them when the link is down', () => {
    expect(gimbalPadView({
      reachable: true,
      mode: 'real',
      health: { gimbal: { present: true, mode: 'follow', control_enabled: true, attitude: { yaw: 12.34, pitch: -3 }, zoom: 2 } },
    })).toMatchObject({ enabled: true, yaw: 12.34, pitch: -3, zoom: 2 });
    expect(gimbalPadView(null)).toMatchObject({ yaw: null, pitch: null, zoom: null });
  });
});
