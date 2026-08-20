import { CodingAgentProvider } from './coding-agent-base.mjs';
import { createCursorAgentSupervisor } from './cursor-agent-supervisor.mjs';
import { loadDefaultCursorSdkAdapter } from './cursor-sdk-adapter.mjs';
import { resolveApprovedWorktree } from './cursor-agent-worktree-guard.mjs';
import { createWslCursorAgentSupervisor } from './wsl-cursor-agent-supervisor.mjs';

let _defaultSupervisorPromise = null;

/**
 * Windows cannot host a sandboxed Cursor agent (C9.9-W), so a Windows host runs
 * the agent through the WSL bridge. Explicitly injected supervisors/adapters
 * (tests, non-Windows hosts) keep the in-process path.
 */
export function shouldUseWslRuntime(opts = {}) {
  if (opts.supervisor || opts.adapter) return false;
  if (opts.forceInProcess) return false;
  if (opts.wslRuntime) return true;
  return (opts.platform || process.platform) === 'win32';
}

async function getDefaultSupervisor(opts) {
  if (opts.supervisor) return opts.supervisor;
  if (!_defaultSupervisorPromise) {
    _defaultSupervisorPromise = (async () => {
      if (shouldUseWslRuntime(opts)) {
        return createWslCursorAgentSupervisor({
          repoRoot: opts.repoRoot,
          apiKey: opts.apiKey,
          model: opts.model,
          distro: opts.wslDistro,
          env: opts.env,
          runtime: opts.wslRuntime || null,
        });
      }
      const adapter = opts.adapter || await loadDefaultCursorSdkAdapter();
      return createCursorAgentSupervisor({
        repoRoot: opts.repoRoot,
        apiKey: opts.apiKey,
        model: opts.model,
        adapter,
      });
    })();
  }
  return _defaultSupervisorPromise;
}

export class CursorSdkCodingAgentProvider extends CodingAgentProvider {
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this._supervisor = opts.supervisor || null;
    this._supervisorPromise = null;
  }

  get providerName() {
    return 'cursor-sdk';
  }

  async _supervisorInstance() {
    if (this._supervisor) return this._supervisor;
    if (!this._supervisorPromise) {
      this._supervisorPromise = getDefaultSupervisor(this._opts);
    }
    return this._supervisorPromise;
  }

  async getRuntimeStatus() {
    try {
      const supervisor = await this._supervisorInstance();
      if (typeof supervisor.probeHealth === 'function') {
        const health = await supervisor.probeHealth();
        return {
          ok: health.ok === true,
          kind: health.kind || 'cursor-sdk',
          reason: health.ok === true ? null : (health.reason || 'Development agent unavailable'),
        };
      }
      return { ok: true, kind: 'cursor-sdk-in-process', reason: null };
    } catch (err) {
      return {
        ok: false,
        kind: 'cursor-sdk',
        reason: String(err?.message || 'Development agent unavailable'),
      };
    }
  }

  _validateWorktree(worktree) {
    resolveApprovedWorktree(this._opts.repoRoot || process.cwd(), worktree);
  }

  async createSession(task, worktree) {
    this._validateWorktree(worktree);
    const supervisor = await this._supervisorInstance();
    return supervisor.startSession(task, worktree);
  }

  async getSession(sessionId) {
    const supervisor = await this._supervisorInstance();
    return supervisor.getSessionSnapshot(sessionId);
  }

  async cancelSession(sessionId) {
    const supervisor = await this._supervisorInstance();
    try {
      return await supervisor.cancelSession(sessionId);
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('NOT_SUPPORTED')) throw new Error('NOT_SUPPORTED');
      throw err;
    }
  }

  async sendInstruction(sessionId, instruction) {
    const supervisor = await this._supervisorInstance();
    return supervisor.sendInstruction(sessionId, instruction);
  }
}

export function resetCursorSdkProviderCacheForTests() {
  _defaultSupervisorPromise = null;
}
