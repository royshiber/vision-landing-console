import { ASSIST_CAPABILITIES, ASSIST_WORKSPACES } from './assist-types.mjs';

/** Map today's main tabs into C10 workspace labels (until Pulse/Mission shells ship). */
export const TAB_TO_WORKSPACE = Object.freeze({
  terrain: 'MISSION',
  development: 'EVOLVE',
  simLab: 'LAB',
  control: 'PLATFORM',
  telemetry: 'PLATFORM',
  maintenance: 'PLATFORM',
  recordings: 'PLATFORM',
  flights: 'PLATFORM',
  advisor: 'PLATFORM',
  featureDesigner: 'EVOLVE',
  flightEngineer: 'MISSION',
});

export const TAB_TO_CAPABILITY = Object.freeze({
  terrain: 'mission',
  development: 'evolve',
  simLab: 'lab_sitl',
  control: 'configuration',
  telemetry: 'diagnostics',
  maintenance: 'companion',
  recordings: 'debrief',
  flights: 'debrief',
  advisor: 'diagnostics',
  featureDesigner: 'evolve',
  flightEngineer: 'voice',
  landingParams: 'landing',
  abortParams: 'landing',
  visionNavParams: 'vision',
  arduParams: 'configuration',
  customParams: 'configuration',
});

function cleanString(value, max = 200) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function pickAircraftState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    connected: raw.connected === true,
    flight_mode: cleanString(raw.flight_mode || raw.flightMode, 40),
    armed: typeof raw.armed === 'boolean' ? raw.armed : null,
    gps_ok: typeof raw.gps_ok === 'boolean' ? raw.gps_ok : null,
    vision_confidence: typeof raw.vision_confidence === 'number' ? raw.vision_confidence : null,
    altitude_m: typeof raw.altitude_m === 'number' ? raw.altitude_m : null,
    airspeed_ms: typeof raw.airspeed_ms === 'number' ? raw.airspeed_ms : null,
  };
}

/**
 * Build AssistContext from a client snapshot + optional server enrichment.
 * Does not invent aircraft/flight data — only passes through what was provided.
 */
export function buildAssistContext(clientSnapshot = {}, serverEnrichment = {}) {
  const snap = clientSnapshot && typeof clientSnapshot === 'object' ? clientSnapshot : {};
  const tab = cleanString(snap.current_tab || snap.tab, 40);
  const subtab = cleanString(snap.current_subtab || snap.subtab, 40);
  let workspace = cleanString(snap.current_workspace, 20);
  if (workspace && !ASSIST_WORKSPACES.includes(workspace)) workspace = 'UNKNOWN';
  if (!workspace && tab) workspace = TAB_TO_WORKSPACE[tab] || 'UNKNOWN';
  if (!workspace) workspace = 'UNKNOWN';

  let capability = cleanString(snap.current_capability, 40);
  if (capability && !ASSIST_CAPABILITIES.includes(capability)) capability = null;
  if (!capability && subtab && TAB_TO_CAPABILITY[subtab]) capability = TAB_TO_CAPABILITY[subtab];
  if (!capability && tab && TAB_TO_CAPABILITY[tab]) capability = TAB_TO_CAPABILITY[tab];

  const availableActions = Array.isArray(serverEnrichment.available_actions)
    ? serverEnrichment.available_actions
    : ['UI_NAVIGATION', 'CREATE_NOTE', 'CREATE_OBSERVATION', 'CREATE_DEVELOPMENT_TASK'];

  return {
    current_user: cleanString(snap.current_user, 80) || 'primary',
    current_workspace: workspace,
    current_capability: capability,
    current_ui_state: {
      tab: tab,
      subtab: subtab,
      assist_open: snap.assist_open === true,
    },
    current_mission: snap.current_mission && typeof snap.current_mission === 'object'
      ? { focus: cleanString(snap.current_mission.focus, 80) }
      : null,
    current_flight: snap.current_flight && typeof snap.current_flight === 'object'
      ? {
        id: cleanString(snap.current_flight.id, 80),
        session_id: cleanString(snap.current_flight.session_id, 80),
      }
      : null,
    aircraft_state: pickAircraftState(snap.aircraft_state),
    recent_events: Array.isArray(snap.recent_events)
      ? snap.recent_events.slice(0, 10).map((e) => cleanString(e, 160)).filter(Boolean)
      : [],
    recent_notes: Array.isArray(serverEnrichment.recent_notes) ? serverEnrichment.recent_notes.slice(0, 10) : [],
    active_development_task: serverEnrichment.active_development_task || null,
    recent_releases: Array.isArray(serverEnrichment.recent_releases)
      ? serverEnrichment.recent_releases.slice(0, 5)
      : [],
    recent_deployments: Array.isArray(serverEnrichment.recent_deployments)
      ? serverEnrichment.recent_deployments.slice(0, 5)
      : [],
    available_actions: availableActions,
    policy_state: {
      flight_actions_allowed: false,
      param_writes_allowed: false,
      deploy_allowed: false,
      agent_autostart_allowed: false,
      requires_confirmation_for: ['CREATE_NOTE', 'CREATE_OBSERVATION', 'CREATE_DEVELOPMENT_TASK'],
      ...(serverEnrichment.policy_state && typeof serverEnrichment.policy_state === 'object'
        ? serverEnrichment.policy_state
        : {}),
    },
    historical_context: null,
    channel: snap.channel === 'voice' ? 'voice' : 'text',
  };
}

export function summarizeContextForResponse(ctx) {
  return {
    workspace: ctx.current_workspace,
    capability: ctx.current_capability,
    tab: ctx.current_ui_state?.tab || null,
    aircraft_connected: ctx.aircraft_state?.connected ?? null,
    active_task_id: ctx.active_development_task?.id || null,
  };
}
