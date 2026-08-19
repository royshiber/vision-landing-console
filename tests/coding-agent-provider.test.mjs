import { describe, it, expect } from 'vitest';
import {
  MockCodingAgentProvider,
  UnavailableCodingAgentProvider,
  createCodingAgentProvider,
} from '../lib/coding-agent-provider.mjs';

describe('coding-agent-provider', () => {
  it('runs healthy mock lifecycle to success', async () => {
    const p = new MockCodingAgentProvider({ scenario: 'healthy' });
    const s = await p.createSession({ id: 'dev-1' }, { branch: 'development/tasks/dev-1', worktree_id: '.worktrees/dev-1' });
    expect(s.branch).toContain('development/tasks/dev-1');
    await new Promise((r) => setTimeout(r, 1100));
    const done = await p.getSession(s.session_id);
    expect(done.state).toBe('SUCCEEDED');
    expect(done.progress).toBe(null);
  });

  it('runs degraded mock lifecycle to failure', async () => {
    const p = new MockCodingAgentProvider({ scenario: 'degraded' });
    const s = await p.createSession({ id: 'dev-2' }, { branch: 'development/tasks/dev-2', worktree_id: '.worktrees/dev-2' });
    await new Promise((r) => setTimeout(r, 1100));
    const done = await p.getSession(s.session_id);
    expect(done.state).toBe('FAILED');
    expect(done.error).toContain('degraded');
  });

  it('supports cancellation', async () => {
    const p = new MockCodingAgentProvider({ scenario: 'healthy' });
    const s = await p.createSession({ id: 'dev-3' }, { branch: 'development/tasks/dev-3', worktree_id: '.worktrees/dev-3' });
    const c = await p.cancelSession(s.session_id);
    expect(c.state).toBe('CANCELLED');
  });

  it('returns unavailable provider when requested provider is unknown', async () => {
    const p = createCodingAgentProvider({ DEVELOPMENT_AGENT_PROVIDER: 'real-cursor' });
    expect(p).toBeInstanceOf(UnavailableCodingAgentProvider);
    await expect(p.createSession({})).rejects.toThrow(/unavailable/i);
  });

  it('disconnects mock when disconnected scenario selected', async () => {
    const p = createCodingAgentProvider({
      DEVELOPMENT_AGENT_PROVIDER: 'mock',
      DEVELOPMENT_AGENT_MOCK_SCENARIO: 'disconnected',
    });
    await expect(p.createSession({ id: 'dev-4' }, { branch: 'development/tasks/dev-4', worktree_id: '.worktrees/dev-4' })).rejects.toThrow(/unavailable/i);
  });

  it('rejects unsafe branch targets', async () => {
    const p = new MockCodingAgentProvider({ scenario: 'healthy' });
    await expect(p.createSession({ id: 'dev-5' }, { branch: 'master', worktree_id: '.worktrees/dev-5' })).rejects.toThrow(/unsafe agent branch/);
  });
});
