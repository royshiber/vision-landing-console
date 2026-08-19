import fs from 'fs';
import path from 'path';

export const DEV_TASK_STATUSES = Object.freeze([
  'DRAFT',
  'QUEUED',
  'IN_PROGRESS',
  'WAITING_FOR_REVIEW',
  'TESTING',
  'READY_FOR_RELEASE',
  'RELEASED',
  'DEPLOYED',
  'FAILED',
  'CANCELLED',
]);

export const DEV_TASK_PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
export const DEV_TASK_TARGET_AREAS = Object.freeze([
  'VISION',
  'NAVIGATION',
  'LANDING',
  'VIDEO',
  'MAVLINK',
  'COMPANION',
  'UI',
  'API',
  'MAINTENANCE',
  'OTHER',
]);

export const DEV_AGENT_STATES = Object.freeze([
  'NOT_STARTED',
  'QUEUED',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const DEV_TEST_STATES = Object.freeze([
  'NOT_STARTED',
  'QUEUED',
  'RUNNING',
  'PASSED',
  'FAILED',
  'CANCELLED',
]);

export const DEV_RELEASE_STATES = Object.freeze([
  'NOT_STARTED',
  'BUILDING',
  'READY',
  'FAILED',
  'DEPLOYED',
]);

export const DEV_TASK_TRANSITIONS = Object.freeze({
  DRAFT: ['QUEUED', 'CANCELLED'],
  QUEUED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['TESTING', 'FAILED', 'CANCELLED'],
  WAITING_FOR_REVIEW: ['TESTING', 'READY_FOR_RELEASE', 'CANCELLED'],
  TESTING: ['WAITING_FOR_REVIEW', 'FAILED', 'CANCELLED'],
  READY_FOR_RELEASE: ['RELEASED'],
  RELEASED: ['DEPLOYED'],
  DEPLOYED: [],
  FAILED: [],
  CANCELLED: [],
});

const DEV_TASK_STORE_RELATIVE = path.join('var', 'development', 'tasks.json');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, obj) {
  ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function normalizeEnum(value, allowed, fallback = null) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : null;
}

function requireText(value, field, maxLen) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maxLen) throw new Error(`${field} is too long`);
  return text;
}

function optionalText(value, maxLen = 8000) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLen) throw new Error('text is too long');
  return text;
}

function createTaskId() {
  const stamp = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `dev-${stamp}-${rnd}`;
}

export function canTransitionStatus(fromStatus, toStatus) {
  const from = normalizeEnum(fromStatus, DEV_TASK_STATUSES);
  const to = normalizeEnum(toStatus, DEV_TASK_STATUSES);
  if (!from || !to) return false;
  if (from === to) return true;
  return (DEV_TASK_TRANSITIONS[from] || []).includes(to);
}

