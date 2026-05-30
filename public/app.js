
/* ─── ARDUPILOT READ / DIFF / WRITE ─── *//** Why: APP_VERSION is owned by ./version.js and injected into index.html by the server. What: read the meta tag once and fall back to /api/health if needed. */
const APP_VERSION_NEW = (() => {
  const meta = document.querySelector('meta[name="app-version"]');
  const v = meta?.getAttribute('content') || '';
  return v && !v.includes('__APP_VERSION__') ? v : '0.0.0';
})();

/**
 * Why: accidental browser zoom (Ctrl +/- / wheel) breaks dense cockpit layout proportions.
 * What: block accidental zoom-in/out shortcuts (leave Ctrl+0 available for reset).
 */
function initGlobalViewportScaleGuard() {
  // Prevent accidental keyboard zoom shortcuts in this app.
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    const k = String(e.key || '').toLowerCase();
    // Keep Ctrl+0 allowed so pilot can always reset browser zoom to 100%.
    if (k === '+' || k === '-' || k === '=' || k === '_') {
      e.preventDefault();
    }
  }, { passive: false });

  // Prevent Ctrl+wheel zoom drift over charts/maps/forms.
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
  }, { passive: false });
}
initGlobalViewportScaleGuard();

/** Why: changelog is now loaded from /changelog.json (structured, typed entries) so the modal stays in sync with version.js without editing app.js. What: cached in-memory after first fetch. */
let VERSION_HISTORY = [];

/** Why: fetch structured changelog (typed entries) from JSON so editing the changelog doesn't require touching JS. What: replaces the legacy string format with { type, title, detail? } and caches in-memory. */
async function loadChangelog() {
  try {
    const res = await fetch('./changelog.json?v=' + encodeURIComponent(APP_VERSION_NEW));
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) VERSION_HISTORY = data;
  } catch (err) {
    console.warn('[changelog] fetch failed, using fallback', err);
  }
}
loadChangelog();

/** @type {string | null} */
let _lastAppliedServerAppVersion = null;

/** @returns {-1|0|1} compare major.minor.patch only */
function cmpAppSemver(a, b) {
  const pa = String(a).trim().split('.').map((x) => Number(x) || 0);
  const pb = String(b).trim().split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * Why: `meta` + static HTML are only correct at first paint; after deploy/refresh the running server is the source of truth.
 *  What: keep badge, page title, meta, and Advisor "קונסול" in sync. Idempotent per distinct version to avoid thrashing.
 */
function applyServerAppVersion(ver) {
  if (ver == null) return;
  const v = String(ver).trim();
  if (!v) return;
  if (v === _lastAppliedServerAppVersion) return;
  if (_lastAppliedServerAppVersion && cmpAppSemver(v, _lastAppliedServerAppVersion) < 0) return;
  _lastAppliedServerAppVersion = v;
  const m = document.querySelector('meta[name="app-version"]');
  if (m) m.setAttribute('content', v);
  const vb = document.getElementById('versionBtn');
  if (vb) vb.textContent = `v${v}`;
  if (document.title && document.title.startsWith('Vision Landing Console')) {
    document.title = `Vision Landing Console v${v}`;
  }
  const advC = document.getElementById('advSysConsole');
  if (advC) advC.textContent = `v${v}`;
}

/** Why: explicit pull when SSE is down, on tab focus, and periodically — complements stream `appVersion`. */
async function syncServerAppVersion() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j?.version) {
        applyServerAppVersion(j.version);
        return;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const r2 = await fetch('/api/meta', { cache: 'no-store' });
    if (!r2.ok) return;
    const j2 = await r2.json();
    if (j2?.appVersion) applyServerAppVersion(j2.appVersion);
  } catch {
    /* ignore */
  }
}

void syncServerAppVersion();
setInterval(() => {
  void syncServerAppVersion();
}, 10_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncServerAppVersion();
});
window.addEventListener('focus', () => {
  void syncServerAppVersion();
});

const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));
const subtabs = Array.from(document.querySelectorAll('.subtab'));
const subpanels = Array.from(document.querySelectorAll('.subpanel'));
const controlSubtabsBar = document.getElementById('controlSubtabsBar');

function setParamCenterChromeVisible(visible) {
  if (controlSubtabsBar) controlSubtabsBar.classList.toggle('visible', visible);
}
const arduTopCatsHost = document.getElementById('arduTopCatsHost');
const debriefTabButtons = Array.from(document.querySelectorAll('[data-debrief-tab]'));
const debriefRecordingsPanel = document.getElementById('debriefRecordingsPanel');
const debriefLogsPanel = document.getElementById('debriefLogsPanel');
const debriefPanelsHost = document.getElementById('recordings');
const telemetryPanel = document.getElementById('telemetry');
let selectedContextEvent = null;
let processIndex = 0;

/** Why: F5/refresh should keep the current main tab and (when relevant) the control sub-tab. What: sessionStorage, same window session. */
const MAIN_TAB_KEY = 'visionLandingMainTabV1';
const CONTROL_SUBTAB_KEY = 'visionLandingControlSubtabV1';
function _mainTabIds() {
  return new Set(tabs.map((t) => t.dataset.tab).filter(Boolean));
}
function _subtabIds() {
  return new Set(subtabs.map((t) => t.dataset.subtab).filter(Boolean));
}
function initDebriefTelemetrySubtab() {
  // Telemetry is now its own main tab — no longer moved into recordings.
}
function applyDebriefSubtab(tabId = 'recordings', { save = true } = {}) {
  // "לוגים" sub-tab redirects directly to the flights main tab (no placeholder)
  if (tabId === 'logs') {
    applyMainTab('flights');
    return;
  }
  const wanted = 'recordings';
  debriefTabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.debriefTab === wanted));
  [debriefRecordingsPanel, debriefLogsPanel].forEach((panel) => {
    if (!panel) return;
    panel.classList.toggle('visible', panel.dataset.debriefPanel === wanted);
  });
  if (save) {
    try {
      sessionStorage.setItem('visionLandingDebriefSubtabV1', wanted);
    } catch {
      /* ignore */
    }
  }
}
function applyMainTab(tabId, { save = true } = {}) {
  if (!_mainTabIds().has(tabId)) return;
  tabs.forEach((t) => t.classList.remove('active'));
  panels.forEach((p) => p.classList.remove('visible'));
  const tab = tabs.find((t) => t.dataset.tab === tabId);
  const panel = document.getElementById(tabId);
  if (tab) tab.classList.add('active');
  if (panel) panel.classList.add('visible');
  setParamCenterChromeVisible(tabId === 'control');
  updateArduTopCatsVisibility();
  if (save) {
    try {
      sessionStorage.setItem(MAIN_TAB_KEY, tabId);
    } catch {
      /* ignore */
    }
  }
  void syncServerAppVersion();
  if (tabId === 'advisor') {
    void refreshAdvisorHealth();
  }
  if (tabId === 'telemetry') {
    setTimeout(() => onTelemetryTabActivated(), 60);
  }
  if (tabId === 'simLab') {
    setTimeout(() => {
      window.simLab3d?.resizeRenderer?.();
      window.simLab3d?.invalidateMiniMap?.();
    }, 80);
  }
  if (tabId === 'flights') {
    setTimeout(() => {
      refreshFlightLists();
      refreshAllLogsTable();
    }, 50);
  }
}
const PARAM_SUBTAB_IDS = new Set(['landingParams', 'abortParams', 'visionNavParams', 'arduParams', 'customParams']);

function applyControlSubtab(subId, { save = true, selectOverride = null } = {}) {
  if (!_subtabIds().has(subId)) return;
  subtabs.forEach((t) => t.classList.remove('active'));
  subpanels.forEach((p) => p.classList.remove('visible'));
  const st = subtabs.find((t) => t.dataset.subtab === subId);
  const sp = document.getElementById(subId);
  if (st) st.classList.add('active');
  if (sp) sp.classList.add('visible');
  // sync param-subtab select
  const paramSel = document.getElementById('paramSubtabSelect');
  if (paramSel) {
    const isParam = PARAM_SUBTAB_IDS.has(subId);
    paramSel.classList.toggle('param-subtab-select--active', isParam);
    if (isParam) paramSel.value = selectOverride !== null ? selectOverride : subId;
  }
  updateArduTopCatsVisibility();
  if (save) {
    try {
      sessionStorage.setItem(CONTROL_SUBTAB_KEY, selectOverride !== null ? selectOverride : subId);
    } catch {
      /* ignore */
    }
  }
}
function updateArduTopCatsVisibility() {
  if (!arduTopCatsHost) return;
  // ArduPilot categories now live in #paramSubtabSelect — secondary dropdown stays hidden.
  arduTopCatsHost.classList.add('hidden');
}
function restoreLastUiTab() {
  let main;
  let sub;
  let debriefSub;
  try {
    main = sessionStorage.getItem(MAIN_TAB_KEY);
    debriefSub = sessionStorage.getItem('visionLandingDebriefSubtabV1');
  } catch {
    return;
  }
  // telemetry is now a proper main tab; flights/processes removed from nav
  if (main === 'processes') main = 'control';
  if (main === 'telemetry') {
    // telemetry is now a direct main tab — no redirect needed
  }
  if (main && _mainTabIds().has(main)) {
    applyMainTab(main, { save: false });
  }
  if (main === 'recordings') {
    // 'logs' sub-tab now redirects to flights — always restore to 'recordings'
    applyDebriefSubtab('recordings', { save: false });
  }
  if (main === 'control') {
    try {
      sub = sessionStorage.getItem(CONTROL_SUBTAB_KEY);
    } catch {
      return;
    }
    // Migrate old sessions that stored 'arduParams' directly → default to first ArduPilot category.
    if (sub === 'arduParams') sub = 'ardu-jetson';
    if (sub && /^ardu-/.test(sub)) {
      // Virtual ArduPilot category option — restore subpanel and note the slug for renderArduParamForm.
      applyControlSubtab('arduParams', { save: false, selectOverride: sub });
    } else if (sub && _subtabIds().has(sub)) {
      applyControlSubtab(sub, { save: false });
    }
  }
}

/** Why: one line in collapsed advisor info bar — same screen, minimal vertical use. */
function updateAdvInfoPeek() {
  const peek = document.getElementById('advInfoPeek');
  if (!peek) return;
  const c = document.getElementById('advSysConsole')?.textContent?.trim() || '—';
  const mod = document.getElementById('advisorModeBanner')?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const modShort = mod.length > 70 ? `${mod.slice(0, 67)}…` : mod;
  peek.textContent = [c, modShort].filter(Boolean).join(' · ');
}

/** Why: advisor tab shows whether Gemini will answer or local fallback only. What: GET /api/health and fills #advisorModeBanner. */
async function refreshAdvisorHealth() {
  const el = document.getElementById('advisorModeBanner');
  if (!el) return;
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    const gem = h.geminiConfigured;
    const eff = (h.geminiModel && h.geminiModel.effective) || '?';
    el.className = `advisor-mode-banner${gem ? ' advisor-mode-banner--ok' : ' advisor-mode-banner--muted'}`;
    el.textContent = gem
      ? `יועץ Gemini פעיל — מודל: ${eff}`
      : 'אין מפתח Gemini בשרת — התשובות מקומיות בלבד. הוסף GEMINI_API_KEY ל־.env והפעל מחדש את השרת.';
  } catch {
    el.className = 'advisor-mode-banner advisor-mode-banner--err';
    el.textContent = 'לא ניתן לגשת ל־/api/health — ודא שרץ server.js והפורט נכון.';
  }
  updateAdvInfoPeek();
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    applyMainTab(tab.dataset.tab);
  });
});
debriefTabButtons.forEach((tab) => {
  tab.addEventListener('click', () => {
    applyDebriefSubtab(tab.dataset.debriefTab);
  });
});
const openFlightsFromDebriefBtn = document.getElementById('openFlightsFromDebriefBtn');
if (openFlightsFromDebriefBtn) {
  openFlightsFromDebriefBtn.addEventListener('click', () => applyMainTab('flights'));
}
// Mirror subtabs in the flights panel: "הקלטות" → recordings main tab; "לוגים" stays on flights
const debriefRecBtn2 = document.getElementById('debriefRecBtn2');
const debriefLogsBtn2 = document.getElementById('debriefLogsBtn2');
if (debriefRecBtn2) {
  debriefRecBtn2.addEventListener('click', () => applyMainTab('recordings'));
}
if (debriefLogsBtn2) {
  debriefLogsBtn2.addEventListener('click', () => applyMainTab('flights'));
}
subtabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    applyControlSubtab(tab.dataset.subtab);
  });
});
initDebriefTelemetrySubtab();
restoreLastUiTab();
{
  const activeMainTab = document.querySelector('.tab.active');
  setParamCenterChromeVisible(activeMainTab?.dataset?.tab === 'control');
}
updateArduTopCatsVisibility();

const TEXT_OVERRIDES_KEY = 'visionLandingTextOverridesV1';
const DEV_MODE_KEY = 'visionLandingDeveloperModeV1';
const PARAMS = [
  { key: 'flare_alt_m', label: 'גובה הצפה (m)', min: 1, max: 30, step: 0.5, value: 8 },
  { key: 'laser_detect_alt_m', label: 'גובה זיהוי לייזר (m)', min: 1, max: 40, step: 0.5, value: 15 },
  { key: 'flare_pitch_up_deg', label: 'זווית הרמת אף בהצפה (deg)', min: 1, max: 20, step: 0.5, value: 7 },
  { key: 'motor_hold_s', label: 'משך זמן מנוע בהצפה (s)', min: 0, max: 8, step: 0.1, value: 2.5 },
  { key: 'vision_enable_alt_m', label: 'גובה הפעלת Vision (m)', min: 5, max: 120, step: 1, value: 55 },
  { key: 'vision_conf_min', label: 'סף מינימום לתיקון Vision', min: 0.4, max: 0.99, step: 0.01, value: 0.78 },
  { key: 'abort_conf_min', label: 'סף ביטחון מינימלי ל-Auto Abort', min: 0.3, max: 0.95, step: 0.01, value: 0.70 },
  { key: 'abort_conf_hold_s', label: 'משך זמן מתחת לסף לפני Abort (s)', min: 0.5, max: 8, step: 0.1, value: 2.0 },
  { key: 'abort_recover_conf', label: 'סף יציאה מ-Abort (Recover)', min: 0.35, max: 0.99, step: 0.01, value: 0.76 },
  { key: 'xtrack_gain', label: 'Cross Track Gain', min: 0.1, max: 3.5, step: 0.05, value: 1.25 },
  { key: 'yaw_align_gain', label: 'Yaw Align Gain', min: 0.1, max: 2.5, step: 0.05, value: 0.95 },
  { key: 'approach_speed_ms', label: 'מהירות גישה (m/s)', min: 8, max: 35, step: 0.5, value: 16.5 },
  { key: 'sink_rate_ms', label: 'שקיעה מותרת (m/s)', min: 0.3, max: 4, step: 0.1, value: 1.4 },
  { key: 'max_roll_deg', label: 'הטיה מקסימלית בתיקון (deg)', min: 5, max: 35, step: 1, value: 18 },
  { key: 'abort_max_xtrack_m', label: 'Abort אם סטייה רוחבית גבוהה (m)', min: 0.5, max: 12, step: 0.1, value: 4.0 },
  { key: 'abort_max_heading_deg', label: 'Abort אם שגיאת כיוון גבוהה (deg)', min: 5, max: 80, step: 1, value: 22 },
  { key: 'to_rotate_speed_ms', label: 'Takeoff Rotate Speed (m/s)', min: 6, max: 30, step: 0.5, value: 13.0 },
  { key: 'to_pitch_deg', label: 'Takeoff Pitch (deg)', min: 4, max: 20, step: 0.5, value: 11.0 },
  { key: 'to_max_crosswind_ms', label: 'Crosswind Max להמראה (m/s)', min: 1, max: 20, step: 0.5, value: 8.0 },
  { key: 'to_min_gps_sats', label: 'מינימום לוויינים להמראה', min: 10, max: 40, step: 1, value: 12 },
  { key: 'to_motor_spool_s', label: 'משך ספול מנוע לפני שחרור (s)', min: 0.5, max: 8, step: 0.1, value: 2.2 },
  { key: 'to_abort_speed_loss_ms', label: 'Abort אם איבוד מהירות (m/s)', min: 0.5, max: 8, step: 0.1, value: 2.5 },
];
const PROCESS_STEPS = [
  'כניסה לנתיב נחיתה',
  'אימות גובה/מהירות גישה',
  'הפעלת Vision לנחיתה',
  'אימות GPS ולייזר',
  'יישור רוחבי ראשוני',
  'בדיקת Confidence לפני Final',
  'מעבר ל-Final',
  'תיקוני Cross Track עדינים',
  'בדיקת תנאי Abort',
  'כניסה ל-Flare',
  'הפחתת מנוע מבוקרת',
  'נגיעה בקרקע',
  'ריצת האטה',
  'עצירה סופית',
];

function buildParamTooltip(param) {
  const generic = 'מתי לשנות: כשביצועי הנחיתה לא יציבים או לא עקביים.';
  const higher = 'ערך גבוה יותר: מגיב חזק/מוקדם יותר.';
  const lower = 'ערך נמוך יותר: מגיב עדין/מאוחר יותר.';
  if (param.key.includes('abort')) {
    return `מתי לשנות: כשיש false abort או abort מאוחר מדי.\nגבוה יותר: בטיחות שמרנית יותר.\nנמוך יותר: פחות abortים אבל סיכון גבוה יותר.`;
  }
  if (param.key.includes('conf')) {
    return `מתי לשנות: כשאיכות הזיהוי משתנה בתאורה/מסלול.\nגבוה יותר: דורש זיהוי יציב יותר.\nנמוך יותר: סלחני יותר אבל פחות בטוח.`;
  }
  if (param.key.includes('speed') || param.key.includes('sink')) {
    return `מתי לשנות: כשגישה מהירה/איטית מדי או נחיתה קשה.\nגבוה יותר: גישה אגרסיבית יותר.\nנמוך יותר: גישה רגועה יותר.`;
  }
  return `${generic}\n${higher}\n${lower}`;
}

/** Why: local fallback provides useful guidance without Gemini. What: keyword-matched advice with actionable parameter names. */
function localAdvisorReply(q) {
  const text = String(q || '').toLowerCase();
  if (text.includes('נדנוד') || text.includes('oscillat') || text.includes('hunting')) {
    return 'נדנוד: הורד xtrack_gain ב-10-15%, הגדל abort_conf_hold_s ל-3-4 שניות למניעת תגובת יתר, ובדוק שyaw_align_gain אינו גבוה מ-0.4.';
  }
  if (text.includes('הצפה') || text.includes('flare') || text.includes('bounce')) {
    return 'הצפה / bounce בנגיעה: העלה flare_alt_m בצעדים של 0.2m, כוון flare_pitch_up_deg בצעדים של 0.5°, ובדוק שsink_rate_ms מתחת ל-1.5.';
  }
  if (text.includes('ביטחון') || text.includes('confidence') || text.includes('abort')) {
    return 'ABORT / ביטחון: abort_conf_min — ספף ביטחון לביטול, abort_conf_hold_s — כמה שניות לשמור ביטחון נמוך לפני ביטול, abort_recover_conf — ספף חזרה ממצב ABORT.';
  }
  if (text.includes('מהירות') || text.includes('speed') || text.includes('approach')) {
    return 'מהירות גישה: הורד approach_speed_ms אם הנגיעה קשה, הגדל אם המטוס מתנהל. sink_rate_ms — קצב ירידה רצוי. שינוי ב-0.1m/s בכל פעם.';
  }
  if (text.includes('המראה') || text.includes('takeoff') || text.includes('טייק')) {
    return 'המראה: to_rotate_speed_ms — מהירות הרמה, to_pitch_deg — זווית עלייה, to_max_crosswind_ms — רוח צד מקסימלית. בדוק GPS sats ≥ 8 לפני.';
  }
  if (text.includes('jetson') && (text.includes('fc') || text.includes('רחפן') || text.includes('מטוס') || text.includes('gcs') || text.includes('mavlink'))) {
    return 'תקשורת: קו MAVLink בדרך כלל בין עמדת קרקע לבקר (FC). Jetson מריץ Vision בנתיב נפרד — לא מחליף את קו ה־GCS ל־FC. ב-ArduPilot בחר פורט Companion (SERIALx) וערוץ SRx בהתאם.';
  }
  if (text.includes('jetson') || text.includes('ג\'טסון') || text.includes('חיבור') || text.includes('connect')) {
    return 'Jetson: ודא שהשרת והJetson באותה רשת, ש-heartbeat מגיע בקצב < 5s. בדוק /api/jetson/status לפרטים. אם offline — הפעל מחדש.';
  }
  if (text.includes('slam') || text.includes('gps') || text.includes('מיקום')) {
    return 'SLAM/GPS: הפעל SLAM כשיש כיסוי ויזואלי מספיק. GPS נדרש לפחות ל-8 לוויינים לניווט עצמאי. בדוק Loop Closures > 0 לאמות שהמפה תקינה.';
  }
  if (text.includes('פרמטר') || text.includes('param') || text.includes('הגדר') || text.includes('שנה')) {
    return 'שינוי פרמטר: שנה פרמטר אחד בכל טיסה, שמור פרופיל לפני השינוי (כפתור "שמור"), ועשה READ מהמטוס לאחר WRITE לוודא שנשמר.';
  }
  return 'שאל אותי על: נדנוד, הצפה, מהירות גישה, ABORT, המראה, Jetson, SLAM/GPS, או פרמטרים ספציפיים. לתשובות מתקדמות — הוסף GEMINI_API_KEY ל-.env.';
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
/** Why: split tuning deck into feature tabs; what: keys rendered under פרמטרי נחיתה (גישה סופית / הצפה). */
const LANDING_PARAM_KEYS = new Set([
  'flare_alt_m',
  'laser_detect_alt_m',
  'flare_pitch_up_deg',
  'motor_hold_s',
  'approach_speed_ms',
  'sink_rate_ms',
]);
/** Why: vision path correction limits; what: keys under ניווט לפי תמונה. */
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
const COMPANION_PORT_OPTIONS = Array.from({ length: 8 }, (_x, i) => i + 1);
const companionLinkState = { companion_serial_port: 2, companion_sr_bucket: 2 };

function normalizeCompanionLink(raw) {
  const p = Number(raw?.companion_serial_port);
  const s = Number(raw?.companion_sr_bucket);
  const companion_serial_port = COMPANION_PORT_OPTIONS.includes(p) ? p : 2;
  const companion_sr_bucket = COMPANION_PORT_OPTIONS.includes(s) ? s : companion_serial_port;
  return { companion_serial_port, companion_sr_bucket };
}

function buildArduTargetDefaultsClient(rawCompanion = companionLinkState) {
  const companion = normalizeCompanionLink(rawCompanion);
  const out = {};
  for (const port of COMPANION_PORT_OPTIONS) {
    out[`SERIAL${port}_PROTOCOL`] = port === companion.companion_serial_port ? 2 : 0;
    out[`SERIAL${port}_BAUD`] = port === companion.companion_serial_port ? 921 : 57;
    out[`SR${port}_EXT_STAT`] = port === companion.companion_sr_bucket ? 5 : 0;
    out[`SR${port}_POSITION`] = port === companion.companion_sr_bucket ? 10 : 0;
    out[`SR${port}_RC_CHAN`] = port === companion.companion_sr_bucket ? 5 : 0;
    out[`SR${port}_EXTRA1`] = port === companion.companion_sr_bucket ? 10 : 0;
    out[`SR${port}_EXTRA2`] = port === companion.companion_sr_bucket ? 10 : 0;
  }
  Object.assign(out, {
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
    LIM_PITCH_CD: 3000,
    LIM_ROLL_CD: 4500,
    RLL2SRV_RMAX: 90,
    FS_THR_ENABLE: 1,
    FS_THR_VALUE: 975,
    ARMING_CHECK: 1,
  });
  return Object.freeze(out);
}

const ARDU_TARGET_DEFAULTS_CLIENT = buildArduTargetDefaultsClient();
let arduTargetState = { ...ARDU_TARGET_DEFAULTS_CLIENT };

/** Why: detect unsaved POST /api/vision/config. What: set after successful GET/POST vision config; compared to current UI state. */
let lastServerSyncedCanonical = null;
/** Why: compare editable Ardu targets to last FC READ. What: null until a successful READ while connected; updated after WRITE success. */
let fcCurrentSnapshot = null;

/** Why: stable JSON for dirty detection vs last server persist. What: sorted keys for profile + arduTarget. */
function canonicalServerPayloadStr() {
  const prof = {};
  Object.keys(profileState)
    .sort()
    .forEach((k) => {
      prof[k] = profileState[k];
    });
  prof.companion_serial_port = companionLinkState.companion_serial_port;
  prof.companion_sr_bucket = companionLinkState.companion_sr_bucket;
  const ardu = {};
  Object.keys(arduTargetState)
    .sort()
    .forEach((k) => {
      ardu[k] = arduTargetState[k];
    });
  return JSON.stringify({ profile: prof, arduTarget: ardu });
}

/** Why: mark UI as matching persisted server snapshot. What: call after successful GET/POST /api/vision/config. */
function captureServerBaseline() {
  lastServerSyncedCanonical = canonicalServerPayloadStr();
}

/** Why: count Ardu keys that differ from last known FC state. What: null if never READ while connected. */
function countArduMismatchVsFc() {
  if (!fcCurrentSnapshot || typeof fcCurrentSnapshot !== 'object') return null;
  let n = 0;
  for (const k of Object.keys(arduTargetState)) {
    if (String(fcCurrentSnapshot[k]) !== String(arduTargetState[k])) n += 1;
  }
  return n;
}

/** Why: pilot sees pending WRITE לשרת vs WRITE לרחפן. What: fills #paramSyncBanner from baselines and diff counts. */
function updateParamSyncBanner() {
  const el = document.getElementById('paramSyncBanner');
  if (!el) return;

  const serverDirty = lastServerSyncedCanonical != null && canonicalServerPayloadStr() !== lastServerSyncedCanonical;
  const fcMis = countArduMismatchVsFc();

  const lines = [];
  if (serverDirty) {
    lines.push('יש שינויים שלא נשמרו לשרת — לחץ «WRITE — לשרת».');
  }
  if (fcMis == null) {
    lines.push('לא בוצע READ מהרחפן — לא ידוע אם המטוס תואם ליעדים.');
  } else if (fcMis > 0) {
    lines.push(`יש שינויים ביעדי Ardu שלא נשלחו למטוס (${fcMis}) — «WRITE — לרחפן».`);
  }

  let level = 'ok';
  if (serverDirty || (fcMis != null && fcMis > 0)) {
    level = 'warn';
  } else if (fcMis == null && !serverDirty) {
    level = 'info';
  }

  if (!serverDirty && fcMis === 0) {
    lines.length = 0;
    lines.push('הכל מסונכרן: שמירה לשרת ויעדי Ardu כפי שנקראו מהמטוס.');
    level = 'ok';
  }

  el.className = `param-sync-banner param-sync-banner--${level}`;
  el.innerHTML = lines.map((t) => `<span class="param-sync-line">${t}</span>`).join('');
}

const saveProfileBtn = document.getElementById('saveProfileBtn');
const exportProfileBtn = document.getElementById('exportProfileBtn');
const importProfileInput = document.getElementById('importProfileInput');
const devModeBtn = document.getElementById('devModeBtn');
let developerMode = localStorage.getItem(DEV_MODE_KEY) === '1';

function updateDeveloperModeUI() {
  document.body.classList.toggle('dev-mode', developerMode);
  if (devModeBtn) devModeBtn.textContent = `מוד מפתח: ${developerMode ? 'פעיל' : 'כבוי'}`;
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
  const next = window.prompt('עריכת טקסט (מוד מפתח):', target.textContent || '');
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
    const nextTitle = window.prompt('עריכת tooltip לפרמטר:', currentTitle);
    if (nextTitle == null) return;
    target.setAttribute('title', nextTitle);
    return;
  }
  const currentTooltip = target.getAttribute('title') || '';
  const nextTooltip = window.prompt('עריכת tooltip לטקסט:', currentTooltip);
  if (nextTooltip == null) return;
  target.setAttribute('title', nextTooltip);
});

// ── Param-info popup (global ? button handler) ─────────────────────────────
(function initParamInfoPopup() {
  const popup = document.getElementById('paramInfoPopup');
  if (!popup) return;

  let currentBtn = null;

  function closePopup() {
    popup.classList.add('hidden');
    popup.textContent = '';
    currentBtn?.classList.remove('param-info--open');
    currentBtn = null;
  }

  function openPopup(btn) {
    const text = btn.getAttribute('title') || btn.getAttribute('data-help') || '(אין מידע נוסף)';
    if (currentBtn === btn) { closePopup(); return; }
    closePopup();
    currentBtn = btn;
    btn.classList.add('param-info--open');
    popup.textContent = text;
    popup.classList.remove('hidden');

    // Position near the button
    const rect = btn.getBoundingClientRect();
    const pw = 260;
    let left = rect.left + window.scrollX;
    let top  = rect.bottom + window.scrollY + 6;
    if (left + pw > window.innerWidth - 10) left = window.innerWidth - pw - 10;
    if (left < 6) left = 6;
    if (top + 120 > window.innerHeight + window.scrollY) top = rect.top + window.scrollY - 8;
    popup.style.left = `${left}px`;
    popup.style.top  = `${top}px`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.param-info');
    if (btn) { e.stopPropagation(); openPopup(btn); return; }
    if (!popup.contains(e.target)) closePopup();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
})();

// ---------------------------------------------------------------------------
// Parameter icon map — maps ArduPilot param name prefixes to visual icons
// ---------------------------------------------------------------------------
const PARAM_ICON_MAP = [
  { prefixes: ['ARSPD', 'ASPD', 'TECS_SPDW', 'TECS_SPD'],    icon: '💨', color: '#38bdf8', label: 'מהירות אווירית' },
  { prefixes: ['THR', 'TKOFF_THR', 'LAND_THR', 'MOT_THST'],   icon: '🔥', color: '#f97316', label: 'מצערת' },
  { prefixes: ['NAVL1', 'WP_', 'NAV_'],                        icon: '🧭', color: '#a78bfa', label: 'ניווט' },
  { prefixes: ['TECS_HGT', 'ALT_', 'BARO_'],                   icon: '📏', color: '#4ade80', label: 'גובה / לחץ' },
  { prefixes: ['EKF', 'AHRS'],                                  icon: '🔬', color: '#f472b6', label: 'EKF / AHRS' },
  { prefixes: ['GPS_'],                                         icon: '📡', color: '#34d399', label: 'GPS' },
  { prefixes: ['BATT'],                                         icon: '🔋', color: '#facc15', label: 'סוללה' },
  { prefixes: ['RCMAP', 'RCIN', 'RCOUT', 'RC'],                icon: '📻', color: '#fb923c', label: 'RC / שלט' },
  { prefixes: ['SRV_', 'SERVO'],                                icon: '⚙️', color: '#94a3b8', label: 'סרוו' },
  { prefixes: ['COMPASS', 'MAG_'],                              icon: '🧲', color: '#c084fc', label: 'מצפן' },
  { prefixes: ['FS_', 'FENCE_'],                                icon: '🛡️', color: '#ef4444', label: 'בטיחות' },
  { prefixes: ['CAM_', 'CAMERA'],                               icon: '📷', color: '#60a5fa', label: 'מצלמה' },
  { prefixes: ['LOG_'],                                         icon: '📋', color: '#a3e635', label: 'לוגינג' },
  { prefixes: ['MIS_', 'CMD_'],                                 icon: '🗺️', color: '#67e8f9', label: 'מיסיון' },
  { prefixes: ['LAND_'],                                        icon: '🛬', color: '#fb7185', label: 'נחיתה' },
  { prefixes: ['TKOFF_'],                                       icon: '🛫', color: '#86efac', label: 'המראה' },
  { prefixes: ['PTCH', 'PITCH'],                                icon: '↕️', color: '#fde68a', label: 'Pitch' },
  { prefixes: ['RLL', 'ROLL'],                                  icon: '↔️', color: '#ddd6fe', label: 'Roll' },
  { prefixes: ['YAW', 'RUDDER'],                                icon: '🔄', color: '#99f6e4', label: 'Yaw' },
  { prefixes: ['TECS_'],                                        icon: '📈', color: '#7dd3fc', label: 'TECS' },
  { prefixes: ['PLND_'],                                        icon: '🎯', color: '#f9a8d4', label: 'Precision Landing' },
  { prefixes: ['MOT_'],                                         icon: '🛸', color: '#c4b5fd', label: 'מנוע' },
  { prefixes: ['SERIAL', 'SER'],                                icon: '🔌', color: '#fdba74', label: 'סיריאל' },
];

function getParamIcon(name) {
  if (!name) return { icon: '⚙️', color: '#64748b', label: 'פרמטר' };
  const upper = name.toUpperCase();
  for (const entry of PARAM_ICON_MAP) {
    if (entry.prefixes.some(p => upper.startsWith(p))) return entry;
  }
  if (/_P\b/.test(upper) || upper.endsWith('_P')) return { icon: '🎯', color: '#f59e0b', label: 'P gain' };
  if (/_IMAX$|_I\b/.test(upper) || upper.endsWith('_I')) return { icon: '∑', color: '#fb923c', label: 'I gain' };
  if (upper.endsWith('_D')) return { icon: '📉', color: '#818cf8', label: 'D gain' };
  if (upper.endsWith('_FF')) return { icon: '➡️', color: '#6ee7b7', label: 'FF gain' };
  return { icon: '⚙️', color: '#64748b', label: 'פרמטר' };
}

function renderParamIcon(key) {
  const k = encodeURIComponent(String(key || '').toUpperCase());
  const fb = getParamIcon(key);
  const title = String(fb.label).replace(/"/g, '&quot;');
  return `<span class="pc-param-icon-wrap" title="${title}">
    <img class="pc-param-icon pc-param-icon--svg" src="/api/param-icons/${k}" alt="" width="18" height="18" loading="lazy"
      onerror="this.style.display='none';this.parentElement.classList.add('pc-param-icon--failed')">
    <span class="pc-param-icon pc-param-icon--fallback" style="color:${fb.color}">${fb.icon}</span>
  </span>`;
}

function renderParamsIn(container, items) {
  if (!container) return;
  container.innerHTML = '';
  items.forEach((param) => {
    const locked = !!lockState[param.key];
    const card = document.createElement('article');
    card.className = 'param-card';
    card.innerHTML = `
      <div class="param-top">
        <h3 class="param-title">${renderParamIcon(param.key)}${param.label}</h3>
        <span class="param-info" title="${buildParamTooltip(param).replace(/"/g, '&quot;')}">?</span>
        <button class="lock-btn ${locked ? 'locked' : ''}" id="lock_${param.key}" title="נועל או משחרר את הפרמטר לעריכה">
          ${locked ? '🔒' : '🔓'}
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
      updateParamSyncBanner();
    });
  });
}

function paramMatchesSearchQuery(param, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const help = buildParamTooltip(param) || '';
  return `${param.key} ${param.label} ${help}`.toLowerCase().includes(q);
}

function renderParams() {
  const query = String(arduSearchQuery || '').trim();
  const landing = PARAMS.filter((p) => LANDING_PARAM_KEYS.has(p.key) && paramMatchesSearchQuery(p, query));
  const visionNav = PARAMS.filter((p) => VISION_NAV_PARAM_KEYS.has(p.key) && paramMatchesSearchQuery(p, query));
  const abort = PARAMS.filter((p) => ABORT_PARAM_KEYS.has(p.key) && paramMatchesSearchQuery(p, query));
  const takeoff = PARAMS.filter((p) => TAKEOFF_PARAM_KEYS.has(p.key) && paramMatchesSearchQuery(p, query));
  renderParamsIn(paramsGrid, landing);
  renderParamsIn(visionNavGrid, visionNav);
  renderParamsIn(abortGrid, abort);
  renderParamsIn(takeoffGrid, takeoff);
  bindParamHandlers(landing);
  bindParamHandlers(visionNav);
  bindParamHandlers(abort);
  bindParamHandlers(takeoff);
  updateParamSyncBanner();
}

/**
 * Why: drive the ArduPilot sub-tab form layout; what: metadata for checkboxes vs numeric inputs (Hebrew labels).
 */
function serialLabelForPort(port) {
  return `SERIAL${port}`;
}

function srLabelForBucket(bucket) {
  return `SR${bucket}`;
}

const FC_STATIC_FIELD_SCHEMA = [
  { group: 'EKF / AHRS', key: 'EK3_ENABLE', label: 'EKF3 פעיל', kind: 'bool', tier: 'advanced' },
  { group: 'EKF / AHRS', key: 'AHRS_EKF_TYPE', label: 'סוג EKF', kind: 'enum', options: [2, 3], tier: 'expert' },
  { group: 'EKF / AHRS', key: 'EK3_GPS_TYPE', label: 'EK3 — סוג GPS', kind: 'enum', options: [0, 1, 2, 3], tier: 'expert' },
  { group: 'EKF / AHRS', key: 'EK3_ALT_SOURCE', label: 'EK3 — מקור גובה', kind: 'enum', options: [0, 1, 2, 3], tier: 'expert' },
  { group: 'נחיתה מדויקת (Vision)', key: 'PLND_ENABLED', label: 'Precision Landing פעיל', kind: 'bool', tier: 'core' },
  { group: 'נחיתה מדויקת (Vision)', key: 'PLND_TYPE', label: 'סוג PLND', kind: 'enum', options: [0, 1, 2, 3, 4, 5], tier: 'core' },
  { group: 'נחיתה מדויקת (Vision)', key: 'PLND_BUS', label: 'PLND — Bus', kind: 'number', min: 0, max: 10, step: 1, tier: 'advanced' },
  { group: 'נחיתה מדויקת (Vision)', key: 'PLND_LAG', label: 'PLND — Lag (שניות)', kind: 'number', min: 0, max: 1, step: 0.01, tier: 'core' },
  { group: 'נחיתה מדויקת (Vision)', key: 'PLND_XY_DIST_MAX', label: 'מרחק מקס׳ XY מהמטרה (מ׳)', kind: 'number', min: 0, max: 50, step: 0.5, tier: 'advanced' },
  { group: 'נחיתה מדויקת (Vision)', key: 'PLND_STRICT', label: 'PLND — מצב strict', kind: 'enum', options: [0, 1], tier: 'advanced' },
  { group: 'לוגים', key: 'LOG_DISARMED', label: 'לוג גם כבוי (Disarmed)', kind: 'bool', tier: 'advanced' },
  { group: 'לוגים', key: 'LOG_REPLAY', label: 'LOG_REPLAY', kind: 'bool', tier: 'advanced' },
  { group: 'לוגים', key: 'LOG_BITMASK', label: 'LOG_BITMASK', kind: 'bitmask', min: 0, max: 2147483647, step: 1, tier: 'expert' },
  { group: 'נחיתה כללית', key: 'LAND_SPEED', label: 'מהירות נחיתה סופית (ס״מ/ש)', kind: 'number', min: 10, max: 300, step: 1, tier: 'core' },
  { group: 'נחיתה כללית', key: 'LAND_SPEED_HIGH', label: 'LAND_SPEED_HIGH', kind: 'number', min: 0, max: 500, step: 1, tier: 'advanced' },
  { group: 'נחיתה כללית', key: 'LAND_ALT_LOW', label: 'LAND_ALT_LOW (ס״מ)', kind: 'number', min: 0, max: 5000, step: 10, tier: 'advanced' },
  { group: 'נחיתה כללית', key: 'LAND_ABORT_PWM', label: 'LAND_ABORT_PWM', kind: 'number', min: 800, max: 2200, step: 1, tier: 'expert' },
  { group: 'גבולות טיסה (Ardu)', key: 'LIM_PITCH_CD', label: 'מגבלת פיץ׳ מקס׳ (סנטי-מעלות)', kind: 'number', min: 500, max: 4500, step: 50, tier: 'core' },
  { group: 'גבולות טיסה (Ardu)', key: 'LIM_ROLL_CD', label: 'מגבלת רול מקס׳ (סנטי-מעלות)', kind: 'number', min: 500, max: 6500, step: 50, tier: 'core' },
  { group: 'גבולות טיסה (Ardu)', key: 'RLL2SRV_RMAX', label: 'קצב גלגול מקס׳ (deg/s)', kind: 'number', min: 0, max: 180, step: 1, tier: 'core' },
  { group: 'בטיחות', key: 'FS_THR_ENABLE', label: 'Failsafe throttle', kind: 'enum', options: [0, 1, 2], tier: 'expert' },
  { group: 'בטיחות', key: 'FS_THR_VALUE', label: 'ערך PWM ל-FS', kind: 'number', min: 800, max: 1200, step: 1, tier: 'expert' },
  { group: 'בטיחות', key: 'ARMING_CHECK', label: 'ARMING_CHECK', kind: 'bitmask', min: 0, max: 2147483647, step: 1, tier: 'expert' },
];

function buildDynamicCommFields(rawCompanion = companionLinkState) {
  const companion = normalizeCompanionLink(rawCompanion);
  const serialPort = companion.companion_serial_port;
  const srBucket = companion.companion_sr_bucket;
  const serialKey = serialLabelForPort(serialPort);
  const srKey = srLabelForBucket(srBucket);
  return [
    { group: 'תקשורת Jetson', key: 'companion_serial_port', label: 'פורט Companion (SERIALx)', kind: 'enum', virtual: true, options: COMPANION_PORT_OPTIONS, tier: 'core' },
    { group: 'תקשורת Jetson', key: 'companion_sr_bucket', label: 'ערוץ SRx לקצבים', kind: 'enum', virtual: true, options: COMPANION_PORT_OPTIONS, tier: 'core' },
    { group: 'תקשורת Jetson', key: `${serialKey}_PROTOCOL`, label: `${serialKey} — פרוטוקול (MAVLink)`, kind: 'enum', options: [0, 1, 2], tier: 'core' },
    { group: 'תקשורת Jetson', key: `${serialKey}_BAUD`, label: `${serialKey} — Baud (Ardu code)`, kind: 'enum', options: [9, 19, 38, 57, 115, 230, 460, 921], tier: 'core' },
    { group: 'תקשורת Jetson', key: `${srKey}_EXT_STAT`, label: `שידור ${srKey} — EXT_STAT (Hz)`, kind: 'number', min: 0, max: 50, step: 1, tier: 'advanced' },
    { group: 'תקשורת Jetson', key: `${srKey}_POSITION`, label: `שידור ${srKey} — POSITION (Hz)`, kind: 'number', min: 0, max: 50, step: 1, tier: 'advanced' },
    { group: 'תקשורת Jetson', key: `${srKey}_RC_CHAN`, label: `שידור ${srKey} — RC_CHAN (Hz)`, kind: 'number', min: 0, max: 50, step: 1, tier: 'advanced' },
    { group: 'תקשורת Jetson', key: `${srKey}_EXTRA1`, label: `שידור ${srKey} — EXTRA1 (Hz)`, kind: 'number', min: 0, max: 50, step: 1, tier: 'advanced' },
    { group: 'תקשורת Jetson', key: `${srKey}_EXTRA2`, label: `שידור ${srKey} — EXTRA2 (Hz)`, kind: 'number', min: 0, max: 50, step: 1, tier: 'advanced' },
  ];
}

function buildArduFormFields(rawCompanion = companionLinkState) {
  return [...buildDynamicCommFields(rawCompanion), ...FC_STATIC_FIELD_SCHEMA];
}

let ARDU_FORM_FIELDS = buildArduFormFields();
let arduSearchQuery = '';
let arduSmartMatchedKeys = null;
/** @type {{ param_key: string, label_he: string, label_en: string }[] | null} */
let arduSmartSearchMatches = null;
/** @type {{ param_key: string, label_he: string, label_en: string, available_in_ui?: boolean }[] | null} */
let arduSmartOutsideMatches = null;
/** @type {Array | null} Custom params from active Feature Designer features */
let arduSmartCustomMatches = null;
const ARDU_FAVORITES_KEY = 'visionArduFavoritesV1';
let arduFavoriteKeys = new Set();
try {
  const rawFav = JSON.parse(localStorage.getItem(ARDU_FAVORITES_KEY) || '[]');
  if (Array.isArray(rawFav)) arduFavoriteKeys = new Set(rawFav.filter((x) => typeof x === 'string'));
} catch {
  arduFavoriteKeys = new Set();
}

/** Why: category tab order matches form field declaration order; what: unique group titles for Ardu subtabs. */
let ARDU_GROUP_ORDER = [...new Set(ARDU_FORM_FIELDS.map((f) => f.group))];

/** Why: per-FC param lock, same idea as `lockState` for Jetson profile. */
const arduLockState = Object.fromEntries(ARDU_FORM_FIELDS.map((f) => [f.key, false]));

function syncDynamicArduFormModel() {
  ARDU_FORM_FIELDS = buildArduFormFields(companionLinkState);
  ARDU_GROUP_ORDER = [...new Set(ARDU_FORM_FIELDS.map((f) => f.group))];
  ARDU_FORM_FIELDS.forEach((f) => {
    if (arduLockState[f.key] == null) arduLockState[f.key] = false;
  });
  const known = new Set(ARDU_FORM_FIELDS.map((f) => f.key));
  arduFavoriteKeys = new Set([...arduFavoriteKeys].filter((k) => known.has(k)));
}

function persistArduFavorites() {
  try {
    localStorage.setItem(ARDU_FAVORITES_KEY, JSON.stringify([...arduFavoriteKeys].sort()));
  } catch {}
}

/** Why: `?` tooltips on ArduPilot form — short Hebrew, parameter name in English in title bar only via label. */
const ARDU_PARAM_HELP = {
  companion_serial_port: 'בחירת פורט פיזי שאליו מחובר ה‑Companion. אם החיבור בפועל הוא SERIAL3 ואתה משאיר SERIAL2, ה‑FC ישדר בפורט הלא נכון ותראה ניתוקים/חוסר נתונים. שנה רק כשאתה בטוח בחיווט.',
  companion_sr_bucket: 'קובע מאיזה SRx יוצאים קצבי הטלמטריה ל‑Companion. ברוב המקרים תואם לאותו מספר של SERIALx, אבל יש מערכות שבהן זה מופרד. אם אתה רואה heartbeat בלי נתונים עשירים, בדוק את הערך הזה.',
  EK3_ENABLE: 'מפעיל את EKF3 כחישוב הניווט הראשי. שינוי פרמטר זה משפיע על התנהגות FC גלובלית ולכן מבוצע רק על הקרקע ובזהירות.',
  AHRS_EKF_TYPE: 'בוחר מנוע EKF בשכבת AHRS. ערך 3 הוא EKF3 ברוב גרסאות Plane. שינוי כאן יכול להשפיע על יציבות חישוב Attitude ו‑Position.',
  EK3_GPS_TYPE: 'מגדיר כמה ואיך EKF3 מסתמך על GPS. מתאים בעיקר לניסויי GPS/vision coupling — לא לשנות בלי להבין את מקור המיקום הפעיל בניסוי.',
  EK3_ALT_SOURCE: 'מקור הגובה הראשי של EKF3 (לרוב ברומטר/טווח/שילוב). אם מקור הגובה לא נכון תראה פרופיל גובה לא יציב ב‑final.',
  PLND_ENABLED: 'מפעיל Precision Landing בצד FC. כשכבוי, נתוני נחיתה מדויקת מה‑Companion יתקבלו אך לא יניעו לוגיקת נחיתה ייעודית.',
  PLND_TYPE: 'סוג קלט נחיתה מדויקת. ערך 1 לרוב מייצג MAVLink ולכן מתאים לאינטגרציה עם Companion/Jetson.',
  PLND_BUS: 'ערוץ/Bus ממנו FC מצפה לקבל PLND. ברוב תרחישי MAVLink נשאר ברירת מחדל, אבל במערכות היברידיות צריך התאמה מפורשת.',
  PLND_LAG: 'פיצוי עיכוב בין המדידה הוויזואלית לבין השימוש ב‑FC. אם גבוה מדי התיקון מגיע מאוחר; אם נמוך מדי מתקבלת תגובת יתר.',
  PLND_XY_DIST_MAX: 'רדיוס אופקי שבו FC עדיין מוכן להשתמש בנתוני PLND. קטן מדי יבטל תיקונים מוקדם, גדול מדי עלול לאפשר תיקונים אגרסיביים רחוקים.',
  PLND_STRICT: 'מצב הקשחה ללוגיקת PLND. במצב קשיח FC פחות סלחני לנתונים חלשים ולכן מתאים לשטח יציב/תצפית טובה, פחות לרוח ותנאים קשים.',
  LOG_DISARMED: 'רישום לוג גם כשהכלי Disarmed. חיוני לתחקור חיבור/פרמטרים לפני המראה, אבל מגדיל נפח לוג לאורך זמן.',
  LOG_REPLAY: 'שומר נתונים שמתאימים ל‑replay/ניתוח עומק. שימושי מאוד לניסויים, עם עלות כתיבה גדולה יותר.',
  LOG_BITMASK: 'בחירת סוגי הודעות בלוג כ‑bitmask. אם חסרים נתונים בתחקור — צריך להרחיב; אם עומס I/O גבוה — צריך לצמצם.',
  LAND_SPEED: 'מהירות הנמכה סופית בס״מ/ש. גבוה מדי ייתן נגיעה קשה, נמוך מדי עלול למשוך זמן final ולגרור תיקוני יתר ברוח.',
  LAND_SPEED_HIGH: 'מהירות נחיתה בשלבים גבוהים יותר (כשנתמך בפירמוור). עוזר לבנות מעבר הדרגתי בין final ל‑flare.',
  LAND_ALT_LOW: 'גובה המעבר לשלב נחיתה נמוך. קובע מתי לוגיקת low-alt ננעלת על התנהגות סופית.',
  LAND_ABORT_PWM: 'סף/ערך PWM שמוגדר ללוגיקת abort בצד FC (אם הקונפיג תומך). פרמטר רגיש — לשנות רק בניסוי מבוקר.',
  LIM_PITCH_CD: 'מגבלת זווית אף מקסימלית ביחידות סנטי-מעלה (למשל 3000 = 30°). פרמטר ArduPlane קנוני לזווית פיץ׳ מקסימלית.',
  LIM_ROLL_CD: 'מגבלת זווית גלגול מקסימלית ביחידות סנטי-מעלה.',
  RLL2SRV_RMAX: 'קצב גלגול מקסימלי (deg/s) — מגביל כמה מהר המטוס רשאי לגלגל. זה פרמטר של קצב (rate), לא של זווית יעד.',
  FS_THR_ENABLE: 'מצב הפעלת failsafe אובדן throttle/RC. זה פרמטר בטיחותי קריטי שמשנה התנהגות בעת אובדן קישור.',
  FS_THR_VALUE: 'ערך PWM שמתחתיו FC מחשיב מצב failsafe. חייב להתאים לקליברציה של המקלט כדי להימנע מהפעלות שווא.',
  ARMING_CHECK: 'bitmask בדיקות pre-arm. מאפשר לפתוח/לסגור בדיקות בטיחות. מומלץ לתעד כל שינוי כי זה משפיע ישירות על רמת הבטיחות בהמראה.',
};

function escapeArduTitle(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** Why: very wide numeric fields (baud, bitmask) stay as number inputs; the rest get a range slider. */
function arduFieldUseRange(f) {
  if (f.kind !== 'number' || f.virtual) return false;
  if (f.key === 'LOG_BITMASK') return false;
  if (/^SERIAL\d+_BAUD$/.test(f.key)) return false;
  return f.max - f.min <= 50000;
}

/** Why: stable `data-panel` ids; what: maps Hebrew group title to ASCII slug for DOM ids. */
function arduGroupToSlug(g) {
  const m = {
    'מועדפים': 'favorites',
    'תקשורת Jetson': 'jetson',
    'EKF / AHRS': 'ekf',
    'נחיתה מדויקת (Vision)': 'plnd',
    'לוגים': 'logs',
    'נחיתה כללית': 'land',
    'גבולות טיסה (Ardu)': 'limits',
    'בטיחות': 'safety',
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

/** Why: after READ, show whether each schema param key appears in the FC parameter list (MAVLink). What: pill next to title + optional card outline. */
function renderArduFcPresenceBadge(f) {
  if (f.virtual) {
    return '<span class="ardu-fc-presence ardu-fc-presence--virtual" title="שדה פרופיל בקונסולה — לא פרמטר ArduPilot על הבקר">פרופיל</span>';
  }
  if (!fcCurrentSnapshot || typeof fcCurrentSnapshot !== 'object') {
    return '<span class="ardu-fc-presence ardu-fc-presence--unknown" title="בצע «READ — מהרחפן» כדי לבדוק אם השם קיים בקושחה">לא נקרא</span>';
  }
  if (Object.prototype.hasOwnProperty.call(fcCurrentSnapshot, f.key)) {
    return '<span class="ardu-fc-presence ardu-fc-presence--ok" title="מפתח זה הופיע ברשימת הפרמטרים מהבקר (אחרי READ אחרון)">בבקר</span>';
  }
  return '<span class="ardu-fc-presence ardu-fc-presence--missing" title="לא הופיע אחרי READ — ייתכן שאין פרמטר בשם זה בגרסת הקושחה; WRITE עלול להיכשל">לא בבקר</span>';
}

function arduFcCardMissingClass(f) {
  if (f.virtual) return '';
  if (!fcCurrentSnapshot || typeof fcCurrentSnapshot !== 'object') return '';
  return Object.prototype.hasOwnProperty.call(fcCurrentSnapshot, f.key) ? '' : ' ardu-fc-param--missing-fc';
}

/** Why: one field card — same param-card pattern as Jetson tabs (כותרת, ?, מנעול, סליידר או מספר). */
function renderArduFieldCard(f) {
  const presenceBadge = renderArduFcPresenceBadge(f);
  const missCls = arduFcCardMissingClass(f);
  const isVirtual = f.virtual === true;
  const v = isVirtual ? companionLinkState[f.key] : arduTargetState[f.key];
  const locked = !!arduLockState[f.key];
  const fav = arduFavoriteKeys.has(f.key);
  const help = ARDU_PARAM_HELP[f.key] || f.label;
  const helpT = escapeArduTitle(help);
  const dis = locked && !isVirtual ? ' disabled' : '';
  const favBtn = `<button type="button" class="ardu-fav-btn ${fav ? 'on' : ''}" data-ardu-fav="${f.key}" title="${fav ? 'הסר ממועדפים' : 'הוסף למועדפים'}">${fav ? '★ מועדף' : '☆ מועדף'}</button>`;
  const iconHtml = renderParamIcon(f.key);
  if (f.kind === 'enum') {
    const options = (f.options || []).map((opt) => {
      const val = Number(opt);
      const selected = Number(v) === val ? ' selected' : '';
      return `<option value="${val}"${selected}>${val}</option>`;
    }).join('');
    return `<article class="param-card ardu-fc-param${missCls}" data-ardu-key="${f.key}">
      <div class="param-top">
        <h3 class="param-title">${iconHtml}${f.label}</h3>
        ${presenceBadge}
        <span class="param-info" title="${helpT}">?</span>
        ${favBtn}
        ${isVirtual ? '' : `<button type="button" class="lock-btn ${locked ? 'locked' : ''}" id="ardu_lock_${f.key}" title="נעל או שחרר עריכה">${locked ? '🔒' : '🔓'}</button>`}
      </div>
      <div class="param-meta">
        <span>בחירה בדידה</span>
        <span class="param-value" id="ardu_val_${f.key}">${v != null ? v : '—'}</span>
      </div>
      <select id="ardu_sel_${f.key}" data-ardu-key="${f.key}" data-ardu-kind="enum"${dis}>${options}</select>
      <span class="ardu-field-key ardu-fc-key-foot">${f.key}</span>
    </article>`;
  }
  if (f.kind === 'bitmask') {
    const valStr = v != null ? String(v) : '';
    return `<article class="param-card ardu-fc-param${missCls}" data-ardu-key="${f.key}">
      <div class="param-top">
        <h3 class="param-title">${iconHtml}${f.label}</h3>
        ${presenceBadge}
        <span class="param-info" title="${helpT}">?</span>
        ${favBtn}
        <button type="button" class="lock-btn ${locked ? 'locked' : ''}" id="ardu_lock_${f.key}" title="נעל או שחרר עריכה">${locked ? '🔒' : '🔓'}</button>
      </div>
      <div class="param-meta">
        <span>${f.min} – ${f.max}</span>
        <span class="param-value" id="ardu_val_${f.key}">${valStr}</span>
      </div>
      <input type="number" id="ardu_num_${f.key}" data-ardu-key="${f.key}" data-ardu-kind="bitmask"
        min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${valStr}"${dis} />
      <span class="ardu-field-key ardu-fc-key-foot">${f.key}</span>
    </article>`;
  }
  if (f.kind === 'bool') {
    const on = Number(v) === 1;
    return `<article class="param-card ardu-fc-param${missCls}" data-ardu-key="${f.key}">
      <div class="param-top">
        <h3 class="param-title">${iconHtml}${f.label}</h3>
        ${presenceBadge}
        <span class="param-info" title="${helpT}">?</span>
        ${favBtn}
        ${isVirtual ? '' : `<button type="button" class="lock-btn ${locked ? 'locked' : ''}" id="ardu_lock_${f.key}" title="נעל או שחרר עריכה">${locked ? '🔒' : '🔓'}</button>`}
      </div>
      <div class="param-meta ardu-fc-bool-row">
        <label class="ardu-fc-cb-label"><input type="checkbox" id="ardu_cb_${f.key}" data-ardu-key="${f.key}" ${on ? 'checked' : ''}${dis} /> פעיל</label>
        <span class="ardu-field-key">${f.key}</span>
      </div>
    </article>`;
  }
  const useRange = arduFieldUseRange(f);
  const valStr = v != null ? String(v) : '';
  if (useRange) {
    return `<article class="param-card ardu-fc-param${missCls}" data-ardu-key="${f.key}">
      <div class="param-top">
        <h3 class="param-title">${iconHtml}${f.label}</h3>
        ${presenceBadge}
        <span class="param-info" title="${helpT}">?</span>
        ${favBtn}
        ${isVirtual ? '' : `<button type="button" class="lock-btn ${locked ? 'locked' : ''}" id="ardu_lock_${f.key}" title="נעל או שחרר עריכה">${locked ? '🔒' : '🔓'}</button>`}
      </div>
      <div class="param-meta">
        <span>${f.min} – ${f.max}</span>
        <span class="param-value" id="ardu_val_${f.key}">${valStr}</span>
      </div>
      <input type="range" class="ardu-fc-range" id="ardu_rng_${f.key}" data-ardu-key="${f.key}"
        min="${f.min}" max="${f.max}" step="${f.step}" value="${valStr}"${dis} />
      <span class="ardu-field-key ardu-fc-key-foot">${f.key}</span>
    </article>`;
  }
  return `<article class="param-card ardu-fc-param${missCls}" data-ardu-key="${f.key}">
    <div class="param-top">
      <h3 class="param-title">${iconHtml}${f.label}</h3>
      ${presenceBadge}
      <span class="param-info" title="${helpT}">?</span>
      ${favBtn}
      ${isVirtual ? '' : `<button type="button" class="lock-btn ${locked ? 'locked' : ''}" id="ardu_lock_${f.key}" title="נעל או שחרר עריכה">${locked ? '🔒' : '🔓'}</button>`}
    </div>
    <div class="param-meta">
      <span>${f.min} – ${f.max}</span>
      <span class="param-value" id="ardu_val_${f.key}">${valStr}</span>
    </div>
    <input type="number" id="ardu_num_${f.key}" data-ardu-key="${f.key}" data-ardu-kind="number"
      min="${f.min}" max="${f.max}" step="${f.step}" value="${valStr}"${dis} />
    <span class="ardu-field-key ardu-fc-key-foot">${f.key}</span>
  </article>`;
}

/** Why: render editable FC targets under מרכז פרמטרים; what: one sub-tab per category (no single long scroll). */
function renderArduParamForm() {
  syncDynamicArduFormModel();
  const tabs = arduTopCatsHost;
  const host = document.getElementById('arduParamFormPanels');
  if (!tabs || !host) return;
  const paramSelArduSlug = (() => {
    const v = document.getElementById('paramSubtabSelect')?.value || '';
    const m = v.match(/^ardu-(.+)$/);
    return m ? m[1] : null;
  })();
  const prevSlug = document.querySelector('#arduCatSelect')?.value
    || paramSelArduSlug
    || document.querySelector('.ardu-cat-subtab.active')?.dataset?.arduCat;
  const byGroup = {};
  ARDU_FORM_FIELDS.forEach((f) => {
    if (!byGroup[f.group]) byGroup[f.group] = [];
    byGroup[f.group].push(f);
  });
  const query = String(arduSearchQuery || '').trim().toLowerCase();
  const filteredByGroup = {};
  Object.entries(byGroup).forEach(([grp, fields]) => {
    let out = fields.slice();
    if (Array.isArray(arduSmartMatchedKeys) && arduSmartMatchedKeys.length) {
      out = out.filter((f) => arduSmartMatchedKeys.includes(f.key));
    } else if (query) {
      out = out.filter((f) => {
        const help = ARDU_PARAM_HELP[f.key] || '';
        return `${f.key} ${f.label} ${help}`.toLowerCase().includes(query);
      });
    }
    filteredByGroup[grp] = out;
  });
  const favoriteFields = [];
  Object.values(filteredByGroup).forEach((fields) => {
    fields.forEach((f) => {
      if (arduFavoriteKeys.has(f.key) && !favoriteFields.some((x) => x.key === f.key)) favoriteFields.push(f);
    });
  });
  if (favoriteFields.length) filteredByGroup['מועדפים'] = favoriteFields;
  const order = ['מועדפים', ...ARDU_GROUP_ORDER].filter((g, i, arr) => arr.indexOf(g) === i && filteredByGroup[g]?.length);
  const activeSlug = (prevSlug && order.some((g) => arduGroupToSlug(g) === prevSlug))
    ? prevSlug
    : arduGroupToSlug(order[0] || '');
  tabs.innerHTML = `<select id="arduCatSelect" class="ardu-cat-select" aria-label="קטגוריית ArduPilot">`
    + order.map((grp) => {
        const slug = arduGroupToSlug(grp);
        return `<option value="${slug}"${slug === activeSlug ? ' selected' : ''}>${grp}</option>`;
      }).join('')
    + `</select>`;
  host.innerHTML = order
    .map((grp) => {
      const slug = arduGroupToSlug(grp);
      const fields = filteredByGroup[grp];
      const grid = fields.map((f) => renderArduFieldCard(f)).join('');
      return `<div class="ardu-cat-subpanel${slug === activeSlug ? ' visible' : ''}" data-panel="${slug}" role="tabpanel">${grid}</div>`;
    })
    .join('');

  updateParamSyncBanner();
}

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}

function focusArduParamCardByKey(key) {
  const host = document.getElementById('arduParamFormPanels');
  if (!host || !key) return false;
  const field = ARDU_FORM_FIELDS.find((f) => f.key === key);
  if (!field) return false;
  const targetSlug = arduGroupToSlug(field.group);
  const sel = document.querySelector('#arduCatSelect');
  if (sel) {
    const hasDirect = [...sel.options].some((o) => o.value === targetSlug);
    sel.value = hasDirect ? targetSlug : (sel.querySelector('option[value="favorites"]') ? 'favorites' : sel.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // Sync main param-subtab select to the matching ardu-* virtual option.
    const paramSel = document.getElementById('paramSubtabSelect');
    if (paramSel) {
      const virtualVal = `ardu-${sel.value}`;
      if ([...paramSel.options].some((o) => o.value === virtualVal)) {
        paramSel.value = virtualVal;
        paramSel.classList.add('param-subtab-select--active');
        try { sessionStorage.setItem(CONTROL_SUBTAB_KEY, virtualVal); } catch { /* ignore */ }
      }
    }
  }
  const safeKey = String(key).replace(/"/g, '\\"');
  const card = host.querySelector(`[data-ardu-key="${safeKey}"]`);
  if (!card) return false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  card.classList.add('smart-focus');
  setTimeout(() => card.classList.remove('smart-focus'), 1300);
  const input = card.querySelector('input, select, button.lock-btn');
  if (input && typeof input.focus === 'function') input.focus({ preventScroll: true });
  return true;
}

/** Why: switch ArduPilot firmware category panels on select change; what: shows the matching .ardu-cat-subpanel. */
function wireArduCategorySubtabsOnce() {
  const root = document.getElementById('arduParamFormPanels');
  if (!root || root.dataset.arduCatWired === '1') return;
  root.dataset.arduCatWired = '1';
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('#arduCatSelect');
    if (!sel) return;
    const slug = sel.value;
    root.querySelectorAll('.ardu-cat-subpanel').forEach((p) => {
      p.classList.toggle('visible', p.dataset.panel === slug);
    });
  });
}
wireArduCategorySubtabsOnce();

/** Why: param-subtab select drives landing/abort/visionNav/custom subpanels and ArduPilot categories. */
(function initParamSubtabSelect() {
  const sel = document.getElementById('paramSubtabSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const val = sel.value;
    const arduMatch = val.match(/^ardu-(.+)$/);
    if (arduMatch) {
      const slug = arduMatch[1];
      applyControlSubtab('arduParams', { selectOverride: val });
      // Navigate the hidden #arduCatSelect to the matching category slug.
      requestAnimationFrame(() => {
        const catSel = document.getElementById('arduCatSelect');
        if (catSel) {
          catSel.value = slug;
          catSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    } else {
      applyControlSubtab(val);
    }
  });
})();

/** Why: single listener for Ardu FC cards — סליידר/מספר/checkbox + מנעול; avoids re-binding after every render. */
(function initArduFormPanelsDelegation() {
  const host = document.getElementById('arduParamFormPanels');
  if (!host || host.dataset.delegationWired === '1') return;
  host.dataset.delegationWired = '1';
  function applyArduFieldInput(t) {
    const key = t.getAttribute('data-ardu-key');
    if (!key) return;
    const field = ARDU_FORM_FIELDS.find((x) => x.key === key);
    if (!field) return;
    if (!field.virtual && arduLockState[key]) return;
    if (field.virtual && (key === 'companion_serial_port' || key === 'companion_sr_bucket')) {
      companionLinkState[key] = Number(t.value);
      const normalized = normalizeCompanionLink(companionLinkState);
      companionLinkState.companion_serial_port = normalized.companion_serial_port;
      companionLinkState.companion_sr_bucket = normalized.companion_sr_bucket;
      syncDynamicArduFormModel();
      renderArduParamForm();
      syncConfigTextFromArdu();
      updateParamSyncBanner();
      return;
    }
    if (field.kind === 'bool') {
      arduTargetState[key] = t.checked ? 1 : 0;
    } else if (field.kind === 'enum') {
      const n = Number(t.value);
      if (Number.isFinite(n)) arduTargetState[key] = n;
    } else {
      arduTargetState[key] = coerceArduFieldValue(field, t.value);
      const valEl = document.getElementById(`ardu_val_${key}`);
      if (valEl) valEl.textContent = String(arduTargetState[key]);
    }
    syncConfigTextFromArdu();
    updateParamSyncBanner();
  }
  host.addEventListener('click', (e) => {
    const favBtn = e.target.closest('button[data-ardu-fav]');
    if (favBtn && host.contains(favBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const key = favBtn.getAttribute('data-ardu-fav');
      if (!key) return;
      if (arduFavoriteKeys.has(key)) arduFavoriteKeys.delete(key);
      else arduFavoriteKeys.add(key);
      persistArduFavorites();
      renderArduParamForm();
      return;
    }
    const lockBtn = e.target.closest('button.lock-btn[id^="ardu_lock_"]');
    if (!lockBtn || !host.contains(lockBtn)) return;
    e.preventDefault();
    e.stopPropagation();
    const key = lockBtn.id.replace('ardu_lock_', '');
    if (!key) return;
    arduLockState[key] = !arduLockState[key];
    const locked = arduLockState[key];
    lockBtn.classList.toggle('locked', locked);
    lockBtn.textContent = locked ? '🔒' : '🔓';
    const rng = document.getElementById(`ardu_rng_${key}`);
    const num = document.getElementById(`ardu_num_${key}`);
    const cb = document.getElementById(`ardu_cb_${key}`);
    if (rng) rng.disabled = locked;
    if (num) num.disabled = locked;
    if (cb) cb.disabled = locked;
  });
  host.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.getAttribute('data-ardu-key')) return;
    if (t.type === 'checkbox' || t.tagName === 'SELECT') return;
    applyArduFieldInput(t);
  });
  host.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.getAttribute('data-ardu-key')) return;
    if (t.type !== 'checkbox' && t.tagName !== 'SELECT') return;
    applyArduFieldInput(t);
  });
})();

(function initArduParamSearch() {
  const input = document.getElementById('arduParamSearchInput');
  const searchBtn = document.getElementById('arduParamSearchBtn');
  const clearBtn = document.getElementById('arduParamSearchClearBtn');
  const smartBtn = document.getElementById('arduParamSmartSearchBtn');
  const status = document.getElementById('arduSearchStatus');
  const smartResultsEl = document.getElementById('arduSmartSearchResults');
  if (!input || !searchBtn || !clearBtn || !smartBtn) return;

  function escapeSmartHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const formPanelsEl = document.getElementById('arduParamFormPanels');

  function renderArduSmartSearchPanel() {
    if (!smartResultsEl) return;
    const listAll = Array.isArray(arduSmartSearchMatches) ? arduSmartSearchMatches : [];
    const outsideAll = Array.isArray(arduSmartOutsideMatches) ? arduSmartOutsideMatches : [];
    const list = listAll.slice(0, 5);
    const outside = outsideAll.slice(0, Math.max(0, 5 - list.length));
    // (early-exit now handled below after customShown is computed)

    // Clean Hebrew: take first meaningful sentence, strip repeated param-key prefixes, limit length.
    const cleanHe = (s, key) => {
      let t = String(s || '').trim();
      if (!t) return '';
      // Remove leading "KEY — KEY: " or "KEY — " patterns that repeat the param name
      t = t.replace(new RegExp(`^${key}[\\s\\-—:]+`, 'i'), '').trim();
      t = t.replace(/^[A-Z0-9_]{3,}[\s\-—:]+/g, '').trim();
      // Take first sentence
      const first = t.split(/[.!?\n]/)[0].trim();
      return first.length > 90 ? `${first.slice(0, 90)}…` : first;
    };

    const buildCard = (m, isOutside) => {
      const he = cleanHe(m.label_he, m.param_key) || cleanHe(m.label_en, m.param_key) || m.param_key;
      const conf = Number.isFinite(Number(m.confidence)) ? Math.round(Number(m.confidence) * 100) : null;
      const keyAttr = escapeAttr(m.param_key);
      const keyTxt = escapeSmartHtml(m.param_key);
      const heTxt = escapeSmartHtml(he);
      const editorId = `smart-edit-${m.param_key.replace(/[^A-Za-z0-9]/g, '_')}`;
      const enumValues = m.enum_values && typeof m.enum_values === 'object' ? m.enum_values : null;
      const formatValue = (v) => {
        if (v == null || v === '') return 'לא נקרא מהרחפן';
        const label = enumValues?.[String(v)];
        return label ? `${v} (${label})` : String(v);
      };
      const currentValue = m.live_value ?? arduTargetState?.[m.param_key] ?? null;
      const defaultText = m.default_value == null
        ? 'לא מופיע במאגר הרשמי'
        : formatValue(m.default_value);
      const helpText = m.simple_he || m.reason_he || he;
      const isServoFunction = /^SERVO\d+_FUNCTION$/.test(m.param_key);
      const valueEditor = isServoFunction
        ? `<select class="ardu-smart-inline-input" data-param-key="${keyAttr}" aria-label="ערך חדש עבור ${keyTxt}">
             <option value="">בחר מצב</option>
             <option value="26">26 — הפעל ניהוג גלגל אף</option>
             <option value="0">0 — כבה / Disabled</option>
           </select>`
        : `<input type="number" class="ardu-smart-inline-input" placeholder="ערך חדש"
                 data-param-key="${keyAttr}" step="any" aria-label="ערך חדש עבור ${keyTxt}" />`;
      const fullHelp = [
        m.simple_he || m.reason_he || '',
        m.label_he && m.label_he !== (m.simple_he || m.reason_he) ? m.label_he : '',
        m.label_en ? `(${m.label_en})` : '',
        m.units ? `יחידות: ${m.units}` : '',
      ].map(s => s.trim()).filter(Boolean).join('\n') || helpText;
      const panelId = `smart-help-panel-${m.param_key.replace(/[^A-Za-z0-9]/g, '_')}`;
      const inlineEditor = `
        <div class="ardu-smart-meta">
          <span>ערך נוכחי: <strong>${escapeSmartHtml(formatValue(currentValue))}</strong></span>
          <span>ברירת מחדל: <strong>${escapeSmartHtml(defaultText)}</strong></span>
          <span class="ardu-smart-help" data-help="${escapeAttr(fullHelp)}" data-panel="${panelId}" title="הצג הסבר">?</span>
        </div>
        <div class="ardu-smart-help-panel" id="${panelId}"></div>
        <div class="ardu-smart-inline-editor" id="${editorId}">
          ${valueEditor}
          <button type="button" class="ardu-smart-send-btn" data-param-key="${keyAttr}" title="שלח לרחפן">שלח ✈</button>
          <span class="ardu-smart-send-status"></span>
        </div>`;

      if (isOutside) {
        return `<li class="ardu-smart-result-card outside">
          <div class="ardu-smart-result-key">${keyTxt}</div>
          <div class="ardu-smart-result-he">${heTxt}</div>
          ${conf !== null ? `<div class="ardu-smart-result-confidence">${conf}% התאמה</div>` : ''}
          ${inlineEditor}
        </li>`;
      }
      return `<li class="ardu-smart-result-card" data-smart-key="${keyAttr}">
        <div class="ardu-smart-result-key">${keyTxt}</div>
        <div class="ardu-smart-result-he">${heTxt}</div>
        ${conf !== null ? `<div class="ardu-smart-result-confidence">${conf}% התאמה</div>` : ''}
        ${inlineEditor}
      </li>`;
    };

    const customAll = Array.isArray(arduSmartCustomMatches) ? arduSmartCustomMatches : [];
    const customShown = customAll.slice(0, 5);

    // If there is nothing at all to show (including custom), hide the panel
    if (!list.length && !outside.length && !customShown.length) {
      smartResultsEl.innerHTML = '';
      smartResultsEl.classList.add('hidden');
      smartResultsEl.setAttribute('hidden', 'true');
      if (formPanelsEl) { formPanelsEl.style.display = ''; }
      return;
    }

    smartResultsEl.classList.remove('hidden');
    smartResultsEl.removeAttribute('hidden');
    if (formPanelsEl) { formPanelsEl.style.display = 'none'; }

    const totalShown = list.length + outside.length;

    const buildCustomCard = (m) => {
      const key = String(m.param_key || '');
      const keyAttr = escapeAttr(key);
      const keyTxt = escapeSmartHtml(key);
      const desc = escapeSmartHtml(String(m.description || m.description_en || key).slice(0, 90));
      const feat = escapeSmartHtml(String(m.feature_name || ''));
      const cur = m.current_value ?? m.default_value ?? 0;
      const editorId = `fd-smart-edit-${key.replace(/[^A-Za-z0-9]/g, '_')}`;
      return `<li class="ardu-smart-result-card fd-custom-result-card">
        <div class="ardu-smart-result-key">${keyTxt} <span class="fd-custom-badge" title="פרמטר מפיצ'ר מותאם">✨ Custom</span></div>
        <div class="ardu-smart-result-he">${desc}</div>
        ${feat ? `<div class="fd-custom-feature-tag">פיצ'ר: ${feat}</div>` : ''}
        <div class="ardu-smart-meta">
          <span>ערך נוכחי: <strong>${escapeSmartHtml(String(cur))}</strong></span>
          <span>ברירת מחדל: <strong>${escapeSmartHtml(String(m.default_value ?? 0))}</strong></span>
        </div>
        <div class="ardu-smart-inline-editor" id="${editorId}">
          <input type="number" class="ardu-smart-inline-input fd-custom-param-input" placeholder="ערך חדש"
                 data-custom-param-key="${keyAttr}" step="any" aria-label="ערך חדש עבור ${keyTxt}" />
          <button type="button" class="ardu-smart-send-btn fd-custom-param-send"
                  data-custom-param-key="${keyAttr}" title="שמור ערך">שמור ✅</button>
          <span class="ardu-smart-send-status"></span>
        </div>
      </li>`;
    };

    const customSection = customShown.length
      ? `<div class="fd-custom-section-head">פיצ'רים מותאמים (${customShown.length})</div>
         ${customShown.map(buildCustomCard).join('')}`
      : '';

    smartResultsEl.innerHTML = `
      <div class="ardu-smart-results-head">נמצאו ${totalShown + customShown.length} פרמטרים${customShown.length ? ` (כולל ${customShown.length} מפיצ'רים מותאמים)` : ''}</div>
      <ul class="ardu-smart-results-list">
        ${list.map((m) => buildCard(m, false)).join('')}
        ${outside.map((m) => buildCard(m, true)).join('')}
        ${customSection}
      </ul>`;

    // Handle save for custom params via Feature Designer param-set route
    smartResultsEl.querySelectorAll('.fd-custom-param-send').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-custom-param-key');
        const editor = btn.closest('.ardu-smart-inline-editor');
        const inp = editor?.querySelector('.fd-custom-param-input');
        const statusEl = editor?.querySelector('.ardu-smart-send-status');
        if (!inp || !key) return;
        const val = Number(inp.value);
        if (!Number.isFinite(val)) { if (statusEl) statusEl.textContent = 'ערך לא תקין'; return; }
        if (statusEl) statusEl.textContent = '…';
        btn.disabled = true;
        try {
          const r = await fetch('/api/feature-designer/param-set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ param: key, value: val }),
          });
          const d = await r.json();
          if (statusEl) statusEl.textContent = d.ok ? `✅ נשמר` : `✘ ${d.message || 'שגיאה'}`;
        } catch (err) {
          if (statusEl) statusEl.textContent = `✘ ${err?.message || 'שגיאת רשת'}`;
        }
        btn.disabled = false;
      });
    });
  }

  function setStatus(msg, cls = '') {
    if (!status) return;
    status.textContent = msg;
    status.className = `vision-config-status ${cls}`.trim();
  }

  function applySimpleSearch() {
    arduSearchQuery = input.value || '';
    arduSmartMatchedKeys = null;
    arduSmartSearchMatches = null;
    arduSmartOutsideMatches = null;
    arduSmartCustomMatches = null;
    renderArduSmartSearchPanel();
    renderArduParamForm();
    renderParams();
    setStatus(arduSearchQuery ? `מסנן לפי: ${arduSearchQuery}` : '');
  }

  input.addEventListener('input', applySimpleSearch);
  searchBtn.addEventListener('click', applySimpleSearch);

  clearBtn.addEventListener('click', () => {
    input.value = '';
    arduSearchQuery = '';
    arduSmartMatchedKeys = null;
    arduSmartSearchMatches = null;
    arduSmartOutsideMatches = null;
    arduSmartCustomMatches = null;
    renderArduSmartSearchPanel();
    renderArduParamForm();
    renderParams();
    setStatus('');
  });

  smartBtn.addEventListener('click', async () => {
    const q = String(input.value || '').trim();
    if (!q) {
      setStatus('כתוב קודם מה אתה מחפש (למשל: "נחיתה קשה" או "ניתוקים בתקשורת").', 'fail');
      return;
    }
    setStatus('מחפש…', '');
    try {
      const res = await fetch('/api/param-center/smart-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        const snippet = raw.replace(/\s+/g, ' ').slice(0, 140);
        arduSmartSearchMatches = null;
        renderArduSmartSearchPanel();
        setStatus(
          `חיפוש חכם נכשל: תשובת השרת אינה JSON (${res.status})${snippet ? ` — ${snippet}` : ''}`,
          'fail',
        );
        return;
      }
      const keys = Array.isArray(data.keys) ? data.keys : [];
      const matches = Array.isArray(data.editable_matches)
        ? data.editable_matches
        : Array.isArray(data.matches)
          ? data.matches
          : [];
      const outside = Array.isArray(data.outside_matches)
        ? data.outside_matches
        : Array.isArray(data.outside_matches_legacy)
          ? data.outside_matches_legacy
          : Array.isArray(data.outside_legacy)
            ? data.outside_legacy
            : [];
      // Custom Feature Designer params
      arduSmartCustomMatches = Array.isArray(data.custom_matches) && data.custom_matches.length
        ? data.custom_matches : null;
      if (!res.ok || !data.ok) {
        arduSmartSearchMatches = null;
        arduSmartOutsideMatches = null;
        renderArduSmartSearchPanel();
        const detail = data.message || data.error || (res.status ? `HTTP ${res.status}` : '');
        setStatus(detail ? `חיפוש חכם נכשל: ${detail}` : 'חיפוש חכם נכשל', 'fail');
        return;
      }
      if (!keys.length) {
        arduSmartMatchedKeys = null;
        arduSmartSearchMatches = null;
        arduSmartOutsideMatches = outside.length ? outside : null;
        renderArduSmartSearchPanel();
        const customCount = Array.isArray(arduSmartCustomMatches) ? arduSmartCustomMatches.length : 0;
        if (customCount) {
          setStatus(`נמצאו ${customCount} פרמטרים מפיצ'רים מותאמים שלך.`, 'ok');
        } else if (outside.length) {
          setStatus(`לא נמצאו פרמטרים פתוחים לעריכה במסך זה. נמצאו ${outside.length} פרמטרים בארדופיילוט מחוץ לסקופ.`, 'ok');
        } else {
          setStatus('לא נמצאו פרמטרים מתאימים — נסה ניסוח אחר או חיפוש רגיל.', 'fail');
        }
        return;
      }
      arduSmartMatchedKeys = keys;
      arduSmartSearchMatches = matches.length ? matches : keys.map((k) => ({ param_key: k, label_he: k, label_en: k }));
      arduSmartOutsideMatches = outside.length ? outside : null;
      applyControlSubtab('arduParams', { selectOverride: 'ardu-jetson' });
      renderArduSmartSearchPanel();
      renderArduParamForm();
      const src =
        data.source === 'gemini' || data.source === 'gemini+local'
          ? 'Gemini'
          : data.source === 'hard-intent'
            ? 'זיהוי כוונה קשיח'
          : data.source === 'local'
            ? 'מילון מקומי'
            : data.source === 'fuzzy'
              ? 'התאמה מקומית (כולל טיפוגרפיה קרובה)'
              : '';
      const hint =
        data.source === 'fuzzy' ? ' — Gemini לא זמין; הוחלה התאמה מקומית (מילון + טיפוגרפיה קרובה).' : '';
      const shown = matches.length + outside.length;
      setStatus(`נמצאו ${shown} תוצאות${src ? ` (${src})` : ''}${hint} — לחץ "ערוך" ליד פרמטר כדי לפתוח לעריכה.`, 'ok');
    } catch (err) {
      arduSmartSearchMatches = null;
      arduSmartOutsideMatches = null;
      renderArduSmartSearchPanel();
      const msg = err && err.message ? String(err.message) : '';
      setStatus(
        msg ? `חיפוש חכם נכשל (רשת/דפדפן): ${msg}` : 'חיפוש חכם נכשל כרגע — נסה שוב בעוד רגע.',
        'fail',
      );
    }
  });

  async function handleParamSend(btn) {
    const key = btn.getAttribute('data-param-key');
    if (!key) return;
    const editor = btn.closest('.ardu-smart-inline-editor');
    const input = editor?.querySelector('.ardu-smart-inline-input');
    const statusEl = editor?.querySelector('.ardu-smart-send-status');
    if (!input || !statusEl) return;
    const raw = input.value.trim();
    if (raw === '') {
      statusEl.textContent = 'הכנס ערך';
      statusEl.className = 'ardu-smart-send-status fail';
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      statusEl.textContent = 'ערך לא תקין';
      statusEl.className = 'ardu-smart-send-status fail';
      return;
    }
    btn.disabled = true;
    statusEl.textContent = 'שולח…';
    statusEl.className = 'ardu-smart-send-status';
    try {
      const res = await fetch('/api/param-center/param-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ param: key, value }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        statusEl.textContent = `✘ ${d.message || 'שגיאה'}`;
        statusEl.className = 'ardu-smart-send-status fail';
        btn.disabled = false;
        return;
      }
      if (d.via === 'offline') {
        statusEl.textContent = '⚠ נשמר (לא מחובר לרחפן)';
        statusEl.className = 'ardu-smart-send-status warn';
      } else {
        const echo = d.value != null ? ` (FC: ${d.value})` : '';
        statusEl.textContent = `✔ נשלח${echo}`;
        statusEl.className = 'ardu-smart-send-status ok';
      }
      input.value = '';
    } catch (err) {
      statusEl.textContent = `✘ ${err?.message || 'שגיאת רשת'}`;
      statusEl.className = 'ardu-smart-send-status fail';
    }
    btn.disabled = false;
  }

  function handleSmartResultOpen(e) {
    // ? help button — toggle inline description panel
    const helpBtn = e.target.closest('.ardu-smart-help');
    if (helpBtn) {
      const panelId = helpBtn.getAttribute('data-panel');
      const helpText = helpBtn.getAttribute('data-help') || '';
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        const isOpen = panel.classList.toggle('visible');
        helpBtn.classList.toggle('open', isOpen);
        if (isOpen && !panel.textContent.trim()) panel.textContent = helpText;
      }
      return;
    }

    // Send-to-FC button
    const sendBtn = e.target.closest('.ardu-smart-send-btn');
    if (sendBtn) { handleParamSend(sendBtn); return; }

    // Jump-to-edit button — opens the card in the form below
    const jumpBtn = e.target.closest('.ardu-smart-jump-btn');
    if (jumpBtn) {
      const key = jumpBtn.getAttribute('data-smart-key');
      if (!key) return;
      const ok = focusArduParamCardByKey(key);
      if (!ok) setStatus(`לא נמצא כרטיס לעריכה עבור ${key}. השתמש בעורך המובנה בכרטיס.`, 'fail');
      return;
    }
  }

  // Allow pressing Enter inside the inline input to send
  smartResultsEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('.ardu-smart-inline-input');
    if (!input) return;
    const btn = input.closest('.ardu-smart-inline-editor')?.querySelector('.ardu-smart-send-btn');
    if (btn) handleParamSend(btn);
  });

  smartResultsEl?.addEventListener('click', handleSmartResultOpen);
})();

/** Why: hydrate UI from server after boot or READ; what: merges profile + FC target, re-renders sliders and Ardu form. */
async function loadVisionConfigFromServer(statusEl) {
  try {
    const res = await fetch('/api/vision/config');
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    if (d.profile && typeof d.profile === 'object') {
      Object.keys(profileState).forEach((key) => {
        if (d.profile[key] != null && Number.isFinite(Number(d.profile[key]))) {
          profileState[key] = Number(d.profile[key]);
        }
      });
      const normalized = normalizeCompanionLink(d.profile);
      companionLinkState.companion_serial_port = normalized.companion_serial_port;
      companionLinkState.companion_sr_bucket = normalized.companion_sr_bucket;
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
    captureServerBaseline();
    updateParamSyncBanner();
    if (statusEl) {
      statusEl.textContent = 'נטען מהשרת';
      statusEl.className = 'vision-config-status ok';
    }
  } catch {
    if (statusEl) {
      statusEl.textContent = 'שגיאת רשת';
      statusEl.className = 'vision-config-status fail';
    }
  }
}

/** Why: persist full tab state server-side; what: POST profile + arduTarget for next session / other clients. */
async function saveVisionConfigToServer(statusEl) {
  try {
    const profilePayload = {
      ...profileState,
      companion_serial_port: companionLinkState.companion_serial_port,
      companion_sr_bucket: companionLinkState.companion_sr_bucket,
    };
    const res = await fetch('/api/vision/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: profilePayload, arduTarget: { ...arduTargetState } }),
    });
    const d = await res.json();
    if (d.ok) {
      captureServerBaseline();
      updateParamSyncBanner();
      if (statusEl) {
        statusEl.textContent = 'נשמר בשרת';
        statusEl.className = 'vision-config-status ok';
      }
    } else if (statusEl) {
      statusEl.textContent = 'נכשל';
      statusEl.className = 'vision-config-status fail';
    }
  } catch {
    if (statusEl) {
      statusEl.textContent = 'שגיאת רשת';
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
  saveProfileBtn.addEventListener('click', async () => {
    // Always keep localStorage for backward-compat / offline use.
    localStorage.setItem('visionLandingProfile', JSON.stringify({
      values: profileState,
      locks: lockState,
      companionLink: { ...companionLinkState },
    }));
    // Additionally push to server so the profile persists across browser clears / devices.
    saveProfileBtn.textContent = '⏳ שומר…';
    try {
      const res = await fetch('/api/vision/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: {
            ...profileState,
            companion_serial_port: companionLinkState.companion_serial_port,
            companion_sr_bucket: companionLinkState.companion_sr_bucket,
          },
          arduTarget: { ...arduTargetState },
        }),
      });
      const d = await res.json();
      if (d.ok) {
        captureServerBaseline();
        updateParamSyncBanner();
        saveProfileBtn.textContent = '✓ נשמר';
      } else {
        saveProfileBtn.textContent = '⚠ שגיאה';
      }
    } catch {
      saveProfileBtn.textContent = '⚠ שגיאת רשת';
    }
    setTimeout(() => { saveProfileBtn.textContent = 'שמור פרופיל'; }, 1800);
  });
}

if (exportProfileBtn) {
  exportProfileBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({
      values: profileState,
      locks: lockState,
      companionLink: { ...companionLinkState },
      arduTarget: { ...arduTargetState },
    }, null, 2)], { type: 'application/json' });
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
      const incomingCompanion = parsed?.companionLink || parsed || {};
      Object.keys(profileState).forEach((key) => {
        if (typeof incomingValues[key] === 'number') profileState[key] = incomingValues[key];
        if (typeof incomingLocks[key] === 'boolean') lockState[key] = incomingLocks[key];
      });
      const normalized = normalizeCompanionLink(incomingCompanion);
      companionLinkState.companion_serial_port = normalized.companion_serial_port;
      companionLinkState.companion_sr_bucket = normalized.companion_sr_bucket;
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
      renderArduParamForm();
      refreshEventsFromParams();
      updateParamSyncBanner();
    } catch {}
    e.target.value = '';
  });
}

try {
  const saved = JSON.parse(localStorage.getItem('visionLandingProfile') || 'null');
  const savedValues = saved?.values || saved;
  const savedLocks = saved?.locks || {};
  const savedCompanion = saved?.companionLink || saved || {};
  if (savedValues && typeof savedValues === 'object') {
    Object.keys(profileState).forEach((key) => {
      if (typeof savedValues[key] === 'number') profileState[key] = savedValues[key];
      if (typeof savedLocks[key] === 'boolean') lockState[key] = savedLocks[key];
    });
    const normalized = normalizeCompanionLink(savedCompanion);
    companionLinkState.companion_serial_port = normalized.companion_serial_port;
    companionLinkState.companion_sr_bucket = normalized.companion_sr_bucket;
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
  let icon = '→';
  if (ev.t < t - 0.5) { cls = 'past'; icon = '←'; }
  else if (Math.abs(ev.t - t) <= 0.5) { cls = 'current'; icon = '◆'; }
  return `
    <article class="event-item ${cls}" data-event-time="${ev.t}" data-event-key="${ev.key}">
      <div class="event-time">t+${ev.t}s · ${ev.type}</div>
      <div>${ev.msg}<span class="arrow">${icon}</span></div>
      <div class="event-time">פרמטר: ${ev.key} = ${val}</div>
    </article>
  `;
}

function refreshEventsFromParams() {
  if (!eventsList) return;
  const t = Number(timelineRange?.value || 0);
  const near = eventSamples.filter((ev) => ev.t >= t - 14 && ev.t <= t + 14);
  eventsList.innerHTML = near.length
    ? near.map(formatEventRow).join('')
    : '<div class="event-item">אין אירועים סביב הזמן הנוכחי.</div>';
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
const jetsonInstalledVersionEl = document.getElementById('jetsonInstalledVersion');
const jetsonTargetVersionSelect = document.getElementById('jetsonTargetVersionSelect');
const jetsonInstallBtn = document.getElementById('jetsonInstallBtn');

/** Why: release dropdown + diff text need the same catalog the server uses. What: filled by GET /api/jetson/releases. */
let jetsonReleasesCache = [];
/** Why: diff panel compares selected target to last known installed from SSE/REST. What: string version or empty before first status. */
let jetsonInstalledVersionCached = '';

/** Why: populate version picker from server catalog (synced with Aero-Lab list). What: builds options; preserves selection when possible. */
async function loadJetsonReleasesCatalog() {
  try {
    const res = await fetch('/api/jetson/releases');
    const data = await res.json();
    jetsonReleasesCache = Array.isArray(data.releases) ? data.releases : [];
    if (!jetsonTargetVersionSelect) return;
    const prev = jetsonTargetVersionSelect.value;
    jetsonTargetVersionSelect.innerHTML = jetsonReleasesCache
      .map((r) => `<option value="${r.version}">${r.version} (${r.channel})</option>`)
      .join('');
    const pick =
      (prev && jetsonReleasesCache.some((r) => r.version === prev) && prev) ||
      (jetsonInstalledVersionCached && jetsonReleasesCache.some((r) => r.version === jetsonInstalledVersionCached) && jetsonInstalledVersionCached) ||
      jetsonReleasesCache[0]?.version ||
      '';
    if (pick) jetsonTargetVersionSelect.value = pick;
    renderJetsonVersionNotes();
  } catch {
    if (document.getElementById('jetsonSelectedNotesHe')) {
      document.getElementById('jetsonSelectedNotesHe').textContent = 'לא ניתן לטעון את רשימת הגרסאות.';
    }
  }
}

/** Why: visual state for install lifecycle in the compact badge. What: maps installState to CSS class + short Hebrew label. */
function applyJetsonInstallStateBadge(state) {
  const badge = document.getElementById('jetsonInstallStateBadge');
  if (!badge) return;
  badge.className = 'jetson-install-badge';
  const cls = { idle: 'idle', installing: 'busy', success: 'ok', error: 'err' };
  badge.classList.add(cls[state] || 'idle');
  const labels = { idle: 'מוכן', installing: 'מתקין…', success: 'הצלחה', error: 'שגיאה' };
  badge.textContent = labels[state] || state || '';
}

/** Why: operator sees Hebrew release notes and a plain diff vs what the console thinks is installed. What: uses cached catalog + installedVersion. */
function renderJetsonVersionNotes() {
  const sel = jetsonTargetVersionSelect?.value || '';
  const rel = jetsonReleasesCache.find((r) => r.version === sel);
  const notesEl = document.getElementById('jetsonSelectedNotesHe');
  const diffEl = document.getElementById('jetsonDiffNotesHe');
  if (notesEl) notesEl.textContent = rel?.notesHe || '—';
  if (!diffEl) return;
  const inst = jetsonInstalledVersionCached;
  if (!rel) {
    diffEl.textContent = '—';
    return;
  }
  if (!inst) {
    diffEl.textContent = 'מחכים לגרסה מותקנת מהשרת (רענן או SSE).';
    return;
  }
  if (sel === inst) {
    diffEl.textContent = 'אין שינוי — הגרסה שנבחרה זהה לגרסה המסומנת כמותקנת במאגר המקומי.';
    return;
  }
  const prevRel = jetsonReleasesCache.find((r) => r.version === inst);
  diffEl.textContent = `מעבר מ־${inst} ל־${sel}. בגרסה היעד: ${rel.notesHe} · במה שרץ עכשיו: ${prevRel?.notesHe || 'אין תיאור במאגר לגרסה הנוכחית.'}`;
}

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
    if (jetsonOut) jetsonOut.textContent = `שגיאת חיבור לשרת: ${err?.message || err}`;
  }
}

/** Why: Stitch-style bars + value chips for CPU/RAM plus compact text for temp/heartbeat. What: updates progress bars with animated width transition. */
function applyJetsonUi(online, data) {
  if (jetsonStatusDot) jetsonStatusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  if (jetsonOnlineState) jetsonOnlineState.textContent = online ? 'מחובר' : 'לא מחובר';
  if (jetsonLastSeen && data.ageMs != null) {
    const sec = Math.round(data.ageMs / 1000);
    jetsonLastSeen.textContent = sec < 5 ? '< 5 שניות' : `${sec}s`;
  } else if (jetsonLastSeen) {
    jetsonLastSeen.textContent = 'אין heartbeat';
  }

  // CPU bar + value
  const cpuPct = data.cpuLoadPct != null ? Math.min(100, data.cpuLoadPct) : null;
  if (jetsonCpu) jetsonCpu.textContent = cpuPct != null ? `${cpuPct}%` : '—';
  const cpuBar = document.getElementById('jetsonCpuBar');
  if (cpuBar) {
    cpuBar.style.width = cpuPct != null ? `${cpuPct}%` : '0%';
    cpuBar.className = `jst-bar ${cpuPct != null && cpuPct > 85 ? 'jst-bar--warn' : 'jst-bar--primary'}`;
  }

  // RAM bar + value
  const memPct = data.memPct != null ? Math.min(100, data.memPct) : null;
  if (jetsonMem) jetsonMem.textContent = memPct != null ? `${memPct}%` : '—';
  const memBar = document.getElementById('jetsonMemBar');
  if (memBar) {
    memBar.style.width = memPct != null ? `${memPct}%` : '0%';
    memBar.className = `jst-bar ${memPct != null && memPct > 85 ? 'jst-bar--warn' : 'jst-bar--teal'}`;
  }

  // Mini cards
  if (jetsonTemp) jetsonTemp.textContent = data.tempC != null ? `${data.tempC}°C` : '—';
  const latEl = document.getElementById('heartbeatLatency');
  const qualEl = document.getElementById('linkQuality');
  if (latEl) latEl.textContent = data.ageMs != null ? `${Math.round(data.ageMs)}ms` : '-';
  if (qualEl) qualEl.textContent = data.linkQualityPct != null ? `${data.linkQualityPct}%` : '-';
  const latJ = document.getElementById('heartbeatLatencyJetson');
  const qualJ = document.getElementById('linkQualityJetson');
  if (latJ) latJ.textContent = data.ageMs != null ? `${Math.round(data.ageMs)}ms` : '—';
  if (qualJ) qualJ.textContent = data.linkQualityPct != null ? `${data.linkQualityPct}%` : '—';

  // Version management
  if (data.installedVersion != null) {
    jetsonInstalledVersionCached = String(data.installedVersion);
    if (jetsonInstalledVersionEl) jetsonInstalledVersionEl.textContent = data.installedVersion;
  }
  if (data.installState) applyJetsonInstallStateBadge(data.installState);
  const la = document.getElementById('jetsonInstallLastAction');
  if (la && data.lastAction) la.textContent = data.lastAction;
  renderJetsonVersionNotes();
  if (jetsonInstallBtn) jetsonInstallBtn.disabled = data.installState === 'installing';
}

if (jetsonRefreshBtn) jetsonRefreshBtn.addEventListener('click', refreshJetsonStatus);

const jetsonPullLogsBtn = document.getElementById('jetsonPullLogsBtn');
if (jetsonPullLogsBtn) {
  jetsonPullLogsBtn.addEventListener('click', async () => {
    jetsonPullLogsBtn.disabled = true;
    if (jetsonOut) jetsonOut.textContent = 'מושך לוגים מ-Jetson…';
    try {
      const res = await fetch('/api/jetson/pull-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'משיכת לוגים נכשלה');
      const n = data.imported ?? 0;
      if (jetsonOut) {
        jetsonOut.textContent = n
          ? `יובאו ${n} קבצים לטיסה #${data.flightId}`
          : (data.message || 'אין לוגים חדשים');
      }
      if (n > 0) document.querySelector('.tab[data-tab="flights"]')?.click();
    } catch (err) {
      if (jetsonOut) jetsonOut.textContent = err?.message || String(err);
    } finally {
      jetsonPullLogsBtn.disabled = false;
    }
  });
}

jetsonTargetVersionSelect?.addEventListener('change', () => {
  renderJetsonVersionNotes();
});

/** Why: trigger local/simulated or companion-backed bundle install from the telemetry tab. What: POST /api/jetson/install then refresh status. */
if (jetsonInstallBtn) {
  jetsonInstallBtn.addEventListener('click', async () => {
    const v = jetsonTargetVersionSelect?.value;
    if (!v) return;
    jetsonInstallBtn.disabled = true;
    try {
      const res = await fetch('/api/jetson/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'התקנה נכשלה');
      await refreshJetsonStatus();
      if (jetsonOut) jetsonOut.textContent = data.lastAction || 'התקנה הושלמה.';
    } catch (err) {
      if (jetsonOut) jetsonOut.textContent = err?.message || String(err);
      await refreshJetsonStatus();
    }
  });
}

(async () => {
  await refreshJetsonStatus();
  await loadJetsonReleasesCatalog();
})();

const visionLateralEl = document.getElementById('visionLateralOffset');
const visionHeadingEl = document.getElementById('visionHeadingError');
const visionConfEl = document.getElementById('visionConfidence');
const visionAgeEl = document.getElementById('visionFrameAge');
const visionCountEl = document.getElementById('visionFrameCount');
const terrainCam1StatusEl = document.getElementById('terrainCam1Status');
const terrainCam1FpsEl    = document.getElementById('terrainCam1Fps');
const terrainCam2StatusEl = document.getElementById('terrainCam2Status');
const terrainNavStatusEl  = document.getElementById('terrainNavStatus');

function applyVisionUi(d) {
  if (!d) return;
  const fresh = d.ageMs != null && d.ageMs < 3000;
  if (visionLateralEl) visionLateralEl.textContent = d.lateralOffsetM != null ? `${d.lateralOffsetM.toFixed(2)}m` : '-';
  if (visionHeadingEl) visionHeadingEl.textContent = d.headingErrorDeg != null ? `${d.headingErrorDeg.toFixed(1)}°` : '-';
  if (visionConfEl) visionConfEl.textContent = d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '-';
  if (visionAgeEl) visionAgeEl.textContent = d.ageMs != null ? (d.ageMs > 3000 ? `${(d.ageMs / 1000).toFixed(1)}s ⚠` : `${d.ageMs}ms`) : '-';
  if (visionCountEl) visionCountEl.textContent = String(d.frameCount || 0);
  // Mark cards as DEMO or LIVE based on freshness
  document.querySelectorAll('[data-vision-card]').forEach((el) => {
    el.classList.toggle('demo-data', !fresh);
    el.classList.toggle('live-data', fresh);
  });
}

function applySlamUi(d) {
  if (!d) return;
  const vioFresh  = d.ageMs != null && d.ageMs < 5000;
  const flowFresh = d.flowTimestamp ? (Date.now() - Date.parse(d.flowTimestamp)) < 5000 : false;

  if (terrainCam1StatusEl) terrainCam1StatusEl.textContent = vioFresh ? 'פעילה' : 'לא מחוברת';
  if (terrainCam1FpsEl)    terrainCam1FpsEl.textContent    = d.cam1Fps != null ? `${Number(d.cam1Fps).toFixed(0)} fps` : '--';
  if (terrainCam2StatusEl) terrainCam2StatusEl.textContent = flowFresh ? 'פעילה' : 'לא מחוברת';
  if (terrainNavStatusEl)  terrainNavStatusEl.textContent  = d.mapQuality != null ? `${Math.round(d.mapQuality * 100)}%` : '--';
}


/** Why: auto-load flights+logs when Jetson first comes online so operator doesn't need to navigate manually. What: tracks previous online state and triggers refresh on transition. */
let jetsonWasOnlinePrev = false;

/** Why: show a transient toast when auto-refresh fires. What: fills #autoLogsBanner for 4s. */
function showAutoLogsBanner(msg) {
  const el = document.getElementById('autoLogsBanner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

/** Why: Advisor tab — one row for Console vs FC vs Jetson “version” vs live ARM (from SSE mavlink + jetson). */
function updateAdvisorSysStrip(mavlink, jetson, appVersion) {
  if (appVersion) applyServerAppVersion(appVersion);
  const c = document.getElementById('advSysConsole');
  const fc = document.getElementById('advSysFc');
  const arm = document.getElementById('advSysArmed');
  const j = document.getElementById('advSysJetson');
  if (!c || !fc || !arm || !j) return;
  const meta = document.querySelector('meta[name="app-version"]');
  c.textContent = meta?.content ? `v${meta.content}` : '—';
  if (!mavlink) {
    fc.textContent = '—';
    arm.textContent = '—';
  } else {
    fc.textContent = mavlink.connected
      ? [mavlink.autopilotName || 'FC', mavlink.vehicleType].filter(Boolean).join(' · ')
      : 'לא מחובר';
    if (!mavlink.armedKnown) arm.textContent = 'לא ידוע';
    else if (mavlink.armed === true) arm.textContent = 'ARM';
    else if (mavlink.armed === false) arm.textContent = 'DISARM';
    else arm.textContent = '—';
  }
  const jv = jetson?.agentVersion || jetson?.installedVersion;
  if (jetson?.online) {
    j.textContent = jv ? `מקוון · ${jv}` : 'מקוון';
  } else if (jv) {
    j.textContent = `לא מקוון · ידוע מותקן: ${jv}`;
  } else {
    j.textContent = 'לא מקוון';
  }
  updateAdvInfoPeek();
}

/** ArduPlane flight mode names by custom_mode number — keep keys in sync with `lib/arduplane-flight-modes.mjs` (tlog replay). */
const ARDUPILOT_PLANE_MODES = {
  0:'MANUAL', 1:'CIRCLE', 2:'STABILIZE', 3:'TRAINING', 4:'ACRO',
  5:'FBWA', 6:'FBWB', 7:'CRUISE', 8:'AUTOTUNE', 10:'AUTO', 11:'RTL',
  12:'LOITER', 14:'LAND', 15:'GUIDED', 17:'QSTABILIZE', 18:'QHOVER',
  19:'QLOITER', 20:'QLAND', 21:'QRTL', 22:'THERMAL', 25:'TAKEOFF',
};
const hudAirspeedEl  = document.getElementById('hudAirspeed');
const hudAltitudeEl  = document.getElementById('hudAltitude');
const hudFlightModeEl = document.getElementById('hudFlightMode');

/** Groundspeed shown as IAS when FC pitot/VFR airspeed missing — not true IAS (ArduPlane stall margins differ with wind). */
const VLC_TOOLTIP_IAS_FROM_GS =
  'מהירות מוצגת כפרוקסי ממהירות קרקע — לא מד טיוח אוויר (IAS). בתנאי רוח גבית/ראשית ערך זה אינו מהימן לסטול.';
/** MAVLink attitude vs nav packets arrived far apart — horizon vs tapes may not match one FC instant. */
const VLC_TOOLTIP_HUD_TIME_SKEW =
  'פער זמן בין חבילות MAVLink — ייתכן עיוות זמני בין אופק לשאר מדי ה-HUD.';

// ── Flight HUD PFD elements ────────────────────────────────────────────────────
const horizonCanvas    = document.getElementById('horizonCanvas');
const pfdHorizonShell  = document.getElementById('pfdHorizonShell');
const pfdArmedBadge    = document.getElementById('pfdArmedBadge');
const pfdModeVal       = document.getElementById('pfdModeVal');
const pfdHdgVal        = document.getElementById('pfdHdgVal');
const pfdHdgArrow      = document.getElementById('pfdHdgArrow');
const pfdAirspeedVal   = document.getElementById('pfdAirspeedVal');
const pfdAltVal        = document.getElementById('pfdAltVal');
const pfdBattVal       = document.getElementById('pfdBattVal');
const hudNavGpsPill    = document.getElementById('hudNavGps');
const hudNavGpsVal     = document.getElementById('hudNavGpsVal');
const pfcMsgPrimaryHe  = document.getElementById('pfcMsgPrimaryHe');
const pfcMsgScroll     = document.getElementById('pfcMsgScroll');
const pfdOptMini       = document.getElementById('pfdOptMini');
const pfdVoiceFlightBtn = document.getElementById('pfdVoiceFlightBtn');
const pfdReadinessPopover = document.getElementById('pfdReadinessPopover');
const pfdReadinessBody = document.getElementById('pfdReadinessBody');
const pfdReadinessCloseBtn = document.getElementById('pfdReadinessCloseBtn');
// Kept as null — removed from HTML
const hudRollLabel = null;
const hudPitchLabel = null;
const hudHubAirspeed = null;
const hudHubAltitude = null;
const hudHubFlightMode = null;
const hudHubBatteryV = null;

/** PFD: ignore garbage angles (>360° magnitude); clamp to sane display range. Huge values make toFixed() print scientific notation. */
function finiteHudAngleDeg(val, clampAbs = 180) {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n) || Math.abs(n) > 360) return null;
  return Math.max(-clampAbs, Math.min(clampAbs, n));
}

function formatHudAngleLabel(deg) {
  if (deg == null || !Number.isFinite(deg)) return '0.0';
  const clipped = Math.max(-180, Math.min(180, deg));
  return clipped.toFixed(1);
}

// ── ResizeObserver: keep canvas pixel size = CSS size × devicePixelRatio ──────
if (horizonCanvas && pfdHorizonShell) {
  const _resizeCanvas = () => {
    const { width, height } = pfdHorizonShell.getBoundingClientRect();
    if (width > 10 && height > 10) {
      const dpr = window.devicePixelRatio || 1;
      horizonCanvas.width  = Math.round(width  * dpr);
      horizonCanvas.height = Math.round(height * dpr);
      horizonCanvas.style.width  = width  + 'px';
      horizonCanvas.style.height = height + 'px';
      drawHorizon(horizonCanvas, _lastRoll, _lastPitch, { videoMode: _horizonVideoMode });
    }
  };
  new ResizeObserver(_resizeCanvas).observe(pfdHorizonShell);
}

let _horizonVideoMode = false;
let _lastRoll = null;
let _lastPitch = null;

// ── Horizon video overlay wiring ───────────────────────────────────────────
(function initHorizonVideo() {
  const videoEl     = document.getElementById('horizonVideoEl');
  const toggleBtn   = document.getElementById('horizonVideoToggle');
  const panel       = document.getElementById('horizonVideoPanel');
  const urlInput    = document.getElementById('horizonVideoUrl');
  const applyBtn    = document.getElementById('horizonVideoApply');
  if (!toggleBtn || !panel || !videoEl) return;

  const LS_VIDEO_URL = 'vlc.horizon.videoUrl';
  const LS_VIDEO_ON  = 'vlc.horizon.videoOn';

  // Restore saved URL
  const savedUrl = localStorage.getItem(LS_VIDEO_URL) || '';
  if (urlInput && savedUrl) urlInput.value = savedUrl;

  function setVideoActive(active, url) {
    _horizonVideoMode = active;
    toggleBtn.classList.toggle('active', active);
    pfdHorizonShell?.classList.toggle('pfd-horizon-shell--video-active', active);
    if (active && url) {
      videoEl.src = url;
      videoEl.classList.remove('hidden');
      videoEl.play().catch(() => {});
    } else {
      videoEl.src = '';
      videoEl.classList.add('hidden');
    }
    // Redraw horizon with updated videoMode flag
    drawHorizon(horizonCanvas, _lastRoll, _lastPitch, { videoMode: active });
    try { localStorage.setItem(LS_VIDEO_ON, active ? '1' : '0'); } catch {}
  }

  function applyVideoUrl() {
    const url = urlInput?.value.trim() || '';
    if (!url) return;
    try { localStorage.setItem(LS_VIDEO_URL, url); } catch {}
    panel.classList.add('hidden');
    setVideoActive(true, url);
  }

  toggleBtn.addEventListener('click', () => {
    if (_horizonVideoMode) {
      setVideoActive(false, '');
      panel.classList.add('hidden');
    } else {
      panel.classList.toggle('hidden');
    }
  });

  if (applyBtn) applyBtn.addEventListener('click', applyVideoUrl);
  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyVideoUrl(); }
    });
  }

  // Restore previous session state
  if (savedUrl && localStorage.getItem(LS_VIDEO_ON) === '1') {
    setVideoActive(true, savedUrl);
  }
})();
/** @type {object | null} snapshot from last SSE — readiness popover */
let latestHudMavlink = null;
let _statustextSig = '';
let _statustextTimer = null;

// ── Unified HUD data-grid ──────────────────────────────────────────────────
const HUD_SLOTS_KEY_V2  = 'vlc_hud_slots_v2';
const HUD_SLOT_COLORS   = ['#22d3ee','#4ade80','#facc15','#fb923c','#f87171','#c084fc','#60a5fa','#2dd4bf'];
const DEFAULT_HUD_SLOTS = [
  { key: 'vision.confidence',   label: 'Vision',   unit: '%'   },
  { key: 'mavlink.groundspeed', label: 'GS',        unit: 'm/s' },
];

function loadHudSlots() {
  try { const r = localStorage.getItem(HUD_SLOTS_KEY_V2); if (r) return JSON.parse(r); } catch {}
  return DEFAULT_HUD_SLOTS.map((s) => ({ ...s }));
}
function saveHudSlots(slots) {
  try { localStorage.setItem(HUD_SLOTS_KEY_V2, JSON.stringify(slots)); } catch {}
}

let _hudSlots = loadHudSlots();

const hudDataGrid   = document.getElementById('hudDataGrid');
const hudCtxMenu    = document.getElementById('hudCtxMenu');
const hudCtxEditBtn = document.getElementById('hudCtxEdit');
const hudCtxDelBtn  = document.getElementById('hudCtxDelete');
const hudAddSlotBtn = document.getElementById('hudAddSlotBtn');

let _hudCtxSlotIdx = -1;

function calcGridCols(n) {
  if (n <= 2) return 'repeat(2, 1fr)';
  if (n <= 4) return 'repeat(2, 1fr)';
  if (n <= 6) return 'repeat(3, 1fr)';
  return 'repeat(auto-fill, minmax(88px, 1fr))';
}

function renderHudGrid() {
  if (!hudDataGrid) return;
  hudDataGrid.innerHTML = '';
  _hudSlots.forEach((slot, idx) => {
    const color = HUD_SLOT_COLORS[idx % HUD_SLOT_COLORS.length];
    const div = document.createElement('div');
    div.className   = 'hud-slot';
    div.dataset.slotIdx = String(idx);
    div.style.setProperty('--sc', color);
    div.tabIndex    = 0;
    div.title       = 'קליק ימני לעריכה / מחיקה';
    const lbl = slot.label.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const unt = slot.unit ? '<span class="hud-slot-unit">' + slot.unit.replace(/</g,'&lt;') + '</span>' : '';
    div.innerHTML = '<span class="hud-slot-label">' + lbl + '</span>' +
      '<strong class="hud-slot-val" id="hudSlotVal' + idx + '">--</strong>' + unt;
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showHudCtxMenu(idx, e.clientX, e.clientY);
    });
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const r = div.getBoundingClientRect();
        showHudCtxMenu(idx, r.left, r.bottom);
      }
    });
    hudDataGrid.appendChild(div);
  });
  hudDataGrid.style.gridTemplateColumns = calcGridCols(_hudSlots.length);
}

function applyHudGrid(payload) {
  if (!payload) return;
  _hudSlots.forEach((slot, idx) => {
    const valEl = document.getElementById('hudSlotVal' + idx);
    if (!valEl) return;
    const raw = getPayloadValue(payload, slot.key);
    if (raw == null) { valEl.textContent = '--'; return; }
    if (typeof raw === 'number' && !Number.isFinite(raw)) { valEl.textContent = '--'; return; }
    if (slot.key === 'mavlink.flightMode') {
      valEl.textContent = ARDUPILOT_PLANE_MODES[raw] ?? (raw != null ? '#' + raw : '--');
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) { valEl.textContent = '--'; return; }
      const a = Math.abs(raw);
      if (a > 1e6 || (a > 0 && a < 1e-9)) { valEl.textContent = '--'; return; }
      const dec = Number.isInteger(raw) ? 0 : (a < 10 ? 2 : 1);
      valEl.textContent = raw.toFixed(dec) + (slot.unit ? ' ' + slot.unit : '');
    } else {
      valEl.textContent = String(raw) + (slot.unit ? ' ' + slot.unit : '');
    }
  });
}

function showHudCtxMenu(slotIdx, x, y) {
  _hudCtxSlotIdx = slotIdx;
  if (!hudCtxMenu) return;
  hudCtxMenu.classList.remove('hidden');
  const W = window.innerWidth, H = window.innerHeight;
  hudCtxMenu.style.left = Math.min(x, W - 200) + 'px';
  hudCtxMenu.style.top  = Math.min(y, H - 100) + 'px';
  hudCtxEditBtn?.focus();
}

function closeHudCtxMenu() {
  hudCtxMenu?.classList.add('hidden');
  _hudCtxSlotIdx = -1;
}

hudCtxEditBtn?.addEventListener('click', () => {
  const idx = _hudCtxSlotIdx;
  closeHudCtxMenu();
  _hudActiveSlotIdx = idx;
  if (hudParamInput)  hudParamInput.value = (_hudSlots[idx]?.label ?? '');
  if (hudParamStatus) { hudParamStatus.textContent = ''; hudParamStatus.className = 'hud-param-overlay-status'; }
  if (hudParamHint) { hudParamHint.hidden = true; hudParamHint.textContent = ''; }
  if (hudParamOptions) { hudParamOptions.hidden = true; hudParamOptions.innerHTML = ''; }
  if (hudParamOverlay) hudParamOverlay.hidden = false;
  setTimeout(() => hudParamInput?.focus(), 50);
});

hudCtxDelBtn?.addEventListener('click', () => {
  if (_hudCtxSlotIdx < 0) return;
  _hudSlots.splice(_hudCtxSlotIdx, 1);
  saveHudSlots(_hudSlots);
  renderHudGrid();
  closeHudCtxMenu();
});

document.addEventListener('click', (e) => {
  if (hudCtxMenu && !hudCtxMenu.classList.contains('hidden') && !hudCtxMenu.contains(e.target)) closeHudCtxMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHudCtxMenu(); });

hudAddSlotBtn?.addEventListener('click', () => {
  _hudActiveSlotIdx = _hudSlots.length;
  if (hudParamInput)  hudParamInput.value = '';
  if (hudParamStatus) { hudParamStatus.textContent = ''; hudParamStatus.className = 'hud-param-overlay-status'; }
  if (hudParamHint) { hudParamHint.hidden = true; hudParamHint.textContent = ''; }
  if (hudParamOptions) { hudParamOptions.hidden = true; hudParamOptions.innerHTML = ''; }
  if (hudParamOverlay) hudParamOverlay.hidden = false;
  setTimeout(() => hudParamInput?.focus(), 50);
});

/**
 * Premium artificial horizon — fills full square, sharp vector PFD style,
 * HiDPI-aware, optional video-overlay mode (semi-transparent sky/ground).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number|null} rollDeg
 * @param {number|null} pitchDeg
 * @param {{ videoMode?: boolean }} [opts]
 */
function drawHorizon(canvas, rollDeg, pitchDeg, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  // Always re-apply HiDPI transform so call-sites don't need to worry about it
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Pixel-sharp rendering
  ctx.imageSmoothingEnabled = false;
  // Work in CSS pixel space (canvas.width is physical px = CSS px × dpr)
  const W   = canvas.width / dpr;
  const H   = canvas.height / dpr;
  const cx  = W / 2;
  const cy  = H / 2;
  const videoMode = !!opts.videoMode;

  const rollBounded  = finiteHudAngleDeg(rollDeg, 180);
  const pitchBounded = finiteHudAngleDeg(pitchDeg, 90);
  const showRoll  = rollBounded != null;
  const showPitch = pitchBounded != null;
  const rollDraw  = showRoll ? rollBounded : 0;
  const pitchDraw = showPitch ? pitchBounded : 0;
  const rollRad  = (rollDraw * Math.PI) / 180;
  const pxPerDeg = H / 40;
  const pitchPx  = Math.max(-H, Math.min(H, pitchDraw * pxPerDeg));
  const diag     = Math.sqrt(W * W + H * H);

  ctx.clearRect(0, 0, W, H);

  // ── 1. Sky + Ground (full square, rotated) ──────────────────────────────
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rollRad);

  const skyAlpha = videoMode ? 0.62 : 1;
  const gndAlpha = videoMode ? 0.58 : 1;

  const skyGrad = ctx.createLinearGradient(0, -diag * 0.5 + pitchPx, 0, pitchPx);
  skyGrad.addColorStop(0,    `rgba(2,14,34,${skyAlpha})`);
  skyGrad.addColorStop(0.5,  `rgba(11,58,114,${skyAlpha})`);
  skyGrad.addColorStop(1,    `rgba(21,96,184,${skyAlpha})`);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(-diag, -diag + pitchPx, diag * 2, diag);

  const gndGrad = ctx.createLinearGradient(0, pitchPx, 0, pitchPx + diag * 0.6);
  gndGrad.addColorStop(0,   `rgba(107,63,26,${gndAlpha})`);
  gndGrad.addColorStop(0.45,`rgba(66,38,14,${gndAlpha})`);
  gndGrad.addColorStop(1,   `rgba(30,16,8,${gndAlpha})`);
  ctx.fillStyle = gndGrad;
  ctx.fillRect(-diag, pitchPx, diag * 2, diag);

  // ── 2. Horizon line ────────────────────────────────────────────────────
  const hlLen = diag;
  const horizPx = Math.round(pitchPx) + 0.5; // snap to pixel boundary for crispness
  ctx.shadowColor = 'rgba(160,230,255,0.9)';
  ctx.shadowBlur  = videoMode ? 3 : 5;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth   = videoMode ? 1.5 : 2.5;
  ctx.beginPath(); ctx.moveTo(-hlLen, horizPx); ctx.lineTo(hlLen, horizPx); ctx.stroke();
  ctx.shadowBlur  = 0;

  // ── 3. Pitch ladder ────────────────────────────────────────────────────
  ctx.font    = `600 ${H * 0.055}px "Space Grotesk", monospace`;
  ctx.lineCap = 'round';
  for (let p = -40; p <= 40; p += 5) {
    if (p === 0) continue;
    const y   = pitchPx - p * pxPerDeg;
    if (Math.abs(y) > H * 0.6) continue;
    const big = p % 10 === 0;
    const hw  = big ? W * 0.22 : W * 0.12;
    const alpha = videoMode ? (big ? 0.9 : 0.55) : (big ? 1 : 0.55);
    const ySnap = Math.round(y) + 0.5;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth   = big ? (videoMode ? 1.5 : 2) : 1;
    ctx.beginPath(); ctx.moveTo(-hw, ySnap); ctx.lineTo(hw, ySnap); ctx.stroke();
    if (big) {
      const tk = H * 0.025;
      ctx.beginPath();
      ctx.moveTo(-hw, y); ctx.lineTo(-hw, y + (p > 0 ? tk : -tk));
      ctx.moveTo( hw, y); ctx.lineTo( hw, y + (p > 0 ? tk : -tk));
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${videoMode ? 0.9 : 1})`;
      ctx.textAlign = 'right'; ctx.fillText(String(Math.abs(p)), -hw - 4, y + H * 0.02);
      ctx.textAlign = 'left';  ctx.fillText(String(Math.abs(p)),  hw + 4, y + H * 0.02);
    }
  }
  ctx.lineCap = 'butt';
  ctx.restore();

  // ── 4. Bank arc + ticks (fixed, over the square) ──────────────────────
  const arcR = Math.min(cx, cy) * 0.82;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth   = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, arcR, -Math.PI * 0.78, -Math.PI * 0.22);
  ctx.stroke();

  [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].forEach((deg) => {
    const a   = (-90 + deg) * Math.PI / 180;
    const big = Math.abs(deg) % 30 === 0;
    const tL  = big ? 9 : 5;
    ctx.strokeStyle = big ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.32)';
    ctx.lineWidth   = big ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * arcR,        cy + Math.sin(a) * arcR);
    ctx.lineTo(cx + Math.cos(a) * (arcR - tL),  cy + Math.sin(a) * (arcR - tL));
    ctx.stroke();
  });

  // Bank pointer triangle (rotates with roll)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rollRad);
  ctx.shadowColor = 'rgba(250,204,21,0.7)';
  ctx.shadowBlur  = 5;
  ctx.fillStyle   = '#facc15';
  ctx.beginPath();
  ctx.moveTo(0, -arcR + 1);
  ctx.lineTo(-5, -arcR + 13);
  ctx.lineTo( 5, -arcR + 13);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();

  // ── 5. Aircraft T-bar symbol ───────────────────────────────────────────
  const aW = W * 0.19;
  const aG = W * 0.05;
  const aY = cy;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(250,204,21,0.8)';
  ctx.shadowBlur  = 9;
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth   = 2.6;
  ctx.beginPath(); ctx.moveTo(cx - aG, aY); ctx.lineTo(cx - aW, aY + H * 0.02); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + aG, aY); ctx.lineTo(cx + aW, aY + H * 0.02); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, aY); ctx.lineTo(cx, aY - H * 0.065); ctx.stroke();
  ctx.shadowBlur = 10;
  ctx.fillStyle  = '#facc15';
  ctx.beginPath(); ctx.arc(cx, aY, 3, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineCap = 'butt'; ctx.lineJoin = 'butt';

  // ── 6. Corner readouts (R / P) ─────────────────────────────────────────
  ctx.font      = `700 ${Math.min(W, H) * 0.055}px "Space Grotesk", monospace`;
  ctx.fillStyle = showRoll && rollDraw === 0 ? 'rgba(180,210,255,0.5)' : '#facc15';
  ctx.textAlign = 'left';
  ctx.fillText(showRoll ? `R${rollDraw >= 0 ? '+' : ''}${formatHudAngleLabel(rollDraw)}°` : 'R --', 5, H - 5);
  ctx.fillStyle = showPitch && pitchDraw === 0 ? 'rgba(180,210,255,0.5)' : '#4ade80';
  ctx.textAlign = 'right';
  ctx.fillText(showPitch ? `P${pitchDraw >= 0 ? '+' : ''}${formatHudAngleLabel(pitchDraw)}°` : 'P --', W - 5, H - 5);
}
const GPS_FIX_LABELS = ['אין GPS', 'אין Fix', '2D Fix', '3D Fix', 'DGPS', 'RTK Float', 'RTK Fixed'];

/** Update the PFD with the latest MAVLink snapshot. */
function applyFlightHud(mav) {
  if (!mav) return;
  latestHudMavlink = mav;

  // Horizon canvas — level when angles unknown or out-of-range garbage
  const r = finiteHudAngleDeg(mav.rollDeg, 180);
  const p = finiteHudAngleDeg(mav.pitchDeg, 90);
  _lastRoll = r;
  _lastPitch = p;
  drawHorizon(horizonCanvas, r, p, { videoMode: _horizonVideoMode });

  // Armed / mode (top bar)
  const armed = !!mav.armed;
  if (pfdArmedBadge) {
    if (!mav.connected) {
      pfdArmedBadge.textContent = 'ללא FC';
      pfdArmedBadge.className   = 'pfd-badge pfd-badge--unknown';
      pfdArmedBadge.title       = 'אין חיבור MAVLink — לחץ לפרטים';
    } else if (!mav.armedKnown) {
      pfdArmedBadge.textContent = 'ARM ?';
      pfdArmedBadge.className   = 'pfd-badge pfd-badge--unknown';
      pfdArmedBadge.title       = 'לא התקבל מידע ARM מלא — לחץ לפרטים';
    } else {
      pfdArmedBadge.textContent = armed ? 'ARMED' : 'DISARMED';
      pfdArmedBadge.className   = 'pfd-badge ' + (armed ? 'pfd-badge--armed' : 'pfd-badge--disarmed');
      pfdArmedBadge.title       = armed ? 'במצב ARM — לחץ להסבר מוכנות' : 'DISARMED — לחץ לבדיקת מוכנות / הודעות';
    }
  }
  if (pfdModeVal) {
    pfdModeVal.textContent = ARDUPILOT_PLANE_MODES[mav.flightMode] ?? (mav.connected ? `#${mav.flightMode ?? '--'}` : '--');
  }

  // Heading (top bar)
  if (pfdHdgVal && pfdHdgArrow) {
    const hdg = mav.heading;
    if (typeof hdg === 'number' && Number.isFinite(hdg)) {
      const hdgNorm = ((hdg % 360) + 360) % 360;
      pfdHdgVal.textContent = `${Math.round(hdgNorm)}°`;
      pfdHdgArrow.style.transform = `rotate(${hdgNorm}deg)`;
    } else {
      pfdHdgVal.textContent = '---°';
      pfdHdgArrow.style.transform = 'rotate(0deg)';
    }
  }

  // Side tapes
  const airTape = pfdAirspeedVal?.closest('.pfd-side-tape');
  if (airTape) {
    airTape.classList.toggle('pfd-side-tape--airspeed-proxy', !!mav.airspeedIsGroundspeedProxy);
    airTape.title = mav.airspeedIsGroundspeedProxy ? VLC_TOOLTIP_IAS_FROM_GS : '';
  }
  if (pfdHorizonShell) {
    pfdHorizonShell.classList.toggle('pfd-horizon-shell--time-skew', !!mav.hudTimeSkewWarn);
    pfdHorizonShell.title = mav.hudTimeSkewWarn ? VLC_TOOLTIP_HUD_TIME_SKEW : '';
  }
  if (pfdAirspeedVal) {
    const as = mav.airspeed;
    pfdAirspeedVal.textContent = typeof as === 'number' && Number.isFinite(as) ? as.toFixed(1) : '--';
  }
  if (pfdAltVal) {
    const al = mav.altitude;
    pfdAltVal.textContent = typeof al === 'number' && Number.isFinite(al) ? al.toFixed(1) : '--';
    pfdAltVal.title = mav.hudTimeSkewWarn ? VLC_TOOLTIP_HUD_TIME_SKEW : '';
  }

  // Battery (bottom bar)
  if (pfdBattVal) {
    const bv = mav.batteryV;
    const bvOk = typeof bv === 'number' && Number.isFinite(bv);
    pfdBattVal.textContent = bvOk ? `${bv.toFixed(1)} V` : '-- V';
    pfdBattVal.style.color = !bvOk ? '' : bv < 10.5 ? '#f87171'
      : bv < 11.5 ? '#facc15' : '#4ade80';
  }

  // GPS pill (top bar)
  if (hudNavGpsPill && hudNavGpsVal) {
    const fix  = mav.gpsFixType;
    const sats = mav.gpsSats;
    const fixLabel = typeof fix === 'number' && Number.isFinite(fix) ? (GPS_FIX_LABELS[fix] ?? `Fix ${fix}`) : '--';
    const satsStr  = typeof sats === 'number' && Number.isFinite(sats) ? ` ${sats}🛰` : '';
    hudNavGpsVal.textContent = fixLabel + satsStr;
    hudNavGpsPill.dataset.status = !mav.connected ? 'unknown'
      : typeof fix !== 'number' || !Number.isFinite(fix) ? 'unknown'
      : fix >= 3 ? 'ok'
      : fix === 2 ? 'warn'
      : 'fail';
  }
}

/** Update the optical-nav indicator (compact strip near FC messages). */
function applyNavOpticalStatus(vision) {
  if (!pfdOptMini) return;
  const ageMs = vision?.ageMs;
  const conf  = vision?.confidence;
  const active = typeof ageMs === 'number' && ageMs < 3000;
  if (!active) {
    pfdOptMini.textContent = '👁 לא פעיל';
    pfdOptMini.title = 'Vision — אין נתוני פריים אחרונים';
    return;
  }
  const pct = typeof conf === 'number' ? `${Math.round(conf * 100)}%` : '';
  pfdOptMini.textContent = pct ? `👁 ${pct}` : '👁 פעיל';
  pfdOptMini.title = pct
    ? `Vision פעיל — ביטחון ${pct}`
    : 'Vision פעיל';
}

function applyFcStatustextHud(mavlink) {
  if (!pfcMsgPrimaryHe) return;
  if (!mavlink?.connected) {
    pfcMsgPrimaryHe.textContent = 'אין חיבור לבקר — לא מתקבלות הודעות MAVLink.';
    if (pfcMsgScroll) pfcMsgScroll.innerHTML = '';
    _statustextSig = '';
    return;
  }
  const raw = Array.isArray(mavlink.recentStatusTexts) ? mavlink.recentStatusTexts : [];
  if (!raw.length) {
    pfcMsgPrimaryHe.textContent = 'אין הודעות STATUSTEXT אחרונות — ריק מהבקר.';
    if (pfcMsgScroll) pfcMsgScroll.innerHTML = '';
    _statustextSig = '';
    return;
  }
  const sig = JSON.stringify(raw.slice(0, 18));
  if (sig === _statustextSig) return;
  _statustextSig = sig;
  clearTimeout(_statustextTimer);
  _statustextTimer = setTimeout(() => void translateAndRenderFcStatustext(raw.slice(0, 18)), 400);
}

async function translateAndRenderFcStatustext(rows) {
  const texts = rows.map((r) => String(r?.text ?? '').trim().slice(0, 220));
  if (!texts.some(Boolean)) return;
  try {
    const resp = await fetch('/api/mavlink/statustext-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
    });
    const d = await resp.json();
    const he = Array.isArray(d.he) ? d.he : texts;
    if (pfcMsgPrimaryHe && (he[0] || texts[0])) pfcMsgPrimaryHe.textContent = he[0] || texts[0] || '';
    if (!pfcMsgScroll) return;
    pfcMsgScroll.innerHTML = '';
    for (let i = 1; i < Math.min(rows.length, 8); i += 1) {
      const line = String(he[i] ?? texts[i] ?? rows[i]?.text ?? '').trim();
      if (!line) continue;
      const p = document.createElement('p');
      const sev = rows[i]?.severity;
      p.className = 'pfc-msg-line' + (typeof sev === 'number' && sev <= 4 ? ' pfc-msg-line--warn' : '');
      p.textContent = line;
      pfcMsgScroll.appendChild(p);
    }
  } catch {
    if (pfcMsgPrimaryHe) pfcMsgPrimaryHe.textContent = texts[0] || '';
  }
}

function positionPfdReadinessPopover() {
  if (!pfdReadinessPopover || !pfdArmedBadge || pfdReadinessPopover.classList.contains('hidden')) return;
  const r = pfdArmedBadge.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  pfdReadinessPopover.style.width = `${w}px`;
  pfdReadinessPopover.style.left = `${left}px`;
  pfdReadinessPopover.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`;
}

function buildReadinessListHtml(m) {
  if (!pfdReadinessBody) return;
  pfdReadinessBody.innerHTML = '';
  const ul = document.createElement('ul');
  function addLi(text) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  }
  if (!m || !m.connected) {
    addLi('אין חיבור לבקר הטיסה — התחבר בווידג׳ט MAVLink למעלה.');
  } else {
    if (m.armedKnown === false || m.armedKnown == null) {
      addLi('לא התקבל heartbeat עם מצב ARM ברור — בדוק קישור ו-sys/comp.');
    } else if (m.armed === true) {
      addLi('המטוס במצב ARM — מנוע/מדחף פעילים לפי היחידה.');
    } else {
      addLi('DISARM — כבוי להפעלה; ארמה מותנית במצבים תקינים (GPS/פרה‑ארם וכו׳).');
    }
    const fix = m.gpsFixType;
    if (typeof fix === 'number') {
      addLi(fix >= 3 ? `GPS: תיקון מספיק לרוב המצבים (${fix}).` : `GPS: תיקון חלש (${fix}) — עשוי לחסום ARM או ניווט.`);
    } else addLi('GPS: לא התקבל עדיין ערך תיקון.');

    if (typeof m.batteryV === 'number') {
      addLi(`סוללה: ${m.batteryV.toFixed(1)} V${m.batteryPct != null ? ` — ${m.batteryPct}%` : ''}.`);
    }
    const rsts = Array.isArray(m.recentStatusTexts) ? m.recentStatusTexts : [];
    const critical = rsts.filter((x) => typeof x.severity === 'number' && x.severity <= 4 && String(x.text || '').trim());
    if (critical.length) {
      addLi('הודעות אחרונות מהבקר:');
      critical.slice(0, 5).forEach((c) => {
        addLi(`[${c.severity}] ${c.text}`);
      });
    }
  }
  pfdReadinessBody.appendChild(ul);
}

function openPfdReadinessPopover() {
  if (!pfdReadinessPopover) return;
  buildReadinessListHtml(latestHudMavlink);
  pfdReadinessPopover.classList.remove('hidden');
  positionPfdReadinessPopover();
}

function closePfdReadinessPopover() {
  pfdReadinessPopover?.classList.add('hidden');
}

function setupFlightHudChromeHandlers() {
  pfdVoiceFlightBtn?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab="flightEngineer"]')?.click();
    setTimeout(() => document.getElementById('feMicBtn')?.click(), 220);
  });
  function toggleArmPopover(e) {
    e.preventDefault();
    if (pfdReadinessPopover?.classList.contains('hidden')) openPfdReadinessPopover();
    else closePfdReadinessPopover();
  }
  pfdArmedBadge?.addEventListener('click', toggleArmPopover);
  pfdArmedBadge?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') toggleArmPopover(e);
  });
  pfdReadinessCloseBtn?.addEventListener('click', () => closePfdReadinessPopover());
  document.addEventListener('click', (e) => {
    if (!pfdReadinessPopover || pfdReadinessPopover.classList.contains('hidden')) return;
    if (pfdArmedBadge?.contains(e.target)) return;
    if (pfdReadinessPopover.contains(e.target)) return;
    closePfdReadinessPopover();
  });
  window.addEventListener('resize', () => positionPfdReadinessPopover());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePfdReadinessPopover();
  });
}
setupFlightHudChromeHandlers();

/** Retrieve a value from a nested payload object by dot-path, e.g. "mavlink.airspeed". */
function getPayloadValue(payload, key) {
  if (!key) return undefined;
  const parts = key.split('.');
  let cur = payload;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Legacy shim -- now handled by applyHudGrid. */
function applyHudCustomSlots(payload) { applyHudGrid(payload); }

// Initial render
renderHudGrid();

// ── Custom-param resolve overlay logic ────────────────────────────────────────
const hudParamOverlay     = document.getElementById('hudParamOverlay');
const hudParamInput       = document.getElementById('hudParamInput');
const hudParamStatus      = document.getElementById('hudParamStatus');
const hudParamHint        = document.getElementById('hudParamHint');
const hudParamOptions     = document.getElementById('hudParamOptions');
const hudParamConfirmBtn  = document.getElementById('hudParamConfirmBtn');
const hudParamCancelBtn   = document.getElementById('hudParamCancelBtn');
let   _hudActiveSlotIdx   = -1;

function clearHudAmbiguousUI() {
  if (hudParamHint) { hudParamHint.hidden = true; hudParamHint.textContent = ''; }
  if (hudParamOptions) { hudParamOptions.hidden = true; hudParamOptions.innerHTML = ''; }
}

function openHudParamOverlay(slotIdx) {
  _hudActiveSlotIdx = slotIdx;
  clearHudAmbiguousUI();
  if (hudParamInput)  hudParamInput.value = '';
  if (hudParamStatus) { hudParamStatus.textContent = ''; hudParamStatus.className = 'hud-param-overlay-status'; }
  if (hudParamOverlay) hudParamOverlay.hidden = false;
  setTimeout(() => hudParamInput?.focus(), 50);
}

function closeHudParamOverlay() {
  if (hudParamOverlay) hudParamOverlay.hidden = true;
  _hudActiveSlotIdx = -1;
  clearHudAmbiguousUI();
}

function applyHudResolvedSlot(slotCfg) {
  if (_hudActiveSlotIdx >= _hudSlots.length) { _hudSlots.push(slotCfg); }
  else { _hudSlots[_hudActiveSlotIdx] = slotCfg; }
  saveHudSlots(_hudSlots);
  renderHudGrid();
}

function showHudParamAmbiguous(hint, options) {
  if (hudParamStatus) { hudParamStatus.textContent = ''; hudParamStatus.className = 'hud-param-overlay-status'; }
  if (hudParamHint) {
    hudParamHint.textContent = 'לא זיהינו במדויק — בחר מהרשימה, או נסח מחדש בשדה למעלה:';
    hudParamHint.hidden = false;
  }
  if (!hudParamOptions) return;
  hudParamOptions.innerHTML = '';
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-param-option-btn';
    const u = opt.unit ? ` — ${opt.unit}` : '';
    b.textContent = `${opt.label}${u}`;
    b.addEventListener('click', () => {
      applyHudResolvedSlot({ key: opt.key, label: opt.label, unit: opt.unit ?? '' });
      if (hudParamStatus) { hudParamStatus.textContent = `✓ ${opt.label}`; hudParamStatus.className = 'hud-param-overlay-status ok'; }
      setTimeout(closeHudParamOverlay, 600);
    });
    hudParamOptions.appendChild(b);
  }
  hudParamOptions.hidden = false;
}

async function confirmHudParamResolve() {
  const text = hudParamInput?.value.trim();
  if (!text) return;
  if (hudParamStatus) { hudParamStatus.textContent = 'מזהה…'; hudParamStatus.className = 'hud-param-overlay-status'; }
  clearHudAmbiguousUI();
  if (hudParamConfirmBtn) hudParamConfirmBtn.disabled = true;
  const slot = _hudActiveSlotIdx >= 0 ? document.getElementById(`hudCustomSlot${_hudActiveSlotIdx}`) : null;
  if (slot) slot.classList.add('hud-resolving');
  try {
    const resp = await fetch('/api/flight-hud/resolve-param', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!resp.ok && resp.headers.get('content-type')?.includes('text/html')) {
      throw new Error(`שרת החזיר שגיאה ${resp.status}`);
    }
    const data = await resp.json();
    if (data.ok) {
      const slotCfg = { key: data.key, label: data.label, unit: data.unit ?? '' };
      applyHudResolvedSlot(slotCfg);
      if (hudParamStatus) { hudParamStatus.textContent = `✓ ${data.label}`; hudParamStatus.className = 'hud-param-overlay-status ok'; }
      setTimeout(closeHudParamOverlay, 800);
    } else if (data.ambiguous && Array.isArray(data.options) && data.options.length) {
      showHudParamAmbiguous(data.hint, data.options);
    } else {
      if (hudParamStatus) { hudParamStatus.textContent = data.message || 'שגיאה בזיהוי'; hudParamStatus.className = 'hud-param-overlay-status'; }
    }
  } catch (err) {
    if (hudParamStatus) {
      hudParamStatus.textContent = err?.message?.startsWith('שרת') ? err.message : 'שגיאת חיבור — ודא שהשרת פועל';
      hudParamStatus.className = 'hud-param-overlay-status';
    }
  } finally {
    if (hudParamConfirmBtn) hudParamConfirmBtn.disabled = false;
    if (slot) slot.classList.remove('hud-resolving');
  }
}

hudParamConfirmBtn?.addEventListener('click', confirmHudParamResolve);
hudParamCancelBtn?.addEventListener('click', closeHudParamOverlay);
hudParamInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmHudParamResolve(); } });
hudParamOverlay?.addEventListener('click', (e) => { if (e.target === hudParamOverlay) closeHudParamOverlay(); });

// "Show all" — fetch full catalog and display all as options
document.getElementById('hudParamShowAll')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/flight-hud/catalog');
    const data = await res.json();
    const catalog = Array.isArray(data.catalog) ? data.catalog : [];
    if (catalog.length) {
      if (hudParamHint) { hudParamHint.textContent = 'כל הפרמטרים הזמינים:'; hudParamHint.hidden = false; }
      if (hudParamOptions) {
        hudParamOptions.innerHTML = '';
        for (const opt of catalog) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'hud-param-option-btn';
          b.textContent = `${opt.label}${opt.unit ? ` — ${opt.unit}` : ''}`;
          b.addEventListener('click', () => {
            applyHudResolvedSlot({ key: opt.key, label: opt.label, unit: opt.unit ?? '' });
            if (hudParamStatus) { hudParamStatus.textContent = `✓ ${opt.label}`; hudParamStatus.className = 'hud-param-overlay-status ok'; }
            setTimeout(closeHudParamOverlay, 600);
          });
          hudParamOptions.appendChild(b);
        }
        hudParamOptions.hidden = false;
      }
    }
  } catch {}
});

// Initial horizon draw — defer so ResizeObserver fires first
requestAnimationFrame(() => drawHorizon(horizonCanvas, 0, 0));

// ── Map fly-to context menu ────────────────────────────────────────────────────
const mapFlyToMenu    = document.getElementById('mapFlyToMenu');
const mapFlyToBtn     = document.getElementById('mapFlyToBtn');
const mapFlyToCoords  = document.getElementById('mapFlyToCoords');
const mapFlyToAlt     = document.getElementById('mapFlyToAlt');
const mapFlyToStatus  = document.getElementById('mapFlyToStatus');
let   _flyToTarget    = null; // { lat, lng }

function showMapFlyToMenu(lat, lng, clientX, clientY) {
  _flyToTarget = { lat, lng };
  if (mapFlyToCoords) {
    mapFlyToCoords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
  if (mapFlyToStatus) { mapFlyToStatus.textContent = ''; mapFlyToStatus.className = 'map-fly-to-status'; }
  if (!mapFlyToMenu) return;
  mapFlyToMenu.classList.remove('hidden');
  // Position near cursor, keep within viewport
  const W = window.innerWidth;
  const H = window.innerHeight;
  const mW = 200;
  const mH = 140;
  const x = Math.min(clientX, W - mW - 8);
  const y = Math.min(clientY, H - mH - 8);
  mapFlyToMenu.style.left = `${x}px`;
  mapFlyToMenu.style.top  = `${y}px`;
  mapFlyToBtn?.focus();
}

function closeMapFlyToMenu() {
  mapFlyToMenu?.classList.add('hidden');
  _flyToTarget = null;
}

mapFlyToBtn?.addEventListener('click', async () => {
  if (!_flyToTarget) return;
  const alt = Number(mapFlyToAlt?.value ?? 60);
  if (mapFlyToBtn) mapFlyToBtn.disabled = true;
  if (mapFlyToStatus) { mapFlyToStatus.textContent = 'שולח…'; mapFlyToStatus.className = 'map-fly-to-status'; }
  try {
    const resp = await fetch('/api/mavlink/fly-to', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: _flyToTarget.lat, lon: _flyToTarget.lng, alt }),
    });
    const data = await resp.json();
    if (data.ok) {
      if (mapFlyToStatus) { mapFlyToStatus.textContent = `✓ פקודה נשלחה (${alt}m)`; mapFlyToStatus.className = 'map-fly-to-status ok'; }
      setTimeout(closeMapFlyToMenu, 1200);
    } else {
      if (mapFlyToStatus) { mapFlyToStatus.textContent = data.message || 'שגיאה'; mapFlyToStatus.className = 'map-fly-to-status'; }
    }
  } catch {
    if (mapFlyToStatus) { mapFlyToStatus.textContent = 'שגיאת רשת'; mapFlyToStatus.className = 'map-fly-to-status'; }
  } finally {
    if (mapFlyToBtn) mapFlyToBtn.disabled = false;
  }
});

// Close fly-to menu on outside click or Escape
document.addEventListener('click', (e) => {
  if (mapFlyToMenu && !mapFlyToMenu.contains(e.target)) closeMapFlyToMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMapFlyToMenu();
});

function applyTopbarFlightData(mav) {
  if (!mav) return;
  const miniSpd = hudAirspeedEl?.closest('.tele-hud-mini');
  if (miniSpd) miniSpd.classList.toggle('tele-hud-mini--airspeed-proxy', !!mav.airspeedIsGroundspeedProxy);
  const miniAlt = hudAltitudeEl?.closest('.tele-hud-mini');
  if (miniAlt) miniAlt.classList.toggle('tele-hud-mini--time-skew', !!mav.hudTimeSkewWarn);
  if (hudAirspeedEl) {
    const spd = mav.airspeed;
    hudAirspeedEl.textContent = (typeof spd === 'number' && Number.isFinite(spd)) ? `${spd.toFixed(1)} m/s` : '-- m/s';
    hudAirspeedEl.title = mav.airspeedIsGroundspeedProxy ? VLC_TOOLTIP_IAS_FROM_GS : '';
  }
  if (hudAltitudeEl) {
    const alt = mav.altitude;
    hudAltitudeEl.textContent = (typeof alt === 'number' && Number.isFinite(alt)) ? `${alt.toFixed(1)} m` : '-- m';
    hudAltitudeEl.title = mav.hudTimeSkewWarn ? VLC_TOOLTIP_HUD_TIME_SKEW : '';
  }
  if (hudFlightModeEl) {
    const mode = ARDUPILOT_PLANE_MODES[mav.flightMode];
    hudFlightModeEl.textContent = mode ?? (mav.connected ? `#${mav.flightMode ?? '--'}` : '--');
  }
}

// RC approval channel (updated by initFlightEngineer via checkStatus)
let feRcApprovalChannelGlobal = 7;

/** Why: single SSE connection replaces all client-side polling (vision 500ms + jetson 5s) with server-pushed 300ms events. What: EventSource from /api/stream; on 'telemetry' event updates all UI components and shared state. */
(function startSseStream() {
  const src = new EventSource('/api/stream');
  src.addEventListener('telemetry', (e) => {
    try {
      const payload = JSON.parse(e.data);
      latestJetsonFromServer = payload.jetson;
      latestVisionFromServer = payload.vision;
      const jetsonOnline = Boolean(payload.jetson?.online);
      updateAdvisorSysStrip(payload.mavlink, payload.jetson, payload.appVersion);
      applyJetsonUi(jetsonOnline, payload.jetson || {});
      applyVisionUi(payload.vision);
      applySlamUi(payload.slam);
      applyTopbarFlightData(payload.mavlink);
      applyFlightHud(payload.mavlink);
      applyFcStatustextHud(payload.mavlink);
      applyNavOpticalStatus(payload.vision);
      applyHudCustomSlots(payload);
      if (payload.visionNav?.mode) applyVisionNavModeUi(payload.visionNav.mode);
      updateFlightOverlaysOnAllMaps(payload);
      // RC-switch param approval: dispatch event consumed by initFlightEngineer
      if (payload.mavlink?.rcChannels) {
        const rcVal = payload.mavlink.rcChannels[`chan${feRcApprovalChannelGlobal}_raw`];
        if (rcVal > 1700) document.dispatchEvent(new CustomEvent('fe:rc-approve'));
      }
      document.dispatchEvent(new CustomEvent('vlc:telemetry', { detail: payload }));
      /** Why: when Jetson transitions offline→online, auto-pull flight list and logs so operator sees current data. */
      if (jetsonOnline && !jetsonWasOnlinePrev) {
        jetsonWasOnlinePrev = true;
        refreshFlightLists().then(() => {
          refreshAllLogsTable();
          showAutoLogsBanner('Jetson מחובר — לוגים עודכנו אוטומטית');
        });
      } else if (!jetsonOnline) {
        jetsonWasOnlinePrev = false;
      }
    } catch {}
  });
  src.onerror = () => {
    // SSE disconnected; mark as offline and retry automatically (browser reconnects)
    if (jetsonStatusDot) jetsonStatusDot.className = 'status-dot offline';
    jetsonWasOnlinePrev = false;
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
const refreshAllLogsBtn = document.getElementById('refreshAllLogsBtn');
const allLogsArduTbody = document.getElementById('allLogsArduTbody');
const allLogsJetsonTbody = document.getElementById('allLogsJetsonTbody');

/** Why: escape text/HTML for safe table cells and href. What: minimal entity encode for innerHTML rows. */
function escapeAllLogsCell(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

/** Why: Ardu/Jetson history tables were never wired after copy into monorepo. What: GET /api/flights/all-logs, split by source, render download links + delete buttons. */
async function refreshAllLogsTable() {
  const uploadLogStatus = document.getElementById('uploadLogStatus');
  if (!allLogsArduTbody || !allLogsJetsonTbody) return;
  try {
    const res = await fetch('/api/flights/all-logs');
    const data = await res.json();
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const bySource = (src) => logs.filter((l) => String(l.source || '').toLowerCase() === src);
    function tbodyHtml(list) {
      if (!list.length) return '<tr><td colspan="3">אין לוגים</td></tr>';
      return list
        .map((l, i) => {
          const raw = l.original_name || '';
          const flightNum = l.flight_id ? `טיסה #${l.flight_id}` : '';
          const flightLabel = l.flight_title && !l.flight_title.startsWith('Flight')
            ? l.flight_title
            : raw.replace(/\.\w+$/, '') || `לוג ${i + 1}`;
          const displayName = flightNum ? `${flightNum} — ${flightLabel}` : flightLabel;
          const dateStr = l.uploaded_at ? new Date(l.uploaded_at).toLocaleDateString('he-IL') : '';
          const href = l.downloadUrl ? escapeAllLogsCell(l.downloadUrl) : '';
          const dlLink = href ? `<a href="${href}" download title="${escapeAllLogsCell(raw)}">הורדה</a>` : '—';
          const delBtn = `<button type="button" class="del-log-btn" data-log-id="${l.id}" title="מחק לוג ${escapeAllLogsCell(raw)}" aria-label="מחק לוג">🗑</button>`;
          return `<tr><td>${escapeAllLogsCell(displayName)}${dateStr ? `<br><small style="opacity:0.6">${dateStr}</small>` : ''}</td><td>${escapeAllLogsCell(flightNum || `#${l.flight_id}`)}</td><td class="log-action-cell">${dlLink} ${delBtn}</td></tr>`;
        })
        .join('');
    }
    allLogsArduTbody.innerHTML = tbodyHtml(bySource('ardupilot'));
    allLogsJetsonTbody.innerHTML = tbodyHtml(bySource('jetson'));
    if (uploadLogStatus) uploadLogStatus.textContent = `נטענו ${logs.length} לוגים מהשרת.`;
  } catch (err) {
    if (uploadLogStatus) uploadLogStatus.textContent = `טעינת כל הלוגים נכשלה: ${err?.message || err}`;
  }
}

/** Event delegation for log delete buttons in both table bodies. */
async function handleDeleteLogClick(e) {
  const btn = e.target.closest('.del-log-btn');
  if (!btn) return;
  const logId = btn.dataset.logId;
  if (!logId) return;
  const name = btn.closest('tr')?.querySelector('td')?.textContent?.trim() || `לוג #${logId}`;
  if (!confirm(`למחוק את "${name}"?\nהפעולה בלתי הפיכה.`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/flights/log/${logId}`, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(d.message || `HTTP ${res.status}`);
    await refreshAllLogsTable();
  } catch (err) {
    alert(`מחיקה נכשלה: ${err?.message || err}`);
    btn.disabled = false;
  }
}
allLogsArduTbody?.addEventListener('click', handleDeleteLogClick);
allLogsJetsonTbody?.addEventListener('click', handleDeleteLogClick);

pullLogsBtn?.addEventListener('click', () => {
  refreshAllLogsTable();
});
refreshAllLogsBtn?.addEventListener('click', () => {
  refreshAllLogsTable();
});

/** Why: show chosen filename in the modern drop zone; what: updates label after native input or drag-drop. */
function updateLogFileNameDisplay() {
  if (!logFileNameDisplay || !logFileInput) return;
  const f = logFileInput.files?.[0];
  logFileNameDisplay.textContent = f ? f.name : 'לא נבחר קובץ';
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

/** Why: keep advisor and log UI aligned with server flight list. What: fills both selects + flight list cards from GET /api/flights. */
async function refreshFlightLists() {
  try {
    const res = await fetch('/api/flights');
    const data = await res.json();
    const flights = data.flights || [];
    const opts = flights.map((f) => `<option value="${f.id}">${f.title} (#${f.id})</option>`).join('');
    if (flightSelect) flightSelect.innerHTML = opts || '<option value="">אין טיסות — צור טיסה חדשה</option>';
    if (advisorFlightSelect) {
      advisorFlightSelect.innerHTML = `<option value="">כל הטיסות במאגר</option>${opts}`;
    }
    // Render flight list cards
    renderFlightListCards(flights);
  } catch (err) {
    if (flightLogsOut) flightLogsOut.textContent = `רשימת טיסות נכשלה: ${err?.message || err}`;
  }
}

function renderFlightListCards(flights) {
  const wrap = document.getElementById('flightListWrap');
  if (!wrap) return;
  if (!flights.length) {
    wrap.innerHTML = '<p class="flight-list-empty">אין טיסות עדיין — צור טיסה חדשה למעלה.</p>';
    return;
  }
  wrap.innerHTML = flights.map((f) => {
    const date = f.created_at ? new Date(f.created_at).toLocaleDateString('he-IL') : '';
    return `<div class="flight-list-row" data-flight-id="${f.id}">
      <span class="flight-list-num">#${f.id}</span>
      <span class="flight-list-title">${f.title || `טיסה ${f.id}`}</span>
      ${date ? `<span class="flight-list-date">${date}</span>` : ''}
      <button type="button" class="flight-list-del" data-flight-id="${f.id}" title="מחק טיסה זו וכל הלוגים שלה">🗑 מחק</button>
    </div>`;
  }).join('');
}

// Event delegation for inline flight delete buttons
document.getElementById('flightListWrap')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.flight-list-del');
  if (!btn) return;
  const id = Number(btn.dataset.flightId);
  if (!id) return;
  const title = btn.closest('.flight-list-row')?.querySelector('.flight-list-title')?.textContent || `טיסה #${id}`;
  if (!confirm(`למחוק את "${title}" וכל הלוגים שלה?\nהפעולה בלתי הפיכה.`)) return;
  btn.disabled = true;
  btn.textContent = 'מוחק…';
  try {
    const res = await fetch(`/api/flights/${id}`, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(d.message || `HTTP ${res.status}`);
    await refreshFlightLists();
    await refreshAllLogsTable();
  } catch (err) {
    alert(`מחיקה נכשלה: ${err?.message || err}`);
    btn.disabled = false;
    btn.textContent = '🗑 מחק';
  }
});

/** Why: show uploaded logs for selected flight. What: GET /api/flights/:id/logs. */
async function refreshFlightLogsList() {
  if (!flightSelect || !flightLogsOut) return;
  const id = Number(flightSelect.value);
  if (!id) {
    flightLogsOut.textContent = 'בחר טיסה.';
    return;
  }
  try {
    const res = await fetch(`/api/flights/${id}/logs`);
    const data = await res.json();
    flightLogsOut.textContent = JSON.stringify(data.logs || [], null, 2);
  } catch (err) {
    flightLogsOut.textContent = `לוגים: ${err?.message || err}`;
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
const deleteFlightBtn = document.getElementById('deleteFlightBtn');
if (deleteFlightBtn) {
  deleteFlightBtn.addEventListener('click', async () => {
    const id = Number(flightSelect?.value);
    if (!id) return;
    const selText = flightSelect.options[flightSelect.selectedIndex]?.text || `טיסה #${id}`;
    if (!confirm(`למחוק את "${selText}" וכל הלוגים שלה?\nהפעולה בלתי הפיכה.`)) return;
    deleteFlightBtn.disabled = true;
    try {
      const res = await fetch(`/api/flights/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      await refreshFlightLists();
      await refreshAllLogsTable();
      if (flightLogsOut) flightLogsOut.textContent = `הטיסה "${selText}" נמחקה.`;
    } catch (err) {
      alert(`מחיקת הטיסה נכשלה: ${err?.message || err}`);
    }
    deleteFlightBtn.disabled = false;
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
      if (flightLogsOut) flightLogsOut.textContent = 'הערה נשמרה.';
    } catch (err) {
      if (flightLogsOut) flightLogsOut.textContent = `שמירת הערה נכשלה: ${err?.message || err}`;
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
      await refreshAllLogsTable();
    } catch (err) {
      if (flightLogsOut) flightLogsOut.textContent = `העלאה נכשלה: ${err?.message || err}`;
    }
  });
}
refreshFlightLists().then(refreshFlightLogsList).then(() => refreshAllLogsTable());

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
      label: `GPS מספיק (${gpsSats} / מינימום ${profileState.to_min_gps_sats})`,
      pass: gpsSats >= Number(profileState.to_min_gps_sats || 10),
    },
    {
      label: `רוח צד בטווח (${crosswind.toFixed(1)} / מקס ${profileState.to_max_crosswind_ms})`,
      pass: crosswind <= Number(profileState.to_max_crosswind_ms || 8),
    },
    {
      label: `ספול מנוע הושלם (${spool.toFixed(1)}s / נדרש ${profileState.to_motor_spool_s}s)`,
      pass: spool >= Number(profileState.to_motor_spool_s || 2.2),
    },
    {
      label: `מהירות קרקע בטוחה לשחרור (${groundSpeed.toFixed(1)} < ${profileState.to_rotate_speed_ms})`,
      pass: groundSpeed < Number(profileState.to_rotate_speed_ms || 13),
    },
    {
      label: `ביטחון Vision מעל סף Abort (${Math.round(currentConfidence * 100)}% >= ${Math.round(Number(profileState.abort_conf_min || 0.7) * 100)}%)`,
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
        <div class="process-index">שלב ${idx + 1}</div>
        <div class="process-title">${title}</div>
        ${idx < processIndex ? '<div class="process-check">V</div>' : ''}
      </article>
    `;
  }).join('');
}

/** Why: confidence bar shows real Vision data when hardware is connected (ageMs < 3s); shows "ללא חיבור" otherwise. What: runs every 1s. */
setInterval(() => {
  const visionFresh = latestVisionFromServer != null && latestVisionFromServer.ageMs != null && latestVisionFromServer.ageMs < 3000;
  let current;
  let sourceLabel;
  if (visionFresh) {
    current = Math.max(0, Math.min(1, latestVisionFromServer.confidence ?? 0));
    sourceLabel = latestJetsonFromServer?.online ? 'מחובר' : 'מחובר (Vision)';
  } else {
    current = 0;
    sourceLabel = 'ללא חיבור';
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
  if (telemetryConfidence) telemetryConfidence.textContent = pct != null ? `${pct}%` : '—';
  if (abortState) abortState.textContent = isAbort ? `ABORT (${lowConfidenceSeconds.toFixed(0)}s)` : `ARMED (${lowConfidenceSeconds.toFixed(0)}s)`;
  if (takeoffState) takeoffState.textContent = takeoffReady ? 'READY' : 'HOLD';
  if (liveConfidenceText) liveConfidenceText.textContent = pct != null ? `${pct}%` : '—';
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

/** Why: pilot downloads a ready-to-import .param file — no manual copy-paste needed. What: creates a Blob from configText and triggers browser download. */
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
      if (mpOut) { mpOut.classList.add('visible'); mpOut.textContent = `שגיאה: ${err?.message || err}`; }
    }
  });
}

const advisorMessages = document.getElementById('advisorMessages');
const advisorInput = document.getElementById('advisorInput');
const advisorSendBtn = document.getElementById('advisorSendBtn');
const advisorStatus = document.getElementById('advisorStatus');
const advisorMicBtn = document.getElementById('advisorMicBtn');
const advisorThreadTitle = document.getElementById('advisorThreadTitle');
const advisorNewChatBtn = document.getElementById('advisorNewChatBtn');
const advisorAttachBtn = document.getElementById('advisorAttachBtn');
const advisorFileInput = document.getElementById('advisorFileInput');

/** Currently pending file attachment { name, mimeType, dataBase64?, text?, dataUrl? } | null */
let pendingAttachment = null;

/** Track which saved issue the current thread is viewing.
 *  null = brand-new conversation (server will create or reuse issue on send). */
let activeIssueId = null;

function setAdvisorStatus(text, tone = '') {
  if (!advisorStatus) return;
  advisorStatus.textContent = text;
  advisorStatus.classList.remove('busy', 'err');
  if (tone) advisorStatus.classList.add(tone);
}

function setThreadTitle(text) {
  if (advisorThreadTitle) advisorThreadTitle.textContent = text || 'שיחה חדשה';
}

function pushMsg(role, text, opts = {}) {
  if (!advisorMessages) {
    setAdvisorStatus(`צ'אט לא נטען: אין advisorMessages (role=${role})`, 'err');
    return;
  }
  const welcome = advisorMessages.querySelector('[data-static-welcome="1"]');
  if (welcome) welcome.remove();
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  const msgText = document.createElement('span');
  msgText.className = 'msg-text';
  msgText.textContent = text;
  node.appendChild(msgText);
  const mid = Number(opts.messageId);
  if (role === 'user' && Number.isFinite(mid) && mid > 0) {
    const resolved = opts.resolved === true;
    node.dataset.messageId = String(mid);
    node.dataset.resolved = resolved ? '1' : '0';
    if (resolved) node.classList.add('resolved');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `adv-msg-resolve ${resolved ? 'resolved' : 'open'}`;
    btn.setAttribute('data-action', 'toggle-msg-resolve');
    btn.setAttribute('data-message-id', String(mid));
    btn.textContent = resolved ? 'נפתר' : 'לא נפתר';
    node.appendChild(btn);
  }
  advisorMessages.appendChild(node);
  advisorMessages.scrollTop = advisorMessages.scrollHeight;
}

function attachResolveMetaToLastUserMessage(messageId, resolved = false) {
  const mid = Number(messageId);
  if (!advisorMessages || !Number.isFinite(mid) || mid < 1) return;
  const msg = Array.from(advisorMessages.querySelectorAll('.msg.user')).reverse().find((n) => !n.dataset.messageId);
  if (!msg) return;
  msg.dataset.messageId = String(mid);
  msg.dataset.resolved = resolved ? '1' : '0';
  if (resolved) msg.classList.add('resolved');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `adv-msg-resolve ${resolved ? 'resolved' : 'open'}`;
  btn.setAttribute('data-action', 'toggle-msg-resolve');
  btn.setAttribute('data-message-id', String(mid));
  btn.textContent = resolved ? 'נפתר' : 'לא נפתר';
  msg.appendChild(btn);
}

/** Auto-resize the composer textarea to fit content (bounded by CSS max-height). */
function autoResizeAdvisorInput() {
  if (!advisorInput || advisorInput.tagName !== 'TEXTAREA') return;
  advisorInput.style.height = 'auto';
  advisorInput.style.height = Math.min(advisorInput.scrollHeight, 140) + 'px';
}

/** Reset chat area to a fresh conversation. */
function startNewAdvisorThread() {
  activeIssueId = null;
  if (advisorMessages) {
    advisorMessages.innerHTML = `<div class="adv-empty-state" data-static-welcome="1">
      <div class="adv-empty-icon">✦</div>
      <div class="adv-empty-title">שיחה חדשה</div>
      <div class="adv-empty-sub">שאל על: נדנוד, הצפה, מהירות גישה, ABORT, Jetson, SLAM — או בקש שינוי פרמטר.</div>
      <div class="adv-empty-chips">
        <button type="button" class="adv-chip" data-prompt="יש לי נדנוד לפני ההצפה, מה לשנות?">נדנוד לפני הצפה</button>
        <button type="button" class="adv-chip" data-prompt="הנחיתה קשה מדי, איזה פרמטר לשנות?">נחיתה קשה</button>
        <button type="button" class="adv-chip" data-prompt="מה השינויים האחרונים שביצעתי בפרמטרים?">מה שיניתי לאחרונה?</button>
        <button type="button" class="adv-chip" data-prompt="יש לי הרבה ABORT שגויים, מה לכוונן?">ABORT שגויים</button>
      </div>
    </div>`;
  }
  setThreadTitle('שיחה חדשה');
  setAdvisorStatus('מוכן');
  if (advisorInput) {
    advisorInput.value = '';
    autoResizeAdvisorInput();
    advisorInput.focus();
  }
  document.querySelectorAll('.adv-issues-list .advisor-issue-card.active').forEach((el) => el.classList.remove('active'));
}

/** Load a saved issue's messages into the chat area. */
async function loadIssueIntoChat(issueId) {
  if (!issueId || !advisorMessages) return;
  setAdvisorStatus('טוען שיחה…', 'busy');
  try {
    const res = await fetch(`/api/advisor/issues/${issueId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.message || 'failed');
    activeIssueId = issueId;
    advisorMessages.innerHTML = '';
    const issue = data.issue || {};
    const header = document.createElement('div');
    header.className = 'msg system';
    const versions = [];
    if (issue.app_version) versions.push(`Console ${issue.app_version}`);
    if (issue.agent_version) versions.push(`Agent ${issue.agent_version}`);
    if (issue.fc_firmware_version) versions.push(`FC ${issue.fc_firmware_version}`);
    header.textContent = `בעיה #${issue.id} · ${issue.status === 'resolved' ? 'נפתרה' : issue.status === 'wont_fix' ? 'לא רלוונטית' : 'פתוחה'}${versions.length ? ' · ' + versions.join(' · ') : ''}`;
    advisorMessages.appendChild(header);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (const m of messages) {
      const role = m.role === 'user' ? 'user' : 'bot';
      const body = m.message != null ? m.message : m.content;
      pushMsg(role, body != null ? String(body) : '', { messageId: m.id, resolved: Boolean(m.is_resolved) });
    }
    if (issue.resolution) {
      const resNode = document.createElement('div');
      resNode.className = 'msg system';
      resNode.textContent = `פתרון מתועד: ${issue.resolution}`;
      advisorMessages.appendChild(resNode);
    }
    setThreadTitle(issue.title ? `#${issue.id} ${issue.title}` : `בעיה #${issue.id}`);
    setAdvisorStatus('מוכן');
    document.querySelectorAll('.adv-issues-list .advisor-issue-card').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.issueId) === Number(issueId));
    });
    advisorMessages.scrollTop = advisorMessages.scrollHeight;
  } catch (err) {
    setAdvisorStatus(`שגיאה בטעינת שיחה: ${err?.message || err}`, 'err');
  }
}

if (advisorNewChatBtn) advisorNewChatBtn.addEventListener('click', startNewAdvisorThread);

/* ── Sidebar / chat resize handle ────────────────────────────────────────
   Drags the vertical divider to resize sidebar vs chat column.
   Persists chosen width in localStorage. Advisor layout is direction:ltr so the
   sidebar stays physical left; doc may still be rtl — branch matches drag delta. */
(function initAdvResizeHandle() {
  const handle = document.getElementById('advResizeHandle');
  const layout = handle?.closest('.advisor-layout');
  if (!handle || !layout) return;

  const STORAGE_KEY = 'adv_sidebar_w';
  // Min = natural min-content of the sidebar header row (✦ + title + "＋ שיחה" + ⟳ + paddings ≈ 215px).
  const MIN_W = 215;
  const MAX_W = 480;

  function applyWidth(w) {
    layout.style.setProperty('--adv-sidebar-w', `${w}px`);
  }

  // Restore saved width.
  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved >= MIN_W && saved <= MAX_W) applyWidth(saved);

  let startX = 0;
  let startW = 0;
  let dragging = false;

  function onMove(e) {
    if (!dragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const rect = layout.getBoundingClientRect();
    const isRtl = getComputedStyle(document.documentElement).direction === 'rtl';
    let newW;
    if (isRtl) {
      newW = startW + (startX - clientX);   // drag left → sidebar grows
    } else {
      newW = startW + (clientX - startX);   // drag right → sidebar grows
    }
    newW = Math.max(MIN_W, Math.min(MAX_W, Math.round(newW)));
    applyWidth(newW);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Save width
    const cur = parseInt(getComputedStyle(layout).getPropertyValue('--adv-sidebar-w'), 10);
    if (cur >= MIN_W && cur <= MAX_W) localStorage.setItem(STORAGE_KEY, cur);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const rect = layout.getBoundingClientRect();
    // Current sidebar pixel width from the CSS variable or computed grid columns.
    const colW = parseInt(getComputedStyle(layout).getPropertyValue('--adv-sidebar-w') || '260', 10);
    startW = colW;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Touch support
  handle.addEventListener('touchstart', (e) => {
    dragging = true;
    startX = e.touches[0].clientX;
    const colW = parseInt(getComputedStyle(layout).getPropertyValue('--adv-sidebar-w') || '260', 10);
    startW = colW;
    handle.classList.add('dragging');
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend',  onUp);
  }, { passive: true });
})();

/** Why: one round-trip to server (Gemini + retrieval + digest).
 *  What: returns { reply, options, source } — options is the validated action list.
 *  Fallbacks: on network/JSON failure, returns local heuristic with empty options. */
async function advisorReply(q, attachment = null) {
  const localFallback = { reply: localAdvisorReply(q), options: [], source: 'local_rules', issueId: activeIssueId };
  try {
    const fidRaw = advisorFlightSelect?.value;
    const flightId = fidRaw ? Number(fidRaw) : null;
    const res = await fetch('/api/advisor-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        issueId: activeIssueId,
        params: profileState,
        flightId: Number.isInteger(flightId) && flightId > 0 ? flightId : null,
        attachment: attachment || undefined,
      }),
    });
    let data;
    try { data = await res.json(); } catch {
      return { reply: `${localFallback.reply}\n\n[השרת החזיר תשובה שאינה JSON — בדוק שרץ node server.js מהתיקייה VisionLandingConsole ושהפורט 4010 נכון.]`, options: [], source: 'local_fallback' };
    }
    const replyText = typeof data?.reply === 'string' ? data.reply.trim() : '';
    const options = Array.isArray(data?.options) ? data.options : [];
    if (data?.ok) {
      if (replyText || options.length) {
        return {
          reply: replyText,
          options,
          source: data.source || 'unknown',
          issueId: Number.isInteger(Number(data.issueId)) ? Number(data.issueId) : activeIssueId,
          userMessageId: Number.isInteger(Number(data.userMessageId)) ? Number(data.userMessageId) : null,
          advisorMessageId: Number.isInteger(Number(data.advisorMessageId)) ? Number(data.advisorMessageId) : null,
        };
      }
      return { reply: `${localFallback.reply}\n\n[השרת החזיר תשובה ריקה — נסה ניסוח אחר, או בדוק מפתח Gemini / מכסה API.]`, options: [], source: 'local_fallback' };
    }
    const serverMsg = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : `HTTP ${res.status}`;
    return { reply: `${localFallback.reply}\n\n[יועץ שרת: ${serverMsg}]`, options: [], source: 'local_fallback' };
  } catch (e) {
    const hint = e?.message || String(e);
    return { reply: `${localFallback.reply}\n\n[רשת/דפדפן: ${hint}]`, options: [], source: 'local_fallback' };
  }
}

// ── Advisor action UI ───────────────────────────────────────────────────────

const RISK_LABEL = { low: 'סיכון נמוך', med: 'סיכון בינוני', high: 'סיכון גבוה' };
const RISK_CLASS = { low: 'risk-low', med: 'risk-med', high: 'risk-high' };

/**
 * Render advisor options as interactive cards.
 * Phase 3: no_action = info-only; param_change = Apply button with confirm flow.
 */
function renderAdvisorOptions(options) {
  if (!advisorMessages || !Array.isArray(options) || options.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'adv-options';
  for (const opt of options) {
    if (!opt) continue;
    const card = document.createElement('div');
    const riskCls = opt.risk ? ` ${RISK_CLASS[opt.risk] || ''}` : '';
    if (opt.kind === 'no_action') {
      card.className = `adv-option adv-option-no-action${riskCls}`;
    } else if (opt.kind === 'param_change') {
      card.className = `adv-option adv-option-param${riskCls}`;
    } else {
      card.className = `adv-option${riskCls}`;
    }
    card.dataset.actionId = opt.id || '';
    card.dataset.actionKind = opt.kind || '';

    const head = document.createElement('div');
    head.className = 'adv-option-head';

    const titleEl = document.createElement('div');
    titleEl.className = 'adv-option-title';
    titleEl.textContent = opt.title || '(ללא כותרת)';
    head.appendChild(titleEl);

    if (opt.risk && opt.kind === 'param_change') {
      const badge = document.createElement('span');
      badge.className = `adv-risk-badge ${RISK_CLASS[opt.risk] || ''}`;
      badge.textContent = RISK_LABEL[opt.risk] || opt.risk;
      head.appendChild(badge);
    }
    card.appendChild(head);

    if (opt.detail) {
      const detEl = document.createElement('div');
      detEl.className = 'adv-option-detail';
      detEl.textContent = opt.detail;
      card.appendChild(detEl);
    }

    if (opt.kind === 'param_change' && opt.change) {
      const fromStr = opt.change.from != null ? String(opt.change.from) : '?';
      const unitStr = opt.unit ? ` ${opt.unit}` : '';
      const alts =
        Array.isArray(opt.alternatives) && opt.alternatives.length > 1 ? opt.alternatives : null;
      const defaultTo = alts
        ? (alts.find((a) => a.isPrimary) || alts[alts.length - 1] || alts[0]).to
        : opt.change.to;
      const defaultLabel = opt.enumLabel || alts?.find((a) => a.isPrimary)?.enumLabel || null;
      const diffEl = document.createElement('div');
      diffEl.className = 'adv-option-diff';
      const helpText = (opt.paramHelp && String(opt.paramHelp).trim()) || '';

      const paramLine = document.createElement('div');
      paramLine.className = 'adv-param-line';
      const pSpan = document.createElement('span');
      pSpan.className = 'diff-param';
      pSpan.textContent = opt.change.param;
      paramLine.appendChild(pSpan);
      if (helpText) {
        const hp = document.createElement('button');
        hp.type = 'button';
        hp.className = 'adv-param-help';
        hp.setAttribute('aria-label', helpText);
        hp.title = helpText;
        hp.textContent = '?';
        paramLine.appendChild(hp);
      }
      diffEl.appendChild(paramLine);

      const valLine = document.createElement('div');
      valLine.className = 'adv-diff-vals';
      const fromSp = document.createElement('span');
      fromSp.className = 'diff-from';
      fromSp.textContent = fromStr + unitStr;
      const toSpan = document.createElement('span');
      toSpan.className = 'diff-to';
      toSpan.textContent = defaultLabel || String(defaultTo) + unitStr;
      valLine.appendChild(fromSp);
      valLine.appendChild(document.createTextNode(' → '));
      valLine.appendChild(toSpan);
      diffEl.appendChild(valLine);
      card.appendChild(diffEl);

      const altName = `adv-alt-${(opt.id || 'x').replace(/[^a-z0-9-]/ig, 'x')}`;
      if (alts) {
        const group = document.createElement('div');
        group.className = 'adv-alt-tiers';
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', opt.discreteKind === 'enum' ? 'ערך enum' : 'עוצמת שינוי');
        const preA = alts.find((x) => x.isPrimary) || alts[0];
        for (const a of alts) {
          const id = `alt-${altName}-${a.id}`;
          const label = document.createElement('label');
          label.className = 'adv-alt-label';
          label.htmlFor = id;
          const input = document.createElement('input');
          input.id = id;
          input.type = 'radio';
          input.name = altName;
          input.value = String(a.to);
          input.checked = !!preA && Math.abs(Number(a.to) - Number(preA.to)) < 1e-5;
          input.addEventListener('change', (e) => {
            const v = e.target?.value;
            if (v != null) {
              const alt = alts.find((x) => Math.abs(Number(x.to) - Number(v)) < 1e-5);
              toSpan.textContent = (alt?.enumLabel || String(v)) + (alt?.enumLabel ? '' : unitStr);
            }
          });
          label.appendChild(input);
          label.appendChild(document.createTextNode(` ${a.label} `));
          const vEm = document.createElement('em');
          vEm.className = 'adv-alt-to';
          vEm.textContent = `(${String(a.to)}${unitStr})`;
          label.appendChild(vEm);
          group.appendChild(label);
        }
        card.appendChild(group);
      }

      const actBar = document.createElement('div');
      actBar.className = 'adv-option-actions';

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'adv-apply-btn';
      applyBtn.dataset.actionId = opt.id || '';
      applyBtn.dataset.actionKind = opt.kind;
      applyBtn.dataset.risk = opt.risk || 'med';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', () => {
        let chosen = defaultTo;
        if (alts) {
          const g = card.querySelector(`input[name="${altName}"]:checked`);
          if (g && g.value != null) chosen = Number(g.value);
        } else {
          chosen = opt.change.to;
        }
        void openApplyConfirm(opt, chosen);
      });
      actBar.appendChild(applyBtn);

      const inFlightNote = opt.inflightSafe === false
        ? document.createElement('span')
        : null;
      if (inFlightNote) {
        inFlightNote.className = 'adv-inflight-note';
        inFlightNote.textContent = '⚠ Only when DISARMED';
        actBar.appendChild(inFlightNote);
      }
      card.appendChild(actBar);
    }
    wrap.appendChild(card);
  }
  if (wrap.children.length > 0) {
    advisorMessages.appendChild(wrap);
    advisorMessages.scrollTop = advisorMessages.scrollHeight;
  }
}

// ── Apply confirm modal ───────────────────────────────────────────────────

const applyConfirmModal    = document.getElementById('applyConfirmModal');
const applyConfirmTitle    = document.getElementById('applyConfirmTitle');
const applyConfirmBody     = document.getElementById('applyConfirmBody');
const applyConfirmOkBtn    = document.getElementById('applyConfirmOkBtn');
const applyConfirmCancelBtn= document.getElementById('applyConfirmCancelBtn');
const applyConfirmTypeInput= document.getElementById('applyConfirmTypeInput');
const closeApplyConfirmBtn = document.getElementById('closeApplyConfirmBtn');
const applyInflightBlock = document.getElementById('applyInflightOverrideBlock');
const applyInflightAck = document.getElementById('applyInflightAck');
const applyInflightReason = document.getElementById('applyInflightReason');

/** @type {{ opt: any, valueTo: number|undefined } | null} */
let _pendingApply = null;
/** FC + ARM + server override flag: require checkbox + reason before OK. */
let _applyNeedsInflightOverride = false;

function validateApplyConfirmOk() {
  if (!applyConfirmOkBtn) return;
  const opt = _pendingApply?.opt;
  const high = opt?.risk === 'high';
  if (high && applyConfirmTypeInput && applyConfirmTypeInput.value.trim().toUpperCase() !== 'APPLY') {
    applyConfirmOkBtn.disabled = true;
    return;
  }
  if (_applyNeedsInflightOverride) {
    const ack = applyInflightAck?.checked === true;
    const reason = (applyInflightReason?.value || '').trim();
    if (!ack || reason.length < 15) {
      applyConfirmOkBtn.disabled = true;
      return;
    }
  }
  applyConfirmOkBtn.disabled = false;
}

/**
 * @param {any} opt
 * @param {number} [chosenTo] — selected tier; defaults to `opt.change.to`
 */
async function openApplyConfirm(opt, chosenTo) {
  const toApply = (chosenTo != null && Number.isFinite(Number(chosenTo)))
    ? Number(chosenTo)
    : Number(opt?.change?.to);
  _pendingApply = { opt, valueTo: toApply };
  _applyNeedsInflightOverride = false;
  if (applyInflightBlock) applyInflightBlock.classList.add('hidden');
  if (applyInflightAck) applyInflightAck.checked = false;
  if (applyInflightReason) applyInflightReason.value = '';
  if (!applyConfirmModal) return;
  applyConfirmTitle.textContent = opt.title || 'אישור שינוי';

  let preview = null;
  if (opt.kind === 'param_change' && opt.id) {
    try {
      const u = new URL(`/api/advisor/actions/${encodeURIComponent(opt.id)}/preview`, window.location.origin);
      u.searchParams.set('valueTo', String(toApply));
      const pr = await fetch(u.pathname + u.search);
      preview = await pr.json();
    } catch {
      preview = null;
    }
  }

  const unitStr = opt.unit ? ` ${opt.unit}` : '';
  let fromStr = opt.change?.from != null ? String(opt.change.from) : '?';
  if (preview?.ok && preview.liveFrom != null && Number.isFinite(Number(preview.liveFrom))) {
    fromStr = String(preview.liveFrom);
  }
  const toStr = String(toApply ?? opt.change?.to ?? '?');
  const effectiveTarget = preview?.ok && (preview.target === 'fc' || preview.target === 'jetson')
    ? preview.target
    : opt.target;
  const target = effectiveTarget === 'fc' ? 'FC (ArduPilot)' : 'Jetson';
  const riskStr = RISK_LABEL[opt.risk] || opt.risk || 'לא ידוע';
  const previewRow =
    preview?.ok && preview.target === 'fc'
      ? `<tr><th>ערך חי מה-FC</th><td>${escapeHtml(fromStr)}${escapeHtml(unitStr)} <span class="apply-preview-tag">(מקאש MAVLink)</span></td></tr>`
      : '';
  let inFlightWarning = opt.inflightSafe === false
    ? `<p class="apply-warn">⚠ שינוי זה בדרך כלל מותר רק כשהמטוס DISARMED — אלא אם הופעל override בשרת והשלמת אישור למטה.</p>`
    : '';
  if (preview?.ok && preview.target === 'fc' && preview.armed === true && !preview.inflightSafe) {
    if (preview.inflightOverrideEnabled) {
      inFlightWarning += `<p class="apply-warn apply-warn-override">מטוס ARM — אפשר להמשיך רק עם אישור מילולי + <code>ADVISOR_FC_INFLIGHT_OVERRIDE</code> בשרת.</p>`;
      _applyNeedsInflightOverride = true;
      if (applyInflightBlock) applyInflightBlock.classList.remove('hidden');
    } else {
      inFlightWarning += `<p class="apply-warn">מטוס ARM — כתיבת FC חסומה (אין override בשרת). Disarm או הגדר משתנה סביבה.</p>`;
    }
  }
  applyConfirmBody.innerHTML = `
    <table class="apply-table">
      <tr><th>פרמטר</th><td><strong>${escapeHtml(opt.change?.param || '')}</strong></td></tr>
      ${previewRow}
      <tr><th>מ (הצעה / לפני)</th><td>${escapeHtml(opt.change?.from != null ? String(opt.change.from) : '?')}${escapeHtml(unitStr)}</td></tr>
      <tr><th>ל (אחרי)</th><td><strong>${escapeHtml(toStr)}${escapeHtml(unitStr)}</strong></td></tr>
      <tr><th>יעד</th><td>${escapeHtml(target)}${preview?.ok ? ' <span class="apply-preview-tag">(מאומת שרת)</span>' : ''}</td></tr>
      <tr><th>סיכון</th><td><span class="adv-risk-badge ${RISK_CLASS[opt.risk] || ''}">${escapeHtml(riskStr)}</span></td></tr>
    </table>
    ${opt.detail ? `<p class="apply-detail">${escapeHtml(opt.detail)}</p>` : ''}
    ${inFlightWarning}
    ${opt.risk === 'high' ? '<p class="apply-warn apply-warn-high">שינוי בסיכון גבוה — הקלד APPLY בשדה למטה לאישור.</p>' : ''}
  `;
  if (opt.risk === 'high') {
    applyConfirmTypeInput.classList.remove('hidden');
    applyConfirmTypeInput.value = '';
    applyConfirmTypeInput.oninput = validateApplyConfirmOk;
  } else {
    applyConfirmTypeInput.classList.add('hidden');
  }
  if (applyInflightAck) applyInflightAck.onchange = validateApplyConfirmOk;
  if (applyInflightReason) applyInflightReason.oninput = validateApplyConfirmOk;
  validateApplyConfirmOk();
  applyConfirmModal.classList.remove('hidden');
}

function closeApplyConfirm() {
  if (!applyConfirmModal) return;
  applyConfirmModal.classList.add('hidden');
  _pendingApply = null;
  _applyNeedsInflightOverride = false;
  if (applyInflightBlock) applyInflightBlock.classList.add('hidden');
}

async function executeApply() {
  const pending = _pendingApply;
  const opt = pending?.opt;
  if (!opt || !opt.id) {
    closeApplyConfirm();
    return;
  }
  const toApply = pending.valueTo != null && Number.isFinite(pending.valueTo)
    ? pending.valueTo
    : Number(opt.change?.to);
  const reason = (applyInflightReason?.value || '').trim();
  const inflightBody = {};
  if (_applyNeedsInflightOverride) {
    if (!applyInflightAck?.checked || reason.length < 15) {
      setAdvisorStatus('אישור בטיסה: סמן את התיבה וכתוב סיבה של 15+ תווים.', 'err');
      return;
    }
    inflightBody.acknowledgeInflightRisk = true;
    inflightBody.inflightOverrideReason = reason;
  }
  if (opt.kind === 'param_change' && toApply != null) {
    inflightBody.valueTo = toApply;
  }
  closeApplyConfirm();
  applyConfirmOkBtn.disabled = true;
  pushMsg('bot', `⏳ מחיל שינוי: ${opt.change?.param} → ${toApply}…`);
  try {
    const resp = await fetch(`/api/advisor/actions/${encodeURIComponent(opt.id)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inflightBody),
    });
    const data = await resp.json();
    if (data.ok) {
      pushMsg('bot', `✅ הוחל: ${opt.change?.param} = ${toApply}${opt.unit ? ' ' + opt.unit : ''}. snapshot=${data.snapshotId}`);
      // Mark card as applied
      const card = advisorMessages?.querySelector(`[data-action-id="${CSS.escape(opt.id)}"]`);
      if (card) {
        card.classList.add('adv-option-applied');
        const applyBtn = card.querySelector('.adv-apply-btn');
        if (applyBtn) {
          applyBtn.textContent = 'Undo';
          applyBtn.className = 'adv-apply-btn adv-undo-btn';
          applyBtn.onclick = () => executeRollback(opt.id, opt.change?.param, card);
        }
      }
      refreshPendingBanner();
    } else {
      pushMsg('bot', `❌ השינוי נכשל: ${data.message || data.code || 'שגיאה לא ידועה'}`);
    }
  } catch (err) {
    pushMsg('bot', `❌ שגיאת רשת: ${err?.message || err}`);
  }
}

async function executeRollback(actionId, paramName, card) {
  if (!confirm(`בטל את השינוי של ${paramName}?`)) return;
  try {
    const resp = await fetch(`/api/advisor/actions/${encodeURIComponent(actionId)}/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const data = await resp.json();
    if (data.ok) {
      pushMsg('bot', `↩ בוטל: ${paramName} שוחזר ל-${data.restoredTo}`);
      if (card) card.classList.add('adv-option-rolled-back');
      refreshPendingBanner();
    } else {
      pushMsg('bot', `❌ Rollback נכשל: ${data.message}`);
    }
  } catch (err) {
    pushMsg('bot', `❌ שגיאת רשת: ${err?.message || err}`);
  }
}

if (applyConfirmOkBtn)     applyConfirmOkBtn.addEventListener('click', executeApply);
if (applyConfirmCancelBtn) applyConfirmCancelBtn.addEventListener('click', closeApplyConfirm);
if (closeApplyConfirmBtn)  closeApplyConfirmBtn.addEventListener('click', closeApplyConfirm);
if (applyConfirmModal)     applyConfirmModal.addEventListener('click', (e) => { if (e.target === applyConfirmModal) closeApplyConfirm(); });

// ── Audit viewer ──────────────────────────────────────────────────────────

const auditModal     = document.getElementById('auditModal');
const auditContent   = document.getElementById('auditModalContent');
const closeAuditBtn  = document.getElementById('closeAuditModalBtn');
const advisorAuditBtn= document.getElementById('advisorAuditBtn');

async function openAuditModal() {
  if (!auditModal) return;
  auditModal.classList.remove('hidden');
  if (auditContent) auditContent.innerHTML = '<div class="audit-loading">טוען…</div>';
  try {
    const resp = await fetch('/api/advisor/audit?days=60&limit=200');
    const data = await resp.json();
    if (!data.ok || !data.entries?.length) {
      auditContent.innerHTML = '<p style="padding:1rem;opacity:.7">אין שינויים מוקלטים ב-60 יום האחרונים.</p>';
      return;
    }
    const rows = data.entries.map((r) => {
      const verb = r.kind === 'rollback' ? '↩ rollback' : r.verified ? '✔' : '✘ failed';
      const delta = r.value_from != null && r.value_to != null
        ? `${Number(r.value_from).toFixed(3)} → ${Number(r.value_to).toFixed(3)}`
        : '—';
      const err = r.error ? `<span class="audit-err" title="${escapeHtml(r.error)}">⚠</span>` : '';
      const fcFw = r.fc_firmware != null && r.fc_firmware !== '' ? escapeHtml(String(r.fc_firmware)) : '—';
      const appV = r.app_version != null && r.app_version !== '' ? escapeHtml(String(r.app_version)) : '—';
      const note = r.note != null && String(r.note).trim() !== '' ? escapeHtml(String(r.note).slice(0, 120)) : '—';
      return `<tr>
        <td>${escapeHtml((r.created_at || '').slice(0, 16))}</td>
        <td>${verb}${err}</td>
        <td>${escapeHtml(r.target || '')}</td>
        <td><strong>${escapeHtml(r.param || '')}</strong></td>
        <td>${escapeHtml(delta)}</td>
        <td>${fcFw}</td>
        <td>${appV}</td>
        <td title="${r.note != null ? escapeHtml(String(r.note)) : ''}">${note}</td>
        <td>${r.issue_id ? `#${r.issue_id}` : '—'}</td>
      </tr>`;
    }).join('');
    auditContent.innerHTML = `<table class="audit-table">
      <thead><tr><th>תאריך</th><th>סוג</th><th>יעד</th><th>פרמטר</th><th>שינוי</th><th>FC/OS</th><th>קונסול</th><th>הערה</th><th>Issue</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (err) {
    if (auditContent) auditContent.innerHTML = `<p style="padding:1rem;color:var(--col-danger)">שגיאה: ${escapeHtml(err?.message || err)}</p>`;
  }
}

if (closeAuditBtn)   closeAuditBtn.addEventListener('click', () => auditModal?.classList.add('hidden'));
if (advisorAuditBtn) advisorAuditBtn.addEventListener('click', openAuditModal);
const advSysAuditBtn = document.getElementById('advSysAuditBtn');
if (advSysAuditBtn) advSysAuditBtn.addEventListener('click', openAuditModal);
if (auditModal)      auditModal.addEventListener('click', (e) => { if (e.target === auditModal) auditModal.classList.add('hidden'); });

// ── Pending changes banner ────────────────────────────────────────────────

const advisorPendingBanner  = document.getElementById('advisorPendingBanner');
const advisorPendingMsg     = document.getElementById('advisorPendingMsg');
const advisorRevertAllBtn   = document.getElementById('advisorRevertAllBtn');

async function refreshPendingBanner() {
  if (!advisorPendingBanner) return;
  try {
    const resp = await fetch('/api/advisor/session/pending');
    const data = await resp.json();
    if (data.ok && data.pendingCount > 0) {
      advisorPendingBanner.classList.remove('hidden');
      if (advisorPendingMsg) {
        advisorPendingMsg.textContent = `יש ${data.pendingCount} שינוי/ים שלא שוחזרו מאז תחילת הסשן.`;
      }
    } else {
      advisorPendingBanner.classList.add('hidden');
    }
  } catch { /* silent */ }
}

if (advisorRevertAllBtn) {
  advisorRevertAllBtn.addEventListener('click', async () => {
    if (!confirm('לשחזר את כל שינויי הפרמטרים של הסשן הנוכחי?')) return;
    advisorRevertAllBtn.disabled = true;
    try {
      const resp = await fetch('/api/advisor/session/revert-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await resp.json();
      if (data.ok) {
        const count = data.reverted?.length || 0;
        const errs  = data.errors?.length || 0;
        pushMsg('bot', `↩ Revert הכל: ${count} שינוי/ים שוחזרו${errs ? `, ${errs} שגיאות` : ''}.`);
        refreshPendingBanner();
      } else {
        pushMsg('bot', `❌ Revert נכשל: ${data.message}`);
      }
    } catch (err) {
      pushMsg('bot', `❌ שגיאת רשת: ${err?.message || err}`);
    } finally {
      advisorRevertAllBtn.disabled = false;
    }
  });
}

// Poll pending banner every 60s while on the advisor tab.
setInterval(() => {
  const advisorSection = document.getElementById('advisor');
  if (advisorSection && !advisorSection.classList.contains('hidden')) refreshPendingBanner();
}, 60000);

async function handleAdvisorSend() {
  if (!advisorInput) return;
  let q = advisorInput.value.trim();

  // For text file attachments, prepend content to the question
  let attachmentPayload = null;
  if (pendingAttachment) {
    if (pendingAttachment.text) {
      q = (q ? q + '\n\n' : '') + `[קובץ מצורף: ${pendingAttachment.name}]\n${pendingAttachment.text.slice(0, 4000)}`;
    } else if (pendingAttachment.dataBase64) {
      attachmentPayload = { name: pendingAttachment.name, mimeType: pendingAttachment.mimeType, dataBase64: pendingAttachment.dataBase64 };
    }
  }

  if (!q && !attachmentPayload) return;
  if (!q) q = `[קובץ מצורף: ${pendingAttachment?.name || 'קובץ'}]`;

  if (advisorSendBtn) advisorSendBtn.disabled = true;
  setAdvisorStatus('שולח…', 'busy');

  const sentAttachment = pendingAttachment;
  pendingAttachment = null;
  if (advisorFileInput) advisorFileInput.value = '';
  renderAttachmentPreview();

  try {
    const displayQ = sentAttachment?.dataUrl
      ? `${advisorInput.value.trim() || ''} 🖼 ${sentAttachment.name}`.trim()
      : q;
    pushMsg('user', displayQ || q, { messageId: null, resolved: false });
    const result = await advisorReply(q, attachmentPayload);
    if (Number.isInteger(Number(result.issueId)) && Number(result.issueId) > 0) {
      activeIssueId = Number(result.issueId);
      setThreadTitle(`שיחה #${activeIssueId}`);
    }
    attachResolveMetaToLastUserMessage(result.userMessageId, false);
    if (result.reply) pushMsg('bot', result.reply, { messageId: result.advisorMessageId });
    if (result.options && result.options.length) renderAdvisorOptions(result.options);
    advisorInput.value = '';
    autoResizeAdvisorInput();
    setAdvisorStatus('מוכן');
  } catch {
    pushMsg('bot', localAdvisorReply(q));
    setAdvisorStatus('שגיאה — תשובה מקומית', 'err');
  } finally {
    if (advisorSendBtn) advisorSendBtn.disabled = false;
  }
}

// ── File attachment ────────────────────────────────────────────────────────

function renderAttachmentPreview() {
  const existing = document.getElementById('advisorAttachPreview');
  if (existing) existing.remove();
  if (!pendingAttachment) return;
  const composer = advisorSendBtn?.closest('.adv-composer');
  if (!composer) return;
  const preview = document.createElement('div');
  preview.id = 'advisorAttachPreview';
  preview.className = 'adv-attach-preview';
  const isImage = pendingAttachment.mimeType?.startsWith('image/');
  preview.innerHTML = `
    <span class="adv-attach-icon">${isImage ? '🖼' : '📄'}</span>
    <span class="adv-attach-name">${pendingAttachment.name}</span>
    <button class="adv-attach-remove" title="הסר קובץ" aria-label="הסר">✕</button>`;
  preview.querySelector('.adv-attach-remove').addEventListener('click', () => {
    pendingAttachment = null;
    if (advisorFileInput) advisorFileInput.value = '';
    renderAttachmentPreview();
  });
  composer.insertAdjacentElement('beforebegin', preview);
}

if (advisorAttachBtn && advisorFileInput) {
  advisorAttachBtn.addEventListener('click', () => advisorFileInput.click());
  advisorFileInput.addEventListener('change', () => {
    const file = advisorFileInput.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isText = /text\/|application\/(json|xml)|\.log|\.csv/.test(file.type) || /\.(log|txt|csv|json|xml)$/i.test(file.name);
    const reader = new FileReader();
    if (isImage) {
      reader.onload = () => {
        const dataUrl = reader.result;
        const dataBase64 = dataUrl.split(',')[1];
        pendingAttachment = { name: file.name, mimeType: file.type, dataBase64, dataUrl };
        renderAttachmentPreview();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        pendingAttachment = { name: file.name, mimeType: file.type || 'text/plain', text: reader.result };
        renderAttachmentPreview();
      };
      reader.readAsText(file, 'utf-8');
    }
  });
}

if (advisorSendBtn && advisorInput) {
  advisorSendBtn.addEventListener('click', async () => {
    await handleAdvisorSend();
    refreshAdvisorIssues();
  });
  advisorInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      await handleAdvisorSend();
      refreshAdvisorIssues();
    }
  });
  advisorInput.addEventListener('input', autoResizeAdvisorInput);
  autoResizeAdvisorInput();
} else {
  setAdvisorStatus("צ'אט לא נטען: חסרים advisorSendBtn או advisorInput", 'err');
}

/** Why: show a scrollable list of past issues the advisor remembers, with version tags + resolve button.
 *  What: fetches /api/advisor/issues with current filter, renders cards; "נפתרה" posts to resolve endpoint. */
const advisorIssuesList = document.getElementById('advisorIssuesList');
const advisorIssuesRefreshBtn = document.getElementById('advisorIssuesRefresh');
const advisorIssueFilterInputs = document.querySelectorAll('input[name="advIssueFilter"]');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAdvisorIssues(issues) {
  if (!advisorIssuesList) return;
  if (!issues || issues.length === 0) {
    advisorIssuesList.innerHTML = '<div class="advisor-issues-empty">אין בעיות שמורות עדיין. כל שיחה עם היועץ תישמר אוטומטית.</div>';
    return;
  }
  advisorIssuesList.innerHTML = issues
    .map((it) => {
      const versions = [];
      if (it.app_version) versions.push(`Console ${it.app_version}`);
      if (it.agent_version) versions.push(`Agent ${it.agent_version}`);
      if (it.fc_firmware_version) versions.push(`FC ${it.fc_firmware_version}`);
      if (it.internal_fw_version) versions.push(`FW ${it.internal_fw_version}`);
      const versionChips = versions
        .map((v) => `<span class="issue-chip version" title="גרסאות כפי שנרשמו בזמן שמירת השיחה (היסטורי)">${escapeHtml(v)}</span>`)
        .join('');
      const tagChips = it.tags
        ? it.tags
            .split(',')
            .filter(Boolean)
            .map((t) => `<span class="issue-chip tag">${escapeHtml(t)}</span>`)
            .join('')
        : '';
      const statusLabel = it.status === 'resolved' ? '✓ נפתר' : it.status === 'wont_fix' ? '✗ לא רלוונטי' : '◯ פתוח';
      const resolutionHtml = it.resolution
        ? `<div class="issue-resolution">פתרון: ${escapeHtml(it.resolution)}</div>`
        : '';
      const actionsHtml =
        it.status === 'open'
          ? `<div class="issue-actions">
               <button type="button" class="issue-btn-resolve" data-action="resolve" data-id="${it.id}">נפתר</button>
               <button type="button" class="issue-btn-delete" data-action="delete" data-id="${it.id}">מחק</button>
             </div>`
          : `<div class="issue-actions">
               <button type="button" class="issue-btn-reopen" data-action="reopen" data-id="${it.id}">פתח</button>
               <button type="button" class="issue-btn-delete" data-action="delete" data-id="${it.id}">מחק</button>
             </div>`;
      const activeCls = Number(activeIssueId) === Number(it.id) ? ' active' : '';
      return `
        <div class="advisor-issue-card ${it.status}${activeCls}" data-issue-id="${it.id}" role="button" tabindex="0">
          <div class="issue-head">
            <span class="issue-title">#${it.id} ${escapeHtml(it.title || '(ללא כותרת)')}</span>
            <span class="issue-meta">
              <span>${statusLabel}</span>
              <span>· ${it.hit_count || 1} פניות</span>
              <span>· ${escapeHtml((it.updated_at || '').slice(0, 16))}</span>
              ${tagChips}
              ${versionChips}
            </span>
          </div>
          <div class="issue-summary">${escapeHtml(String(it.summary || '').slice(0, 400))}</div>
          ${resolutionHtml}
          ${actionsHtml}
        </div>`;
    })
    .join('');
}

async function refreshAdvisorIssues() {
  if (!advisorIssuesList) return;
  const filterEl = Array.from(advisorIssueFilterInputs).find((i) => i.checked);
  const filter = filterEl ? filterEl.value : 'open';
  const sep = filter === 'all' ? '?' : '?status=' + encodeURIComponent(filter) + '&';
  const qs = `${sep}_=${Date.now()}`;
  try {
    const res = await fetch(`/api/advisor/issues${qs}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok) renderAdvisorIssues(data.issues || []);
  } catch {
    // silent — memory is best-effort
  }
}

async function resolveAdvisorIssue(id, status) {
  let resolution = null;
  if (status === 'resolved') {
    // Two-step: explicit text confirmation prevents accidental resolve.
    resolution = window.prompt(
      'סימון כנפתרה\n\nרשום בקצרה מה הפתרון (חובה — ריק = ביטול):',
      '',
    );
    if (resolution === null || resolution.trim() === '') return; // user cancelled or left blank
    resolution = resolution.trim();
  }
  try {
    await fetch(`/api/advisor/issues/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, resolution }),
    });
    refreshAdvisorIssues();
  } catch {
    // silent
  }
}

async function deleteAdvisorIssue(id) {
  try {
    const delUrl = `/api/advisor/issues/${encodeURIComponent(id)}?t=${Date.now()}`;
    const res = await fetch(delUrl, {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const ct = res.headers.get('content-type') || '';
    const isJson = ct.includes('json');
    const data = isJson ? await res.json().catch(() => ({})) : {};
    if (!res.ok || data.ok === false) {
      let errMsg = data?.message;
      if (errMsg && String(errMsg).toLowerCase() === 'not found') {
        errMsg = 'הבעיה לא נמצאה (ייתכן שכבר נמחקה). רעננו את הרשימה.';
      } else if (!errMsg && res.status === 404) {
        errMsg =
          'השרת החזיר 404 — כנראה שתהליך השרת ישן ולא מטען את נתיבי היועץ. הפעילו מחדש: קיצור שולחן העבודה (מעדכן PM2 אוטומטית), או `npm run start:clean`, או `pm2 restart vision-landing-console`.';
      } else if (!errMsg) {
        errMsg = `מחיקה נכשלה (HTTP ${res.status})`;
      }
      setAdvisorStatus(errMsg, 'err');
      return;
    }
    setAdvisorStatus('הבעיה נמחקה מהרשימה.', '');
    if (Number(activeIssueId) === Number(id)) startNewAdvisorThread();
    await refreshAdvisorIssues();
  } catch (e) {
    setAdvisorStatus(`מחיקה נכשלה: ${e?.message || e}`, 'err');
  }
}

if (advisorIssuesList) {
  advisorIssuesList.addEventListener(
    'click',
    (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const id = Number(btn.dataset.id);
      const action = btn.dataset.action;
      if (!id || !action) return;
      if (action === 'resolve') resolveAdvisorIssue(id, 'resolved');
      else if (action === 'reopen') resolveAdvisorIssue(id, 'open');
      else if (action === 'delete') deleteAdvisorIssue(id);
      return;
    }
    const card = e.target.closest('.advisor-issue-card[data-issue-id]');
    if (card) {
      const issueId = Number(card.dataset.issueId);
      if (Number.isFinite(issueId) && issueId > 0) loadIssueIntoChat(issueId);
    }
  },
    true,
  );
  advisorIssuesList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest?.('.advisor-issue-card[data-issue-id]');
    if (!card) return;
    e.preventDefault();
    const issueId = Number(card.dataset.issueId);
    if (Number.isFinite(issueId) && issueId > 0) loadIssueIntoChat(issueId);
  });
}

if (advisorMessages) {
  advisorMessages.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="toggle-msg-resolve"][data-message-id]');
    if (!btn) return;
    const id = Number(btn.dataset.messageId);
    if (!Number.isFinite(id) || id < 1) return;
    const nextResolved = !btn.classList.contains('resolved');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/advisor/messages/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: nextResolved }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      btn.classList.toggle('resolved', nextResolved);
      btn.classList.toggle('open', !nextResolved);
      btn.textContent = nextResolved ? 'נפתר' : 'לא נפתר';
      const msg = btn.closest('.msg.user');
      if (msg) msg.classList.toggle('resolved', nextResolved);
    } catch (err) {
      setAdvisorStatus(`שגיאה בעדכון סטטוס שאלה: ${err?.message || err}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}
if (advisorIssuesRefreshBtn) advisorIssuesRefreshBtn.addEventListener('click', refreshAdvisorIssues);
advisorIssueFilterInputs.forEach((inp) => inp.addEventListener('change', refreshAdvisorIssues));
refreshAdvisorIssues();

// Quick-prompt chips on the empty state
if (advisorMessages) {
  advisorMessages.addEventListener('click', (e) => {
    const chip = e.target.closest('.adv-chip[data-prompt]');
    if (!chip) return;
    const prompt = chip.dataset.prompt;
    if (!prompt || !advisorInput) return;
    advisorInput.value = prompt;
    autoResizeAdvisorInput();
    advisorInput.focus();
    // Auto-send after a brief pause so user sees it filled
    setTimeout(() => handleAdvisorSend(), 120);
  });
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
    if (advisorStatus) advisorStatus.textContent = 'הושלם הקלט — ערוך ושלח';
  };
  rec.onend = () => advisorMicBtn.classList.remove('recording');
  rec.onerror = () => {
    advisorMicBtn.classList.remove('recording');
    if (advisorStatus) advisorStatus.textContent = 'מיקרופון: שגיאה';
  };
  advisorMicBtn.addEventListener('click', () => {
    try {
      rec.start();
      advisorMicBtn.classList.add('recording');
      if (advisorStatus) advisorStatus.textContent = 'מאזין…';
    } catch {
      if (advisorStatus) advisorStatus.textContent = 'לא ניתן להתחיל הקלטה';
    }
  });
} else if (advisorMicBtn) {
  advisorMicBtn.disabled = true;
  advisorMicBtn.title = 'הדפדפן לא תומך בדיבור לטקסט';
}
/* Welcome line is static in index.html (data-static-welcome) — avoids empty chat if script stops early. */
renderProcessFlow();

const versionBtn = document.getElementById('versionBtn');
const versionModal = document.getElementById('versionModal');
const versionModalContent = document.getElementById('versionModalContent');
const closeVersionModalBtn = document.getElementById('closeVersionModalBtn');

/** Why: changelog.json is the single source of truth; modal reconciles it with APP_VERSION_NEW (from version.js via meta tag) so the badge and the ★ always match.
 *  What: renders structured entries with type badges; emits a leading synthetic entry when the real version has no changelog row yet. */
const CHANGE_TYPE_META = {
  feat:     { label: 'FEAT',  cls: 'cl-type-feat'     },
  fix:      { label: 'FIX',   cls: 'cl-type-fix'      },
  ui:       { label: 'UI',    cls: 'cl-type-ui'       },
  refactor: { label: 'REFAC', cls: 'cl-type-refactor' },
  chore:    { label: 'CHORE', cls: 'cl-type-chore'    },
  perf:     { label: 'PERF',  cls: 'cl-type-perf'     },
  docs:     { label: 'DOCS',  cls: 'cl-type-chore'    },
};

function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _renderChangeLine(c) {
  if (typeof c === 'string') {
    return `<li class="cl-change"><span class="cl-type cl-type-feat">FEAT</span><span class="cl-text">${_escHtml(c)}</span></li>`;
  }
  const meta = CHANGE_TYPE_META[c.type] || CHANGE_TYPE_META.feat;
  const title = _escHtml(c.title || '');
  const detail = c.detail ? `<div class="cl-detail">${_escHtml(c.detail)}</div>` : '';
  return `<li class="cl-change"><span class="cl-type ${meta.cls}">${meta.label}</span><div class="cl-body"><div class="cl-title">${title}</div>${detail}</div></li>`;
}

function _renderEntry(entry, isCurrent) {
  const date = entry.date ? `<span class="cl-date">${_escHtml(entry.date)}</span>` : '';
  const star = isCurrent ? '<span class="cl-star" aria-label="current">★</span>' : '';
  const head = `<h3 class="cl-version${isCurrent ? ' cl-current' : ''}">${star}גרסה ${_escHtml(entry.version)}${date}</h3>`;
  const list = entry.changes && entry.changes.length
    ? `<ul class="cl-list">${entry.changes.map(_renderChangeLine).join('')}</ul>`
    : `<div class="cl-empty">אין תיעוד לגרסה זו.</div>`;
  return `<section class="cl-entry${isCurrent ? ' cl-entry-current' : ''}">${head}${list}</section>`;
}

/** Why: changelog uses dotted versions (e.g. 1.02.159); compare numerically per segment. */
function semverParse(v) {
  const s = String(v ?? '').replace(/^v/i, '').trim();
  const parts = s.split('.').map((x) => parseInt(x, 10));
  return parts.map((n) => (Number.isFinite(n) ? n : 0));
}
/** @returns {-1|0|1} */
function semverCompare(a, b) {
  const pa = semverParse(a);
  const pb = semverParse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

function renderVersionModal() {
  if (!versionModalContent) return;
  const currentVer =
    document.querySelector('meta[name="app-version"]')?.getAttribute('content') || APP_VERSION_NEW;
  let entries = Array.isArray(VERSION_HISTORY) ? VERSION_HISTORY.slice() : [];

  const hasCurrent = entries.some((e) => e.version === currentVer);
  if (!hasCurrent && currentVer && currentVer !== '0.0.0') {
    const today = new Date().toISOString().slice(0, 10);
    entries = [{
      version: currentVer,
      date: today,
      changes: [{ type: 'chore', title: 'auto-bumped', detail: 'עדיין אין תיעוד ידני לגרסה זו — ראה git log או ערוך public/changelog.json.' }],
      _synthetic: true,
    }, ...entries];
  }

  if (entries.length === 0) {
    versionModalContent.innerHTML = `<div class="cl-empty">טעינת changelog נכשלה. בדוק ש-public/changelog.json קיים.</div>`;
    return;
  }

  const leadVer = entries[0].version;
  let banner = '';
  if (leadVer && currentVer && currentVer !== '0.0.0' && leadVer !== currentVer) {
    const cmp = semverCompare(currentVer, leadVer);
    if (cmp < 0) {
      banner = `<div class="cl-banner cl-banner-warn">שים לב: הדפדפן מציג גרסה <strong>רצה</strong> v${_escHtml(currentVer)}, בעוד ש־<code>public/changelog.json</code> על הדיסק כבר ב־v${_escHtml(leadVer)}. בדרך כלל השרת לא הופעל מחדש אחרי משיכת קוד — <strong>עצור והפעל מחדש</strong> את Node (<code>node server.js</code> או <code>start-vision-landing-console.bat</code>) מתיקיית VisionLandingConsole, ואז רענון קשיח.</div>`;
    } else if (cmp > 0) {
      banner = `<div class="cl-banner cl-banner-warn">שים לב: הגרסה המדווחת v${_escHtml(currentVer)} חדשה מ־v${_escHtml(leadVer)} ב-changelog. הרץ <code>npm run bump</code> או עדכן ידנית את <code>public/changelog.json</code>.</div>`;
    }
  }

  versionModalContent.innerHTML = banner + entries.map((e) => _renderEntry(e, e.version === currentVer)).join('');
}

if (versionBtn && versionModal) {
  /** Badge text comes from server-rendered index.html; `applyServerAppVersion` keeps it aligned with /api/health + SSE.
   *  Do not reset here from `APP_VERSION_NEW` — that constant is frozen at parse time and could disagree after sync. */
  versionBtn.addEventListener('click', async () => {
    if (!VERSION_HISTORY || VERSION_HISTORY.length === 0) await loadChangelog();
    renderVersionModal();
    versionModal.classList.remove('hidden');
  });
  setTimeout(() => { void syncServerAppVersion(); }, 200);
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

/* ── Pre-flight status card ─────────────────────────────────────────── */
(function initPreflightCard() {
  const card = document.getElementById('preflightCard');
  if (!card) return;

  function setRow(id, status, value) {
    const icon  = document.getElementById(`pf-${id}-icon`);
    const val   = document.getElementById(`pf-${id}-val`);
    if (!icon || !val) return;
    const MAP = { ok: '✓', warn: '⚠', fail: '✗', pending: '○' };
    icon.textContent = MAP[status] ?? '○';
    icon.className = `pf-icon ${status}`;
    val.textContent = value;
    val.className = `pf-value ${status}`;
  }

  async function refresh() {
    // MAVLink + ARMED state
    try {
      const d = await fetch('/api/ardu/params').then((r) => r.json());
      if (d.mavlinkConnected) {
        setRow('mavlink', 'ok', `מחובר (${d.paramCount ?? '?'} params)`);
      } else {
        setRow('mavlink', 'fail', 'לא מחובר');
      }
      if (d.armed === true) {
        setRow('armed', 'warn', 'ARMED');
      } else if (d.armed === false) {
        setRow('armed', 'ok', 'Disarmed');
      } else {
        setRow('armed', 'pending', 'לא ידוע');
      }
      // Params match check
      if (d.connected && d.current) {
        const mismatches = Object.entries(arduTargetState).filter(([k, v]) => {
          const fc = d.current[k];
          return fc != null && Math.abs(Number(fc) - Number(v)) > 0.001;
        });
        if (mismatches.length === 0) {
          setRow('params', 'ok', 'מסונכרן');
        } else {
          setRow('params', 'warn', `${mismatches.length} פרמטרים שונים`);
        }
        // Update WRITE button styling too
        refreshArduWriteBtnState(d);
      } else if (!d.connected) {
        setRow('params', 'pending', 'לא קראנו עדיין');
        refreshArduWriteBtnState(d);
      }
    } catch {
      setRow('mavlink', 'fail', 'שגיאת רשת');
    }

    // Jetson
    try {
      const j = await fetch('/api/rpi/status').then((r) => r.json());
      if (j.online) {
        setRow('jetson', 'ok', 'מחובר');
      } else {
        setRow('jetson', 'fail', 'לא מחובר');
      }
    } catch {
      setRow('jetson', 'fail', 'שגיאת רשת');
    }

    // GPS — use the manual satellite count input on the takeoff-readiness card.
    const satsInput = document.getElementById('gpsSatsInput');
    const sats = satsInput ? Number(satsInput.value) : NaN;
    if (!isNaN(sats) && sats >= 6) {
      setRow('gps', 'ok', `${sats} לוויינים`);
    } else if (!isNaN(sats) && sats > 0) {
      setRow('gps', 'warn', `${sats} לוויינים (חלש)`);
    } else if (!isNaN(sats) && sats === 0) {
      setRow('gps', 'fail', 'אין GPS (0 לוויינים)');
    } else {
      setRow('gps', 'pending', 'הזן מספר לוויינים בטאב הזנקה');
    }
  }

  document.getElementById('preflightRefreshBtn')?.addEventListener('click', refresh);
  // Auto-refresh on first load when the arduParams subtab becomes visible.
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) refresh();
  }, { threshold: 0.1 });
  observer.observe(card);
})();
const arduDiffSection = document.getElementById('arduDiffSection');
const arduDiffTable = document.getElementById('arduDiffTable');
const arduDiffSummary = document.getElementById('arduDiffSummary');

function clearArduDiff() {
  if (arduDiffSection) arduDiffSection.classList.remove('visible');
  if (arduDiffTable) arduDiffTable.innerHTML = '';
  if (arduDiffSummary) arduDiffSummary.textContent = '';
}
clearArduDiff();

/** Why: after reading or writing, shows a clear diff table of every parameter — green=match, red=mismatch. What: renders rows with current vs target value comparison. */
function renderArduDiff(current, target) {
  if (!arduDiffTable || !arduDiffSection) return;
  const rows = Object.entries(target).map(([key, want]) => {
    const onFc = current != null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key);
    const have = onFc ? current[key] : undefined;
    const match = onFc && String(have) === String(want);
    const fcCell = onFc
      ? '<span class="diff-fc-mark diff-fc-mark--yes">✓ בבקר</span>'
      : '<span class="diff-fc-mark diff-fc-mark--no">✗ לא בבקר</span>';
    return `<tr class="${match ? 'diff-match' : 'diff-mismatch'}">
      <td class="diff-key">${key}</td>
      <td class="diff-fc-col">${fcCell}</td>
      <td class="diff-have">${onFc ? have : '—'}</td>
      <td class="diff-want">${want}</td>
      <td class="diff-status">${match ? '✓' : '⚠ שונה'}</td>
    </tr>`;
  }).join('');
  arduDiffTable.innerHTML = `<table class="diff-inner">
    <thead><tr><th>פרמטר</th><th>בבקר?</th><th>בדרון עכשיו</th><th>יותקן</th><th>סטטוס</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  arduDiffSection.classList.add('visible');
  const mismatches = Object.entries(target).filter(([k, want]) => {
    const onFc = current != null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, k);
    const have = onFc ? current[k] : undefined;
    return !(onFc && String(have) === String(want));
  }).length;
  const missingOnFc = Object.keys(target).filter((k) =>
    !(current != null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, k)),
  ).length;
  if (arduDiffSummary) {
    arduDiffSummary.textContent = mismatches === 0
      ? '✓ כל הפרמטרים כבר תואמים — אין צורך ב-WRITE לרחפן'
      : `${mismatches} פרמטרים שונים או חסרים בבקר — לחץ WRITE לרחפן להחלתם${missingOnFc > 0 ? ` (${missingOnFc} לא בבקר)` : ''}`;
    arduDiffSummary.style.color = mismatches === 0 ? '#4ade80' : '#fbbf24';
  }
}

if (arduReadBtn) {
  arduReadBtn.addEventListener('click', async () => {
    arduReadBtn.textContent = '⏳ קורא…';
    try {
      const res = await fetch('/api/ardu/params');
      const d = await res.json();
      arduReadBtn.textContent = '📥 READ — מהרחפן';
      // Update WRITE button state based on MAVLink presence + ARMED status.
      refreshArduWriteBtnState(d);
      if (!d.connected || !d.current) {
        fcCurrentSnapshot = null;
        clearArduDiff();
        if (arduWriteStatus) {
          const hint = d.mavlinkConnected
            ? `MAVLink מחובר אך פרמטרים עדיין לא התקבלו (${d.paramCount ?? 0})`
            : 'לא מחובר — חבר דרך ה-Connect widget תחילה';
          arduWriteStatus.textContent = hint;
          arduWriteStatus.className = 'ardu-write-status fail';
        }
      } else {
        fcCurrentSnapshot = { ...d.current };
        renderArduDiff(d.current, arduTargetState);
        const paramStr = d.paramCount != null ? ` (${d.paramCount} פרמטרים)` : '';
        if (arduWriteStatus) {
          arduWriteStatus.textContent = `READ הושלם${paramStr} — תגיות «בבקר / לא בבקר» מתעדכנות בכרטיסים`;
          arduWriteStatus.className = 'ardu-write-status success';
        }
      }
      updateParamSyncBanner();
      renderArduParamForm();
    } catch {
      arduReadBtn.textContent = '📥 READ — מהרחפן';
    }
  });
}

/**
 * Update the WRITE button appearance based on MAVLink / ARMED state.
 * Called after READ and also periodically via the SSE telemetry handler.
 */
function refreshArduWriteBtnState(arduStatus) {
  if (!arduWriteBtn) return;
  const { mavlinkConnected, armed } = arduStatus || {};
  if (!mavlinkConnected) {
    arduWriteBtn.classList.remove('ardu-write-armed');
    arduWriteBtn.classList.add('ardu-write-disconnected');
    arduWriteBtn.title = 'לא מחובר MAVLink — WRITE יפעל במצב סימולציה בלבד';
  } else if (armed === true) {
    arduWriteBtn.classList.add('ardu-write-armed');
    arduWriteBtn.classList.remove('ardu-write-disconnected');
    arduWriteBtn.title = 'המטוס ARMED — WRITE חסום. Disarm ונסה שוב.';
  } else {
    arduWriteBtn.classList.remove('ardu-write-armed', 'ardu-write-disconnected');
    arduWriteBtn.title = 'כתוב פרמטרים ל-FC דרך MAVLink';
  }
}

/** Why: WRITE to FC via real MAVLink (or simulated if disconnected). */
if (arduWriteBtn) {
  arduWriteBtn.addEventListener('click', async () => {
    arduWriteBtn.disabled = true;
    if (arduWriteStatus) {
      arduWriteStatus.textContent = 'שולח…';
      arduWriteStatus.className = 'ardu-write-status';
    }
    try {
      const res = await fetch('/api/ardu/params/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const d = await res.json();
      if (!res.ok && d.code === 'armed') {
        if (arduWriteStatus) {
          arduWriteStatus.textContent = '⛔ ARMED — WRITE חסום. Disarm תחילה.';
          arduWriteStatus.className = 'ardu-write-status fail';
        }
      } else if (!res.ok && d.code === 'armed_unknown') {
        if (arduWriteStatus) {
          arduWriteStatus.textContent = '⚠ מצב ARMED לא ידוע — WRITE חסום עד לקבלת heartbeat.';
          arduWriteStatus.className = 'ardu-write-status fail';
        }
      } else if (!res.ok && d.code === 'not_connected') {
        if (arduWriteStatus) {
          arduWriteStatus.textContent = 'לא מחובר — חבר MAVLink תחילה.';
          arduWriteStatus.className = 'ardu-write-status fail';
        }
      } else if (d.ok) {
        // Real write succeeded — update snapshot from echoed MAVLink values.
        fcCurrentSnapshot = { ...arduTargetState };
        if (arduWriteStatus) {
          const simNote = d.simulated ? ' (סימולציה — אין MAVLink)' : '';
          const failNote = d.failed?.length ? ` — ${d.failed.length} פרמטרים נכשלו` : '';
          arduWriteStatus.textContent = (d.message || 'WRITE הושלם') + simNote + failNote;
          arduWriteStatus.className = d.failed?.length ? 'ardu-write-status warn' : 'ardu-write-status success';
        }
        if (fcCurrentSnapshot && arduDiffTable && arduDiffSection) {
          renderArduDiff(fcCurrentSnapshot, arduTargetState);
        }
      } else {
        if (arduWriteStatus) {
          arduWriteStatus.textContent = d.message || 'WRITE נכשל';
          arduWriteStatus.className = 'ardu-write-status fail';
        }
      }
      updateParamSyncBanner();
      renderArduParamForm();
    } catch {
      if (arduWriteStatus) {
        arduWriteStatus.textContent = 'שגיאת רשת';
        arduWriteStatus.className = 'ardu-write-status fail';
      }
    } finally {
      arduWriteBtn.disabled = false;
    }
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

/** @type {object | null} */
let lastSseTerrainPayload = null;
/** Set true after successful "הצג נתיב טעון" — draws home + mission on maps. */
let showLoadedMissionPath = false;

const jetsonTelemetryMap = null; // map removed from telemetry tab
const jetsonStreetLayer = null;

/** @type {{ gps: L.Marker | null, vision: L.Marker | null, home: L.CircleMarker | null, mission: L.Polyline | null, replayTrack: L.Polyline | null }} */
const terrainFlightLayers = { gps: null, vision: null, home: null, mission: null, replayTrack: null };
/** @type {{ gps: L.Marker | null, vision: L.Marker | null, home: L.CircleMarker | null, mission: L.Polyline | null, replayTrack: L.Polyline | null }} */
const jetsonFlightLayers = { gps: null, vision: null, home: null, mission: null, replayTrack: null };

/** Sim-lab .tlog replay — optional polyline + GPS marker overlay on terrain map. */
let simLabReplayTrackPts = null;
/** @type {{ gpsLat: number, gpsLon: number, globalHdgDeg?: number | null } | null} */
let simLabReplayMapSample = null;

function terrainPlaneDivIcon(color, hdgDeg) {
  const r = Number.isFinite(hdgDeg) ? hdgDeg - 45 : -45;
  return L.divIcon({
    className: 'terrain-plane-icon-wrap',
    html: `<div class="terrain-plane-icon" style="color:${color};transform:rotate(${r}deg)">✈</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function clearPathHomeOnMap(map, layers) {
  if (!map) return;
  if (layers.home) {
    map.removeLayer(layers.home);
    layers.home = null;
  }
  if (layers.mission) {
    map.removeLayer(layers.mission);
    layers.mission = null;
  }
}

/** Why: SSE carries mavlink.map + vision; sim-lab replay can add track + GPS marker; what: GPS/DR + optical markers; home+mission only after user loads path. */
function applyFlightOverlayToMap(map, layers) {
  if (!map) return;
  if (
    !lastSseTerrainPayload &&
    !simLabReplayMapSample &&
    !(simLabReplayTrackPts && simLabReplayTrackPts.length >= 2)
  ) {
    return;
  }

  const sseMap = lastSseTerrainPayload?.mavlink?.map;
  const mapData =
    simLabReplayMapSample &&
    Number.isFinite(simLabReplayMapSample.gpsLat) &&
    Number.isFinite(simLabReplayMapSample.gpsLon)
      ? {
          ...sseMap,
          gpsLat: simLabReplayMapSample.gpsLat,
          gpsLon: simLabReplayMapSample.gpsLon,
          globalHdgDeg:
            simLabReplayMapSample.globalHdgDeg != null &&
            Number.isFinite(simLabReplayMapSample.globalHdgDeg)
              ? simLabReplayMapSample.globalHdgDeg
              : sseMap?.globalHdgDeg ?? null,
          gpsSource: 'SIMLAB_REPLAY',
        }
      : sseMap;
  const vision = lastSseTerrainPayload?.vision;
  const hdg = mapData?.globalHdgDeg ?? null;

  if (simLabReplayTrackPts && simLabReplayTrackPts.length >= 2) {
    if (!layers.replayTrack) {
      layers.replayTrack = L.polyline(simLabReplayTrackPts, {
        color: '#ca8a04',
        weight: 3,
        opacity: 0.82,
        dashArray: '8 6',
      }).addTo(map);
      try {
        layers.replayTrack.bindTooltip('שיחזור .tlog', { sticky: true });
      } catch { /* ignore */ }
    } else {
      layers.replayTrack.setLatLngs(simLabReplayTrackPts);
    }
  } else if (layers.replayTrack) {
    map.removeLayer(layers.replayTrack);
    layers.replayTrack = null;
  }

  if (mapData && Number.isFinite(mapData.gpsLat) && Number.isFinite(mapData.gpsLon)) {
    const src = mapData.gpsSource;
    const planeTitle =
      src === 'SIMLAB_REPLAY'
        ? 'שיחזור לוג (.tlog)'
        : src === 'GLOBAL_POS'
          ? 'GPS / מיקום מסונן (EKF)'
          : 'GPS / DR';
    if (!layers.gps) {
      layers.gps = L.marker([mapData.gpsLat, mapData.gpsLon], {
        icon: terrainPlaneDivIcon('#0b6bcb', hdg),
        title: planeTitle,
      }).addTo(map);
    } else {
      layers.gps.setLatLng([mapData.gpsLat, mapData.gpsLon]);
      layers.gps.setIcon(terrainPlaneDivIcon('#0b6bcb', hdg));
    }
  } else if (layers.gps) {
    map.removeLayer(layers.gps);
    layers.gps = null;
  }

  if (vision && Number.isFinite(vision.navLat) && Number.isFinite(vision.navLon)) {
    if (!layers.vision) {
      layers.vision = L.marker([vision.navLat, vision.navLon], {
        icon: terrainPlaneDivIcon('#ea580c', null),
        title: 'ניווט אופטי',
      }).addTo(map);
    } else {
      layers.vision.setLatLng([vision.navLat, vision.navLon]);
    }
  } else if (layers.vision) {
    map.removeLayer(layers.vision);
    layers.vision = null;
  }

  if (!showLoadedMissionPath) {
    clearPathHomeOnMap(map, layers);
    return;
  }

  if (mapData && Number.isFinite(mapData.homeLat) && Number.isFinite(mapData.homeLon)) {
    if (!layers.home) {
      layers.home = L.circleMarker([mapData.homeLat, mapData.homeLon], {
        radius: 7,
        color: '#15803d',
        fillColor: '#22c55e',
        fillOpacity: 0.88,
        weight: 2,
      })
        .addTo(map)
        .bindTooltip('בית', { direction: 'top' });
    } else {
      layers.home.setLatLng([mapData.homeLat, mapData.homeLon]);
    }
  } else if (layers.home) {
    map.removeLayer(layers.home);
    layers.home = null;
  }

  if (mapData?.mission?.length >= 2) {
    const pts = mapData.mission
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => [p.lat, p.lon]);
    if (pts.length >= 2) {
      if (!layers.mission) {
        layers.mission = L.polyline(pts, { color: '#6d28d9', weight: 3, opacity: 0.85 }).addTo(map);
      } else {
        layers.mission.setLatLngs(pts);
      }
    } else if (layers.mission) {
      map.removeLayer(layers.mission);
      layers.mission = null;
    }
  } else if (layers.mission) {
    map.removeLayer(layers.mission);
    layers.mission = null;
  }
}

function updateFlightOverlaysOnAllMaps(payload) {
  if (payload) lastSseTerrainPayload = payload;
  if (
    !lastSseTerrainPayload &&
    !simLabReplayMapSample &&
    !(simLabReplayTrackPts && simLabReplayTrackPts.length >= 2)
  ) {
    return;
  }
  applyFlightOverlayToMap(terrainMap, terrainFlightLayers);
  applyFlightOverlayToMap(jetsonTelemetryMap, jetsonFlightLayers);
}

window.__vlcSimLabReplayOverlay = {
  setTrack(latLngs) {
    simLabReplayTrackPts =
      Array.isArray(latLngs) && latLngs.length >= 2
        ? latLngs.map((p) => [Number(p[0]), Number(p[1])])
        : null;
    updateFlightOverlaysOnAllMaps();
  },
  setSample(lat, lon, headingDeg) {
    if (
      lat == null ||
      lon == null ||
      !Number.isFinite(Number(lat)) ||
      !Number.isFinite(Number(lon))
    ) {
      simLabReplayMapSample = null;
    } else {
      const h = headingDeg != null ? Number(headingDeg) : NaN;
      simLabReplayMapSample = {
        gpsLat: Number(lat),
        gpsLon: Number(lon),
        globalHdgDeg: Number.isFinite(h) ? h : null,
      };
    }
    updateFlightOverlaysOnAllMaps();
  },
  clear() {
    simLabReplayTrackPts = null;
    simLabReplayMapSample = null;
    updateFlightOverlaysOnAllMaps();
  },
};

/** Why: map must exist before coverage circles and basemap toggles; what: creates L.map once with leaflet-rotate, OSM/Esri layers, and bearing control. */
function initTerrainMap() {
  const mapEl = document.getElementById('terrainMap');
  if (!mapEl || terrainMap) return;

  const israelBounds = L.latLngBounds([29.0, 33.5], [33.7, 36.5]);
  const mapOpts = {
    zoomControl: true,
    rotate: true,
    bearing: 0,
    minZoom: 9,
    maxBounds: israelBounds,
    maxBoundsViscosity: 1.0,
  };
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
  terrainMap.setView([31.5, 34.85], 9);

  /** Why: modern circular compass replaces linear slider — more intuitive for bearing/rotation. What: drag the SVG rose to rotate the map; shows live bearing; N button snaps to north. */
  const BearingCtrl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd(m) {
      const wrap = L.DomUtil.create('div', 'terrain-compass-wrap');
      // Build tick marks SVG string
      const ticks = Array.from({ length: 36 }, (_, i) => {
        const deg = i * 10;
        const isMajor = deg % 90 === 0;
        const isMid = deg % 45 === 0 && !isMajor;
        const rInner = isMajor ? 40 : isMid ? 44 : 48;
        const rOuter = 54;
        const rad = (deg - 90) * Math.PI / 180;
        const x1 = 60 + Math.cos(rad) * rInner, y1 = 60 + Math.sin(rad) * rInner;
        const x2 = 60 + Math.cos(rad) * rOuter, y2 = 60 + Math.sin(rad) * rOuter;
        const w = isMajor ? 2 : isMid ? 1.5 : 0.8;
        const col = isMajor ? 'rgba(0,71,141,0.55)' : 'rgba(0,71,141,0.28)';
        return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${col}" stroke-width="${w}"/>`;
      }).join('');

      wrap.innerHTML = `
        <div class="terrain-compass" role="group" aria-label="סיבוב המפה — גרור להסתובב">
          <svg class="terrain-compass-svg" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <radialGradient id="compassBg" cx="40%" cy="35%" r="60%">
                <stop offset="0%" stop-color="rgba(255,255,255,0.98)"/>
                <stop offset="100%" stop-color="rgba(220,233,255,0.92)"/>
              </radialGradient>
              <filter id="compassShadow" x="-15%" y="-15%" width="130%" height="130%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.22)"/>
              </filter>
            </defs>
            <circle cx="60" cy="60" r="57" fill="url(#compassBg)" filter="url(#compassShadow)" stroke="rgba(0,71,141,0.25)" stroke-width="1.5"/>
            ${ticks}
            <text x="60" y="13" text-anchor="middle" dominant-baseline="middle" class="compass-cardinal north-cardinal">N</text>
            <text x="60" y="107" text-anchor="middle" dominant-baseline="middle" class="compass-cardinal">S</text>
            <text x="107" y="62" text-anchor="middle" dominant-baseline="middle" class="compass-cardinal">E</text>
            <text x="13" y="62" text-anchor="middle" dominant-baseline="middle" class="compass-cardinal">W</text>
            <g class="compass-rose-group">
              <polygon points="60,22 56.5,58 63.5,58" fill="#00478d" opacity="0.92"/>
              <polygon points="60,98 56.5,62 63.5,62" fill="rgba(100,120,160,0.45)"/>
              <polygon points="60,22 60,98 63.5,60 60,58" fill="rgba(0,0,0,0.08)"/>
              <circle cx="60" cy="60" r="5.5" fill="#00478d" stroke="white" stroke-width="1.5"/>
            </g>
            <text class="compass-deg-label" x="60" y="71" text-anchor="middle">0°</text>
          </svg>
          <button class="compass-north-btn" title="איפוס לצפון (0°)">N</button>
        </div>`;

      const svg = wrap.querySelector('.terrain-compass-svg');
      const roseGroup = wrap.querySelector('.compass-rose-group');
      const degLabel = wrap.querySelector('.compass-deg-label');
      const northBtn = wrap.querySelector('.compass-north-btn');

      let currentBearing = 0;
      let dragging = false;
      let startPointerAngle = 0;
      let startBearing = 0;

      const getAngleFromCenter = (e) => {
        const rect = svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return Math.atan2(e.clientX - cx, -(e.clientY - cy)) * 180 / Math.PI;
      };

      const applyDeg = (d) => {
        let x = Number(d);
        if (!Number.isFinite(x)) x = 0;
        while (x > 180) x -= 360;
        while (x < -180) x += 360;
        currentBearing = x;
        if (typeof m.setBearing === 'function') m.setBearing(x);
        if (roseGroup) roseGroup.style.transform = `rotate(${x}deg)`;
        if (degLabel) degLabel.textContent = `${Math.round(Math.abs(x))}°`;
      };

      if (typeof m.setBearing !== 'function') {
        wrap.style.opacity = '0.45';
        wrap.title = 'leaflet-rotate לא זמין';
      } else {
        L.DomEvent.on(svg, 'pointerdown', (e) => {
          dragging = true;
          svg.setPointerCapture(e.pointerId);
          startPointerAngle = getAngleFromCenter(e);
          startBearing = currentBearing;
          e.preventDefault();
        });
        L.DomEvent.on(svg, 'pointermove', (e) => {
          if (!dragging) return;
          const delta = getAngleFromCenter(e) - startPointerAngle;
          applyDeg(startBearing + delta);
        });
        L.DomEvent.on(svg, 'pointerup', () => { dragging = false; });
        L.DomEvent.on(svg, 'pointercancel', () => { dragging = false; });
        L.DomEvent.on(northBtn, 'click', () => applyDeg(0));
        applyDeg(0);
      }

      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.disableScrollPropagation(wrap);
      return wrap;
    },
  });
  terrainMap.addControl(new BearingCtrl());

  // ── Fly-to right-click context menu ───────────────────────────────────────
  terrainMap.on('contextmenu', (e) => {
    const { lat, lng } = e.latlng;
    showMapFlyToMenu(lat, lng, e.originalEvent.clientX, e.originalEvent.clientY);
  });

  setTimeout(() => {
    terrainInvalidateLayout();
    updateFlightOverlaysOnAllMaps();
  }, 0);
}

/** Why: satellite vs street, or hide all tiles for “mapped only” white canvas; what: toggles tile pane and active TileLayer. */
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

/** Why: align circle colors with the legend (כחול נמוך → אדום גבוה); what: maps normalized altitude 0..1 to HSL hue 240..0. */
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

/** Why: pilot sees where visual nav was mapped at which AGL; what: draws circles colored by aglM/altM (min–max in view), popup keeps quality + radius. */
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
    circle.bindPopup(`גובה מיפוי (AGL): ${Math.round(altM)}m · איכות: ${Math.round(q * 100)}% · רדיוס: ${r.toFixed(0)}m`);
    terrainCircles.push(circle);
    totalArea += Math.PI * r * r;
  });
  if (terrainCellCount) terrainCellCount.textContent = String(list.length);
  if (terrainAreaEst) terrainAreaEst.textContent = list.length > 0 ? `${Math.round(totalArea)} m²` : '0 m²';
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

/** Why: radio cards under terrain must match server/SSE mode. What: syncs checked state, `.active` on labels, and status line. */
function applyVisionNavModeUi(mode) {
  const hint = document.getElementById('terrainNavModeHint');
  document.querySelectorAll('.terrain-nav-ref-option').forEach((label) => {
    const on = label.dataset.navMode === mode;
    label.classList.toggle('active', on);
    const inp = label.querySelector('input[type="radio"]');
    if (inp) inp.checked = on;
  });
  if (hint) {
    hint.textContent =
      mode === 'prior_mission_map'
        ? 'נשמר בשרת: ייחוס למפת כיסוי / טיסה קודמת (מוזרם גם ב־SSE לצינור Jetson).'
        : 'נשמר בשרת: ייחוס לצילום לוויין — דורש התאמת תנאי תאורה ורזולוציה בשטח.';
  }
}

/** Why: operator selects how the pipeline should compare the live frame. What: POST /api/vision/nav-mode and refresh local UI. */
async function postVisionNavMode(mode) {
  try {
    const res = await fetch('/api/vision/nav-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const d = await res.json();
    if (d.mode) applyVisionNavModeUi(d.mode);
  } catch {}
}

/** Why: opening terrain tab should show current nav reference without waiting for next SSE tick. What: GET /api/vision/nav-mode once. */
async function syncVisionNavModeFromServer() {
  try {
    const res = await fetch('/api/vision/nav-mode');
    const d = await res.json();
    if (d.mode) applyVisionNavModeUi(d.mode);
  } catch {}
}

function onTelemetryTabActivated() {
  // no-op: Jetson map was removed from telemetry tab
}

function onTerrainTabActivated() {
  setTimeout(() => {
    initTerrainMap();
    applyTerrainBasemapVisibility();
    loadTerrainCoverage();
    syncVisionNavModeFromServer();
    terrainInvalidateLayout();
    updateFlightOverlaysOnAllMaps();
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
    if (terrainAreaEst) terrainAreaEst.textContent = '0 m²';
    terrainInvalidateLayout();
  });
}

async function requestAndShowLoadedMissionPath(btn) {
  try {
    if (btn) btn.disabled = true;
    const res = await fetch('/api/mavlink/mission-refresh', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.ok) {
      showLoadedMissionPath = true;
      updateFlightOverlaysOnAllMaps();
    }
  } catch {
    /* ignore */
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('terrainShowLoadedPathBtn')?.addEventListener('click', async () => {
  await requestAndShowLoadedMissionPath(document.getElementById('terrainShowLoadedPathBtn'));
});

document.querySelectorAll('input[name="terrainNavRef"]').forEach((inp) => {
  inp.addEventListener('change', () => {
    if (inp.checked) postVisionNavMode(inp.value);
  });
});
syncVisionNavModeFromServer();

/* ─── CAMERA ANNOTATIONS ─── */
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

  const conf = latestVisionFromServer?.confidence ?? null;
  const lateral = latestVisionFromServer?.lateralOffsetM ?? null;

  // No live data — show "no data" overlay instead of fake animations.
  if (conf === null || lateral === null) {
    ctx.save();
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = 'rgba(250,204,21,0.85)';
    ctx.textAlign = 'center';
    ctx.fillText('NO LIVE VISION DATA', canvas.width / 2, canvas.height * 0.12);
    ctx.textAlign = 'left';
    ctx.restore();
    return;
  }

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
    lockIndicator.textContent = isLocked ? 'ננעל ✓' : isSearching ? 'מחפש…' : 'אין נעילה';
    lockIndicator.className = `lock-indicator ${isLocked ? 'locked' : isSearching ? 'searching' : 'no-lock'}`;
  }
  if (annotConfidence) annotConfidence.textContent = `ביטחון: ${Math.round(conf * 100)}%`;
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
    if (lockIndicator) { lockIndicator.textContent = 'אין נעילה'; lockIndicator.className = 'lock-indicator no-lock'; }
  });
  flightVideo.addEventListener('timeupdate', () => {
    if (flightVideo.paused) drawAnnotations(flightVideo, annotationCanvas);
  });
  window.addEventListener('resize', () => drawAnnotations(flightVideo, annotationCanvas));
}

if (annotationsToggleBtn) {
  annotationsToggleBtn.addEventListener('click', () => {
    annotationsEnabled = !annotationsEnabled;
    annotationsToggleBtn.textContent = `אנוטציות: ${annotationsEnabled ? 'פועל' : 'כבוי'}`;
    if (!annotationsEnabled && annotationCanvas) annotationCanvas.getContext('2d').clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  });
}

/** Why: show Gemini health on page load and refresh periodically so user sees live state. What: initial call + 60s interval. */
refreshAdvisorHealth();
setInterval(refreshAdvisorHealth, 60_000);

// ── Topbar CONNECT widget (Mission Planner style) ──────────────────────────
(() => {
  /** Why: compact topbar connection widget mirroring Mission Planner UX.
   *  What: dropdowns for type / port / baud, CONNECT toggle, STAT modal with live stats. */
  const widget = document.getElementById('connectWidget');
  if (!widget) return;

  const typeSel   = document.getElementById('connectType');
  const portList  = document.getElementById('connectPortList');
  const portInput = document.getElementById('connectPortInput');
  const baudSel   = document.getElementById('connectBaud');
  const connBtn   = document.getElementById('connectBtn');
  const connectAutoBtn = document.getElementById('connectAutoBtn');
  const statBtn   = document.getElementById('connectStatBtn');
  const dot       = document.getElementById('connectStatusDot');
  const modal     = document.getElementById('connectStatModal');
  const statBody  = document.getElementById('connectStatBody');
  const statAuto  = document.getElementById('connectStatAutoRefresh');
  const statRefr  = document.getElementById('connectStatRefreshBtn');
  const toggleBtn = document.getElementById('connectToggleBtn');
  const panel     = document.getElementById('connectPanel');
  const pillLabel = document.getElementById('connectPillLabel');
  const connectAutoProgress = document.getElementById('connectAutoProgress');
  const connectAutoStepper = document.getElementById('connectAutoStepper');
  const connectAutoChecklist = document.getElementById('connectAutoChecklist');
  const AUTO_CONNECT_PHASE_IDS = ['usb_serial', 'jetson_relay', 'sitl_local'];
  const AUTO_CONNECT_POLL_MS = 350;

  function setPillLabel(text) {
    if (pillLabel) pillLabel.textContent = text;
  }
  async function openPanel() {
    if (!panel || !toggleBtn) return;
    panel.hidden = false;
    toggleBtn.setAttribute('aria-expanded', 'true');
    refreshSerialPorts();
    await syncConnectionApiGate();
  }
  function closePanel() {
    if (!panel || !toggleBtn) return;
    panel.hidden = true;
    toggleBtn.setAttribute('aria-expanded', 'false');
  }
  function togglePanel() {
    if (!panel) return;
    if (panel.hidden) void openPanel();
    else closePanel();
  }

  const LS_KEY = 'vlc.connect.widget.v1';
  let currentId = null;
  let statusPollTimer = null;
  let statPollTimer = null;

  /** בולם הקלקות כפולות בזמן חיבור אוטומטי (הבקשה חוסמת עד החזרת JSON). */
  let autoConnectInFlight = false;
  let autoConnectReplayTimer = null;
  let autoConnectPollTimer = null;

  function clearAutoConnectReplay() {
    if (autoConnectReplayTimer) {
      clearInterval(autoConnectReplayTimer);
      autoConnectReplayTimer = null;
    }
  }

  function stopAutoConnectPoll() {
    if (autoConnectPollTimer) {
      clearInterval(autoConnectPollTimer);
      autoConnectPollTimer = null;
    }
  }

  function subStatusHe(sub) {
    if (sub === 'heartbeat') return 'ממתין ל-heartbeat';
    if (sub === 'activate') return 'פותח חיבור';
    if (sub === 'exhausted') return 'סיימנו את כל השלבים';
    return 'סורק יעדים';
  }

  function syncAutoConnectBridges() {
    if (!connectAutoStepper) return;
    const steps = [...connectAutoStepper.querySelectorAll('.conn-auto-step')];
    const bridges = [...connectAutoStepper.querySelectorAll('.conn-auto-bridge')];
    bridges.forEach((b, i) => {
      const left = steps[i]?.dataset.state || 'pending';
      if (left === 'done') b.dataset.state = 'done';
      else if (left === 'failed') b.dataset.state = 'failed';
      else if (left === 'active') b.dataset.state = 'active';
      else if (left === 'skipped') b.dataset.state = 'pending';
      else b.dataset.state = 'pending';
    });
  }

  function applyAutoConnectProgress(p) {
    if (!p) return;
    if (connectAutoStepper) {
      connectAutoStepper.classList.remove('hidden');
      const states = p.phaseStates || {};
      for (const li of connectAutoStepper.querySelectorAll('.conn-auto-step')) {
        const phase = li.dataset.phase;
        li.dataset.state = states[phase] || (p.currentPhase === phase ? 'active' : 'pending');
      }
      syncAutoConnectBridges();
    }
    if (!connectAutoProgress) return;
    connectAutoProgress.classList.remove('hidden');
    connectAutoProgress.classList.remove(
      'conn-auto-sub-scanning',
      'conn-auto-sub-heartbeat',
      'conn-auto-sub-exhausted',
    );
    const sub = p.subStatus || 'scanning';
    if (sub === 'heartbeat') connectAutoProgress.classList.add('conn-auto-sub-heartbeat');
    else if (sub === 'exhausted') connectAutoProgress.classList.add('conn-auto-sub-exhausted');
    else connectAutoProgress.classList.add('conn-auto-sub-scanning');

    const parts = [];
    if (p.message) parts.push(p.message);
    else parts.push(subStatusHe(sub));
    if (p.currentTarget) parts.push(p.currentTarget);
    if (p.attemptIndex > 0) parts.push(`ניסיון ${p.attemptIndex}`);
    if (p.startedAt) parts.push(`${Math.max(0, Math.round((Date.now() - p.startedAt) / 1000))}s`);
    if (p.jetsonOnline === false) parts.push('Jetson offline');
    else if (p.jetsonOnline === true) parts.push('Jetson online');
    connectAutoProgress.textContent = parts.filter(Boolean).join(' · ');
  }

  function finalizeAutoConnectStepper(p, ok) {
    if (!connectAutoStepper || !p) return;
    const states = p.phaseStates || {};
    for (const li of connectAutoStepper.querySelectorAll('.conn-auto-step')) {
      const phase = li.dataset.phase;
      if (states[phase]) li.dataset.state = states[phase];
      else if (ok && p.phasesDone?.includes(phase)) li.dataset.state = 'done';
      else if (!ok && !p.active) li.dataset.state = states[phase] || 'failed';
    }
    syncAutoConnectBridges();
  }

  async function pollAutoConnectProgress() {
    try {
      const r = await fetch('/api/connections/auto-connect/progress', { cache: 'no-store' });
      const p = await r.json();
      if (p?.ok !== false) applyAutoConnectProgress(p);
      return p;
    } catch {
      return null;
    }
  }

  function startAutoConnectPoll() {
    stopAutoConnectPoll();
    if (connectAutoStepper) connectAutoStepper.classList.remove('hidden');
    void pollAutoConnectProgress();
    autoConnectPollTimer = setInterval(() => {
      void pollAutoConnectProgress();
    }, AUTO_CONNECT_POLL_MS);
  }

  function hideAutoConnectUi() {
    clearAutoConnectReplay();
    stopAutoConnectPoll();
    if (connectAutoStepper) connectAutoStepper.classList.add('hidden');
    if (connectAutoProgress) {
      connectAutoProgress.classList.add('hidden');
      connectAutoProgress.textContent = '';
      connectAutoProgress.classList.remove(
        'conn-auto-sub-scanning',
        'conn-auto-sub-heartbeat',
        'conn-auto-sub-exhausted',
      );
    }
    if (connectAutoChecklist) {
      connectAutoChecklist.classList.add('hidden');
      connectAutoChecklist.innerHTML = '';
    }
  }

  function renderAutoSuggestion(suggestion) {
    if (!connectAutoChecklist || !suggestion) return;
    const items = Array.isArray(suggestion.checklist) ? suggestion.checklist : [];
    const title = suggestion.headline || 'מה כדאי לבדוק';
    const list = items.map((x) => `<li>${esc(x)}</li>`).join('');
    connectAutoChecklist.innerHTML = `
      <div class="conn-auto-checklist-title">${esc(title)}</div>
      <ul class="conn-auto-checklist-ul">${list}</ul>`;
    connectAutoChecklist.classList.remove('hidden');
  }

  function formatAttemptProgressLine(a) {
    if (!a) return '';
    const net = a.host != null && a.port != null ? `${a.host}:${a.port}` : '';
    const path = esc(a.target || a.portPath || net || a.port || '?');
    const baudNum = Number(a.baud);
    const baudStr = Number.isFinite(baudNum) ? String(baudNum) : '';
    if (a.phase === 'activate' && a.code === 'port_busy') {
      return `${path}${baudStr ? ' @ ' + baudStr : ''}: COM תפוס / גישה נחסמת — צריך לסגור תוכנה אחרת על אותה יציאה`;
    }
    if (a.phase === 'heartbeat' && !a.ok) {
      const b = baudStr || (net ? 'TCP/UDP' : 'נסיון במהירות לא ידועה');
      return `${path}${baudStr ? ' @ ' + baudStr : ''}: נפתח — לא התקבל heartbeat (${b})`;
    }
    return `${path}${baudStr ? ' @ ' + baudStr : ''}`;
  }

  /** אחרי תשובה מהשרת — סיכום ויזואלי קצב־מתון של מה שניסו (אין פרוגרס מהשרת בזמן אמת כאן). */
  function replayAttemptsTimeline(attempts, finalMsg) {
    clearAutoConnectReplay();
    return new Promise((resolve) => {
      if (!connectAutoProgress) {
        resolve();
        return;
      }
      const arr = Array.isArray(attempts) ? attempts : [];
      const failOnly = arr.filter((x) => x && x.ok !== true);
      connectAutoProgress.classList.remove('hidden');

      function settle(msg) {
        clearAutoConnectReplay();
        connectAutoProgress.textContent = msg || '';
        resolve();
      }

      if (failOnly.length === 0) {
        settle(finalMsg || '');
        return;
      }

      let i = 0;
      const tick = () => {
        if (i >= failOnly.length) return settle(finalMsg || '');
        const a = failOnly[i++];
        connectAutoProgress.textContent = `סיכום ניסויים (${i}/${failOnly.length}): ${formatAttemptProgressLine(a)}`;
      };

      tick();
      autoConnectReplayTimer = setInterval(tick, 135);
    });
  }

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  function savePrefs() {
    try {
      const prefs = {
        type: typeSel.value,
        host: portInput.value,
        serialPort: portList.value,
        baud: baudSel.value,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch { /* ignore */ }
  }

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }
  function fmtDuration(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60), rm = m % 60;
    return `${h}h ${rm}m`;
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function setDot(state) { dot.dataset.state = state; }

  function applyTypeUI() {
    const t = typeSel.value;
    const isSerial = t === 'serial';
    portList.hidden = !isSerial;
    portList.style.display = isSerial ? '' : 'none';
    portInput.hidden = isSerial;
    portInput.style.display = isSerial ? 'none' : '';
    baudSel.hidden = !isSerial;
    baudSel.style.display = isSerial ? '' : 'none';
    if (!isSerial && !portInput.value) {
      portInput.value = t === 'udp' ? '0.0.0.0:14550' : '127.0.0.1:5760';
    }
  }

  async function refreshSerialPorts() {
    try {
      const r = await fetch('/api/connections/ports/list');
      const j = await r.json();
      const prev = portList.value;
      portList.innerHTML = '';
      const ports = (j.ports || []);
      if (ports.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'אין COM ports';
        opt.disabled = true;
        portList.appendChild(opt);
      } else {
        for (const p of ports) {
          const opt = document.createElement('option');
          opt.value = p.path;
          opt.textContent = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
          portList.appendChild(opt);
        }
        if (prev && ports.some((p) => p.path === prev)) portList.value = prev;
      }
    } catch (err) {
      console.warn('refreshSerialPorts failed', err);
    }
  }

  function parseHostPort(s) {
    const m = String(s || '').trim().match(/^([^:]+):(\d+)$/);
    if (!m) return null;
    return { host: m[1], port: Number(m[2]) };
  }

  async function parseConnJsonResponse(r) {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        r.ok
          ? 'תשובת השרת לא בפורמט JSON — ודא שהשרת מעודכן והופעל מחדש.'
          : `HTTP ${r.status}: התקבלה תשובת HTML במקום JSON — ודא שהשרת הוא Vision Landing Console מגרסה עדכנית.`,
      );
    }
  }

  /** False when /api/meta has no features.mavlinkQuickConnect (old Node process still bound to the port). */
  let connectionApisOk = true;

  async function syncConnectionApiGate() {
    const hint = document.getElementById('connectApiUpgradeHint');
    try {
      const r = await fetch('/api/meta', { cache: 'no-store' });
      const raw = await r.text();
      let j = {};
      try {
        j = JSON.parse(raw);
      } catch {
        connectionApisOk = true;
        if (hint) hint.classList.add('hidden');
        return true;
      }
      connectionApisOk = j.features?.mavlinkQuickConnect === true;
      if (hint) {
        hint.classList.toggle('hidden', connectionApisOk);
        if (!connectionApisOk) {
          hint.textContent =
            `תהליך השרת שמאזין כאן דיווח גרסה ${j.appVersion || 'לא ידועה'}, אבל זה בילד ישן בלי נתיבי חיבור מהיר — תופיע שגיאת 404. עצור את כל תהליכי Node (פורט 4010), פתח מחדש טרמינל בתיקיית VisionLandingConsole והרץ: set PORT=4010 ; node server.js`;
        }
      }
      if (connectAutoBtn && connBtn.dataset.connected !== '1') {
        connectAutoBtn.disabled = !connectionApisOk;
        connectAutoBtn.title = connectionApisOk
          ? 'מזהה אוטומטית: FC ב-USB → Jetson relay → SITL מקומי'
          : 'דורש הפעלה מחדש של השרת מהריפו המעודכן.';
      }
      return connectionApisOk;
    } catch {
      connectionApisOk = true;
      if (hint) hint.classList.add('hidden');
      return true;
    }
  }

  async function refreshConnectionStatus() {
    try {
      const r = await fetch('/api/connections');
      const j = await r.json();
      const connections = j.connections || [];
      const active = connections.find((c) => c.liveStatus && c.liveStatus.connected);
      if (active) {
        currentId = active.id;
        const age = active.liveStatus.lastHeartbeatAgeMs;
        setDot(age != null && age < 5000 ? 'on' : 'warn');
        connBtn.textContent = 'DISCONNECT';
        connBtn.dataset.connected = '1';
        connBtn.title = `מחובר ל-${active.liveStatus.remoteAddr || active.name}. לחץ לניתוק.`;
        setPillLabel(`מחובר · ${active.liveStatus.remoteAddr || active.name}`);
      } else {
        const listening = connections.find((c) => c.liveStatus && c.liveStatus.listening);
        if (listening) {
          currentId = listening.id;
          setDot('connecting');
          connBtn.textContent = 'DISCONNECT';
          connBtn.dataset.connected = '1';
          connBtn.title = `מאזין על ${listening.liveStatus.remoteAddr || listening.name} — ממתין ל-heartbeat`;
          setPillLabel(`מאזין · ${listening.liveStatus.remoteAddr || listening.name}`);
        } else {
          currentId = null;
          setDot('off');
          connBtn.textContent = 'CONNECT';
          connBtn.dataset.connected = '0';
          connBtn.title = 'התחבר למטוס';
          setPillLabel('לא מחובר');
        }
      }
    } catch (err) {
      console.warn('refreshConnectionStatus failed', err);
    }
  }

  async function onConnectClick() {
    const connected = connBtn.dataset.connected === '1';
    connBtn.disabled = true;
    try {
      if (!(await syncConnectionApiGate())) {
        alert(
          'תהליך Node על הפורט הזה הוא בילד ישן — אין נתיבי חיבור מהיר (/api/connections/*). עצור את השרת והפעל שוב מתיקיית VisionLandingConsole (npm start או node server.js).',
        );
        return;
      }
      if (connected) {
        const r = await fetch('/api/connections/disconnect-all', { method: 'POST' });
        const j = await parseConnJsonResponse(r);
        if (!j.ok) throw new Error(j.message || 'disconnect failed');
      } else {
        const type = typeSel.value;
        savePrefs();
        const body = { type, baudRate: Number(baudSel.value) || 57600 };
        if (type === 'serial') {
          if (!portList.value) { alert('בחר COM port תחילה'); return; }
          body.serialPort = portList.value;
        } else {
          const hp = parseHostPort(portInput.value);
          if (!hp) { alert('הזן כתובת בפורמט host:port, למשל 0.0.0.0:14550'); return; }
          body.host = hp.host; body.port = hp.port;
        }
        setDot('connecting');
        const r = await fetch('/api/connections/quick-connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await parseConnJsonResponse(r);
        if (!j.ok) throw new Error(j.message || 'connect failed');
        currentId = j.id;
      }
    } catch (err) {
      setDot('err');
      alert(`שגיאת חיבור: ${err.message || err}`);
    } finally {
      connBtn.disabled = false;
      await refreshConnectionStatus();
    }
  }

  async function onAutoConnectClick() {
    if (autoConnectInFlight) return;
    if (connBtn.dataset.connected === '1') {
      alert('כבר מחובר — לחץ DISCONNECT לפני חיבור אוטומטי.');
      return;
    }
    if (!(await syncConnectionApiGate())) {
      alert(
        'תהליך Node על הפורט הזה הוא בילד ישן — חיבור אוטומטי דורש שרת מעודכן. עצור את השרת והפעל שוב מתיקיית VisionLandingConsole.',
      );
      return;
    }
    autoConnectInFlight = true;
    hideAutoConnectUi();
    connBtn.disabled = true;
    if (connectAutoBtn) connectAutoBtn.disabled = true;
    setDot('connecting');
    setPillLabel('חיבור חכם…');
    applyAutoConnectProgress({
      active: true,
      message: 'מזהה אוטומטית: USB FC → Jetson relay → SITL…',
      subStatus: 'scanning',
      phaseStates: Object.fromEntries(AUTO_CONNECT_PHASE_IDS.map((id) => [id, 'pending'])),
      attemptIndex: 0,
    });
    startAutoConnectPoll();
    openPanel();
    try {
      const r = await fetch('/api/connections/auto-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await parseConnJsonResponse(r);
      stopAutoConnectPoll();
      const finalProg = await pollAutoConnectProgress();
      if (!j.ok) {
        setDot('err');
        setPillLabel('חיבור אוטומטי נכשל');
        const msg = j.message || 'auto-connect failed';
        finalizeAutoConnectStepper(finalProg, false);
        if (finalProg) {
          applyAutoConnectProgress({ ...finalProg, subStatus: 'exhausted', message: msg });
        }
        await replayAttemptsTimeline(j.attempts, msg);
        renderAutoSuggestion(j.suggestion);
        return;
      }
      currentId = j.id;
      const connType = j.connectionType || 'serial';
      typeSel.value = connType;
      applyTypeUI();
      if (connType === 'serial') {
        await refreshSerialPorts();
        if (j.serialPort && [...portList.options].some((o) => o.value === j.serialPort)) {
          portList.value = j.serialPort;
        }
        if (j.baudRate != null) baudSel.value = String(j.baudRate);
      } else if (connType === 'tcp' || connType === 'udp') {
        if (portInput && j.host != null && j.port != null) {
          portInput.value = connType === 'udp' && j.host === '0.0.0.0'
            ? `:${j.port}`
            : `${j.host}:${j.port}`;
        }
      }
      savePrefs();
      setDot('on');
      const win = j.connectPath
        ? `מחובר · ${j.connectPath}`
        : j.winner?.port && j.winner?.baud
          ? `מחובר · ${j.winner.port} @ ${j.winner.baud}`
          : j.winner?.host
            ? `מחובר · ${j.winner.host}:${j.winner.port}`
            : 'מחובר (חכם)';
      setPillLabel(win);
      const phaseHint = Array.isArray(j.phases) && j.phases.length
        ? j.phases.map((p) => p.summary).filter(Boolean).join(' → ')
        : '';
      const okLine = j.connectPath
        ? `הצלחה: ${j.connectPath}${phaseHint ? ` (${phaseHint})` : ''}`
        : j.winner?.port && j.winner?.baud
          ? `הצלחה: ${j.winner.port} @ ${j.winner.baud} — heartbeat OK`
          : j.winner?.host
            ? `הצלחה: ${j.winner.host}:${j.winner.port} — heartbeat OK`
            : 'הצלחה — heartbeat OK';
      finalizeAutoConnectStepper(finalProg, true);
      if (finalProg) applyAutoConnectProgress({ ...finalProg, message: okLine });
      await replayAttemptsTimeline(j.attempts, okLine);
      setTimeout(() => {
        if (connectAutoProgress) connectAutoProgress.classList.add('hidden');
        if (connectAutoStepper) connectAutoStepper.classList.add('hidden');
      }, 4500);
    } catch (err) {
      stopAutoConnectPoll();
      setDot('err');
      setPillLabel('חיבור אוטומטי נכשל');
      const errMsg = err?.message || String(err);
      if (connectAutoProgress) {
        connectAutoProgress.classList.remove('hidden');
        connectAutoProgress.textContent = errMsg;
        connectAutoProgress.classList.add('conn-auto-sub-exhausted');
      }
      if (connectAutoStepper) connectAutoStepper.classList.remove('hidden');
    } finally {
      autoConnectInFlight = false;
      connBtn.disabled = false;
      if (connectAutoBtn) connectAutoBtn.disabled = !connectionApisOk;
      await refreshConnectionStatus();
    }
  }

  function renderStatBody(cn) {
    if (!cn || !cn.liveStatus) {
      return '<div style="color: var(--text-muted); text-align: center; padding: 20px;">לא מחובר כרגע — לחץ CONNECT בווידג\'ט למעלה.</div>';
    }
    const s = cn.liveStatus;
    const linkClass = s.lastHeartbeatAgeMs == null ? 'warn' : (s.lastHeartbeatAgeMs < 3000 ? 'good' : s.lastHeartbeatAgeMs < 10000 ? 'warn' : 'bad');
    const cells = [
      { k: 'שם', v: esc(s.name || cn.name) },
      { k: 'סוג', v: esc((s.type || cn.type || '').toUpperCase()) },
      { k: 'כתובת', v: esc(s.remoteAddr || '—') },
      { k: 'סטטוס', v: s.connected ? 'מחובר' : (s.listening ? 'מאזין' : 'מנותק'), cls: s.connected ? 'good' : (s.listening ? 'warn' : 'bad') },
      { k: 'זמן חיבור', v: fmtDuration(s.uptimeMs) },
      { k: 'Heartbeat אחרון', v: s.lastHeartbeatAgeMs == null ? '—' : `${(s.lastHeartbeatAgeMs / 1000).toFixed(1)}s`, cls: linkClass },
      { k: 'Heartbeat Rate', v: s.heartbeatRateHz != null ? `${s.heartbeatRateHz} Hz` : '—' },
      { k: 'סה"כ Heartbeats', v: s.heartbeatCount ?? 0 },
      { k: 'System ID', v: s.sysId ?? '—' },
      { k: 'Autopilot', v: esc(s.autopilotName || '—') },
      { k: 'Vehicle', v: esc(s.vehicleType || '—') },
      { k: 'Params', v: `${s.paramCount ?? 0} / ${s.totalParamCount ?? '?'}` },
      { k: 'RX bytes', v: fmtBytes(s.bytesRx) },
      { k: 'TX bytes', v: fmtBytes(s.bytesTx) },
      { k: 'RX frames', v: s.framesRx ?? 0 },
      { k: 'TX frames', v: s.framesTx ?? 0 },
      { k: 'Dropped bytes', v: s.droppedBytes ?? 0, cls: (s.droppedBytes || 0) > 0 ? 'warn' : '' },
      { k: 'Last error', v: esc(s.lastError || '—'), cls: s.lastError ? 'bad' : '' },
    ];
    const grid = cells.map((c) => `
      <div class="conn-stat-cell${c.cls ? ' ' + c.cls : ''}">
        <span class="k">${c.k}</span>
        <span class="v">${c.v}</span>
      </div>`).join('');
    const texts = (s.recentStatusTexts || []).slice(0, 8);
    const textsHtml = texts.length === 0 ? '<div style="color: var(--text-muted); font-size: 0.82rem;">אין STATUSTEXT אחרונים.</div>'
      : texts.map((t) => `<div class="conn-status-line"><span class="sev-${t.severity ?? 6}">[${esc(t.severityName || 'INFO')}]</span> ${esc(t.text || '')}</div>`).join('');
    return `
      <div class="conn-stat-grid">${grid}</div>
      <div class="conn-section-title">הודעות STATUSTEXT אחרונות</div>
      ${textsHtml}
    `;
  }

  async function refreshStatBody() {
    if (!currentId) {
      statBody.innerHTML = renderStatBody(null);
      return;
    }
    try {
      const r = await fetch(`/api/connections/${currentId}/status`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || 'status failed');
      statBody.innerHTML = renderStatBody(j.connection);
    } catch (err) {
      statBody.innerHTML = `<div style="color: #b91c1c;">שגיאת קריאת סטטוס: ${esc(err.message || err)}</div>`;
    }
  }

  function openStatModal() {
    modal.hidden = false;
    refreshStatBody();
    if (statPollTimer) clearInterval(statPollTimer);
    if (statAuto.checked) statPollTimer = setInterval(refreshStatBody, 1000);
  }
  function closeStatModal() {
    modal.hidden = true;
    if (statPollTimer) { clearInterval(statPollTimer); statPollTimer = null; }
  }

  typeSel.addEventListener('change', () => { applyTypeUI(); savePrefs(); });
  portList.addEventListener('change', savePrefs);
  portInput.addEventListener('change', savePrefs);
  baudSel.addEventListener('change', savePrefs);
  portList.addEventListener('focus', refreshSerialPorts);
  connBtn.addEventListener('click', onConnectClick);
  if (connectAutoBtn) connectAutoBtn.addEventListener('click', onAutoConnectClick);
  statBtn.addEventListener('click', openStatModal);
  statRefr.addEventListener('click', refreshStatBody);
  statAuto.addEventListener('change', () => {
    if (statPollTimer) { clearInterval(statPollTimer); statPollTimer = null; }
    if (statAuto.checked && !modal.hidden) statPollTimer = setInterval(refreshStatBody, 1000);
  });
  modal.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.close) closeStatModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!modal.hidden) closeStatModal();
      else if (panel && !panel.hidden) closePanel();
    }
  });
  if (toggleBtn) toggleBtn.addEventListener('click', (ev) => { ev.stopPropagation(); togglePanel(); });
  document.addEventListener('click', (ev) => {
    if (!panel || panel.hidden) return;
    if (widget.contains(ev.target)) return;
    closePanel();
  });

  const prefs = loadPrefs();
  if (prefs.type) typeSel.value = prefs.type;
  if (prefs.host) portInput.value = prefs.host;
  if (prefs.baud) baudSel.value = prefs.baud;
  applyTypeUI();
  refreshSerialPorts();
  refreshConnectionStatus();
  void syncConnectionApiGate();
  if (prefs.serialPort) {
    setTimeout(() => {
      if ([...portList.options].some((o) => o.value === prefs.serialPort)) portList.value = prefs.serialPort;
    }, 600);
  }

  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = setInterval(refreshConnectionStatus, 2000);
})();

/* ─── AUTO-CONFIG WIZARD ─── */
(function initAutoConfigWizard() {
  const acComponentBtns    = document.getElementById('acComponentBtns');
  const acSymptoms         = document.getElementById('acSymptoms');
  const acPlanBtn          = document.getElementById('acPlanBtn');
  const acPlanBtnLabel     = acPlanBtn?.querySelector('.ac-plan-btn-label');
  const acStatus           = document.getElementById('acStatus');
  const acResults          = document.getElementById('acResults');
  const acSummaryBox       = document.getElementById('acSummaryBox');
  const acWarningsBox      = document.getElementById('acWarningsBox');
  const acChecksSection    = document.getElementById('acChecksSection');
  const acChecksList       = document.getElementById('acChecksList');
  const acParamsSection    = document.getElementById('acParamsSection');
  const acParamsList       = document.getElementById('acParamsList');
  const acPhaseBar         = document.getElementById('acPhaseBar');
  const acPhaseDetail      = document.getElementById('acPhaseDetail');
  const acEmptyState       = document.getElementById('acEmptyState');
  const acHistoryDetails   = document.getElementById('acHistoryDetails');
  const acHistoryTbody     = document.getElementById('acHistoryTbody');
  const acHistoryCount     = document.getElementById('acHistoryCount');
  const acHistoryClearBtn  = document.getElementById('acHistoryClearBtn');

  if (!acComponentBtns || !acPlanBtn) return;

  // ── Phase bar helpers ──────────────────────────────────────────────────────
  const PHASES = ['acPhase1', 'acPhase2', 'acPhase3', 'acPhase4'];

  function setPhase(active, detail) {
    if (!acPhaseBar) return;
    acPhaseBar.classList.remove('hidden');
    if (acEmptyState) acEmptyState.style.display = 'none';
    PHASES.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('ac-phase--active', 'ac-phase--done', 'ac-phase--pending');
      if (idx < active)      el.classList.add('ac-phase--done');
      else if (idx === active) el.classList.add('ac-phase--active');
      else                   el.classList.add('ac-phase--pending');
    });
    if (acPhaseDetail && detail != null) acPhaseDetail.textContent = detail;
  }

  function resetPhase() {
    if (acPhaseBar) acPhaseBar.classList.add('hidden');
    if (acEmptyState) acEmptyState.style.display = '';
  }

  // ── History log ───────────────────────────────────────────────────────────
  let _acHistory = [];

  function addHistoryEntry(component, paramKey, value, fcResponse, ok) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _acHistory.unshift({ time: timeStr, component: component || '—', paramKey, value, fcResponse, ok });
    renderHistory();
    if (acHistoryDetails) acHistoryDetails.classList.remove('hidden');
    if (acHistoryCount)   acHistoryCount.textContent = String(_acHistory.length);
  }

  function renderHistory() {
    if (!acHistoryTbody) return;
    acHistoryTbody.innerHTML = _acHistory.map((e) => `
      <tr class="${e.ok ? 'ac-hist-ok' : 'ac-hist-fail'}">
        <td>${e.time}</td>
        <td>${e.component}</td>
        <td class="ac-hist-key">${e.paramKey}</td>
        <td>${e.value}</td>
        <td>${e.fcResponse || '—'}</td>
        <td>${e.ok ? '✔ הצליח' : '✘ נכשל'}</td>
      </tr>`).join('');
    if (acHistoryCount) acHistoryCount.textContent = String(_acHistory.length);
  }

  acHistoryClearBtn?.addEventListener('click', () => {
    _acHistory = [];
    renderHistory();
    if (acHistoryDetails) acHistoryDetails.classList.add('hidden');
  });

  let selectedComponent = null;

  /** Fetch component types and build the selector buttons. */
  async function loadComponentTypes() {
    try {
      const res = await fetch('/api/auto-config/components');
      const d = await res.json();
      if (!d.ok || !Array.isArray(d.components)) return;
      acComponentBtns.innerHTML = '';
      d.components.forEach(({ id, labelHe }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ac-comp-btn';
        btn.dataset.compId = id;
        btn.textContent = labelHe;
        btn.addEventListener('click', () => {
          selectedComponent = id;
          acComponentBtns.querySelectorAll('.ac-comp-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');

          // Guide user to the textarea — highlight it and update placeholder
          if (acSymptoms) {
            acSymptoms.placeholder = `מה לא עובד עם ${labelHe}? לדוגמה: חיברתי ל-SERIAL3 אבל הרכיב לא מזוהה...`;
            acSymptoms.classList.add('ac-textarea--ready');
            const lbl = document.getElementById('acSymptomsLabel');
            if (lbl) lbl.classList.add('ac-label--active');
            // Scroll into view and focus
            acSymptoms.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => acSymptoms.focus(), 200);
          }
        });
        acComponentBtns.appendChild(btn);
      });
      // Auto-select first
      const first = acComponentBtns.querySelector('.ac-comp-btn');
      if (first) first.click();
    } catch (err) {
      acComponentBtns.textContent = '(שגיאה בטעינת רשימת רכיבים)';
      console.error('[auto-config] loadComponentTypes failed', err);
    }
  }

  /** Risk badge HTML */
  function riskBadge(risk) {
    const label = risk === 'high' ? 'סיכון גבוה' : risk === 'medium' ? 'סיכון בינוני' : 'סיכון נמוך';
    return `<span class="ac-risk-badge ${risk}">${label}</span>`;
  }

  /** Apply a single param change via the existing param-set endpoint. */
  async function applyParamChange(paramKey, value, applyBtn, statusEl) {
    const numVal = Number(value);
    if (!Number.isFinite(numVal)) {
      statusEl.textContent = 'ערך לא תקין';
      statusEl.className = 'ac-param-apply-status fail';
      return;
    }
    applyBtn.disabled = true;
    statusEl.textContent = 'שולח…';
    statusEl.className = 'ac-param-apply-status';
    setPhase(2, `שולח ${paramKey} = ${numVal} לרחפן…`);
    try {
      const res = await fetch('/api/param-center/param-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ param: paramKey, value: numVal }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        const errMsg = d.message || 'שגיאה';
        statusEl.textContent = `✘ ${errMsg}`;
        statusEl.className = 'ac-param-apply-status fail';
        setPhase(2, `✘ ${paramKey}: ${errMsg}`);
        addHistoryEntry(selectedComponent, paramKey, numVal, errMsg, false);
        applyBtn.disabled = false;
        return;
      }
      if (d.via === 'offline') {
        statusEl.textContent = '⚠ נשמר (לא מחובר לרחפן)';
        setPhase(3, `⚠ ${paramKey} = ${numVal} נשמר. אין חיבור לרחפן.`);
        addHistoryEntry(selectedComponent, paramKey, numVal, 'נשמר (לא מחובר)', true);
      } else {
        const echo = d.value != null ? ` (FC: ${d.value})` : '';
        statusEl.textContent = `✔ נשלח${echo}`;
        setPhase(3, `✔ ${paramKey} = ${numVal} נשלח ואושר על-ידי FC${echo}.`);
        addHistoryEntry(selectedComponent, paramKey, numVal, d.value != null ? `FC: ${d.value}` : 'אושר', true);
      }
    } catch (err) {
      const errMsg = err?.message || 'שגיאת רשת';
      statusEl.textContent = `✘ ${errMsg}`;
      statusEl.className = 'ac-param-apply-status fail';
      setPhase(2, `✘ שגיאת רשת בשליחת ${paramKey}`);
      addHistoryEntry(selectedComponent, paramKey, numVal, errMsg, false);
      applyBtn.disabled = false;
    }
  }

  /** Render the recipe into the results area. */
  function renderRecipe(recipe) {
    // Summary
    acSummaryBox.textContent = recipe.summary || '';

    // Warnings
    if (recipe.warnings && recipe.warnings.length > 0) {
      acWarningsBox.innerHTML = recipe.warnings
        .map((w) => `<div class="ac-warning-item">${w}</div>`)
        .join('');
      acWarningsBox.classList.remove('hidden');
    } else {
      acWarningsBox.classList.add('hidden');
    }

    // Checks
    if (recipe.checks && recipe.checks.length > 0) {
      acChecksList.innerHTML = recipe.checks.map((c) => `
        <div class="ac-check-card" data-check-id="${c.id}">
          <input type="checkbox" class="ac-check-checkbox" id="chk-${c.id}" aria-label="סמן כבוצע: ${c.title}">
          <div class="ac-check-body">
            <div class="ac-check-title"><label for="chk-${c.id}" style="cursor:pointer">${c.title}</label></div>
            <div class="ac-check-desc">${c.description}</div>
            ${c.expected ? `<div class="ac-check-expected">✓ ${c.expected}</div>` : ''}
          </div>
        </div>
      `).join('');
      acChecksSection.classList.remove('hidden');
    } else {
      acChecksSection.classList.add('hidden');
    }

    // Param changes
    if (recipe.param_changes && recipe.param_changes.length > 0) {
      acParamsList.innerHTML = '';
      recipe.param_changes.forEach((p) => {
        const card = document.createElement('div');
        card.className = `ac-param-card risk-${p.risk || 'low'}`;

        const currentBlock = p.current_value != null
          ? `<span>ערך נוכחי: <strong>${p.current_value}</strong></span>`
          : '<span class="ac-optional">ערך נוכחי לא ידוע</span>';

        card.innerHTML = `
          <div class="ac-param-header">
            <span class="ac-param-key">${p.param_key}</span>
            ${riskBadge(p.risk || 'low')}
          </div>
          <div class="ac-param-values">
            ${currentBlock}
            <span>ערך מומלץ: <strong>${p.recommended_value}</strong></span>
          </div>
          ${p.reason ? `<div class="ac-param-reason">${p.reason}</div>` : ''}
          ${p.success_condition ? `<div class="ac-param-success">תנאי הצלחה: ${p.success_condition}</div>` : ''}
          <div class="ac-param-apply-row">
            <input class="ac-param-val-input" type="text" value="${p.recommended_value}" aria-label="ערך לשליחה עבור ${p.param_key}">
            <button class="ac-param-apply-btn" type="button">Apply ✈</button>
            <span class="ac-param-apply-status"></span>
          </div>
        `;

        const applyBtn = card.querySelector('.ac-param-apply-btn');
        const valInput = card.querySelector('.ac-param-val-input');
        const statusEl = card.querySelector('.ac-param-apply-status');
        applyBtn.addEventListener('click', () => {
          applyParamChange(p.param_key, valInput.value.trim(), applyBtn, statusEl);
        });

        acParamsList.appendChild(card);
      });
      acParamsSection.classList.remove('hidden');
    } else {
      acParamsSection.classList.add('hidden');
    }

    acResults.classList.remove('hidden');
    acResults.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** Run the plan request. */
  acPlanBtn.addEventListener('click', async () => {
    const symptoms = acSymptoms?.value.trim() ?? '';
    if (!selectedComponent) {
      if (acStatus) acStatus.textContent = 'בחר סוג רכיב תחילה';
      return;
    }
    if (!symptoms) {
      if (acStatus) acStatus.textContent = 'תאר את הבעיה תחילה (שדה 2)';
      return;
    }

    acPlanBtn.disabled = true;
    if (acPlanBtnLabel) acPlanBtnLabel.textContent = 'מנתח…';
    if (acStatus) acStatus.textContent = '';
    acResults?.classList.add('hidden');
    setPhase(0, 'שולח בקשה ל-AI — בונה תוכנית קונפיגורציה…');

    try {
      const res = await fetch('/api/auto-config/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ componentType: selectedComponent, symptoms }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        const msg = d.message || 'שגיאת שרת';
        if (acStatus) acStatus.textContent = `✘ ${msg}`;
        setPhase(0, `✘ נכשל: ${msg}`);
        acPlanBtn.disabled = false;
        if (acPlanBtnLabel) acPlanBtnLabel.textContent = 'קבל המלצות קונפיגורציה';
        return;
      }
      setPhase(1, 'המלצות מוכנות — לחץ Apply ליד כל פרמטר כדי לשלוח לרחפן.');
      renderRecipe(d.recipe);
    } catch (err) {
      const msg = err?.message || 'שגיאת רשת';
      if (acStatus) acStatus.textContent = `✘ ${msg}`;
      setPhase(0, `✘ ${msg}`);
    }
    acPlanBtn.disabled = false;
    if (acPlanBtnLabel) acPlanBtnLabel.textContent = 'קבל המלצות קונפיגורציה';
  });

  loadComponentTypes();
})();

/* ─── CUSTOM PARAMS PANEL ─── */
(function initCustomParamsPanel() {
  const cpSearchInput   = document.getElementById('cpSearchInput');
  const cpRefreshBtn    = document.getElementById('cpRefreshBtn');
  const cpFeaturesGrid  = document.getElementById('cpFeaturesGrid');
  const cpStatus        = document.getElementById('cpStatus');
  if (!cpFeaturesGrid) return;

  let _cpFeatures = [];
  let _cpQuery    = '';

  function cpSetStatus(msg, type) {
    if (!cpStatus) return;
    cpStatus.textContent = msg;
    cpStatus.className   = 'cp-status' + (type ? ' cp-status--' + type : '');
  }

  async function loadCpFeatures() {
    cpSetStatus('טוען…', 'loading');
    try {
      const res  = await fetch('/api/feature-designer');
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'שגיאה בטעינה');
      const summaries = Array.isArray(data.features) ? data.features : [];
      // Fetch full details (with params) for each non-archived feature in parallel
      const nonArchived = summaries.filter(f => f.status !== 'archived');
      const fullFeatures = await Promise.all(
        nonArchived.map(async (f) => {
          try {
            const r = await fetch(`/api/feature-designer/${f.id}`);
            const d = await r.json();
            return d.ok ? d.feature : f;
          } catch { return f; }
        })
      );
      _cpFeatures = fullFeatures;
      renderCpPanel();
      cpSetStatus('', '');
    } catch (err) {
      cpSetStatus('שגיאה בטעינת פרמטרים: ' + (err?.message || ''), 'error');
    }
  }

  function cpMatchesQuery(f, params) {
    if (!_cpQuery) return true;
    const q = _cpQuery.toLowerCase();
    const blob = [f.name, f.description, ...params.map(p => p.param_key + ' ' + (p.display_name || '') + ' ' + (p.description || '') + ' ' + (p.description_he || ''))].join(' ').toLowerCase();
    return blob.includes(q);
  }

  function renderCpPanel() {
    if (!cpFeaturesGrid) return;
    const active   = _cpFeatures.filter(f => f.status === 'active');
    const draft    = _cpFeatures.filter(f => f.status !== 'active' && f.status !== 'archived');

    const groups = [
      { label: 'פעיל', items: active, cls: 'cp-group--active' },
      { label: 'טיוטה', items: draft, cls: 'cp-group--draft' },
    ].filter(g => g.items.length > 0);

    if (!groups.length) {
      cpFeaturesGrid.innerHTML = '<div class="cp-empty">לא נוצרו עדיין פרמטרים מותאמים.<br>עבור ל<strong>ArduLab</strong> כדי ליצור פיצ\'ר חדש.</div>';
      return;
    }

    cpFeaturesGrid.innerHTML = groups.map(group => {
      const cards = group.items.map(f => {
        const params = Array.isArray(f.params) ? f.params : [];
        if (!cpMatchesQuery(f, params)) return '';
        const paramCount = f.param_count ?? params.length;
        const paramRows  = params.map(p => {
          const key  = String(p.param_key || '');
          const esc  = key.replace(/[^A-Za-z0-9]/g, '_');
          const cur  = p.current_value ?? p.default_value ?? '';
          const desc = p.description_he || p.description || p.display_name || '';
          const _cpi = getParamIcon(key);
          return `<div class="cp-param-row">
            <div class="cp-param-info">
              <span class="cp-param-key"><span class="pc-param-icon" style="color:${_cpi.color}" title="${_cpi.label}">${_cpi.icon}</span>${escapeSmartHtml(key)}</span>
              ${p.units ? `<span class="cp-param-unit">${escapeSmartHtml(p.units)}</span>` : ''}
              ${desc ? `<span class="cp-param-desc">${escapeSmartHtml(desc.slice(0, 70))}</span>` : ''}
            </div>
            <div class="cp-param-editor" id="cp-edit-${esc}">
              <input type="number" class="cp-param-input" data-cp-key="${escapeAttr(key)}" placeholder="ערך חדש" step="any" value="${escapeAttr(String(cur))}" aria-label="ערך עבור ${escapeAttr(key)}" />
              <button type="button" class="cp-param-send" data-cp-key="${escapeAttr(key)}" title="שלח לרחפן">שלח ✈</button>
              <span class="cp-param-status"></span>
            </div>
          </div>`;
        }).join('');

        const hasParams = params.length > 0;
        return `<div class="cp-feature-card ${f.status === 'active' ? 'cp-card--active' : 'cp-card--draft'}" role="listitem">
          <div class="cp-card-header">
            <span class="cp-card-name">${escapeSmartHtml(f.name || 'ללא שם')}</span>
            <span class="cp-card-badge cp-badge--${f.status}">${f.status === 'active' ? 'פעיל' : 'טיוטה'}</span>
            <span class="cp-card-count">${paramCount} פרמטרים</span>
          </div>
          ${f.description ? `<p class="cp-card-desc">${escapeSmartHtml(f.description.slice(0, 120))}</p>` : ''}
          ${hasParams ? `<div class="cp-params-list">${paramRows}</div>` : '<div class="cp-no-params">אין פרמטרים לפיצ\'ר זה</div>'}
        </div>`;
      }).join('');

      if (!cards.trim()) return '';
      return `<div class="cp-group ${group.cls}">
        <div class="cp-group-label">${group.label}</div>
        ${cards}
      </div>`;
    }).join('');

    // Wire up send buttons
    cpFeaturesGrid.querySelectorAll('.cp-param-send').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key   = btn.getAttribute('data-cp-key');
        const row   = btn.closest('.cp-param-editor');
        const inp   = row?.querySelector('.cp-param-input');
        const stEl  = row?.querySelector('.cp-param-status');
        if (!key || !inp) return;
        const raw = inp.value.trim();
        if (raw === '') { if (stEl) { stEl.textContent = 'הכנס ערך'; stEl.className = 'cp-param-status err'; } return; }
        const val = Number(raw);
        if (!Number.isFinite(val)) { if (stEl) { stEl.textContent = 'ערך לא תקין'; stEl.className = 'cp-param-status err'; } return; }
        btn.disabled = true;
        if (stEl) { stEl.textContent = '…'; stEl.className = 'cp-param-status'; }
        try {
          const r = await fetch('/api/param-center/param-set', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ param: key, value: val }),
          });
          const d = await r.json();
          if (stEl) {
            stEl.textContent = d.ok ? '✓' : (d.message || 'שגיאה');
            stEl.className   = 'cp-param-status ' + (d.ok ? 'ok' : 'err');
          }
        } catch (e) {
          if (stEl) { stEl.textContent = 'שגיאת רשת'; stEl.className = 'cp-param-status err'; }
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  cpSearchInput?.addEventListener('input', () => {
    _cpQuery = (cpSearchInput.value || '').trim();
    renderCpPanel();
  });
  cpRefreshBtn?.addEventListener('click', () => loadCpFeatures());

  // Load when sub-tab is activated
  document.querySelectorAll('.subtab[data-subtab="customParams"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!_cpFeatures.length) loadCpFeatures();
    });
  });
})();

/* ─── FEATURE DESIGNER ─── */
(function initFeatureDesigner() {
  // Elements
  const fdPanel       = document.getElementById('featureDesigner');
  if (!fdPanel) return;

  const fdNewBtn        = document.getElementById('fdNewBtn');
  const fdFeatureList   = document.getElementById('fdFeatureList');
  const fdWelcome       = document.getElementById('fdWelcome');
  const fdDetail        = document.getElementById('fdDetail');
  const fdDetailName    = document.getElementById('fdDetailName');
  const fdDetailDesc    = document.getElementById('fdDetailDescription');
  const fdStatusBadge   = document.getElementById('fdStatusBadge');
  const fdActivateBtn   = document.getElementById('fdActivateBtn');
  const fdDeactivateBtn = document.getElementById('fdDeactivateBtn');
  const fdDeleteBtn     = document.getElementById('fdDeleteBtn');
  const fdMessages      = document.getElementById('fdMessages');
  const fdFeedbackInput = document.getElementById('fdFeedbackInput');
  const fdSendBtn       = document.getElementById('fdSendBtn');
  const fdSendLabel     = document.getElementById('fdSendLabel');
  const fdCodeContent   = document.getElementById('fdCodeContent');
  const fdCopyCodeBtn   = document.getElementById('fdCopyCodeBtn');
  const fdParamsNote    = document.getElementById('fdParamsNote');
  const fdParamCards    = document.getElementById('fdParamCards');
  const fdWelcomeInput  = document.getElementById('fdWelcomeInput');
  const fdWelcomeCreateBtn = document.getElementById('fdWelcomeCreateBtn');
  const fdWelcomeCreateLabel = document.getElementById('fdWelcomeCreateLabel');
  const fdInnerTabs     = document.querySelectorAll('.fd-inner-tab');
  const fdPanels        = {
    conversation: document.getElementById('fdPanelConversation'),
    code:         document.getElementById('fdPanelCode'),
    params:       document.getElementById('fdPanelParams'),
  };

  let currentFeatureId = null;
  let currentFeature   = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function fdEscape(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /** Render basic Markdown → safe HTML for AI response bubbles.
   *  Handles: **bold**, *italic*, `code`, numbered lists, bullet lists, line breaks. */
  function fdRenderMarkdown(s) {
    let html = fdEscape(s);
    // Bold **text** and __text__
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic *text* and _text_
    html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    html = html.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
    // Inline code `code`
    html = html.replace(/`([^`\n]+?)`/g, '<code class="fd-inline-code">$1</code>');
    // Numbered list items → RTL card with round badge
    html = html.replace(/^(\d+)\.\s+(.+)$/gm,
      '<div class="fd-md-li fd-md-ol"><span class="fd-md-num">$1</span><span class="fd-md-text">$2</span></div>');
    // Bullet list items → RTL card
    html = html.replace(/^[-*]\s+(.+)$/gm,
      '<div class="fd-md-li fd-md-ul"><span class="fd-md-bullet">•</span><span class="fd-md-text">$1</span></div>');
    // Line breaks (but not after list item divs)
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/(<\/div>)<br>/g, '$1');
    return html;
  }

  function showWelcome() {
    fdWelcome.classList.remove('hidden');
    fdDetail.classList.add('hidden');
    currentFeatureId = null;
    currentFeature   = null;
    document.querySelectorAll('.fd-feature-item').forEach((el) => el.classList.remove('active'));
    if (fdWelcomeInput) {
      fdWelcomeInput.value = '';
      setTimeout(() => fdWelcomeInput.focus(), 50);
    }
  }

  function statusLabel(s) {
    return s === 'active' ? 'פעיל' : s === 'archived' ? 'ארכיון' : 'טיוטה';
  }

  function applyInnerTab(tabId) {
    fdInnerTabs.forEach((t) => t.classList.toggle('active', t.dataset.fdtab === tabId));
    Object.entries(fdPanels).forEach(([k, el]) => el?.classList.toggle('hidden', k !== tabId));
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────

  async function loadFeatures() {
    try {
      const res = await fetch('/api/feature-designer');
      const d   = await res.json();
      if (!d.ok) return;
      renderSidebar(d.features);
    } catch (err) {
      console.error('[fd] loadFeatures', err);
    }
  }

  function renderSidebar(features) {
    if (!features.length) {
      fdFeatureList.innerHTML = '<div class="fd-sidebar-empty">אין פיצ\'רים עדיין.<br>לחץ "+ חדש" ליצירה.</div>';
      return;
    }
    fdFeatureList.innerHTML = features.map((f) => `
      <div class="fd-feature-item" data-fid="${f.id}" role="button" tabindex="0" aria-label="${fdEscape(f.name)}">
        <div class="fd-feature-item-name">${fdEscape(f.name)}</div>
        <div class="fd-feature-item-meta">
          <span class="fd-item-status-dot ${f.status}"></span>
          <span>${statusLabel(f.status)}</span>
          <span>${f.param_count || 0} פרמטרים</span>
        </div>
      </div>
    `).join('');

    fdFeatureList.querySelectorAll('.fd-feature-item').forEach((el) => {
      el.addEventListener('click', () => selectFeature(Number(el.dataset.fid)));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectFeature(Number(el.dataset.fid)); });
    });

    // Restore active highlight
    if (currentFeatureId) {
      const active = fdFeatureList.querySelector(`[data-fid="${currentFeatureId}"]`);
      if (active) active.classList.add('active');
    }
  }

  // ── Feature detail ────────────────────────────────────────────────────────

  async function selectFeature(id) {
    try {
      const res = await fetch(`/api/feature-designer/${id}`);
      const d   = await res.json();
      if (!d.ok || !d.feature) return;
      currentFeatureId = id;
      currentFeature   = d.feature;
      renderDetail(d.feature);
    } catch (err) {
      console.error('[fd] selectFeature', err);
    }
  }

  function renderDetail(f) {
    fdWelcome.classList.add('hidden');
    fdDetail.classList.remove('hidden');

    // Header
    fdDetailName.textContent = f.name;
    fdDetailDesc.textContent = f.description || '';

    // Status badge
    fdStatusBadge.textContent = statusLabel(f.status);
    fdStatusBadge.className = `fd-status-badge fd-status-${f.status}`;

    // Activate / deactivate buttons
    const isActive = f.status === 'active';
    fdActivateBtn.classList.toggle('hidden', isActive);
    fdDeactivateBtn.classList.toggle('hidden', !isActive);

    // Highlight sidebar
    document.querySelectorAll('.fd-feature-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.fid) === f.id);
    });

    // Conversation
    renderConversation(f.conversation || []);

    // Code
    fdCodeContent.textContent = f.cpp_code || '// (קוד לא נוצר עדיין)';

    // Params
    renderParams(f.params || [], f.status);

    applyInnerTab('conversation');
  }

  function renderConversation(conv) {
    fdMessages.innerHTML = '';
    conv.forEach((turn) => {
      const div = document.createElement('div');
      div.className = `fd-message ${turn.role === 'user' ? 'user' : 'assistant'}`;
      const isAI = turn.role !== 'user';
      div.innerHTML = `
        <div class="fd-message-role">${isAI ? 'ArduLab AI' : 'אתה'}</div>
        <div class="fd-message-bubble${isAI ? ' fd-md' : ''}">${isAI ? fdRenderMarkdown(turn.content) : fdEscape(turn.content)}</div>
      `;
      fdMessages.appendChild(div);
    });
    fdMessages.scrollTop = fdMessages.scrollHeight;
  }

  function renderParams(params, status) {
    const isActive = status === 'active';
    fdParamsNote.textContent = isActive
      ? `${params.length} פרמטרים — הפיצ'ר פעיל ופרמטריו מופיעים בחיפוש החכם.`
      : `${params.length} פרמטרים — הפעל את הפיצ'ר כדי שיופיעו בחיפוש החכם.`;

    fdParamCards.innerHTML = '';
    params.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'fd-param-card';
      const rangeText = (p.min_val != null && p.max_val != null)
        ? `טווח: ${p.min_val}–${p.max_val}`
        : '';
      card.innerHTML = `
        <div class="fd-param-header">
          <span class="fd-param-key">${fdEscape(p.param_key)}</span>
          <span class="fd-param-type-badge">${fdEscape(p.param_type || 'FLOAT')}</span>
        </div>
        ${p.description ? `<div class="fd-param-desc">${fdEscape(p.description)}</div>` : ''}
        ${p.description_he ? `<div class="fd-param-desc-he">${fdEscape(p.description_he)}</div>` : ''}
        <div class="fd-param-meta">
          <span>ברירת מחדל: <strong>${p.default_value ?? '—'}</strong></span>
          <span>ערך נוכחי: <strong>${p.current_value ?? p.default_value ?? '—'}</strong></span>
          ${p.units ? `<span>יחידות: <strong>${fdEscape(p.units)}</strong></span>` : ''}
          ${rangeText ? `<span>${fdEscape(rangeText)}</span>` : ''}
        </div>
        <div class="fd-param-edit-row">
          <input class="fd-param-input" type="text" value="${p.current_value ?? p.default_value ?? ''}"
            aria-label="ערך חדש עבור ${fdEscape(p.param_key)}" />
          <button class="fd-param-save-btn" type="button" data-pkey="${fdEscape(p.param_key)}">שמור ✓</button>
          <span class="fd-param-save-status"></span>
        </div>
      `;

      const saveBtn   = card.querySelector('.fd-param-save-btn');
      const valInput  = card.querySelector('.fd-param-input');
      const statusEl  = card.querySelector('.fd-param-save-status');

      saveBtn.addEventListener('click', async () => {
        const raw = valInput.value.trim();
        if (raw === '') { statusEl.textContent = 'הכנס ערך'; return; }
        saveBtn.disabled = true;
        statusEl.textContent = 'שומר…';
        try {
          const r = await fetch('/api/feature-designer/param-set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ param: p.param_key, value: Number(raw) }),
          });
          const rd = await r.json();
          if (!r.ok || !rd.ok) {
            statusEl.textContent = `✘ ${rd.message || 'שגיאה'}`;
          } else {
            statusEl.textContent = '✔ נשמר';
            // Update current_value display
            const metaSpan = card.querySelectorAll('.fd-param-meta strong')[1];
            if (metaSpan) metaSpan.textContent = raw;
          }
        } catch (e) {
          statusEl.textContent = `✘ ${e?.message || 'שגיאת רשת'}`;
        }
        saveBtn.disabled = false;
      });

      fdParamCards.appendChild(card);
    });
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async function createFeature(description) {
    if (!description.trim()) return;
    if (fdWelcomeCreateBtn) {
      fdWelcomeCreateBtn.disabled = true;
      if (fdWelcomeCreateLabel) fdWelcomeCreateLabel.textContent = 'יוצר… (עד 30 שניות)';
    }

    // Show thinking bubble in conversation area
    fdWelcome.classList.add('hidden');
    fdDetail.classList.remove('hidden');
    fdDetailName.textContent = 'יוצר פיצ\'ר…';
    fdDetailDesc.textContent = description;
    fdMessages.innerHTML = `
      <div class="fd-message user">
        <div class="fd-message-role">אתה</div>
        <div class="fd-message-bubble">${fdEscape(description)}</div>
      </div>
      <div class="fd-thinking-bubble">✨ AI כותב קוד ArduPilot…</div>
    `;
    fdStatusBadge.textContent = 'יוצר…';
    fdStatusBadge.className = 'fd-status-badge fd-status-draft';
    fdActivateBtn.classList.add('hidden');
    fdDeactivateBtn.classList.add('hidden');
    fdCodeContent.textContent = '';
    fdParamCards.innerHTML = '';
    applyInnerTab('conversation');

    try {
      const res = await fetch('/api/feature-designer/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.message || 'שגיאת שרת');
      currentFeatureId = d.feature.id;
      currentFeature   = d.feature;
      await loadFeatures();
      renderDetail(d.feature);
    } catch (err) {
      fdMessages.innerHTML += `<div class="fd-message assistant">
        <div class="fd-message-role">מערכת</div>
        <div class="fd-message-bubble">✘ ${fdEscape(err.message || 'שגיאה')}</div>
      </div>`;
      fdDetailName.textContent = 'שגיאה';
      showWelcome();
    } finally {
      if (fdWelcomeCreateBtn) {
        fdWelcomeCreateBtn.disabled = false;
        if (fdWelcomeCreateLabel) fdWelcomeCreateLabel.textContent = '✨ צור פיצ\'ר';
      }
      if (fdWelcomeInput) fdWelcomeInput.value = '';
    }
  }

  // ── Chat / Refine ─────────────────────────────────────────────────────────
  // Uses the /chat endpoint which handles both conversational questions and
  // code-update requests, returning type "chat" or "update" accordingly.

  async function refineFeature(feedback) {
    if (!feedback.trim() || !currentFeatureId) return;
    fdSendBtn.disabled = true;
    if (fdSendLabel) fdSendLabel.textContent = 'שולח…';

    // Add user message
    const userMsg = document.createElement('div');
    userMsg.className = 'fd-message user';
    userMsg.innerHTML = `<div class="fd-message-role">אתה</div><div class="fd-message-bubble">${fdEscape(feedback)}</div>`;
    fdMessages.appendChild(userMsg);

    // Thinking bubble
    const thinkBubble = document.createElement('div');
    thinkBubble.className = 'fd-thinking-bubble';
    thinkBubble.textContent = '✨ AI חושב…';
    fdMessages.appendChild(thinkBubble);
    fdMessages.scrollTop = fdMessages.scrollHeight;

    try {
      const res = await fetch(`/api/feature-designer/${currentFeatureId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: feedback }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.message || 'שגיאת שרת');

      thinkBubble.remove();

      // Show AI response as a chat message
      const aiMsg = document.createElement('div');
      aiMsg.className = 'fd-message assistant';
      const badgeHtml = d.type === 'update'
        ? '<span class="fd-update-badge">✦ עדכון קוד</span>'
        : '';
      aiMsg.innerHTML = `<div class="fd-message-role">ArduLab AI</div><div class="fd-message-bubble fd-md">${badgeHtml}${fdRenderMarkdown(d.message)}</div>`;
      fdMessages.appendChild(aiMsg);
      fdMessages.scrollTop = fdMessages.scrollHeight;

      // If the AI also updated the code, refresh the view
      if (d.type === 'update' && d.feature) {
        currentFeature = d.feature;
        renderDetail(d.feature);
        await loadFeatures();
      }
    } catch (err) {
      thinkBubble.className = 'fd-message assistant';
      thinkBubble.innerHTML = `<div class="fd-message-role">שגיאה</div><div class="fd-message-bubble">✘ ${fdEscape(err.message)}</div>`;
    } finally {
      fdSendBtn.disabled = false;
      if (fdSendLabel) fdSendLabel.textContent = 'שלח ↩';
      fdFeedbackInput.value = '';
    }
  }

  // ── Status change ─────────────────────────────────────────────────────────

  async function setFeatureStatus(id, status) {
    try {
      const res = await fetch(`/api/feature-designer/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const d = await res.json();
      if (!d.ok) return;
      currentFeature = d.feature;
      renderDetail(d.feature);
      await loadFeatures();
    } catch (err) {
      console.error('[fd] setFeatureStatus', err);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function deleteFeature(id) {
    if (!confirm('מחוק את הפיצ\'ר? פעולה זו לא הפיכה.')) return;
    try {
      await fetch(`/api/feature-designer/${id}`, { method: 'DELETE' });
      showWelcome();
      await loadFeatures();
    } catch (err) {
      console.error('[fd] deleteFeature', err);
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  fdNewBtn?.addEventListener('click', showWelcome);

  fdWelcomeCreateBtn?.addEventListener('click', () => {
    createFeature(fdWelcomeInput?.value || '');
  });

  fdWelcomeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      createFeature(fdWelcomeInput.value);
    }
  });

  // Example chips
  document.querySelectorAll('.fd-example-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (fdWelcomeInput) {
        fdWelcomeInput.value = chip.dataset.example || '';
        fdWelcomeInput.focus();
      }
    });
  });

  // Inner tabs
  fdInnerTabs.forEach((tab) => {
    tab.addEventListener('click', () => applyInnerTab(tab.dataset.fdtab));
  });

  // Feedback send
  fdSendBtn?.addEventListener('click', () => refineFeature(fdFeedbackInput?.value || ''));

  fdFeedbackInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      refineFeature(fdFeedbackInput.value);
    }
  });

  // Activate / Deactivate / Delete
  fdActivateBtn?.addEventListener('click', () => {
    if (currentFeatureId) setFeatureStatus(currentFeatureId, 'active');
  });
  fdDeactivateBtn?.addEventListener('click', () => {
    if (currentFeatureId) setFeatureStatus(currentFeatureId, 'draft');
  });
  fdDeleteBtn?.addEventListener('click', () => {
    if (currentFeatureId) deleteFeature(currentFeatureId);
  });

  // Copy code
  fdCopyCodeBtn?.addEventListener('click', async () => {
    const code = fdCodeContent?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      fdCopyCodeBtn.textContent = 'הועתק ✓';
      setTimeout(() => { fdCopyCodeBtn.textContent = 'העתק קוד'; }, 2000);
    } catch {
      fdCopyCodeBtn.textContent = 'שגיאה';
    }
  });

  // Load when tab is opened
  const featureDesignerTabBtn = document.querySelector('.tab[data-tab="featureDesigner"]');
  if (featureDesignerTabBtn) {
    featureDesignerTabBtn.addEventListener('click', () => {
      loadFeatures();
    });
  }

  // Initial load if tab is already active
  const isTabActive = document.querySelector('.tab.active')?.dataset?.tab === 'featureDesigner';
  if (isTabActive) loadFeatures();
})();

// ══════════════════════════════════════════════════════════════════════════════
// Global settings (gear in top bar) — volume, voices, STT
// ══════════════════════════════════════════════════════════════════════════════
(function initGlobalSettings() {
  const STORAGE_KEY = 'vlc_settings_v1';
  function defaults() {
    return { ttsVolume: 1, elevenVoiceId: '', feSttLangOverride: '', browserVoiceURI: '' };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      return { ...defaults(), ...JSON.parse(raw) };
    } catch {
      return defaults();
    }
  }
  window.__vlcSettings = load();
  window.__vlcPersistSettings = function vlcPersistSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(window.__vlcSettings));
    } catch { /* ignore */ }
  };

  const btn    = document.getElementById('globalSettingsBtn');
  const modal  = document.getElementById('globalSettingsModal');
  if (!btn || !modal) return;

  const closeBtns   = modal.querySelectorAll('[data-close="1"]');
  const volSlider   = document.getElementById('gsVolumeSlider');
  const volLabel    = document.getElementById('gsVolumeLabel');
  const elevenSel   = document.getElementById('gsElevenVoice');
  const browserSel  = document.getElementById('gsBrowserVoice');
  const sttSel      = document.getElementById('gsSttLang');
  const permBody    = document.getElementById('gsPermissionsBody');
  const sttHint     = document.getElementById('gsSttHint');

  async function openModal() {
    modal.hidden = false;
    await refreshPermissions();
    await populateElevenVoices();
    populateBrowserVoices();
    syncFormFromStore();
    refreshSttHint();
  }

  function closeModal() {
    modal.hidden = true;
  }

  function syncFormFromStore() {
    const s = window.__vlcSettings;
    const pct = Math.round(Math.min(100, Math.max(0, Number(s.ttsVolume != null ? s.ttsVolume : 1) * 100)));
    if (volSlider) volSlider.value = String(pct);
    if (volLabel) volLabel.textContent = `${pct}%`;
    if (sttSel) sttSel.value = s.feSttLangOverride || '';
    if (browserSel) {
      const uri = s.browserVoiceURI || '';
      browserSel.value = uri && [...browserSel.options].some((o) => o.value === uri) ? uri : '';
    }
    if (elevenSel) {
      const id = s.elevenVoiceId || '';
      elevenSel.value = id && [...elevenSel.options].some((o) => o.value === id) ? id : '';
    }
  }

  async function refreshPermissions() {
    if (!permBody) return;
    let fe = {};
    try {
      const r = await fetch('/api/flight-engineer/status');
      fe = await r.json();
    } catch { /* ignore */ }
    const rc = Number.isFinite(Number(fe.rcApprovalChannel)) ? fe.rcApprovalChannel : '—';
    const inflightOn = !!fe.fcInflightOverrideConfigured;
    const inflightLine = inflightOn
      ? 'בשרת מופעלת אפשרות <strong>כתיבת פרמטרים מסוכנים בזמן ARM</strong> רק לאחר אישור מפורט מהטייס (<code>ADVISOR_FC_INFLIGHT_OVERRIDE</code>).'
      : 'בשרת <strong>לא</strong> מופעלת כתיבה לפרמטרים לא-bypass בזמן ARM — נדרש Disarm או מדיניות שרת מתאימה.';
    permBody.innerHTML = `
      <ul class="gs-perms-list">
        <li><strong>יועץ (צ׳אט):</strong> אין כתיבה ישירה לבקר מהדפדפן. שינוי פרמטרים רק דרך הצעות מאושרות ו־<strong>Apply</strong> בשרת (כולל רישום audit).</li>
        <li><strong>מהנדס טיסה:</strong> שינוי פרמטר דורש אישור — מתג RC בערוץ <strong>${rc}</strong> או Apply מאושר. ${inflightLine}</li>
        <li>פרטים: <code>docs/ADVISOR_SAFETY.md</code></li>
      </ul>`;
  }

  async function populateElevenVoices() {
    if (!elevenSel) return;
    const saved = String(window.__vlcSettings.elevenVoiceId || '').trim();
    elevenSel.innerHTML = '<option value="">ברירת מחדל מהשרת (ELEVENLABS_VOICE_ID)</option>';
    try {
      const r = await fetch('/api/flight-engineer/voices');
      const d = await r.json();
      if (!d.ok || !Array.isArray(d.voices)) return;
      for (const v of d.voices) {
        const opt = document.createElement('option');
        opt.value = v.voice_id;
        opt.textContent = v.name || v.voice_id;
        elevenSel.appendChild(opt);
      }
      if (saved && [...elevenSel.options].some((o) => o.value === saved)) elevenSel.value = saved;
    } catch { /* ignore */ }
  }

  let browserVoicesHooked = false;

  function populateBrowserVoices() {
    if (!browserSel || !('speechSynthesis' in window)) return;
    const saved = window.__vlcSettings.browserVoiceURI || '';
    const fill = () => {
      browserSel.innerHTML = '<option value="">אוטומטי — לפי שפה</option>';
      try {
        const voices = speechSynthesis.getVoices();
        for (const v of voices) {
          const opt = document.createElement('option');
          opt.value = v.voiceURI;
          opt.textContent = `${v.name} (${v.lang})`;
          browserSel.appendChild(opt);
        }
        browserSel.value = saved && [...browserSel.options].some((o) => o.value === saved) ? saved : '';
      } catch { /* ignore */ }
    };
    fill();
    if (!browserVoicesHooked) {
      browserVoicesHooked = true;
      try {
        speechSynthesis.addEventListener('voiceschanged', fill);
      } catch { /* ignore */ }
    }
  }

  function refreshSttHint() {
    if (!sttHint) return;
    sttHint.textContent =
      'שינוי השפה נכנס לתוקף בהפעלה הבאה של המיקרופון (או ריענון דף). ברירת השרת נקבעת ב־FE_STT_LANG.';
  }

  btn.addEventListener('click', () => openModal());
  closeBtns.forEach((el) => el.addEventListener('click', closeModal));

  volSlider?.addEventListener('input', () => {
    const pct = Number(volSlider.value) || 0;
    if (volLabel) volLabel.textContent = `${pct}%`;
    window.__vlcSettings.ttsVolume = pct / 100;
    window.__vlcPersistSettings();
  });

  elevenSel?.addEventListener('change', () => {
    window.__vlcSettings.elevenVoiceId = String(elevenSel.value || '').trim();
    window.__vlcPersistSettings();
  });

  browserSel?.addEventListener('change', () => {
    window.__vlcSettings.browserVoiceURI = String(browserSel.value || '').trim();
    window.__vlcPersistSettings();
  });

  sttSel?.addEventListener('change', () => {
    window.__vlcSettings.feSttLangOverride = String(sttSel.value || '').trim();
    window.__vlcPersistSettings();
    try {
      window.__vlcFeResetRecognition?.();
    } catch { /* ignore */ }
    refreshSttHint();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// Flight Engineer — Voice AI co-pilot
// ══════════════════════════════════════════════════════════════════════════════
(function initFlightEngineer() {
  // ── Element refs ────────────────────────────────────────────────────────────
  const panel         = document.getElementById('flightEngineer');
  if (!panel) return;

  const feMicBtn        = document.getElementById('feMicBtn');
  const feMicStatus     = document.getElementById('feMicStatus');
  const feInterimText   = document.getElementById('feInterimText');
  const feVadFill       = document.getElementById('feVadFill');
  const feChat          = document.getElementById('feChat');
  const feTtsStatus     = document.getElementById('feTtsStatus');
  const feTtsLabel      = document.getElementById('feTtsLabel');
  const feNotesList     = document.getElementById('feNotesList');
  const feNoteInput     = document.getElementById('feNoteInput');
  const feNoteAddBtn    = document.getElementById('feNoteAddBtn');
  const feClearNotesBtn = document.getElementById('feClearNotesBtn');
  const feNewSessionBtn = document.getElementById('feNewSessionBtn');

  // ── State ────────────────────────────────────────────────────────────────────
  let sessionId   = crypto.randomUUID();
  let history     = [];          // [{role, content}]
  let micState    = 'idle';      // idle | listening | muted | thinking | speaking
  let recognition = null;
  let currentAudio = null;       // HTMLAudioElement playing TTS
  let ttsMode     = 'browser';   // elevenlabs | browser
  let vadCtx      = null;
  let vadAnalyser = null;
  let vadAnimId   = null;
  /** Barge-in tuning: suppress triggers right when TTS audio starts */
  let feBargeQuietUntilMs = 0;
  /** Consecutive “loud-ish” ticks while engineer is speaking → real interrupt */
  let feBargeVadHits      = 0;
  /** Last combined mic-energy score ( fft + RMS ) — aligns STT-aided cutoff with physics */
  let feLastMicCombo      = 0;
  const FE_BARGE_WARMUP_MS       = 380;
  const FE_BARGE_VAD_FRAMES      = 5;
  /** Heuristic combo ~same scale as old raw avg(~20 gate); RMS mixed in catches speech fft misses */
  const FE_BARGE_TRIGGER_COMBO   = 19;
  /** Extra uplift required before partial transcript alone cancels TTS (mitigate loudspeaker bleed) */
  const FE_STT_PARTIAL_NEED_COMBO_DELTA = 7;
  let pendingChange  = null;     // { key, value, reason, token } — awaiting pilot approval
  let feRcApprovalChannel = 7;   // RC channel for hardware approval (updated from /status)
  /** @type {'auto'|'he-IL'|'en-US'|'zh-CN'} from server .env FE_STT_LANG — biases Web Speech language */
  let feSttLangCfg = 'auto';

  function computeFeRecognitionLang() {
    const o = typeof window !== 'undefined' && window.__vlcSettings?.feSttLangOverride;
    if (o === 'he-IL' || o === 'en-US' || o === 'zh-CN') return o;
    if (o === 'auto_client') {
      try {
        const b = sessionStorage.getItem('feSttBias');
        if (b === 'en') return 'en-US';
        if (b === 'he') return 'he-IL';
        if (b === 'zh') return 'zh-CN';
      } catch { /* ignore */ }
      const nav = navigator.language || '';
      if (/^zh/i.test(nav)) return 'zh-CN';
      return /^en\b/i.test(nav) ? 'en-US' : 'he-IL';
    }
    if (feSttLangCfg === 'he-IL' || feSttLangCfg === 'en-US' || feSttLangCfg === 'zh-CN') return feSttLangCfg;
    try {
      const b = sessionStorage.getItem('feSttBias');
      if (b === 'en') return 'en-US';
      if (b === 'he') return 'he-IL';
      if (b === 'zh') return 'zh-CN';
    } catch { /* ignore */ }
    const nav = navigator.language || '';
    if (/^zh/i.test(nav)) return 'zh-CN';
    return /^en\b/i.test(nav) ? 'en-US' : 'he-IL';
  }

  // ── Status helpers ───────────────────────────────────────────────────────────
  function setMicState(state) {
    micState = state;
    feMicBtn.className = 'fe-mic-btn' + (state !== 'idle' ? ` ${state}` : '');
    const labels = {
      idle:      'לחץ להתחלת האזנה',
      listening: '🟢 מאזין — פשוט דבר',
      muted:     '🔇 מושתק — לחץ להמשך',
      thinking:  '💭 חושב…',
      speaking:  '🔊 מדבר…',
    };
    feMicStatus.textContent = labels[state] || state;
  }

  function setTtsMode(mode, label) {
    ttsMode = mode;
    feTtsStatus.dataset.mode = mode;
    feTtsLabel.textContent   = label;
  }

  // ── Check server status ──────────────────────────────────────────────────────
  async function checkStatus() {
    try {
      const r = await fetch('/api/flight-engineer/status');
      const d = await r.json();
      if (d.elevenlabs) {
        let elLabel = 'ElevenLabs ✓';
        const t = d.elevenlabsTts;
        if (t?.model) {
          if (String(t.model).includes('eleven_v3')) elLabel = 'ElevenLabs ✓ v3';
          else if (String(t.model).includes('flash')) elLabel = 'ElevenLabs ✓ Flash';
          else elLabel = `ElevenLabs ✓ ${t.model}`;
        }
        setTtsMode('elevenlabs', elLabel);
      } else {
        setTtsMode('browser', 'Browser TTS');
      }
      if (d.rcApprovalChannel) {
        feRcApprovalChannel = d.rcApprovalChannel;
        feRcApprovalChannelGlobal = d.rcApprovalChannel;
      }
      if (d.feSttLang === 'auto' || d.feSttLang === 'he-IL' || d.feSttLang === 'en-US' || d.feSttLang === 'zh-CN') {
        feSttLangCfg = d.feSttLang;
      }
    } catch(err) {
      setTtsMode('error', 'שגיאת חיבור');
    }
  }

  // ── Chat history rendering ────────────────────────────────────────────────────
  function renderEmpty() {
    feChat.innerHTML = `
      <div class="fe-welcome-hero">
        <div class="fe-welcome-card">
          <div class="fe-welcome-kicker">זמין לשיחה</div>
          <div class="fe-welcome-icon">🎙</div>
          <h2 class="fe-welcome-title">מהנדס הטיסה שלך</h2>
          <p class="fe-welcome-sub">אבחון וטלמטריה כשיש חיבור לבקר — וגם בלי מטוס מחובר: התייעצות על הארכיטקטורה של הקונסולה, פרמטרים וארדופליין, והכנה לטיסה. בחר נושא או תאר במילים שלך.</p>
          <div class="fe-welcome-chips">
            <button type="button" class="fe-chip" data-prompt="מה הקונסולה והמהנדס יודעים לעשות גם כשאין טיסן מחובר לבקר?">מה אפשר בלי חיבור?</button>
            <button type="button" class="fe-chip" data-prompt="הטיסה לא יציבה — מה לבדוק ברמת פרמטרים וברמת חומרה?">הטיסה לא יציבה</button>
            <button type="button" class="fe-chip" data-prompt="תן הסבר קצר על מערכת הוויז׳ן, ה-VIO וה-EKF בהקשר של Vision Landing">וויז׳ן ו־EKF ב-VLC</button>
            <button type="button" class="fe-chip" data-prompt="זה קרה לנו כבר בעבר?">זה קרה לנו כבר?</button>
          </div>
          <div class="fe-welcome-hint"><span class="fe-hint-dot"></span>לחץ על המיקרופון — נשמיע תשובה בקול</div>
        </div>
      </div>`;
    feChat.querySelectorAll('.fe-chip[data-prompt]').forEach((btn) =>
      btn.addEventListener('click', () => handlePilotTurn(btn.dataset.prompt)));
  }

  function addMessage(role, text) {
    feChat.querySelector('.fe-welcome-hero')?.remove();
    const emptyEl = feChat.querySelector('.fe-chat-empty');
    if (emptyEl) emptyEl.remove();
    // Remove any previous suggestion chips when a new turn starts
    feChat.querySelector('.fe-suggest-row')?.remove();

    const now   = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    const div   = document.createElement('div');
    div.className = `fe-msg fe-msg--${role}`;
    div.innerHTML = `
      <div class="fe-msg-bubble">${text.replace(/</g, '&lt;').replace(/\n/g,'<br>')}</div>
      <span class="fe-msg-time">${now}</span>`;
    feChat.appendChild(div);
    feChat.scrollTop = feChat.scrollHeight;
    history.push({ role, content: text });
  }

  /** Render inline disambiguation / quick-reply chips after the last engineer message. */
  function renderSuggestionChips(suggestions) {
    feChat.querySelector('.fe-suggest-row')?.remove();
    if (!Array.isArray(suggestions) || suggestions.length === 0) return;
    const row = document.createElement('div');
    row.className = 'fe-suggest-row';
    for (const chip of suggestions.slice(0, 4)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fe-suggest-chip';
      btn.textContent = chip;
      btn.addEventListener('click', () => {
        row.remove();
        handlePilotTurn(chip);
      });
      row.appendChild(btn);
    }
    feChat.appendChild(row);
    feChat.scrollTop = feChat.scrollHeight;
  }

  // ── Notes rendering ───────────────────────────────────────────────────────────
  function renderNotes(notes) {
    if (!notes || !notes.length) {
      feNotesList.innerHTML = '<div class="fe-notes-empty">אין פתקים עדיין</div>';
      return;
    }
    feNotesList.innerHTML = notes.map((n) => {
      const t = new Date(n.ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      const cat = n.category || 'general';
      return `
        <div class="fe-note-item" data-cat="${cat}" data-id="${n.id}">
          <button class="fe-note-del" data-id="${n.id}" title="מחק">✕</button>
          <div>${n.content.replace(/</g,'&lt;')}</div>
          <div class="fe-note-meta"><span>${t}</span><span>${cat}</span></div>
        </div>`;
    }).join('');
  }

  async function refreshNotes() {
    try {
      const r = await fetch(`/api/flight-engineer/notes/${sessionId}`);
      const d = await r.json();
      if (d.ok) renderNotes(d.notes);
    } catch { /* silent */ }
  }

  // ── TTS playback ──────────────────────────────────────────────────────────────
  async function speak(text) {
    if (!text) return;
    stopSpeaking();
    setMicState('speaking');
    feBargeVadHits = 0;
    feBargeQuietUntilMs = Date.now() + FE_BARGE_WARMUP_MS;

    if (ttsMode === 'elevenlabs') {
      try {
        const vid = String(window.__vlcSettings?.elevenVoiceId || '').trim();
        const payload = { text };
        if (vid) payload.voiceId = vid;
        const resp = await fetch('/api/flight-engineer/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (resp.status === 204) {
          // No key — fall through to browser TTS
          speakBrowser(text);
          return;
        }
        if (resp.ok) {
          const blob = await resp.blob();
          const url  = URL.createObjectURL(blob);
          currentAudio = new Audio(url);
          const rawVol = Number(window.__vlcSettings?.ttsVolume ?? 1);
          const vol = Math.min(1, Math.max(0, Number.isFinite(rawVol) ? rawVol : 1));
          currentAudio.volume = vol;
          currentAudio.onended = () => { URL.revokeObjectURL(url); resumeListening(); };
          currentAudio.onerror = () => { resumeListening(); speakBrowser(text); };
          await currentAudio.play();
          return;
        }
      } catch { /* fall through */ }
    }

    speakBrowser(text);
  }

  function speakBrowser(text) {
    if (!('speechSynthesis' in window)) { setMicState('idle'); return; }
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = (() => {
      const t = String(text || '');
      if (/[\u0590-\u05FF]/.test(t)) return 'he-IL';
      if (/[\u4e00-\u9fff]/.test(t)) return 'zh-CN';
      return 'en-US';
    })();
    utt.rate = 1.05;
    utt.pitch = 1.0;
    const rawVu = Number(window.__vlcSettings?.ttsVolume ?? 1);
    utt.volume = Math.min(1, Math.max(0, Number.isFinite(rawVu) ? rawVu : 1));
    const voices = speechSynthesis.getVoices();
    const uri = window.__vlcSettings?.browserVoiceURI;
    if (uri) {
      const picked = voices.find((x) => x.voiceURI === uri);
      if (picked) utt.voice = picked;
    } else {
      const preferred = voices.find((v) =>
        v.lang.startsWith(utt.lang.split('-')[0]) && !v.name.includes('compact'));
      if (preferred) utt.voice = preferred;
    }
    utt.onend  = () => resumeListening();
    utt.onerror = () => resumeListening();
    speechSynthesis.speak(utt);
  }

  function stopSpeaking() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    speechSynthesis?.cancel();
  }

  // ── VAD (Voice Activity Detection) ───────────────────────────────────────────
  async function startVad(stream) {
    if (!stream) return;
    try {
      vadCtx     = new AudioContext();
      vadAnalyser = vadCtx.createAnalyser();
      vadAnalyser.fftSize = 256;
      const src   = vadCtx.createMediaStreamSource(stream);
      src.connect(vadAnalyser);
      const data  = new Uint8Array(vadAnalyser.frequencyBinCount);
      const tdBuf = new Uint8Array(vadAnalyser.fftSize);
      const tick = () => {
        vadAnalyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        vadAnalyser.getByteTimeDomainData(tdBuf);
        let sumSq = 0;
        for (let i = 0; i < tdBuf.length; i++) {
          const z = (tdBuf[i] - 128) / 128;
          sumSq += z * z;
        }
        const rms        = Math.sqrt(sumSq / tdBuf.length);
        const rmsScaled  = Math.min(100, rms * 620);
        const combo      = avg * 0.55 + rmsScaled * 0.45;
        feLastMicCombo   = combo;
        const pct = Math.min(100, avg * 3);
        feVadFill.style.height = `${pct}%`;
        /* Barge-in: sustained energy above combo threshold (speech often lifts RMS sooner than bleed-only TTS) */
        if (micState === 'speaking' && Date.now() >= feBargeQuietUntilMs) {
          if (combo > FE_BARGE_TRIGGER_COMBO) {
            feBargeVadHits += 1;
            if (feBargeVadHits >= FE_BARGE_VAD_FRAMES) {
              feBargeVadHits = 0;
              stopSpeaking();
              resumeListening();
            }
          } else {
            feBargeVadHits = Math.max(0, feBargeVadHits - 2);
          }
        } else feBargeVadHits = 0;
        vadAnimId = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* VAD optional */ }
  }

  function stopVad() {
    if (vadAnimId) { cancelAnimationFrame(vadAnimId); vadAnimId = null; }
    if (vadCtx)   { vadCtx.close(); vadCtx = null; }
    feVadFill.style.height = '0%';
  }

  // ── Speech Recognition ────────────────────────────────────────────────────────
  function buildRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous      = true;   // keep listening after each utterance
    r.interimResults  = true;
    r.maxAlternatives = 1;
    r.lang = computeFeRecognitionLang();

    r.onstart = () => {
      if (micState !== 'thinking' && micState !== 'speaking') setMicState('listening');
    };
    r.onend = () => {
      // Auto-restart if we're still supposed to be listening (Chrome stops on silence)
      if (micState === 'listening') {
        setTimeout(() => {
          if (micState === 'listening' && recognition) {
            try { recognition.start(); } catch { /* already running */ }
          }
        }, 150);
      } else if (micState !== 'muted' && micState !== 'thinking' && micState !== 'speaking') {
        stopVad();
        setMicState('idle');
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed') {
        addMessage('engineer', '⚠ אין גישה למיקרופון. אשר הרשאה בדפדפן.');
        stopVad();
        setMicState('idle');
      }
      // no-speech / aborted / audio-capture: just keep going (auto-restart via onend)
    };
    r.onresult = async (e) => {
      const result = e.results[e.results.length - 1];
      const transcript = result[0].transcript;
      if (!result.isFinal) {
        feInterimText.textContent = transcript;
        /** Partial transcripts + clear mic uplift → cut TTS faster than VADavg-only (still gated vs echo). */
        const tPart = transcript.trim();
        if (micState === 'speaking'
            && Date.now() >= feBargeQuietUntilMs
            && tPart.length >= 4
            && feLastMicCombo > FE_BARGE_TRIGGER_COMBO + FE_STT_PARTIAL_NEED_COMBO_DELTA) {
          stopSpeaking();
          resumeListening();
        }
        return;
      }
      feInterimText.textContent = '';
      const text = transcript.trim();
      if (!text) return;

      /* Voice approval: even while TTS is playing, honour explicit approval cues */
      if (pendingChange && /מאשר|confirm|确认|批准/i.test(text)) {
        feBargeVadHits = 0;
        stopSpeaking();
        submitApproval(pendingChange.token);
        return;
      }

      /** Final hypothesis while engineer still talking counts as deliberate interrupt → handle turn */
      if (micState === 'speaking') {
        feBargeVadHits = 0;
        stopSpeaking();
        await handlePilotTurn(text);
        return;
      }

      if (feSttLangCfg === 'auto') {
        let he = 0;
        let la = 0;
        let zh = 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (/[\u0590-\u05FF]/.test(ch)) he++;
          else if (/[\u4e00-\u9fff]/.test(ch)) zh++;
          else if (/[A-Za-z]/.test(ch)) la++;
        }
        try {
          if (zh >= 2 && zh >= he && zh >= la * 0.5) sessionStorage.setItem('feSttBias', 'zh');
          else if (la >= 6 && la > he * 2 && la > zh * 2) sessionStorage.setItem('feSttBias', 'en');
          else if (he >= 4 && he > la * 2 && he > zh * 2) sessionStorage.setItem('feSttBias', 'he');
        } catch { /* ignore */ }
        const nl = computeFeRecognitionLang();
        if (r.lang !== nl) r.lang = nl;
      }

      if (micState === 'thinking') return;
      await handlePilotTurn(text);
    };
    return r;
  }

  // Mic button toggle: idle/muted → start listening; listening → mute; thinking/speaking → cancel
  async function toggleMic() {
    if (micState === 'thinking' || micState === 'speaking') {
      stopSpeaking();
      if (recognition) { try { recognition.stop(); } catch { /* */ } }
      setMicState('muted');
      return;
    }
    if (micState === 'listening') {
      // Mute
      if (recognition) { try { recognition.stop(); } catch { /* */ } }
      stopVad();
      setMicState('muted');
      return;
    }
    // idle or muted → start always-on listening
    if (!recognition || micState === 'idle') recognition = buildRecognition();
    if (!recognition) {
      addMessage('engineer', 'הדפדפן אינו תומך בזיהוי קולי. השתמש ב-Chrome.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startVad(stream);
      setMicState('listening');
      recognition.start();
    } catch {
      addMessage('engineer', '⚠ אין גישה למיקרופון. אשר הרשאה בדפדפן.');
      setMicState('idle');
    }
  }

  // Resume listening after AI speech ends (unless user manually muted)
  function resumeListening() {
    if (micState === 'muted') return;
    setMicState('listening');
    if (!recognition) recognition = buildRecognition();
    if (recognition) {
      try { recognition.start(); } catch { /* already running */ }
    }
  }

  // ── Main turn handler ─────────────────────────────────────────────────────────
  async function handlePilotTurn(text) {
    addMessage('user', text);
    setMicState('thinking');
    try {
      const fidRaw = advisorFlightSelect?.value;
      const flightId = fidRaw ? Number(fidRaw) : null;
      const res = await fetch('/api/flight-engineer/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sessionId,
          flightId: Number.isInteger(flightId) && flightId > 0 ? flightId : null,
          /** Prior turns only — current utterance lives in `text` / server telemetry blob (no duplicate trailing user). */
          history: history.length > 0 ? history.slice(0, -1).slice(-12) : [],
        }),
      });
      const data = await res.json();
      if (!data.ok) { addMessage('engineer', data.message || 'שגיאה'); resumeListening(); return; }
      addMessage('engineer', data.text);
      if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        renderSuggestionChips(data.suggestions);
      }
      if (data.notes) renderNotes(data.notes);
      if (data.pendingChange) {
        pendingChange = data.pendingChange;
        renderApprovalCard(data.pendingChange);
      }
      await speak(data.text);
    } catch {
      addMessage('engineer', '⚠ שגיאת חיבור לשרת');
      resumeListening();
    }
  }

  // ── Param approval card ──────────────────────────────────────────────────────
  function renderApprovalCard({ key, value, reason, token }) {
    document.getElementById('feApprovalCard')?.remove();
    const div = document.createElement('div');
    div.className = 'fe-approval-card';
    div.id = 'feApprovalCard';
    div.innerHTML = `
      <div class="fe-approval-header">✋ ממתין לאישורך</div>
      <div class="fe-approval-param">
        <span class="fe-param-key">${String(key).replace(/</g,'&lt;')}</span>
        <span class="fe-param-arrow">→</span>
        <span class="fe-param-val">${value}</span>
      </div>
      <div class="fe-approval-reason">${String(reason).replace(/</g,'&lt;')}</div>
      <div class="fe-approval-actions">
        <input id="feApprovalInput" class="fe-approval-input" placeholder='הקלד "מאשר" או אמור בקול' autocomplete="off" />
        <button id="feApprovalBtn" class="fe-approve-btn">אשר</button>
        <button id="feRejectBtn"  class="fe-reject-btn">בטל</button>
      </div>
      <div class="fe-approval-rc-hint">💡 ניתן גם להפעיל מפסק RC ${feRcApprovalChannel} לאישור</div>`;
    feChat.appendChild(div);
    feChat.scrollTop = feChat.scrollHeight;

    document.getElementById('feApprovalBtn').addEventListener('click', () => {
      if ((document.getElementById('feApprovalInput')?.value ?? '').trim() === 'מאשר') {
        submitApproval(token);
      } else {
        document.getElementById('feApprovalInput')?.focus();
      }
    });
    document.getElementById('feApprovalInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim() === 'מאשר') submitApproval(token);
    });
    document.getElementById('feRejectBtn').addEventListener('click', () => {
      pendingChange = null;
      div.remove();
      addMessage('engineer', 'ההצעה בוטלה.');
    });
  }

  async function submitApproval(token) {
    if (!pendingChange || pendingChange.token !== token) return;
    const change = pendingChange;
    pendingChange = null;
    document.getElementById('feApprovalCard')?.remove();
    addMessage('engineer', `מיישם: ${change.key} ← ${change.value}…`);
    try {
      const res = await fetch('/api/flight-engineer/apply-param', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token }),
      });
      const data = await res.json();
      if (data.ok) {
        const suffix = data.method === 'offline' ? ' (FC לא מחובר — לא נשלח למטוס)' : ' ✓';
        addMessage('engineer', `${change.key} עודכן ל-${change.value}${suffix}`);
        await speak(`${change.key} עודכן בהצלחה`);
      } else {
        addMessage('engineer', `שגיאה: ${data.message}`);
        resumeListening();
      }
    } catch {
      addMessage('engineer', '⚠ שגיאת חיבור — הפרמטר לא הוחל');
      resumeListening();
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────────
  feMicBtn.addEventListener('click', toggleMic);

  // Space bar: toggle mute/listen (only when FE tab is active and not in a text input)
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
    if (activeTab !== 'flightEngineer') return;
    e.preventDefault();
    toggleMic();
  });

  // RC-switch approval: listen via custom DOM event dispatched from SSE handler
  document.addEventListener('fe:rc-approve', () => {
    if (pendingChange) submitApproval(pendingChange.token);
  });

  // Notes: delete single
  feNotesList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.fe-note-del');
    if (!btn) return;
    const noteId = btn.dataset.id;
    await fetch(`/api/flight-engineer/notes/${sessionId}/${noteId}`, { method: 'DELETE' });
    refreshNotes();
  });

  // Notes: clear all
  feClearNotesBtn.addEventListener('click', async () => {
    if (!confirm('למחוק את כל הפתקים?')) return;
    await fetch(`/api/flight-engineer/notes/${sessionId}`, { method: 'DELETE' });
    refreshNotes();
  });

  // Notes: add manual
  async function addManualNote() {
    const txt = feNoteInput.value.trim();
    if (!txt) return;
    feNoteInput.value = '';
    await fetch(`/api/flight-engineer/notes/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: txt }),
    });
    refreshNotes();
  }
  feNoteAddBtn.addEventListener('click', addManualNote);
  feNoteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualNote(); });

  async function saveSessionDebrief() {
    if (!history.length) return;
    try {
      await fetch('/api/flight-engineer/debrief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, history: history.slice(-40) }),
      });
    } catch { /* best effort: don't block new-session UX */ }
  }

  // New session
  feNewSessionBtn.addEventListener('click', async () => {
    if (!confirm('להתחיל שיחה חדשה? ההיסטוריה תיאפס (פתקים נשמרים).')) return;
    await saveSessionDebrief();
    stopSpeaking();
    if (recognition) { try { recognition.stop(); } catch { /* */ } recognition = null; }
    stopVad();
    sessionId    = crypto.randomUUID();
    history      = [];
    pendingChange = null;
    try { sessionStorage.removeItem('feSttBias'); } catch { /* */ }
    setMicState('idle');
    renderEmpty();
    renderNotes([]);
  });

  // ── Init ─────────────────────────────────────────────────────────────────────
  renderEmpty();
  renderNotes([]);
  checkStatus();

  // Refresh status when tab becomes active
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      if (t.dataset.tab === 'flightEngineer') checkStatus();
    });
  });

  window.__vlcFeResetRecognition = () => {
    try { recognition?.stop(); } catch { /* */ }
    recognition = null;
  };
})();
