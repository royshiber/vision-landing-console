
/* ??? ARDUPILOT READ / DIFF / WRITE ??? *//** Why: single client-side version for the top badge (must match index.html cache-bust and server APP_VERSION). What: read at init when wiring the version modal. */
const APP_VERSION_NEW = '1.01.57';

/** Why: single source of truth for what changed in each release. What: rendered into versionModal when user clicks the version badge. */
const VERSION_HISTORY = [
  {
    version: '1.01.57',
    date: '2026-04-11',
    changes: [
      '????? Gemini: ????? ????? ?????? legacy ? gemini-2.5-flash ?????? ???? ?????.',
      '????? ????: ????? ??????? ? ?????? ????????, ?????, ??? inline ????? ??????? ???????.',
    ],
  },
  {
    version: '1.01.56',
    date: '2026-03-27',
    changes: [
      '????? ?????: ?????? ????? ???/????? ??initTerrainMap ? ??? ?? ??????? ???? ??ReferenceError ?????? (???? ???????? ?????) ?? ?????.',
      'Critical fix: terrain DOM refs + Leaflet init restored ? script no longer throws on undefined toolbar vars; map initializes on terrain tab.',
    ],
  },
  {
    version: '1.01.55',
    date: '2026-03-27',
    changes: [
      '????? ?????: ???? ?????? ??? ????? (z-index) + ??? ??? ?-flex ??? ??? ???? ???? ?? ???????; ???? ??-????? ?? ???? ??????? ???? ?? ???? ??????.',
      'Telemetry layout: ??? ???? ???? ???? (grid ????? minmax(0,1fr)), ???? padding ? ????? ??? ??? ???? ??? ????? ??.',
      'Main tabs stay clickable (stacking + flex shell); telemetry grid uses full panel height; control subtabs bar toggles with control tab only.',
    ],
  },
  {
    version: '1.01.27',
    date: '2026-03-26',
    changes: [
      '???? ?? ?????? ???? ?????????/??? ?????? ?????? ? ???? ???? ?????? ??????? ???? (Jetson + Vision + SLAM).',
      'Removed all mock/simulation/demo buttons and server routes; UI now shows only real hardware data.',
    ],
  },
  {
    version: '1.01.26',
    date: '2026-03-25',
    changes: [
      '??? ?????: ???? ????? ??? ???? AGL ????? (????????? ????????); ???? ?????; ????? ??? ?? leaflet-rotate (? N ? ??? ???). ???????: ???? DEMO ????? ????? ??? ????? ? ?????? (???)? ?? ????; ????????? Vision ????? ?????.',
      'Terrain cells colored by mapped AGL; dynamic legend; map bearing via leaflet-rotate; demo stop toggles client suppressTelemetryDemo; vision mock clears suppress.',
    ],
  },
  {
    version: '1.01.25',
    date: '2026-03-25',
    changes: [
      '??? ?????: ???? ???? AGL ????? ?????; ????? ??? (??????? ??? ???); ????? ? ????? ?????, ????? ????, ?????? ???? ???????; ?????? ? ????? ???? ????; ???? ??????? ? ?????? ?????; ArduPilot ? ??-????? ??? ???????; ???? ??? ? ????? ???? ?????? (???)?.',
      'Terrain altitude-colored coverage + map bearing control; logs pull/drag-drop/pills; recordings video taller; parameter hub tighter; Ardu sub-tabs; demo stop clears simulated link label.',
    ],
  },
  {
    version: '1.01.24',
    date: '2026-03-25',
    changes: [
      '??? ?????: ????? ????? ????? (????? flex + max-height), ???? ??? ???? / ????? (Esri), ??? ??? ?????? ??????? ? ??? ??? ??? ??????, ?? ?????? ?????.',
      'Terrain tab: layout fix, OSM vs satellite toggle, mapped-only white canvas with coverage circles only.',
    ],
  },
  {
    version: '1.01.23',
    date: '2026-03-25',
    changes: [
      '???? ???????: ??? ??? ????? ???? ????? + ArduPilot ? ??-?????: ?????, ABORT, ?????, ????? ??? ?????, ?????. READ/WRITE ????; ?????? READ/WRITE ????? + ???? ????? (?????? / ON-OFF).',
      'API: GET/POST /api/vision/config ?????? ?????? ??? + ??? ArduPilot ????; ????? JSON ???? arduTarget.',
      'Unified parameter hub: one tab with five feature subtabs; server sync + FC read/write + editable Ardu targets.',
    ],
  },
  {
    version: '1.01.22',
    date: '2026-03-25',
    changes: [
      '????? ??????: `.panel:not(.visible) { display:none !important }` + ???? flex ?? !important ? ??? ????? ???? ?????? ?? ?????? ??????? ???? ??? ???? inline display.',
      'Panel isolation: hidden main tabs stay hidden even if a panel regains inline display; terrain map only when its tab is active.',
    ],
  },
  {
    version: '1.01.21',
    date: '2026-03-25',
    changes: [
      '?????: ??? ????? ?? ????? ???? ???? ?????? ?????? ? ???? display:flex ??-inline ?? #terrain (??? ??? ?? ????? ?????). ???? ?????? ?? ???? ???? ??????.',
      'Fix: terrain map no longer stacks under Landing Control ? inline flex on #terrain overrode .panel display:none; map shows only on the terrain tab.',
    ],
  },
  {
    version: '1.01.20',
    date: '2026-03-25',
    changes: [
      '???? ????? (Tuning Deck): ????? ?????? ? ??? ??????? ?? ?????? ????? (auto-fill, ???? ~240px), ??????? ?????? ????, ????? ?????? ????? ?????????. ???? ????? ?? ???? ???? ??????.',
    ],
  },
  {
    version: '1.01.19',
    date: '2026-03-25',
    changes: [
      '???? Aero-Lab (Google Stitch): ??? ???? ????, ???? #f7f9fc / ???? #00478d, ?????? Inter + Space Grotesk, ??? ??????, ????? ?????, ??????? ?????? ?????? ????.',
      '????? ?????? ???????, ???????, ArduPilot, ???, ???? ??????? ? ?????? ?? ??? ????.',
    ],
  },
  {
    version: '1.01.18',
    date: '2026-03-25',
    changes: [
      '????? ???? DEMO: ???? ?? ?? ????? ????????? ???? ?????? ????? "????? ????".',
      'ArduPilot READ/WRITE: ????? READ ???? ?? ???????? ???????? ??-ArduPilot + ?????? diff ?????? ?? ????? ?????? WRITE. ????? WRITE + ????? SUCCESS/FAIL.',
      '??? ?????: ??? ??? ?? Leaflet ? ??????? ???????? ?????? ??? ????? SLAM. ????=???, ????=????, ????=????.',
      '?????: ?? ?????? ?????? ?? ??? ????? ???. ????? ??????? ArduPilot/Jetson ??? ????. ????? "?? ???? ? ??? ?? ?????".',
      '???????? ?????: canvas overlay ?? ?????? ?? ????? ?????, ?? ??????, ?????????? ????/?? ????.',
    ],
  },
  {
    version: '1.01.17',
    date: '2026-03-25',
    changes: [
      'SSE real-time push: replaced all HTTP polling (vision 500ms + jetson 5s) with a single /api/stream EventSource ? updates every 300ms.',
      'Confidence Bar ??: ???? Jetson ???? vision frames ??????? (ageMs < 3s) ? ??? ???? ?????? ?????? ????? ????.',
      'DEMO / LIVE badges: ?????? Vision ?-SLAM ??????? "DEMO" ???? ????? ?-"LIVE" ??????? ????.',
      'SLAM / VIO ????? + ???? Gemini ?? ???? ??? ????? ???? ???.',
    ],
  },
  {
    version: '1.01.16',
    date: '2026-03-25',
    changes: [
      '???? ?\'?? ???? ???? ? ????? ?????? max-width.',
      '????? ???????? ???? ???? ? SVG ???? ?? pulse ???? ?????.',
      'Jetson ???? ? ????? dot, ??? ????? ??????, ??? JSON ?????.',
      'ArduPilot Idiot-proof ? ?????? ??????? + ????? ????? ???? .param.',
    ],
  },
  {
    version: '1.01.15',
    date: '2026-03-25',
    changes: [
      'Vision Output ?????: endpoint /api/vision/frame ????? ????? ????? ?-Jetson + ??????? ???? (????? ??????, ????? ?????, confidence, ??? ?????).',
      'Link Health: ???? ????? heartbeat + ???? packet-loss ????? ??? ?????? ??????.',
      'ArduPilot Config ???: ?????? Vision Landing ????? (PLND, EKF, SERIAL, LOG, LAND, FS) + ???? ????? ????? ???? reboot.',
      'Tauri Desktop: ???? src-tauri/tauri.conf.json + ???????? tauri:dev / tauri:build (???? Rust + Tauri CLI).',
      '???? ????: ???? "?? ???" ??? data-driven ? ????? ?-VERSION_HISTORY ????.',
    ],
  },
  {
    version: '1.01.14',
    date: '2026-03-25',
    changes: [
      '????? ????? ? const eventContextMenu ????? ???? ?????? ?? (Temporal Dead Zone). ????? ?????? ???? ??? ?????, ???? ?????. ???? ????? ?????? ????? ???? DOM lookups.',
    ],
  },
  {
    version: '1.01.08?1.01.13',
    date: '2026-03-24',
    changes: [
      '????? DOM ????? ? ????? ????? ????? ?? advisorMessages/??????? ?????.',
      'Gemini 2.5-flash ?????? ????; ????? ??????? ??????? ????? (1.5-flash, 2.0-flash).',
      'npm run start:clean ? ???? node ?? ???? 4010 ?????? ??? ??????.',
      '/api/health ???? geminiModel (env, effective, remapped).',
    ],
  },
  {
    version: '1.01.03',
    date: '2026-03-23',
    changes: [
      '??? Express ???? ? ?? /api/* ???? ????? ??????.',
      '???? ???? ????? ?????? + ???? ?????? ????.',
    ],
  },
  {
    version: '1.01.00?1.01.02',
    date: '2026-03-22',
    changes: [
      'Gemini ???? + ???? SQLite ??????, ????? ??????.',
      'ingest ??????? ?-GitHub Actions.',
      'Jetson ????? RPi (/api/jetson/* + ?????? /api/rpi/*).',
      '???????? ????? (Web Speech API) + ???? ???? ??????.',
    ],
  },
];
const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));
const subtabs = Array.from(document.querySelectorAll('.subtab'));
const subpanels = Array.from(document.querySelectorAll('.subpanel'));
const controlSubtabsBar = document.getElementById('controlSubtabsBar');
let selectedContextEvent = null;
let processIndex = 0;

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('visible'));
    tab.classList.add('active');
    const panel = document.getElementById(tab.dataset.tab);
    if (panel) panel.classList.add('visible');
    /** Why: subtabs row belongs only to ???? ???????; what: hide bar on other main tabs so it cannot intercept layout or focus. */
    if (controlSubtabsBar) {
      controlSubtabsBar.classList.toggle('visible', tab.dataset.tab === 'control');
    }
  });
});
if (controlSubtabsBar) {
  const activeMainTab = document.querySelector('.tab.active');
  controlSubtabsBar.classList.toggle('visible', activeMainTab?.dataset?.tab === 'control');
}
subtabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    subtabs.forEach((t) => t.classList.remove('active'));
    subpanels.forEach((p) => p.classList.remove('visible'));
    tab.classList.add('active');
    const panel = document.getElementById(tab.dataset.subtab);
    if (panel) panel.classList.add('visible');
  });
});

