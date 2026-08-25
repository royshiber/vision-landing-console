import { CodingAgentProvider } from './coding-agent-base.mjs';
import { CursorSdkCodingAgentProvider } from './cursor-sdk-coding-agent-provider.mjs';

function nowIso() {
  return new Date().toISOString();
}

export { CodingAgentProvider };

function slugifyTaskId(taskId) {
  return String(taskId || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export class MockCodingAgentProvider extends CodingAgentProvider {
  constructor(opts = {}) {
    super();
    this._sessions = new Map();
    this._scenario = String(opts.scenario || 'healthy').toLowerCase();
  }

  get providerName() {
    return `mock:${this._scenario}`;
  }

  _ensureAvailable() {
    if (this._scenario === 'disconnected') {
      throw new Error('Development agent unavailable');
    }
  }

  _computeState(session) {
    if (!session) return null;
    if (session.state === 'CANCELLED') return { ...session };
    const elapsed = Date.now() - session.createdMs;
    let state = 'QUEUED';
    let msg = 'Queued';
    if (elapsed >= 200) {
      state = 'RUNNING';
      msg = 'Analyzing task context';
    }
    if (elapsed >= 450) {
      state = 'WAITING';
      msg = 'Preparing patch plan';
    }
    if (elapsed >= 800) {
      if (session.scenario === 'degraded') {
        state = 'FAILED';
        msg = 'Provider reported execution failure';
      } else {
        state = 'SUCCEEDED';
        msg = 'Agent completed requested coding task';
      }
    }
    return {
      ...session,
      state,
      updated_at: nowIso(),
      last_message: msg,
      progress: null,
      error: state === 'FAILED' ? 'mock provider degraded scenario' : null,
      log_ref: session.log_ref ?? null,
      output_excerpt: session.output_excerpt ?? null,
      pr_url: state === 'SUCCEEDED' ? (session.pr_url || 'https://example.invalid/development/pull/mock') : (session.pr_url || null),
    };
  }

  async createSession(task, worktree) {
    this._ensureAvailable();
    const taskId = slugifyTaskId(task?.id || 'task');
    const session_id = `mock-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const branch = String(worktree?.branch || `development/tasks/${taskId}`);
    const worktreeId = String(worktree?.worktree_id || `.worktrees/${taskId}`);
    if (!branch.startsWith('development/tasks/')) throw new Error('unsafe agent branch');
    if (!worktreeId.startsWith('.worktrees/')) throw new Error('unsafe agent worktree');
    const s = {
      provider: this.providerName,
      session_id,
      state: 'QUEUED',
      branch,
      worktree: worktreeId,
      started_at: nowIso(),
      updated_at: nowIso(),
      last_message: 'Session created',
      progress: null,
      error: null,
      log_ref: null,
      output_excerpt: null,
      createdMs: Date.now(),
      scenario: this._scenario,
    };
    this._sessions.set(session_id, s);
    return this._computeState(s);
  }

  async getSession(sessionId) {
    this._ensureAvailable();
    const s = this._sessions.get(String(sessionId || ''));
    if (!s) throw new Error('Agent session not found');
    const next = this._computeState(s);
    this._sessions.set(s.session_id, next);
    return next;
  }

  async cancelSession(sessionId) {
    this._ensureAvailable();
    const s = this._sessions.get(String(sessionId || ''));
    if (!s) throw new Error('Agent session not found');
    const next = {
      ...s,
      state: 'CANCELLED',
      updated_at: nowIso(),
      last_message: 'Session cancelled',
      error: null,
    };
    this._sessions.set(s.session_id, next);
    return next;
  }

  async sendInstruction(sessionId, instruction) {
    this._ensureAvailable();
    const s = this._sessions.get(String(sessionId || ''));
    if (!s) throw new Error('Agent session not found');
    const msg = String(instruction || '').trim();
    const next = {
      ...s,
      updated_at: nowIso(),
      state: s.state === 'QUEUED' ? 'RUNNING' : s.state,
      last_message: msg || s.last_message,
    };
    this._sessions.set(s.session_id, next);
    return next;
  }
}

export class UnavailableCodingAgentProvider extends CodingAgentProvider {
  constructor(opts = {}) {
    super();
    const reason = String(opts.reason || '').trim();
    this._reason = reason
      ? (reason.startsWith('Development agent unavailable') ? reason : `Development agent unavailable: ${reason}`)
      : 'Development agent unavailable';
  }

  get providerName() {
    return 'unavailable';
  }

  get unavailableReason() {
    return this._reason;
  }

  _fail() {
    throw new Error(this._reason);
  }

  async createSession() {
    this._fail();
  }

  async getSession() {
    this._fail();
  }

  async cancelSession() {
    this._fail();
  }

  async sendInstruction() {
    this._fail();
  }
}

export function createCodingAgentProvider(env = process.env, opts = {}) {
  const requested = String(env.DEVELOPMENT_AGENT_PROVIDER || '').trim().toLowerCase();
  if (requested === 'mock') {
    return new MockCodingAgentProvider({ scenario: env.DEVELOPMENT_AGENT_MOCK_SCENARIO || 'healthy' });
  }
  if (requested === 'cursor-sdk') {
    const apiKey = String(env.CURSOR_API_KEY || '').trim();
    if (!apiKey) return new UnavailableCodingAgentProvider({ reason: 'CURSOR_API_KEY is not configured' });
    return new CursorSdkCodingAgentProvider({
      apiKey,
      repoRoot: opts.repoRoot || process.cwd(),
      model: env.CURSOR_AGENT_MODEL || 'composer-2.5',
      supervisor: opts.cursorSupervisor || null,
      adapter: opts.cursorSdkAdapter || null,
      wslRuntime: opts.wslRuntime || null,
      wslDistro: env.CURSOR_WSL_DISTRO || opts.wslDistro || '',
      platform: opts.platform || process.platform,
      env,
    });
  }
  return new UnavailableCodingAgentProvider({
    reason: requested
      ? `unsupported DEVELOPMENT_AGENT_PROVIDER: ${requested.slice(0, 40)}`
      : 'DEVELOPMENT_AGENT_PROVIDER is not configured',
  });
}

export { CursorSdkCodingAgentProvider };
