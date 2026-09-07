/** C10.2 Assist — shared types and constants (no LLM orchestration). */

export const ASSIST_INTENTS = Object.freeze([
  'QUESTION',
  'OBSERVATION',
  'NOTE',
  'REQUEST',
  'DEVELOPMENT',
  'UI_ACTION',
  'UNRESOLVED',
]);

export const ASSIST_CHANNELS = Object.freeze(['text', 'voice']);

export const ASSIST_ACTION_TYPES = Object.freeze([
  'UI_NAVIGATION',
  'CREATE_NOTE',
  'CREATE_OBSERVATION',
  'CREATE_DEVELOPMENT_TASK',
]);

/** Mission is an ops surface: notes, observations, known-route nav. No coding-agent start. */
export const MISSION_AVAILABLE_ACTIONS = Object.freeze([
  'UI_NAVIGATION',
  'CREATE_NOTE',
  'CREATE_OBSERVATION',
]);

export function availableActionsForWorkspace(workspace) {
  if (workspace === 'MISSION') return [...MISSION_AVAILABLE_ACTIONS];
  return [...ASSIST_ACTION_TYPES];
}

export function isWorkspaceActionAllowed(workspace, action) {
  return availableActionsForWorkspace(workspace).includes(action);
}

/** Explicitly rejected — Assist must never propose these. */
export const ASSIST_PROHIBITED_ACTIONS = Object.freeze([
  'PARAM_WRITE',
  'FC_COMMAND',
  'ARM',
  'DISARM',
  'MODE_CHANGE',
  'LANDING_COMMAND',
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
