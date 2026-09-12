/**
 * SSE / HUD MAVLink snapshot.
 * Built from the live radio (or connected command-link) connection so Mission
 * STATUSTEXT / AH do not stay on HTML empty-state while /api/connections/:id/status is live.
 */
import { isFcArmed } from './advisor-apply.mjs';
import { composeHudTelemetryFields, sseFiniteNumber } from './mavlink-hud-fields.mjs';

export const SSE_MAVLINK_DISCONNECTED = Object.freeze({
  connected: false,
  listening: false,
  id: null,
  linkRole: null,
  heartbeatCount: 0,
  armed: null,
  armedKnown: false,
  autopilotName: null,
  vehicleType: null,
  flightMode: null,
  airspeed: null,
  groundspeed: null,
  altitude: null,
  heading: null,
  airspeedIsGroundspeedProxy: false,
  hudTimeSkewMs: null,
  hudTimeSkewWarn: false,
  rollDeg: null,
  pitchDeg: null,
  batteryV: null,
  batteryPct: null,
  fcLoadPct: null,
  fcMemPct: null,
  fcTempC: null,
  gpsFixType: null,
  gpsSats: null,
  rcChannels: null,
  map: null,
  recentStatusTexts: [],
});

function mapStatusTexts(mavConn) {
  const raw = Array.isArray(mavConn?.statusTexts)
    ? mavConn.statusTexts
    : Array.isArray(mavConn?.recentStatusTexts)
      ? mavConn.recentStatusTexts
      : [];
  return raw.slice(0, 28).map((st) => ({
    severity: st.severity,
    text: st.text,
    receivedAt: st.receivedAt || null,
  }));
}

/**
 * @param {object|null|undefined} mavConn live MavlinkConnection (or status-shaped)
 * @returns {object}
 */
export function buildSseMavlinkSnapshot(mavConn) {
  if (!mavConn) return { ...SSE_MAVLINK_DISCONNECTED, recentStatusTexts: [] };
  const hud = composeHudTelemetryFields(mavConn);
  const mapTelemetry = typeof mavConn.getMapTelemetrySnapshot === 'function'
    ? mavConn.getMapTelemetrySnapshot()
    : (mavConn.map ?? null);
  return {
    connected: mavConn.connected === true,
    listening: mavConn.listening === true,
    id: mavConn.id ?? null,
    linkRole: mavConn.linkRole || 'radio',
    heartbeatCount: Number(mavConn.heartbeatCount) || 0,
    armed: isFcArmed(mavConn),
    armedKnown: typeof mavConn.lastBaseMode === 'number',
    autopilotName: mavConn.autopilotName || null,
    vehicleType: mavConn.vehicleType || null,
    flightMode: sseFiniteNumber(mavConn.lastCustomMode),
    airspeed: hud.airspeed,
    groundspeed: hud.groundspeed,
    altitude: hud.altitude,
    heading: hud.heading,
    airspeedIsGroundspeedProxy: !!hud.airspeedIsGroundspeedProxy,
    hudTimeSkewMs: hud.hudTimeSkewMs,
    hudTimeSkewWarn: !!hud.hudTimeSkewWarn,
    rollDeg: sseFiniteNumber(mavConn.lastAttitude?.rollDeg),
    pitchDeg: sseFiniteNumber(mavConn.lastAttitude?.pitchDeg),
    batteryV: sseFiniteNumber(mavConn.lastBattery?.voltage_V),
    batteryPct: sseFiniteNumber(mavConn.lastBattery?.remaining_pct),
    fcLoadPct: sseFiniteNumber(mavConn.lastBattery?.load_pct),
    fcMemPct: null,
    fcTempC: null,
    gpsFixType: sseFiniteNumber(mavConn.lastGpsRaw?.fixType),
    gpsSats: sseFiniteNumber(mavConn.lastGpsRaw?.satellites),
    rcChannels: mavConn.lastRcChannels ?? null,
    map: mapTelemetry,
    recentStatusTexts: mapStatusTexts(mavConn),
  };
}