function sanitizeTaskForStore(task) {
  const agent = task.agent && typeof task.agent === 'object' ? task.agent : {};
  const tests = task.tests && typeof task.tests === 'object' ? task.tests : {};
  const worktreeMeta = task.worktree_meta && typeof task.worktree_meta === 'object' ? task.worktree_meta : {};
  return {
    id: String(task.id),
    title: String(task.title),
    description: String(task.description),
    notes: task.notes == null ? null : String(task.notes),
    created_at: String(task.created_at),
    updated_at: String(task.updated_at),
    status: String(task.status),
    priority: String(task.priority),
    target_area: String(task.target_area),
    branch: task.branch == null ? null : String(task.branch),
    worktree: task.worktree == null ? null : String(task.worktree),
    worktree_meta: {
      id: worktreeMeta.id ?? null,
      branch: worktreeMeta.branch ?? null,
      created_at: worktreeMeta.created_at ?? null,
      base_commit: worktreeMeta.base_commit ?? null,
      clean: worktreeMeta.clean ?? null,
      changed_files: Number(worktreeMeta.changed_files ?? 0),
    },
    agent: {
      provider: agent.provider ?? null,
      session_id: agent.session_id ?? null,
      state: agent.state ?? 'NOT_STARTED',
      branch: agent.branch ?? null,
      worktree: agent.worktree ?? null,
      started_at: agent.started_at ?? null,
      updated_at: agent.updated_at ?? null,
      last_message: agent.last_message ?? null,
      progress: agent.progress ?? null,
      error: agent.error ?? null,
      log_ref: agent.log_ref ?? null,
      output_excerpt: agent.output_excerpt ?? null,
    },
    tests: {
      profile: tests.profile ?? null,
      state: tests.state ?? 'NOT_STARTED',
      passed: tests.passed ?? null,
      failed: tests.failed ?? null,
      duration_ms: tests.duration_ms ?? null,
      last_run: tests.last_run ?? null,
      result: tests.result ?? null,
      exit_status: tests.exit_status ?? null,
      run_id: tests.run_id ?? null,
      log_ref: tests.log_ref ?? null,
    },
    release: {
      state: task.release?.state ?? 'NOT_STARTED',
      release_id: task.release?.release_id ?? null,
      version: task.release?.version ?? null,
      artifact_sha256: task.release?.artifact_sha256 ?? null,
      artifact_size: task.release?.artifact_size ?? null,
      source_commit: task.release?.source_commit ?? null,
      task_id: task.release?.task_id ?? null,
      created_at: task.release?.created_at ?? null,
      error: task.release?.error ?? null,
      mock: task.release?.mock ?? null,
    },
    deployment: task.deployment || { state: 'NOT_STARTED', running_version: null, result: null },
    audit: Array.isArray(task.audit) ? task.audit : [],
  };
}

function readStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return { tasks: [] };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('malformed task store JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
    throw new Error('malformed task store schema');
  }
  return {
    tasks: parsed.tasks.map(sanitizeTaskForStore),
  };
}

function writeStore(filePath, state) {
  atomicWriteJson(filePath, { tasks: state.tasks.map(sanitizeTaskForStore) });
}

function pushAudit(task, action, previous_value, new_value) {
  if (!Array.isArray(task.audit)) task.audit = [];
  task.audit.push({
    timestamp: nowIso(),
    action,
    previous_value: previous_value ?? null,
    new_value: new_value ?? null,
  });
}

function buildTask(input) {
  const created = nowIso();
  const id = input.id ? String(input.id).trim() : createTaskId();
  const title = requireText(input.title, 'title', 140);
  const description = requireText(input.description, 'description', 5000);
  const target_area = normalizeEnum(input.target_area, DEV_TASK_TARGET_AREAS, 'OTHER');
  if (!target_area) throw new Error('invalid target_area');
  const priority = normalizeEnum(input.priority, DEV_TASK_PRIORITIES, 'NORMAL');
  if (!priority) throw new Error('invalid priority');
  const notes = optionalText(input.notes, 5000);
  const status = 'DRAFT';
  const task = {
    id,
    title,
    description,
    notes,
    created_at: created,
    updated_at: created,
    status,
    priority,
    target_area,
    branch: null,
    worktree: null,
    worktree_meta: {
      id: null,
      branch: null,
      created_at: null,
      base_commit: null,
      clean: null,
      changed_files: 0,
    },
    agent: {
      provider: null,
      session_id: null,
      state: 'NOT_STARTED',
      branch: null,
      worktree: null,
      started_at: null,
      updated_at: null,
      last_message: null,
      progress: null,
      error: null,
      log_ref: null,
      output_excerpt: null,
    },
    tests: {
      profile: null,
      state: 'NOT_STARTED',
      passed: null,
      failed: null,
      duration_ms: null,
      last_run: null,
      result: null,
      exit_status: null,
      run_id: null,
      log_ref: null,
    },
    release: {
      state: 'NOT_STARTED',
      release_id: null,
      version: null,
      artifact_sha256: null,
      artifact_size: null,
      source_commit: null,
      task_id: null,
      created_at: null,
      error: null,
      mock: null,
    },
    deployment: { state: 'NOT_STARTED', running_version: null, result: null },
    audit: [],
  };
  pushAudit(task, 'created', null, { status, priority, target_area });
  return task;
}

