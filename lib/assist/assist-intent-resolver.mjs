import { findAssistRoute } from './assist-routes.mjs';

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function lower(text) {
  return normalize(text).toLowerCase();
}

/**
 * JavaScript \b is ASCII-only. Hebrew letters are not word chars, so \b never
 * matches after them (e.g. הוסף טאב). Token bounds use Unicode letters instead.
 */
function isLetterChar(ch) {
  return Boolean(ch) && /\p{L}/u.test(ch);
}

function startsWithToken(text, token) {
  const t = String(text || '');
  const tok = String(token);
  if (!tok || !t.startsWith(tok)) return false;
  return t.length === tok.length || !isLetterChar(t.charAt(tok.length));
}

function startsWithAnyToken(text, tokens) {
  return tokens.some((tok) => startsWithToken(text, tok));
}

const HE_CLITICS = 'הבלמושכ';

function isTokenStart(text, idx) {
  if (idx <= 0) return true;
  const prev = text.charAt(idx - 1);
  if (!isLetterChar(prev)) return true;
  // Natural Hebrew attaches ה/ב/ל/מ/ו/ש/כ: הכיתוב, במסך, לטאב.
  if (HE_CLITICS.includes(prev) && (idx === 1 || !isLetterChar(text.charAt(idx - 2)))) {
    return true;
  }
  return false;
}

function hasToken(text, token) {
  const t = String(text || '');
  const tok = String(token);
  if (!tok) return false;
  let from = 0;
  while (from <= t.length - tok.length) {
    const idx = t.indexOf(tok, from);
    if (idx < 0) return false;
    const after = t.charAt(idx + tok.length);
    if (isTokenStart(t, idx) && !isLetterChar(after)) return true;
    from = idx + 1;
  }
  return false;
}

function hasAnyToken(text, tokens) {
  return tokens.some((tok) => hasToken(text, tok));
}

const HE_DEV_VERBS = [
  'הוסף', 'תוסיף', 'להוסיף',
  'צור', 'תיצור', 'ליצור',
  'בנה', 'תבנה', 'לבנות',
  'ממש', 'לממש',
  'שנה', 'תשנה', 'לשנות',
  'תקן', 'תתקן', 'לתקן',
  'עדכן', 'תעדכן', 'לעדכן',
  'שפר', 'תשפר', 'לשפר',
];

const HE_REQUEST_PREFIXES = ['אני רוצה', 'אני צריך', 'כדאי'];

const HE_QUESTION_PREFIXES = ['מה', 'למה', 'איך', 'האם', 'מתי', 'איפה'];

const HE_PRODUCT_NOUNS = [
  'טאב', 'לשונית', 'מסך', 'פאנל', 'ממשק', 'תצוגה', 'זרימה',
  'כיתוב', 'טקסט', 'תכונה', 'יכולת', 'כפתור',
];

const EN_PRODUCT_RE = /\b(tab|screen|panel|feature|capability|ui|copy|flow)\b/i;

function hasProductChangeObject(q) {
  return hasAnyToken(q, HE_PRODUCT_NOUNS) || EN_PRODUCT_RE.test(q);
}

const PROHIBITED_PATTERNS = [
  { re: /\b(arm|disarm)\b/i, action: 'ARM' },
  { re: /\b(deploy|rollback)\b/i, action: 'DEPLOY' },
  { re: /\b(restart|reboot)\b.+\b(service|jetson|systemd)\b/i, action: 'RESTART_SERVICE' },
  { re: /\b(shell|bash|powershell|cmd\.exe)\b/i, action: 'SHELL' },
  { re: /\b(write|set|change)\b.+\bparam/i, action: 'PARAM_WRITE' },
  { re: /\bmode\s+(change|to)\b/i, action: 'MODE_CHANGE' },
  { re: /\b(land\s+now|auto\s*land|rtl\b)/i, action: 'LANDING_COMMAND' },
  { re: /\b(start\s+agent|run\s+cursor)\b/i, action: 'CURSOR_AGENT_START' },
];

/**
 * Deterministic intent resolver. Not an LLM.
 * Returns { intent, confidence, route?, prohibited?, reason?, slots }
 */
