/**
 * Versions and rollback view for the ground console.
 * Unknown fields stay null. The UI prints אין מידע. Nothing here is invented.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { assessUpdateSafety } from './app-update.mjs';

export const UNKNOWN_HE = 'גרסה לא ידועה';
export const UNKNOWN_DATE_HE = 'תאריך לא ידוע';
export const NO_COMPANION_HE = 'אין קישור למחשב המשימה';
export const NO_CONSOLE_ROLLBACK_HE = 'אין גרסה קודמת לשחזור';
export const ARMED_HE = 'המטוס חמוש. אין שחזור.';
export const ROLLBACK_TIMEOUT_MS = 45000;
export const ROLLBACK_BLOCK_HE = Object.freeze({
  armed: ARMED_HE,
  in_flight: 'המטוס באוויר. אין שחזור.',
  unknown: 'מצב הטיסה לא ידוע. אין שחזור.',
  stale: 'מצב הטיסה ישן. אין שחזור.',
  missing: 'אין מצב טיסה ממחשב המשימה. אין שחזור.',
  busy: 'שחזור כבר מתבצע',
  timeout: 'השחזור לא הסתיים.',
});

export function rollbackBlockMessage(reason) {
  if (reason === 'armed') return ROLLBACK_BLOCK_HE.armed;
  if (reason === 'in_flight') return ROLLBACK_BLOCK_HE.in_flight;
  if (reason === 'unknown' || reason === 'unknown_connected') return ROLLBACK_BLOCK_HE.unknown;
  if (reason === 'stale') return ROLLBACK_BLOCK_HE.stale;
  if (reason === 'missing') return ROLLBACK_BLOCK_HE.missing;
  if (reason === 'busy') return ROLLBACK_BLOCK_HE.busy;
  return 'אין שחזור.';
}

const EMPTY_STATE = {
  console: { version: null, installedAt: null, previousVersion: null },
  knownGood: null,
  autoFlightId: null,
  rollback: { state: 'idle', kind: null, from: null, to: null, backupId: null, error: null, startedAt: null },
};

export function readVersionsState(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return structuredClone(EMPTY_STATE);
    return {
      ...structuredClone(EMPTY_STATE),
      ...parsed,
      console: { ...EMPTY_STATE.console, ...(parsed.console || {}) },
      rollback: { ...EMPTY_STATE.rollback, ...(parsed.rollback || {}) },
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

export function writeVersionsState(filePath, state) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function readVersionFile(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    const m = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Previous console build kept by the in-app updater, when that copy is on disk. */
export function findPreviousConsole(appRoot) {
  const parent = path.dirname(appRoot);
  const candidates = [
    path.join(parent, 'airvix-rollback', 'console', 'version.js'),
    path.join(parent, 'rollback', 'version.js'),
  ];
  for (const file of candidates) {
    const version = readVersionFile(file);
    if (version) return { available: true, version, versionFile: file };
  }
  return { available: false, version: null, versionFile: null };
}

export function noteConsoleVersion(state, version, nowIso) {
  const next = {
    ...state,
    console: { ...state.console },
  };
  if (!version) return next;
  if (next.console.version && next.console.version !== version) {
    next.console.previousVersion = next.console.version;
    next.console.installedAt = nowIso;
  }
  next.console.version = version;
  return next;
}

export function readLastFcParamSnapshotAt(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  const queries = [
    {
      table: 'param_snapshots',
      sql: `SELECT created_at AS at FROM param_snapshots WHERE target = 'fc' AND created_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    },
    {
      table: 'fc_param_snapshots',
      sql: `SELECT created_at AS at FROM fc_param_snapshots WHERE created_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    },
  ];
  for (const query of queries) {
    try {
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(query.table);
      if (!table) continue;
      const row = db.prepare(query.sql).get();
      const at = row?.at;
      if (typeof at === 'string' && at.trim()) return at.trim();
    } catch {
      /* table shape from an in-flight snapshot change — try the next source */
    }
  }
  return null;
}

export function findCleanEndedFlight(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const cols = db.prepare(`PRAGMA table_info(flights)`).all();
    const names = new Set(cols.map((col) => col?.name).filter(Boolean));
    if (!names.has('disarm_utc') || !names.has('errors') || !names.has('critical') || !names.has('id')) {
      return null;
    }
    const row = db.prepare(
      `SELECT id, disarm_utc, errors, critical
       FROM flights
       WHERE disarm_utc IS NOT NULL AND TRIM(disarm_utc) != ''
         AND errors = 0 AND critical = 0
       ORDER BY disarm_utc DESC
       LIMIT 1`,
    ).get();
    if (!row || row.id == null) return null;
    return { id: row.id, endedAt: row.disarm_utc };
  } catch {
    return null;
  }
}

export function markKnownGood(state, { consoleVersion, companionVersion, source, at, flightId = null }) {
  return {
    ...state,
    autoFlightId: source === 'flight' ? flightId : state.autoFlightId,
    knownGood: {
      at,
      source,
      consoleVersion: consoleVersion || null,
      companionVersion: companionVersion || null,
      flightId,
    },
  };
}

export function maybeAutoKnownGood(state, db, { consoleVersion, companionVersion, nowIso }) {
  if (!consoleVersion || !companionVersion) return { state, marked: false };
  const flight = findCleanEndedFlight(db);
  if (!flight) return { state, marked: false };
  if (String(state.autoFlightId) === String(flight.id)) return { state, marked: false };
  const sameCombo = state.knownGood
    && state.knownGood.consoleVersion === consoleVersion
    && state.knownGood.companionVersion === companionVersion
    && String(state.knownGood.flightId) === String(flight.id);
  if (sameCombo) return { state, marked: false };
  return {
    marked: true,
    state: markKnownGood(state, {
      consoleVersion,
      companionVersion,
      source: 'flight',
      at: nowIso,
      flightId: flight.id,
    }),
  };
}

