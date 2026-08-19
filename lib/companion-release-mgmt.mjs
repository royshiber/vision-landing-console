/**
 * Jetson release-management wire → Console UI mapping.
 * Wire schema is source of truth — no invented filesystem paths or shell fields.
 */

export const DEPLOY_STATES = Object.freeze([
  'IDLE',
  'VERIFYING',
  'BACKING_UP',
  'ACTIVATING',
  'RESTARTING',
  'HEALTH_CHECK',
  'SUCCEEDED',
  'FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
]);

export const DEPLOY_STATE_LABELS_HE = Object.freeze({
  IDLE: 'ממתין',
  VERIFYING: 'מאמת',
  BACKING_UP: 'גיבוי',
  ACTIVATING: 'מפעיל גרסה',
  RESTARTING: 'מאתחל תהליך',
  HEALTH_CHECK: 'בדיקת תקינות',
  SUCCEEDED: 'הצליח',
  FAILED: 'נכשל',
  ROLLING_BACK: 'משחזר גרסה קודמת',
  ROLLED_BACK: 'שוחזר אוטומטית',
});

export const RELEASE_STATUS_DEPLOYABLE = Object.freeze(['VERIFIED', 'AVAILABLE']);

/** Fields that must never appear in deploy/rollback POST bodies from the browser. */
export const FORBIDDEN_DEPLOY_BODY_KEYS = Object.freeze([
  'path',
  'url',
  'command',
  'shell',
  'script',
  'sudo',
  'systemd',
  'service',
  'git',
  'exec',
  'argv',
  'cwd',
  'file',
  'directory',
  'release_path',
  'artifact_path',
  'artifact_url',
]);

/**
 * @param {unknown} releaseId
 * @returns {{ release_id: string }}
 */
export function buildDeployPayload(releaseId) {
  const id = String(releaseId || '').trim();
  if (!id) throw new Error('release_id is required');
  return { release_id: id };
}

/**
 * @param {unknown} body
 * @returns {{ release_id: string }}
 */
export function sanitizeDeployPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('deploy body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_DEPLOY_BODY_KEYS.includes(key.toLowerCase())) {
      throw new Error(`forbidden deploy field: ${key}`);
    }
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'release_id') {
    throw new Error('deploy body must contain only release_id');
  }
  return buildDeployPayload(body.release_id);
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isDeployableReleaseStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  return RELEASE_STATUS_DEPLOYABLE.includes(s);
}

/**
 * @param {unknown} state
 * @returns {string|null}
 */
export function formatDeployStateLabel(state) {
  const key = String(state || '').trim().toUpperCase();
  if (!key) return null;
  return DEPLOY_STATE_LABELS_HE[key] ?? key;
}

/**
 * Derive operator-facing activation message. Never claim running process changed
 * unless the wire response explicitly proves it.
 *
 * @param {object|null|undefined} wire
 * @returns {string|null}
 */
export function formatActivationMessage(wire) {
  if (!wire || typeof wire !== 'object') return null;
  if (typeof wire.message === 'string' && wire.message.trim()) return wire.message.trim();
  const state = String(wire.state || wire.deploy_state || '').trim().toUpperCase();
  if (state === 'SUCCEEDED') {
    if (wire.running_process_changed === true) {
      const rv = wire.running_version ?? wire.active_release?.version ?? null;
      return rv ? `Deployment successful (running ${rv})` : 'Deployment successful';
    }
    return 'Deployment completed without runtime confirmation';
  }
  if (state === 'ROLLED_BACK') {
    const reason = wire.failure_reason ? ` (${wire.failure_reason})` : '';
    return `Deployment failed — previous version restored${reason}`;
  }
  if (state === 'FAILED') {
    return wire.failure_reason || 'Deployment failed';
  }
  return null;
}

/**
 * Strict success criteria for C8.3.4 real deploy.
 * @param {object|null|undefined} wire
 * @param {string|null|undefined} requestedReleaseId
 * @returns {{ok:boolean,message:string,runningVersion:string|null,state:string|null}}
 */
export function evaluateDeployOutcome(wire, requestedReleaseId) {
  const state = String(wire?.state || wire?.deploy_state || '').trim().toUpperCase() || null;
  const runningVersion = wire?.running_version == null ? null : String(wire.running_version);
  if (state === 'ROLLED_BACK') {
    const reason = wire?.failure_reason ? ` (${wire.failure_reason})` : '';
    return {
      ok: false,
      state,
      runningVersion,
      message: `Deployment failed — previous version restored${reason}`,
    };
  }
  if (state === 'FAILED') {
    return {
      ok: false,
      state,
      runningVersion,
      message: wire?.failure_reason || 'Deployment failed',
    };
  }
  const requestedOk = requestedReleaseId
    ? (String(wire?.release_id || wire?.requested_release_id || '').trim() === String(requestedReleaseId))
    : true;
  const runningChanged = wire?.running_process_changed === true;
  const healthOk = wire?.health_check_ok === true || wire?.health_ok === true || wire?.health === 'valid';
  const activeVersion = wire?.active_release?.version == null ? null : String(wire.active_release.version);
  const versionMatches = !!runningVersion && !!activeVersion && runningVersion === activeVersion;
  const finalSucceeded = state === 'SUCCEEDED';
  if (requestedOk && runningChanged && healthOk && versionMatches && finalSucceeded) {
    return { ok: true, state, runningVersion, message: 'Deployment successful' };
  }
  return {
    ok: false,
    state,
    runningVersion,
    message: wire?.message || 'Deployment did not reach verified running state',
  };
}