export function resolveAssistIntent(rawText, context = {}) {
  const text = normalize(rawText);
  const q = lower(text);
  if (!text) {
    return { intent: 'UNRESOLVED', confidence: 0, reason: 'empty input', slots: {} };
  }

  for (const p of PROHIBITED_PATTERNS) {
    if (p.re.test(text)) {
      return {
        intent: 'UNRESOLVED',
        confidence: 1,
        prohibited: true,
        prohibited_action: p.action,
        reason: `prohibited action pattern: ${p.action}`,
        slots: {},
      };
    }
  }

  // UI navigation cues
  const navMatch = q.match(/^(?:open|go to|show|navigate to|פתח|עבור ל)\s+(.+)$/i)
    || q.match(/^(?:open|show)\s+(.+?)(?:\s+telemetry)?$/i);
  if (navMatch) {
    const target = navMatch[1].replace(/\s+please$/, '').trim();
    const route = findAssistRoute(target);
    if (route) {
      return {
        intent: 'UI_ACTION',
        confidence: 0.92,
        slots: { action: 'UI_NAVIGATION', route_id: route.id, route },
      };
    }
  }
  // Bare "open vision" / Hebrew open forms already covered; also "show landing telemetry"
  if (/^(open|show|go to)\b/i.test(q) || /^פתח\b/.test(q)) {
    const route = findAssistRoute(q.replace(/^(open|show|go to|פתח)\s+/i, ''));
    if (route) {
      return {
        intent: 'UI_ACTION',
        confidence: 0.9,
        slots: { action: 'UI_NAVIGATION', route_id: route.id, route },
      };
    }
  }

  // Explicit note
  if (
    /^(write|save|add|create)\s+(a\s+)?note\b/i.test(q)
    || /^כתוב פתק\b/.test(q)
    || /^שמור פתק\b/.test(q)
    || /\bflight note\b/i.test(q)
  ) {
    const body = text
      .replace(/^(write|save|add|create)\s+(a\s+)?note\s*(that\s+|about\s+|:\s*)?/i, '')
      .replace(/^כתוב פתק\s*(ש|על|:)?\s*/i, '')
      .trim() || text;
    return {
      intent: 'NOTE',
      confidence: 0.95,
      slots: { action: 'CREATE_NOTE', body },
    };
  }

  // Observation
  if (
    /^(i\s+)?(noticed|see|saw|observe|observing)\b/i.test(q)
    || /\bdrifting\b/i.test(q)
    || /^שמתי לב\b/.test(q)
    || /^אני רואה\b/.test(q)
  ) {
    return {
      intent: 'OBSERVATION',
      confidence: 0.88,
      slots: { action: 'CREATE_OBSERVATION', body: text },
    };
  }

  // Hebrew questions first: ASCII \b never matches after Hebrew, and a question
  // that mentions a tab/screen must not become a development task.
  const hebrewQuestion = startsWithAnyToken(q, HE_QUESTION_PREFIXES);

  // Development / request for product change
  const heProduct = hasProductChangeObject(q);
  const heLandingConfidence = hasToken(q, 'ביטחון נחיתה');
  const heDevVerb = hasAnyToken(q, HE_DEV_VERBS);
  const devCue = /^(add|create|build|implement|make)\b.+\b(tab|screen|panel|feature|capability|ui)\b/i.test(q)
    || /\b(add a tab|new tab|landing confidence)\b/i.test(q)
    || (heDevVerb && (heProduct || heLandingConfidence));
  const requestCue = /^(please\s+)?(can you|could you|i want|i wish|i need)\b/i.test(q)
    || /\bwould be (useful|nice|helpful)\b/i.test(q)
    || startsWithAnyToken(q, HE_REQUEST_PREFIXES);

  if (!hebrewQuestion && devCue) {
    return {
      intent: 'DEVELOPMENT',
      confidence: 0.9,
      slots: {
        action: 'CREATE_DEVELOPMENT_TASK',
        title: deriveTaskTitle(text),
        description: text,
        taxonomy: 'FEATURE',
        target_area: inferTargetArea(text, context),
      },
    };
  }
  if (
    !hebrewQuestion
    && requestCue
    && (
      /\b(tab|feature|ui|screen|improve|improvement)\b/i.test(q)
      || heProduct
      || heLandingConfidence
    )
  ) {
    return {
      intent: 'REQUEST',
      confidence: 0.85,
      slots: {
        action: 'CREATE_DEVELOPMENT_TASK',
        title: deriveTaskTitle(text),
        description: text,
        taxonomy: 'REQUEST',
        target_area: inferTargetArea(text, context),
      },
    };
  }

  // Questions
  if (
    /^(what|why|how|when|where|is|are|can|does|do)\b/i.test(q)
    || /\?$/.test(text)
    || hebrewQuestion
    || /what am i looking at/i.test(q)
    || /what'?s (wrong|running|happening)/i.test(q)
    || /gps status/i.test(q)
  ) {
    return {
      intent: 'QUESTION',
      confidence: 0.86,
      slots: { topic: inferQuestionTopic(q, context) },
    };
  }

  // Soft development without strong verbs
  if (/\b(tab for|feature for|improve landing|landing confidence)\b/i.test(q)) {
    return {
      intent: 'DEVELOPMENT',
      confidence: 0.7,
      slots: {
        action: 'CREATE_DEVELOPMENT_TASK',
        title: deriveTaskTitle(text),
        description: text,
        taxonomy: 'IDEA',
        target_area: inferTargetArea(text, context),
      },
    };
  }

  return {
    intent: 'UNRESOLVED',
    confidence: 0.35,
    reason: 'no deterministic rule matched',
    slots: {},
  };
}

function deriveTaskTitle(text) {
  const t = normalize(text).replace(/^(please\s+)?/i, '');
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

function inferTargetArea(text, context) {
  const q = lower(text);
  if (/vision|vio|slam|camera|ראייה|מצלמה/.test(q)) return 'VISION';
  if (/land|flare|approach|נחיתה/.test(q)) return 'LANDING';
  if (/nav|gps|position|ניווט/.test(q)) return 'NAVIGATION';
  if (/video|stream/.test(q)) return 'VIDEO';
  if (/ui|tab|screen|panel|hud|טאב|לשונית|מסך|ממשק/.test(q)) return 'UI';
  if (/api|endpoint/.test(q)) return 'API';
  if (/companion|jetson/.test(q)) return 'COMPANION';
  const cap = context?.current_capability;
  if (cap === 'vision') return 'VISION';
  if (cap === 'landing') return 'LANDING';
  if (cap === 'navigation') return 'NAVIGATION';
  return 'OTHER';
}

function inferQuestionTopic(q, context) {
  if (/gps/.test(q)) return 'gps';
  if (/vision|confidence/.test(q)) return 'vision';
  if (/looking at|what am i/.test(q)) return 'context';
  if (/running|active|task/.test(q)) return 'evolve';
  if (/wrong/.test(q)) return context?.current_capability || 'diagnostics';
  return context?.current_capability || 'general';
}