export function mapCompanionVersions(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const backups = Array.isArray(payload.backups) ? payload.backups : [];
  return {
    linked: true,
    version: payload.version || null,
    deployedAt: payload.deployed_at || null,
    gitSha: payload.git_sha || null,
    knownGood: payload.known_good === true,
    backups: backups.map((row) => ({
      id: row?.id || null,
      version: row?.version || null,
      deployedAt: row?.deployed_at || null,
      gitSha: row?.git_sha || null,
      knownGood: row?.known_good === true,
    })).filter((row) => row.id),
    rollback: payload.rollback && typeof payload.rollback === 'object' ? payload.rollback : null,
  };
}

export function buildVersionsView({
  appVersion,
  state,
  previousConsole,
  companion,
  fcSnapshotAt,
}) {
  const consoleVersion = appVersion || state?.console?.version || null;
  const previous = previousConsole?.version || state?.console?.previousVersion || null;
  const rollbackAvailable = previousConsole?.available === true && !!previousConsole.version;
  return {
    ok: true,
    console: {
      version: consoleVersion,
      installedAt: state?.console?.installedAt || null,
      previousVersion: previous,
      rollbackAvailable,
      rollbackUnavailableReason: rollbackAvailable ? null : NO_CONSOLE_ROLLBACK_HE,
    },
    companion: companion?.linked
      ? companion
      : {
          linked: false,
          version: null,
          deployedAt: null,
          gitSha: null,
          knownGood: null,
          backups: [],
          rollback: null,
          message: NO_COMPANION_HE,
        },
    fcParams: { snapshotAt: fcSnapshotAt || null },
    knownGood: state?.knownGood || null,
    rollback: state?.rollback || EMPTY_STATE.rollback,
  };
}

export function assertRollbackConfirm(body, expected) {
  if (!body || body.confirm !== true) {
    return { ok: false, status: 400, message: 'נדרש אישור מפורש.' };
  }
  if (!expected?.from) {
    return { ok: false, status: 409, message: 'גרסה לא ידועה. אין שחזור.' };
  }
  const bodyTo = body.to == null || body.to === '' ? '' : String(body.to);
  const expectedTo = expected.to == null || expected.to === '' ? '' : String(expected.to);
  if (String(body.from || '') !== String(expected.from) || bodyTo !== expectedTo) {
    return { ok: false, status: 409, message: 'הגרסאות השתנו. פתחו את האישור מחדש.' };
  }
  return { ok: true };
}

export function idleRollback() {
  return {
    state: 'idle',
    kind: null,
    from: null,
    to: null,
    backupId: null,
    error: null,
    startedAt: null,
  };
}

export function isRollbackRunning(rollback, nowMs = Date.now()) {
  if (!rollback || rollback.state !== 'running') return false;
  const started = Date.parse(rollback.startedAt || '');
  if (!Number.isFinite(started)) return false;
  return nowMs - started < ROLLBACK_TIMEOUT_MS;
}

function resultIsForThisRun(rollback, result) {
  if (!result || typeof result !== 'object') return false;
  if (rollback?.backupId && result.backup_id && String(result.backup_id) !== String(rollback.backupId)) return false;
  const finished = Date.parse(result.finished_at || '');
  const started = Date.parse(rollback?.startedAt || '');
  if (Number.isFinite(finished) && Number.isFinite(started) && finished + 1000 < started) return false;
  return true;
}

export function terminalFromCompanion(rollback, result) {
  if (!resultIsForThisRun(rollback, result)) return null;
  if (result.state === 'done' && result.reverted !== true) return idleRollback();
  if (result.state === 'failed' || result.reverted === true) {
    return {
      ...rollback,
      state: 'failed',
      error: result.message || 'השחזור נכשל.',
    };
  }
  return null;
}

export function reconcileRollback(state, { companion = null, consoleVersion = null, nowMs = Date.now() } = {}) {
  const rollback = { ...EMPTY_STATE.rollback, ...(state?.rollback || {}) };
  if (rollback.state !== 'running') return { state, changed: false };
  const terminal = terminalFromCompanion(rollback, companion?.rollback || null);
  if (terminal) return { changed: true, state: { ...state, rollback: terminal } };
  if (rollback.kind === 'console' && consoleVersion && rollback.to && String(consoleVersion) === String(rollback.to)) {
    return { changed: true, state: { ...state, rollback: idleRollback() } };
  }
  if (!isRollbackRunning(rollback, nowMs)) {
    const versionBack = companion?.version && rollback.to && String(companion.version) === String(rollback.to);
    if (rollback.kind === 'companion' && versionBack && companion?.rollback?.reverted !== true) {
      return { changed: true, state: { ...state, rollback: idleRollback() } };
    }
    return {
      changed: true,
      state: {
        ...state,
        rollback: { ...rollback, state: 'failed', error: ROLLBACK_BLOCK_HE.timeout },
      },
    };
  }
  return { state, changed: false };
}

export function rollbackSafety(mavConn) {
  const safety = assessUpdateSafety(mavConn, { confirmUnknown: false });
  if (safety.allowed) {
    return { allowed: true, blockedReason: null, needsConfirmation: false, message: null };
  }
  return {
    allowed: false,
    blockedReason: safety.blockedReason,
    needsConfirmation: false,
    message: rollbackBlockMessage(safety.blockedReason),
  };
}
