/**
 * Exp#1 / first-flight field readiness — software honesty only.
 * Aggregates already-observed console gates. Never probes hardware.
 * Never invents modem, camera, GPS, or a live nav/FC write.
 * ARM / LAND / auto-land and live EKF switch stay blocked.
 */

import { summarizeCommLinks, qualityFromCompanionSignal, EMPTY_QUALITY } from './comm-links.mjs';
import { DEFAULT_CELLULAR_ENDPOINT } from './dual-link.mjs';
import {
  resolveJetsonCompanionState,
  resolveFcHeartbeatState,
  buildPlndProfileHonesty,
  resolveTelemetryRecordingState,
} from './vision-landing-readiness.mjs';
import { APP_VERSION } from '../version.js';

export const FIELD_PREFLIGHT_IDS = Object.freeze([
  'link_cellular',
  'link_radio',
  'link_home',
  'link_rc',
  'cameras',
  'companion',
  'mavlink',
  'archive',
  'tailscale',
  'modem',
  'plnd_observe',
  'ask_go',
  'arm_land_blocked',
  'nav_switch_blocked',
]);

export const UPDATE_READINESS_IDS = Object.freeze([
  'console_version',
  'jetson_version',
  'fc_version',
  'link_quality',
  'backup_rollback',
  'fc_flash_gate',
]);

export const FIELD_PREFLIGHT_TONES = Object.freeze(['ok', 'warn', 'fail', 'blocked', 'absent']);

export const FIELD_PREFLIGHT_KIND = 'exp1_field_preflight';
export const FIELD_PREFLIGHT_TITLE_HE = 'מוכנות שדה · ניסוי אחד';
export const FIELD_PREFLIGHT_PURPOSE_HE = 'רשימת שדה לפני טיסה ראשונה. בלי המצאת חומרה.';
export const UPDATE_READINESS_TITLE_HE = 'עדכון בקר ומחשב משימה';
export const UPDATE_READINESS_LEAD_HE = 'הבזקה דורשת אישור. אין הבזקה מכאן.';

export const ARM_LAND_TOKENS = Object.freeze(['ARM', 'LAND', 'auto-land']);

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstBool(...values) {
  for (const v of values) {
    if (v === true || v === false) return v;
  }
  return null;
}

function cleanVersion(value) {
  const s = String(value || '').trim();
  if (!s || s === '--' || s === 'null' || s === 'unknown') return null;
  return s;
}

function row(id, {
  state,
  tone,
  nameHe,
  stateHe,
  missingHe = '',
  requiredForExperiment1 = false,
  requiredForField = true,
  extra = {},
} = {}) {
  return {
    id,
    state,
    tone,
    nameHe,
    stateHe,
    missingHe,
    requiredForExperiment1,
    requiredForField,
    invented: false,
    ...extra,
  };
}

/**
 * Camera honesty: live only from camera_ok without dry-run / synthetic.
 * Companion reachability alone never invents a camera.
 */
export function resolveFieldCameraHonesty({
  companionReachable = false,
  cameraOk = null,
  dryRun = false,
  source = null,
} = {}) {
  const src = String(source || '').trim().toLowerCase();
  const dry = dryRun === true || src === 'synthetic';
  if (dry) return 'dry_run';
  if (companionReachable && cameraOk === true && src !== 'absent') return 'live';
  if (companionReachable && cameraOk === false) return 'absent';
  return 'unknown';
}

export function resolveAskGoState(active) {
  if (active === true) return 'on';
  if (active === false) return 'off';
  return 'unknown';
}

export function resolveTailscaleHonesty({
  companionReachable = false,
  tailscaleUp = null,
} = {}) {
  if (tailscaleUp === true) return 'up';
  if (tailscaleUp === false) return 'down';
  if (companionReachable) return 'unknown';
  return 'absent';
}

