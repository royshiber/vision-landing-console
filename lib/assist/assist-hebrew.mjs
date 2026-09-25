import { formatSpokenMeasure } from './spoken-units.mjs';

/** Hebrew Assist copy for the confirmed development → isolated coding-agent loop. */

export const ASSIST_HE = Object.freeze({
  developmentProposalAnswer: [
    'זו בקשת יכולת.',
    'הכנתי כרטיס: מה, למה, ומודולים.',
    'התחלת סוכן תרוץ על ענף מבודד.',
    'לא יתבצע מיזוג לענף הראשי.',
    'לא יתבצע טיסה.',
    'לא תוחל תצורת מחשב משימה.',
  ].join('\n'),
  developmentProposalNextStep: 'בחרו פתח בפיתוח, שמור טיוטה, או התחל סוכן.',
  capabilityHandoffAnswer: 'הכרטיס נפתח בפיתוח.',
  taskDraftSaved: 'הטיוטה נשמרה בפיתוח.',
  missionDevelopmentRefused: [
    'כאן זה הטסה.',
    'אי אפשר לפתוח משימת פיתוח מכאן.',
    'עברו לפיתוח אם צריך משימה.',
  ].join('\n'),
  missionDevelopmentNextStep: 'פתחו פיתוח ליצירת משימה.',
  gpsOk: 'מצב GPS תקין בצילום המטוס הנוכחי.',
  gpsNotOk: 'מצב GPS אינו תקין בצילום המטוס הנוכחי.',
  gpsUnknown: 'אין מצב GPS בהקשר הנוכחי של AIRVIX Ask. פתחו אבחון או טלמטריה לבדיקת GPS חי.',
  visionNoMetrics: 'יכולת הראייה במוקד. אין מדדי ראייה חיים בהקשר. פתחו ראייה או אבחון לסטטוס חי.',
  visionCannotChangeParams: 'AIRVIX Ask אינו יכול לשנות פרמטרי ראייה.',
  visionConfidenceLabel: 'ביטחון הראייה בהקשר הנוכחי',
  aircraftConnected: 'המטוס מחובר.',
  aircraftNotConnected: 'המטוס אינו מחובר.',
  aircraftArmed: 'המטוס חמוש.',
  aircraftDisarmed: 'המטוס אינו חמוש.',
  flightModeLabel: 'מצב טיסה',
  askMoreSpecificOrDiagnostics: 'שאלו שאלה ממוקדת יותר או פתחו אבחון.',
  noAircraftSnapshot: 'אין צילום מטוס.',
  generalAskTopics: 'שאלו על GPS, ראייה, או פיתוח פעיל לתשובה ממוקדת יותר.',
  prohibitedAnswer: [
    'הבקשה ממפה לפעולה אסורה.',
    'דורש שער אדם / לא בטיסות ראשונות.',
    'AIRVIX Ask לא ישלח פקודות טיסה, לא יחליף מקור ניווט בבקר, ולא יפעיל פריסה או סוכן בלי מסלול מאושר.',
  ].join('\n'),
  prohibitedNextStep: 'נסחו מחדש כשאלה, פתק, תצפית, ניווט במסך, או בקשת שינוי שדורשת אישור.',
  blockedFlightCommandAnswer: [
    'הבקשה היא חימוש או נטרול.',
    'חימוש ונטרול חסומים תמיד.',
    'AIRVIX Ask לא ישלח חימוש או נטרול לבקר.',
  ].join('\n'),
  blockedNavSwitchAnswer: [
    'הבקשה היא החלפת מקור ניווט בבקר.',
    'דורש שער אדם / לא בטיסות ראשונות.',
    'AIRVIX Ask לא יחליף מקור ניווט חי ולא יכתוב מפתחות ניווט לבקר.',
  ].join('\n'),
  blockedDeployAnswer: [
    'הבקשה היא פריסה, הפעלה מחדש, או פעולת מערכת.',
    'דורש שער אדם / לא בטיסות ראשונות.',
    'AIRVIX Ask לא יריץ זאת.',
  ].join('\n'),
  blockedFlightNextStep: 'אפשר לשאול על מצב, לשמור פתק, או להציע שינוי פרמטר בטוח.',
  voiceSessionRequired: 'שיחת הקול סגורה. לחצו GO או אמרו יאללה כדי לפתוח שיחה. אחר כך נחיתה ומצב בלי אישור לכל פעולה.',
  voiceSessionRequiredNext: 'פתחו שיחת קול. חימוש ונטרול נשארים חסומים.',
  flightOpSent: 'נשלח לבקר כהחלפת מצב.',
  flightOpOffline: 'הבקר אינו מחובר — הפקודה לא נשלחה למטוס.',
  flightOpUnknownMode: 'לא צוין מצב טיסה מוכר. לא נשלח.',
  flightOpFailed: 'שליחת פקודת הטיסה נכשלה.',
  landNoDoLandStart: 'אין במשימה שעל הבקר סימון DO_LAND_START. לא נשלח דבר. אפשר לבקש חזרה הביתה, או לנחות ידנית.',
  landNavLandWithoutMarker: 'יש נקודת נחיתה במשימה, אבל אין סימון DO_LAND_START לפניה. לא נשלח דבר.',
  landMissionEmpty: 'אין משימה על הבקר. לא נשלח דבר.',
  landMissionUnreadable: 'לא הצלחתי לקרוא את המשימה מהבקר. לא נשלח דבר.',
  landNotFixedWing: 'פקודת הנחיתה הזו מיועדת למטוס כנף קבועה. לא נשלח דבר.',
  landAckAccepted: 'הבקר קיבל את פקודת תחילת הנחיתה.',
  landAckRejected: 'הבקר דחה את פקודת תחילת הנחיתה. הנחיתה לא התחילה.',
  landAckTimeout: 'פקודת תחילת הנחיתה נשלחה, והבקר לא השיב. לא ידוע אם הנחיתה התחילה.',
  readoutAbsent: '--',
  readoutAltitude: 'גובה',
  readoutSpeed: 'מהירות',
  readoutClimb: 'קצב אנכי',
  readoutDistance: 'מרחק',
  readoutMode: 'מצב טיסה',
  readoutBattery: 'סוללה',
  readoutLink: 'קישור',
  readoutParam: 'פרמטר',
  paramUnknown: 'אין ערך שמור לפרמטר זה בהקשר הנוכחי.',
  paramProposalAnswer: 'מציע שינוי פרמטר. נדרש אישור מפורש. אמרו כן, אשר, או מאשר, או לחצו אישור.',
  paramProposalNextStep: 'אשרו כדי להחיל דרך מסלול המהנדס. בטלו כדי לא לשנות.',
  paramApplied: 'השינוי אושר והועבר למסלול ההחלה.',
  paramAppliedOffline: 'השינוי אושר. הבקר אינו מחובר — הפרמטר לא נשלח למטוס.',
  paramDirectApplied: 'השינוי הוחל דרך מסלול המהנדס.',
  paramDirectAppliedOffline: 'השינוי הוחל. הבקר אינו מחובר — הפרמטר לא נשלח למטוס.',
  paramApplyFailed: 'ההחלה נכשלה.',
  suggestionApprove: 'לאשר את ההצעה?',
  voiceConfirmHint: 'אמרו כן, אשר, או מאשר, או לחצו אישור.',
  voiceGoEnabled: 'שיחת קול נפתחה. נחיתה, חזרה הביתה, ומצב בלי אישור לכל פעולה. חימוש ונטרול חסומים. שינוי פרמטר דורש אישור.',
  voiceGoDisabled: 'שיחת הקול כבויה. נחיתה ומצב דורשים פתיחה. חימוש ונטרול חסומים. שינוי פרמטר דורש אישור.',
  voiceGoHintIdle: 'הפעלה פותחת שיחת קול. אחריה נחיתה ומצב בלי אישור לכל פעולה. חימוש ונטרול חסומים. שינוי פרמטר דורש אישור.',
  voiceGoHintActive: 'שיחת קול פתוחה. נחיתה ומצב בלי אישור. חימוש ונטרול חסומים. שינוי פרמטר דורש אישור.',
  unknownRoute: 'היעד אינו מסלול מוכר ב-AIRVIX Ask.',
  uiNavNextStep: 'הלקוח מנווט למסלול מוכר בלבד.',
  noteProposalAnswer: 'אפשר לשמור זאת כפתק. ליצור את הפתק?',
  noteProposalNextStep: 'אשרו כדי לשמור את הפתק.',
  noteSaved: 'הפתק נשמר.',
  observationProposalAnswer: 'נשמרה מועמדת לתצפית מההקשר הנוכחי. לשמור את התצפית?',
  observationProposalNextStep: 'אשרו כדי לשמור את התצפית.',
  observationSaved: 'התצפית נשמרה.',
  unresolvedAnswer: 'לא הצלחתי לשייך זאת לכוונה מבוקרת ב-AIRVIX Ask. נסו שאלה, פתק, תצפית, פתיחת מסך, או בקשת פיתוח.',
  unresolvedNextStep: 'נסחו מחדש בכוונה ברורה יותר.',
  actionNotAllowed: 'הפעולה אינה מותרת.',
  unsupportedAction: 'הפעולה אינה נתמכת.',
  developmentStoreUnavailable: 'מאגר משימות הפיתוח אינו זמין.',
  done: 'בוצע.',
  cancelled: 'הפעולה בוטלה.',
  proposalGone: 'ההצעה כבר לא זמינה.',
  taskCreatedAgentRunning: 'המשימה נוצרה.\nהסוכן רץ על הענף המבודד.',
  taskCreatedAgentQueued: 'המשימה נוצרה.\nהסוכן הופעל על הענף המבודד.',
  taskCreatedUnavailable: 'המשימה נוצרה.\nהסוכן אינו זמין כרגע.\nלא הופעל סוכן.',
  taskCreatedWorktreeFailed: 'המשימה נוצרה.\nיצירת הענף המבודד נכשלה.\nלא הופעל סוכן.',
  taskCreatedStartFailed: 'המשימה נוצרה.\nהפעלת הסוכן נכשלה.',
  taskCreatedNoRuntime: 'המשימה נוצרה.\nאין סביבת סוכן מוכנה.\nלא הופעל סוכן.',
  running: 'הסוכן רץ על הענף המבודד.',
  queued: 'הסוכן ממתין בתור על הענף המבודד.',
  waiting: 'הסוכן ממתין על הענף המבודד.',
  succeeded: 'הסוכן סיים על הענף המבודד.',
  failed: 'הסוכן נכשל על הענף המבודד.',
  cancelledAgent: 'הסוכן בוטל.',
  notStarted: 'הסוכן לא הופעל.',
  labelTaskId: 'מזהה משימה',
  labelAgentState: 'מצב סוכן',
  labelLastMessage: 'הודעה אחרונה',
  labelProgress: 'התקדמות',
  labelBranch: 'ענף',
  labelPrUrl: 'כתובת בקשה',
  agentConnectTitle: 'חיבור הסוכן',
  agentConnectHint: 'כדי להריץ שינוי מאושר צריך לחבר את הסוכן.',
  agentConnectKeyLabel: 'מפתח חיבור',
  agentConnectButton: 'חיבור',
  agentDisconnectButton: 'ניתוק',
  agentConnecting: 'מחברים את הסוכן…',
  agentConnected: 'הסוכן מחובר ומוכן.',
  agentDisconnected: 'הסוכן מנותק.',
  agentConnectFailed: 'החיבור לסוכן נכשל.',
  agentKeyMissing: 'חסר מפתח חיבור.',
  agentKeyEmpty: 'יש להזין מפתח חיבור.',
  agentKeyInvalid: 'מפתח החיבור אינו תקין.',
  agentUnavailable: 'הסוכן אינו זמין כרגע.',
  messageFailed: 'שליחת ההודעה נכשלה.',
  messagesEmpty: 'אין הודעות עדיין.',
  confirmAgentDisconnected: 'הסוכן מנותק. חברו מפתח לפני אישור. אחרת תיווצר משימה בלי הרצת סוכן.',
  talkbackDisconnected: 'דיבור-חזרה לא מחובר',
  talkbackConnected: 'דיבור-חזרה מחובר',
});

