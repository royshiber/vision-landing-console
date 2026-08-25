/** Hebrew Assist copy for the confirmed development → isolated coding-agent loop. */

export const ASSIST_HE = Object.freeze({
  developmentProposalAnswer: [
    'אישור יריץ את סוכן הקידוד על ענף מבודד.',
    'לא יתבצע מיזוג לענף הראשי.',
    'לא יתבצע טיסה.',
    'לא תוחל תצורת מלווה.',
  ].join('\n'),
  developmentProposalNextStep: 'לחצו אישור כדי ליצור את המשימה ולהפעיל את הסוכן על הענף המבודד.',
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
