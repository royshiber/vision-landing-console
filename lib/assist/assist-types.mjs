/** C10.2 Assist — shared types and constants (no LLM orchestration). */

export const ASSIST_INTENTS = Object.freeze([
  'QUESTION',
  'OBSERVATION',
  'NOTE',
  'REQUEST',
  'DEVELOPMENT',
  'UI_ACTION',
  'FLIGHT_PARAM',
  'UNRESOLVED',
]);

export const ASSIST_CHANNELS = Object.freeze(['text', 'voice']);

export const ASSIST_ACTION_TYPES = Object.freeze([
  'UI_NAVIGATION',
  'CREATE_NOTE',
  'CREATE_OBSERVATION',
  'CREATE_DEVELOPMENT_TASK',
  'PROPOSE_PARAM_CHANGE',
]);

/** Mission is an ops surface: notes, observations, known-route nav, confirm-gated param propose. No coding-agent start. */
export const MISSION_AVAILABLE_ACTIONS = Object.freeze([
  'UI_NAVIGATION',
  'CREATE_NOTE',
  'CREATE_OBSERVATION',
  'PROPOSE_PARAM_CHANGE',
]);

export function availableActionsForWorkspace(workspace) {
  if (workspace === 'MISSION') return [...MISSION_AVAILABLE_ACTIONS];
  return [...ASSIST_ACTION_TYPES];
}

export function isWorkspaceActionAllowed(workspace, action) {
  return availableActionsForWorkspace(workspace).includes(action);
}

/**
 * Explicitly rejected — Ask must never execute these.
 * PARAM_WRITE stays a direct-write ban. Safe param work is PROPOSE_PARAM_CHANGE
 * (confirm-required). ARM / LAND / auto-land / live nav switch stay blocked
 * (Roy 2026-09-12 early-flight Human Gate).
 */
export const ASSIST_PROHIBITED_ACTIONS = Object.freeze([
  'PARAM_WRITE',
  'FC_COMMAND',
  'ARM',
  'DISARM',
  'MODE_CHANGE',
  'LANDING_COMMAND',
  'NAV_SOURCE_SWITCH',
  'DEPLOY',
  'ROLLBACK',
  'RESTART_SERVICE',
  'SHELL',
  'CURSOR_AGENT_START',
  'ARBITRARY_PATH',
  'ARBITRARY_URL',
]);

export const ASSIST_WORKSPACES = Object.freeze([
  'PULSE',
  'MISSION',
  'PLATFORM',
  'EVOLVE',
  'LAB',
  'UNKNOWN',
]);

export const ASSIST_CAPABILITIES = Object.freeze([
  'vision',
  'landing',
  'navigation',
  'mission',
  'video',
  'voice',
  'diagnostics',
  'companion',
  'configuration',
  'debrief',
  'evolve',
  'lab_sitl',
  'advisor',
]);

export function nowIso() {
  return new Date().toISOString();
}