export function hebrewUnavailableReason(raw) {
  const s = String(raw || '').trim();
  if (!s) return ASSIST_HE.agentUnavailable;
  if (/agent-disconnected/i.test(s)) return ASSIST_HE.agentDisconnected;
  if (/agent-key-empty/i.test(s)) return ASSIST_HE.agentKeyEmpty;
  if (/agent-key-invalid/i.test(s)) return ASSIST_HE.agentKeyInvalid;
  if (/agent-key-missing/i.test(s) || /CURSOR_API_KEY/i.test(s)) {
    return /CURSOR_API_KEY/i.test(s) ? 'מפתח החיבור לסוכן לא הוגדר.' : ASSIST_HE.agentKeyMissing;
  }
  if (/agent-connection-missing/i.test(s)) return ASSIST_HE.agentUnavailable;
  if (/DEVELOPMENT_AGENT_PROVIDER is not configured/i.test(s)) return 'ספק הסוכן לא הוגדר.';
  if (/unsupported DEVELOPMENT_AGENT_PROVIDER/i.test(s)) return 'ספק הסוכן אינו נתמך.';
  return ASSIST_HE.agentUnavailable;
}

export function hebrewAgentStateAnswer(state) {
  const s = String(state || '').trim().toUpperCase();
  if (s === 'RUNNING') return ASSIST_HE.running;
  if (s === 'QUEUED') return ASSIST_HE.queued;
  if (s === 'WAITING') return ASSIST_HE.waiting;
  if (s === 'SUCCEEDED') return ASSIST_HE.succeeded;
  if (s === 'FAILED') return ASSIST_HE.failed;
  if (s === 'CANCELLED') return ASSIST_HE.cancelledAgent;
  return ASSIST_HE.notStarted;
}

