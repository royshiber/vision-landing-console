/**
 * Jetson maintenance wire → Console UI mapping.
 * Wire schema is source of truth — no invented Jetson fields.
 */

export const MAINTENANCE_RECENT_MAX = 10;

export const MAINT_HEALTH_VALUES = Object.freeze(['unavailable', 'degraded', 'valid']);

export const MAINT_HEALTH_LABELS_HE = Object.freeze({
  valid: 'תקין',
  degraded: 'חלקי',
  unavailable: 'לא זמין',
});

export const MAINT_UI_LABELS = Object.freeze({
  gitCleanTrue: 'נקי',
  gitCleanFalse: 'dirty',
  gitCleanUnknown: 'לא ידוע',
  unavailable: 'לא זמין',
  apiRunningTrue: 'פעיל',
  apiRunningFalse: 'לא פעיל',
  reachableTrue: 'כן',
  reachableFalse: 'לא',
});

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatMaintPercent(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `${n}%`;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatHealthLabel(v) {
  const key = String(v || '').trim().toLowerCase();
  if (!key) return null;
  return MAINT_HEALTH_LABELS_HE[key] ?? key;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatGitClean(v) {
  if (v === true) return MAINT_UI_LABELS.gitCleanTrue;
  if (v === false) return MAINT_UI_LABELS.gitCleanFalse;
  if (v === null || v === undefined) return MAINT_UI_LABELS.gitCleanUnknown;
  return null;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatChangedFilesCount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function formatApiRunning(v) {
  if (v === true) return MAINT_UI_LABELS.apiRunningTrue;
  if (v === false) return MAINT_UI_LABELS.apiRunningFalse;
  return null;
}

/**
 * @param {unknown} ts
 * @returns {string|null}
 */
export function formatMaintEventTime(ts) {
  if (!ts || typeof ts !== 'object') return null;
  const utcNs = ts.t_utc_ns;
  if (utcNs != null && Number.isFinite(Number(utcNs))) {
    return new Date(Number(utcNs) / 1e6).toISOString();
  }
  const monoNs = ts.t_monotonic_ns;
  if (monoNs != null && Number.isFinite(Number(monoNs))) {
    return `#${Number(monoNs)}`;
  }
  return null;
}

/**
 * Preserve Jetson order; cap at MAINTENANCE_RECENT_MAX.
 * @param {unknown} recent
 * @returns {Array<object>}
 */
export function normalizeMaintenanceRecent(recent) {
  if (!Array.isArray(recent)) return [];
  return recent.slice(0, MAINTENANCE_RECENT_MAX);
}

/**
 * @param {unknown} wire
 * @returns {boolean}
 */
export function isMaintenanceWireShape(wire) {
  return !!(wire && typeof wire === 'object' && wire.software && wire.system && wire.companion);
}

/**
 * Map Jetson maintenance wire payload to UI display values.
 * Console-local fields are passed via opts — never mixed into wire.
 *
 * @param {object|null|undefined} wire
 * @param {{ uiVersion?: string|null, companionMode?: string|null, apiReachable?: boolean|null }} [opts]
 */
export function mapMaintenanceForUi(wire, opts = {}) {
  const sw = wire?.software || {};
  const sys = wire?.system || {};
  const comp = wire?.companion || {};
  const recent = normalizeMaintenanceRecent(wire?.diagnostics?.recent);

  const ramUsed = sys.ram_used_mb;
  const ramTotal = sys.ram_total_mb;
  let mem = null;
  if (ramUsed != null && ramTotal != null) {
    mem = `${ramUsed}/${ramTotal} MB`;
  } else if (ramUsed != null) {
    mem = `${ramUsed} MB`;
  }

  let status = 'unavailable';
  if (opts.apiReachable === false) {
    status = 'unavailable';
  } else if (comp.api_running === true) {
    status = 'ok';
  } else if (comp.api_running === false) {
    status = 'degraded';
  } else if (wire) {
    status = 'degraded';
  }

  return {
    status,
    uiVersion: opts.uiVersion ?? null,
    companionMode: opts.companionMode ?? null,
    apiReachable: opts.apiReachable ?? null,
    companionVersion: sw.companion_version ?? null,
    apiVersion: comp.api_version ?? null,
    apiRunning: comp.api_running ?? null,
    gitCommit: sw.git_commit ? String(sw.git_commit).slice(0, 7) : sw.git_commit ?? null,
    gitBranch: sw.git_branch ?? null,
    gitClean: sw.git_clean ?? null,
    gitCleanLabel: formatGitClean(sw.git_clean),
    changedFilesCount: sw.changed_files_count ?? null,
    changedFilesLabel: formatChangedFilesCount(sw.changed_files_count),
    cpu: formatMaintPercent(sys.cpu_percent),
    mem,
    gpu: formatMaintPercent(sys.gpu_percent),
    temperature: sys.temperature_c != null ? `${sys.temperature_c}°` : null,
    disk: formatMaintPercent(sys.disk_used_percent),
    apiRunningLabel: formatApiRunning(comp.api_running),
    apiReachableLabel:
      opts.apiReachable === true
        ? MAINT_UI_LABELS.reachableTrue
        : opts.apiReachable === false
          ? MAINT_UI_LABELS.reachableFalse
          : null,
    diagnosticsRecent: recent.map((ev) => ({
      time: formatMaintEventTime(ev.timestamp) || '—',
      health: ev.health ?? null,
      healthLabel: formatHealthLabel(ev.health),
      subsystem: ev.subsystem ?? null,
      message: ev.message ?? null,
    })),
  };
}