/**
 * @param {unknown} ts
 * @returns {string|null}
 */
export function formatReleaseTime(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'object' && ts.t_utc_ns != null && Number.isFinite(Number(ts.t_utc_ns))) {
    return new Date(Number(ts.t_utc_ns) / 1e6).toISOString();
  }
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return new Date(ts).toISOString();
  }
  return String(ts);
}

/**
 * @param {unknown} wire
 * @returns {boolean}
 */
export function isReleaseInventoryShape(wire) {
  return !!(wire && typeof wire === 'object' && wire.active);
}

/**
 * @param {unknown} entries
 * @returns {Array<object>}
 */
export function normalizeAuditEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return [...entries].sort((a, b) => {
    const au = a?.timestamp?.t_utc_ns ?? 0;
    const bu = b?.timestamp?.t_utc_ns ?? 0;
    if (bu !== au) return Number(bu) - Number(au);
    const am = a?.timestamp?.t_monotonic_ns ?? 0;
    const bm = b?.timestamp?.t_monotonic_ns ?? 0;
    return Number(bm) - Number(am);
  });
}

/**
 * @param {object|null|undefined} inventory
 */
export function mapReleaseInventoryForUi(inventory) {
  const inv = inventory && typeof inventory === 'object' ? inventory : {};
  const active = inv.active || null;
  const previous = inv.previous || null;
  const available = Array.isArray(inv.available) ? inv.available : [];
  const deployState = inv.deploy_state ?? 'IDLE';
  return {
    deployState,
    deployStateLabel: formatDeployStateLabel(deployState),
    active: active ? {
      releaseId: active.release_id ?? null,
      version: active.version ?? null,
      status: active.status ?? null,
    } : null,
    previous: previous ? {
      releaseId: previous.release_id ?? null,
      version: previous.version ?? null,
      status: previous.status ?? null,
    } : null,
    available: available.map((r) => ({
      releaseId: r.release_id ?? null,
      version: r.version ?? null,
      status: r.status ?? null,
      createdAt: formatReleaseTime(r.created_at ?? r.timestamp),
      compatibility: r.compatibility ?? null,
      sha256: r.sha256 ?? null,
      sizeBytes: r.size_bytes ?? r.size ?? null,
      deployable: isDeployableReleaseStatus(r.status),
    })),
    canRollback: !!(previous?.release_id),
  };
}

/**
 * @param {object|null|undefined} wire
 */
export function mapBackupsForUi(wire) {
  const list = Array.isArray(wire?.backups) ? wire.backups : Array.isArray(wire) ? wire : [];
  return list.map((b) => ({
    backupId: b.backup_id ?? null,
    createdAt: formatReleaseTime(b.created_at ?? b.timestamp),
    releaseId: b.release_id ?? null,
    sha256: b.sha256 ?? null,
  }));
}

/**
 * @param {object|null|undefined} wire
 */
export function mapAuditForUi(wire) {
  const entries = normalizeAuditEntries(wire?.entries ?? wire?.recent ?? wire);
  return entries.map((e) => ({
    time: formatReleaseTime(e.timestamp ?? e.created_at),
    operation: e.operation ?? null,
    releaseId: e.release_id ?? e.release ?? null,
    result: e.result ?? null,
    failureReason: e.failure_reason ?? null,
    activeReleaseId: e.active_release_id ?? e.active_release ?? null,
  }));
}

/**
 * @param {number|null|undefined} status
 * @param {object|null|undefined} body
 * @returns {string}
 */
export function formatMaintenanceApiError(status, body) {
  const msg = body?.message || body?.error || body?.failure_reason;
  if (status === 400) return msg || 'בקשה לא תקינה';
  if (status === 403) return msg || 'אין הרשאה';
  if (status === 404) return msg || 'לא נמצא';
  if (status === 409) return msg || 'קונפליקט — פעולה לא זמינה כעת';
  if (status === 501) return msg || 'לא נתמך ב-Jetson';
  if (status === 503 || status === 504) return msg || 'Companion לא זמין';
  return msg || 'שגיאה';
}