export function isTerminalAgentState(state) {
  const s = String(state || '').trim().toUpperCase();
  return s === 'SUCCEEDED' || s === 'FAILED' || s === 'CANCELLED';
}

const WORKSPACE_HE = Object.freeze({
  PULSE: 'סטטוס מחשבים',
  MISSION: 'משימה',
  PLATFORM: 'פלטפורמה',
  EVOLVE: 'פיתוח',
  LAB: 'יועץ',
  UNKNOWN: 'לא ידוע',
});

const CAPABILITY_HE = Object.freeze({
  vision: 'ראייה',
  landing: 'נחיתה',
  navigation: 'ניווט',
  mission: 'משימה',
  video: 'וידאו',
  voice: 'קול',
  diagnostics: 'אבחון',
  companion: 'Jetson',
  configuration: 'תצורה',
  debrief: 'תחקור',
  evolve: 'פיתוח',
  lab_sitl: 'יועץ',
  advisor: 'יועץ',
});

const TAB_HE = Object.freeze({
  terrain: 'הטסה',
  development: 'פיתוח',
  control: 'פרמטרים',
  telemetry: 'טלמטריה',
  maintenance: 'סטטוס מחשבים',
  recordings: 'תחקור',
  flights: 'תחקור',
  advisor: 'יועץ',
  featureDesigner: 'פיצ׳ר',
  flightEngineer: 'מהנדס טיסה',
  pulse: 'סטטוס מחשבים',
  platform: 'סטטוס מחשבים',
});