const TEXT_OVERRIDES_KEY = 'visionLandingTextOverridesV1';
const DEV_MODE_KEY = 'visionLandingDeveloperModeV1';
const PARAMS = [
  { key: 'flare_alt_m', label: '???? ???? (m)', min: 1, max: 30, step: 0.5, value: 8 },
  { key: 'laser_detect_alt_m', label: '???? ????? ????? (m)', min: 1, max: 40, step: 0.5, value: 15 },
  { key: 'flare_pitch_up_deg', label: '????? ???? ?? ????? (deg)', min: 1, max: 20, step: 0.5, value: 7 },
  { key: 'motor_hold_s', label: '??? ??? ???? ????? (s)', min: 0, max: 8, step: 0.1, value: 2.5 },
  { key: 'vision_enable_alt_m', label: '???? ????? Vision (m)', min: 5, max: 120, step: 1, value: 55 },
  { key: 'vision_conf_min', label: '?? ??????? ?????? Vision', min: 0.4, max: 0.99, step: 0.01, value: 0.78 },
  { key: 'abort_conf_min', label: '?? ?????? ??????? ?-Auto Abort', min: 0.3, max: 0.95, step: 0.01, value: 0.70 },
  { key: 'abort_conf_hold_s', label: '??? ??? ???? ??? ???? Abort (s)', min: 0.5, max: 8, step: 0.1, value: 2.0 },
  { key: 'abort_recover_conf', label: '?? ????? ?-Abort (Recover)', min: 0.35, max: 0.99, step: 0.01, value: 0.76 },
  { key: 'xtrack_gain', label: 'Cross Track Gain', min: 0.1, max: 3.5, step: 0.05, value: 1.25 },
  { key: 'yaw_align_gain', label: 'Yaw Align Gain', min: 0.1, max: 2.5, step: 0.05, value: 0.95 },
  { key: 'approach_speed_ms', label: '?????? ???? (m/s)', min: 8, max: 35, step: 0.5, value: 16.5 },
  { key: 'sink_rate_ms', label: '????? ????? (m/s)', min: 0.3, max: 4, step: 0.1, value: 1.4 },
  { key: 'max_roll_deg', label: '???? ???????? ?????? (deg)', min: 5, max: 35, step: 1, value: 18 },
  { key: 'abort_max_xtrack_m', label: 'Abort ?? ????? ?????? ????? (m)', min: 0.5, max: 12, step: 0.1, value: 4.0 },
  { key: 'abort_max_heading_deg', label: 'Abort ?? ????? ????? ????? (deg)', min: 5, max: 80, step: 1, value: 22 },
  { key: 'to_rotate_speed_ms', label: 'Takeoff Rotate Speed (m/s)', min: 6, max: 30, step: 0.5, value: 13.0 },
  { key: 'to_pitch_deg', label: 'Takeoff Pitch (deg)', min: 4, max: 20, step: 0.5, value: 11.0 },
  { key: 'to_max_crosswind_ms', label: 'Crosswind Max ?????? (m/s)', min: 1, max: 20, step: 0.5, value: 8.0 },
  { key: 'to_min_gps_sats', label: '??????? ???????? ??????', min: 10, max: 40, step: 1, value: 12 },
  { key: 'to_motor_spool_s', label: '??? ???? ???? ???? ????? (s)', min: 0.5, max: 8, step: 0.1, value: 2.2 },
  { key: 'to_abort_speed_loss_ms', label: 'Abort ?? ????? ?????? (m/s)', min: 0.5, max: 8, step: 0.1, value: 2.5 },
];
const PROCESS_STEPS = [
  '????? ????? ?????',
  '????? ????/?????? ????',
  '????? Vision ??????',
  '????? GPS ??????',
  '????? ????? ??????',
  '????? Confidence ???? Final',
  '???? ?-Final',
  '?????? Cross Track ??????',
  '????? ???? Abort',
  '????? ?-Flare',
  '????? ???? ??????',
  '????? ?????',
  '???? ????',
  '????? ?????',
];

function buildParamTooltip(param) {
  const generic = '??? ?????: ???????? ?????? ?? ?????? ?? ?? ??????.';
  const higher = '??? ???? ????: ???? ???/????? ????.';
  const lower = '??? ???? ????: ???? ????/????? ????.';
  if (param.key.includes('abort')) {
    return `??? ?????: ???? false abort ?? abort ????? ???.\n???? ????: ?????? ?????? ????.\n???? ????: ???? abort?? ??? ????? ???? ????.`;
  }
  if (param.key.includes('conf')) {
    return `??? ?????: ??????? ?????? ????? ??????/?????.\n???? ????: ???? ????? ???? ????.\n???? ????: ????? ???? ??? ???? ????.`;
  }
  if (param.key.includes('speed') || param.key.includes('sink')) {
    return `??? ?????: ?????? ?????/????? ??? ?? ????? ???.\n???? ????: ???? ???????? ????.\n???? ????: ???? ????? ????.`;
  }
  return `${generic}\n${higher}\n${lower}`;
}

function localAdvisorReply(q) {
  const text = String(q || '').toLowerCase();
  if (text.includes('?????') || text.includes('oscillation')) {
    return '??????: ???? ??? xtrack_gain, ???? yaw_align_gain ????, ????? abort_conf_hold_s ?????? ????? ???.';
  }
  if (text.includes('????') || text.includes('flare')) {
    return '?????: ???? ??? flare_alt_m, ????? flare_pitch_up_deg ?????? ????? ?? 0.5.';
  }
  if (text.includes('??????') || text.includes('confidence')) {
    return '???????: ???? abort_conf_min ?? ??? ???? ?????? ?????? ????, ???? abort_recover_conf ??? ???? ?-ABORT ?? ???? ???????? ??????.';
  }
  if (text.includes('??????') || text.includes('speed')) {
    return '???????: ???? approach_speed_ms ?? ?????? ???, ???? sink_rate_ms ?? ???? ???.';
  }
  if (text.includes('?????') || text.includes('takeoff')) {
    return '??????: ???? ???? GPS sats ?????, ??? ?? ???? ???, ????? ???? ??? ???? ?????.';
  }
  return '????? ?????: ????? ????? ??? ??? ????, ????? ??????, ??????? ?????? ????/????.';
}
const ABORT_PARAM_KEYS = new Set([
  'abort_conf_min',
  'abort_conf_hold_s',
  'abort_recover_conf',
  'abort_max_xtrack_m',
  'abort_max_heading_deg',
]);
const TAKEOFF_PARAM_KEYS = new Set([
  'to_rotate_speed_ms',
  'to_pitch_deg',
  'to_max_crosswind_ms',
  'to_min_gps_sats',
  'to_motor_spool_s',
  'to_abort_speed_loss_ms',
]);
/** Why: split tuning deck into feature tabs; what: keys rendered under ?????? ????? (???? ????? / ????). */
const LANDING_PARAM_KEYS = new Set([
  'flare_alt_m',
  'laser_detect_alt_m',
  'flare_pitch_up_deg',
  'motor_hold_s',
  'approach_speed_ms',
  'sink_rate_ms',
]);
/** Why: vision path correction limits; what: keys under ????? ??? ?????. */
const VISION_NAV_PARAM_KEYS = new Set([
  'vision_enable_alt_m',
  'vision_conf_min',
  'xtrack_gain',
  'yaw_align_gain',
  'max_roll_deg',
]);

const profileState = Object.fromEntries(PARAMS.map((p) => [p.key, p.value]));
const lockState = Object.fromEntries(PARAMS.map((p) => [p.key, false]));
const paramsGrid = document.getElementById('paramsGrid');
const abortGrid = document.getElementById('abortGrid');
const takeoffGrid = document.getElementById('takeoffGrid');
const visionNavGrid = document.getElementById('visionNavGrid');
/** Why: match server `ARDU_TARGET_DEFAULTS` shape; what: cloned into `arduTargetState` for editable FC targets. */
const ARDU_TARGET_DEFAULTS_CLIENT = Object.freeze({
  SERIAL2_PROTOCOL: 2,
  SERIAL2_BAUD: 921,
  SR2_EXT_STAT: 5,
  SR2_POSITION: 10,
  SR2_RC_CHAN: 5,
  SR2_EXTRA1: 10,
  SR2_EXTRA2: 10,
  EK3_ENABLE: 1,
  AHRS_EKF_TYPE: 3,
  EK3_GPS_TYPE: 0,
  EK3_ALT_SOURCE: 1,
  PLND_ENABLED: 1,
  PLND_TYPE: 1,
  PLND_BUS: 0,
  PLND_LAG: 0.02,
  PLND_XY_DIST_MAX: 5,
  PLND_STRICT: 0,
  LOG_DISARMED: 1,
  LOG_REPLAY: 1,
  LOG_BITMASK: 65535,
  LAND_SPEED: 50,
  LAND_SPEED_HIGH: 0,
  LAND_ALT_LOW: 1000,
  LAND_ABORT_PWM: 900,
  FS_THR_ENABLE: 1,
  FS_THR_VALUE: 975,
  ARMING_CHECK: 1,
});
let arduTargetState = { ...ARDU_TARGET_DEFAULTS_CLIENT };

const saveProfileBtn = document.getElementById('saveProfileBtn');
const exportProfileBtn = document.getElementById('exportProfileBtn');
const importProfileInput = document.getElementById('importProfileInput');
const devModeBtn = document.getElementById('devModeBtn');
let developerMode = localStorage.getItem(DEV_MODE_KEY) === '1';

function updateDeveloperModeUI() {
  document.body.classList.toggle('dev-mode', developerMode);
  if (devModeBtn) devModeBtn.textContent = `??? ????: ${developerMode ? '????' : '????'}`;
}

function applyTextOverrides() {
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(TEXT_OVERRIDES_KEY) || '{}'); } catch {}
  document.querySelectorAll('[data-text-key]').forEach((el) => {
    const key = el.dataset.textKey;
    if (key && typeof overrides[key] === 'string') el.textContent = overrides[key];
  });
}

if (devModeBtn) {
  devModeBtn.addEventListener('click', () => {
    developerMode = !developerMode;
    localStorage.setItem(DEV_MODE_KEY, developerMode ? '1' : '0');
    updateDeveloperModeUI();
  });
}

document.addEventListener('click', (e) => {
  const target = e.target.closest?.('[data-text-key]');
  if (!target || !developerMode) return;
  e.preventDefault();
  const key = target.dataset.textKey;
  const next = window.prompt('????? ???? (??? ????):', target.textContent || '');
  if (next == null) return;
  target.textContent = next;
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(TEXT_OVERRIDES_KEY) || '{}'); } catch {}
  overrides[key] = next;
  localStorage.setItem(TEXT_OVERRIDES_KEY, JSON.stringify(overrides));
});

document.addEventListener('contextmenu', (e) => {
  if (!developerMode) return;
  const target = e.target.closest?.('[data-text-key], .param-info');
  if (!target) return;
  e.preventDefault();
  if (target.classList.contains('param-info')) {
    const currentTitle = target.getAttribute('title') || '';
    const nextTitle = window.prompt('????? tooltip ??????:', currentTitle);
    if (nextTitle == null) return;
    target.setAttribute('title', nextTitle);
    return;
  }
  const currentTooltip = target.getAttribute('title') || '';
  const nextTooltip = window.prompt('????? tooltip ?????:', currentTooltip);
  if (nextTooltip == null) return;
  target.setAttribute('title', nextTooltip);
});

function renderParamsIn(container, items) {
  if (!container) return;
  container.innerHTML = '';
  items.forEach((param) => {
    const locked = !!lockState[param.key];
    const card = document.createElement('article');
    card.className = 'param-card';
    card.innerHTML = `
      <div class="param-top">
        <h3 class="param-title">${param.label}</h3>
        <span class="param-info" title="${buildParamTooltip(param).replace(/"/g, '&quot;')}">?</span>
        <button class="lock-btn ${locked ? 'locked' : ''}" id="lock_${param.key}" title="???? ?? ????? ?? ?????? ??????">
          ${locked ? '??' : '??'}
        </button>
      </div>
      <div class="param-meta">
        <span>${param.min} - ${param.max}</span>
        <span class="param-value" id="val_${param.key}">${profileState[param.key]}</span>
      </div>
      <input type="range" id="rng_${param.key}" min="${param.min}" max="${param.max}" step="${param.step}" value="${profileState[param.key]}" ${locked ? 'disabled' : ''} />
    `;
    container.appendChild(card);
  });
}

function bindParamHandlers(items) {
  items.forEach((param) => {
    const slider = document.getElementById(`rng_${param.key}`);
    const valueNode = document.getElementById(`val_${param.key}`);
    const lockBtn = document.getElementById(`lock_${param.key}`);
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        lockState[param.key] = !lockState[param.key];
        renderParams();
      });
    }
    if (!slider || !valueNode) return;
    slider.addEventListener('input', () => {
      if (lockState[param.key]) return;
      profileState[param.key] = Number(slider.value);
      valueNode.textContent = slider.value;
      refreshEventsFromParams();
    });
  });
}

function renderParams() {
  const landing = PARAMS.filter((p) => LANDING_PARAM_KEYS.has(p.key));
  const visionNav = PARAMS.filter((p) => VISION_NAV_PARAM_KEYS.has(p.key));
  const abort = PARAMS.filter((p) => ABORT_PARAM_KEYS.has(p.key));
  const takeoff = PARAMS.filter((p) => TAKEOFF_PARAM_KEYS.has(p.key));
  renderParamsIn(paramsGrid, landing);
  renderParamsIn(visionNavGrid, visionNav);
  renderParamsIn(abortGrid, abort);
  renderParamsIn(takeoffGrid, takeoff);
  bindParamHandlers(landing);
  bindParamHandlers(visionNav);
  bindParamHandlers(abort);
  bindParamHandlers(takeoff);
}

/**
 * Why: drive the ArduPilot sub-tab form layout; what: metadata for checkboxes vs numeric inputs (Hebrew labels).
 */
