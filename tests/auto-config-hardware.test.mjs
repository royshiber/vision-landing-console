/**
 * Hardware-intent model for the Configuration Wizard.
 * Each card answers: what is connected, where it is wired, what to expect.
 */
import { describe, it, expect } from 'vitest';
import {
  getHardwareIntent,
  listHardwareIntentComponents,
  validateHardwareIntent,
} from '../lib/auto-config-hardware.mjs';
import { listComponentTypes } from '../lib/auto-config-recipes.mjs';

describe('listHardwareIntentComponents', () => {
  const walk = listHardwareIntentComponents();

  it('returns a small realistic AIRVIX walk', () => {
    expect(walk.length).toBeGreaterThanOrEqual(4);
    expect(walk.length).toBeLessThanOrEqual(8);
  });

  it('includes GPS with 3D fix and a pin-level FC target', () => {
    const gps = walk.find((c) => c.id === 'GPS');
    expect(gps).toBeTruthy();
    expect(gps.expected.token).toBe('3D fix');
    expect(gps.wiring.fc.port).toBe('GPS');
    expect(gps.wiring.fc.pins).toEqual(expect.arrayContaining(['GPS', 'CAN']));
    expect(gps.wiring.jetson).toBeNull();
  });

  it('includes companion link on FC and Jetson ports', () => {
    const link = walk.find((c) => c.id === 'CompanionLink');
    expect(link).toBeTruthy();
    expect(link.connected.modelHe).toBe('Jetson');
    expect(link.wiring.fc.port).toBe('TELEM2');
    expect(link.wiring.jetson.port).toBe('UART1');
    expect(link.wiring.jetson.pins).toEqual(expect.arrayContaining(['UART1', 'ttyTHS1']));
    expect(link.expected.token).toBe('heartbeat');
    expect(link.wiring.jetson.hostHe).toBe('מחשב משימה');
  });

  it('includes radio, landing camera, and receiver', () => {
    const ids = walk.map((c) => c.id);
    expect(ids).toContain('TelemetryRadio');
    expect(ids).toContain('LandingCamera');
    expect(ids).toContain('Receiver');
    expect(walk.find((c) => c.id === 'TelemetryRadio')?.expected.token).toBe('telemetry stream');
    expect(walk.find((c) => c.id === 'LandingCamera')?.expected.token).toBe('vision estimate');
    expect(walk.find((c) => c.id === 'LandingCamera')?.wiring.jetson.port).toBe('CSI1');
  });

  it('every card answers the three locked questions', () => {
    for (const c of walk) {
      const checked = validateHardwareIntent(c);
      expect(checked.ok, checked.error).toBe(true);
      expect(c.connected.titleHe.length).toBeGreaterThan(0);
      expect(c.wiring.fc || c.wiring.jetson).toBeTruthy();
      expect(c.expected.token.length).toBeGreaterThan(0);
    }
  });

  it('never uses forbidden companion or assist labels', () => {
    const blob = JSON.stringify(walk);
    expect(blob).not.toContain('מסייע');
    expect(blob).not.toContain('מלווה');
  });

  it('keeps FC and Jetson as distinct hosts', () => {
    const link = getHardwareIntent('CompanionLink');
    expect(link.wiring.fc.host).toBe('fc');
    expect(link.wiring.jetson.host).toBe('jetson');
    expect(link.wiring.fc.hostHe).not.toBe(link.wiring.jetson.hostHe);
  });
});

describe('listComponentTypes hardware-intent merge', () => {
  it('still lists GPS and Receiver and attaches intent when present', () => {
    const types = listComponentTypes();
    const ids = types.map((t) => t.id);
    expect(ids).toContain('GPS');
    expect(ids).toContain('Receiver');
    const gps = types.find((t) => t.id === 'GPS');
    expect(gps.hardwareIntent?.expected.token).toBe('3D fix');
  });
});