function commRowFromLink(id, nameHe, link, { requiredForExperiment1 = false } = {}) {
  const state = String(link?.state || 'disconnected');
  if (state === 'modem_absent' || (id === 'link_cellular' && link?.connected !== true && state === 'absent')) {
    return row(id, {
      state: 'modem_absent',
      tone: 'absent',
      nameHe,
      stateHe: 'מודם לא מחובר',
      missingHe: link?.hintHe || 'מודם לא מחובר.',
      requiredForExperiment1,
    });
  }
  if (state === 'connected' || state === 'live' || link?.connected === true) {
    return row(id, {
      state: state === 'live' ? 'live' : 'connected',
      tone: 'ok',
      nameHe,
      stateHe: id === 'link_rc' ? 'חי' : 'מחובר',
      missingHe: '',
      requiredForExperiment1,
    });
  }
  if (state === 'listening' || state === 'connecting' || state === 'empty') {
    return row(id, {
      state,
      tone: 'warn',
      nameHe,
      stateHe: state === 'empty' ? 'אין נתונים' : (state === 'listening' ? 'מאזין' : 'מתחבר'),
      missingHe: link?.hintHe || '',
      requiredForExperiment1,
    });
  }
  if (state === 'error') {
    return row(id, {
      state: 'error',
      tone: 'fail',
      nameHe,
      stateHe: 'שגיאה',
      missingHe: link?.hintHe || 'הקישור נכשל.',
      requiredForExperiment1,
    });
  }
  if (id === 'link_rc') {
    return row(id, {
      state: 'off',
      tone: 'warn',
      nameHe,
      stateHe: 'אין שלט',
      missingHe: 'אין ערוצי שלט.',
      requiredForExperiment1: false,
    });
  }
  return row(id, {
    state: state || 'disconnected',
    tone: 'absent',
    nameHe,
    stateHe: 'מנותק',
    missingHe: link?.hintHe || 'אין קישור.',
    requiredForExperiment1,
  });
}

function camerasRow(honesty) {
  if (honesty === 'live') {
    return row('cameras', {
      state: 'live',
      tone: 'ok',
      nameHe: 'מצלמות',
      stateHe: 'חי',
      missingHe: '',
      requiredForExperiment1: true,
    });
  }
  if (honesty === 'dry_run') {
    return row('cameras', {
      state: 'dry_run',
      tone: 'warn',
      nameHe: 'מצלמות',
      stateHe: 'הרצה יבשה',
      missingHe: 'הרצה יבשה. אין מצלמה חיה.',
      requiredForExperiment1: true,
    });
  }
  if (honesty === 'absent') {
    return row('cameras', {
      state: 'absent',
      tone: 'absent',
      nameHe: 'מצלמות',
      stateHe: 'חסר',
      missingHe: 'אין דיווח מצלמה חיה.',
      requiredForExperiment1: true,
    });
  }
  return row('cameras', {
    state: 'unknown',
    tone: 'warn',
    nameHe: 'מצלמות',
    stateHe: 'לא ידוע',
    missingHe: 'אין דיווח מצלמה.',
    requiredForExperiment1: true,
  });
}

function companionRow(state) {
  if (state === 'reachable') {
    return row('companion', {
      state,
      tone: 'ok',
      nameHe: 'מחשב משימה',
      stateHe: 'מגיע',
      requiredForExperiment1: true,
    });
  }
  if (state === 'mock') {
    return row('companion', {
      state,
      tone: 'ok',
      nameHe: 'מחשב משימה',
      stateHe: 'מדומה',
      requiredForExperiment1: true,
    });
  }
  if (state === 'unreachable') {
    return row('companion', {
      state,
      tone: 'fail',
      nameHe: 'מחשב משימה',
      stateHe: 'לא מגיב',
      missingHe: 'חסרה הגעה למחשב משימה.',
      requiredForExperiment1: true,
    });
  }
  return row('companion', {
    state: 'off',
    tone: 'absent',
    nameHe: 'מחשב משימה',
    stateHe: 'כבוי',
    missingHe: 'חסרה הגעה למחשב משימה.',
    requiredForExperiment1: true,
  });
}

