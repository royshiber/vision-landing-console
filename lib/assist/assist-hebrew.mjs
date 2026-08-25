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
});

export function hebrewUnavailableReason(raw) {
  const s = String(raw || '').trim();
  if (/CURSOR_API_KEY/i.test(s)) return 'מפתח החיבור לסוכן לא הוגדר.';
  if (/DEVELOPMENT_AGENT_PROVIDER is not configured/i.test(s)) return 'ספק הסוכן לא הוגדר.';
  if (/unsupported DEVELOPMENT_AGENT_PROVIDER/i.test(s)) return 'ספק הסוכן אינו נתמך.';
  return 'הסוכן אינו זמין כרגע.';
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
