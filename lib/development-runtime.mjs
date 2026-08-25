import path from 'path';
import { createDevelopmentTaskStore } from './development-task-store.mjs';
import { createCodingAgentProvider } from './coding-agent-provider.mjs';
import { createDevelopmentAgentService } from './development-agent-service.mjs';
import { createTestingProvider } from './testing-provider.mjs';
import { createDevelopmentWorktreeManager } from './development-worktree-manager.mjs';
import { createDevelopmentTestingService } from './development-testing-service.mjs';

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
  const provider = ctx.codingAgentProvider || createCodingAgentProvider(process.env, { repoRoot });
  const testingProvider = ctx.testingProvider || createTestingProvider(process.env, { repoRoot });
  const worktreeManager = ctx.worktreeManager || createDevelopmentWorktreeManager({ repoRoot });
  const agentService = ctx.developmentAgentService || createDevelopmentAgentService({
    store,
    provider,
    worktreeManager,
  });
  const testingService = ctx.developmentTestingService || createDevelopmentTestingService({
    store,
    worktreeManager,
    testingProvider,
  });
  const runtime = {
    repoRoot,
    store,
    provider,
    testingProvider,
    worktreeManager,
    agentService,
    testingService,
  };
  ctx.developmentRuntime = runtime;
  return runtime;
}