function mavlinkRow(state) {
  if (state === 'heartbeat') {
    return row('mavlink', {
      state,
      tone: 'ok',
      nameHe: 'קישור בקר',
      stateHe: 'דופק חי',
      requiredForExperiment1: true,
    });
  }
  if (state === 'linked') {
    return row('mavlink', {
      state,
      tone: 'warn',
      nameHe: 'קישור בקר',
      stateHe: 'מקושר',
      missingHe: 'אין דופק מקישור בקר.',
      requiredForExperiment1: true,
    });
  }
  if (state === 'unlinked') {
    return row('mavlink', {
      state,
      tone: 'fail',
      nameHe: 'קישור בקר',
      stateHe: 'מנותק',
      missingHe: 'אין דופק מקישור בקר.',
      requiredForExperiment1: true,
    });
  }
  return row('mavlink', {
    state: 'unknown',
    tone: 'warn',
    nameHe: 'קישור בקר',
    stateHe: 'לא ידוע',
    missingHe: 'אין דופק מקישור בקר.',
    requiredForExperiment1: true,
  });
}

function archiveRow({ recording, archiveReady }) {
  if (recording === true) {
    return row('archive', {
      state: 'recording',
      tone: 'ok',
      nameHe: 'ארכיון הקלטה',
      stateHe: 'מקליט',
      requiredForExperiment1: true,
    });
  }
  if (archiveReady === true) {
    return row('archive', {
      state: 'ready',
      tone: 'warn',
      nameHe: 'ארכיון הקלטה',
      stateHe: 'מוכן',
      missingHe: 'מוכן להקלטה. לא מקליט.',
      requiredForExperiment1: true,
    });
  }
  return row('archive', {
    state: 'not-recording',
    tone: 'warn',
    nameHe: 'ארכיון הקלטה',
    stateHe: 'לא מקליט',
    missingHe: 'הקלטה לא חמושה.',
    requiredForExperiment1: true,
  });
}

function tailscaleRow(honesty) {
  if (honesty === 'up') {
    return row('tailscale', {
      state: 'up',
      tone: 'ok',
      nameHe: 'רשת בית מאובטחת',
      stateHe: 'פעילה',
    });
  }
  if (honesty === 'down') {
    return row('tailscale', {
      state: 'down',
      tone: 'fail',
      nameHe: 'רשת בית מאובטחת',
      stateHe: 'כבויה',
      missingHe: 'רשת הבית כבויה.',
    });
  }
  if (honesty === 'unknown') {
    return row('tailscale', {
      state: 'unknown',
      tone: 'warn',
      nameHe: 'רשת בית מאובטחת',
      stateHe: 'לא ידוע',
      missingHe: 'יש הגעה למחשב משימה. אין דיווח רשת בית נפרד.',
    });
  }
  return row('tailscale', {
    state: 'absent',
    tone: 'absent',
    nameHe: 'רשת בית מאובטחת',
    stateHe: 'אין דיווח',
    missingHe: 'אין דיווח רשת בית.',
  });
}

function modemRow({ modemPresent, statusFileMissing, reasonHe, source } = {}) {
  if (modemPresent === true) {
    return row('modem', {
      state: 'present',
      tone: 'ok',
      nameHe: 'מודם סלולר',
      stateHe: 'זוהה',
      extra: { source: source || null, statusFileMissing: false },
    });
  }
  return row('modem', {
    state: 'modem_absent',
    tone: 'absent',
    nameHe: 'מודם סלולר',
    stateHe: 'לא מחובר',
    missingHe: statusFileMissing
      ? 'מודם לא מחובר. אין קובץ סטטוס במחשב משימה.'
      : (reasonHe || 'מודם לא מחובר.'),
    extra: {
      source: source || null,
      statusFileMissing: statusFileMissing === true,
      reason: 'modem_absent',
    },
  });
}