const ARDU_FORM_FIELDS = [
  { group: '?????? Jetson', key: 'SERIAL2_PROTOCOL', label: 'SERIAL2 ? ???????? (MAVLink)', kind: 'number', min: 0, max: 30, step: 1 },
  { group: '?????? Jetson', key: 'SERIAL2_BAUD', label: 'SERIAL2 ? Baud', kind: 'number', min: 9600, max: 921600, step: 1 },
  { group: '?????? Jetson', key: 'SR2_EXT_STAT', label: '????? SR2 ? EXT_STAT (Hz)', kind: 'number', min: 0, max: 50, step: 1 },
  { group: '?????? Jetson', key: 'SR2_POSITION', label: '????? SR2 ? POSITION (Hz)', kind: 'number', min: 0, max: 50, step: 1 },
  { group: '?????? Jetson', key: 'SR2_RC_CHAN', label: '????? SR2 ? RC_CHAN (Hz)', kind: 'number', min: 0, max: 50, step: 1 },
  { group: '?????? Jetson', key: 'SR2_EXTRA1', label: '????? SR2 ? EXTRA1 (Hz)', kind: 'number', min: 0, max: 50, step: 1 },
  { group: '?????? Jetson', key: 'SR2_EXTRA2', label: '????? SR2 ? EXTRA2 (Hz)', kind: 'number', min: 0, max: 50, step: 1 },
  { group: 'EKF / AHRS', key: 'EK3_ENABLE', label: 'EKF3 ????', kind: 'bool' },
  { group: 'EKF / AHRS', key: 'AHRS_EKF_TYPE', label: '??? EKF (3 = EKF3)', kind: 'number', min: 0, max: 10, step: 1 },
  { group: 'EKF / AHRS', key: 'EK3_GPS_TYPE', label: 'EK3 ? ??? GPS', kind: 'number', min: 0, max: 10, step: 1 },
  { group: 'EKF / AHRS', key: 'EK3_ALT_SOURCE', label: 'EK3 ? ???? ????', kind: 'number', min: 0, max: 10, step: 1 },
  { group: '????? ?????? (Vision)', key: 'PLND_ENABLED', label: 'Precision Landing ????', kind: 'bool' },
  { group: '????? ?????? (Vision)', key: 'PLND_TYPE', label: '??? PLND (1 = MAVLink)', kind: 'number', min: 0, max: 5, step: 1 },
  { group: '????? ?????? (Vision)', key: 'PLND_BUS', label: 'PLND ? Bus', kind: 'number', min: 0, max: 10, step: 1 },
  { group: '????? ?????? (Vision)', key: 'PLND_LAG', label: 'PLND ? Lag (?????)', kind: 'number', min: 0, max: 1, step: 0.01 },
  { group: '????? ?????? (Vision)', key: 'PLND_XY_DIST_MAX', label: '???? ???? XY ?????? (??)', kind: 'number', min: 0, max: 50, step: 0.5 },
  { group: '????? ?????? (Vision)', key: 'PLND_STRICT', label: 'PLND ? ??? strict', kind: 'bool' },
  { group: '?????', key: 'LOG_DISARMED', label: '??? ?? ???? (Disarmed)', kind: 'bool' },
  { group: '?????', key: 'LOG_REPLAY', label: 'LOG_REPLAY', kind: 'bool' },
  { group: '?????', key: 'LOG_BITMASK', label: 'LOG_BITMASK', kind: 'number', min: 0, max: 2147483647, step: 1 },
  { group: '????? ?????', key: 'LAND_SPEED', label: '?????? ????? ????? (???/?)', kind: 'number', min: 10, max: 200, step: 1 },
  { group: '????? ?????', key: 'LAND_SPEED_HIGH', label: 'LAND_SPEED_HIGH', kind: 'number', min: 0, max: 500, step: 1 },
  { group: '????? ?????', key: 'LAND_ALT_LOW', label: 'LAND_ALT_LOW (???)', kind: 'number', min: 0, max: 5000, step: 10 },
  { group: '????? ?????', key: 'LAND_ABORT_PWM', label: 'LAND_ABORT_PWM', kind: 'number', min: 800, max: 2200, step: 1 },
  { group: '??????', key: 'FS_THR_ENABLE', label: 'Failsafe ????', kind: 'bool' },
  { group: '??????', key: 'FS_THR_VALUE', label: '??? PWM ?-FS', kind: 'number', min: 800, max: 1200, step: 1 },
  { group: '??????', key: 'ARMING_CHECK', label: '?????? ???? Arm', kind: 'bool' },
];

/** Why: category tab order matches form field declaration order; what: unique group titles for Ardu subtabs. */
const ARDU_GROUP_ORDER = [...new Set(ARDU_FORM_FIELDS.map((f) => f.group))];

/** Why: stable `data-panel` ids; what: maps Hebrew group title to ASCII slug for DOM ids. */
function arduGroupToSlug(g) {
  const m = {
    '?????? Jetson': 'jetson',
    'EKF / AHRS': 'ekf',
    '????? ?????? (Vision)': 'plnd',
    '?????': 'logs',
    '????? ?????': 'land',
    '??????': 'safety',
  };
  return m[g] || `cat_${String(g).replace(/\W+/g, '_').slice(0, 16)}`;
}

/** Why: Mission Planner expects NAME,value lines; what: keeps hidden `#configText` in sync for download / MP route. */
function syncConfigTextFromArdu() {
  const el = document.getElementById('configText');
  if (!el) return;
  el.textContent = Object.keys(arduTargetState)
    .map((k) => `${k},${arduTargetState[k]}`)
    .join('\n');
}

/** Why: normalize form input into the same types as `arduTargetState`; what: used on change handlers for number/bool fields. */
function coerceArduFieldValue(field, raw) {
  if (field.kind === 'bool') return raw ? 1 : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Why: render editable FC targets under ???? ???????; what: one sub-tab per category (no single long scroll). */
function renderArduParamForm() {
  const tabs = document.getElementById('arduCatSubtabs');
  const host = document.getElementById('arduParamFormPanels');
  if (!tabs || !host) return;
  const byGroup = {};
  ARDU_FORM_FIELDS.forEach((f) => {
    if (!byGroup[f.group]) byGroup[f.group] = [];
    byGroup[f.group].push(f);
  });
  const order = ARDU_GROUP_ORDER.filter((g) => byGroup[g]?.length);
  tabs.innerHTML = order
    .map((grp, i) => {
      const slug = arduGroupToSlug(grp);
      return `<button type="button" role="tab" class="ardu-cat-subtab${i === 0 ? ' active' : ''}" data-ardu-cat="${slug}" aria-selected="${i === 0 ? 'true' : 'false'}">${grp}</button>`;
    })
    .join('');
  host.innerHTML = order
    .map((grp, i) => {
      const slug = arduGroupToSlug(grp);
      const fields = byGroup[grp];
      const grid = fields
        .map((f) => {
          const v = arduTargetState[f.key];
          if (f.kind === 'bool') {
            const on = Number(v) === 1;
            return `<article class="ardu-field-card ardu-field-bool">
            <label for="ardu_in_${f.key}">${f.label}</label>
            <div><input type="checkbox" id="ardu_in_${f.key}" data-ardu-key="${f.key}" ${on ? 'checked' : ''} />
            <span class="ardu-field-key">${f.key}</span></div>
          </article>`;
          }
          return `<article class="ardu-field-card">
            <label for="ardu_in_${f.key}">${f.label}</label>
            <input type="number" id="ardu_in_${f.key}" data-ardu-key="${f.key}" data-ardu-kind="number"
              min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" />
            <span class="ardu-field-key">${f.key}</span>
          </article>`;
        })
        .join('');
      return `<div class="ardu-cat-subpanel${i === 0 ? ' visible' : ''}" data-panel="${slug}" role="tabpanel">${grid}</div>`;
    })
    .join('');
  host.querySelectorAll('[data-ardu-key]').forEach((input) => {
    const key = input.dataset.arduKey;
    const field = ARDU_FORM_FIELDS.find((x) => x.key === key);
    if (!field) return;
    input.addEventListener('change', () => {
      if (field.kind === 'bool') {
        arduTargetState[key] = input.checked ? 1 : 0;
      } else {
        arduTargetState[key] = coerceArduFieldValue(field, input.value);
      }
      syncConfigTextFromArdu();
    });
  });
}

/** Why: switch ArduPilot firmware category panels without reloading the whole form; what: toggles `.active` / `.visible` on subtabs. */
function wireArduCategorySubtabsOnce() {
  const root = document.getElementById('arduParams');
  if (!root || root.dataset.arduCatWired === '1') return;
  root.dataset.arduCatWired = '1';
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.ardu-cat-subtab');
    if (!btn || !root.contains(btn)) return;
    const slug = btn.dataset.arduCat;
    root.querySelectorAll('.ardu-cat-subtab').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    root.querySelectorAll('.ardu-cat-subpanel').forEach((p) => {
      p.classList.toggle('visible', p.dataset.panel === slug);
    });
  });
}
wireArduCategorySubtabsOnce();

/** Why: hydrate UI from server after boot or READ; what: merges profile + FC target, re-renders sliders and Ardu form. */
async function loadVisionConfigFromServer(statusEl) {
  try {
    const res = await fetch('/api/vision/config');
    const d = await res.json();
    if (d.profile && typeof d.profile === 'object') {
      Object.keys(profileState).forEach((key) => {
        if (d.profile[key] != null && Number.isFinite(Number(d.profile[key]))) {
          profileState[key] = Number(d.profile[key]);
        }
      });
    }
    if (d.arduTarget && typeof d.arduTarget === 'object') {
      Object.keys(arduTargetState).forEach((k) => {
        if (d.arduTarget[k] !== undefined && d.arduTarget[k] !== null) {
          const t = typeof arduTargetState[k] === 'number' ? Number(d.arduTarget[k]) : d.arduTarget[k];
          if (typeof arduTargetState[k] === 'number' ? Number.isFinite(t) : true) arduTargetState[k] = t;
        }
      });
    }
    renderParams();
    renderArduParamForm();
    syncConfigTextFromArdu();
    if (statusEl) {
      statusEl.textContent = '???? ?????';
      statusEl.className = 'vision-config-status ok';
    }
  } catch {
    if (statusEl) {
      statusEl.textContent = '????? ???';
      statusEl.className = 'vision-config-status fail';
    }
  }
}

/** Why: persist full tab state server-side; what: POST profile + arduTarget for next session / other clients. */
async function saveVisionConfigToServer(statusEl) {
  try {
    const res = await fetch('/api/vision/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { ...profileState }, arduTarget: { ...arduTargetState } }),
    });
    const d = await res.json();
    if (d.ok) {
      if (statusEl) {
        statusEl.textContent = '???? ????';
        statusEl.className = 'vision-config-status ok';
      }
    } else if (statusEl) {
      statusEl.textContent = '????';
      statusEl.className = 'vision-config-status fail';
    }
  } catch {
    if (statusEl) {
      statusEl.textContent = '????? ???';
      statusEl.className = 'vision-config-status fail';
    }
  }
}

const visionConfigReadBtn = document.getElementById('visionConfigReadBtn');
const visionConfigWriteBtn = document.getElementById('visionConfigWriteBtn');
const visionConfigStatus = document.getElementById('visionConfigStatus');
if (visionConfigReadBtn) {
  visionConfigReadBtn.addEventListener('click', () => loadVisionConfigFromServer(visionConfigStatus));
}
if (visionConfigWriteBtn) {
  visionConfigWriteBtn.addEventListener('click', () => saveVisionConfigToServer(visionConfigStatus));
}

if (saveProfileBtn) {
  saveProfileBtn.addEventListener('click', () => {
    localStorage.setItem('visionLandingProfile', JSON.stringify({ values: profileState, locks: lockState }));
    saveProfileBtn.textContent = '????';
    setTimeout(() => { saveProfileBtn.textContent = '???? ??????'; }, 1000);
  });
}

if (exportProfileBtn) {
  exportProfileBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ values: profileState, locks: lockState, arduTarget: { ...arduTargetState } }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vision-landing-profile.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

if (importProfileInput) {
  importProfileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incomingValues = parsed?.values || parsed;
      const incomingLocks = parsed?.locks || {};
      Object.keys(profileState).forEach((key) => {
        if (typeof incomingValues[key] === 'number') profileState[key] = incomingValues[key];
        if (typeof incomingLocks[key] === 'boolean') lockState[key] = incomingLocks[key];
      });
      if (parsed?.arduTarget && typeof parsed.arduTarget === 'object') {
        Object.keys(arduTargetState).forEach((k) => {
          if (parsed.arduTarget[k] !== undefined && parsed.arduTarget[k] !== null) {
            const t = typeof arduTargetState[k] === 'number' ? Number(parsed.arduTarget[k]) : parsed.arduTarget[k];
            if (typeof arduTargetState[k] === 'number' ? Number.isFinite(t) : true) arduTargetState[k] = t;
          }
        });
        syncConfigTextFromArdu();
        renderArduParamForm();
      }
      renderParams();
      refreshEventsFromParams();
    } catch {}
    e.target.value = '';
  });
}

