import { describe, expect, it } from 'vitest';
import { coerceArduTargetPatch } from '../lib/param-schema.mjs';
import {
  coercePeripheralWriteValue,
  listPeripheralWizardCatalog,
  wizardAssignment,
} from '../lib/fc-peripheral-wizard.mjs';

describe('FC peripheral wizard catalog', () => {
  it('lists the fixed-wing peripherals and a real GPS serial assignment', () => {
    const catalog = listPeripheralWizardCatalog();
    const ids = catalog.peripherals.map((item) => item.id);
    expect(ids).toEqual(['gps', 'airspeed', 'rangefinder', 'camera', 'telemetry', 'companion']);
    const gps = wizardAssignment('gps', 'serial3');
    expect(gps.whereLabelHe).toBe('SERIAL3');
    expect(gps.params.map((item) => [item.key, item.value])).toEqual([
      ['SERIAL3_PROTOCOL', 5],
      ['SERIAL3_BAUD', 115],
      ['GPS_TYPE', 1],
    ]);
    expect(wizardAssignment('camera', 'jetson').params.map((item) => item.key)).toEqual([
      'PLND_ENABLED',
      'PLND_TYPE',
    ]);
    expect(wizardAssignment('nope', 'serial1')).toBe(null);
  });

  it('accepts wizard values on the existing write validator and rejects garbage', () => {
    expect(coercePeripheralWriteValue('SERIAL3_PROTOCOL', 5)).toEqual({ ok: true, value: 5 });
    expect(coercePeripheralWriteValue('GPS_TYPE', 1)).toEqual({ ok: true, value: 1 });
    expect(coercePeripheralWriteValue('GPS_TYPE', 99)).toEqual({ ok: false, reason: 'invalid_enum' });
    expect(coercePeripheralWriteValue('NOT_A_PARAM', 1)).toBe(null);
    const patch = coerceArduTargetPatch({
      SERIAL3_PROTOCOL: 5,
      GPS_TYPE: 1,
      NOT_A_PARAM: 1,
    });
    expect(patch.accepted.SERIAL3_PROTOCOL).toBe(5);
    expect(patch.accepted.GPS_TYPE).toBe(1);
    expect(patch.rejected.NOT_A_PARAM).toBe('unknown_key');
  });
});
