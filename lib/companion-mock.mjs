/**
 * Mock Companion API — same method surface as createCompanionApiClient.
 * Payloads match Jetson OpenAPI v1. No Jetson / FC / camera required.
 */

import { EventEmitter } from "events";
import { CompanionApiError } from "./companion-api-client.mjs";
import { COMPANION_API_VERSION, COMPANION_V1_PATHS, GIMBAL_CONTROL_DISABLED_HE } from "./companion-v1-paths.mjs";
import { visionFixtureAllowed } from "./qa-mode.mjs";
import { isDeployableReleaseStatus, sanitizeDeployPayload } from "./companion-release-mgmt.mjs";
import {
  snapshotForScenario,
  healthyPolicy,
  healthyCompanionConfig,
  healthyPolicyPreview,
  maintenanceForScenario,
  releaseInventoryForScenario,
  backupsForScenario,
  auditForScenario,
  findMockReleaseById,
  MOCK_RELEASE_CATALOG,
} from "./companion-mock-fixtures.mjs";

export const COMPANION_MOCK_SCENARIOS = Object.freeze(["healthy", "disconnected", "degraded"]);

function gimbalControlOn(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.VLC_GIMBAL_CONTROL_ENABLED || "0").trim().toLowerCase());
}

function mockGimbalCommand(action, body) {
  if (!gimbalControlOn()) {
    throw new CompanionApiError({
      kind: "http",
      status: 403,
      message: GIMBAL_CONTROL_DISABLED_HE,
      body: {
        ok: false,
        reason: "gimbal_control_disabled",
        message: GIMBAL_CONTROL_DISABLED_HE,
        sent: false,
        action,
      },
    });
  }
  return {
    ok: false,
    sent: false,
    confirmed: false,
    present: false,
    reason: "no_reply",
    action,
    echoed: body && typeof body === "object" ? body : {},
    note: "mock has no gimbal; command not invented as applied",
  };
}

function clone(obj) {
  return structuredClone(obj);
}

const MOCK_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUTEhIVFhUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAADAAIEBQYHCP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A1e1h0AAAAA//9k=', 'base64');

const CALIB_HINTS = ['קרב את הלוח', 'הרחק את הלוח', 'הטה את הלוח', 'הזז לפינה', 'החזק'];

function freshCalib() {
  return {
    phase: 'idle',
    captured: 0,
    target: 20,
    hint: '',
    rms: null,
    verdict: null,
    saved: false,
    board: { inner_cols: 9, inner_rows: 6, square_mm: 25 },
  };
}

function calibStatus(camera, session) {
  return {
    ok: true,
    camera,
    phase: session.phase,
    captured: session.captured,
    target: session.target,
    progress: `${session.captured}/${session.target}`,
    hint: session.hint,
    board: session.board,
    rms_px: session.rms,
    verdict: session.verdict,
    saved: session.saved,
    flight_commands: false,
  };
}

function advanceCalib(session, body) {
  const action = String(body?.action || 'status');
  if (action === 'start') {
    const next = freshCalib();
    next.phase = 'running';
    next.hint = 'החזק לוח שחמט מול המצלמה';
    next.board = {
      inner_cols: Number(body?.inner_cols) || 9,
      inner_rows: Number(body?.inner_rows) || 6,
      square_mm: Number(body?.square_mm) || 25,
    };
    Object.assign(session, next);
  } else if (action === 'retry') {
    Object.assign(session, freshCalib());
  } else if (action === 'observe' && session.phase === 'running') {
    session.captured = Math.min(session.target, session.captured + 1);
    if (session.captured >= session.target) {
      session.phase = 'review';
      session.rms = 0.42;
      session.verdict = 'מצוין';
      session.hint = '';
    } else {
      session.hint = CALIB_HINTS[(session.captured - 1) % CALIB_HINTS.length];
    }
  } else if (action === 'save' && session.phase === 'review') {
    session.saved = true;
  }
  return session;
}

