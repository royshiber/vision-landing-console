import { ASSIST_CAPABILITIES, ASSIST_WORKSPACES, availableActionsForWorkspace } from './assist-types.mjs';
import { normalizeSpokenUnits } from './spoken-units.mjs';

/** Map today's main tabs into C10 workspace labels (until Pulse/Mission shells ship). */
export const TAB_TO_WORKSPACE = Object.freeze({
  terrain: 'MISSION',
  development: 'EVOLVE',
  simLab: 'LAB',
  control: 'PLATFORM',
  platform: 'PLATFORM',
  telemetry: 'PLATFORM',
  maintenance: 'PLATFORM',
  recordings: 'PLATFORM',
  flights: 'PLATFORM',
  advisor: 'LAB',
  featureDesigner: 'EVOLVE',
  flightEngineer: 'MISSION',
});

export const TAB_TO_CAPABILITY = Object.freeze({
  terrain: 'mission',
  development: 'evolve',
  simLab: 'lab_sitl',
  control: 'configuration',
  platform: 'companion',
  telemetry: 'diagnostics',
  maintenance: 'companion',
  recordings: 'debrief',
  flights: 'debrief',
  advisor: 'advisor',
  featureDesigner: 'evolve',
  flightEngineer: 'voice',
  landingParams: 'landing',
  abortParams: 'landing',
  visionNavParams: 'vision',
  arduParams: 'configuration',
  customParams: 'configuration',
  autoConfig: 'configuration',
});

function cleanString(value, max = 200) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function pickStatusTexts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    const text = typeof row === 'string' ? row : row?.text;
    const s = cleanString(text, 160);
    if (!s) continue;
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

function pickAircraftState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const quality = typeof raw.link_quality === 'number' && Number.isFinite(raw.link_quality)
    ? raw.link_quality
    : null;
  return {
    connected: raw.connected === true,
    flight_mode: cleanString(raw.flight_mode || raw.flightMode, 40),
    armed: typeof raw.armed === 'boolean' ? raw.armed : null,
    gps_ok: typeof raw.gps_ok === 'boolean' ? raw.gps_ok : null,
    vision_confidence: typeof raw.vision_confidence === 'number' ? raw.vision_confidence : null,
    altitude_m: typeof raw.altitude_m === 'number' ? raw.altitude_m : null,
    airspeed_ms: typeof raw.airspeed_ms === 'number' ? raw.airspeed_ms : null,
    groundspeed_ms: typeof raw.groundspeed_ms === 'number' ? raw.groundspeed_ms : null,
    climb_rate_ms: typeof raw.climb_rate_ms === 'number' ? raw.climb_rate_ms : null,
    distance_m: typeof raw.distance_m === 'number' ? raw.distance_m : null,
    battery_v: typeof raw.battery_v === 'number' ? raw.battery_v : null,
    battery_pct: typeof raw.battery_pct === 'number' ? raw.battery_pct : null,
    link_label: cleanString(raw.link_label, 40),
    link_path: cleanString(raw.link_path || raw.link_role || raw.linkRole, 24)?.toLowerCase() || null,
    simulator: raw.simulator === true,
    link_port: Number.isFinite(Number(raw.link_port ?? raw.port)) ? Number(raw.link_port ?? raw.port) : null,
    link_host: cleanString(raw.link_host || raw.host, 80),
    link_type: cleanString(raw.link_type || raw.type, 16)?.toLowerCase() || null,
    link_quality: quality,
    gps_sats: typeof raw.gps_sats === 'number' ? raw.gps_sats : null,
    ekf_ok: typeof raw.ekf_ok === 'boolean' ? raw.ekf_ok : null,
    status_texts: pickStatusTexts(raw.status_texts || raw.recentStatusTexts),
  };
}

function pickKnownParams(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(k)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[k] = value;
    else if (typeof value === 'string' && value.trim()) out[k] = value.trim().slice(0, 40);
    if (Object.keys(out).length >= 40) break;
  }
  return Object.keys(out).length ? out : null;
}

