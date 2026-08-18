/**
 * Companion status mapping for Phase A.
 * Missing numeric values stay null — never coerce to 0.
 */

export const COMPANION_STATES = Object.freeze({
  OK: "OK",
  DISCONNECTED: "DISCONNECTED",
  DEGRADED: "DEGRADED",
  NOT_PRESENT: "NOT_PRESENT",
  DISABLED: "DISABLED",
  WAITING_FOR_HARDWARE: "WAITING_FOR_HARDWARE",
  STALE: "STALE",
});

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

export function mapCompanionHealth(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, state: COMPANION_STATES.DISCONNECTED };
  if (raw.ok === false) return { ok: false, state: COMPANION_STATES.DEGRADED, detail: raw };
  return { ok: true, state: COMPANION_STATES.OK, detail: raw };
}

export function mapCompanionStatus(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const fc = src.fc && typeof src.fc === "object" ? src.fc : {};
  const vision = src.vision && typeof src.vision === "object" ? src.vision : {};
  const nav = src.navigation && typeof src.navigation === "object" ? src.navigation : {};
  const video = src.video && typeof src.video === "object" ? src.video : {};
  const system = src.system && typeof src.system === "object" ? src.system : {};
  const landing = src.landing && typeof src.landing === "object" ? src.landing : {};

  const connected = src.connected === true || src.ok === true || src.reachable === true;
  let state = COMPANION_STATES.OK;
  if (src.state && COMPANION_STATES[String(src.state)]) state = String(src.state);
  else if (src.disabled === true) state = COMPANION_STATES.DISABLED;
  else if (src.waitingForHardware === true) state = COMPANION_STATES.WAITING_FOR_HARDWARE;
  else if (src.stale === true) state = COMPANION_STATES.STALE;
  else if (src.degraded === true || src.ok === false) state = COMPANION_STATES.DEGRADED;
  else if (!connected && src.ok !== true) state = COMPANION_STATES.DISCONNECTED;

  return {
    state,
    connected: connected || state === COMPANION_STATES.OK,
    version: strOrNull(src.version || src.appVersion),
    system: {
      cpuTempC: numOrNull(system.cpuTempC ?? system.cpu_temp_c),
      gpuTempC: numOrNull(system.gpuTempC ?? system.gpu_temp_c),
      memUsedPct: numOrNull(system.memUsedPct ?? system.mem_used_pct),
    },
    fc: {
      connected: boolOrNull(fc.connected),
      armed: boolOrNull(fc.armed),
      mode: strOrNull(fc.mode),
      voltageV: numOrNull(fc.voltageV ?? fc.voltage),
    },
    vision: {
      fps: numOrNull(vision.fps),
      latencyMs: numOrNull(vision.latencyMs ?? vision.latency_ms),
      padVisible: boolOrNull(vision.padVisible ?? vision.pad_visible),
    },
    navigation: {
      quality: numOrNull(nav.quality ?? nav.slamQuality),
      tracking: boolOrNull(nav.tracking),
    },
    landing: {
      phase: strOrNull(landing.phase),
      ready: boolOrNull(landing.ready),
    },
    video: {
      streaming: boolOrNull(video.streaming),
      url: strOrNull(video.url),
    },
    raw: src,
  };
}

/**
 * Overlay for existing SSE `event: telemetry` — keep current UI working.
 * Fields marked compatibility are transitional until Phase B UI rewrite.
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
      latencyMs: m.vision?.latencyMs ?? null,
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
