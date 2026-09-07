/**
 * Code-owned Assist navigation targets.
 * Assist never accepts arbitrary URLs/paths — only these ids.
 */

export const ASSIST_ROUTES = Object.freeze([
  {
    id: 'mission',
    workspace: 'MISSION',
    capability: 'mission',
    tab: 'terrain',
    labels: ['mission', 'fly', 'flight', 'terrain', 'הטסה', 'משימה'],
    description: 'Mission / flight workspace',
  },
  {
    id: 'evolve',
    workspace: 'EVOLVE',
    capability: 'evolve',
    tab: 'development',
    labels: ['evolve', 'development', 'develop', 'dev', 'tasks', 'פיתוח'],
    description: 'Evolve / development tasks',
  },
  {
    id: 'advisor',
    workspace: 'LAB',
    capability: 'advisor',
    tab: 'advisor',
    labels: ['advisor', 'ai advisor', 'יועץ'],
    description: 'Advisor panel — Assist routes Q&A here',
  },
  {
    id: 'ardulab',
    workspace: 'EVOLVE',
    capability: 'evolve',
    tab: 'featureDesigner',
    labels: [
      'ardulab',
      'ardu lab',
      'feature designer',
      'featuredesigner',
      'ארדולאב',
      'מעצב פיצ׳רים',
      "מעצב פיצ'רים",
    ],
    description: 'Evolve specialist — ArduLab custom-feature lab. Not a peer Assist tab.',
  },
  {
    id: 'engineer',
    workspace: 'MISSION',
    capability: 'voice',
    tab: 'flightEngineer',
    labels: ['flight engineer', 'voice engineer', 'engineer', 'flightengineer', 'מהנדס', 'מהנדס טיסה', 'מהנדס קולי'],
    description: 'Flight engineer shelf — Assist routes voice/ops notes here',
  },
  {
    id: 'readiness',
    workspace: 'MISSION',
    capability: 'mission',
    tab: 'terrain',
    labels: ['מוכנות'],
    description: 'Mission readiness glance — same concept as diagnostics checklist',
  },
  {
    id: 'vision',
    workspace: 'PLATFORM',
    capability: 'vision',
    tab: 'control',
    subtab: 'visionNavParams',
    labels: ['vision', 'vision nav', 'ניווט לפי תמונה', 'ראייה'],
    description: 'Vision / visual navigation parameters',
  },
  {
    id: 'landing',
    workspace: 'PLATFORM',
    capability: 'landing',
    tab: 'control',
    subtab: 'landingParams',
    labels: ['landing', 'land', 'נחיתה', 'landing confidence', 'landing telemetry'],
    description: 'Landing parameters',
  },
  {
    id: 'navigation',
    workspace: 'PLATFORM',
    capability: 'navigation',
    tab: 'control',
    subtab: 'visionNavParams',
    labels: ['navigation', 'nav', 'ניווט'],
    description: 'Navigation parameters',
  },
  {
    id: 'configuration',
    workspace: 'PLATFORM',
    capability: 'configuration',
    tab: 'control',
    labels: ['configuration', 'config', 'params', 'parameters', 'פרמטרים', 'מרכז פרמטרים'],
    description: 'Parameter / configuration center',
  },
  {
    id: 'auto-config',
    workspace: 'PLATFORM',
    capability: 'configuration',
    tab: 'control',
    subtab: 'autoConfig',
    labels: [
      'auto-config',
      'autoconfig',
      'auto config',
      'אשף',
      'קונפיג אוטומטי',
      'קונפיגורציה אוטומטית',
      'אשף קונפיגורציה',
    ],
    description: 'Auto-config wizard under Parameter Center. Assist + Configuration fold. Panel stays.',
  },
  {
    id: 'diagnostics',
    workspace: 'PLATFORM',
    capability: 'diagnostics',
    tab: 'telemetry',
    labels: ['diagnostics', 'telemetry', 'status', 'טלמטריה', 'אבחון', 'אבחונים'],
    description: 'Telemetry / diagnostics',
  },
  {
    id: 'companion',
    workspace: 'PLATFORM',
    capability: 'companion',
    tab: 'maintenance',
    labels: ['companion', 'Companion', 'maintenance', 'jetson', 'Jetson', 'תחזוקה', 'מלווה', 'מחשב משימה'],
    description: 'Maintenance / companion status',
  },
  {
    id: 'debrief',
    workspace: 'PLATFORM',
    capability: 'debrief',
    tab: 'recordings',
    labels: ['debrief', 'recordings', 'logs', 'flights', 'תחקור', 'הקלטות', 'לוגים', 'טיסות'],
    description: 'Debrief / recordings',
  },
  {
    id: 'pulse_proxy',
    workspace: 'PULSE',
    capability: 'diagnostics',
    tab: 'pulse',
    labels: ['pulse', 'home', 'overview', 'סקירה', 'תמונת מצב', 'בית'],
    description: 'Pulse home',
  },
  {
    id: 'platform',
    workspace: 'PLATFORM',
    capability: 'companion',
    tab: 'platform',
    labels: ['platform', 'פלטפורמה'],
    description: 'Platform capability shells',
  },
]);

export function findAssistRoute(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  // Never treat paths/URLs as Assist destinations
  if (/[\\/]/.test(q) || /^https?:/.test(q) || q.includes('..')) return null;

  for (const route of ASSIST_ROUTES) {
    if (route.id === q) return route;
    for (const label of route.labels) {
      if (q === label) return route;
    }
  }
  // Phrase containment: query contains a full label as a whole phrase
  for (const route of ASSIST_ROUTES) {
    for (const label of route.labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i');
      if (re.test(q)) return route;
    }
  }
  return null;
}

export function getAssistRouteById(id) {
  return ASSIST_ROUTES.find((r) => r.id === id) || null;
}

export function isKnownAssistRouteId(id) {
  return ASSIST_ROUTES.some((r) => r.id === id);
}