try {
  const saved = JSON.parse(localStorage.getItem('visionLandingProfile') || 'null');
  const savedValues = saved?.values || saved;
  const savedLocks = saved?.locks || {};
  if (savedValues && typeof savedValues === 'object') {
    Object.keys(profileState).forEach((key) => {
      if (typeof savedValues[key] === 'number') profileState[key] = savedValues[key];
      if (typeof savedLocks[key] === 'boolean') lockState[key] = savedLocks[key];
    });
  }
} catch {}
applyTextOverrides();
updateDeveloperModeUI();
renderParams();
renderArduParamForm();
syncConfigTextFromArdu();
loadVisionConfigFromServer(null);

const eventsList = document.getElementById('eventsList');
const eventContextMenu = document.getElementById('eventContextMenu');
const timelineRange = document.getElementById('timelineRange');
const flightVideo = document.getElementById('flightVideo');
const videoInput = document.getElementById('videoInput');

const eventSamples = [
  { t: 5, type: 'Vision', msg: 'Vision lock acquired', key: 'vision_conf_min' },
  { t: 9, type: 'Control', msg: 'Cross-track correction started', key: 'xtrack_gain' },
  { t: 14, type: 'Laser', msg: 'Laser altitude valid', key: 'laser_detect_alt_m' },
  { t: 18, type: 'Flare', msg: 'Flare phase entered', key: 'flare_alt_m' },
  { t: 21, type: 'Flare', msg: 'Pitch-up command applied', key: 'flare_pitch_up_deg' },
  { t: 24, type: 'Motor', msg: 'Motor hold window started', key: 'motor_hold_s' },
  { t: 27, type: 'Safety', msg: 'Confidence dropped below abort threshold', key: 'abort_conf_min' },
  { t: 31, type: 'Takeoff', msg: 'Runway spool phase started', key: 'to_motor_spool_s' },
];

function formatEventRow(ev) {
  const val = profileState[ev.key];
  const t = Number(timelineRange?.value || 0);
  let cls = 'future';
  let icon = '?';
  if (ev.t < t - 0.5) { cls = 'past'; icon = '?'; }
  else if (Math.abs(ev.t - t) <= 0.5) { cls = 'current'; icon = '?'; }
  return `
    <article class="event-item ${cls}" data-event-time="${ev.t}" data-event-key="${ev.key}">
      <div class="event-time">t+${ev.t}s ? ${ev.type}</div>
      <div>${ev.msg}<span class="arrow">${icon}</span></div>
      <div class="event-time">?????: ${ev.key} = ${val}</div>
    </article>
  `;
}

function refreshEventsFromParams() {
  if (!eventsList) return;
  const t = Number(timelineRange?.value || 0);
  const near = eventSamples.filter((ev) => ev.t >= t - 14 && ev.t <= t + 14);
  eventsList.innerHTML = near.length
    ? near.map(formatEventRow).join('')
    : '<div class="event-item">??? ??????? ???? ???? ??????.</div>';
  bindEventContextMenu();
}

if (timelineRange) {
  timelineRange.addEventListener('input', refreshEventsFromParams);
}
refreshEventsFromParams();

if (videoInput && flightVideo) {
  videoInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    flightVideo.src = url;
  });
}

const healthBtn = document.getElementById('healthBtn');
const healthOut = document.getElementById('healthOut');
if (healthBtn && healthOut) {
  healthBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/health');
      healthOut.textContent = JSON.stringify(await res.json(), null, 2);
    } catch (err) {
      healthOut.textContent = `Health failed: ${err?.message || err}`;
    }
  });
}

const jetsonOnlineState = document.getElementById('jetsonOnlineState');
const jetsonLastSeen = document.getElementById('jetsonLastSeen');
const jetsonCpu = document.getElementById('jetsonCpu');
const jetsonTemp = document.getElementById('jetsonTemp');
const jetsonMem = document.getElementById('jetsonMem');
const jetsonOut = document.getElementById('jetsonOut');
const jetsonStatusDot = document.getElementById('jetsonStatusDot');
const jetsonRefreshBtn = document.getElementById('jetsonRefreshBtn');

/** Why: keep latest SSE-delivered telemetry accessible to the confidence-bar simulation. What: updated by SSE handler; read by the 1s sim interval. */
let latestVisionFromServer = null;
let latestJetsonFromServer = null;

/** Why: one fetch for manual refresh button (no need for polling anymore). What: pulls jetson status once on demand. */
async function refreshJetsonStatus() {
  try {
    const res = await fetch('/api/jetson/status');
    const data = await res.json();
    applyJetsonUi(data.online, data);
  } catch (err) {
    if (jetsonOut) jetsonOut.textContent = `????? ????? ????: ${err?.message || err}`;
  }
}

function applyJetsonUi(online, data) {
  if (jetsonStatusDot) jetsonStatusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  if (jetsonOnlineState) jetsonOnlineState.textContent = online ? '?????' : '?? ?????';
  if (jetsonLastSeen && data.ageMs != null) {
    const sec = Math.round(data.ageMs / 1000);
    jetsonLastSeen.textContent = sec < 5 ? '???? ???? ?-5 ?????' : `???? ${sec} ?????`;
  } else if (jetsonLastSeen) {
    jetsonLastSeen.textContent = '??? heartbeat';
  }
  if (jetsonCpu) jetsonCpu.textContent = data.cpuLoadPct != null ? `${data.cpuLoadPct}%` : '-';
  if (jetsonTemp) jetsonTemp.textContent = data.tempC != null ? `${data.tempC}?C` : '-';
  if (jetsonMem) jetsonMem.textContent = data.memPct != null ? `${data.memPct}%` : '-';
  const latEl = document.getElementById('heartbeatLatency');
  const qualEl = document.getElementById('linkQuality');
  if (latEl) latEl.textContent = data.ageMs != null ? `${Math.round(data.ageMs)}ms` : '-';
  if (qualEl) qualEl.textContent = data.linkQualityPct != null ? `${data.linkQualityPct}%` : '-';
}

if (jetsonRefreshBtn) jetsonRefreshBtn.addEventListener('click', refreshJetsonStatus);

const visionLateralEl = document.getElementById('visionLateralOffset');
const visionHeadingEl = document.getElementById('visionHeadingError');
const visionConfEl = document.getElementById('visionConfidence');
const visionAgeEl = document.getElementById('visionFrameAge');
const visionCountEl = document.getElementById('visionFrameCount');
const slamPosEl = document.getElementById('slamPos');
const slamQualEl = document.getElementById('slamQuality');
const slamLoopsEl = document.getElementById('slamLoopClosures');
const slamAgeEl = document.getElementById('slamAge');

function applyVisionUi(d) {
  if (!d) return;
  const fresh = d.ageMs != null && d.ageMs < 3000;
  if (visionLateralEl) visionLateralEl.textContent = d.lateralOffsetM != null ? `${d.lateralOffsetM.toFixed(2)}m` : '-';
  if (visionHeadingEl) visionHeadingEl.textContent = d.headingErrorDeg != null ? `${d.headingErrorDeg.toFixed(1)}?` : '-';
  if (visionConfEl) visionConfEl.textContent = d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '-';
  if (visionAgeEl) visionAgeEl.textContent = d.ageMs != null ? (d.ageMs > 3000 ? `${(d.ageMs / 1000).toFixed(1)}s ?` : `${d.ageMs}ms`) : '-';
  if (visionCountEl) visionCountEl.textContent = String(d.frameCount || 0);
  // Mark cards as DEMO or LIVE based on freshness
  document.querySelectorAll('[data-vision-card]').forEach((el) => {
    el.classList.toggle('demo-data', !fresh);
    el.classList.toggle('live-data', fresh);
  });
}

function applySlamUi(d) {
  if (!d) return;
  const fresh = d.ageMs != null && d.ageMs < 10000;
  if (slamPosEl) {
    slamPosEl.textContent = d.posX != null
      ? `(${d.posX.toFixed(1)}, ${d.posY.toFixed(1)}, ${d.posZ.toFixed(1)}m)`
      : '?? ????';
  }
  if (slamQualEl) slamQualEl.textContent = d.mapQuality != null ? `${Math.round(d.mapQuality * 100)}%` : '-';
  if (slamLoopsEl) slamLoopsEl.textContent = d.loopClosures != null ? String(d.loopClosures) : '-';
  if (slamAgeEl) slamAgeEl.textContent = d.ageMs != null ? (fresh ? `${Math.round(d.ageMs)}ms` : `${(d.ageMs / 1000).toFixed(0)}s ?`) : '?? ????';
  document.querySelectorAll('[data-slam-card]').forEach((el) => {
    el.classList.toggle('demo-data', !fresh);
    el.classList.toggle('live-data', fresh);
  });
}


/** Why: single SSE connection replaces all client-side polling (vision 500ms + jetson 5s) with server-pushed 300ms events. What: EventSource from /api/stream; on 'telemetry' event updates all UI components and shared state. */
(function startSseStream() {
  const src = new EventSource('/api/stream');
  src.addEventListener('telemetry', (e) => {
    try {
      const payload = JSON.parse(e.data);
      latestJetsonFromServer = payload.jetson;
      latestVisionFromServer = payload.vision;
      applyJetsonUi(payload.jetson?.online, payload.jetson || {});
      applyVisionUi(payload.vision);
      applySlamUi(payload.slam);
    } catch {}
  });
  src.onerror = () => {
    // SSE disconnected; mark as offline and retry automatically (browser reconnects)
    if (jetsonStatusDot) jetsonStatusDot.className = 'status-dot offline';
  };
})();

const flightSelect = document.getElementById('flightSelect');
const advisorFlightSelect = document.getElementById('advisorFlightSelect');
const refreshFlightsBtn = document.getElementById('refreshFlightsBtn');
const newFlightTitle = document.getElementById('newFlightTitle');
const createFlightBtn = document.getElementById('createFlightBtn');
const flightNoteBody = document.getElementById('flightNoteBody');
const saveFlightNoteBtn = document.getElementById('saveFlightNoteBtn');
const logSourceSelect = document.getElementById('logSourceSelect');
const logFileInput = document.getElementById('logFileInput');
const uploadLogBtn = document.getElementById('uploadLogBtn');
const flightLogsOut = document.getElementById('flightLogsOut');
const logDropZone = document.getElementById('logDropZone');
const logPickFileBtn = document.getElementById('logPickFileBtn');
const logFileNameDisplay = document.getElementById('logFileNameDisplay');
const pullLogsBtn = document.getElementById('pullLogsBtn');

/** Why: show chosen filename in the modern drop zone; what: updates label after native input or drag-drop. */
function updateLogFileNameDisplay() {
  if (!logFileNameDisplay || !logFileInput) return;
  const f = logFileInput.files?.[0];
  logFileNameDisplay.textContent = f ? f.name : '?? ???? ????';
}

/** Why: pills mirror hidden select so upload FormData stays unchanged; what: syncs active pill to `logSourceSelect.value`. */
function syncLogSourcePills() {
  const v = logSourceSelect?.value || 'ardupilot';
  document.querySelectorAll('.log-source-pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.logSource === v);
  });
}

document.querySelectorAll('.log-source-pill').forEach((p) => {
  p.addEventListener('click', () => {
    const v = p.dataset.logSource;
    if (logSourceSelect && v) logSourceSelect.value = v;
    syncLogSourcePills();
  });
});
syncLogSourcePills();
logFileInput?.addEventListener('change', updateLogFileNameDisplay);

logPickFileBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  logFileInput?.click();
});

['dragenter', 'dragover'].forEach((ev) => {
  logDropZone?.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    logDropZone.classList.add('log-drop-active');
  });
});
logDropZone?.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (!logDropZone.contains(e.relatedTarget)) logDropZone.classList.remove('log-drop-active');
});
logDropZone?.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  logDropZone.classList.remove('log-drop-active');
  const f = e.dataTransfer?.files?.[0];
  if (!f || !logFileInput) return;
  const dt = new DataTransfer();
  dt.items.add(f);
  logFileInput.files = dt.files;
  updateLogFileNameDisplay();
});

/** Why: keep advisor and log UI aligned with server flight list. What: fills both selects from GET /api/flights. */
async function refreshFlightLists() {
  try {
    const res = await fetch('/api/flights');
    const data = await res.json();
    const flights = data.flights || [];
    const opts = flights.map((f) => `<option value="${f.id}">${f.title} (#${f.id})</option>`).join('');
    if (flightSelect) flightSelect.innerHTML = opts || '<option value="">??? ????? ? ??? ???? ????</option>';
    if (advisorFlightSelect) {
      advisorFlightSelect.innerHTML = `<option value="">?? ?????? ?????</option>${opts}`;
    }
  } catch (err) {
    if (flightLogsOut) flightLogsOut.textContent = `????? ????? ?????: ${err?.message || err}`;
  }
}