export function createCompanionMock(opts = {}) {
  let scenario = COMPANION_MOCK_SCENARIOS.includes(opts.scenario) ? opts.scenario : "healthy";
  const env = opts.env && typeof opts.env === "object" ? opts.env : process.env;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  let runtime = {};
  let policy = healthyPolicy();
  let config = healthyCompanionConfig();
  let deployState = "IDLE";
  let activeRelease = clone(MOCK_RELEASE_CATALOG[0]);
  let previousRelease = clone(MOCK_RELEASE_CATALOG[1]);
  /** @type {Array<object>} */
  let mockBackups = [];
  /** @type {Array<object>} */
  let mockAudit = [];
  const cameras = {
    cam0: { ae: false, exposure_us: 2000, gain: 16, width: 1280, height: 800, fps: 30, fov_deg: 90 },
    cam1: { ae: false, exposure_us: 2000, gain: 16, width: 1280, height: 800, fps: 30, fov_deg: 79 },
  };
  const calib = { cam0: freshCalib(), cam1: freshCalib() };
  const vision = { enabled: false, camera: '', gimbalSteer: false, lock: null };

  function cameraStreams(id) {
    if (!cameraUp()) return false;
    const key = String(id || '');
    const fixture = testVisionFixture();
    if (fixture && String(fixture.camera || '') === key) {
      return fixture.enabled !== false && fixture.stream !== false;
    }
    if (key === 'cam3') {
      const flag = String(env.VLC_MOCK_CAM3_STREAM || '').trim().toLowerCase();
      return flag === '1' || flag === 'true' || flag === 'yes';
    }
    return key === 'cam0' || key === 'cam1';
  }

  function stampCam3(cameras) {
    const next = cameras && typeof cameras === 'object' ? { ...cameras } : {};
    const prev = next.cam3 && typeof next.cam3 === 'object' ? { ...next.cam3 } : { id: 'cam3' };
    const on = cameraStreams('cam3');
    if (!on) return next.cam3 ? next : cameras;
    next.cam3 = {
      ...prev,
      id: 'cam3',
      state: 'streaming',
      camera_ok: true,
      has_frame: true,
      enabled: true,
      present: true,
    };
    return next;
  }

  function testVisionFixture() {
    if (!visionFixtureAllowed(env)) return null;
    const raw = String(env.VLC_VISION_MOCK_TRACKS || '').trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function fixtureTracks(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 40).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = {
        id: row.id,
        class: String(row.class || 'object'),
        label_he: String(row.label_he || ''),
        confidence: Number(row.confidence) || 0,
        bbox: Array.isArray(row.bbox) ? row.bbox.slice(0, 4).map((n) => Number(n) || 0) : [0, 0, 0, 0],
        age: Number(row.age) || 1,
      };
      const color = String(row.color_he || '').trim();
      if (color) item.color_he = color.slice(0, 24);
      return item;
    }).filter(Boolean);
  }

  function visionPayload(camera) {
    const asked = String(camera || '');
    const fixture = testVisionFixture();
    const fixtureCamera = fixture ? String(fixture.camera || '') : '';
    if (fixture && fixtureCamera && fixtureCamera === asked) {
      const steerOn = vision.gimbalSteer === true;
      const enabled = fixture.enabled !== false;
      const stream = cameraStreams(asked);
      return {
        ok: true,
        enabled,
        camera: asked,
        selected_camera: fixtureCamera,
        backend: 'fixture',
        stream,
        frame_width: null,
        frame_height: null,
        tracks: fixtureTracks(fixture.tracks),
        lock: vision.lock && vision.lock.camera === asked ? vision.lock : null,
        gimbal_steer: {
          enabled: steerOn,
          sent: false,
          blocked: true,
          reason: steerOn ? 'gimbal_absent' : 'steer_off',
          reason_he: steerOn ? 'הגימבל לא עונה. היגוי לא נשלח.' : 'היגוי הגימבל כבוי',
          flight_commands: false,
        },
        reason_he: stream ? '' : (enabled ? 'אין נתון על זרם המצלמות' : 'הזיהוי כבוי'),
        flight_commands: false,
        performance: { measured: false, note: 'not measured' },
      };
    }
    const selected = vision.enabled === true && vision.camera === asked;
    const steerOn = vision.gimbalSteer === true;
    const streaming = cameraStreams(asked);
    return {
      ok: true,
      enabled: vision.enabled === true,
      camera: asked,
      selected_camera: vision.camera || null,
      backend: 'off',
      stream: streaming,
      frame_width: null,
      frame_height: null,
      tracks: [],
      lock: vision.lock && vision.lock.camera === asked ? vision.lock : null,
      gimbal_steer: {
        enabled: steerOn,
        sent: false,
        blocked: true,
        reason: steerOn ? 'gimbal_absent' : 'steer_off',
        reason_he: steerOn ? 'הגימבל לא עונה. היגוי לא נשלח.' : 'היגוי הגימבל כבוי',
        flight_commands: false,
      },
      reason_he: vision.enabled !== true
        ? 'הזיהוי כבוי'
        : (streaming ? '' : 'אין נתון על זרם המצלמות'),
      flight_commands: false,
      performance: { measured: false, note: 'not measured' },
    };
  }

  function cameraUp() {
    return scenario !== 'disconnected';
  }

  function controlRow(requested, actual, applied, extra) {
    return { requested, actual, applied: applied === true, ...(extra || {}) };
  }

  function applyCamera(id, body) {
    const cam = cameras[id];
    const asked = body && typeof body === 'object' ? body : {};
    if (asked.ae && typeof asked.ae === 'object' && 'enabled' in asked.ae) cam.ae = asked.ae.enabled === true;
    if (asked.manual === true) cam.ae = false;
    if (!cam.ae) {
      if (asked.exposure_us != null && asked.exposure_us !== '') cam.exposure_us = Number(asked.exposure_us);
      if (asked.gain != null && asked.gain !== '') cam.gain = Number(asked.gain);
    }
    if (asked.width != null) cam.width = Number(asked.width);
    if (asked.height != null) cam.height = Number(asked.height);
    if (asked.fps != null && asked.fps !== '') cam.fps = Number(asked.fps);
    if (asked.fov_deg != null && asked.fov_deg !== '') cam.fov_deg = Number(asked.fov_deg);
    const controls = {
      ae: controlRow(cam.ae, cam.ae, true),
      fov_deg: controlRow(cam.fov_deg, cam.fov_deg, true, { metadata_only: true }),
    };
    if (cam.ae) {
      controls.exposure_us = controlRow(asked.exposure_us ?? null, cam.exposure_us, false, { skipped: true });
      controls.gain = controlRow(asked.gain ?? null, cam.gain, false, { skipped: true });
    } else {
      controls.exposure_us = controlRow(cam.exposure_us, cam.exposure_us, true);
      controls.gain = controlRow(cam.gain, cam.gain, true);
    }
    if (asked.width != null) controls.width = controlRow(cam.width, cam.width, true);
    if (asked.height != null) controls.height = controlRow(cam.height, cam.height, true);
    if (asked.fps != null) controls.fps = controlRow(cam.fps, cam.fps, true);
    cam.controls = controls;
    return controls;
  }

  function cameraStatus(id) {
    if (!cameraUp()) {
      return {
        ok: true,
        camera: id,
        state: 'absent',
        camera_ok: false,
        real: false,
        source: 'absent',
        has_frame: false,
        fps: null,
        dropped: null,
        latency_ms: null,
        flight_commands: false,
        observe_only: true,
        note: 'mock has no camera; not invented',
      };
    }
    const cam = cameras[id];
    return {
      ok: true,
      camera: id,
      state: 'live',
      camera_ok: true,
      real: false,
      dry_run: true,
      source: 'synthetic',
      has_frame: true,
      fps: cam.fps,
      capture_fps: cam.fps,
      width: cam.width,
      height: cam.height,
      dropped: 0,
      latency_ms: 12,
      ae: { enabled: cam.ae },
      exposure_us: cam.exposure_us,
      gain: cam.gain,
      fov_deg: cam.fov_deg,
      controls: cam.controls || null,
      flight_commands: false,
      observe_only: true,
      note: 'synthetic mock camera',
    };
  }

  function cameraSettings(id, body) {
    if (!cameraUp()) return { ok: true, source: 'absent', flight_commands: false };
    const controls = body ? applyCamera(id, body) : null;
    const cam = cameras[id];
    return {
      ok: true,
      source: 'synthetic',
      ae: { enabled: cam.ae },
      exposure_us: cam.exposure_us,
      gain: cam.gain,
      width: cam.width,
      height: cam.height,
      fps: cam.fps,
      fov_deg: cam.fov_deg,
      controls,
      flight_commands: false,
    };
  }

  function mockJpegStream() {
    const chunk = Buffer.concat([
      Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
      MOCK_JPEG,
      Buffer.from('\r\n'),
    ]);
    let timer = null;
    const body = new ReadableStream({
      start(controller) {
        const push = () => {
          try { controller.enqueue(chunk); } catch { /* closed */ }
        };
        push();
        timer = setInterval(push, 500);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return {
      body,
      contentType: 'multipart/x-mixed-replace; boundary=frame',
      abort() { clearInterval(timer); },
    };
  }

  function resetReleaseMockState() {
    deployState = "IDLE";
    activeRelease = clone(MOCK_RELEASE_CATALOG[0]);
    previousRelease = clone(MOCK_RELEASE_CATALOG[1]);
    const base = backupsForScenario(scenario);
    mockBackups = base?.backups ? clone(base.backups) : [];
    const auditBase = auditForScenario(scenario);
    mockAudit = auditBase?.entries ? clone(auditBase.entries) : [];
  }
  resetReleaseMockState();

  function assertReleaseReachable() {
    if (scenario === "disconnected") {
      throw new CompanionApiError({
        kind: "connection",
        message: "Companion API unavailable (mock disconnected)",
      });
    }
  }

  function pushAudit(entry) {
    mockAudit.unshift({
      timestamp: { t_monotonic_ns: Date.now() * 1_000_000, t_utc_ns: null },
      ...entry,
    });
  }

  function pack() {
    const snap = snapshotForScenario(scenario);
    return {
      ...snap,
      version: "0.1.0",
    };
  }

  function healthPayload() {
    const status = pack().status || {};
    const fcValid = status.fc?.heartbeat?.validity === "valid";
    const mavConn = status.mavlink?.connected === true;
    const mavHb = status.mavlink?.heartbeat_ok === true;
    const capabilities = { uplinkStatus: true, uplinkControl: true };
    if (scenario === "disconnected") {
      return { ok: true, api_version: "1", fc_linked: false, fc_heartbeat: false, capabilities };
    }
    if (scenario === "degraded") {
      return { ok: false, api_version: "1", fc_linked: mavConn || fcValid, fc_heartbeat: false, capabilities };
    }
    return {
      ok: true,
      api_version: "1",
      fc_linked: mavConn || fcValid,
      fc_heartbeat: fcValid || mavHb,
      capabilities,
    };
  }

  function emitChange() {
    emitter.emit("companion", { type: "status", scenario, payload: pack() });
  }

  const uplinkPrefs = { wifi: true, cellular: true };

  function uplinkSnapshot() {
    return {
      ok: true,
      read_only: false,
      boot_fallback: null,
      wifi: {
        iface: 'wlP1p1s0',
        up: false,
        enabled: uplinkPrefs.wifi === true,
        ssid: null,
        signal_dbm: null,
        ip: null,
        default_route: false,
      },
      cellular: {
        iface: null,
        up: false,
        enabled: uplinkPrefs.cellular === true,
        ip: null,
        route_metric: null,
        signal: { rssi: null, rsrp: null, rsrq: null, sinr: null },
        signal_icon: null,
        signal_max: null,
        network_type: null,
        network_label: null,
        operator: { short: null, full: null },
        default_route: false,
      },
      default_iface: null,
    };
  }

  const client = {
    kind: "mock",
    apiVersion: COMPANION_API_VERSION,
    get baseUrl() {
      return "mock://companion";
    },
    get timeoutMs() {
      return 0;
    },
    get scenario() {
      return scenario;
    },
    setScenario(next) {
      if (!COMPANION_MOCK_SCENARIOS.includes(next)) {
        throw new Error(`unknown mock scenario: ${next}`);
      }
      scenario = next;
      resetReleaseMockState();
      emitChange();
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    eventsUrl() {
      return "mock://companion/api/v1/events";
    },
    wsUrl() {
      return "mock://companion/api/v1/ws";
    },
    async getHealth() {
      return healthPayload();
    },
    async getVersion() {
      return { api_version: "1", companion_version: pack().version };
    },
    async getStatus() {
      const status = clone(pack().status);
      if (status?.optical_nav && typeof status.optical_nav === 'object') {
        status.optical_nav.cameras = stampCam3(status.optical_nav.cameras);
      }
      return status;
    },
    async getStatusSystem() {
      return clone(pack().status.system);
    },
    async getStatusFc() {
      return clone(pack().status.fc || {});
    },
    async getNetworkUplinks() {
      return uplinkSnapshot();
    },
    async setNetworkUplink(link, body) {
      const kind = String(link || '').trim().toLowerCase();
      if (kind !== 'wifi' && kind !== 'cellular') {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: 'bad_link',
          body: { ok: false, reason: 'bad_link', message: 'קישור לא מוכר' },
        });
      }
      if (!body || typeof body.enabled !== 'boolean') {
        throw new CompanionApiError({
          kind: 'http',
          status: 400,
          message: 'bad_body',
          body: { ok: false, reason: 'bad_body', message: 'גוף הבקשה לא תקין' },
        });
      }
      if (body.enabled === false) {
        throw new CompanionApiError({
          kind: 'http',
          status: 409,
          message: 'אי אפשר לכבות את הקישור האחרון',
          body: { ok: false, reason: 'last_uplink', message: 'אי אפשר לכבות את הקישור האחרון' },
        });
      }
      uplinkPrefs[kind] = true;
      return uplinkSnapshot();
    },
    async getStatusMavlink() {
      return clone(pack().status.mavlink);
    },
    async getStatusChannels() {
      return clone(pack().status.channels);
    },
    async getStatusVision() {
      return clone(pack().status.vision);
    },
    async getStatusCameras() {
      const vision = pack().status.vision || {};
      const nav = pack().status.optical_nav || {};
      return clone({
        ok: true,
        observe_only: true,
        camera_ok: vision.camera_ok === true,
        running: vision.running === true,
        dry_run: false,
        real: false,
        source: vision.camera_ok === true ? 'mock' : 'absent',
        fps: vision.fps ?? null,
        last_frame_age_ms: null,
        cameras: stampCam3(nav.cameras || {}),
        note: 'mock status only; no JPEG frame invented',
      });
    },
    async getStatusGimbal() {
      return {
        ok: true,
        present: false,
        firmware: null,
        hardware_id: null,
        attitude: null,
        zoom: null,
        mode: null,
        recording: null,
        age_ms: null,
        control_enabled: gimbalControlOn(),
        polling: false,
        error: 'no_reply',
        note: 'mock has no gimbal reply; not invented',
      };
    },
    async getCameraFrame(camId) {
      const key = String(camId || '').trim().toLowerCase();
      if (!['cam0', 'cam1', 'cam2', 'cam3'].includes(key)) {
        throw new CompanionApiError({
          kind: 'http',
          status: 404,
          message: 'unknown_camera',
          body: { ok: false, reason: 'unknown_camera' },
        });
      }
      if (!cameraUp() || !cameraStreams(key) || !['cam0', 'cam1', 'cam2', 'cam3'].includes(key)) {
        throw new CompanionApiError({
          kind: 'http',
          status: 404,
          message: 'no_frame',
          body: { ok: false, reason: 'no_frame', camera: key },
        });
      }
      return { bytes: MOCK_JPEG, contentType: 'image/jpeg' };
    },
    async getCam0Status() {
      return cameraStatus('cam0');
    },
    async getCam0Health() {
      const st = await this.getCam0Status();
      return st;
    },
    async getCam1Status() {
      return cameraStatus('cam1');
    },
    async getCam1Health() {
      const st = await this.getCam1Status();
      return st;
    },
    async getCam1Settings() {
      return cameraSettings('cam1');
    },
    async postCam1Settings(body) {
      return cameraSettings('cam1', body || {});
    },
    async getCam1Snapshot() {
      if (!cameraUp()) {
        throw new CompanionApiError({
          kind: 'http',
          status: 404,
          message: 'no_frame',
          body: { ok: false, reason: 'no_frame' },
        });
      }
      return { bytes: MOCK_JPEG, contentType: 'image/jpeg' };
    },
    async openCam1Stream() {
      if (!cameraUp()) {
        throw new CompanionApiError({
          kind: 'http',
          status: 404,
          message: 'no_frame',
          body: { ok: false, reason: 'no_frame' },
        });
      }
      return mockJpegStream();
    },
    async getCam0Settings() {
      return cameraSettings('cam0');
    },
    async postCam0Settings(body) {
      return cameraSettings('cam0', body || {});
    },
    async getCam0Detections() {
      return { ok: true, detections: [], flight_commands: false };
    },
    async getVisionTracks(camera) {
      return visionPayload(camera);
    },
    async getVisionConfig() {
      return visionPayload(vision.camera);
    },
    async postVisionConfig(body) {
      const asked = body && typeof body === 'object' ? body : {};
      if ('enabled' in asked) vision.enabled = asked.enabled === true;
      if (asked.camera) vision.camera = String(asked.camera);
      if ('gimbal_steer' in asked) vision.gimbalSteer = asked.gimbal_steer === true;
      if (vision.enabled && !vision.camera) {
        vision.enabled = false;
        return { ok: false, reason: 'camera_required', reason_he: 'בחרו מצלמה', flight_commands: false };
      }
      return visionPayload(vision.camera);
    },
    async postVisionLock(body) {
      const asked = body && typeof body === 'object' ? body : {};
      const camera = String(asked.camera || vision.camera || '');
      if (asked.action === 'unlock') {
        vision.lock = null;
        return visionPayload(camera);
      }
      const fixture = testVisionFixture();
      const fixtureCamera = fixture ? String(fixture.camera || '') : '';
      const rows = fixture && (!fixtureCamera || fixtureCamera === camera) ? fixtureTracks(fixture.tracks) : [];
      const ordered = [...rows].sort((a, b) => (asked.sort === 'confidence'
        ? (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
        : String(a.label_he || '').localeCompare(String(b.label_he || ''), 'he') || (Number(a.id) - Number(b.id))));
      if (asked.action === 'next') {
        const ids = ordered.map((row) => row.id);
        const current = vision.lock && vision.lock.camera === camera ? vision.lock.id : null;
        const pick = current != null && ids.includes(current) ? ids[(ids.indexOf(current) + 1) % ids.length] : ids[0];
        const chosen = ordered.find((row) => row.id === pick);
        vision.lock = chosen ? { ...chosen, camera } : null;
        return visionPayload(camera);
      }
      if (asked.id != null && asked.id !== '') {
        const chosen = ordered.find((row) => String(row.id) === String(asked.id));
        if (chosen) vision.lock = { ...chosen, camera };
      }
      return visionPayload(camera);
    },
    async getCam0Modules() {
      return { ok: true, modules: [] };
    },
    async postCam0Module(name, body) {
      return { ok: true, name, enabled: body?.enabled !== false, flight_commands: false };
    },
    async getCam0Calibration() {
      return { ok: true, calibration: null, camera_to_body: null };
    },
    async postCam0CalibrationCapture() {
      return { ok: false, reason: 'no_frame' };
    },
    async postCam0CalibrationSolve() {
      return { ok: false, reason: 'no_captures' };
    },
    async postCam0CalibrationSession(body) {
      if (!cameraUp()) return calibStatus('cam0', calib.cam0);
      return calibStatus('cam0', advanceCalib(calib.cam0, body));
    },
    async postCam1CalibrationSession(body) {
      if (!cameraUp()) return calibStatus('cam1', calib.cam1);
      return calibStatus('cam1', advanceCalib(calib.cam1, body));
    },
    async postCam0RecordStart() {
      return { ok: true, recording: false, flight_commands: false };
    },
    async postCam0RecordStop() {
      return { ok: true, recording: false, flight_commands: false };
    },
    async getCam0Recordings() {
      return { ok: true, recordings: [] };
    },
    async getCam0Recording() {
      return { ok: true, frames: [] };
    },
    async getCam0RecordingFrame() {
      throw new CompanionApiError({
        kind: 'http',
        status: 404,
        message: 'no_frame',
        body: { ok: false, reason: 'no_frame' },
      });
    },
    async getCam0Snapshot() {
      throw new CompanionApiError({
        kind: 'http',
        status: 404,
        message: 'no_frame',
        body: { ok: false, reason: 'no_frame' },
      });
    },
    postGimbalRate: (body) => mockGimbalCommand('rate', body),
    postGimbalAngle: (body) => mockGimbalCommand('angle', body),
    postGimbalCenter: (body) => mockGimbalCommand('center', body),
    postGimbalZoom: (body) => mockGimbalCommand('zoom', body),
    postGimbalMode: (body) => mockGimbalCommand('mode', body),
    postGimbalPhoto: (body) => mockGimbalCommand('photo', body),
    postGimbalRecord: (body) => mockGimbalCommand('record', body),
    async getVisionResult() {
      return clone(pack().visionResult);
    },
    async getStatusNavigation() {
      return clone(pack().status.navigation);
    },
    async getStatusOpticalNav() {
      const nav = clone(pack().status.optical_nav || {
        present: false,
        running: false,
        camera_ok: false,
        alt_ceiling_m: 300,
        position: null,
        velocity: null,
        age_ms: null,
        confidence: null,
        ekf_injected: false,
        display_only: true,
        note: "observe-only optical-nav stub; position null",
      });
      nav.cameras = stampCam3(nav.cameras);
      return nav;
    },
    async getNavigationEstimate() {
      return clone(pack().navigationEstimate);
    },
    async getStatusLanding() {
      return clone(pack().status.landing || {
        timestamp: pack().status.timestamp,
        source: "none",
        validity: "invalid",
        quality: { confidence: 0, label: "none" },
        target: null,
        detections: [],
      });
    },
    async getStatusVideo() {
      return clone(pack().status.video);
    },
    async getDiagnostics() {
      return clone(pack().diagnostics);
    },
    async getMaintenance() {
      return clone(maintenanceForScenario(scenario));
    },
    async getMaintenanceReleases() {
      assertReleaseReachable();
      const inv = releaseInventoryForScenario(scenario, { deployState });
      if (!inv) {
        throw new CompanionApiError({ kind: "connection", message: "Release inventory unavailable" });
      }
      inv.active = {
        release_id: activeRelease.release_id,
        version: activeRelease.version,
        status: "ACTIVE",
      };
      inv.previous = {
        release_id: previousRelease.release_id,
        version: previousRelease.version,
        status: "PREVIOUS",
      };
      return clone(inv);
    },
    async getMaintenanceRelease(id) {
      assertReleaseReachable();
      const rel = findMockReleaseById(String(id || ""));
      if (!rel) {
        throw new CompanionApiError({ kind: "http", status: 404, message: "Release not found", body: { message: "Release not found" } });
      }
      return clone(rel);
    },
    async getMaintenanceBackups() {
      assertReleaseReachable();
      return clone({ timestamp: maintenanceForScenario(scenario).timestamp, backups: mockBackups });
    },
    async getMaintenanceAudit() {
      assertReleaseReachable();
      return clone({ timestamp: maintenanceForScenario(scenario).timestamp, entries: mockAudit });
    },
    async postMaintenanceBackup() {
      assertReleaseReachable();
      if (scenario === "degraded") {
        throw new CompanionApiError({
          kind: "http",
          status: 409,
          message: "Backup conflict (mock degraded)",
          body: { message: "Backup conflict (mock degraded)" },
        });
      }
      const backupId = `bk-mock-${String(mockBackups.length + 1).padStart(3, "0")}`;
      const entry = {
        backup_id: backupId,
        created_at: new Date().toISOString(),
        release_id: MOCK_RELEASE_CATALOG[0].release_id,
        sha256: "mocksha256backup0000000000000000000000000000000000000000000000000000",
      };
      mockBackups.unshift(entry);
      pushAudit({
        operation: "backup",
        release_id: entry.release_id,
        result: "success",
        failure_reason: null,
        active_release_id: MOCK_RELEASE_CATALOG[0].release_id,
      });
      return clone({
        mock: true,
        backup_id: backupId,
        created_at: entry.created_at,
        sha256: entry.sha256,
        message: "MOCK: configuration backup created",
      });
    },
    async postMaintenanceDeploy(body) {
      assertReleaseReachable();
      let payload;
      try {
        payload = sanitizeDeployPayload(body);
      } catch (err) {
        throw new CompanionApiError({
          kind: "http",
          status: 400,
          message: err?.message || "invalid deploy payload",
        });
      }
      const rel = findMockReleaseById(payload.release_id);
      if (!rel) {
        throw new CompanionApiError({
          kind: "http",
          status: 404,
          message: "Release not found",
          body: { message: "Release not found" },
        });
      }
      if (!isDeployableReleaseStatus(rel.status)) {
        throw new CompanionApiError({
          kind: "http",
          status: 400,
          message: `Release status ${rel.status} is not deployable`,
          body: { message: `Release status ${rel.status} is not deployable` },
        });
      }
      if (scenario === "degraded") {
        deployState = "FAILED";
        pushAudit({
          operation: "deploy",
          release_id: rel.release_id,
          result: "failure",
          failure_reason: "Health check failed (mock degraded)",
          active_release_id: MOCK_RELEASE_CATALOG[0].release_id,
        });
        throw new CompanionApiError({
          kind: "http",
          status: 409,
          message: "Deploy conflict — health check failed (mock degraded)",
          body: { message: "Deploy conflict — health check failed (mock degraded)" },
        });
      }
      deployState = "SUCCEEDED";
      const lastActive = activeRelease;
      activeRelease = {
        release_id: rel.release_id,
        version: rel.version,
        status: "ACTIVE",
      };
      previousRelease = {
        release_id: lastActive.release_id,
        version: lastActive.version,
        status: "PREVIOUS",
      };
      pushAudit({
        operation: "deploy",
        release_id: rel.release_id,
        result: "success",
        failure_reason: null,
        active_release_id: rel.release_id,
      });
      return clone({
        mock: true,
        state: "SUCCEEDED",
        deploy_state: "SUCCEEDED",
        release_id: rel.release_id,
        running_process_changed: true,
        running_version: rel.version,
        health_check_ok: true,
        message: "Deployment successful",
        active_release: activeRelease,
        previous_release: previousRelease,
      });
    },
    async postMaintenanceRollback() {
      assertReleaseReachable();
      const inv = releaseInventoryForScenario(scenario, { deployState });
      if (!inv?.previous?.release_id) {
        throw new CompanionApiError({
          kind: "http",
          status: 400,
          message: "No previous release to rollback to",
          body: { message: "No previous release to rollback to" },
        });
      }
      if (scenario === "degraded") {
        throw new CompanionApiError({
          kind: "http",
          status: 501,
          message: "Rollback unsupported in degraded mock",
          body: { message: "Rollback unsupported in degraded mock" },
        });
      }
      deployState = "SUCCEEDED";
      const restored = previousRelease;
      const failed = activeRelease;
      activeRelease = {
        release_id: restored.release_id,
        version: restored.version,
        status: "ACTIVE",
      };
      previousRelease = {
        release_id: failed.release_id,
        version: failed.version,
        status: "PREVIOUS",
      };
      pushAudit({
        operation: "rollback",
        release_id: inv.previous.release_id,
        result: "success",
        failure_reason: null,
        active_release_id: inv.previous.release_id,
      });
      return clone({
        mock: true,
        state: "SUCCEEDED",
        running_process_changed: true,
        running_version: activeRelease.version,
        health_check_ok: true,
        message: "Rollback successful",
        active_release: activeRelease,
        previous_release: previousRelease,
      });
    },
    async getVersions() {
      if (scenario === "disconnected") {
        throw new CompanionApiError({
          kind: "connection",
          message: "Companion API unavailable (mock disconnected)",
        });
      }
      return {
        ok: true,
        version: "2.6.0",
        deployed_at: null,
        git_sha: null,
        known_good: false,
        backups: [],
        rollback: null,
      };
    },
    async postVersionsRollback() {
      if (scenario === "disconnected") {
        throw new CompanionApiError({
          kind: "connection",
          message: "Companion API unavailable (mock disconnected)",
        });
      }
      return {
        ok: false,
        reason: "missing",
        message: "הגיבוי לא נמצא.",
        reverted: false,
      };
    },
    async postVersionsKnownGood() {
      if (scenario === "disconnected") {
        throw new CompanionApiError({
          kind: "connection",
          message: "Companion API unavailable (mock disconnected)",
        });
      }
      return {
        ok: true,
        manifest: { version: "2.6.0", deployed_at: null, git_sha: null, known_good: true },
      };
    },
    async getConfig() {
      return clone({ ...config, runtime: { ...config.runtime, ...runtime } });
    },
    async getPolicy() {
      return clone(policy);
    },
    async getPolicyPreview() {
      const ch = policy.channels || {};
      const lines = ['# preview only — does not write /etc'];
      for (const [name, c] of Object.entries(ch)) {
        lines.push(`[${name}]`);
        if (c.deny?.length) lines.push(`  deny: ${c.deny.join(', ')}`);
        if (c.deny_in?.length) lines.push(`  deny_in: ${c.deny_in.join(', ')}`);
        if (c.deny_out?.length) lines.push(`  deny_out: ${c.deny_out.join(', ')}`);
      }
      return { snippet: lines.join('\n'), writes_etc: false, applySupported: false, policy: clone(policy) };
    },
    async patchConfigRuntime(body) {
      const patch = body && typeof body === "object" ? body : {};
      const hasRuntime = patch.runtime && typeof patch.runtime === "object";
      const hasVision = patch.vision && typeof patch.vision === "object";
      if (hasRuntime) {
        runtime = { ...runtime, ...patch.runtime };
      } else if (!hasVision) {
        runtime = { ...runtime, ...patch };
      }
      if (hasVision) {
        config = { ...config, vision: { ...(config.vision || {}), ...patch.vision } };
      }
      return {
        runtime: { ...(config.runtime || {}), ...runtime },
        vision: { ...(config.vision || {}) },
        applied: false,
      };
    },
    async putPolicy(body) {
      if (body && typeof body === "object") policy = { ...body };
      return { ok: true, applied: false, path: "mock://policy" };
    },
    getFullSnapshot() {
      const p = pack();
      const status = p.status || {};
      const health = healthPayload();
      return clone({
        ...status,
        visionResult: p.visionResult,
        navigationEstimate: p.navigationEstimate,
        diagnostics: p.diagnostics,
        companion_version: p.version,
        config: { ...config, runtime: { ...config.runtime, ...runtime } },
        policy,
        policyPreview: { ...healthyPolicyPreview(), policy },
        api_version: "1",
        health,
      });
    },
  };

  client.paths = COMPANION_V1_PATHS;
  return client;
}
