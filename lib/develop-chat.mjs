/**
 * Develop Concept B conversation engine.
 * Clarify with MCQ + always-available free text, then build, then Human Gates.
 * Gates never apply to Jetson / FC. Preview stays read-only until GO.
 */

export const DEVELOP_FREE_TEXT_ID = 'free_text';
export const DEVELOP_FREE_TEXT_LABEL = 'או כתוב חופשי';

export const DEVELOP_GATE_JETSON = {
  id: 'jetson_upload',
  label: 'אשר העלאה לג׳טסון',
};

export const DEVELOP_GATE_FC = {
  id: 'fc_install',
  label: 'אשר התקנה ל-FC',
};

const QUESTION_BANK = [
  {
    id: 'surface',
    prompt: 'איפה היכולת תופיע בממשק?',
    options: [
      { id: 'mission', label: 'הטסה' },
      { id: 'pulse', label: 'סטטוס מחשבים' },
      { id: 'params', label: 'פרמטרים' },
    ],
  },
  {
    id: 'shape',
    prompt: 'מה נחשב הצלחה ליכולת הזו?',
    options: [
      { id: 'display_only', label: 'תצוגה בלבד' },
      { id: 'new_param', label: 'פרמטר חדש' },
      { id: 'full_flow', label: 'תהליך מלא בממשק' },
    ],
  },
];

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix, n) {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

function titleFromText(text) {
  const line = String(text || '').trim().split(/\n+/)[0];
  return line.slice(0, 140) || 'יכולת חדשה';
}

function guessTarget(text, answers) {
  const blob = `${text} ${answers.surface || ''}`.toLowerCase();
  if (answers.surface === 'params' || /פרמטר/.test(blob)) return 'OTHER';
  if (answers.surface === 'pulse' || /סטטוס|מחשב משימה|jetson/.test(blob)) return 'COMPANION';
  if (/נחית|מפה|אזור/.test(blob) || answers.surface === 'mission') return 'LANDING';
  if (/וידאו|מצלמ/.test(blob)) return 'VIDEO';
  return 'UI';
}

function withFreeText(question) {
  return {
    id: question.id,
    prompt: question.prompt,
    options: [
      ...question.options.map((opt) => ({ id: opt.id, label: opt.label, freeText: false })),
      { id: DEVELOP_FREE_TEXT_ID, label: DEVELOP_FREE_TEXT_LABEL, freeText: true },
    ],
  };
}

function emptyProgress() {
  return {
    jetson_upload: { status: 'idle', percent: 0 },
    fc_install: { status: 'idle', percent: 0 },
  };
}

function emptyGates() {
  return {
    [DEVELOP_GATE_JETSON.id]: {
      id: DEVELOP_GATE_JETSON.id,
      label: DEVELOP_GATE_JETSON.label,
      enabled: false,
      approved: false,
      applied: false,
    },
    [DEVELOP_GATE_FC.id]: {
      id: DEVELOP_GATE_FC.id,
      label: DEVELOP_GATE_FC.label,
      enabled: false,
      approved: false,
      applied: false,
    },
  };
}

function installFor(session) {
  const ready = session.phase === 'ready' || session.phase === 'landed';
  const params = Array.isArray(session.params) && session.params.length
    ? session.params
    : (ready ? draftParams(session) : []);
  const items = params.map((p) => `${p.key} · ${p.description_he || p.description}`);
  const progress = session.install?.progress
    ? {
      jetson_upload: { ...session.install.progress.jetson_upload },
      fc_install: { ...session.install.progress.fc_install },
    }
    : emptyProgress();
  if (ready) {
    if (progress.jetson_upload.status === 'idle') progress.jetson_upload = { status: 'queued', percent: 0 };
    if (progress.fc_install.status === 'idle') progress.fc_install = { status: 'queued', percent: 0 };
  }
  return {
    authorized: ready,
    note: 'אין פקודת טיסה.',
    jetson: { target: 'מחשב משימה', items: ready ? items : [] },
    fc: { target: 'בקר טיסה', items: ready ? items : [] },
    progress,
  };
}

function previewFor(session) {
  const title = session.title || 'יכולת חדשה';
  const surface = session.answers.surface;
  const shape = session.answers.shape;
  const surfaceLabel = surface === 'pulse'
    ? 'סטטוס מחשבים'
    : surface === 'params'
      ? 'פרמטרים'
      : 'הטסה';
  const afterHint = shape === 'new_param'
    ? 'פרמטר חדש מופיע בכרטיס, בלי כתיבה לבקר.'
    : shape === 'full_flow'
      ? 'תהליך חדש בממשק, בלי החלה אוטומטית.'
      : 'שכבת תצוגה חדשה על המסך הקיים.';
  return {
    mode: session.phase === 'idle' ? 'before' : 'after',
    title,
    before: {
      kicker: 'לפני',
      headline: 'הממשק הנוכחי',
      lines: ['אין את היכולת הזו עדיין.', 'המפעיל עובד במסך הקיים בלבד.'],
    },
    after: {
      kicker: 'אחרי',
      headline: title,
      lines: [`משטח: ${surfaceLabel}`, afterHint, 'תצוגה חיה. אין פקודת טיסה.'],
    },
  };
}

function draftParams(session) {
  const prefix = 'CAP';
  const params = [{
    key: `${prefix}_ENABLE`,
    type: 'INT8',
    default_value: 0,
    min_val: 0,
    max_val: 1,
    description: 'Enable the new capability',
    description_he: 'הפעלת היכולת החדשה',
    units: 'bool',
  }];
  if (session.answers.shape === 'new_param' || /פרמטר/.test(String(session.answers.shape || ''))) {
    params.push({
      key: `${prefix}_GAIN`,
      type: 'FLOAT',
      default_value: 1,
      min_val: 0,
      max_val: 10,
      description: 'Capability gain',
      description_he: 'עוצמת היכולת',
      units: '',
    });
  }
  return params;
}

export function createDevelopChatSession(seed = {}) {
  const description = String(seed.description || seed.what || '').trim();
  return {
    id: seed.id || null,
    phase: 'idle',
    title: String(seed.title || '').trim(),
    description,
    taxonomy: seed.taxonomy || 'FEATURE',
    target_area: seed.target_area || 'OTHER',
    priority: seed.priority || 'HIGH',
    answers: {},
    pendingQuestion: null,
    questionIndex: 0,
    messages: [],
    gates: emptyGates(),
    install: {
      authorized: false,
      note: 'אין פקודת טיסה.',
      jetson: { target: 'מחשב משימה', items: [] },
      fc: { target: 'בקר טיסה', items: [] },
      progress: emptyProgress(),
    },
    preview: null,
    params: [],
    taskId: null,
    agent: { started: false, available: null, reason: null },
    featureId: null,
    created_at: seed.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

export function snapshotDevelopChat(session) {
  const next = {
    ...session,
    preview: previewFor(session),
    pendingQuestion: session.pendingQuestion
      ? withFreeText(session.pendingQuestion)
      : null,
    gates: {
      jetson_upload: { ...session.gates.jetson_upload },
      fc_install: { ...session.gates.fc_install },
    },
    params: Array.isArray(session.params) ? session.params.map((p) => ({ ...p })) : [],
    install: installFor(session),
    answers: { ...session.answers },
    messages: session.messages.map((m) => ({ ...m })),
  };
  return next;
}

function pushMessage(session, role, text, extra = {}) {
  session.messages.push({
    id: `m-${session.messages.length + 1}`,
    role,
    text,
    at: nowIso(),
    ...extra,
  });
}

function setQuestion(session, index) {
  const q = QUESTION_BANK[index];
  if (!q) {
    session.pendingQuestion = null;
    session.phase = 'awaiting_build';
    return;
  }
  session.questionIndex = index;
  session.pendingQuestion = { id: q.id, prompt: q.prompt, options: q.options };
  session.phase = 'clarify';
}

function enableGates(session) {
  session.gates.jetson_upload.enabled = true;
  session.gates.fc_install.enabled = true;
}

function applyAnswer(session, questionId, value) {
  session.answers[questionId] = value;
  if (questionId === 'surface') {
    session.target_area = guessTarget(session.description, session.answers);
  }
}

export function applyDevelopChatTurn(session, input = {}) {
  const text = String(input.text || '').trim();
  const choiceId = String(input.choiceId || '').trim();
  if (!text && !choiceId) {
    throw new Error('חסרה הודעה');
  }

  if (session.phase === 'idle') {
    if (!text) throw new Error('חסרה הודעה');
    session.title = session.title || titleFromText(text);
    session.description = text;
    session.target_area = guessTarget(text, session.answers);
    pushMessage(session, 'user', text);
    setQuestion(session, 0);
    pushMessage(session, 'assistant', QUESTION_BANK[0].prompt, { questionId: QUESTION_BANK[0].id });
    session.updated_at = nowIso();
    return snapshotDevelopChat(session);
  }

  if (session.phase === 'clarify' && session.pendingQuestion) {
    const q = session.pendingQuestion;
    const known = new Set(q.options.map((o) => o.id));
    known.add(DEVELOP_FREE_TEXT_ID);
    let value = text;
    if (choiceId && choiceId !== DEVELOP_FREE_TEXT_ID) {
      if (!known.has(choiceId)) throw new Error('בחירה לא מוכרת');
      const opt = q.options.find((o) => o.id === choiceId);
      value = opt?.label || choiceId;
      pushMessage(session, 'user', value, { choiceId });
    } else {
      if (!text) throw new Error('חסרה הודעה');
      pushMessage(session, 'user', text, { choiceId: DEVELOP_FREE_TEXT_ID });
      value = text;
    }
    applyAnswer(session, q.id, value);
    const nextIndex = session.questionIndex + 1;
    if (nextIndex < QUESTION_BANK.length) {
      setQuestion(session, nextIndex);
      pushMessage(session, 'assistant', QUESTION_BANK[nextIndex].prompt, { questionId: QUESTION_BANK[nextIndex].id });
    } else {
      session.pendingQuestion = null;
      session.phase = 'awaiting_build';
      pushMessage(session, 'assistant', 'יש לי מספיק. אפשר לבנות את הקוד. השערים יישארו כבויים עד שהיכולת מוכנה.');
    }
    session.updated_at = nowIso();
    return snapshotDevelopChat(session);
  }

  if (!text) throw new Error('חסרה הודעה');
  pushMessage(session, 'user', text);
  if (session.phase === 'awaiting_build') {
    pushMessage(session, 'assistant', 'אפשר לבנות עכשיו. השערים עדיין כבויים.');
  } else if (session.phase === 'ready' || session.phase === 'landed') {
    pushMessage(session, 'assistant', 'היכולת מוכנה לתצוגה. מה יותקן מוצג למטה. אין פקודת טיסה.');
  } else {
    pushMessage(session, 'assistant', 'ממשיך מהמצב הנוכחי.');
  }
  session.updated_at = nowIso();
  return snapshotDevelopChat(session);
}

export function markDevelopChatBuilding(session) {
  session.phase = 'building';
  session.pendingQuestion = null;
  pushMessage(session, 'assistant', 'בונה את הקוד על ענף מבודד. תצוגה חיה בלבד. אין העלאה ואין התקנה.');
  session.updated_at = nowIso();
  return snapshotDevelopChat(session);
}

export function markDevelopChatReady(session, extras = {}) {
  if (extras.taskId) session.taskId = extras.taskId;
  if (extras.featureId) session.featureId = extras.featureId;
  if (extras.agent) session.agent = { ...session.agent, ...extras.agent };
  if (Array.isArray(extras.params)) session.params = extras.params;
  else session.params = draftParams(session);
  session.phase = extras.landed ? 'landed' : 'ready';
  enableGates(session);
  session.install = {
    authorized: true,
    note: 'אין פקודת טיסה.',
    jetson: { target: 'מחשב משימה', items: [] },
    fc: { target: 'בקר טיסה', items: [] },
    progress: {
      jetson_upload: { status: 'queued', percent: 0 },
      fc_install: { status: 'queued', percent: 0 },
    },
  };
  pushMessage(
    session,
    'assistant',
    extras.landed
      ? 'היכולת נחתה. הפרמטרים בכרטיס פרמטרים. למטה מוצג מה יותקן. אין פקודת טיסה.'
      : 'הקוד מוכן לתצוגה. למטה מוצג מה יותקן. אין החלה על חומרה חיה ואין פקודת טיסה.',
    { gates: true },
  );
  session.updated_at = nowIso();
  return snapshotDevelopChat(session);
}

export function approveDevelopChatGate(session, gateId) {
  const gate = session.gates[gateId];
  if (!gate) throw new Error('שער לא מוכר');
  if (!gate.enabled || (session.phase !== 'ready' && session.phase !== 'landed')) {
    throw new Error('השער עדיין כבוי');
  }
  gate.approved = true;
  gate.applied = false;
  if (!session.install) session.install = installFor(session);
  if (!session.install.progress) session.install.progress = emptyProgress();
  session.install.progress[gateId] = { status: 'recorded', percent: 100 };
  pushMessage(
    session,
    'assistant',
    gateId === DEVELOP_GATE_JETSON.id
      ? 'נרשמה התקדמות העלאה למחשב משימה. אין החלה על חומרה חיה ואין פקודת טיסה.'
      : 'נרשמה התקדמות התקנה לבקר. אין כתיבה לבקר ואין פקודת טיסה.',
    { gateId, applied: false },
  );
  session.updated_at = nowIso();
  return snapshotDevelopChat(session);
}

export function createDevelopChatEngine(opts = {}) {
  const sessions = opts.sessions || new Map();
  let seq = opts.seq || 0;

  function create(seed = {}) {
    seq += 1;
    const session = createDevelopChatSession({ ...seed, id: seed.id || makeId('devchat', seq) });
    if (session.title || session.description) {
      session.preview = previewFor(session);
    }
    sessions.set(session.id, session);
    return snapshotDevelopChat(session);
  }

  function get(id) {
    const session = sessions.get(id);
    if (!session) return null;
    return snapshotDevelopChat(session);
  }

  function requireSession(id) {
    const session = sessions.get(id);
    if (!session) throw new Error('שיחה לא נמצאה');
    return session;
  }

  function turn(id, input) {
    let session = id ? sessions.get(id) : null;
    if (!session) {
      if (id) throw new Error('שיחה לא נמצאה');
      const created = create({
        title: titleFromText(input?.text),
        description: input?.text,
      });
      session = sessions.get(created.id);
    }
    return applyDevelopChatTurn(session, input);
  }

  return {
    create,
    get,
    turn,
    markBuilding(id) {
      return markDevelopChatBuilding(requireSession(id));
    },
    markReady(id, extras) {
      return markDevelopChatReady(requireSession(id), extras);
    },
    approveGate(id, gateId) {
      return approveDevelopChatGate(requireSession(id), gateId);
    },
    _sessions: sessions,
  };
}
