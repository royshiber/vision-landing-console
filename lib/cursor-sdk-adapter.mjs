/**
 * Thin adapter boundary for @cursor/sdk — injectable in tests.
 */
export function createCursorSdkAdapter(sdkModule) {
  const Agent = sdkModule?.Agent;
  if (!Agent) throw new Error('Cursor SDK Agent export missing');

  return {
    async createAgent(options) {
      return Agent.create(options);
    },
    async resumeAgent(agentId, options) {
      return Agent.resume(agentId, options);
    },
    async listRuns(agentId, options = {}) {
      return Agent.listRuns(agentId, options);
    },
    async getRun(runId, options) {
      return Agent.getRun(runId, options);
    },
  };
}

export async function loadDefaultCursorSdkAdapter() {
  const sdk = await import('@cursor/sdk');
  return createCursorSdkAdapter(sdk);
}

export function createMockCursorSdkAdapter(handlers = {}) {
  const agents = new Map();
  const runs = new Map();

  return {
    agents,
    runs,
    async createAgent(options) {
      if (handlers.createAgent) return handlers.createAgent(options, { agents, runs });
      const agentId = `agent-mock-${Date.now().toString(36)}`;
      const agent = {
        agentId,
        options,
        disposed: false,
        async send(prompt) {
          if (handlers.send) return handlers.send({ agentId, prompt, options }, { agents, runs });
          const runId = `run-mock-${Date.now().toString(36)}`;
          const run = createMockRun({ runId, agentId, prompt, handlers });
          runs.set(runId, run);
          return run;
        },
        async close() { agent.disposed = true; },
        [Symbol.asyncDispose]: async () => { agent.disposed = true; },
      };
      agents.set(agentId, agent);
      return agent;
    },
    async resumeAgent(agentId, options) {
      if (handlers.resumeAgent) return handlers.resumeAgent(agentId, options, { agents, runs });
      const agent = agents.get(agentId);
      if (!agent) throw new Error('Agent session not found');
      agent.options = { ...agent.options, ...options };
      return agent;
    },
    async listRuns(agentId) {
      if (handlers.listRuns) return handlers.listRuns(agentId, { agents, runs });
      const items = [...runs.values()].filter((r) => r.agentId === agentId);
      return { items, nextCursor: undefined };
    },
    async getRun(runId) {
      if (handlers.getRun) return handlers.getRun(runId, { agents, runs });
      const run = runs.get(runId);
      if (!run) throw new Error('Run not found');
      return run;
    },
  };
}

function createMockRun({ runId, agentId, prompt, handlers }) {
  let status = 'running';
  let resultText = '';
  const events = [
    { type: 'assistant', message: { content: [{ type: 'text', text: `Working on: ${String(prompt).slice(0, 80)}` }] } },
  ];

  const run = {
    id: runId,
    agentId,
    status,
    supports(op) {
      return ['stream', 'wait', 'cancel', 'conversation'].includes(op);
    },
    async *stream() {
      if (handlers.stream) {
        yield* handlers.stream({ runId, agentId, prompt });
        return;
      }
      for (const ev of events) yield ev;
    },
    async wait() {
      if (handlers.wait) return handlers.wait({ runId, agentId, prompt });
      if (status === 'cancelled') {
        return { id: runId, status: 'cancelled', result: '', error: null };
      }
      status = handlers.failRun ? 'error' : 'finished';
      run.status = status;
      resultText = handlers.failRun ? '' : 'Mock agent completed task';
      return {
        id: runId,
        status,
        result: resultText,
        error: handlers.failRun ? 'mock failure' : null,
      };
    },
    async cancel() {
      status = 'cancelled';
      run.status = status;
    },
  };
  return run;
}