function plndObserveRow(honesty) {
  const state = honesty?.state || 'unknown';
  if (state === 'present') {
    return row('plnd_observe', {
      state: 'present',
      tone: 'ok',
      nameHe: 'נחיתה לפי ראייה',
      stateHe: 'קיים',
      missingHe: 'תצוגה בלבד. לא מחליף ניווט חי.',
      requiredForExperiment1: false,
    });
  }
  if (state === 'missing') {
    return row('plnd_observe', {
      state: 'missing',
      tone: 'warn',
      nameHe: 'נחיתה לפי ראייה',
      stateHe: 'חסר',
      missingHe: 'חסר. תצוגה בלבד. לא חוסם את הניסוי.',
      requiredForExperiment1: false,
    });
  }
  return row('plnd_observe', {
    state: 'unknown',
    tone: 'warn',
    nameHe: 'נחיתה לפי ראייה',
    stateHe: 'לא ידוע',
    missingHe: 'אין קריאה. תצוגה בלבד. לא חוסם את הניסוי.',
    requiredForExperiment1: false,
  });
}

function askGoRow(state) {
  if (state === 'on') {
    return row('ask_go', {
      state: 'on',
      tone: 'ok',
      nameHe: 'הפעלת קול',
      stateHe: 'מופעל',
      missingHe: 'פרמטר בלי אישור לכל פעולה. חימוש ונחיתה חסומים.',
    });
  }
  if (state === 'off') {
    return row('ask_go', {
      state: 'off',
      tone: 'warn',
      nameHe: 'הפעלת קול',
      stateHe: 'כבוי',
      missingHe: 'פרמטר דורש אישור. חימוש ונחיתה חסומים.',
    });
  }
  return row('ask_go', {
    state: 'unknown',
    tone: 'warn',
    nameHe: 'הפעלת קול',
    stateHe: 'לא ידוע',
    missingHe: 'אין סשן. חימוש ונחיתה חסומים.',
  });
}

function armLandBlockedRow() {
  return row('arm_land_blocked', {
    state: 'blocked',
    tone: 'blocked',
    nameHe: 'חימוש ונחיתה',
    stateHe: 'חסום',
    missingHe: 'חימוש ונחיתה נשארים חסומים בלי אישור.',
    requiredForExperiment1: true,
    extra: {
      tokens: [...ARM_LAND_TOKENS],
      send: false,
      humanGate: true,
    },
  });
}

function navSwitchBlockedRow() {
  return row('nav_switch_blocked', {
    state: 'blocked',
    tone: 'blocked',
    nameHe: 'החלפת ניווט חי',
    stateHe: 'חסום',
    missingHe: 'בחירת מיקום היא תצוגה בלבד. אין החלפת מקור ניווט חי.',
    requiredForExperiment1: true,
    extra: {
      displayOnly: true,
      liveNavSwitch: false,
      humanGate: true,
    },
  });
}

function updateStep(id, { ok, tone, he, humanGate = false, later = false, extra = {} } = {}) {
  return {
    id,
    ok: ok === true,
    tone,
    he,
    humanGate,
    later,
    autoFlash: false,
    ...extra,
  };
}

/**
 * Staged FC / Jetson update readiness. Status only.
 * Never flashes. Human Gate stays closed.
 */
