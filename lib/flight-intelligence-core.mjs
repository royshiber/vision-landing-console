import { findRelevantEngineerMemory, formatEngineerMemoryForPrompt } from './engineer-memory.mjs';
import { findSimilarIssues, formatIssuesForPrompt } from './chat-memory.mjs';

export function buildModeInstruction(mode) {
  if (mode === 'engineer') {
    return [
      'MODE=ENGINEER: תשובות קול קצרות — משפט ראשון קונקרטי למילות הטייס; **2–4 משפטים** כברירת מחדל; אל תחזור על פסקת FC/Jetson מלאה אם כבר נאמר בשרשור.',
      'בלי בקר מחובר / בלי טיסן באוויר — ייעוץ על ארכיטקטורת VLC, משמעות פרמטרים, הכנה ותכנון הוא בתוקף מלא; השתמש ב-ADVISOR KNOWLEDGE ובידע ArduPlane; אל תדרוש חיבור FC לשאלות תיאורטיות או "מה הקונסולה עושה".',
      'כשיש נתון חי — תצפית מהטלמטריה/פרמטרים → למה → צעד הבא; כשאין נתון חי — תשובה מהודקת מהידע והזיכרון.',
      'כשיש נתון חי בשכבות למעלה — צטט שם פרמטר ומספר עם יחידה.',
      'משפט יחיד מותר רק לאישור מילולי או קריאת מספר שהטייס ביקש במפורש.',
    ].join(' ');
  }
  return 'MODE=ADVISOR: נתח לעומק, פרט סיכונים/אלטרנטיבות, והצע תוכנית פעולה מדורגת.';
}

export function getSharedMemory({ db, text, mode = 'engineer', sessionId = null, versions = {}, liveContext = null }) {
  const q = String(text || '').trim();
  const ctx = liveContext || {};

  // Engineer memory is relevant for both modes.
  const engineerMemory = findRelevantEngineerMemory(db, q, ctx);
  const engineerMemoryBlock = formatEngineerMemoryForPrompt(engineerMemory);

  // Advisor issue memory is relevant for both modes; tighter cap for engineer voice mode.
  const issueLimit = mode === 'engineer' ? 3 : 5;
  const similarIssues = findSimilarIssues(db, q, { versions, limit: issueLimit });
  const advisorMemoryBlock = formatIssuesForPrompt(similarIssues);

  // Unified prompt block consumed by both flows.
  const unifiedMemoryBlock =
    `[ENGINEER MEMORY]\n${engineerMemoryBlock}\n\n` +
    `[ADVISOR MEMORY]\n${advisorMemoryBlock}`;

  return {
    sessionId,
    engineerMemory,
    similarIssues,
    engineerMemoryBlock,
    advisorMemoryBlock,
    unifiedMemoryBlock,
  };
}

export function buildFlightContext({ db, text, sessionId = null, mode = 'engineer', liveContext = null, versions = {} }) {
  const memory = getSharedMemory({ db, text, mode, sessionId, versions, liveContext });
  return {
    mode,
    modeInstruction: buildModeInstruction(mode),
    liveContext: liveContext || {},
    memory,
  };
}
