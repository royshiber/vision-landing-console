/**
 * Companion status mapping for Phase B0.
 * Wire names come from vendor/jetson-companion-api (Jetson OpenAPI snapshot).
 * Missing numeric values stay null — never coerce to 0.
 * camelCase aliases are transitional only.
 */

import { CompanionApiError } from "./companion-api-error.mjs";
import { readContractField } from "./companion-contract.mjs";

export const COMPANION_STATES = Object.freeze({
  OK: "OK",
  DISCONNECTED: "DISCONNECTED",
  DEGRADED: "DEGRADED",
  NOT_PRESENT: "NOT_PRESENT",
  DISABLED: "DISABLED",
  WAITING_FOR_HARDWARE: "WAITING_FOR_HARDWARE",
  STALE: "STALE",
});

const WIRE_STATES = new Set([
  COMPANION_STATES.OK,
  COMPANION_STATES.DISCONNECTED,
  COMPANION_STATES.DEGRADED,
  COMPANION_STATES.WAITING_FOR_HARDWARE,
  COMPANION_STATES.STALE,
]);

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function boolOrNull(v) {
  if (v === true || v === false) return v;
  return null;
}

function objOrEmpty(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function readNum(src, name) {
  return numOrNull(readContractField(src, name).value);
}

function readStr(src, name) {
  return strOrNull(readContractField(src, name).value);
}

function readBool(src, name) {
  return boolOrNull(readContractField(src, name).value);
}

export function mapCompanionHealth(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, state: COMPANION_STATES.DISCONNECTED };
  }
  if (raw.ok === false) return { ok: false, state: COMPANION_STATES.DEGRADED, detail: raw };
  if (raw.ok === true) return { ok: true, state: COMPANION_STATES.OK, detail: raw };
  return { ok: false, state: COMPANION_STATES.DISCONNECTED, detail: raw };
}

function deriveState(src) {
  const wireState = src.state != null ? String(src.state) : "";
  if (WIRE_STATES.has(wireState)) return wireState;
  /* transitional aliases — not contract field names */
  if (src.disabled === true) return COMPANION_STATES.DISABLED;
  if (src.waiting_for_hardware === true || src.waitingForHardware === true) {
    return COMPANION_STATES.WAITING_FOR_HARDWARE;
  }
  if (src.stale === true) return COMPANION_STATES.STALE;
  if (src.degraded === true || src.ok === false) return COMPANION_STATES.DEGRADED;
  const connected = readContractField(src, "connected").value === true || src.ok === true;
  if (!connected) return COMPANION_STATES.DISCONNECTED;
  return COMPANION_STATES.OK;
}

export function mapCompanionStatus(raw) {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new CompanionApiError("schema", "Companion status is not an object");
  }
  const src = raw && typeof raw === "object" ? raw : {};
  const fc = objOrEmpty(src.fc);
  const vision = objOrEmpty(src.vision);
  const nav = objOrEmpty(src.navigation);
  const video = objOrEmpty(src.video);
  const system = objOrEmpty(src.system);
  const landing = objOrEmpty(src.landing);
  const mavlink = objOrEmpty(src.mavlink);
  const channels = objOrEmpty(src.channels);

  const state = raw == null ? COMPANION_STATES.DISCONNECTED : deriveState(src);
  const connectedFlag = readContractField(src, "connected").value;
  const connected = connectedFlag === true || (connectedFlag == null && state === COMPANION_STATES.OK);

  return {
    state,
    connected,
    version: readStr(src, "version"),
    ts: strOrNull(src.ts),
    system: {
      cpu_temp_c: readNum(system, "cpu_temp_c"),
      gpu_temp_c: readNum(system, "gpu_temp_c"),
      mem_used_pct: readNum(system, "mem_used_pct"),
    },
    fc: {
      connected: readBool(fc, "connected"),
      armed: readBool(fc, "armed"),
      mode: readStr(fc, "mode"),
      voltage_v: readNum(fc, "voltage_v"),
    },
    vision: {
      fps: readNum(vision, "fps"),
      latency_ms: readNum(vision, "latency_ms"),
      pad_visible: readBool(vision, "pad_visible"),
    },
    navigation: {
      quality: readNum(nav, "quality"),
      tracking: readBool(nav, "tracking"),
    },
    landing: {
      phase: readStr(landing, "phase"),
      ready: readBool(landing, "ready"),
    },
    video: {
      streaming: readBool(video, "streaming"),
      url: readStr(video, "url"),
    },
    mavlink: {
      connected: readBool(mavlink, "connected"),
      heartbeat_hz: readNum(mavlink, "heartbeat_hz"),
    },
    channels: {
      rc: Object.prototype.hasOwnProperty.call(channels, "rc") ? channels.rc : null,
    },
    raw: src,
  };
}

/**
 * Overlay for existing SSE `event: telemetry` — keep current UI working.
 * Fields marked compatibility are transitional until a UI rewrite.
 */
export function toSseTelemetryOverlay(mapped, extras = {}) {
  const m = mapped && typeof mapped === "object" ? mapped : mapCompanionStatus(null);
  return {
    companion: {
      state: m.state || COMPANION_STATES.DISCONNECTED,
      connected: !!m.connected,
      version: m.version,
      updatedAt: extras.updatedAt || Date.now(),
    },
    /* compatibility — existing dashboard still reads jetson / vision / slam */
    jetson: {
      reachable: m.connected === true,
      companion: m.connected === true,
      lastHeartbeatAt: extras.updatedAt || Date.now(),
      version: m.version,
    },
    vision: {
      fps: m.vision?.fps ?? null,
      latencyMs: m.vision?.latency_ms ?? null,
    },
    slam: {
      quality: m.navigation?.quality ?? null,
      tracking: m.navigation?.tracking ?? null,
    },
  };
}

export function mergeTelemetryWithCompanion(baseTelemetry, overlay) {
  const base = baseTelemetry && typeof baseTelemetry === "object" ? { ...baseTelemetry } : {};
  if (!overlay || typeof overlay !== "object") return base;
  const out = { ...base, companion: overlay.companion };
  if (overlay.jetson) out.jetson = { ...(base.jetson || {}), ...overlay.jetson };
  if (overlay.vision) out.vision = { ...(base.vision || {}), ...overlay.vision };
  if (overlay.slam) out.slam = { ...(base.slam || {}), ...overlay.slam };
  return out;
}