const ROUTE_OPENING_HE = Object.freeze({
  mission: 'פותחים את מרחב המשימה.',
  evolve: 'פותחים את מרחב הפיתוח.',
  vision: 'פותחים את פרמטרי הניווט החזותי.',
  landing: 'פותחים את פרמטרי הנחיתה.',
  navigation: 'פותחים את פרמטרי הניווט.',
  configuration: 'פותחים את מרכז הפרמטרים.',
  diagnostics: 'פותחים את הטלמטריה והאבחון.',
  companion: 'פותחים סטטוס מחשבים.',
  debrief: 'פותחים את התחקור.',
  pulse_proxy: 'פותחים סטטוס מחשבים.',
  platform: 'פותחים סטטוס מחשבים.',
  advisor: 'פותחים את היועץ.',
  engineer: 'פותחים את מהנדס הטיסה.',
  ardulab: 'פותחים את הפיצ׳ר המותאם.',
  readiness: 'פותחים את המוכנות.',
  'auto-config': 'פותחים את אשף הקונפיגורציה.',
});

export function hebrewWorkspaceLabel(ws) {
  return WORKSPACE_HE[ws] || WORKSPACE_HE.UNKNOWN;
}

export function hebrewGpsAnswer(gpsOk) {
  if (gpsOk === true) return ASSIST_HE.gpsOk;
  if (gpsOk === false) return ASSIST_HE.gpsNotOk;
  return ASSIST_HE.gpsUnknown;
}

export function hebrewVisionAnswer(confidence) {
  if (typeof confidence === 'number') {
    return [
      ASSIST_HE.visionConfidenceLabel,
      String(confidence),
      ASSIST_HE.visionCannotChangeParams,
    ].join('\n');
  }
  return ASSIST_HE.visionNoMetrics;
}

export function hebrewLookingAtAnswer(ws, cap, tab) {
  const lines = [`אתם במרחב ${hebrewWorkspaceLabel(ws)}.`];
  const capHe = CAPABILITY_HE[cap];
  if (capHe) lines.push(`יכולת נוכחית: ${capHe}.`);
  const tabHe = TAB_HE[tab];
  if (tabHe) lines.push(`מסך נוכחי: ${tabHe}.`);
  return lines.join('\n');
}

