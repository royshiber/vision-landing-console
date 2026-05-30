/**
 * Sim lab — Three.js mirrored from SSE telemetry (+ optional .tlog replay).
 * MANUAL_CONTROL flows through /api/mavlink/manual-control (gamepad and/or WASD/arrows throttle).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.getElementById('simLabCanvas');

if (!canvas) {
  /* skip — אין אלמנט בממשק */
} else {
  const VLC_TOOLTIP_IAS_FROM_GS =
    'מהירות מוצגת כפרוקסי ממהירות קרקע — לא מד טיוח אוויר (IAS). בתנאי רוח גבית/ראשית ערך זה אינו מהימן לסטול.';
  const VLC_TOOLTIP_HUD_TIME_SKEW =
    'פער זמן בין חבילות MAVLink — ייתכן עיוות זמני בין אופק לשאר מדי ה-HUD.';

  const horizonCanvas = document.getElementById('simLabHorizon');
  const hudConn = document.getElementById('simLabHudConn');
  const hudAtt = document.getElementById('simLabHudAtt');
  const hudHeading = document.getElementById('simLabHudHeading');
  const hudAirspeed = document.getElementById('simLabHudAirspeed');
  const hudAltitude = document.getElementById('simLabHudAltitude');
  const hudGroundspeed = document.getElementById('simLabHudGroundspeed');
  const gpEl = document.getElementById('simLabGamepadStatus');
  const rcHint = document.getElementById('simLabRcHint');
  const rcToggle = document.getElementById('simLabRcSendToggle');
  const replayMeta = document.getElementById('simLabReplayMeta');
  const replayControls = document.getElementById('simLabReplayControls');
  const replaySeek = document.getElementById('simLabReplaySeek');
  const replaySpeedSel = document.getElementById('simLabReplaySpeed');
  const replayStripWrap = document.getElementById('simLabReplayStripWrap');
  const replayEventStrip = document.getElementById('simLabReplayEventStrip');
  const replayEventList = document.getElementById('simLabReplayEventList');
  const mapWrap = document.getElementById('simLabMapWrap');
  const mapCaption = document.getElementById('simLabMapCaption');

  // Pre-flight dashboard elements
  const pfBar    = document.getElementById('simLabPreflightBar');
  const pfArmed  = document.getElementById('simLabPfArmed');
  const pfMode   = document.getElementById('simLabPfMode');
  const pfGps    = document.getElementById('simLabPfGps');
  const pfBatt   = document.getElementById('simLabPfBatt');
  const pfFcLog  = document.getElementById('simLabFcLog');

  // ArduPlane custom-mode numbers → names
  const AP_MODES = {
    0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO',
    5: 'FBW-A', 6: 'FBW-B', 7: 'CRUISE', 8: 'AUTOTUNE',
    10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'ADSB',
    15: 'GUIDED', 16: 'INIT', 17: 'QSTABILIZE', 18: 'QHOVER',
    19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE',
    23: 'QACRO', 24: 'THERMAL', 25: 'LOITER_ALT',
  };

  let renderer;
  let scene;
  let camera;
  let planeGroup;
  let originLat = null;
  let originLon = null;
  let lastConnected = false;

  /** @type {{ tMs: number, rollDeg: number, pitchDeg: number, heading: number|null, altitude: number|null, lat: number|null, lon: number|null }[]} */
  let replaySamples = [];
  let replayIdx = 0;
  let replayPlaying = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let replayTimer = null;
  /** When true, mesh pose comes from replaySamples not live telemetry */
  let replayDrivingMesh = false;

  /** @type {{ kind?: string, tMs?: number, label?: string, sampleIndexApprox?: number, severity?: number }[]} */
  let replayEvents = [];

  /** Leaflet mini-map + terrain mirror */
  let simLabLeafMap = null;
  /** @type {{ track: object | null, plane: object | null }} */
  const simLabMini = { track: null, plane: null };

  let manualControlAllowed = false;
  let lastRcSendMs = 0;

  const camOffset = new THREE.Vector3(-168, 86, 168);
  const rad = Math.PI / 180;

  const SIM_STACK_KEY = 'vlcSimLabStackProfile';
  const SIM_VFX_KEY = 'vlcSimLabVfxSimulator';
  const SIM_AIRCRAFT_URL_KEY = 'vlcSimLabAircraftUrl';
  const SIM_PHOTO_DECOR_URL_KEY = 'vlcSimLabPrimitivePhotoDecorUrl';
  const SIM_MAP_BASE_KEY = 'vlcSimLabMapBasemap';

  const DOC_SIM_LAB = '/docs/SITL_AND_SIM_LAB.md';

  const gltfLoader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  /** @type {THREE.Group|null} */
  let primitivePlaneGroup = null;
  /** @type {THREE.MeshStandardMaterial|null} */
  let primitiveMatFuselage = null;
  /** @type {THREE.MeshStandardMaterial|null} */
  let primitiveMatWing = null;
  /** טקסטורת צילום על הפרימיטיב בלבד (לא מודל GLB שלם) */
  /** @type {THREE.Texture|null} */
  let primitivePhotoTexture = null;

  /** מאגר מקומי לגודל ידוע מהשרת (רשימת נכסים / העלאה) — HEAD ממילא איטי/לא תמיד זמין */
  const glbByteLengthHintByUrl = new Map();

  const GLB_MAX_BYTES = 45 * 1024 * 1024;
  const GLB_WARN_BYTES = 8 * 1024 * 1024;

  async function probeUploadedGlbByteLength(urlPath) {
    try {
      const res = await fetch(urlPath, { method: 'HEAD', cache: 'no-store' });
      const cl = res.headers.get('content-length');
      const n = cl ? Number(cl) : NaN;
      if (res.ok && Number.isFinite(n) && n >= 0) return n;
    } catch {
      /* ignore-network */
    }
    return null;
  }
  /** @type {THREE.Object3D|null} */
  let loadedAircraftRoot = null;

  /** @type {L.TileLayer|L.GridLayer|null} */
  let simLabBaseLayer = null;

  /** @type {THREE.Vector3 | null} */
  let desiredCamPos = null;
  /** @type {THREE.Vector3 | null} */
  let desiredLookAt = null;
  /** @type {THREE.Vector3 | null} */
  let tmpLookAt = null;
  let simLabVfxSmoothCam = true;
  /** PFD-style HUD (reuse main HUD canvas pattern — compact cockpit tape) */
  let simLabHudRollDeg = 0;
  let simLabHudPitchDeg = 0;
  let simLabHorizonSized = false;
  /** Terrain gradient under grid */
  let simLabGroundMesh = null;
  /** @type {THREE.Texture | null} */
  let simLabSkyTexture = null;
  /** @type {THREE.Group | null} */
  let simLabRunwayGroup = null;

  /** @type {Record<string, string>} */
  let arduShortById = { ap44: '4.4.x', ap45: '4.5.x', ap46: '4.6/dev', custom: 'מותאם' };

  function buildGradientSkyTexture(THREElib) {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#15365e');
    g.addColorStop(0.42, '#4e8bc4');
    g.addColorStop(0.72, '#9ec5eb');
    g.addColorStop(1, '#e8eef5');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 512);
    const tex = new THREElib.CanvasTexture(c);
    if (THREElib.SRGBColorSpace) tex.colorSpace = THREElib.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Subtle graded «terrain» under the runway — visuals only (physics live in SITL).
   */
  function buildTerrainGradientTexture(THREElib) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#2d5438');
    g.addColorStop(0.28, '#1e3828');
    g.addColorStop(0.55, '#162a26');
    g.addColorStop(0.82, '#1e3040');
    g.addColorStop(1, '#132635');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 16, 512);
    const tex = new THREElib.CanvasTexture(c);
    if (THREElib.SRGBColorSpace) tex.colorSpace = THREElib.SRGBColorSpace;
    tex.needsUpdate = true;
    tex.wrapS = THREElib.RepeatWrapping;
    tex.wrapT = THREElib.ClampToEdgeWrapping;
    return tex;
  }

  /** Compact circular artificial horizon — same visual language as `drawHorizon` in app.js */
  function drawSimMiniHorizon(c, rollDeg, pitchDeg) {
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    if (!W || !H) return;
    const cx = W / 2;
    const cy = H / 2;

    const roll = rollDeg ?? 0;
    const pitch = pitchDeg ?? 0;
    const rollRad = (roll * Math.PI) / 180;
    const pxPerDeg = H / 52;
    const pitchPx = Math.max(-H, Math.min(H, pitch * pxPerDeg));
    const diag = Math.sqrt(W * W + H * H);
    const clipR = Math.min(cx, cy) * 0.98;

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, clipR, 0, Math.PI * 2);
    ctx.clip();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rollRad);

    const skyGrad = ctx.createLinearGradient(0, -diag / 2 + pitchPx, 0, pitchPx);
    skyGrad.addColorStop(0, '#031329');
    skyGrad.addColorStop(0.5, '#0d4a94');
    skyGrad.addColorStop(1, '#1a73c9');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-diag, -diag + pitchPx, diag * 2, diag);

    const gndGrad = ctx.createLinearGradient(0, pitchPx, 0, pitchPx + diag * 0.62);
    gndGrad.addColorStop(0, '#5f4a36');
    gndGrad.addColorStop(0.45, '#3c2a17');
    gndGrad.addColorStop(1, '#1a140c');
    ctx.fillStyle = gndGrad;
    ctx.fillRect(-diag, pitchPx, diag * 2, diag);

    ctx.strokeStyle = 'rgba(160,215,255,0.9)';
    ctx.lineWidth = 1.35;
    ctx.shadowColor = 'rgba(110,185,255,0.65)';
    ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.moveTo(-diag, pitchPx); ctx.lineTo(diag, pitchPx); ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.font = `600 ${H * 0.055}px "Space Grotesk", monospace, sans-serif`;
    ctx.lineCap = 'round';
    for (let p = -25; p <= 25; p += 5) {
      if (p === 0) continue;
      const y = pitchPx - p * pxPerDeg;
      if (Math.abs(y) > diag * 0.5) continue;
      const big = p % 10 === 0;
      const hw = big ? W * 0.3 : W * 0.16;
      ctx.strokeStyle = big ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.32)';
      ctx.lineWidth = big ? 1.45 : 0.82;
      ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(hw, y); ctx.stroke();
      if (big) {
        const tk = H * 0.024;
        ctx.beginPath();
        ctx.moveTo(-hw, y); ctx.lineTo(-hw, y + (p > 0 ? tk : -tk));
        ctx.moveTo(hw, y); ctx.lineTo(hw, y + (p > 0 ? tk : -tk));
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.textAlign = 'right'; ctx.fillText(String(Math.abs(p)), -hw - 3, y + H * 0.018);
        ctx.textAlign = 'left';  ctx.fillText(String(Math.abs(p)), hw + 3, y + H * 0.018);
      }
    }
    ctx.lineCap = 'butt';
    ctx.restore();

    const aW = W * 0.2;
    const aY = cy;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#facc15';
    ctx.shadowColor = 'rgba(250,204,21,0.6)';
    ctx.shadowBlur = 5;
    ctx.lineWidth = 2.45;
    ctx.beginPath(); ctx.moveTo(cx - W * 0.042, aY); ctx.lineTo(cx - aW, aY + H * 0.02); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + W * 0.042, aY); ctx.lineTo(cx + aW, aY + H * 0.02); ctx.stroke();
    ctx.lineWidth = 1.95;
    ctx.beginPath(); ctx.moveTo(cx, aY); ctx.lineTo(cx, aY - H * 0.065); ctx.stroke();
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#facc15';
    ctx.beginPath(); ctx.arc(cx, aY, 3, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';

    ctx.restore();

    const bGrad = ctx.createLinearGradient(cx - clipR, cy - clipR, cx + clipR, cy + clipR);
    bGrad.addColorStop(0, 'rgba(100,155,235,0.45)');
    bGrad.addColorStop(0.5, 'rgba(25,52,112,0.28)');
    bGrad.addColorStop(1, 'rgba(100,155,235,0.45)');
    ctx.strokeStyle = bGrad;
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(cx, cy, clipR, 0, Math.PI * 2); ctx.stroke();
  }

  function syncSimMiniHorizon() {
    if (!horizonCanvas) return;
    drawSimMiniHorizon(horizonCanvas, simLabHudRollDeg, simLabHudPitchDeg);
  }

  /** @returns {HTMLElement|null} */
  function simLabFocusedInputAncestor() {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return null;
    const tag = ae.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      ae.contentEditable === 'true' ||
      (ae.dataset && ae.dataset.simlabIgnoreKb === '1')
    )
      return ae;
    try {
      if (ae.closest?.('[data-simlab-ignore-kb="1"]')) return ae;
    } catch {}
    return null;
  }

  function simLabTabActive() {
    return Boolean(document.querySelector('.tab[data-tab="simLab"]')?.classList.contains('active'));
  }

  const GP_DEAD = 0.084;
  const kb = {
    w: false,
    s: false,
    a: false,
    d: false,
    q: false,
    e: false,
    arrowUp: false,
    arrowDown: false,
    arrowLeft: false,
    arrowRight: false,
    throttleDec: false,
    throttleInc: false,
  };
  let kbThrottleZ = 0;

  /** @returns {boolean} consume keyboard (prevent scrolling) */
  function bindSimLabKeyboardRc() {
    function onDown(e) {
      if (!simLabTabActive()) return;
      if (simLabFocusedInputAncestor()) return;
      const wantRcKb = manualControlAllowed && rcToggle?.checked;
      const cd = e.code;
      switch (cd) {
        case 'KeyW':
        case 'ArrowUp':
          if (!wantRcKb) return;
          e.preventDefault();
          if (cd === 'KeyW') kb.w = true; else kb.arrowUp = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          e.preventDefault();
          if (cd === 'KeyS') kb.s = true; else kb.arrowDown = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          e.preventDefault();
          if (cd === 'KeyA') kb.a = true; else kb.arrowLeft = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          e.preventDefault();
          if (cd === 'KeyD') kb.d = true; else kb.arrowRight = true;
          break;
        case 'KeyQ':
          kb.q = true;
          e.preventDefault();
          break;
        case 'KeyE':
          kb.e = true;
          e.preventDefault();
          break;
        case 'BracketLeft':
        case 'Comma':
          kb.throttleDec = true;
          e.preventDefault();
          break;
        case 'BracketRight':
        case 'Period':
          kb.throttleInc = true;
          e.preventDefault();
          break;
        default:
      }
    }
    function onUp(e) {
      const cd = e.code;
      switch (cd) {
        case 'KeyW':
          kb.w = false;
          break;
        case 'KeyS':
          kb.s = false;
          break;
        case 'KeyA':
          kb.a = false;
          break;
        case 'KeyD':
          kb.d = false;
          break;
        case 'KeyQ':
          kb.q = false;
          break;
        case 'KeyE':
          kb.e = false;
          break;
        case 'ArrowUp':
          kb.arrowUp = false;
          break;
        case 'ArrowDown':
          kb.arrowDown = false;
          break;
        case 'ArrowLeft':
          kb.arrowLeft = false;
          break;
        case 'ArrowRight':
          kb.arrowRight = false;
          break;
        case 'BracketLeft':
        case 'Comma':
          kb.throttleDec = false;
          break;
        case 'BracketRight':
        case 'Period':
          kb.throttleInc = false;
          break;
        default:
      }
    }
    window.addEventListener('keydown', onDown, false);
    window.addEventListener('keyup', onUp, false);
    return () => {
      window.removeEventListener('keydown', onDown, false);
      window.removeEventListener('keyup', onUp, false);
    };
  }

  bindSimLabKeyboardRc();

  /** Match gamepad semantics in RAF loop (-1000…1000) */
  function buildMergedManualsticks() {
    const gp = navigator.getGamepads?.() ? navigator.getGamepads()[0] : null;
    const ax = gp?.axes || [];

    const pitchKb = kb.w || kb.arrowUp ? -0.78 : kb.s || kb.arrowDown ? 0.78 : null;
    const rollKb = kb.d || kb.arrowRight ? 0.78 : kb.a || kb.arrowLeft ? -0.78 : null;
    const yawKb = kb.e ? 0.72 : kb.q ? -0.72 : null;

    const gp3 = ax[3] ?? 0;
    const gp2 = ax[2] ?? 0;
    const gp1 = ax[1] ?? 0;
    const gp0 = ax[0] ?? 0;

    let axPitch = gp3;
    if (pitchKb != null) {
      const useGp = gp && Math.abs(gp3) > GP_DEAD;
      axPitch = useGp ? gp3 : pitchKb;
    }

    let axRoll = gp2;
    if (rollKb != null) {
      const useGp = gp && Math.abs(gp2) > GP_DEAD;
      axRoll = useGp ? gp2 : rollKb;
    }

    let axYaw = gp0;
    if (yawKb != null) {
      const useGp = gp && Math.abs(gp0) > GP_DEAD;
      axYaw = useGp ? gp0 : yawKb;
    }

    let axThrust = gp1;
    const useGpThr = gp && Math.abs(gp1) > GP_DEAD;
    axThrust = useGpThr ? gp1 : -kbThrottleZ / 1000;

    return {
      x: Math.round(-axPitch * 1000),
      y: Math.round(axRoll * 1000),
      z: Math.round(-axThrust * 1000),
      r: Math.round(axYaw * 1000),
    };
  }

  function formatTapeNum(n, suf, frac = 1) {
    return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(frac)}${suf}` : '—';
  }

  function formatHeading(h) {
    if (h == null || !Number.isFinite(Number(h))) return '—';
    const n = Math.round(((Number(h) % 360) + 360) % 360);
    return `${n}°`;
  }

  /** @param {*} mavlink */
  function updateInstrumentTapesFromMavlink(mavlink) {
    const spdBox = hudAirspeed?.closest('.sim-lab-tape-box');
    const altBox = hudAltitude?.closest('.sim-lab-tape-box');
    if (spdBox) {
      spdBox.classList.toggle('sim-lab-tape-box--airspeed-proxy', !!mavlink?.airspeedIsGroundspeedProxy);
      spdBox.title = mavlink?.airspeedIsGroundspeedProxy ? VLC_TOOLTIP_IAS_FROM_GS : '';
    }
    if (altBox) {
      altBox.classList.toggle('sim-lab-tape-box--time-skew', !!mavlink?.hudTimeSkewWarn);
      altBox.title = mavlink?.hudTimeSkewWarn ? VLC_TOOLTIP_HUD_TIME_SKEW : '';
    }
    if (hudHeading) hudHeading.textContent = mavlink?.connected ? formatHeading(mavlink.heading) : '—';
    if (hudAirspeed)
      hudAirspeed.textContent = mavlink?.connected ? formatTapeNum(mavlink.airspeed, ' m/s') : '—';
    if (hudAltitude)
      hudAltitude.textContent = mavlink?.connected ? formatTapeNum(mavlink.altitude, ' m') : '—';
    if (hudGroundspeed)
      hudGroundspeed.textContent = mavlink?.connected ? formatTapeNum(mavlink.groundspeed, ' m/s') : '—';

    simLabHudRollDeg = mavlink?.rollDeg ?? 0;
    simLabHudPitchDeg = mavlink?.pitchDeg ?? 0;
  }

  function updateInstrumentTapesFromReplaySample(s) {
    if (!s) return;
    if (hudHeading) hudHeading.textContent = formatHeading(s.heading);
    if (hudAirspeed) {
      hudAirspeed.textContent =
        s.airspeed != null && Number.isFinite(Number(s.airspeed))
          ? `${Number(s.airspeed).toFixed(1)} m/s`
          : '—';
    }
    if (hudAltitude) hudAltitude.textContent = s.altitude != null ? formatTapeNum(s.altitude, ' m') : '—';
    if (hudGroundspeed) {
      hudGroundspeed.textContent =
        s.groundspeed != null && Number.isFinite(Number(s.groundspeed))
          ? `${Number(s.groundspeed).toFixed(1)} m/s`
          : '—';
    }
    simLabHudRollDeg = s.rollDeg ?? 0;
    simLabHudPitchDeg = s.pitchDeg ?? 0;
  }

  /** Clear tapes when telemetry drops */
  function clearInstrumentTapes() {
    const spdBox = hudAirspeed?.closest('.sim-lab-tape-box');
    const altBox = hudAltitude?.closest('.sim-lab-tape-box');
    if (spdBox) {
      spdBox.classList.remove('sim-lab-tape-box--airspeed-proxy');
      spdBox.title = '';
    }
    if (altBox) {
      altBox.classList.remove('sim-lab-tape-box--time-skew');
      altBox.title = '';
    }
    if (hudHeading) hudHeading.textContent = '—';
    if (hudAirspeed) hudAirspeed.textContent = '—';
    if (hudAltitude) hudAltitude.textContent = '—';
    if (hudGroundspeed) hudGroundspeed.textContent = '—';
  }

  function updateCameraTargetsFromPlane() {
    if (!planeGroup || !camera || !desiredCamPos || !desiredLookAt || !tmpLookAt) return;
    desiredLookAt.copy(planeGroup.position);
    desiredCamPos.copy(planeGroup.position).add(camOffset);
    if (!simLabVfxSmoothCam) {
      camera.position.copy(desiredCamPos);
      tmpLookAt.copy(desiredLookAt);
      camera.lookAt(tmpLookAt);
    }
  }

  function applyVfxVisualMode(on) {
    if (!scene) return;
    simLabVfxSmoothCam = !!on;
    const v = !!on;
    if (v) {
      if (simLabSkyTexture) scene.background = simLabSkyTexture;
      scene.fog = new THREE.FogExp2(0xc5d9f7, 0.000058);
      if (simLabRunwayGroup) simLabRunwayGroup.visible = true;
    } else {
      /** מצב «קל»: עדיין שמים־גרדיאנט ומיפתח — לא ברק כמעט־שחור ובלי הסתרת מסלול. */
      scene.background = simLabSkyTexture
        ? simLabSkyTexture
        : new THREE.Color(0x2a4870);
      scene.fog = new THREE.Fog(0x5a7595, 1800, 14000);
      if (simLabRunwayGroup) simLabRunwayGroup.visible = true;
    }
    updateCameraTargetsFromPlane();
  }

  function loadStackProfile() {
    try {
      return JSON.parse(localStorage.getItem(SIM_STACK_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function syncArduCustomVisibility() {
    const sel = document.getElementById('simLabArduPreset');
    const wrap = document.getElementById('simLabArduCustomWrap');
    const custom = sel?.value === 'custom';
    if (wrap) wrap.classList.toggle('hidden', !custom);
  }

  function refreshSimLabStackHud() {
    const el = document.getElementById('simLabHudStack');
    if (!el) return;
    const apId = document.getElementById('simLabArduPreset')?.value;
    const cust = document.getElementById('simLabArduCustom')?.value?.trim();
    const jv = document.getElementById('simLabJetsonVer')?.value?.trim();
    const apShort = apId === 'custom' && cust ? cust : arduShortById[apId] || apId || '—';
    const parts = [`ArduPlane ${apShort}`];
    if (jv) parts.push(`Jetson ${jv}`);
    el.textContent = `פרופיל מסומן: ${parts.join(' · ')}`;
  }

  function saveStackProfile() {
    const arduPreset = document.getElementById('simLabArduPreset')?.value || '';
    const custom = document.getElementById('simLabArduCustom')?.value?.trim() || '';
    const jetson = document.getElementById('simLabJetsonVer')?.value || '';
    localStorage.setItem(SIM_STACK_KEY, JSON.stringify({ arduPreset, custom, jetson }));
    refreshSimLabStackHud();
  }

  async function initStackPresetsUi() {
    const arduSel = document.getElementById('simLabArduPreset');
    const jetSel = document.getElementById('simLabJetsonVer');
    const prof = loadStackProfile();
    try {
      const res = await fetch('/api/sim-lab/stack-presets');
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok && Array.isArray(j.arduPlane)) {
        arduShortById = Object.fromEntries(j.arduPlane.map((o) => [o.id, o.short || o.label]));
        if (arduSel) {
          arduSel.innerHTML = '';
          for (const o of j.arduPlane) {
            const opt = document.createElement('option');
            opt.value = o.id;
            opt.textContent = o.label;
            arduSel.appendChild(opt);
          }
          if (prof.arduPreset && [...arduSel.options].some((o) => o.value === prof.arduPreset)) {
            arduSel.value = prof.arduPreset;
          } else if ([...arduSel.options].some((o) => o.value === 'ap45')) {
            arduSel.value = 'ap45';
          }
        }
      }
      if (res.ok && j.ok && Array.isArray(j.jetson) && jetSel) {
        jetSel.innerHTML = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '— לא נבחר —';
        jetSel.appendChild(blank);
        for (const o of j.jetson) {
          const opt = document.createElement('option');
          opt.value = o.version;
          opt.textContent = o.label;
          jetSel.appendChild(opt);
        }
        if (prof.jetson && [...jetSel.options].some((o) => o.value === prof.jetson)) {
          jetSel.value = prof.jetson;
        }
      }
    } catch {
      /* presets optional */
    }
    if (arduSel && arduSel.options.length === 0) {
      arduShortById = { ap44: '4.4.x', ap45: '4.5.x', ap46: '4.6/dev', custom: 'מותאם' };
      const fallback = [
        { id: 'ap44', label: 'ArduPlane 4.4.x (מוכן לייצור)' },
        { id: 'ap45', label: 'ArduPlane 4.5.x' },
        { id: 'ap46', label: 'ArduPlane 4.6 / master' },
        { id: 'custom', label: 'גרסה מותאמת…' },
      ];
      for (const o of fallback) {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.label;
        arduSel.appendChild(opt);
      }
      if (prof.arduPreset && [...arduSel.options].some((x) => x.value === prof.arduPreset)) {
        arduSel.value = prof.arduPreset;
      } else {
        arduSel.value = 'ap45';
      }
    }
    const custInp = document.getElementById('simLabArduCustom');
    if (custInp && prof.custom) custInp.value = prof.custom;
    syncArduCustomVisibility();
    refreshSimLabStackHud();
  }

  function buildGpsTrack(samples) {
    return samples
      .filter((s) => s.lat != null && s.lon != null && Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .map((s) => [s.lat, s.lon]);
  }

  function simLabPlaneIcon(hdgDeg) {
    const r = Number.isFinite(hdgDeg) ? Number(hdgDeg) - 45 : -45;
    return L.divIcon({
      className: 'terrain-plane-icon-wrap',
      html: `<div class="terrain-plane-icon" style="color:#0b6bcb;transform:rotate(${r}deg)">✈</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  function gradientBasemapLayer() {
    const GradientCls = L.GridLayer.extend({
      createTile() {
        const tile = L.DomUtil.create('canvas', 'leaflet-tile');
        const s = this.getTileSize();
        tile.width = s.x;
        tile.height = s.y;
        const ctx = tile.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, s.y);
        g.addColorStop(0, '#c5ddf5');
        g.addColorStop(0.55, '#9eba84');
        g.addColorStop(1, '#2d4a32');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s.x, s.y);
        return tile;
      },
    });
    return new GradientCls();
  }

  function applySimLabMapBasemap(mode) {
    if (!simLabLeafMap || typeof L === 'undefined') return;
    const m = mode === 'satellite' ? 'satellite' : mode === 'gradient' ? 'gradient' : 'osm';
    try {
      localStorage.setItem(SIM_MAP_BASE_KEY, m);
    } catch {
      /* ignore */
    }
    if (simLabBaseLayer) {
      try {
        simLabLeafMap.removeLayer(simLabBaseLayer);
      } catch {
        /* ignore */
      }
      simLabBaseLayer = null;
    }
    if (m === 'satellite') {
      simLabBaseLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: '© Esri' },
      );
    } else if (m === 'gradient') {
      simLabBaseLayer = gradientBasemapLayer();
    } else {
      simLabBaseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      });
    }
    simLabBaseLayer.addTo(simLabLeafMap);
    const cap = document.getElementById('simLabMapBasemapCaption');
    const sel = document.getElementById('simLabMapBasemap');
    if (sel && sel.value !== m) sel.value = m;
    if (cap) {
      cap.textContent =
        m === 'satellite'
          ? 'רקע לוויין (Esri) — דורש רשת; עמידה בתנאי הספק באחריות המפעיל.'
          : m === 'gradient'
            ? 'רקע גרדיאנט מקומי — ללא אריחים חיצוניים'
            : 'מפת רקע: OpenStreetMap';
    }
  }

  function ensureSimLabMiniMap() {
    const mapEl = document.getElementById('simLabMapEl');
    if (simLabLeafMap || typeof L === 'undefined' || !mapEl) return simLabLeafMap;
    simLabLeafMap = L.map(mapEl, { zoomControl: true, worldCopyJump: true });
    simLabLeafMap.setView([31.5, 34.85], 13);
    let stored = 'osm';
    try {
      stored = localStorage.getItem(SIM_MAP_BASE_KEY) || 'osm';
    } catch {
      /* ignore */
    }
    applySimLabMapBasemap(stored);
    setTimeout(() => simLabLeafMap?.invalidateSize(), 120);
    return simLabLeafMap;
  }

  function hideSimLabMiniMap() {
    if (mapWrap) {
      mapWrap.classList.add('hidden');
      mapWrap.setAttribute('aria-hidden', 'true');
    }
    if (simLabMini.track && simLabLeafMap) {
      simLabLeafMap.removeLayer(simLabMini.track);
      simLabMini.track = null;
    }
    if (simLabMini.plane && simLabLeafMap) {
      simLabLeafMap.removeLayer(simLabMini.plane);
      simLabMini.plane = null;
    }
  }

  function syncTerrainReplayOverlay(s) {
    const o = window.__vlcSimLabReplayOverlay;
    if (!o || !s) return;
    if (s.lat != null && Number.isFinite(s.lat) && s.lon != null && Number.isFinite(s.lon)) {
      o.setSample(s.lat, s.lon, s.heading);
    }
  }

  function updateMiniPlaneMarker(s) {
    if (!simLabLeafMap || !s) return;
    if (s.lat == null || !Number.isFinite(s.lat) || s.lon == null || !Number.isFinite(s.lon)) return;
    const h = s.heading != null && Number.isFinite(s.heading) ? Number(s.heading) : null;
    if (!simLabMini.plane) {
      simLabMini.plane = L.marker([s.lat, s.lon], {
        icon: simLabPlaneIcon(h),
        title: 'שיחזור',
      }).addTo(simLabLeafMap);
    } else {
      simLabMini.plane.setLatLng([s.lat, s.lon]);
      simLabMini.plane.setIcon(simLabPlaneIcon(h));
    }
  }

  function uploadsUrlOk(u) {
    if (!u || typeof u !== 'string') return false;
    const s = u.trim();
    return s.startsWith('/uploads/') && !s.includes('..');
  }

  function disposePrimitivePhotoTexture() {
    if (primitiveMatFuselage) primitiveMatFuselage.map = null;
    if (primitiveMatWing) primitiveMatWing.map = null;
    if (primitivePhotoTexture) {
      primitivePhotoTexture.dispose?.();
      primitivePhotoTexture = null;
    }
    if (primitiveMatFuselage) primitiveMatFuselage.needsUpdate = true;
    if (primitiveMatWing) primitiveMatWing.needsUpdate = true;
  }

  /** מחזיר את גוף הקורח וכנף למראה פרימיטיב ברירת־מחדל (גוון אפור תעשייתי). */
  function resetPrimitiveGreyMaterials() {
    disposePrimitivePhotoTexture();
    if (primitiveMatFuselage) {
      primitiveMatFuselage.color.setHex(0xd8e2f0);
      primitiveMatFuselage.needsUpdate = true;
    }
    if (primitiveMatWing) {
      primitiveMatWing.color.setHex(0x9eb6d4);
      primitiveMatWing.needsUpdate = true;
    }
  }

  /** @param {'info'|'err'} severity */
  function flashSimLabAircraftNote(severity = 'info') {
    const st = document.getElementById('simLabAircraftStatus');
    if (!st) return;
    st.dataset.simLabFlashTone = severity;
    st.classList.remove('sim-lab-aircraft-status--flash');
    void st.offsetWidth;
    st.classList.add('sim-lab-aircraft-status--flash');
    window.setTimeout(() => {
      st.classList.remove('sim-lab-aircraft-status--flash');
      delete st.dataset.simLabFlashTone;
    }, 5500);
  }

  /** מבנה עזר — קישור למסמך ללא עריכת innerHTML בטוחה */
  function setSimLabPhotoStatusParagraph(msgBefore, msgAfter = '') {
    const st = document.getElementById('simLabAircraftStatus');
    if (!st) return;
    st.replaceChildren();
    if (msgBefore) st.appendChild(document.createTextNode(msgBefore));
    const a = document.createElement('a');
    a.href = DOC_SIM_LAB;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'sim-lab-aircraft-doclink';
    a.textContent = 'מסמך מעבדת SITL';
    st.appendChild(a);
    if (msgAfter) st.appendChild(document.createTextNode(msgAfter));
  }

  /** צילום מהשרת: מרקם על גוף פרימיטיב (לא יוצר תלת־ממד מכל צילום). */
  async function applyPrimitivePhotoDecorFromUrl(uploadUrl, opts = {}) {
    const { switchToPrimitive = false, silentStatus = false } = opts;
    const u = typeof uploadUrl === 'string' ? uploadUrl.trim() : '';
    const sceneReady = !!primitiveMatFuselage && !!primitiveMatWing;
    if (!uploadsUrlOk(u) || !sceneReady) {
      if (!silentStatus) {
        flashSimLabAircraftNote('err');
        setSimLabPhotoStatusParagraph(
          sceneReady
            ? 'כתובת תגית תמונה לא מורשית — צפוי ‎/uploads/⋯‎ מהשרת. '
            : 'מצב פרימיטיב עדיין לא מוכן — רעננו את הדף והפעילו טאב «מעבדה». ',
          '.',
        );
      }
      return { ok: false, message: 'bad_url_or_scene' };
    }
    if (switchToPrimitive) disposeLoadedGlb();
    disposePrimitivePhotoTexture();

    const tex = await new Promise((resolve) => {
      textureLoader.load(
        u,
        (loaded) => {
          if (THREE.SRGBColorSpace) loaded.colorSpace = THREE.SRGBColorSpace;
          loaded.wrapS = THREE.RepeatWrapping;
          loaded.wrapT = THREE.RepeatWrapping;
          resolve(loaded);
        },
        undefined,
        () => resolve(null),
      );
    });

    const ok = !!tex;
    if (ok) {
      primitivePhotoTexture = tex;
      primitiveMatFuselage.map = tex;
      primitiveMatFuselage.color.setHex(0xffffff);
      primitiveMatFuselage.needsUpdate = true;
      primitiveMatWing.map = tex;
      primitiveMatWing.color.setHex(0xffffff);
      primitiveMatWing.needsUpdate = true;
      if (primitivePlaneGroup) primitivePlaneGroup.visible = true;
      try {
        localStorage.setItem(SIM_PHOTO_DECOR_URL_KEY, u);
      } catch {
        /* quota */
      }
      if (!silentStatus) {
        flashSimLabAircraftNote('info');
        setSimLabPhotoStatusParagraph(
          'צילום: מרקם על פרימיטיב בלבד (לא משחלף GLB שלם). החלפת מודל בתלת־ממד: טעינת שורה בגלילה ובחירת ‎GLB‎ + כפתור «החל על התצוגה». מתקדמת ‎photogrammetry‎/SaaS: ',
          '.',
        );
      }
    } else {
      try {
        localStorage.removeItem(SIM_PHOTO_DECOR_URL_KEY);
      } catch {
        /* ignore */
      }
      if (!silentStatus) {
        flashSimLabAircraftNote('err');
        setSimLabPhotoStatusParagraph(
          'לא ניתן לטעון את הצילום ל-WebGL (‎MIME‎/אריכות/קידוד). הפחיתם רזולוציה או שמרו PNG/JPEG מאומתים. פירוט בתיעוד ',
          '.',
        );
      }
    }

    return { ok, message: ok ? '' : 'texture_load_failed' };
  }

  function normalizeImportedAircraft(root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    const target = 28;
    root.scale.setScalar(target / maxDim);
    const box2 = new THREE.Box3().setFromObject(root);
    const c = new THREE.Vector3();
    box2.getCenter(c);
    root.position.sub(c);
  }

  function disposeLoadedGlb() {
    if (!loadedAircraftRoot || !planeGroup) return;
    planeGroup.remove(loadedAircraftRoot);
    loadedAircraftRoot.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mm of mats) mm.dispose?.();
      }
      if (o.geometry) o.geometry.dispose?.();
    });
    loadedAircraftRoot = null;
  }

  function showPrimitiveAircraft() {
    disposeLoadedGlb();
    resetPrimitiveGreyMaterials();
    try {
      localStorage.removeItem(SIM_AIRCRAFT_URL_KEY);
      localStorage.removeItem(SIM_PHOTO_DECOR_URL_KEY);
    } catch {
      /* ignore */
    }
    const sel = document.getElementById('simLabAircraftSelect');
    if (sel) sel.value = '';
    const st = document.getElementById('simLabAircraftStatus');
    if (st) st.textContent = 'פרימיטיב גאומטרי ברירת־מחדל — ללא צילום';
  }

  async function applyAircraftGlbUrl(url, opts = {}) {
    if (!planeGroup || !url || typeof url !== 'string') return;
    const u = url.trim();
    if (!u.startsWith('/uploads/') || u.includes('..')) {
      const st = document.getElementById('simLabAircraftStatus');
      if (st) st.textContent = 'כתובת לא מורשית — רק /uploads/…';
      return;
    }
    const stEl = document.getElementById('simLabAircraftStatus');

    let byteLen =
      typeof opts.knownByteLength === 'number' && Number.isFinite(opts.knownByteLength)
        ? opts.knownByteLength
        : null;
    if (byteLen == null) {
      const cached = glbByteLengthHintByUrl.get(u);
      if (typeof cached === 'number' && Number.isFinite(cached)) byteLen = cached;
    }
    if (byteLen == null) byteLen = await probeUploadedGlbByteLength(u);

    if (byteLen != null && byteLen > GLB_MAX_BYTES) {
      if (stEl) {
        stEl.textContent =
          'קובץ ה-GLB גדול מדי (מעל 45MB) — דחוס או בחר נכס קטן יותר; הטעינה נחסמה ליציבות.';
      }
      return;
    }

    const largeWarn = byteLen != null && byteLen > GLB_WARN_BYTES;
    const unverified = byteLen == null;
    if (stEl) {
      stEl.textContent = unverified
        ? 'טוען מודל… · גודל לא אומת (ללא Content-Length)'
        : largeWarn
          ? 'טוען מודל… · אזהרה: קובץ גדול (>8MB) — עלול להאט'
          : 'טוען מודל…';
    }
    try {
      const gltf = await new Promise((resolve, reject) => {
        gltfLoader.load(u, resolve, undefined, reject);
      });
      disposeLoadedGlb();
      const root = gltf.scene || gltf.scenes?.[0];
      if (!root) throw new Error('empty gltf');
      loadedAircraftRoot = root;
      normalizeImportedAircraft(root);
      planeGroup.add(root);
      if (primitivePlaneGroup) primitivePlaneGroup.visible = false;
      try {
        localStorage.setItem(SIM_AIRCRAFT_URL_KEY, u);
      } catch {
        /* ignore */
      }
      let okMsg = 'מודל GLB נטען';
      if (largeWarn) okMsg += ' · הערה: קובץ גדול (>8MB)';
      if (unverified) okMsg += ' · הערה: גודל לא אומת לפני טעינה';
      if (stEl) stEl.textContent = okMsg;
    } catch {
      showPrimitiveAircraft();
      if (stEl) stEl.textContent = 'טעינת GLB נכשלה — חזרה לפרימיטיב';
    }
  }

  async function refreshAircraftModelList() {
    const sel = document.getElementById('simLabAircraftSelect');
    const st = document.getElementById('simLabAircraftStatus');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">פרימיטיב (ברירת מחדל)</option>';
    try {
      const res = await fetch('/api/sim-lab/aircraft-models');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        if (st) st.textContent = j.message || 'לא ניתן לטעון רשימת נכסים';
        return;
      }
      const glbCount = [];
      const items = Array.isArray(j.items) ? j.items : [];
      for (const it of items) {
        if (it.assetKind !== 'glb') continue;
        if (typeof it.url === 'string' && typeof it.sizeBytes === 'number' && Number.isFinite(it.sizeBytes)) {
          glbByteLengthHintByUrl.set(it.url, it.sizeBytes);
        }
        glbCount.push(it);
        const opt = document.createElement('option');
        opt.value = it.url;
        opt.textContent = `#${it.id} · ${it.originalName || 'glb'}`;
        sel.appendChild(opt);
      }
      let saved = '';
      try {
        saved = localStorage.getItem(SIM_AIRCRAFT_URL_KEY) || '';
      } catch {
        /* ignore */
      }
      const pick = prev && [...sel.options].some((o) => o.value === prev)
        ? prev
        : saved && [...sel.options].some((o) => o.value === saved)
          ? saved
          : '';
      sel.value = pick;
      if (st) {
        st.textContent =
          j.dbConfigured === false ? 'מסד לא זמין — רק פרימיטיב' : `${glbCount.length} קבצי GLB זמינים`;
      }
    } catch (e) {
      if (st) st.textContent = e?.message || 'שגיאת רשת ברשימת נכסים';
    }
  }

  /** After replaySamples loaded — track polyline + mini-map fit + terrain overlay track */
  function refreshReplayMapsAfterParse() {
    const o = window.__vlcSimLabReplayOverlay;
    const pts = buildGpsTrack(replaySamples);
    if (pts.length >= 2 && o) {
      o.setTrack(pts);
    } else if (o) {
      o.setTrack(null);
    }

    if (pts.length === 0) {
      hideSimLabMiniMap();
      if (mapCaption) mapCaption.textContent = 'אין נקודות GPS בלוג — המפה מוסתרת';
      return;
    }

    if (mapWrap) {
      mapWrap.classList.remove('hidden');
      mapWrap.setAttribute('aria-hidden', 'false');
    }
    if (mapCaption) {
      mapCaption.textContent = `מסלול GPS (${pts.length} נקודות) — מסונכן עם טאב «הטסה»`;
    }

    const m = ensureSimLabMiniMap();
    if (!m) return;

    if (pts.length >= 2) {
      if (!simLabMini.track) {
        simLabMini.track = L.polyline(pts, {
          color: '#00478d',
          weight: 3,
          opacity: 0.88,
        }).addTo(m);
      } else {
        simLabMini.track.setLatLngs(pts);
      }
    } else if (simLabMini.track) {
      m.removeLayer(simLabMini.track);
      simLabMini.track = null;
    }

    try {
      if (pts.length >= 2) m.fitBounds(pts, { padding: [28, 28], maxZoom: 16 });
      else m.setView(pts[0], 14);
    } catch {
      /* ignore */
    }
    setTimeout(() => m.invalidateSize(), 80);
  }

  function applyPoseFromPayload(mavlink) {
    if (!planeGroup || !mavlink) return;

    const conn = mavlink.connected !== false;

    const r = (typeof mavlink.rollDeg === 'number' && Number.isFinite(mavlink.rollDeg)) ? mavlink.rollDeg : 0;
    const p = (typeof mavlink.pitchDeg === 'number' && Number.isFinite(mavlink.pitchDeg)) ? mavlink.pitchDeg : 0;
    const y = (typeof mavlink.heading === 'number' && Number.isFinite(mavlink.heading)) ? mavlink.heading : 0;

    planeGroup.rotation.order = 'ZYX';
    planeGroup.rotation.z = -y * rad;
    planeGroup.rotation.y = p * rad;
    planeGroup.rotation.x = r * rad;

    let altM = mavlink.altitude != null ? Number(mavlink.altitude) : 90;
    if (!Number.isFinite(altM)) altM = 90;
    planeGroup.position.y = Math.max(15, altM);

    const map = mavlink.map;
    if (
      conn &&
      map &&
      map.gpsLat != null &&
      map.gpsLon != null &&
      Number.isFinite(map.gpsLat) &&
      Number.isFinite(map.gpsLon)
    ) {
      if (originLat == null) {
        originLat = map.gpsLat;
        originLon = map.gpsLon;
      }
      const dLat = (map.gpsLat - originLat) * 111000;
      const dLon = (map.gpsLon - originLon) * 111000 * Math.cos(originLat * rad);
      planeGroup.position.x = dLon;
      planeGroup.position.z = -dLat;
    } else if (!conn) {
      planeGroup.position.y = 90;
    }

    updateCameraTargetsFromPlane();
  }

  function sampleToHudPayload(s) {
    return {
      connected: true,
      rollDeg: s.rollDeg,
      pitchDeg: s.pitchDeg,
      heading: s.heading,
      altitude: s.altitude,
      map:
        s.lat != null && s.lon != null && Number.isFinite(s.lat) && Number.isFinite(s.lon)
          ? { gpsLat: s.lat, gpsLon: s.lon }
          : undefined,
    };
  }

  function applyReplayFrame(i) {
    const s = replaySamples[i];
    if (!s || !planeGroup) return;
    applyPoseFromPayload(sampleToHudPayload(s));
    syncTerrainReplayOverlay(s);
    updateMiniPlaneMarker(s);
    updateInstrumentTapesFromReplaySample(s);
    if (hudAtt) {
      const rr = Number(s.rollDeg ?? 0);
      const pp = Number(s.pitchDeg ?? 0);
      const yy = s.heading != null ? Number(s.heading) : 0;
      const alt = s.altitude != null ? Number(s.altitude).toFixed(1) : '—';
      hudAtt.textContent = `φ ${rr.toFixed(1)}°  θ ${pp.toFixed(1)}°  ψ ${yy.toFixed(0)}°  ALT ${alt} m · שיחזור`;
    }
  }

  function clearReplayTimer() {
    if (replayTimer != null) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  }

  /**
   * @param {number} idx
   * @param {{ suspendPlay?: boolean }} opts
   */
  function seekReplayInstant(idx, opts = {}) {
    const { suspendPlay = true } = opts;
    if (!replaySamples.length) return;
    const i = Math.max(
      0,
      Math.min(replaySamples.length - 1, Number.isFinite(Number(idx)) ? Math.trunc(Number(idx)) : 0),
    );
    replayIdx = i;
    if (suspendPlay) {
      replayPlaying = false;
      clearReplayTimer();
    }
    if (replaySeek) replaySeek.value = String(i);
    applyReplayFrame(i);
  }

  /** Clears replay event strip + rows (markers may be empty independently). */
  function clearReplayTimelineDom() {
    if (replayStripWrap) {
      replayStripWrap.classList.add('hidden');
      replayStripWrap.setAttribute('aria-hidden', 'true');
    }
    if (replayEventStrip) replayEventStrip.replaceChildren();
    if (replayEventList) replayEventList.replaceChildren();
  }

  function refreshReplayMarkersAndList() {
    if (!replayEventStrip || !replayEventList || !replayStripWrap) return;
    replayEventStrip.replaceChildren();
    replayEventList.replaceChildren();

    const evs = Array.isArray(replayEvents) ? replayEvents : [];
    if (!replaySamples.length || !evs.length) {
      replayStripWrap.classList.add('hidden');
      replayStripWrap.setAttribute('aria-hidden', 'true');
      return;
    }

    const t0 = replaySamples[0].tMs ?? 0;
    const tLast = replaySamples[replaySamples.length - 1].tMs ?? t0;
    const spanMs = Math.max(1, tLast - t0);

    for (const ev of evs) {
      const pctRaw = ((((ev?.tMs ?? t0) - t0) / spanMs) * 100);
      const pct = Math.max(0, Math.min(100, pctRaw));
      const m = document.createElement('button');
      m.type = 'button';
      m.className = 'sim-lab-event-mark';
      m.dataset.kind = String(ev.kind || 'statustext');
      m.style.left = `${pct}%`;
      m.title = String(ev.label || ev.kind || 'אירוע');
      const al = `${String(ev.kind || 'event')} @ +${((((ev?.tMs ?? t0) - t0) / 1000) || 0).toFixed(1)} s`;
      m.setAttribute('aria-label', al);
      m.addEventListener('click', (e) => {
        e.preventDefault();
        seekReplayInstant(Number(ev.sampleIndexApprox) || 0, { suspendPlay: true });
      });
      replayEventStrip.appendChild(m);
    }

    for (const ev of evs) {
      const row = document.createElement('div');
      row.className = 'sim-lab-event-row';
      const meta = document.createElement('div');
      meta.className = 'sim-lab-event-row-meta';
      const kindEl = document.createElement('span');
      kindEl.className = 'sim-lab-event-kind';
      kindEl.textContent = String(ev.kind || '—').toUpperCase();
      const timeEl = document.createElement('span');
      const offS = ((ev?.tMs ?? t0) - t0) / 1000;
      timeEl.textContent = `${offS >= 0 ? '+' : ''}${offS.toFixed(1)} s`;

      meta.appendChild(kindEl);
      meta.appendChild(timeEl);

      const lab = document.createElement('div');
      lab.className = 'sim-lab-event-label';
      lab.textContent = String(ev.label || '');

      const jb = document.createElement('button');
      jb.type = 'button';
      jb.className = 'sim-lab-event-jump';
      jb.textContent = 'קפיצה למסגרת';
      jb.addEventListener('click', () => seekReplayInstant(Number(ev.sampleIndexApprox) || 0, { suspendPlay: true }));

      row.appendChild(meta);
      row.appendChild(lab);
      row.appendChild(jb);
      replayEventList.appendChild(row);
    }

    replayStripWrap.classList.remove('hidden');
    replayStripWrap.setAttribute('aria-hidden', 'false');
  }

  function replayScheduleStep() {
    clearReplayTimer();
    if (!replayPlaying || !replaySamples.length) return;
    const speed = Number(replaySpeedSel?.value) || 1;
    const i = replayIdx;
    if (i >= replaySamples.length - 1) {
      replayPlaying = false;
      return;
    }
    const cur = replaySamples[i];
    const next = replaySamples[i + 1];
    let dt = (next.tMs ?? 0) - (cur.tMs ?? 0);
    if (!Number.isFinite(dt) || dt < 1) dt = 70;
    dt = Math.max(16, Math.min(4000, dt / speed));

    replayTimer = setTimeout(() => {
      replayIdx++;
      if (replaySeek) replaySeek.value = String(replayIdx);
      applyReplayFrame(replayIdx);
      replayScheduleStep();
    }, dt);
  }

  function initThree() {
    function fitRendererToWrap() {
      const parentEl = canvas.parentElement;
      if (!parentEl) return { w: 720, h: 405 };
      const rect = parentEl.getBoundingClientRect();
      const w = Math.max(320, rect.width || 640);
      const h = Math.max(260, rect.height || (w * 9) / 16);
      return { w, h };
    }

    const initial = fitRendererToWrap();
    const w = initial.w;
    const h = initial.h;

    scene = new THREE.Scene();
    simLabSkyTexture = buildGradientSkyTexture(THREE);
    scene.background = simLabSkyTexture;
    scene.fog = new THREE.FogExp2(0xc5dae8, 0.00006);

    camera = new THREE.PerspectiveCamera(40, w / h, 2, 500000);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
    }

    scene.add(new THREE.HemisphereLight(0xc6ddff, 0x55382a, 0.92));
    const sun = new THREE.DirectionalLight(0xfff8ec, 1.06);
    sun.position.set(520, 860, 360);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xa8bde6, 0.14));

    const grid = new THREE.GridHelper(5200, 52, 0x6f98c8, 0x394b68);
    const gm = grid.material;
    if (gm) {
      const mats = Array.isArray(gm) ? gm : [gm];
      for (const m of mats) {
        m.transparent = true;
        m.opacity = 0.42;
      }
    }
    scene.add(grid);

    const terrainGradient = buildTerrainGradientTexture(THREE);
    terrainGradient.repeat.set(1, 1);
    simLabGroundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(28000, 28000),
      new THREE.MeshStandardMaterial({
        map: terrainGradient,
        roughness:  1,
        metalness:  0,
        envMapIntensity: 0,
      }),
    );
    simLabGroundMesh.receiveShadow = false;
    simLabGroundMesh.rotation.x = -Math.PI / 2;
    simLabGroundMesh.position.y = -0.02;
    scene.add(simLabGroundMesh);

    simLabRunwayGroup = new THREE.Group();
    const rwMat = new THREE.MeshStandardMaterial({ color: 0x2c3848, roughness: 0.96, metalness: 0.04 });
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(32, 6200), rwMat);
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(0, 0.06, 0);
    simLabRunwayGroup.add(runway);
    const dashGeo = new THREE.BoxGeometry(0.4, 0.05, 12);
    const dashMat = new THREE.MeshStandardMaterial({
      color: 0xffc94d,
      emissive: 0x886600,
      emissiveIntensity: 0.45,
      roughness: 0.45,
    });
    for (let z = -3000; z <= 3000; z += 80) {
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.position.set(0, 0.1, z);
      simLabRunwayGroup.add(dash);
    }
    scene.add(simLabRunwayGroup);

    const sunOrb = new THREE.Mesh(
      new THREE.SphereGeometry(420, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffeecc, fog: false, transparent: true, opacity: 0.95 }),
    );
    sunOrb.position.set(-5200, 2600, -9800);
    scene.add(sunOrb);

    planeGroup = new THREE.Group();
    primitivePlaneGroup = new THREE.Group();
    const matFuselage = new THREE.MeshStandardMaterial({ color: 0xd8e2f0, metalness: 0.42, roughness: 0.48 });
    const matWing = new THREE.MeshStandardMaterial({ color: 0x9eb6d4, metalness: 0.28, roughness: 0.52 });
    const fuselage = new THREE.Mesh(new THREE.BoxGeometry(11, 5, 30), matFuselage);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(56, 2.8, 14), matWing);
    wing.position.y = 0.5;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(4, 15, 9), matFuselage);
    tail.position.set(0, 5, -19);
    primitivePlaneGroup.add(fuselage, wing, tail);
    primitiveMatFuselage = matFuselage;
    primitiveMatWing = matWing;
    planeGroup.add(primitivePlaneGroup);
    planeGroup.position.set(0, 90, 0);
    scene.add(planeGroup);

    desiredCamPos = new THREE.Vector3();
    desiredLookAt = new THREE.Vector3();
    tmpLookAt = new THREE.Vector3();
    desiredCamPos.copy(planeGroup.position).add(camOffset);
    desiredLookAt.copy(planeGroup.position);
    tmpLookAt.copy(desiredLookAt);
    camera.position.copy(desiredCamPos);
    camera.lookAt(tmpLookAt);

    function loop() {
      requestAnimationFrame(loop);

      if (camera && planeGroup && simLabVfxSmoothCam && desiredCamPos && tmpLookAt && desiredLookAt) {
        camera.position.lerp(desiredCamPos, 0.078);
        tmpLookAt.lerp(desiredLookAt, 0.13);
        camera.lookAt(tmpLookAt);
      }

      const gps = navigator.getGamepads && navigator.getGamepads()[0];
      const tabActive = !!document.querySelector('.tab[data-tab="simLab"]')?.classList.contains('active');
      if (gpEl) {
        gpEl.textContent = gps
          ? `${gps.id}`
          : 'לא זוהה משחקון/שלט USB — במקום זה השתמש במקשים (כשיש הרשאה וסימון «שליחה»)';
      }

      const stickIn = kb.throttleInc;
      const stickOut = kb.throttleDec;
      if (stickIn && !stickOut) kbThrottleZ = Math.min(1000, kbThrottleZ + 36);
      else if (stickOut && !stickIn) kbThrottleZ = Math.max(-1000, kbThrottleZ - 36);

      function kbAnyHeld() {
        return (
          kb.w ||
          kb.s ||
          kb.a ||
          kb.d ||
          kb.q ||
          kb.e ||
          kb.arrowUp ||
          kb.arrowDown ||
          kb.arrowLeft ||
          kb.arrowRight ||
          kb.throttleInc ||
          kb.throttleDec ||
          kbThrottleZ !== 0
        );
      }

      const now = performance.now();
      const wantRcSend =
        manualControlAllowed &&
        rcToggle?.checked &&
        tabActive &&
        !!(gps || kbAnyHeld());

      const st = buildMergedManualsticks();
      const hasGpStick =
        gps &&
        (Math.abs(gps.axes?.[3] ?? 0) > GP_DEAD ||
          Math.abs(gps.axes?.[2] ?? 0) > GP_DEAD ||
          Math.abs(gps.axes?.[1] ?? 0) > GP_DEAD ||
          Math.abs(gps.axes?.[0] ?? 0) > GP_DEAD);

      const significant =
        Math.abs(st.x) > 42 ||
        Math.abs(st.y) > 42 ||
        Math.abs(st.z) > 42 ||
        Math.abs(st.r) > 42;

      const shouldBurst = hasGpStick ? true : significant;

      if (wantRcSend && shouldBurst && now - lastRcSendMs >= 66) {
        lastRcSendMs = now;
        const { x, y, z, r } = st;
        fetch('/api/mavlink/manual-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y, z, r, buttons: 0 }),
          keepalive: true,
        }).catch(() => {});
      }

      syncSimMiniHorizon();

      renderer.render(scene, camera);
    }
    loop();
  }

  const simLabQsEl = document.getElementById('simLabQuickstart');

  // ── Pre-flight dashboard helpers ───────────────────────────────────────────
  function setChip(el, valText, state) {
    if (!el) return;
    const valEl = el.querySelector('.sl-pf-val');
    if (valEl) valEl.textContent = valText;
    el.className = `sl-pf-chip sl-pf-chip--${state}`;
  }

  function updatePreflightBar(m) {
    // Armed / Disarmed
    if (m.armedKnown) {
      if (m.armed) {
        setChip(pfArmed, '⚡ מזויין', 'err');
      } else {
        setChip(pfArmed, '🔒 לא מזויין', 'ok');
      }
    } else {
      setChip(pfArmed, '—', 'neutral');
    }

    // Flight mode name
    if (m.flightMode != null) {
      const name = AP_MODES[m.flightMode] ?? `MODE ${m.flightMode}`;
      setChip(pfMode, name, 'neutral');
    } else {
      setChip(pfMode, '—', 'neutral');
    }

    // GPS
    if (m.gpsFixType != null) {
      const fix = m.gpsFixType;
      const sats = m.gpsSats ?? 0;
      let gpsState, gpsText;
      if (fix >= 3 && sats >= 6) {
        gpsState = 'ok';
        gpsText = `3D-Fix · ${sats} לוויינים`;
      } else if (fix >= 3) {
        gpsState = 'warn';
        gpsText = `3D · ${sats} לוויינים`;
      } else if (fix >= 2) {
        gpsState = 'warn';
        gpsText = `2D · ${sats} לוויינים`;
      } else if (fix === 1) {
        gpsState = 'err';
        gpsText = 'GPS ← אין נעילה';
      } else {
        gpsState = 'err';
        gpsText = 'אין GPS';
      }
      setChip(pfGps, gpsText, gpsState);
    } else {
      setChip(pfGps, '—', 'neutral');
    }

    // Battery
    if (m.batteryPct != null && m.batteryPct >= 0) {
      const pct = m.batteryPct;
      const vStr = m.batteryV != null ? ` ${m.batteryV.toFixed(1)}V` : '';
      const battState = pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'err';
      setChip(pfBatt, `${pct}%${vStr}`, battState);
    } else if (m.batteryV != null) {
      setChip(pfBatt, `${m.batteryV.toFixed(1)}V`, 'neutral');
    } else {
      setChip(pfBatt, '—', 'neutral');
    }

    // FC messages (statustext)
    if (pfFcLog && Array.isArray(m.recentStatusTexts) && m.recentStatusTexts.length > 0) {
      const items = m.recentStatusTexts.slice(0, 10);
      pfFcLog.replaceChildren(...items.map((st) => {
        const div = document.createElement('div');
        const sev = typeof st.severity === 'number' ? st.severity : 6;
        let cls = 'sl-pf-log-item';
        if (sev <= 2) cls += ' sl-pf-log-item--crit';
        else if (sev <= 4) cls += ' sl-pf-log-item--warn';
        div.className = cls;
        div.textContent = st.text || '';
        return div;
      }));
    } else if (pfFcLog) {
      pfFcLog.replaceChildren();
    }
  }

  function updateHudLive(mavlink) {
    const conn = !!mavlink?.connected;
    if (!conn && lastConnected) {
      originLat = null;
      originLon = null;
      if (!replayDrivingMesh && planeGroup) {
        planeGroup.position.x = 0;
        planeGroup.position.z = 0;
      }
      // Transition: connected → disconnected — go back to wizard step 2
      if (!replayDrivingMesh) {
        document.getElementById('simLabQuickstart')?.classList.remove('hidden');
        document.getElementById('simLabPreflightBar')?.classList.add('hidden');
        wizardGoStep(2);
      }
    }
    // Transition: disconnected → connected — advance wizard to step 3, then hide it
    if (conn && !lastConnected && !replayDrivingMesh) {
      wizardGoStep(3);
      setTimeout(() => {
        document.getElementById('simLabQuickstart')?.classList.add('hidden');
        document.getElementById('simLabPreflightBar')?.classList.remove('hidden');
      }, 800);
    }
    lastConnected = conn;

    // Show/hide quickstart guide based on connection state
    if (simLabQsEl) {
      simLabQsEl.classList.toggle('hidden', conn || replayDrivingMesh);
    }

    // Show/hide pre-flight dashboard
    if (pfBar) {
      pfBar.classList.toggle('hidden', !conn || replayDrivingMesh);
    }
    if (conn && mavlink && !replayDrivingMesh) {
      updatePreflightBar(mavlink);
    }

    const replaySuffix =
      replayDrivingMesh && replaySamples.length ? ` · שיחזור ${replayIdx + 1}/${replaySamples.length}` : '';

    if (hudConn) {
      hudConn.textContent = conn
        ? `מחובר · ${mavlink.autopilotName || 'FC'} · מוד ${mavlink.flightMode ?? '—'}${replaySuffix}`
        : `אין חיבור FC — הרץ SITL והגדר UDP/TCP במסמך המעבדה${replaySuffix}`;
    }

    if (!replayDrivingMesh && mavlink && hudAtt) {
      const r = (typeof mavlink.rollDeg === 'number' && Number.isFinite(mavlink.rollDeg)) ? mavlink.rollDeg : 0;
      const p = (typeof mavlink.pitchDeg === 'number' && Number.isFinite(mavlink.pitchDeg)) ? mavlink.pitchDeg : 0;
      const y = (typeof mavlink.heading === 'number' && Number.isFinite(mavlink.heading)) ? mavlink.heading : 0;
      const altRaw = mavlink.altitude != null ? Number(mavlink.altitude) : NaN;
      const alt = Number.isFinite(altRaw) ? altRaw.toFixed(1) : '—';
      let ias = '—';
      if (mavlink.connected && mavlink.airspeed != null && Number.isFinite(Number(mavlink.airspeed))) {
        ias = Number(mavlink.airspeed).toFixed(1);
      }
      const iasSim = mavlink.airspeedIsGroundspeedProxy ? ' (SIM)' : '';
      hudAtt.textContent = `φ ${r.toFixed(1)}° · θ ${p.toFixed(1)}° · ψ ${y.toFixed(0)}° · ALT ${alt} m · IAS ${ias}${iasSim} m/s`;
    }

    if (!replayDrivingMesh) {
      if (conn && mavlink) updateInstrumentTapesFromMavlink(mavlink);
      else clearInstrumentTapes();
    }
  }

  function onTelemetry(ev) {
    const mavlink = ev.detail?.mavlink;
    updateHudLive(mavlink);

    if (replayDrivingMesh || !planeGroup || !mavlink) return;

    applyPoseFromPayload(mavlink);
  }

  document.addEventListener('vlc:telemetry', onTelemetry);

  async function refreshRcCapability() {
    try {
      const res = await fetch('/api/sim-lab/rc-capability');
      const j = await res.json().catch(() => ({}));
      manualControlAllowed = !!j.manualControlAllowed;
      if (rcHint) {
        rcHint.textContent = manualControlAllowed
          ? 'השרת מאשר שליחת MANUAL_CONTROL — השתמש רק ב-SITL.'
          : 'שליחת MANUAL_CONTROL מהדפדפן כבויה (ALLOW_BROWSER_MANUAL_CONTROL≠1).';
      }
      if (rcToggle) {
        rcToggle.disabled = !manualControlAllowed;
        if (!manualControlAllowed) rcToggle.checked = false;
      }
    } catch {
      manualControlAllowed = false;
      if (rcToggle) {
        rcToggle.disabled = true;
        rcToggle.checked = false;
      }
      if (rcHint) rcHint.textContent = 'לא ניתן לבדוק הרשאת שליטה מהשרת.';
    }
  }

  function resize() {
    const parentEl = canvas?.parentElement;
    if (!renderer || !camera || !parentEl) return;
    const rect = parentEl.getBoundingClientRect();
    const w = Math.max(320, rect.width || 640);
    const h = Math.max(260, rect.height || (w * 9) / 16);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    if (horizonCanvas) {
      const wrap = horizonCanvas.closest('.sim-lab-pfd-mini');
      const r2 = wrap?.getBoundingClientRect();
      const css = Math.round(r2?.width ?? 176);
      const pr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.max(128, Math.floor(css * pr));
      if (horizonCanvas.width !== px) {
        horizonCanvas.width = px;
        horizonCanvas.height = px;
        simLabHorizonSized = true;
      }
      syncSimMiniHorizon();
    }
  }

  window.addEventListener('resize', resize);

  document.querySelector('.tab[data-tab="simLab"]')?.addEventListener('click', () => {
    setTimeout(() => {
      resize();
      refreshRcCapability();
      refreshSimLabStackHud();
      try {
        simLabLeafMap?.invalidateSize();
      } catch {
        /* ignore */
      }
    }, 100);
  });

  function bindQuick(id, fn) {
    document.getElementById(id)?.addEventListener('click', fn);
  }

  // Fill connection fields AND auto-connect if not already connected
  function fillAndConnect(type, portVal) {
    const t = document.getElementById('connectType');
    const pi = document.getElementById('connectPortInput');
    if (t) { t.value = type; t.dispatchEvent(new Event('change')); }
    if (pi) pi.value = portVal;
    const cb = document.getElementById('connectBtn');
    if (cb && cb.dataset.connected !== '1') {
      setTimeout(() => cb.click(), 60);
    }
  }

  bindQuick('simLabPresetUdp14550', () => fillAndConnect('udp', '127.0.0.1:14550'));
  bindQuick('simLabPresetUdpBind',   () => fillAndConnect('udp', '0.0.0.0:14550'));
  bindQuick('simLabPresetTcp5760',   () => fillAndConnect('tcp', '127.0.0.1:5760'));
  bindQuick('simLabGoFlightsBtn', () => {
    document.querySelector('.tab[data-tab="flights"]')?.click();
  });

  // ── Wizard step management ─────────────────────────────────────────────────
  function wizardGoStep(n) {
    const wizard = document.getElementById('simLabWizard');
    if (!wizard) return;
    wizard.querySelectorAll('.sl-wiz-step').forEach((el) => {
      const s = parseInt(el.dataset.step);
      el.classList.toggle('sl-wiz-step--active', s === n);
      el.classList.toggle('sl-wiz-step--done', s < n);
    });
    wizard.querySelectorAll('.sl-wiz-connector').forEach((el, i) => {
      el.classList.toggle('sl-wiz-connector--done', i + 1 < n);
    });
    wizard.querySelectorAll('.sl-wiz-panel').forEach((el) => {
      const p = parseInt(el.dataset.panel);
      el.classList.toggle('hidden', p !== n);
    });
  }

  // Copy command button
  bindQuick('simLabCopyCmd', () => {
    const cmd = document.getElementById('simLabSitlCmd')?.textContent?.trim() || '';
    navigator.clipboard?.writeText(cmd).then(() => {
      const btn = document.getElementById('simLabCopyCmd');
      if (!btn) return;
      btn.textContent = '✓ הועתק!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '⎘ העתק'; btn.classList.remove('copied'); }, 1800);
    }).catch(() => {});
  });

  // Skip to step 2
  bindQuick('simLabWizSkip1', () => wizardGoStep(2));

  // Connection buttons → show "connecting" status then call fillAndConnect
  function wizConnect(type, port) {
    const statusEl = document.getElementById('simLabWizConnStatus');
    if (statusEl) { statusEl.textContent = 'מתחבר…'; statusEl.className = 'sl-wiz-conn-status'; }
    fillAndConnect(type, port);
  }
  bindQuick('simLabQsUdp',     () => wizConnect('udp', '127.0.0.1:14550'));
  bindQuick('simLabQsTcp',     () => wizConnect('tcp', '127.0.0.1:5760'));
  bindQuick('simLabQsUdpBind', () => wizConnect('udp', '0.0.0.0:14550'));

  const tlogFileBtn = document.getElementById('simLabTlogFileBtn');
  const wizTlogStatus = document.getElementById('simLabWizTlogStatus');
  let tlogParsing = false;

  function setTlogStatus(text, { error = false, busy = false } = {}) {
    for (const el of [replayMeta, wizTlogStatus]) {
      if (!el) continue;
      el.textContent = text;
      el.classList.toggle('sl-meta--err', !!error);
      el.classList.toggle('sl-meta--busy', !!busy);
    }
  }

  function showSelectedTlogFilename(name) {
    if (!tlogFileBtn || !name) return;
    const short = name.length > 26 ? `${name.slice(0, 23)}…` : name;
    tlogFileBtn.textContent = `📄 ${short}`;
    tlogFileBtn.title = name;
  }

  function syncTlogParseBtn() {
    const parseBtn = document.getElementById('simLabTlogParseBtn');
    const inp = document.getElementById('simLabTlogInput');
    if (!parseBtn) return;
    const hasFile = !!inp?.files?.[0];
    parseBtn.disabled = !hasFile || tlogParsing;
    parseBtn.title = hasFile
      ? 'נתח את הקובץ והצג שיחזור בתלת־ממד'
      : 'בחר קובץ ‎.tlog בלחיצה על «בחר קובץ»';
  }

  async function parseSimLabTlogFromInput() {
    const inp = document.getElementById('simLabTlogInput');
    const file = inp?.files?.[0];
    if (!file) {
      setTlogStatus('בחר קובץ ‎.tlog קודם.', { error: true });
      return;
    }
    if (tlogParsing) return;
    tlogParsing = true;
    const parseBtn = document.getElementById('simLabTlogParseBtn');
    const prevBtnText = parseBtn?.textContent;
    if (parseBtn) {
      parseBtn.disabled = true;
      parseBtn.textContent = 'מנתח…';
    }
    setTlogStatus(`טוען לוג… ${file.name}`, { busy: true });
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/sim-lab/parse-tlog', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !Array.isArray(data.samples) || !data.samples.length) {
        replayEvents = [];
        clearReplayTimelineDom();
        const msg = data.message
          || (Array.isArray(data.samples) && !data.samples.length
            ? 'הקובץ נטען אך לא נמצאו דגימות לשיחזור.'
            : 'ניתוח נכשל.');
        setTlogStatus(msg, { error: true });
        if (replayControls) replayControls.classList.add('hidden');
        return;
      }
      setTlogStatus('מנתח…', { busy: true });
      replaySamples = data.samples;
      replayEvents = Array.isArray(data.replayEvents) ? data.replayEvents : [];
      replayIdx = 0;
      replayDrivingMesh = true;
      originLat = null;
      originLon = null;
      clearReplayTimer();
      replayPlaying = false;
      document.getElementById('simLabQuickstart')?.classList.add('hidden');
      pfBar?.classList.add('hidden');

      if (replaySeek) {
        const max = Math.max(0, replaySamples.length - 1);
        replaySeek.max = String(max);
        replaySeek.value = '0';
      }
      if (replayControls) replayControls.classList.remove('hidden');
      const durS = data.durationMs != null ? (Number(data.durationMs) / 1000).toFixed(1) : '—';
      const ne = replayEvents.length;
      const evPart = ne ? ` · ${ne} אירועי ציר` : '';
      setTlogStatus(`✓ מוכן — לחץ ▶ · ${replaySamples.length} דגימות · ~${durS}s${evPart}`);
      refreshReplayMapsAfterParse();
      refreshReplayMarkersAndList();
      applyReplayFrame(0);
    } catch (err) {
      replayEvents = [];
      clearReplayTimelineDom();
      setTlogStatus(err?.message || 'שגיאת רשת — בדוק שהשרת פועל.', { error: true });
      if (replayControls) replayControls.classList.add('hidden');
    } finally {
      tlogParsing = false;
      if (parseBtn) {
        parseBtn.disabled = false;
        parseBtn.textContent = prevBtnText || '▶ נתח והפעל';
      }
    }
  }

  // tlog shortcut in quickstart — opens picker; change handler parses
  bindQuick('simLabQsTlog', () => {
    const inp = document.getElementById('simLabTlogInput');
    if (inp) inp.value = '';
    setTlogStatus('בחר קובץ ‎.tlog…', { busy: true });
    inp?.click();
  });

  // Initialize wizard at step 1
  wizardGoStep(1);

  // "Connect Now" button in sidebar — shown after a preset is selected while disconnected
  const connectNowBtn = document.getElementById('simLabConnectNowBtn');
  function updateConnectNowBtn() {
    const cb = document.getElementById('connectBtn');
    if (!connectNowBtn || !cb) return;
    connectNowBtn.classList.toggle('hidden', cb.dataset.connected === '1');
  }
  if (connectNowBtn) {
    connectNowBtn.addEventListener('click', () => {
      const cb = document.getElementById('connectBtn');
      if (cb && cb.dataset.connected !== '1') cb.click();
    });
  }
  // Observe connectBtn state changes to show/hide the "Connect Now" button
  const _cbEl = document.getElementById('connectBtn');
  if (_cbEl) {
    new MutationObserver(updateConnectNowBtn).observe(_cbEl, { attributes: true, attributeFilter: ['data-connected'] });
    updateConnectNowBtn();
  }

  bindQuick('simLabTlogParseBtn', () => { void parseSimLabTlogFromInput(); });

  document.getElementById('simLabTlogInput')?.addEventListener('change', () => {
    const inp = document.getElementById('simLabTlogInput');
    const file = inp?.files?.[0];
    if (!file) return;
    showSelectedTlogFilename(file.name);
    setTlogStatus(`נבחר: ${file.name} — מנתח…`, { busy: true });
    void parseSimLabTlogFromInput();
  });

  document.getElementById('simLabReplayPlay')?.addEventListener('click', () => {
    if (!replaySamples.length) return;
    replayDrivingMesh = true;
    replayPlaying = true;
    replayScheduleStep();
  });

  document.getElementById('simLabReplayPause')?.addEventListener('click', () => {
    replayPlaying = false;
    clearReplayTimer();
  });

  document.getElementById('simLabReplayStop')?.addEventListener('click', () => {
    replayPlaying = false;
    clearReplayTimer();
    replaySamples = [];
    replayEvents = [];
    replayDrivingMesh = false;
    replayIdx = 0;
    originLat = null;
    originLon = null;
    if (replayControls) replayControls.classList.add('hidden');
    // Restore quickstart guide if not connected to live FC
    if (!lastConnected) {
      document.getElementById('simLabQuickstart')?.classList.remove('hidden');
    }
    // Also restore pre-flight bar if live FC is connected
    if (pfBar) pfBar.classList.toggle('hidden', !lastConnected);
    if (replaySeek) {
      replaySeek.max = '0';
      replaySeek.value = '0';
    }
    setTlogStatus('');
    if (tlogFileBtn) {
      tlogFileBtn.textContent = 'בחר קובץ';
      tlogFileBtn.removeAttribute('title');
    }
    clearReplayTimelineDom();
    window.__vlcSimLabReplayOverlay?.clear();
    hideSimLabMiniMap();
    if (planeGroup) {
      planeGroup.position.set(0, 90, 0);
      planeGroup.rotation.set(0, 0, 0);
    }
    updateCameraTargetsFromPlane();
    clearInstrumentTapes();
  });

  replaySeek?.addEventListener('input', () => {
    if (!replaySamples.length || !replaySeek) return;
    seekReplayInstant(Number(replaySeek.value), { suspendPlay: true });
  });

  replaySpeedSel?.addEventListener('change', () => {
    if (replayPlaying) {
      clearReplayTimer();
      replayScheduleStep();
    }
  });

  function bootSimLab() {
    initThree();

    const vfxToggle = document.getElementById('simLabVfxToggle');
    if (vfxToggle) {
      const stored = localStorage.getItem(SIM_VFX_KEY);
      if (stored === '0') vfxToggle.checked = false;
      else if (stored === '1') vfxToggle.checked = true;
      vfxToggle.addEventListener('change', () => {
        localStorage.setItem(SIM_VFX_KEY, vfxToggle.checked ? '1' : '0');
        applyVfxVisualMode(vfxToggle.checked);
      });
    }
    applyVfxVisualMode(vfxToggle?.checked !== false);

    const mapBaseSel = document.getElementById('simLabMapBasemap');
    if (mapBaseSel) {
      try {
        const m = localStorage.getItem(SIM_MAP_BASE_KEY) || 'osm';
        mapBaseSel.value = m === 'satellite' || m === 'gradient' ? m : 'osm';
      } catch {
        mapBaseSel.value = 'osm';
      }
      mapBaseSel.addEventListener('change', (e) => {
        applySimLabMapBasemap(e.target?.value || 'osm');
        try {
          simLabLeafMap?.invalidateSize();
        } catch {
          /* ignore */
        }
      });
    }

    document.getElementById('simLabAircraftReload')?.addEventListener('click', () => void refreshAircraftModelList());
    document.getElementById('simLabAircraftApply')?.addEventListener('click', () => {
      const sel = document.getElementById('simLabAircraftSelect');
      const v = sel?.value;
      if (!v) {
        /** ריק מהגלילה = פרימיטיב אפור; צילום מוחל בהעלה (לא בשורת בחירה — רק ‎GLB‎). */
        showPrimitiveAircraft();
      } else void applyAircraftGlbUrl(v);
    });
    document.getElementById('simLabAircraftUpload')?.addEventListener('change', async (ev) => {
      const input = ev.target;
      const f = input?.files?.[0];
      if (!f) return;
      const st = document.getElementById('simLabAircraftStatus');
      const fd = new FormData();
      fd.append('file', f);
      if (st) st.textContent = 'מעלה…';
      try {
        const res = await fetch('/api/aircraft-model/upload', { method: 'POST', body: fd });
        let j = {};
        try {
          j = JSON.parse(await res.text());
        } catch {
          j = {};
        }
        const codeBit = typeof j.code === 'string' ? ` [${j.code}]` : '';
        if (!res.ok || !j.ok) {
          const fallback =
            res.status === 404
              ? 'השרת לא מוכר את /api/aircraft-model/upload — ודא שאתה מריץ את VisionLandingConsole בהרצת שרת מעודכנת והדף לא מתחבר לגרסת שרת ישנה.'
              : res.status === 413
                ? 'הקובץ גדול מדי מהמגבלה בשרת (~80MB) — הקטין או דחוס תמונה/GLB.'
                : '';
          const msg =
            (typeof j.message === 'string' && j.message.trim() ? `${j.message.trim()}${codeBit}` : '') ||
            (fallback ? `${fallback}${codeBit}` : '') ||
            `שגיאת העלאה (HTTP ${res.status})${codeBit}`;
          if (st) st.textContent = msg.trim();
          return;
        }
        await refreshAircraftModelList();
        const sel = document.getElementById('simLabAircraftSelect');
        const pickUrlRaw = typeof j.downloadUrl === 'string' ? j.downloadUrl.trim() : '';
        const pickUrlAlt = typeof j.url === 'string' ? j.url.trim() : '';
        const pickUrl = pickUrlRaw || pickUrlAlt;
        if (sel && pickUrl && j.assetKind === 'glb') {
          sel.value = pickUrl;
          if (typeof j.sizeBytes === 'number' && Number.isFinite(j.sizeBytes)) {
            glbByteLengthHintByUrl.set(pickUrl, j.sizeBytes);
          }
          await applyAircraftGlbUrl(pickUrl, {
            knownByteLength: typeof j.sizeBytes === 'number' ? j.sizeBytes : undefined,
          });
        } else if (pickUrl && j.assetKind === 'photo') {
          await applyPrimitivePhotoDecorFromUrl(pickUrl, { switchToPrimitive: true });
        } else if (st && !(pickUrl && (j.assetKind === 'photo' || j.assetKind === 'glb'))) {
          const kind = typeof j.assetKind === 'string' ? j.assetKind : 'נכס';
          st.replaceChildren(document.createTextNode(`הועלה בהצלחה — סוג «${kind}». לתצוגה תלת־ממדית מהירה עם שורה זו יש צורך ב־‎GLB‎ (אל תסמכו על צילום). `));
          const a = document.createElement('a');
          a.href = DOC_SIM_LAB;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'sim-lab-aircraft-doclink';
          a.textContent = 'תיעוד';
          st.appendChild(a);
          st.appendChild(document.createTextNode('.'));
        }
      } catch (e) {
        if (st) {
          const m = typeof e?.message === 'string' ? e.message : '';
          const net =
            /\bfetch\b|Failed to fetch|NetworkError|נטוורק/i.test(m) ? ' — בעיית רשת/Fetch (השרת רץ?).' : '';
          st.textContent = m ? `${m}${net}` : `העלאה נכשלה${net}`;
        }
      }
      input.value = '';
    });

    queueMicrotask(() => {
      resize();
      void refreshAircraftModelList().then(async () => {
        const sel = document.getElementById('simLabAircraftSelect');
        if (sel?.value) {
          await applyAircraftGlbUrl(sel.value);
          return;
        }
        let decor = '';
        try {
          decor = localStorage.getItem(SIM_PHOTO_DECOR_URL_KEY) || '';
        } catch {
          /* ignore */
        }
        if (decor && uploadsUrlOk(decor)) await applyPrimitivePhotoDecorFromUrl(decor, { silentStatus: true });
      });
    });

    void initStackPresetsUi().then(() => {
      document.getElementById('simLabArduPreset')?.addEventListener('change', () => {
        syncArduCustomVisibility();
        saveStackProfile();
      });
      document.getElementById('simLabArduCustom')?.addEventListener('input', () => saveStackProfile());
      document.getElementById('simLabJetsonVer')?.addEventListener('change', () => saveStackProfile());
    });

    document.getElementById('simLabParamSend')?.addEventListener('click', async () => {
      const nameEl = document.getElementById('simLabParamName');
      const valEl = document.getElementById('simLabParamValue');
      const statusEl = document.getElementById('simLabParamStatus');
      const param = String(nameEl?.value || '')
        .trim()
        .toUpperCase();
      const raw = valEl?.value;
      if (!param || raw === '' || raw == null) {
        if (statusEl) statusEl.textContent = 'נדרש שם פרמטר וערך מספרי.';
        return;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        if (statusEl) statusEl.textContent = 'הערך חייב להיות מספר.';
        return;
      }
      if (statusEl) statusEl.textContent = 'שולח…';
      try {
        const res = await fetch('/api/param-center/param-set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ param, value }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.ok) {
          const warn = j.warning ? ` — ${j.warning}` : '';
          if (statusEl) {
            statusEl.textContent = j.verified
              ? `אומת ב־FC · ${j.param} = ${j.value}`
              : `${j.via || 'נשמר'} · ${j.param} = ${j.value}${warn}`;
          }
        } else if (statusEl) {
          statusEl.textContent = j.message || `שגיאה ${res.status}`;
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = err?.message || 'שגיאת רשת.';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootSimLab);
  else bootSimLab();

  refreshRcCapability();

  window.simLab3d = {
    resizeRenderer: resize,
    invalidateMiniMap: () => {
      try {
        simLabLeafMap?.invalidateSize();
      } catch {
        /* ignore */
      }
    },
  };
}