/** Why: show uploaded logs for selected flight. What: GET /api/flights/:id/logs. */
async function refreshFlightLogsList() {
  if (!flightSelect || !flightLogsOut) return;
  const id = Number(flightSelect.value);
  if (!id) {
    flightLogsOut.textContent = '??? ????.';
    return;
  }
  try {
    const res = await fetch(`/api/flights/${id}/logs`);
    const data = await res.json();
    flightLogsOut.textContent = JSON.stringify(data.logs || [], null, 2);
  } catch (err) {
    flightLogsOut.textContent = `?????: ${err?.message || err}`;
  }
}

if (refreshFlightsBtn) refreshFlightsBtn.addEventListener('click', () => { refreshFlightLists().then(refreshFlightLogsList); });
if (flightSelect) flightSelect.addEventListener('change', refreshFlightLogsList);
if (createFlightBtn) {
  createFlightBtn.addEventListener('click', async () => {
    const title = String(newFlightTitle?.value || '').trim();
    try {
      const res = await fetch('/api/flights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || undefined }),
      });
      const data = await res.json();
      if (data.flight?.id && flightSelect) flightSelect.value = String(data.flight.id);
      if (newFlightTitle) newFlightTitle.value = '';
      await refreshFlightLists();
      await refreshFlightLogsList();
    } catch {}
  });
}
if (saveFlightNoteBtn) {
  saveFlightNoteBtn.addEventListener('click', async () => {
    const id = Number(flightSelect?.value);
    const body = String(flightNoteBody?.value || '').trim();
    if (!id || !body) return;
    try {
      await fetch(`/api/flights/${id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (flightNoteBody) flightNoteBody.value = '';
      if (flightLogsOut) flightLogsOut.textContent = '???? ?????.';
    } catch (err) {
      if (flightLogsOut) flightLogsOut.textContent = `????? ???? ?????: ${err?.message || err}`;
    }
  });
}
if (uploadLogBtn) {
  uploadLogBtn.addEventListener('click', async () => {
    const id = Number(flightSelect?.value);
    const file = logFileInput?.files?.[0];
    if (!id || !file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('source', String(logSourceSelect?.value || 'ardupilot'));
    try {
      const res = await fetch(`/api/flights/${id}/logs`, { method: 'POST', body: fd });
      const data = await res.json();
      if (flightLogsOut) flightLogsOut.textContent = JSON.stringify(data, null, 2);
      if (logFileInput) logFileInput.value = '';
      updateLogFileNameDisplay();
      await refreshFlightLogsList();
    } catch (err) {
      if (flightLogsOut) flightLogsOut.textContent = `????? ?????: ${err?.message || err}`;
    }
  });
}
refreshFlightLists().then(refreshFlightLogsList);

const linkState = document.getElementById('linkState');
const lastRefresh = document.getElementById('lastRefresh');
const eventsCount = document.getElementById('eventsCount');
const telemetryConfidence = document.getElementById('telemetryConfidence');
const abortState = document.getElementById('abortState');
const takeoffState = document.getElementById('takeoffState');
const gpsSatsInput = document.getElementById('gpsSatsInput');
const crosswindInput = document.getElementById('crosswindInput');
const groundSpeedInput = document.getElementById('groundSpeedInput');
const spoolInput = document.getElementById('spoolInput');
const runChecklistBtn = document.getElementById('runChecklistBtn');
const checklistList = document.getElementById('checklistList');
const processFlow = document.getElementById('processFlow');
const processPrevBtn = document.getElementById('processPrevBtn');
const processNextBtn = document.getElementById('processNextBtn');
if (gpsSatsInput) {
  gpsSatsInput.min = '10';
  gpsSatsInput.max = '40';
  if (Number(gpsSatsInput.value) < 10) gpsSatsInput.value = '10';
}
const liveConfidenceBar = document.getElementById('liveConfidenceBar');
const liveConfidenceText = document.getElementById('liveConfidenceText');
let lowConfidenceSeconds = 0;

function computeChecklist(currentConfidence) {
  const gpsSats = Number(gpsSatsInput?.value || 0);
  const crosswind = Number(crosswindInput?.value || 0);
  const groundSpeed = Number(groundSpeedInput?.value || 0);
  const spool = Number(spoolInput?.value || 0);
  const checks = [
    {
      label: `GPS ????? (${gpsSats} / ??????? ${profileState.to_min_gps_sats})`,
      pass: gpsSats >= Number(profileState.to_min_gps_sats || 10),
    },
    {
      label: `??? ?? ????? (${crosswind.toFixed(1)} / ??? ${profileState.to_max_crosswind_ms})`,
      pass: crosswind <= Number(profileState.to_max_crosswind_ms || 8),
    },
    {
      label: `???? ???? ????? (${spool.toFixed(1)}s / ???? ${profileState.to_motor_spool_s}s)`,
      pass: spool >= Number(profileState.to_motor_spool_s || 2.2),
    },
    {
      label: `?????? ???? ????? ?????? (${groundSpeed.toFixed(1)} < ${profileState.to_rotate_speed_ms})`,
      pass: groundSpeed < Number(profileState.to_rotate_speed_ms || 13),
    },
    {
      label: `?????? Vision ??? ?? Abort (${Math.round(currentConfidence * 100)}% >= ${Math.round(Number(profileState.abort_conf_min || 0.7) * 100)}%)`,
      pass: currentConfidence >= Number(profileState.abort_conf_min || 0.7),
    },
  ];
  return checks;
}

function renderChecklist(checks) {
  if (!checklistList) return;
  checklistList.innerHTML = checks.map((c) => `
    <article class="check-item ${c.pass ? 'pass' : 'fail'}">
      <span>${c.label}</span>
      <strong>${c.pass ? 'PASS' : 'FAIL'}</strong>
    </article>
  `).join('');
}

function renderProcessFlow() {
  if (!processFlow) return;
  processFlow.innerHTML = PROCESS_STEPS.map((title, idx) => {
    let cls = 'pending';
    if (idx < processIndex) cls = 'done';
    if (idx === processIndex) cls = 'active';
    return `
      <article class="process-card ${cls}">
        <div class="process-index">??? ${idx + 1}</div>
        <div class="process-title">${title}</div>
        ${idx < processIndex ? '<div class="process-check">V</div>' : ''}
      </article>
    `;
  }).join('');
}

/** Why: confidence bar shows real Vision data when hardware is connected (ageMs < 3s); shows "??? ?????" otherwise. What: runs every 1s. */
setInterval(() => {
  const visionFresh = latestVisionFromServer != null && latestVisionFromServer.ageMs != null && latestVisionFromServer.ageMs < 3000;
  let current;
  let sourceLabel;
  if (visionFresh) {
    current = Math.max(0, Math.min(1, latestVisionFromServer.confidence ?? 0));
    sourceLabel = latestJetsonFromServer?.online ? '?????' : '????? (Vision)';
  } else {
    current = 0;
    sourceLabel = '??? ?????';
    lowConfidenceSeconds = 0;
  }
  const pct = visionFresh ? Math.round(current * 100) : null;
  const abortThreshold = Number(profileState.abort_conf_min || 0.7);
  const holdNeeded = Number(profileState.abort_conf_hold_s || 2);
  const recoverThreshold = Number(profileState.abort_recover_conf || (abortThreshold + 0.05));
  if (visionFresh && current < abortThreshold) lowConfidenceSeconds += 1;
  else if (visionFresh && current >= recoverThreshold) lowConfidenceSeconds = Math.max(0, lowConfidenceSeconds - 1);
  const isAbort = lowConfidenceSeconds >= holdNeeded;
  const checks = computeChecklist(current);
  const takeoffReady = checks.every((c) => c.pass);
  if (linkState) linkState.textContent = sourceLabel;
  if (lastRefresh) lastRefresh.textContent = new Date().toLocaleTimeString();
  if (eventsCount) eventsCount.textContent = String(eventSamples.length);
  if (telemetryConfidence) telemetryConfidence.textContent = pct != null ? `${pct}%` : '?';
  if (abortState) abortState.textContent = isAbort ? `ABORT (${lowConfidenceSeconds.toFixed(0)}s)` : `ARMED (${lowConfidenceSeconds.toFixed(0)}s)`;
  if (takeoffState) takeoffState.textContent = takeoffReady ? 'READY' : 'HOLD';
  if (liveConfidenceText) liveConfidenceText.textContent = pct != null ? `${pct}%` : '?';
  if (liveConfidenceBar) liveConfidenceBar.style.width = pct != null ? `${pct}%` : '0%';
  if (liveConfidenceBar) liveConfidenceBar.classList.toggle('bar-live', visionFresh);
  renderChecklist(checks);
  /* renderProcessFlow only when processIndex changes (buttons); not every telemetry tick */
}, 1000);
if (runChecklistBtn) {
  runChecklistBtn.addEventListener('click', () => {
    const currentText = String(telemetryConfidence?.textContent || '0').replace('%', '');
    const confidence = Math.max(0, Math.min(1, Number(currentText) / 100));
    renderChecklist(computeChecklist(confidence));
  });
}

if (processPrevBtn) {
  processPrevBtn.addEventListener('click', () => {
    processIndex = Math.max(0, processIndex - 1);
    renderProcessFlow();
  });
}
if (processNextBtn) {
  processNextBtn.addEventListener('click', () => {
    processIndex = Math.min(PROCESS_STEPS.length - 1, processIndex + 1);
    renderProcessFlow();
  });
}

const configText = document.getElementById('configText');
const downloadParamBtn = document.getElementById('downloadParamBtn');
const applyToMpBtn = document.getElementById('applyToMpBtn');
const mpOut = document.getElementById('mpOut');

/** Why: pilot downloads a ready-to-import .param file ? no manual copy-paste needed. What: creates a Blob from configText and triggers browser download. */
if (downloadParamBtn && configText) {
  downloadParamBtn.addEventListener('click', () => {
    syncConfigTextFromArdu();
    const blob = new Blob([configText.textContent || ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vision-landing.param';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

if (applyToMpBtn && configText) {
  applyToMpBtn.addEventListener('click', async () => {
    try {
      syncConfigTextFromArdu();
      const res = await fetch('/api/mission-planner/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configText: configText.textContent || '' }),
      });
      const data = await res.json();
      if (mpOut) { mpOut.classList.add('visible'); mpOut.textContent = data.message || JSON.stringify(data, null, 2); }
    } catch (err) {
      if (mpOut) { mpOut.classList.add('visible'); mpOut.textContent = `?????: ${err?.message || err}`; }
    }
  });
}

const advisorMessages = document.getElementById('advisorMessages');
const advisorInput = document.getElementById('advisorInput');
const advisorSendBtn = document.getElementById('advisorSendBtn');
const advisorStatus = document.getElementById('advisorStatus');
const advisorMicBtn = document.getElementById('advisorMicBtn');

/** Why: Gemini returns markdown; raw textContent shows asterisks/hashes literally. What: minimal safe renderer ? escapes HTML first, then applies bold/italic/lists. */
function renderMarkdown(raw) {
  const esc = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc.split('\n');
  let html = '';
  let listType = '';
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = ''; } };
  const inline = (s) => s
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  for (const line of lines) {
    const t = line.trim();
    const ol = t.match(/^(\d+)\.\s+([\s\S]+)$/);
    const ul = t.match(/^[-*]\s+([\s\S]+)$/);
    const h = t.match(/^(#{1,3})\s+([\s\S]+)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inline(ol[2])}</li>`;
    } else if (ul) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${inline(ul[1])}</li>`;
    } else if (h) {
      closeList();
      const lvl = h[1].length;
      html += `<h${lvl} class="md-h">${inline(h[2])}</h${lvl}>`;
    } else if (t === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(t)}</p>`;
    }
  }
  closeList();
  return html;
}

function pushMsg(role, text) {
  if (!advisorMessages) {
    if (advisorStatus) advisorStatus.textContent = `?'?? ?? ????: ??? advisorMessages (role=${role})`;
    return;
  }
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.innerHTML = renderMarkdown(text);
  advisorMessages.appendChild(node);
  if (role === 'bot') {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    advisorMessages.scrollTop = advisorMessages.scrollHeight;
  }
}

/** Why: one round-trip to server (Gemini + retrieval + digest). What: returns assistant text, merges server errors into visible chat, or local fallback when fetch/JSON fails. */
async function advisorReply(q) {
  const local = localAdvisorReply(q);
  try {
    const fidRaw = advisorFlightSelect?.value;
    const flightId = fidRaw ? Number(fidRaw) : null;
    const res = await fetch('/api/advisor-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        params: profileState,
        flightId: Number.isInteger(flightId) && flightId > 0 ? flightId : null,
      }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      return `${local}\n\n[???? ????? ????? ????? JSON ? ???? ??? node server.js ???????? VisionLandingConsole ??????? 4010 ????.]`;
    }
    const replyText = typeof data?.reply === 'string' ? data.reply.trim() : '';
    if (data?.ok && replyText) {
      const tag = data.source ? ` [${data.source}]` : '';
      return `${data.reply}${tag}`;
    }
    const serverMsg = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : `HTTP ${res.status}`;
    return `${local}\n\n[???? ???: ${serverMsg}]`;
  } catch (e) {
    const hint = e?.message || String(e);
    return `${local}\n\n[???/?????: ${hint}]`;
  }
}