function sortByUpdated(tasks, sort = 'updated_desc') {
  const dir = String(sort || 'updated_desc').toLowerCase() === 'updated_asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const av = Date.parse(a.updated_at) || 0;
    const bv = Date.parse(b.updated_at) || 0;
    return (av - bv) * dir;
  });
}

function applyFilters(tasks, { status, target, openOnly }) {
  const statusNorm = status ? normalizeEnum(status, DEV_TASK_STATUSES) : null;
  const targetNorm = target ? normalizeEnum(target, DEV_TASK_TARGET_AREAS) : null;
  return tasks.filter((t) => {
    if (statusNorm && t.status !== statusNorm) return false;
    if (targetNorm && t.target_area !== targetNorm) return false;
    if (openOnly && ['DEPLOYED', 'CANCELLED'].includes(t.status)) return false;
    return true;
  });
}

export function createDevelopmentTaskStore(opts = {}) {
  const filePath = opts.filePath || path.join(process.cwd(), DEV_TASK_STORE_RELATIVE);

  function list(query = {}) {
    const state = readStore(filePath);
    const filtered = applyFilters(state.tasks, {
      status: query.status || null,
      target: query.target || null,
      openOnly: String(query.open || '').toLowerCase() === 'true',
    });
    return sortByUpdated(filtered, query.sort || 'updated_desc');
  }

  function getById(id) {
    const state = readStore(filePath);
    return state.tasks.find((t) => t.id === String(id || '').trim()) || null;
  }

  function create(input) {
    const state = readStore(filePath);
    const task = buildTask(input || {});
    if (state.tasks.some((t) => t.id === task.id)) {
      throw new Error('duplicate task id');
    }
    state.tasks.push(task);
    writeStore(filePath, state);
    return task;
  }

  function patch(id, updates = {}) {
    const state = readStore(filePath);
    const task = state.tasks.find((t) => t.id === String(id || '').trim());
    if (!task) return null;

    const allowed = new Set(['title', 'description', 'notes', 'priority', 'target_area', 'status']);
    const keys = Object.keys(updates || {});
    for (const key of keys) {
      if (!allowed.has(key)) throw new Error(`field not allowed: ${key}`);
    }

    if ('title' in updates) {
      const next = requireText(updates.title, 'title', 140);
      if (next !== task.title) {
        pushAudit(task, 'edited', { title: task.title }, { title: next });
        task.title = next;
      }
    }
    if ('description' in updates) {
      const next = requireText(updates.description, 'description', 5000);
      if (next !== task.description) {
        pushAudit(task, 'edited', { description: task.description }, { description: next });
        task.description = next;
      }
    }
    if ('notes' in updates) {
      const next = optionalText(updates.notes, 5000);
      if (next !== task.notes) {
        pushAudit(task, 'edited', { notes: task.notes }, { notes: next });
        task.notes = next;
      }
    }
    if ('priority' in updates) {
      const next = normalizeEnum(updates.priority, DEV_TASK_PRIORITIES);
      if (!next) throw new Error('invalid priority');
      if (next !== task.priority) {
        pushAudit(task, 'priority_changed', { priority: task.priority }, { priority: next });
        task.priority = next;
      }
    }
    if ('target_area' in updates) {
      const next = normalizeEnum(updates.target_area, DEV_TASK_TARGET_AREAS);
      if (!next) throw new Error('invalid target_area');
      if (next !== task.target_area) {
        pushAudit(task, 'target_changed', { target_area: task.target_area }, { target_area: next });
        task.target_area = next;
      }
    }
    if ('status' in updates) {
      const next = normalizeEnum(updates.status, DEV_TASK_STATUSES);
      if (!next) throw new Error('invalid status');
      if (!canTransitionStatus(task.status, next)) {
        throw new Error(`invalid status transition: ${task.status} -> ${next}`);
      }
      if (next !== task.status) {
        const action = next === 'CANCELLED' ? 'cancelled' : 'status_changed';
        pushAudit(task, action, { status: task.status }, { status: next });
        task.status = next;
      }
    }

    task.updated_at = nowIso();
    writeStore(filePath, state);
    return task;
  }

  function mutateTask(id, mutator) {
    const state = readStore(filePath);
    const task = state.tasks.find((t) => t.id === String(id || '').trim());
    if (!task) return null;
    mutator(task);
    task.updated_at = nowIso();
    writeStore(filePath, state);
    return task;
  }

  function startAgent(id, payload = {}) {
    return mutateTask(id, (task) => {
      const now = nowIso();
      const prevAgent = { ...task.agent };
      const provider = String(payload.provider || 'mock');
      const sessionId = String(payload.session_id || '').trim();
      const branch = String(payload.branch || '').trim();
      const worktree = String(payload.worktree || '').trim();
      if (!sessionId || !branch || !worktree) {
        throw new Error('missing agent session metadata');
      }

      if (task.status === 'DRAFT') {
        pushAudit(task, 'status_changed', { status: task.status }, { status: 'QUEUED' });
        task.status = 'QUEUED';
      }
      if (task.status === 'QUEUED') {
        pushAudit(task, 'status_changed', { status: task.status }, { status: 'IN_PROGRESS' });
        task.status = 'IN_PROGRESS';
      }
      if (task.status !== 'IN_PROGRESS') {
        throw new Error(`task status does not allow agent start: ${task.status}`);
      }

      task.branch = branch;
      task.worktree = worktree;
      task.agent = {
        provider,
        session_id: sessionId,
        state: 'RUNNING',
        branch,
        worktree,
        started_at: now,
        updated_at: now,
        last_message: payload.last_message ?? 'Agent started',
        progress: Number.isFinite(payload.progress) ? payload.progress : null,
        error: null,
        log_ref: payload.log_ref ?? null,
        output_excerpt: payload.output_excerpt ?? null,
      };
      pushAudit(task, 'agent_started', prevAgent, { ...task.agent });
    });
  }

  function syncAgent(id, payload = {}) {
    return mutateTask(id, (task) => {
      const prevAgent = { ...task.agent };
      const nextState = normalizeEnum(payload.state, DEV_AGENT_STATES, task.agent?.state || 'NOT_STARTED');
      if (!nextState) throw new Error('invalid agent state');
      task.agent = {
        ...task.agent,
        state: nextState,
        updated_at: nowIso(),
        last_message: payload.last_message ?? task.agent?.last_message ?? null,
        progress: Number.isFinite(payload.progress) ? payload.progress : (task.agent?.progress ?? null),
        error: payload.error ?? task.agent?.error ?? null,
        log_ref: payload.log_ref ?? task.agent?.log_ref ?? null,
        output_excerpt: payload.output_excerpt ?? task.agent?.output_excerpt ?? null,
      };
      pushAudit(task, 'agent_updated', prevAgent, { ...task.agent });

      if (nextState === 'SUCCEEDED') {
        pushAudit(task, 'agent_completed', { status: task.status }, { status: task.status });
      } else if (nextState === 'FAILED') {
        const prevStatus = task.status;
        task.status = 'FAILED';
        pushAudit(task, 'agent_failed', { status: prevStatus }, { status: task.status, error: task.agent.error ?? null });
      } else if (nextState === 'CANCELLED') {
        const prevStatus = task.status;
        task.status = 'CANCELLED';
        pushAudit(task, 'agent_cancelled', { status: prevStatus }, { status: task.status });
      }
    });
  }

  function markAgentCancelRequested(id, message = null) {
    return mutateTask(id, (task) => {
      const prevAgent = { ...task.agent };
      task.agent = {
        ...task.agent,
        updated_at: nowIso(),
        last_message: message ?? task.agent?.last_message ?? 'Cancel requested',
      };
      pushAudit(task, 'agent_cancel_requested', prevAgent, { ...task.agent });
    });
  }

  function setWorktree(id, meta = {}) {
    return mutateTask(id, (task) => {
      const prev = task.worktree_meta || null;
      task.branch = meta.branch || task.branch;
      task.worktree = meta.worktree_id || task.worktree;
      task.worktree_meta = {
        id: meta.worktree_id || null,
        branch: meta.branch || null,
        created_at: meta.created_at || nowIso(),
        base_commit: meta.base_commit || null,
        clean: meta.clean ?? true,
        changed_files: Number(meta.changed_files || 0),
      };
      if (task.status === 'DRAFT') {
        pushAudit(task, 'status_changed', { status: task.status }, { status: 'QUEUED' });
        task.status = 'QUEUED';
      }
      if (task.status === 'QUEUED') {
        pushAudit(task, 'status_changed', { status: task.status }, { status: 'IN_PROGRESS' });
        task.status = 'IN_PROGRESS';
      }
      pushAudit(task, 'worktree_created', prev, task.worktree_meta);
    });
  }

  function setWorktreeStatus(id, meta = {}) {
    return mutateTask(id, (task) => {
      const prev = { ...(task.worktree_meta || {}) };
      task.worktree_meta = {
        ...(task.worktree_meta || {}),
        clean: meta.clean ?? task.worktree_meta?.clean ?? null,
        changed_files: Number(meta.changed_files ?? task.worktree_meta?.changed_files ?? 0),
        base_commit: meta.base_commit || task.worktree_meta?.base_commit || null,
      };
      pushAudit(task, 'worktree_status', prev, task.worktree_meta);
    });
  }

  function clearWorktree(id, note = null) {
    return mutateTask(id, (task) => {
      const prev = task.worktree_meta || null;
      task.branch = null;
      task.worktree = null;
      task.worktree_meta = {
        id: null,
        branch: null,
        created_at: null,
        base_commit: null,
        clean: null,
        changed_files: 0,
      };
      pushAudit(task, 'worktree_removed', prev, { note: note || 'removed' });
    });
  }

  function startTests(id, payload = {}) {
    return mutateTask(id, (task) => {
      const prev = { ...(task.tests || {}) };
      task.status = 'TESTING';
      task.tests = {
        profile: payload.profile,
        state: 'RUNNING',
        passed: null,
        failed: null,
        duration_ms: null,
        last_run: payload.started_at || nowIso(),
        result: null,
        exit_status: null,
        run_id: payload.run_id || null,
        log_ref: payload.log_ref || null,
      };
      pushAudit(task, 'test_started', prev, { profile: task.tests.profile, run_id: task.tests.run_id });
    });
  }

  function completeTests(id, payload = {}) {
    return mutateTask(id, (task) => {
      const prev = { ...(task.tests || {}) };
      const state = normalizeEnum(payload.state, DEV_TEST_STATES);
      if (!state) throw new Error('invalid test state');
      task.tests = {
        ...task.tests,
        state,
        passed: payload.passed ?? task.tests.passed ?? null,
        failed: payload.failed ?? task.tests.failed ?? null,
        duration_ms: payload.duration_ms ?? task.tests.duration_ms ?? null,
        last_run: payload.ended_at || task.tests.last_run || nowIso(),
        result: payload.result ?? task.tests.result ?? null,
        exit_status: payload.exit_status ?? task.tests.exit_status ?? null,
        run_id: payload.run_id ?? task.tests.run_id ?? null,
        log_ref: payload.log_ref ?? task.tests.log_ref ?? null,
      };
      if (state === 'PASSED') {
        task.status = 'WAITING_FOR_REVIEW';
        pushAudit(task, 'test_passed', prev, { profile: task.tests.profile, result: task.tests.result });
      } else if (state === 'FAILED') {
        task.status = 'FAILED';
        pushAudit(task, 'test_failed', prev, { profile: task.tests.profile, result: task.tests.result });
      } else if (state === 'CANCELLED') {
        pushAudit(task, 'test_cancelled', prev, { profile: task.tests.profile, result: task.tests.result });
      }
    });
  }

  function markTestCancelRequested(id) {
    return mutateTask(id, (task) => {
      pushAudit(task, 'test_cancel_requested', { run_id: task.tests?.run_id || null }, { run_id: task.tests?.run_id || null });
    });
  }

  function recordEvent(id, action, previous_value = null, new_value = null) {
    return mutateTask(id, (task) => {
      pushAudit(task, action, previous_value, new_value);
    });
  }

  function approveForRelease(id) {
    return mutateTask(id, (task) => {
      const prev = task.status;
      if (task.status !== 'WAITING_FOR_REVIEW') throw new Error('task is not waiting for review');
      pushAudit(task, 'release_approval_requested', { status: prev }, { status: prev });
      task.status = 'READY_FOR_RELEASE';
      pushAudit(task, 'release_approved', { status: prev }, { status: task.status });
    });
  }

  function startReleaseBuild(id) {
    return mutateTask(id, (task) => {
      const prev = { ...(task.release || {}) };
      task.release = {
        ...task.release,
        state: 'BUILDING',
        error: null,
      };
      pushAudit(task, 'release_build_started', prev, { state: task.release.state });
    });
  }

  function completeReleaseBuild(id, payload = {}) {
    return mutateTask(id, (task) => {
      const prev = { ...(task.release || {}) };
      const nextState = normalizeEnum(payload.state, DEV_RELEASE_STATES);
      if (!nextState || !['READY', 'FAILED'].includes(nextState)) throw new Error('invalid release build state');
      task.release = {
        ...task.release,
        state: nextState,
        release_id: payload.release_id ?? task.release?.release_id ?? null,
        version: payload.version ?? task.release?.version ?? null,
        artifact_sha256: payload.artifact_sha256 ?? task.release?.artifact_sha256 ?? null,
        artifact_size: payload.artifact_size ?? task.release?.artifact_size ?? null,
        source_commit: payload.source_commit ?? task.release?.source_commit ?? null,
        task_id: task.id,
        created_at: payload.created_at ?? task.release?.created_at ?? nowIso(),
        error: payload.error ?? null,
        mock: payload.mock ?? null,
      };
      if (nextState === 'READY') {
        task.status = 'RELEASED';
        pushAudit(task, 'release_build_succeeded', prev, { release_id: task.release.release_id, version: task.release.version });
      } else {
        pushAudit(task, 'release_build_failed', prev, { error: task.release.error });
      }
    });
  }

  function recordDeployResult(id, payload = {}) {
    return mutateTask(id, (task) => {
      const prevDeployment = { ...(task.deployment || {}) };
      const prevStatus = task.status;
      const result = String(payload.result || '').toLowerCase();
      task.deployment = {
        ...task.deployment,
        state: payload.state || task.deployment?.state || null,
        running_version: payload.running_version ?? task.deployment?.running_version ?? null,
        result: result || task.deployment?.result || null,
      };
      if (result === 'success') {
        task.status = 'DEPLOYED';
        task.release = { ...task.release, state: 'DEPLOYED' };
        pushAudit(task, 'deploy_succeeded', { status: prevStatus, deployment: prevDeployment }, { status: task.status, deployment: task.deployment });
      } else if (result === 'rolled_back') {
        if (task.status === 'DEPLOYED') task.status = 'RELEASED';
        pushAudit(task, 'deploy_rolled_back', { status: prevStatus, deployment: prevDeployment }, { status: task.status, deployment: task.deployment });
      } else {
        if (task.status === 'DEPLOYED') task.status = 'RELEASED';
        pushAudit(task, 'deploy_failed', { status: prevStatus, deployment: prevDeployment }, { status: task.status, deployment: task.deployment });
      }
    });
  }

  return {
    filePath,
    list,
    getById,
    create,
    patch,
    startAgent,
    syncAgent,
    markAgentCancelRequested,
    setWorktree,
    setWorktreeStatus,
    clearWorktree,
    startTests,
    completeTests,
    markTestCancelRequested,
    recordEvent,
    approveForRelease,
    startReleaseBuild,
    completeReleaseBuild,
    recordDeployResult,
  };
}