export function buildUpdateReadinessChecklist({
  companionReachable = false,
  consoleVersion = APP_VERSION,
  jetsonVersion = null,
  fcVersion = null,
  linkQuality = null,
} = {}) {
  const consoleVer = cleanVersion(consoleVersion) || APP_VERSION;
  const jetsonVer = cleanVersion(jetsonVersion);
  const fcVer = cleanVersion(fcVersion);
  const quality = linkQuality && linkQuality.known === true
    ? linkQuality
    : { ...EMPTY_QUALITY };
  return {
    titleHe: UPDATE_READINESS_TITLE_HE,
    leadHe: UPDATE_READINESS_LEAD_HE,
    autoFlash: false,
    autoDeployFc: false,
    fcFirmwareHumanGate: true,
    companionApplyRestart: false,
    flashHumanGate: true,
    steps: [
      updateStep('console_version', {
        ok: Boolean(consoleVer),
        tone: consoleVer ? 'ok' : 'absent',
        he: consoleVer ? `גרסת קונסולה ידועה.` : 'גרסת קונסולה לא ידועה.',
        extra: { version: consoleVer },
      }),
      updateStep('jetson_version', {
        ok: Boolean(jetsonVer),
        tone: jetsonVer ? 'ok' : (companionReachable ? 'warn' : 'absent'),
        he: jetsonVer
          ? `גרסת מחשב משימה ידועה.`
          : (companionReachable
            ? 'מחשב משימה מגיע. אין גרסה מדווחת.'
            : 'אין גרסת מחשב משימה.'),
        extra: { version: jetsonVer },
      }),
      updateStep('fc_version', {
        ok: Boolean(fcVer),
        tone: fcVer ? 'ok' : 'absent',
        he: fcVer ? 'גרסת בקר ידועה.' : 'אין גרסת בקר מדווחת.',
        extra: { version: fcVer },
      }),
      updateStep('link_quality', {
        ok: quality.known === true,
        tone: quality.known ? 'ok' : 'absent',
        he: quality.known
          ? 'איכות קישור ידועה ממד אמיתי.'
          : 'אין מד איכות. אין אחוז מזויף.',
        extra: { quality },
      }),
      updateStep('backup_rollback', {
        ok: false,
        tone: 'warn',
        later: true,
        humanGate: true,
        he: 'גיבוי והחזרה על המפעיל. אין מסלול אוטומטי.',
      }),
      updateStep('fc_flash_gate', {
        ok: false,
        tone: 'blocked',
        later: true,
        humanGate: true,
        he: 'הבזקה דורשת אישור. אין הבזקה מכאן.',
      }),
    ],
  };
}

function cameraSignals(input) {
  const overlay = obj(input.overlay) || {};
  const companion = obj(input.companion) || {};
  const vision = obj(overlay.vision) || obj(companion.vision) || {};
  const extras = obj(overlay.extras) || obj(companion.extras) || obj(input.extras) || {};
  const opticalNav = obj(overlay.optical_nav) || obj(overlay.opticalNav)
    || obj(companion.optical_nav) || obj(input.opticalNav) || {};
  const cameras = obj(opticalNav.cameras) || obj(vision.cameras) || obj(extras.cameras) || {};
  const cam1 = obj(cameras.cam1) || {};
  const cam2 = obj(cameras.cam2) || {};
  const dryRun = extras.dry_run === true
    || vision.dry_run === true
    || vision.dryRun === true
    || cam1.dry_run === true
    || cam2.dry_run === true
    || cam1.source === 'synthetic'
    || cam2.source === 'synthetic';
  const source = cam1.source || cam2.source || vision.source || extras.source || null;
  const cameraOk = firstBool(
    vision.camera_ok,
    vision.cameraOk,
    extras.camera_ok,
    extras.camera_connected,
    cam1.camera_ok,
    cam2.camera_ok,
    opticalNav.camera_ok,
  );
  return { cameraOk, dryRun, source };
}

function tailscaleFlag(companion, overlay) {
  const channels = obj(companion?.channels) || obj(overlay?.channels) || {};
  const raw = channels.gcs_tailscale ?? channels.gcsTailscale ?? companion?.tailscaleUp ?? overlay?.tailscaleUp;
  if (raw === true || raw === 'up' || raw === 'connected') return true;
  if (raw === false || raw === 'down' || raw === 'disconnected') return false;
  return null;
}

function commFromInput(input) {
  const comm = obj(input.comm);
  if (comm && Array.isArray(comm.rows) && comm.rows.length) return comm;
  return summarizeCommLinks({
    radio: input.radio || 'disconnected',
    cellular: input.cellular || 'disconnected',
    preferred: input.preferred || 'radio',
    modemPresent: input.modemPresent === true,
    companion: input.companion,
    rc: input.rc,
    cellularSignal: input.cellularSignal,
  });
}

/**
 * Build the Exp#1 field checklist from already-observed snapshots.
 * Callers must pass real API / link fields. This function does not probe hardware.
 */
