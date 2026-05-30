/** In-memory auto-connect progress (single Node process). */

export const AUTO_CONNECT_PHASES = ['usb_serial', 'jetson_relay', 'sitl_local'];

/** @typedef {'pending'|'active'|'done'|'failed'|'skipped'} PhaseUiState */
/** @typedef {'scanning'|'activate'|'heartbeat'|'exhausted'} SubStatus */

function defaultPhaseStates() {
  return Object.fromEntries(AUTO_CONNECT_PHASES.map((p) => [p, 'pending']));
}

/** @type {{
 *   active: boolean,
 *   startedAt: number|null,
 *   currentPhase: string|null,
 *   currentTarget: string|null,
 *   subStatus: SubStatus|null,
 *   attemptIndex: number,
 *   totalPhases: number,
 *   phasesDone: string[],
 *   phaseStates: Record<string, PhaseUiState>,
 *   lastAttempt: object|null,
 *   message: string|null,
 *   jetsonOnline: boolean|null,
 * }} */
let progress = {
  active: false,
  startedAt: null,
  currentPhase: null,
  currentTarget: null,
  subStatus: null,
  attemptIndex: 0,
  totalPhases: AUTO_CONNECT_PHASES.length,
  phasesDone: [],
  phaseStates: defaultPhaseStates(),
  lastAttempt: null,
  message: null,
  jetsonOnline: null,
};

function snapshot() {
  return {
    ok: true,
    active: progress.active,
    startedAt: progress.startedAt,
    currentPhase: progress.currentPhase,
    currentTarget: progress.currentTarget,
    subStatus: progress.subStatus,
    attemptIndex: progress.attemptIndex,
    totalPhases: progress.totalPhases,
    phasesDone: [...progress.phasesDone],
    phaseStates: { ...progress.phaseStates },
    lastAttempt: progress.lastAttempt ? { ...progress.lastAttempt } : null,
    message: progress.message,
    jetsonOnline: progress.jetsonOnline,
  };
}

export function getAutoConnectProgress() {
  return snapshot();
}

/**
 * @param {{ jetsonOnline?: boolean }} meta
 */
export function patchAutoConnectMeta(meta) {
  if (!progress.active) return;
  if (typeof meta.jetsonOnline === 'boolean') progress.jetsonOnline = meta.jetsonOnline;
}

export function beginAutoConnectProgress() {
  progress = {
    active: true,
    startedAt: Date.now(),
    currentPhase: null,
    currentTarget: null,
    subStatus: 'scanning',
    attemptIndex: 0,
    totalPhases: AUTO_CONNECT_PHASES.length,
    phasesDone: [],
    phaseStates: defaultPhaseStates(),
    lastAttempt: null,
    message: 'מתחיל חיבור חכם…',
    jetsonOnline: null,
  };
}

/**
 * @param {string} phase
 * @param {{ message?: string, subStatus?: SubStatus }} [opts]
 */
export function setAutoConnectPhaseActive(phase, opts = {}) {
  if (!progress.active) return;
  for (const p of AUTO_CONNECT_PHASES) {
    if (p === phase) {
      progress.phaseStates[p] = 'active';
    } else if (progress.phaseStates[p] === 'active') {
      progress.phaseStates[p] = 'failed';
      if (!progress.phasesDone.includes(p)) progress.phasesDone.push(p);
    }
  }
  progress.currentPhase = phase;
  progress.subStatus = opts.subStatus ?? 'scanning';
  if (opts.message) progress.message = opts.message;
}

/**
 * @param {string} phase
 * @param {'failed'|'skipped'} outcome
 * @param {string} [message]
 */
export function finishAutoConnectPhase(phase, outcome, message) {
  if (!progress.active) return;
  if (progress.phaseStates[phase] === 'active') {
    progress.phaseStates[phase] = outcome;
  } else if (progress.phaseStates[phase] === 'pending') {
    progress.phaseStates[phase] = outcome;
  }
  if (!progress.phasesDone.includes(phase)) progress.phasesDone.push(phase);
  if (message) progress.message = message;
  if (progress.currentPhase === phase) {
    progress.currentPhase = null;
    progress.currentTarget = null;
    progress.subStatus = 'scanning';
  }
}

/**
 * @param {{ target: string, subStatus: SubStatus, attemptIndex?: number, lastAttempt?: object }} patch
 */
export function patchAutoConnectAttempt(patch) {
  if (!progress.active) return;
  if (patch.target != null) progress.currentTarget = patch.target;
  if (patch.subStatus) progress.subStatus = patch.subStatus;
  if (patch.attemptIndex != null) progress.attemptIndex = patch.attemptIndex;
  if (patch.lastAttempt) progress.lastAttempt = { ...patch.lastAttempt };
}

/**
 * @param {{ ok: boolean, message?: string, winningPhase?: string }} result
 */
export function completeAutoConnectProgress({ ok, message, winningPhase }) {
  if (winningPhase && AUTO_CONNECT_PHASES.includes(winningPhase)) {
    for (const p of AUTO_CONNECT_PHASES) {
      if (p === winningPhase) progress.phaseStates[p] = 'done';
      else if (progress.phaseStates[p] === 'active' || progress.phaseStates[p] === 'pending') {
        progress.phaseStates[p] = progress.phaseStates[p] === 'active' ? 'failed' : 'skipped';
      }
    }
    if (!progress.phasesDone.includes(winningPhase)) progress.phasesDone.push(winningPhase);
  } else if (!ok) {
    for (const p of AUTO_CONNECT_PHASES) {
      if (progress.phaseStates[p] === 'active') progress.phaseStates[p] = 'failed';
      else if (progress.phaseStates[p] === 'pending') progress.phaseStates[p] = 'skipped';
    }
    progress.subStatus = 'exhausted';
  }
  progress.active = false;
  progress.currentPhase = null;
  progress.currentTarget = null;
  if (message) progress.message = message;
}
