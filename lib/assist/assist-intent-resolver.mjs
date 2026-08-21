import { findAssistRoute } from './assist-routes.mjs';

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function lower(text) {
  return normalize(text).toLowerCase();
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

  // Development / request for product change
  const devCue = /^(add|create|build|implement|make)\b.+\b(tab|screen|panel|feature|capability|ui)\b/i.test(q)
    || /\b(add a tab|new tab|landing confidence)\b/i.test(q)
    || /^(הוסף|תיצור|צור)\b/.test(q);
  const requestCue = /^(please\s+)?(can you|could you|i want|i wish|i need)\b/i.test(q)
    || /\bwould be (useful|nice|helpful)\b/i.test(q);

  if (devCue) {
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
  if (requestCue && /\b(tab|feature|ui|screen|improve|improvement)\b/i.test(q)) {
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
    || /^(מה|למה|איך|האם)\b/.test(q)
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
  if (/vision|vio|slam|camera/.test(q)) return 'VISION';
  if (/land|flare|approach/.test(q)) return 'LANDING';
  if (/nav|gps|position/.test(q)) return 'NAVIGATION';
  if (/video|stream/.test(q)) return 'VIDEO';
  if (/ui|tab|screen|panel|hud/.test(q)) return 'UI';
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