function pickOpsSignals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (typeof raw.camera_ok === 'boolean') out.camera_ok = raw.camera_ok;
  if (typeof raw.recording_on === 'boolean') out.recording_on = raw.recording_on;
  if (typeof raw.optical_missing === 'boolean') out.optical_missing = raw.optical_missing;
  const jetson = cleanString(raw.jetson, 20);
  if (jetson === 'reachable' || jetson === 'unreachable' || jetson === 'off' || jetson === 'mock') {
    out.jetson = jetson;
  }
  if (raw.cameras && typeof raw.cameras === 'object') {
    const cameras = {};
    if (typeof raw.cameras.cam0 === 'boolean') cameras.cam0 = raw.cameras.cam0;
    if (typeof raw.cameras.cam1 === 'boolean') cameras.cam1 = raw.cameras.cam1;
    if (typeof raw.cameras.cam3 === 'boolean') cameras.cam3 = raw.cameras.cam3;
    else if (typeof raw.cameras.a8 === 'boolean') cameras.cam3 = raw.cameras.a8;
    if (Object.keys(cameras).length) out.cameras = cameras;
  }
  return Object.keys(out).length ? out : null;
}

function pickVision(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const camera = cleanString(raw.camera, 8);
  if (camera === 'cam0' || camera === 'cam1' || camera === 'cam3') out.camera = camera;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.stream === 'boolean') out.stream = raw.stream;
  if (raw.streams && typeof raw.streams === 'object') {
    const streams = {};
    for (const id of ['cam0', 'cam1', 'cam3']) {
      if (raw.streams[id] === true || raw.streams[id] === false) streams[id] = raw.streams[id];
    }
    if (Object.keys(streams).length) out.streams = streams;
  }
  if (raw.cameras && typeof raw.cameras === 'object') {
    const cameras = {};
    for (const id of ['cam0', 'cam1', 'cam3']) {
      const row = raw.cameras[id];
      if (!row || typeof row !== 'object') continue;
      const snap = pickVision({ ...row, camera: id, cameras: undefined, streams: undefined });
      if (snap) cameras[id] = snap;
    }
    if (Object.keys(cameras).length) out.cameras = cameras;
  }
  if (typeof raw.model === 'boolean') out.model = raw.model;
  const reason = cleanString(raw.reason_he, 80);
  if (reason) out.reason_he = reason;
  if (Array.isArray(raw.tracks)) {
    out.tracks = raw.tracks.slice(0, 40).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = {};
      const cls = cleanString(row.class, 40);
      const label = cleanString(row.label_he, 40);
      if (cls) item.class = cls;
      if (label) item.label_he = label;
      const color = cleanString(row.color_he, 24);
      if (color) item.color_he = color;
      if (row.id != null && String(row.id) !== '') item.id = row.id;
      return Object.keys(item).length ? item : null;
    }).filter(Boolean);
  }
  if (raw.lock === null) out.lock = null;
  else if (raw.lock && typeof raw.lock === 'object' && raw.lock.id != null && String(raw.lock.id) !== '') {
    out.lock = { id: raw.lock.id };
  }
  return Object.keys(out).length ? out : null;
}

function pickAttentionPolicy(raw) {
  const level = cleanString(raw?.attention_policy || raw?.proactiveLevel, 20);
  if (level === 'attention' || level === 'critical' || level === 'off') return level;
  return 'off';
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

  const workspaceActions = availableActionsForWorkspace(workspace);
  const availableActions = Array.isArray(serverEnrichment.available_actions)
    ? serverEnrichment.available_actions.filter((a) => workspaceActions.includes(a))
    : workspaceActions;
  const confirmActions = workspace === 'MISSION'
    ? ['CREATE_NOTE', 'CREATE_OBSERVATION', 'PROPOSE_PARAM_CHANGE']
    : ['CREATE_NOTE', 'CREATE_OBSERVATION', 'CREATE_DEVELOPMENT_TASK', 'PROPOSE_PARAM_CHANGE'];

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
    known_params: pickKnownParams(snap.known_params),
    ops_signals: pickOpsSignals(snap.ops_signals),
    vision: pickVision(snap.vision),
    attention_policy: pickAttentionPolicy(snap),
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
      ...(serverEnrichment.policy_state && typeof serverEnrichment.policy_state === 'object'
        ? serverEnrichment.policy_state
        : {}),
      ...(workspace === 'MISSION'
        ? {
          flight_actions_allowed: false,
          param_writes_allowed: false,
          deploy_allowed: false,
          agent_autostart_allowed: false,
        }
        : {}),
      requires_confirmation_for: confirmActions,
    },
    historical_context: null,
    channel: snap.channel === 'voice' ? 'voice' : 'text',
    spoken_units: normalizeSpokenUnits(snap.spoken_units || snap.spokenUnits),
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
