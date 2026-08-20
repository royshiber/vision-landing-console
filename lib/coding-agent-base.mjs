export class CodingAgentProvider {
  get providerName() {
    return 'abstract';
  }

  /** Public, secret-free explanation shown when the provider cannot run. */
  get unavailableReason() {
    return null;
  }

  /**
   * Readiness of the execution runtime behind the provider. Providers that own
   * an out-of-process runtime override this with a real probe.
   */
  async getRuntimeStatus() {
    const ok = this.providerName !== 'unavailable' && !String(this.providerName).startsWith('unavailable');
    return { ok, kind: this.providerName, reason: ok ? null : this.unavailableReason };
  }

  async createSession(_task, _worktree) {
    throw new Error('createSession not implemented');
  }

  async getSession(_sessionId) {
    throw new Error('getSession not implemented');
  }

  async cancelSession(_sessionId) {
    throw new Error('cancelSession not implemented');
  }

  async sendInstruction(_sessionId, _instruction) {
    throw new Error('sendInstruction not implemented');
  }
}