async function handleAdvisorSend() {
  if (advisorInput) {
    const q = advisorInput.value.trim();
    if (!q) return;
    if (advisorSendBtn) advisorSendBtn.disabled = true;
    if (advisorStatus) advisorStatus.textContent = '?????';
    try {
      pushMsg('user', q);
      const reply = await advisorReply(q);
      if (reply) pushMsg('bot', reply);
      advisorInput.value = '';
      if (advisorStatus) advisorStatus.textContent = '????';
    } catch {
      pushMsg('bot', localAdvisorReply(q));
      if (advisorStatus) advisorStatus.textContent = '????? ? ????? ??????';
    } finally {
      if (advisorSendBtn) advisorSendBtn.disabled = false;
    }
  }
}

if (advisorSendBtn && advisorInput) {
  advisorSendBtn.addEventListener('click', handleAdvisorSend);
  advisorInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdvisorSend();
  });
  if (advisorStatus && advisorStatus.textContent === '????') advisorStatus.textContent = "?'?? ????? (??????? ??????)";
} else {
  if (advisorStatus) advisorStatus.textContent = "?'?? ?? ????: ????? advisorSendBtn ?? advisorInput";
}

/** Why: quick voice capture without typing. What: Web Speech API fills advisor input (browser-dependent). */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (advisorMicBtn && SR) {
  const rec = new SR();
  rec.lang = 'he-IL';
  rec.interimResults = false;
  rec.onresult = (e) => {
    const t = e.results[0][0].transcript;
    if (advisorInput) advisorInput.value = t;
    advisorMicBtn.classList.remove('recording');
    if (advisorStatus) advisorStatus.textContent = '????? ???? ? ???? ????';
  };
  rec.onend = () => advisorMicBtn.classList.remove('recording');
  rec.onerror = () => {
    advisorMicBtn.classList.remove('recording');
    if (advisorStatus) advisorStatus.textContent = '????????: ?????';
  };
  advisorMicBtn.addEventListener('click', () => {
    try {
      rec.start();
      advisorMicBtn.classList.add('recording');
      if (advisorStatus) advisorStatus.textContent = '??????';
    } catch {
      if (advisorStatus) advisorStatus.textContent = '?? ???? ?????? ?????';
    }
  });
} else if (advisorMicBtn) {
  advisorMicBtn.disabled = true;
  advisorMicBtn.title = '?????? ?? ???? ?????? ?????';
}
/* Welcome line is static in index.html (data-static-welcome) ? avoids empty chat if script stops early. */
renderProcessFlow();

const versionBtn = document.getElementById('versionBtn');
const versionModal = document.getElementById('versionModal');
const versionModalContent = document.getElementById('versionModalContent');
const closeVersionModalBtn = document.getElementById('closeVersionModalBtn');

/** Why: VERSION_HISTORY is the single source of truth; modal is rendered here to stay in sync. What: builds HTML from the array and injects it into the modal skeleton. */
function renderVersionModal() {
  if (!versionModalContent) return;
  versionModalContent.innerHTML = VERSION_HISTORY.map((entry, i) => {
    const isCurrent = i === 0;
    return `
      <div style="margin-bottom:1rem">
        <h3 style="${isCurrent ? 'color:#4ade80' : 'color:#94a3b8'}">
          ${isCurrent ? '? ' : ''}???? ${entry.version} <small style="font-size:0.75rem;opacity:0.7">${entry.date}</small>
        </h3>
        <ul>${entry.changes.map((c) => `<li>${c}</li>`).join('')}</ul>
      </div>`;
  }).join('<hr style="border-color:#334155;margin:0.5rem 0"/>');
}

if (versionBtn && versionModal) {
  versionBtn.textContent = `v${APP_VERSION_NEW}`;
  versionBtn.addEventListener('click', () => {
    renderVersionModal();
    versionModal.classList.remove('hidden');
  });
}
if (closeVersionModalBtn && versionModal) {
  closeVersionModalBtn.addEventListener('click', () => versionModal.classList.add('hidden'));
}
if (versionModal) {
  versionModal.addEventListener('click', (e) => {
    if (e.target === versionModal) versionModal.classList.add('hidden');
  });
}

function bindEventContextMenu() {
  if (!eventsList || !eventContextMenu) return;
  eventsList.querySelectorAll('.event-item').forEach((node) => {
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedContextEvent = {
        t: Number(node.dataset.eventTime || 0),
        key: node.dataset.eventKey || '',
      };
      eventContextMenu.style.left = `${e.clientX}px`;
      eventContextMenu.style.top = `${e.clientY}px`;
      eventContextMenu.classList.remove('hidden');
    });
  });
}
bindEventContextMenu();
window.addEventListener('click', () => {
  if (eventContextMenu) eventContextMenu.classList.add('hidden');
});
if (eventContextMenu) {
  eventContextMenu.addEventListener('click', (e) => {
    const action = e.target?.dataset?.action;
    if (!action || !selectedContextEvent) return;
    const key = selectedContextEvent.key;
    const def = PARAMS.find((p) => p.key === key);
    if (!def) return;
    if (action === 'inc') profileState[key] = Math.min(def.max, Number(profileState[key]) + Number(def.step));
    if (action === 'dec') profileState[key] = Math.max(def.min, Number(profileState[key]) - Number(def.step));
    if (action === 'jump' && timelineRange) timelineRange.value = String(selectedContextEvent.t);
    renderParams();
    refreshEventsFromParams();
  });
}


const arduReadBtn = document.getElementById('arduReadBtn');
const arduWriteBtn = document.getElementById('arduWriteBtn');
const arduWriteStatus = document.getElementById('arduWriteStatus');
const arduDiffSection = document.getElementById('arduDiffSection');
const arduDiffTable = document.getElementById('arduDiffTable');
const arduDiffSummary = document.getElementById('arduDiffSummary');

