import { CodingAgentProvider } from './coding-agent-base.mjs';

/**
 * Live-replaceable coding-agent provider. Assist and Development share one
 * handle so POST connect can swap the inner provider without rebuilding the stack.
 */
export class CodingAgentProviderHandle extends CodingAgentProvider {
  constructor(inner) {
    super();
    if (!inner) throw new Error('provider required');
    this._inner = inner;
  }

  replace(next) {
    if (!next) throw new Error('provider required');
    this._inner = next;
    return this._inner;
  }

  get inner() {
    return this._inner;
  }

  get providerName() {
    return this._inner.providerName;
  }

  get unavailableReason() {
    return this._inner.unavailableReason;
  }

  async getRuntimeStatus() {
    return this._inner.getRuntimeStatus();
  }

  async createSession(task, worktree) {
    return this._inner.createSession(task, worktree);
  }

  async getSession(sessionId) {
    return this._inner.getSession(sessionId);
  }

  async cancelSession(sessionId) {
    return this._inner.cancelSession(sessionId);
  }

  async sendInstruction(sessionId, instruction) {
    return this._inner.sendInstruction(sessionId, instruction);
  }
}

export function wrapCodingAgentProvider(provider) {
  if (provider instanceof CodingAgentProviderHandle) return provider;
  return new CodingAgentProviderHandle(provider);
}
