import path from 'path';
import { createDevelopmentTaskStore } from './development-task-store.mjs';
import { createCodingAgentProvider } from './coding-agent-provider.mjs';
import { createDevelopmentAgentService } from './development-agent-service.mjs';
import { createTestingProvider } from './testing-provider.mjs';
import { createDevelopmentWorktreeManager } from './development-worktree-manager.mjs';
import { createDevelopmentTestingService } from './development-testing-service.mjs';
import { wrapCodingAgentProvider } from './coding-agent-provider-handle.mjs';
import { mergeAgentEnv, readStoredConnection } from './coding-agent-connection.mjs';
import { resetCursorSdkProviderCache } from './cursor-sdk-coding-agent-provider.mjs';

export function snapshotAgentEnv(env = process.env) {
  return {
    DEVELOPMENT_AGENT_PROVIDER: env.DEVELOPMENT_AGENT_PROVIDER,
    DEVELOPMENT_AGENT_MOCK_SCENARIO: env.DEVELOPMENT_AGENT_MOCK_SCENARIO,
    CURSOR_API_KEY: env.CURSOR_API_KEY,
    CURSOR_AGENT_MODEL: env.CURSOR_AGENT_MODEL,
    CURSOR_WSL_DISTRO: env.CURSOR_WSL_DISTRO,
    VLC_CODING_AGENT_TEST_DOUBLE: env.VLC_CODING_AGENT_TEST_DOUBLE,
  };
}

function providerOpts(ctx, repoRoot) {
  return {
    repoRoot,
    cursorSupervisor: ctx.cursorSupervisor || null,
    cursorSdkAdapter: ctx.cursorSdkAdapter || null,
    wslRuntime: ctx.wslRuntime || null,
    wslDistro: ctx.wslDistro || '',
    platform: ctx.platform || process.platform,
    ...(ctx.codingAgentProviderOpts || {}),
  };
}

function resolveBaseEnv(ctx, runtime) {
  const base = ctx.agentEnv || snapshotAgentEnv(process.env);
  if (runtime?.ignoreEnvConnection) {
    return {
      ...base,
      DEVELOPMENT_AGENT_PROVIDER: '',
      CURSOR_API_KEY: '',
    };
  }
  return base;
}

function createProviderFromStore(ctx, repoRoot, stored, runtime) {
  const factory = ctx.codingAgentProviderFactory || createCodingAgentProvider;
  const merged = mergeAgentEnv(resolveBaseEnv(ctx, runtime), stored);
  return wrapCodingAgentProvider(factory(merged, providerOpts(ctx, repoRoot)));
}

/**
 * Shared store / provider / worktree / agent stack for Development APIs and Assist.
 * Assist confirm reuses this path; it does not invent a second agent stack.
 */
export function resolveDevelopmentRuntime(ctx = {}) {
  if (ctx.developmentRuntime) return ctx.developmentRuntime;
  const repoRoot = ctx.repoRoot || process.cwd();
  const store = ctx.developmentTaskStore || createDevelopmentTaskStore({
    filePath: ctx.developmentTaskStorePath || path.join(repoRoot, 'var', 'development', 'tasks.json'),
  });
  const runtime = {
    repoRoot,
    store,
    ignoreEnvConnection: false,
    provider: null,
    testingProvider: null,
    worktreeManager: null,
    agentService: null,
    testingService: null,
    rebuildProvider(nextStored) {
      resetCursorSdkProviderCache();
      const stored = runtime.ignoreEnvConnection
        ? { connected: false, apiKey: null }
        : (nextStored || readStoredConnection(ctx.db || null));
      const next = createProviderFromStore(ctx, repoRoot, stored, runtime);
      if (runtime.provider) runtime.provider.replace(next.inner);
      else runtime.provider = next;
      return runtime.provider;
    },
  };

  if (ctx.codingAgentProvider) {
    runtime.provider = wrapCodingAgentProvider(ctx.codingAgentProvider);
  } else {
    runtime.rebuildProvider(readStoredConnection(ctx.db || null));
  }

  runtime.testingProvider = ctx.testingProvider || createTestingProvider(process.env, { repoRoot });
  runtime.worktreeManager = ctx.worktreeManager || createDevelopmentWorktreeManager({ repoRoot });
  runtime.agentService = ctx.developmentAgentService || createDevelopmentAgentService({
    store,
    provider: runtime.provider,
    worktreeManager: runtime.worktreeManager,
  });
  runtime.testingService = ctx.developmentTestingService || createDevelopmentTestingService({
    store,
    worktreeManager: runtime.worktreeManager,
    testingProvider: runtime.testingProvider,
  });

  ctx.developmentRuntime = runtime;
  ctx.codingAgentProvider = runtime.provider;
  return runtime;
}

export function rebuildDevelopmentAgentProvider(ctx, stored) {
  const runtime = resolveDevelopmentRuntime(ctx);
  return runtime.rebuildProvider(stored);
}

export function agentEnvForStatus(ctx) {
  const runtime = ctx.developmentRuntime || null;
  return resolveBaseEnv(ctx, runtime);
}