/** Why: after reading or writing, shows a clear diff table of every parameter ? green=match, red=mismatch. What: renders rows with current vs target value comparison. */
function renderArduDiff(current, target) {
  if (!arduDiffTable || !arduDiffSection) return;
  const rows = Object.entries(target).map(([key, want]) => {
    const have = current[key];
    const match = String(have) === String(want);
    return `<tr class="${match ? 'diff-match' : 'diff-mismatch'}">
      <td class="diff-key">${key}</td>
      <td class="diff-have">${have != null ? have : '?'}</td>
      <td class="diff-want">${want}</td>
      <td class="diff-status">${match ? '?' : '? ????'}</td>
    </tr>`;
  }).join('');
  arduDiffTable.innerHTML = `<table class="diff-inner">
    <thead><tr><th>?????</th><th>????? ?????</th><th>?????</th><th>?????</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  arduDiffSection.classList.add('visible');
  const mismatches = Object.entries(target).filter(([k, v]) => String(current[k]) !== String(v)).length;
  if (arduDiffSummary) {
    arduDiffSummary.textContent = mismatches === 0
      ? '? ?? ???????? ??? ?????? ? ??? ???? ?-WRITE ?????'
      : `${mismatches} ??????? ????? ? ??? WRITE ????? ??????`;
    arduDiffSummary.style.color = mismatches === 0 ? '#4ade80' : '#fbbf24';
  }
}

if (arduReadBtn) {
  arduReadBtn.addEventListener('click', async () => {
    arduReadBtn.textContent = '? ???? ??????';
    try {
      const res = await fetch('/api/ardu/params');
      const d = await res.json();
      arduReadBtn.textContent = '?? READ ? ??????';
      if (!d.connected || !d.current) {
        if (arduWriteStatus) { arduWriteStatus.textContent = '?? ????? ? ??? ?-ArduPilot ??? MAVProxy'; arduWriteStatus.className = 'ardu-write-status fail'; }
      } else {
        renderArduDiff(d.current, arduTargetState);
      }
    } catch { arduReadBtn.textContent = '?? READ ? ??????'; }
  });
}

/** Why: avoid ReferenceError and share one Leaflet instance; what: toolbar element refs, layer handles, and coverage circle list for terrain tab. */
const terrainLayerStreetBtn = document.getElementById('terrainLayerStreetBtn');
const terrainLayerSatBtn = document.getElementById('terrainLayerSatBtn');
const terrainMappedOnlyBtn = document.getElementById('terrainMappedOnlyBtn');
const terrainClearBtn = document.getElementById('terrainClearBtn');
const terrainCellCount = document.getElementById('terrainCellCount');
const terrainAreaEst = document.getElementById('terrainAreaEst');

let terrainMap = null;
let terrainStreetLayer = null;
let terrainSatLayer = null;
let terrainCircles = [];
let terrainLastCells = [];
let terrainMappedOnly = false;
let terrainActiveBase = 'street';

/** Why: map must exist before coverage circles and basemap toggles; what: creates L.map once with leaflet-rotate, OSM/Esri layers, and bearing control. */
function initTerrainMap() {
  const mapEl = document.getElementById('terrainMap');
  if (!mapEl || terrainMap) return;

  const mapOpts = { zoomControl: true, rotate: true, bearing: 0 };
  terrainMap = L.map(mapEl, mapOpts);

  terrainStreetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  });
  terrainSatLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
  );

  terrainStreetLayer.addTo(terrainMap);
  terrainMap.setView([31.5, 34.85], 8);

  const BearingCtrl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd(m) {
      const root = L.DomUtil.create('div', 'terrain-bearing-control leaflet-bar');
      root.innerHTML =
        '<span class="terrain-rot-deg">0?</span><input type="range" class="terrain-rot-slider" min="-180" max="180" value="0" aria-label="????? ???" /><button type="button" class="terrain-rot-north" title="????">N</button>';
      const slider = root.querySelector('.terrain-rot-slider');
      const degEl = root.querySelector('.terrain-rot-deg');
      const northBtn = root.querySelector('.terrain-rot-north');

      const applyDeg = (d) => {
        let x = Number(d);
        if (!Number.isFinite(x)) x = 0;
        if (typeof m.setBearing === 'function') m.setBearing(x);
        if (degEl) degEl.textContent = `${Math.round(x)}?`;
        if (slider) slider.value = String(Math.round(x));
      };

      if (typeof m.setBearing !== 'function') {
        root.classList.add('disabled');
        if (degEl) degEl.textContent = '?';
      } else {
        L.DomEvent.on(slider, 'input', (ev) => applyDeg(ev.target.value));
        L.DomEvent.on(northBtn, 'click', () => applyDeg(0));
      }

      L.DomEvent.disableClickPropagation(root);
      L.DomEvent.disableScrollPropagation(root);
      return root;
    },
  });
  terrainMap.addControl(new BearingCtrl());

  setTimeout(() => terrainInvalidateLayout(), 0);
}

/** Why: satellite vs street, or hide all tiles for ?mapped only? white canvas; what: toggles tile pane and active TileLayer. */
function applyTerrainBasemapVisibility() {
  if (!terrainMap) return;
  const c = terrainMap.getContainer();
  const tp = terrainMap.getPanes().tilePane;
  if (terrainMappedOnly) {
    tp.style.display = 'none';
    c.classList.add('terrain-mapped-only-bg');
    return;
  }
  tp.style.display = '';
  c.classList.remove('terrain-mapped-only-bg');
  if (terrainStreetLayer && terrainSatLayer) {
    if (terrainMap.hasLayer(terrainStreetLayer)) terrainMap.removeLayer(terrainStreetLayer);
    if (terrainMap.hasLayer(terrainSatLayer)) terrainMap.removeLayer(terrainSatLayer);
    if (terrainActiveBase === 'satellite') terrainSatLayer.addTo(terrainMap);
    else terrainStreetLayer.addTo(terrainMap);
  }
}

function terrainInvalidateLayout() {
  if (!terrainMap) return;
  terrainMap.invalidateSize();
  requestAnimationFrame(() => terrainMap.invalidateSize());
}

/** Why: align circle colors with the legend (???? ???? ? ???? ????); what: maps normalized altitude 0..1 to HSL hue 240..0. */
function terrainAltNormToColor(t) {
  const tt = Math.max(0, Math.min(1, t));
  const h = 240 * (1 - tt);
  return `hsl(${h}, 82%, 46%)`;
}

/** Why: legend ticks should reflect real data range when cells carry AGL; what: updates three spans if present. */
function updateTerrainAltLegendTicks(minM, maxM) {
  const lo = document.getElementById('terrainAltTickMin');
  const mid = document.getElementById('terrainAltTickMid');
  const hi = document.getElementById('terrainAltTickMax');
  if (!lo || !mid || !hi) return;
  const fmt = (n) => `${Math.round(n)}m`;
  if (!Number.isFinite(minM) || !Number.isFinite(maxM) || maxM <= minM) {
    lo.textContent = '~5m';
    mid.textContent = '~45m';
    hi.textContent = '~90m+';
    return;
  }
  lo.textContent = fmt(minM);
  mid.textContent = fmt((minM + maxM) / 2);
  hi.textContent = fmt(maxM);
}

/** Why: pilot sees where visual nav was mapped at which AGL; what: draws circles colored by aglM/altM (min?max in view), popup keeps quality + radius. */
function renderTerrainCoverage(cells) {
  if (!terrainMap) return;
  terrainLastCells = Array.isArray(cells) ? cells.slice() : [];
  terrainCircles.forEach((c) => terrainMap.removeLayer(c));
  terrainCircles = [];
  let totalArea = 0;
  const fillOp = terrainMappedOnly ? 0.52 : 0.38;

  const list = terrainLastCells;
  const finiteAlts = list
    .map((c) => {
      const a = c.aglM != null ? Number(c.aglM) : c.altM != null ? Number(c.altM) : NaN;
      return Number.isFinite(a) ? a : null;
    })
    .filter((a) => a != null);
  let minA = finiteAlts.length ? Math.min(...finiteAlts) : NaN;
  let maxA = finiteAlts.length ? Math.max(...finiteAlts) : NaN;
  if (!Number.isFinite(minA) || !Number.isFinite(maxA)) {
    minA = 5;
    maxA = 90;
  }
  if (maxA <= minA) maxA = minA + 1;
  updateTerrainAltLegendTicks(minA, maxA);

  list.forEach((cell) => {
    const q = cell.quality || 0.5;
    const r = cell.radiusM || 15;
    let altM = cell.aglM != null ? Number(cell.aglM) : cell.altM != null ? Number(cell.altM) : NaN;
    if (!Number.isFinite(altM)) {
      altM = minA + (maxA - minA) * q;
    }
    const t = (altM - minA) / (maxA - minA);
    const color = terrainAltNormToColor(t);
    const circle = L.circle([cell.lat, cell.lon], {
      radius: r, color, fillColor: color, fillOpacity: fillOp, weight: 1.5,
    }).addTo(terrainMap);
    circle.bindPopup(`???? ????? (AGL): ${Math.round(altM)}m ? ?????: ${Math.round(q * 100)}% ? ?????: ${r.toFixed(0)}m`);
    terrainCircles.push(circle);
    totalArea += Math.PI * r * r;
  });
  if (terrainCellCount) terrainCellCount.textContent = String(list.length);
  if (terrainAreaEst) terrainAreaEst.textContent = list.length > 0 ? `${Math.round(totalArea)} m?` : '0 m?';
  if (list.length > 0) {
    const lats = list.map((c) => c.lat);
    const lons = list.map((c) => c.lon);
    terrainMap.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [30, 30] }
    );
  }
  terrainInvalidateLayout();
}

async function loadTerrainCoverage() {
  try {
    const res = await fetch('/api/terrain/coverage');
    const d = await res.json();
    if (d.cells) renderTerrainCoverage(d.cells);
  } catch {}
}

function onTerrainTabActivated() {
  setTimeout(() => {
    initTerrainMap();
    applyTerrainBasemapVisibility();
    loadTerrainCoverage();
    terrainInvalidateLayout();
  }, 100);
}

document.querySelectorAll('.tab').forEach((btn) => {
  if (btn.dataset.tab === 'terrain') {
    btn.addEventListener('click', onTerrainTabActivated);
  }
});

if (terrainLayerStreetBtn) {
  terrainLayerStreetBtn.addEventListener('click', () => {
    terrainActiveBase = 'street';
    terrainLayerStreetBtn.classList.add('active');
    terrainLayerSatBtn?.classList.remove('active');
    applyTerrainBasemapVisibility();
    terrainInvalidateLayout();
  });
}

if (terrainLayerSatBtn) {
  terrainLayerSatBtn.addEventListener('click', () => {
    terrainActiveBase = 'satellite';
    terrainLayerSatBtn.classList.add('active');
    terrainLayerStreetBtn?.classList.remove('active');
    applyTerrainBasemapVisibility();
    terrainInvalidateLayout();
  });
}

if (terrainMappedOnlyBtn) {
  terrainMappedOnlyBtn.addEventListener('click', () => {
    terrainMappedOnly = !terrainMappedOnly;
    terrainMappedOnlyBtn.classList.toggle('active', terrainMappedOnly);
    applyTerrainBasemapVisibility();
    if (terrainMap && terrainLastCells.length) {
      renderTerrainCoverage(terrainLastCells);
    } else {
      terrainInvalidateLayout();
    }
  });
}

if (terrainClearBtn) {
  terrainClearBtn.addEventListener('click', () => {
    terrainCircles.forEach((c) => terrainMap?.removeLayer(c));
    terrainCircles = [];
    terrainLastCells = [];
    if (terrainCellCount) terrainCellCount.textContent = '0';
    if (terrainAreaEst) terrainAreaEst.textContent = '0 m?';
    terrainInvalidateLayout();
  });
}

/* ??? CAMERA ANNOTATIONS ??? */
const annotationCanvas = document.getElementById('annotationCanvas');
const annotationsToggleBtn = document.getElementById('annotationsToggleBtn');
const lockIndicator = document.getElementById('lockIndicator');
const annotConfidence = document.getElementById('annotConfidence');
let annotationsEnabled = true;
let annotationTimer = null;

/** Why: pilot needs to see what the vision system locked onto in the recording. What: draws detection boxes, confidence text, and lock indicator on a canvas overlaid over the video. */
function drawAnnotations(video, canvas) {
  if (!canvas || !video || !annotationsEnabled) return;
  const ctx = canvas.getContext('2d');
  canvas.width = video.offsetWidth;
  canvas.height = video.offsetHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const conf = latestVisionFromServer?.confidence ?? (0.65 + Math.sin((video.currentTime || 0) * 0.8) * 0.25);
  const lateral = latestVisionFromServer?.lateralOffsetM ?? (Math.sin((video.currentTime || 0) * 0.4) * 1.5);
  const isLocked = conf > 0.72;
  const isSearching = conf > 0.45 && conf <= 0.72;

  const cx = canvas.width / 2 + (lateral / 5) * (canvas.width * 0.15);
  const cy = canvas.height * 0.52;
  const bw = canvas.width * 0.22, bh = canvas.height * 0.28;
  ctx.strokeStyle = isLocked ? '#4ade80' : isSearching ? '#fbbf24' : '#ef4444';
  ctx.lineWidth = 2.5;
  ctx.setLineDash(isLocked ? [] : [6, 4]);
  ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
  ctx.setLineDash([]);

  const cl = 14;
  ctx.lineWidth = 3;
  [[cx - bw / 2, cy - bh / 2], [cx + bw / 2, cy - bh / 2], [cx - bw / 2, cy + bh / 2], [cx + bw / 2, cy + bh / 2]].forEach(([x, y]) => {
    ctx.beginPath(); ctx.moveTo(x, y + Math.sign(y - cy) * cl); ctx.lineTo(x, y); ctx.lineTo(x + Math.sign(x - cx) * cl, y); ctx.stroke();
  });

  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = isLocked ? '#4ade80' : '#fbbf24';
  ctx.fillText(`${Math.round(conf * 100)}%`, cx - bw / 2, cy - bh / 2 - 6);

  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
  ctx.setLineDash([]);

  if (lockIndicator) {
    lockIndicator.textContent = isLocked ? '???? ?' : isSearching ? '?????' : '??? ?????';
    lockIndicator.className = `lock-indicator ${isLocked ? 'locked' : isSearching ? 'searching' : 'no-lock'}`;
  }
  if (annotConfidence) annotConfidence.textContent = `??????: ${Math.round(conf * 100)}%`;
}

if (flightVideo && annotationCanvas) {
  flightVideo.addEventListener('play', () => {
    clearInterval(annotationTimer);
    annotationTimer = setInterval(() => drawAnnotations(flightVideo, annotationCanvas), 66);
  });
  flightVideo.addEventListener('pause', () => clearInterval(annotationTimer));
  flightVideo.addEventListener('ended', () => {
    clearInterval(annotationTimer);
    annotationCanvas.getContext('2d').clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    if (lockIndicator) { lockIndicator.textContent = '??? ?????'; lockIndicator.className = 'lock-indicator no-lock'; }
  });
  flightVideo.addEventListener('timeupdate', () => {
    if (flightVideo.paused) drawAnnotations(flightVideo, annotationCanvas);
  });
  window.addEventListener('resize', () => drawAnnotations(flightVideo, annotationCanvas));
}

if (annotationsToggleBtn) {
  annotationsToggleBtn.addEventListener('click', () => {
    annotationsEnabled = !annotationsEnabled;
    annotationsToggleBtn.textContent = `????????: ${annotationsEnabled ? '????' : '????'}`;
    if (!annotationsEnabled && annotationCanvas) annotationCanvas.getContext('2d').clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  });
}
/* ???????????????????????????????????????????????????????????????
   COMPATIBILITY BANNER
   ??????????????????????????????????????????????????????????????? */

const compatBanner        = document.getElementById('compatBanner');
const compatBannerText    = document.getElementById('compatBannerText');
const compatBannerDetails = document.getElementById('compatBannerDetails');
const compatBannerClose   = document.getElementById('compatBannerClose');

let _lastCompatData = null;

async function checkCompatibility() {
  try {
    const r = await fetch('/api/health/compatibility');
    if (!r.ok) return;
    const data = await r.json();
    _lastCompatData = data;
    renderCompatBanner(data);
    renderCompatCards(data);
  } catch { /* network error ? silent */ }
}

function renderCompatBanner(data) {
  if (!compatBanner) return;
  if (data.overallStatus === 'ok') {
    compatBanner.classList.add('compat-banner--hidden');
    compatBanner.classList.remove('compat-banner--warn', 'compat-banner--error');
    return;
  }
  const issues = Object.values(data.components)
    .filter(c => c.status === 'error' || c.status === 'warn')
    .map(c => `${c.label}${c.message ? ': ' + c.message : ''}`)
    .join(' | ');
  compatBannerText.textContent = issues || '????? ?????? ??????';
  compatBanner.classList.remove('compat-banner--hidden', 'compat-banner--warn', 'compat-banner--error');
  compatBanner.classList.add(data.overallStatus === 'error' ? 'compat-banner--error' : 'compat-banner--warn');
}

function renderCompatCards(data) {
  const el = document.getElementById('connCompatCards');
  if (!el) return;
  const chips = Object.entries(data.components).map(([, c]) => {
    const tip = c.message ? ` title="${c.message}"` : '';
    return `<span class="conn-compat-chip conn-compat-chip--${c.status}"${tip}>
      <span class="conn-compat-chip-dot"></span>
      ${c.label}${c.version ? ` <small style="opacity:.7">${c.version}</small>` : ''}
    </span>`;
  }).join('');
  el.innerHTML = chips || '<span style="color:var(--text-muted);font-size:.82rem">?? ????</span>';
}

if (compatBannerClose) compatBannerClose.addEventListener('click', () => {
  compatBanner.classList.add('compat-banner--hidden');
});

if (compatBannerDetails) compatBannerDetails.addEventListener('click', () => {
  const tab = document.querySelector('[data-tab="connections"]');
  if (tab) tab.click();
});

const reCheckCompatBtn = document.getElementById('reCheckCompatBtn');
if (reCheckCompatBtn) reCheckCompatBtn.addEventListener('click', checkCompatibility);

checkCompatibility();
setInterval(checkCompatibility, 60_000);

/* ???????????????????????????????????????????????????????????????
   CONNECTION MANAGER
   ??????????????????????????????????????????????????????????????? */

const connectionsList     = document.getElementById('connectionsList');
const addConnectionBtn    = document.getElementById('addConnectionBtn');
const refreshConnectionsBtn = document.getElementById('refreshConnectionsBtn');
const connFormCard        = document.getElementById('connFormCard');
const connFormTitle       = document.getElementById('connFormTitle');
const connFormName        = document.getElementById('connFormName');
const connFormType        = document.getElementById('connFormType');
const connFormHost        = document.getElementById('connFormHost');
const connFormPort        = document.getElementById('connFormPort');
const connFormSerial      = document.getElementById('connFormSerial');
const connFormBaud        = document.getElementById('connFormBaud');
const connFormSaveBtn     = document.getElementById('connFormSaveBtn');
const connFormCancelBtn   = document.getElementById('connFormCancelBtn');
const connFormStatus      = document.getElementById('connFormStatus');
const connFormEditId      = document.getElementById('connFormEditId');
const serverUrlDisplay    = document.getElementById('serverUrlDisplay');
const serverUrlQr         = document.getElementById('serverUrlQr');
const copyServerUrlBtn    = document.getElementById('copyServerUrlBtn');

const TYPE_LABELS = {
  udp: 'UDP MAVLink', tcp: 'TCP MAVLink',
  serial: 'Serial', telemetry: 'Telemetry Radio', http: 'HTTP',
};
const TYPE_DEFAULTS = { udp: 14550, tcp: 5760, serial: null, telemetry: null, http: 4010 };
const SERIAL_TYPES = new Set(['serial', 'telemetry']);

function initServerUrl() {
  const url = `${location.protocol}//${location.hostname}:${location.port || 4010}`;
  if (serverUrlDisplay) serverUrlDisplay.textContent = url;
  if (serverUrlQr) serverUrlQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(url)}`;
}

if (copyServerUrlBtn) copyServerUrlBtn.addEventListener('click', async () => {
  const url = serverUrlDisplay?.textContent || '';
  try {
    await navigator.clipboard.writeText(url);
    copyServerUrlBtn.textContent = '? ?????';
    setTimeout(() => { copyServerUrlBtn.textContent = '?? ????'; }, 1500);
  } catch { /* clipboard not available */ }
});

function toggleSerialFields() {
  const isSerial = connFormType && SERIAL_TYPES.has(connFormType.value);
  document.querySelectorAll('.conn-form-serial-field').forEach(el => {
    el.classList.toggle('visible', isSerial);
  });
  if (connFormPort && TYPE_DEFAULTS[connFormType?.value] !== undefined) {
    if (!connFormPort.value) connFormPort.value = TYPE_DEFAULTS[connFormType.value] || '';
  }
}

if (connFormType) connFormType.addEventListener('change', () => {
  toggleSerialFields();
  if (SERIAL_TYPES.has(connFormType.value)) loadSerialPorts();
});

async function loadSerialPorts() {
  if (!connFormSerial) return;
  try {
    const r = await fetch('/api/connections/ports/list');
    const d = await r.json();
    const current = connFormSerial.value;
    connFormSerial.innerHTML = '<option value="">-- ??? ???? --</option>';
    if (d.ok && d.ports.length) {
      d.ports.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path}${p.manufacturer ? ' ? ' + p.manufacturer : ''}`;
        connFormSerial.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '?? ????? ?????? ? ??? ????? ???? ???';
      connFormSerial.appendChild(opt);
    }
    if (current) connFormSerial.value = current;
  } catch { /* ignore */ }
}