export function buildFieldPreflight(input = {}) {
  const companion = obj(input.companion) || {};
  const overlay = obj(input.overlay) || {};
  const modem = obj(input.modem) || {};
  const jetson = resolveJetsonCompanionState({
    jetson: companion.jetson,
    mode: companion.mode,
    reachable: companion.reachable,
  });
  const companionReachable = jetson === 'reachable' || jetson === 'mock';
  const fc = resolveFcHeartbeatState({
    companionFc: companion.fc,
    companionHeartbeat: firstBool(companion.fc_heartbeat, overlay.fc_heartbeat),
    gcsHeartbeatFresh: input.gcsHeartbeatFresh === true
      ? true
      : input.gcsHeartbeatFresh === false
        ? false
        : null,
  });
  const cams = cameraSignals(input);
  const cameraHonesty = resolveFieldCameraHonesty({
    companionReachable,
    cameraOk: cams.cameraOk,
    dryRun: cams.dryRun,
    source: cams.source,
  });
  const recording = resolveTelemetryRecordingState({
    manualRecordApi: input.manualRecordApi,
  });
  const plnd = buildPlndProfileHonesty({
    liveFcParams: input.liveFcParams,
    companionParams: input.companionParams,
    persistedArduTarget: input.persistedArduTarget,
    persistedVisionProfile: input.persistedVisionProfile,
  });
  const comm = commFromInput(input);
  const byId = Object.fromEntries((comm.rows || []).map((r) => [r.id, r]));
  const modemPresent = input.modemPresent === true || modem.present === true;
  const statusFileMissing = modem.statusFileMissing === true
    || input.statusFileMissing === true;
  const askGo = resolveAskGoState(input.askGoActive);
  const tailscale = resolveTailscaleHonesty({
    companionReachable,
    tailscaleUp: tailscaleFlag(companion, overlay),
  });
  const quality = qualityFromCompanionSignal(input.cellularSignal)
    || { ...EMPTY_QUALITY };

  const rows = [
    commRowFromLink('link_cellular', 'סלולר', byId.cellular, { requiredForExperiment1: false }),
    commRowFromLink('link_radio', 'רדיו טלמטריה', byId.radio, { requiredForExperiment1: true }),
    commRowFromLink('link_home', 'רשת בית', byId.home, { requiredForExperiment1: false }),
    commRowFromLink('link_rc', 'שלט', byId.rc, { requiredForExperiment1: false }),
    camerasRow(cameraHonesty),
    companionRow(jetson),
    mavlinkRow(fc),
    archiveRow({
      recording: recording === 'recording',
      archiveReady: input.archiveReady === true || recording === 'not-recording',
    }),
    tailscaleRow(tailscale),
    modemRow({
      modemPresent,
      statusFileMissing,
      reasonHe: modem.reasonHe,
      source: modem.source,
    }),
    plndObserveRow(plnd),
    askGoRow(askGo),
    armLandBlockedRow(),
    navSwitchBlockedRow(),
  ];

  const update = buildUpdateReadinessChecklist({
    companionReachable,
    consoleVersion: input.consoleVersion || APP_VERSION,
    jetsonVersion: input.jetsonVersion || companion.version || overlay.version,
    fcVersion: input.fcVersion
      || companion.fcFirmware
      || obj(companion.fc)?.firmware
      || overlay.fcFirmware,
    linkQuality: input.linkQuality || quality,
  });

  return {
    ok: true,
    kind: FIELD_PREFLIGHT_KIND,
    titleHe: FIELD_PREFLIGHT_TITLE_HE,
    purposeHe: FIELD_PREFLIGHT_PURPOSE_HE,
    rows,
    update,
    invented: { camera: false, gps: false, modem: false },
    sendFlightCommands: false,
    liveNavSwitch: false,
    autoFlash: false,
    flashHumanGate: true,
    endpoint: {
      type: DEFAULT_CELLULAR_ENDPOINT.type,
      host: DEFAULT_CELLULAR_ENDPOINT.host,
      port: DEFAULT_CELLULAR_ENDPOINT.port,
      bound: false,
    },
  };
}
