import { describe, it, expect, beforeEach } from 'vitest';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { maintenanceForScenario } from '../lib/companion-mock-fixtures.mjs';
import {
  MAINTENANCE_RECENT_MAX,
  MAINT_HEALTH_VALUES,
  formatGitClean,
  formatHealthLabel,
  formatMaintPercent,
  mapMaintenanceForUi,
  normalizeMaintenanceRecent,
  isMaintenanceWireShape,
} from '../lib/companion-maintenance.mjs';

const REAL_JETSON_SAMPLE = {
  timestamp: { t_monotonic_ns: 9001, t_utc_ns: 1_700_000_000_000_000_000 },
  software: {
    companion_version: '1.0.2-jetson',
    git_commit: 'deadbeef1234567890',
    git_branch: 'main',
    git_clean: null,
    changed_files_count: null,
  },
  system: {
    cpu_percent: null,
    ram_used_mb: 4200,
    ram_total_mb: 8000,
    gpu_percent: null,
    temperature_c: 48.5,
    disk_used_percent: 31,
  },
  companion: {
    api_version: '1',
    api_running: true,
  },
  diagnostics: {
    recent: [
      {
        timestamp: { t_monotonic_ns: 9002, t_utc_ns: 1_700_000_000_001_000_000 },
        health: 'valid',
        subsystem: 'api',
        message: 'Companion started',
      },
      {
        timestamp: { t_monotonic_ns: 9003, t_utc_ns: null },
        health: 'degraded',
        subsystem: 'vision',
        message: 'Camera frame rate low',
      },
    ],
  },
};

describe('Maintenance wire schema (C8.1.6 / C8.1.8)', () => {
  let mock;
  beforeEach(() => {
    mock = createCompanionMock();
  });

  it('mock healthy matches Jetson schema shape', async () => {
    const d = await mock.getMaintenance();
    expect(d.timestamp).toBeTruthy();
    expect(d.software).toMatchObject({
      companion_version: expect.any(String),
      git_commit: expect.any(String),
      git_branch: expect.any(String),
      git_clean: expect.any(Boolean),
      changed_files_count: expect.any(Number),
    });
    expect(d.software).not.toHaveProperty('ui_version');
    expect(d.software).not.toHaveProperty('api_version');
    expect(d.companion).toEqual({ api_version: '1', api_running: true });
    expect(d.companion).not.toHaveProperty('api_reachable');
    expect(d.diagnostics).toHaveProperty('recent');
    expect(d).not.toHaveProperty('diagnostics_events');
    for (const ev of d.diagnostics.recent) {
      expect(ev).toHaveProperty('health');
      expect(ev).not.toHaveProperty('severity');
      expect(MAINT_HEALTH_VALUES).toContain(ev.health);
    }
  });

  it('mock degraded uses health not severity', async () => {
    mock.setScenario('degraded');
    const d = await mock.getMaintenance();
    expect(d.diagnostics.recent.some((e) => e.health === 'degraded')).toBe(true);
    for (const ev of d.diagnostics.recent) {
      expect(ev).not.toHaveProperty('severity');
    }
  });

  it('mock disconnected has empty recent diagnostics', async () => {
    mock.setScenario('disconnected');
    const d = await mock.getMaintenance();
    expect(d.diagnostics.recent).toEqual([]);
  });

  it('maintenanceForScenario fixtures use health enum', () => {
    const h = maintenanceForScenario('healthy');
    const g = maintenanceForScenario('degraded');
    expect(h.diagnostics.recent.every((e) => e.health === 'valid')).toBe(true);
    expect(g.diagnostics.recent.some((e) => e.health === 'degraded')).toBe(true);
  });
});

describe('mapMaintenanceForUi — real Jetson response with health', () => {
  it('maps health field to display labels', () => {
    expect(isMaintenanceWireShape(REAL_JETSON_SAMPLE)).toBe(true);
    const ui = mapMaintenanceForUi(REAL_JETSON_SAMPLE, {
      uiVersion: '1.02.400',
      companionMode: 'real',
      apiReachable: true,
    });
    expect(ui.diagnosticsRecent).toHaveLength(2);
    expect(ui.diagnosticsRecent[0].health).toBe('valid');
    expect(ui.diagnosticsRecent[0].healthLabel).toBe('תקין');
    expect(ui.diagnosticsRecent[1].health).toBe('degraded');
    expect(ui.diagnosticsRecent[1].healthLabel).toBe('חלקי');
    expect(ui.diagnosticsRecent[0]).not.toHaveProperty('severity');
  });

  it('null cpu/gpu never become zero in labels', () => {
    const ui = mapMaintenanceForUi(REAL_JETSON_SAMPLE, { apiReachable: true });
    expect(ui.cpu).toBeNull();
    expect(ui.gpu).toBeNull();
  });

  it('missing diagnostics.recent is safe', () => {
    const wire = { ...REAL_JETSON_SAMPLE, diagnostics: {} };
    const ui = mapMaintenanceForUi(wire, { apiReachable: true });
    expect(ui.diagnosticsRecent).toEqual([]);
  });

  it('null diagnostics is safe', () => {
    const wire = { ...REAL_JETSON_SAMPLE, diagnostics: null };
    const ui = mapMaintenanceForUi(wire, { apiReachable: true });
    expect(ui.diagnosticsRecent).toEqual([]);
  });
});

describe('formatHealthLabel', () => {
  it('maps HealthState enum to Hebrew', () => {
    expect(formatHealthLabel('valid')).toBe('תקין');
    expect(formatHealthLabel('degraded')).toBe('חלקי');
    expect(formatHealthLabel('unavailable')).toBe('לא זמין');
  });

  it('does not require severity', () => {
    expect(formatHealthLabel(null)).toBeNull();
    expect(formatHealthLabel('')).toBeNull();
  });
});

describe('null Git state display', () => {
  it('formatGitClean null → unknown label', () => {
    expect(formatGitClean(null)).toBe('לא ידוע');
  });
});

describe('diagnostics.recent', () => {
  it('preserves order and caps at 10', () => {
    const recent = Array.from({ length: 15 }, (_, i) => ({
      timestamp: { t_monotonic_ns: i },
      health: 'valid',
      subsystem: 'api',
      message: `event-${i}`,
    }));
    const norm = normalizeMaintenanceRecent(recent);
    expect(norm).toHaveLength(MAINTENANCE_RECENT_MAX);
    expect(norm[0].message).toBe('event-0');
    expect(norm[9].message).toBe('event-9');
  });
});

describe('formatMaintPercent', () => {
  it('null stays null', () => {
    expect(formatMaintPercent(null)).toBeNull();
  });
});

describe('Maintenance API paths', () => {
  it('maintenance path is registered', async () => {
    const { COMPANION_V1_PATHS, COMPANION_READ_METHODS } = await import('../lib/companion-v1-paths.mjs');
    expect(COMPANION_V1_PATHS.maintenance).toBe('/api/v1/maintenance');
    expect(COMPANION_READ_METHODS).toContain('getMaintenance');
  });
});