function connStatusLabel(conn) {
  if (conn.liveStatus?.connected) {
    const remote = conn.liveStatus.remoteAddr ? ` ? ${conn.liveStatus.remoteAddr}` : '';
    const vt = conn.liveStatus.vehicleType ? ` | ${conn.liveStatus.vehicleType}` : '';
    const hb = conn.liveStatus.lastHeartbeatAt ? ' ? HB' : '';
    return `?????${remote}${vt}${hb}`;
  }
  if (conn.liveStatus?.listening) return '????? ??????...';
  return conn.last_connected ? `?????: ${conn.last_connected}` : '?? ?????';
}

function renderConnections(conns) {
  if (!connectionsList) return;
  if (!conns.length) {
    connectionsList.innerHTML = '<p class="conn-empty-hint">?? ?????? ???????. ??? "+ ???? ?????" ??? ?????? ?????? ?-FC.</p>';
    return;
  }
  connectionsList.innerHTML = conns.map(c => {
    const isActive = c.liveStatus?.connected || c.liveStatus?.listening;
    const meta = `${TYPE_LABELS[c.type] || c.type} | ${
      c.type === 'serial' || c.type === 'telemetry' ? `${c.serial_port || '?'} @ ${c.baud_rate}` :
      `${c.host || '0.0.0.0'}:${c.port || '?'}`
    } | ${connStatusLabel(c)}`;
    return `<div class="conn-card${isActive ? ' conn-card--active' : ''}" data-conn-id="${c.id}">
      <span class="conn-card-dot"></span>
      <div class="conn-card-info">
        <div class="conn-card-name">${c.name}</div>
        <div class="conn-card-meta">${meta}</div>
      </div>
      <div class="conn-card-actions">
        ${isActive
          ? `<button class="conn-btn-disconnect" onclick="deactivateConn(${c.id})">???</button>`
          : `<button class="conn-btn-connect" onclick="activateConn(${c.id})" ${SERIAL_TYPES.has(c.type) ? 'disabled title="???? ????? ?????"' : ''}>?????</button>`
        }
        <button class="conn-btn-edit" onclick="editConn(${c.id})">?</button>
        <button class="conn-btn-delete" onclick="deleteConn(${c.id})">??</button>
      </div>
    </div>`;
  }).join('');
}

async function loadConnections() {
  try {
    const r = await fetch('/api/connections');
    const data = await r.json();
    if (data.ok) renderConnections(data.connections);
  } catch { /* network error */ }
}

window.activateConn = async (id) => {
  try {
    const r = await fetch(`/api/connections/${id}/activate`, { method: 'POST' });
    const d = await r.json();
    if (!d.ok) { alert(`?????: ${d.message}`); return; }
    await loadConnections();
    setTimeout(() => loadFcParams(id), 4000);
  } catch (e) { alert(e.message); }
};

window.deactivateConn = async (id) => {
  try {
    await fetch(`/api/connections/${id}/deactivate`, { method: 'POST' });
    await loadConnections();
  } catch { /* ignore */ }
};

window.deleteConn = async (id) => {
  if (!confirm('????? ????? ???')) return;
  try {
    await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    await loadConnections();
  } catch { /* ignore */ }
};

window.editConn = async (id) => {
  try {
    const r = await fetch(`/api/connections/${id}/status`);
    const d = await r.json();
    if (!d.ok) return;
    const c = d.connection;
    connFormEditId.value = String(c.id);
    connFormTitle.textContent = '???? ?????';
    connFormName.value = c.name;
    connFormType.value = c.type;
    connFormHost.value = c.host || '';
    connFormPort.value = c.port || '';
    if (SERIAL_TYPES.has(c.type)) { await loadSerialPorts(); }
    connFormSerial.value = c.serial_port || '';
    connFormBaud.value = String(c.baud_rate || 57600);
    toggleSerialFields();
    connFormCard.classList.remove('conn-form-card--hidden');
    connFormCard.scrollIntoView({ behavior: 'smooth' });
  } catch { /* ignore */ }
};

if (addConnectionBtn) addConnectionBtn.addEventListener('click', () => {
  connFormEditId.value = '';
  connFormTitle.textContent = '????? ???';
  connFormName.value = '';
  connFormType.value = 'udp';
  connFormHost.value = '';
  connFormPort.value = '14550';
  connFormSerial.value = '';
  connFormBaud.value = '57600';
  connFormStatus.textContent = '';
  toggleSerialFields();
  connFormCard.classList.remove('conn-form-card--hidden');
  connFormCard.scrollIntoView({ behavior: 'smooth' });
});

if (connFormCancelBtn) connFormCancelBtn.addEventListener('click', () => {
  connFormCard.classList.add('conn-form-card--hidden');
});

if (connFormSaveBtn) connFormSaveBtn.addEventListener('click', async () => {
  const name = connFormName?.value.trim();
  const type = connFormType?.value;
  if (!name) { connFormStatus.textContent = '?? ????'; return; }
  const body = {
    name, type,
    host: connFormHost?.value.trim() || null,
    port: connFormPort?.value ? Number(connFormPort.value) : null,
    serialPort: connFormSerial?.value.trim() || null,
    baudRate: connFormBaud?.value ? Number(connFormBaud.value) : 57600,
  };
  const editId = connFormEditId?.value;
  try {
    const url = editId ? `/api/connections/${editId}` : '/api/connections';
    const method = editId ? 'PATCH' : 'POST';
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!d.ok) { connFormStatus.textContent = `?????: ${d.message}`; return; }
    connFormCard.classList.add('conn-form-card--hidden');
    await loadConnections();
  } catch (e) { connFormStatus.textContent = e.message; }
});

if (refreshConnectionsBtn) refreshConnectionsBtn.addEventListener('click', () => {
  loadConnections();
  checkCompatibility();
});

document.querySelector('[data-tab="connections"]')?.addEventListener('click', () => {
  initServerUrl();
  loadConnections();
  checkCompatibility();
});

initServerUrl();

/* ???????????????????????????????????????????????????????????????
   FC PARAMETERS PANEL
   ??????????????????????????????????????????????????????????????? */

const fcParamsPanel      = document.getElementById('fcParamsPanel');
const fcParamsProgress   = document.getElementById('fcParamsProgress');
const fcParamsSearch     = document.getElementById('fcParamsSearch');
const fcParamsGroups     = document.getElementById('fcParamsGroups');
const fcParamsRequestBtn = document.getElementById('fcParamsRequestBtn');

let _fcParamsActiveConnId = null;
let _fcParamsAll = {};

/** ArduPilot parameter prefix ? readable group name */
const PARAM_GROUPS = {
  PLND: 'נחיתה מדויקת (PLND)',
  EK3:  'EKF3',
  EK2:  'EKF2',
  AHRS: 'AHRS',
  ARMING: 'Arming',
  FS:   'Failsafe (FS)',
  LAND: 'נחיתה (LAND)',
  LOG:  'לוגים (LOG)',
  SR2:  'Stream rates SR2',
  SR1:  'Stream rates SR1',
  SERIAL2: 'Serial2 (Jetson)',
  SERIAL1: 'Serial1',
  INS:  'IMU / INS',
  COMPASS: 'מצפן',
  RC:   'שלט רחוק (RC)',
  MOT:  'מנועים (MOT)',
  ATC:  'Attitude Control (ATC)',
  PSC:  'Position Control (PSC)',
  WPNAV: 'Waypoint Nav',
  GPS:  'GPS',
  BARO: 'ברומטר',
  RNGFND: 'טווחמר (RNG)',
  PRX:  'Proximity',
  VISO: 'Visual Odom (VISO)',
  CAM:  'מצלמה (CAM)',
  MNT:  'ג׳ימבל (MNT)',
  BTN:  'כפתורים',
};

function getParamGroup(name) {
  for (const [prefix, label] of Object.entries(PARAM_GROUPS)) {
    if (name.startsWith(prefix + '_') || name === prefix) return label;
  }
  return 'אחר';
}

function renderFcParams(params, filter = '') {
  if (!fcParamsGroups) return;
  const total = Object.keys(params).length;
  if (total === 0) {
    fcParamsGroups.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem;margin:0">לא התקבלו פרמטרים עדיין ? ודא שהחיבור פעיל ולחץ ?</p>';
    return;
  }

  const lf = filter.toLowerCase();
  const grouped = {};
  for (const [name, value] of Object.entries(params)) {
    if (lf && !name.toLowerCase().includes(lf)) continue;
    const g = getParamGroup(name);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push({ name, value });
  }

  if (Object.keys(grouped).length === 0) {
    fcParamsGroups.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem;margin:0">לא נמצאו תוצאות לחיפוש</p>';
    return;
  }

  fcParamsGroups.innerHTML = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, rows]) => `
      <div class="fc-params-group">
        <div class="fc-params-group-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
          <span>${group} <small style="opacity:.6">(${rows.length})</small></span>
          <span style="font-size:.7rem;opacity:.5">?</span>
        </div>
        <div class="fc-params-group-body">
          ${rows.sort((a, b) => a.name.localeCompare(b.name)).map(r =>
            `<div class="fc-param-row">
              <span class="fc-param-name">${r.name}</span>
              <span class="fc-param-value">${Number.isInteger(r.value) ? r.value : r.value.toFixed(4).replace(/\.?0+$/, '')}</span>
            </div>`
          ).join('')}
        </div>
      </div>`
    ).join('');
}

async function loadFcParams(connId) {
  if (!connId) return;
  try {
    const r = await fetch(`/api/connections/${connId}/params`);
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok) return;
    _fcParamsAll = d.params;
    _fcParamsActiveConnId = connId;
    if (fcParamsProgress) fcParamsProgress.textContent = `${d.count} פרמטרים`;
    renderFcParams(d.params, fcParamsSearch?.value || '');
    if (fcParamsPanel) fcParamsPanel.classList.remove('fc-params-panel--hidden');
  } catch { /* ignore */ }
}

if (fcParamsSearch) {
  fcParamsSearch.addEventListener('input', () => {
    renderFcParams(_fcParamsAll, fcParamsSearch.value);
  });
}

if (fcParamsRequestBtn) {
  fcParamsRequestBtn.addEventListener('click', async () => {
    if (!_fcParamsActiveConnId) return;
    fcParamsRequestBtn.textContent = 'שולח...';
    await fetch(`/api/connections/${_fcParamsActiveConnId}/request-params`, { method: 'POST' });
    setTimeout(async () => {
      await loadFcParams(_fcParamsActiveConnId);
      fcParamsRequestBtn.textContent = '? רענן מ-FC';
    }, 3000);
  });
}

/* Update FC params when SSE reports a connected MAVLink connection */
const _origSseHandlerForParams = window._sseParamsHooked;
if (!_origSseHandlerForParams) {
  window._sseParamsHooked = true;
  document.addEventListener('mavlink-connected', (e) => {
    setTimeout(() => loadFcParams(e.detail.connId), 3000);
  });
}