export function hebrewAircraftSnapshotAnswer(ws, ac) {
  const lines = [`אתם במרחב ${hebrewWorkspaceLabel(ws)}.`];
  lines.push(ac?.connected ? ASSIST_HE.aircraftConnected : ASSIST_HE.aircraftNotConnected);
  if (ac?.flight_mode) {
    lines.push(ASSIST_HE.flightModeLabel);
    lines.push(String(ac.flight_mode));
  }
  if (typeof ac?.armed === 'boolean') {
    lines.push(ac.armed ? ASSIST_HE.aircraftArmed : ASSIST_HE.aircraftDisarmed);
  }
  lines.push(ASSIST_HE.askMoreSpecificOrDiagnostics);
  return lines.join('\n');
}

export function hebrewGeneralContextAnswer(ws, cap) {
  const lines = [`אתם במרחב ${hebrewWorkspaceLabel(ws)}.`];
  const capHe = CAPABILITY_HE[cap];
  if (capHe) lines.push(`יכולת נוכחית: ${capHe}.`);
  lines.push(ASSIST_HE.noAircraftSnapshot);
  lines.push(ASSIST_HE.generalAskTopics);
  return lines.join('\n');
}

export function hebrewOpenRouteAnswer(routeId) {
  return ROUTE_OPENING_HE[routeId] || ASSIST_HE.unknownRoute;
}

function dashOrNumber(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ASSIST_HE.readoutAbsent;
  const a = Math.abs(value);
  const dec = Number.isInteger(value) ? 0 : (a < 10 ? 2 : digits);
  return value.toFixed(dec);
}

export function hebrewReadbackAnswer(topic, ac, spokenUnits) {
  if (topic === 'altitude') {
    const line = formatSpokenMeasure('altitude', ac?.altitude_m, spokenUnits);
    return [ASSIST_HE.readoutAltitude, line].join('\n');
  }
  if (topic === 'speed') {
    const air = typeof ac?.airspeed_ms === 'number' && Number.isFinite(ac.airspeed_ms)
      ? formatSpokenMeasure('speed', ac.airspeed_ms, spokenUnits)
      : ASSIST_HE.readoutAbsent;
    const gs = typeof ac?.groundspeed_ms === 'number' && Number.isFinite(ac.groundspeed_ms)
      ? formatSpokenMeasure('speed', ac.groundspeed_ms, spokenUnits)
      : ASSIST_HE.readoutAbsent;
    return [ASSIST_HE.readoutSpeed, air === '--' && gs === '--' ? '--' : `אוויר ${air} · קרקע ${gs}`].join('\n');
  }
  if (topic === 'climb') {
    const line = formatSpokenMeasure('verticalRate', ac?.climb_rate_ms, spokenUnits);
    return [ASSIST_HE.readoutClimb, line].join('\n');
  }
  if (topic === 'distance') {
    const line = formatSpokenMeasure('distance', ac?.distance_m, spokenUnits);
    return [ASSIST_HE.readoutDistance, line].join('\n');
  }
  if (topic === 'mode') {
    const mode = ac?.flight_mode ? String(ac.flight_mode) : ASSIST_HE.readoutAbsent;
    return [ASSIST_HE.readoutMode, mode].join('\n');
  }
  if (topic === 'battery') {
    const v = dashOrNumber(ac?.battery_v);
    const pct = dashOrNumber(ac?.battery_pct, 0);
    return [ASSIST_HE.readoutBattery, v === '--' && pct === '--' ? '--' : `${v} V · ${pct} %`].join('\n');
  }
  if (topic === 'link') {
    const label = String(ac?.link_label || '').trim();
    return [ASSIST_HE.readoutLink, label || ASSIST_HE.readoutAbsent].join('\n');
  }
  if (topic === 'gps') {
    return hebrewGpsAnswer(ac?.gps_ok);
  }
  return null;
}

export function hebrewParamGetAnswer(key, knownParams) {
  const k = String(key || '').trim().toUpperCase();
  const raw = knownParams && typeof knownParams === 'object' ? knownParams[k] : null;
  if (raw == null || raw === '') {
    return [ASSIST_HE.readoutParam, k, ASSIST_HE.paramUnknown].join('\n');
  }
  const num = Number(raw);
  const shown = Number.isFinite(num) ? dashOrNumber(num) : String(raw);
  return [ASSIST_HE.readoutParam, k, shown].join('\n');
}
