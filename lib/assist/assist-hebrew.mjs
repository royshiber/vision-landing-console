/** Hebrew Assist copy for the confirmed development → isolated coding-agent loop. */

export const ASSIST_HE = Object.freeze({
  developmentProposalAnswer: [
    'אישור יריץ את סוכן הקידוד על ענף מבודד.',
    'לא יתבצע מיזוג לענף הראשי.',
    'לא יתבצע טיסה.',
    'לא תוחל תצורת מלווה.',
  ].join('\n'),
  developmentProposalNextStep: 'לחצו אישור כדי ליצור את המשימה ולהפעיל את הסוכן על הענף המבודד.',
  gpsOk: 'מצב GPS תקין בצילום המטוס הנוכחי.',
  gpsNotOk: 'מצב GPS אינו תקין בצילום המטוס הנוכחי.',
  gpsUnknown: 'אין מצב GPS בהקשר הנוכחי של המסייע. פתחו אבחון או טלמטריה לבדיקת GPS חי.',
  visionNoMetrics: 'יכולת הראייה במוקד. אין מדדי ראייה חיים בהקשר. פתחו ראייה או אבחון לסטטוס חי.',
  visionCannotChangeParams: 'המסייע אינו יכול לשנות פרמטרי ראייה.',
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
    'המסייע לא יציע פקודות טיסה, כתיבת פרמטרים, פריסה, הפעלה מחדש, מעטפת פקודה או הפעלת סוכן.',
  ].join('\n'),
  prohibitedNextStep: 'נסחו מחדש כשאלה, פתק, תצפית, ניווט במסך, או בקשת פיתוח.',
  unknownRoute: 'היעד אינו מסלול מוכר במסייע.',
  uiNavNextStep: 'הלקוח מנווט למסלול מוכר בלבד.',
  noteProposalAnswer: 'אפשר לשמור זאת כפתק. ליצור את הפתק?',
  noteProposalNextStep: 'אשרו כדי לשמור את הפתק.',
  noteSaved: 'הפתק נשמר.',
  observationProposalAnswer: 'נשמרה מועמדת לתצפית מההקשר הנוכחי. לשמור את התצפית?',
  observationProposalNextStep: 'אשרו כדי לשמור את התצפית.',
  observationSaved: 'התצפית נשמרה.',
  unresolvedAnswer: 'לא הצלחתי לשייך זאת לכוונה מבוקרת במסייע. נסו שאלה, פתק, תצפית, פתיחת מסך, או בקשת פיתוח.',
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
  PULSE: 'סקירה',
  MISSION: 'משימה',
  PLATFORM: 'פלטפורמה',
  EVOLVE: 'פיתוח',
  LAB: 'מעבדה',
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
  companion: 'מלווה',
  configuration: 'תצורה',
  debrief: 'תחקור',
  evolve: 'פיתוח',
  lab_sitl: 'מעבדה',
});

const TAB_HE = Object.freeze({
  terrain: 'הטסה',
  development: 'פיתוח',
  simLab: 'מעבדה',
  control: 'פרמטרים',
  telemetry: 'טלמטריה',
  maintenance: 'תחזוקה',
  recordings: 'תחקור',
  flights: 'תחקור',
  advisor: 'יועץ',
  featureDesigner: 'מעצב פיצ׳רים',
  flightEngineer: 'מהנדס טיסה',
  pulse: 'סקירה',
  platform: 'פלטפורמה',
});

const ROUTE_OPENING_HE = Object.freeze({
  mission: 'פותחים את מרחב המשימה.',
  evolve: 'פותחים את משימות הפיתוח.',
  lab: 'פותחים את מעבדת הסימולציה.',
  vision: 'פותחים את פרמטרי הניווט החזותי.',
  landing: 'פותחים את פרמטרי הנחיתה.',
  navigation: 'פותחים את פרמטרי הניווט.',
  configuration: 'פותחים את מרכז הפרמטרים.',
  diagnostics: 'פותחים את הטלמטריה והאבחון.',
  companion: 'פותחים את התחזוקה והמלווה.',
  debrief: 'פותחים את התחקור.',
  pulse_proxy: 'פותחים את הסקירה.',
  platform: 'פותחים את הפלטפורמה.',
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
