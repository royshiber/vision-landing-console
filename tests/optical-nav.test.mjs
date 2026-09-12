import { describe, expect, it } from 'vitest';
import {
  NAV_DISPLAY_GPS,
  NAV_DISPLAY_OPTICAL,
  OPTICAL_NAV_ALT_CEILING_M,
  emptyOpticalNav,
  normalizeOpticalNav,
  opticalNavHasFix,
  opticalNavStatusHe,
  resolveNavDisplayPreference,
  selectDisplayFix,
} from '../lib/optical-nav.mjs';
import { mapCompanionStatus } from '../lib/companion-status.mjs';
import {
  healthyCompanionStatus,
  disconnectedCompanionStatus,
  degradedCompanionStatus,
  opticalNavStub,
} from '../lib/companion-mock-fixtures.mjs';

describe('optical-nav honesty', () => {
  it('never invents WGS84 from NED or empty stubs', () => {
    const empty = normalizeOpticalNav(null);
    expect(empty.lat).toBeNull();
    expect(empty.lon).toBeNull();
    expect(empty.position).toBeNull();
    expect(empty.velocity).toBeNull();
    expect(empty.camera_ok).toBe(false);
    expect(empty.running).toBe(false);
    expect(empty.ekf_injected).toBe(false);
    expect(empty.display_only).toBe(true);
    expect(empty.alt_ceiling_m).toBe(OPTICAL_NAV_ALT_CEILING_M);
    expect(opticalNavHasFix(empty)).toBe(false);

    const fromNed = normalizeOpticalNav({
      present: true,
      running: true,
      camera_ok: true,
      position_m: [1.2, -0.4, 8.1],
      velocity_m_s: [0.1, 0, -0.2],
    });
    expect(fromNed.lat).toBeNull();
    expect(fromNed.lon).toBeNull();
    expect(fromNed.position).toBeNull();
    expect(opticalNavHasFix(fromNed)).toBe(false);
  });

  it('accepts a real WGS84 only when cameras and estimator are reported', () => {
    const nav = normalizeOpticalNav({
      present: true,
      running: true,
      camera_ok: true,
      position: { lat: 32.08, lon: 34.78, alt_m: 120 },
      confidence: 0.81,
      age_ms: 140,
    });
    expect(nav.lat).toBe(32.08);
    expect(nav.lon).toBe(34.78);
    expect(nav.position).toEqual({ lat: 32.08, lon: 34.78, alt_m: 120 });
    expect(opticalNavHasFix(nav)).toBe(true);

    const camerasOff = normalizeOpticalNav({
      running: true,
      camera_ok: false,
      position: { lat: 32.08, lon: 34.78 },
    });
    expect(camerasOff.lat).toBe(32.08);
    expect(opticalNavHasFix(camerasOff)).toBe(false);
  });

  it('optical display pick stays -- without a real optical fix', () => {
    const gps = { lat: 32.1, lon: 34.8 };
    const none = selectDisplayFix({ preference: NAV_DISPLAY_OPTICAL, gps, optical: emptyOpticalNav() });
    expect(none.source).toBeNull();
    expect(none.lat).toBeNull();
    expect(none.lon).toBeNull();
    expect(none.opticalAvailable).toBe(false);

    const gpsPick = selectDisplayFix({ preference: NAV_DISPLAY_GPS, gps, optical: emptyOpticalNav() });
    expect(gpsPick.source).toBe(NAV_DISPLAY_GPS);
    expect(gpsPick.lat).toBe(32.1);
    expect(gpsPick.lon).toBe(34.8);

    expect(resolveNavDisplayPreference('optical')).toBe(NAV_DISPLAY_OPTICAL);
    expect(resolveNavDisplayPreference('nope')).toBe(NAV_DISPLAY_GPS);
  });

  it('status Hebrew stays -- when cameras or estimator are absent', () => {
    expect(opticalNavStatusHe(null).text).toBe('--');
    expect(opticalNavStatusHe(emptyOpticalNav()).text).toBe('--');
    expect(opticalNavStatusHe(emptyOpticalNav()).title).toContain('אין מצלמה');
    const runningNoFix = normalizeOpticalNav({ camera_ok: true, running: true });
    expect(opticalNavStatusHe(runningNoFix).text).toBe('--');
    expect(opticalNavStatusHe(runningNoFix).title).toContain('אין מיקום');
  });

  it('maps companion fixtures without inventing optical lat/lon or EKF inject', () => {
    const healthy = mapCompanionStatus(healthyCompanionStatus());
    expect(healthy.opticalNav.present).toBe(true);
    expect(healthy.opticalNav.running).toBe(true);
    expect(healthy.opticalNav.camera_ok).toBe(true);
    expect(healthy.opticalNav.lat).toBeNull();
    expect(healthy.opticalNav.lon).toBeNull();
    expect(healthy.opticalNav.ekf_injected).toBe(false);
    expect(healthy.opticalNav.display_only).toBe(true);
    expect(healthy.opticalNav.alt_ceiling_m).toBe(300);
    expect(healthy.compatibility.vision.navLat).toBeNull();
    expect(healthy.compatibility.vision.navLon).toBeNull();

    const down = mapCompanionStatus(disconnectedCompanionStatus());
    expect(down.opticalNav.camera_ok).toBe(false);
    expect(down.opticalNav.running).toBe(false);
    expect(down.opticalNav.position).toBeNull();

    const degraded = mapCompanionStatus(degradedCompanionStatus());
    expect(degraded.opticalNav.camera_ok).toBe(false);
    expect(degraded.opticalNav.position).toBeNull();
    expect(opticalNavStub().position).toBeNull();
  });
});
