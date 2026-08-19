import {
  createDevelopmentTaskStore,
  DEV_TASK_STATUSES,
  DEV_TASK_PRIORITIES,
  DEV_TASK_TARGET_AREAS,
} from '../development-task-store.mjs';
import { logger } from '../logger.mjs';
import { createCodingAgentProvider } from '../coding-agent-provider.mjs';
import { createDevelopmentAgentService } from '../development-agent-service.mjs';
import { createTestingProvider } from '../testing-provider.mjs';
import { createDevelopmentWorktreeManager } from '../development-worktree-manager.mjs';
import { createDevelopmentTestingService } from '../development-testing-service.mjs';
import { createDevelopmentReleaseBuilder } from '../development-release-builder.mjs';
import { createDevelopmentReleaseService } from '../development-release-service.mjs';

export function registerDevelopmentTasksApi(app, ctx = {}) {
  const store = createDevelopmentTaskStore({ filePath: ctx.developmentTaskStorePath });
  const provider = ctx.codingAgentProvider || createCodingAgentProvider();
  const testingProvider = ctx.testingProvider || createTestingProvider(process.env, { repoRoot: process.cwd() });
  const worktreeManager = ctx.worktreeManager || createDevelopmentWorktreeManager({ repoRoot: process.cwd() });
  const releaseBuilder = ctx.releaseBuilder || createDevelopmentReleaseBuilder({ repoRoot: process.cwd() });
  const agentService = createDevelopmentAgentService({ store, provider, testingProvider, worktreeManager });
  const testingService = createDevelopmentTestingService({ store, worktreeManager, testingProvider });
  const deployRelease = ctx.deployRelease || (async (releaseId) => {
    const client = ctx.companionService?.client || ctx.companionClient || null;
    if (!client?.postMaintenanceDeploy) throw new Error('deploy unavailable');
    return client.postMaintenanceDeploy({ release_id: releaseId });
  });
  const releaseService = createDevelopmentReleaseService({ store, worktreeManager, releaseBuilder, deployRelease });

  app.get('/api/development/tasks/meta', (_req, res) => {
    res.json({
      ok: true,
      statuses: DEV_TASK_STATUSES,
      priorities: DEV_TASK_PRIORITIES,
      targetAreas: DEV_TASK_TARGET_AREAS,
      localStore: 'var/development/tasks.json',
      agentProvider: provider.providerName,
      agentAvailable: provider.providerName !== 'unavailable' && !provider.providerName.startsWith('unavailable'),
      testingProvider: testingProvider.providerName,
      testProfiles: testingProvider.supportedProfiles(),
    });
  });

  app.get('/api/development/tasks', (req, res) => {
    try {
      const tasks = store.list({
        status: req.query?.status,
        target: req.query?.target,
        open: req.query?.open,
        sort: req.query?.sort,
      });
      res.json({ ok: true, tasks });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('malformed task store')) {
        return res.status(500).json({ ok: false, message: msg });
      }
      logger.error({ err }, 'GET /api/development/tasks failed');
      res.status(500).json({ ok: false, message: msg || 'cannot list development tasks' });
    }
  });

  app.post('/api/development/tasks', (req, res) => {
    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const task = store.create({
        id: payload.id,
        title: payload.title,
        description: payload.description,
        target_area: payload.target_area,
        priority: payload.priority,
        notes: payload.notes,
      });
      res.status(201).json({ ok: true, task });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('duplicate task id')) {
        return res.status(409).json({ ok: false, message: 'duplicate task id' });
      }
      if (msg.includes('required') || msg.includes('invalid')) {
        return res.status(400).json({ ok: false, message: msg });
      }
      logger.error({ err }, 'POST /api/development/tasks failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot create development task' });
    }
  });

  app.get('/api/development/tasks/:id', (req, res) => {
    try {
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      return res.json({ ok: true, task });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('malformed task store')) {
        return res.status(500).json({ ok: false, message: msg });
      }
      logger.error({ err }, 'GET /api/development/tasks/:id failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot read task' });
    }
  });

  app.patch('/api/development/tasks/:id', (req, res) => {
    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const task = store.patch(req.params.id, payload);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      return res.json({ ok: true, task });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('malformed task store')) {
        return res.status(500).json({ ok: false, message: msg });
      }
      if (msg.includes('invalid status transition')) {
        return res.status(409).json({ ok: false, message: msg });
      }
      if (msg.includes('field not allowed') || msg.includes('invalid') || msg.includes('required')) {
        return res.status(400).json({ ok: false, message: msg });
      }
      logger.error({ err }, 'PATCH /api/development/tasks/:id failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot update task' });
    }
  });

  app.post('/api/development/tasks/:id/agent/start', async (req, res) => {
    try {
      const confirm = req.body?.confirm === true;
      if (!confirm) {
        return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      }
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const started = await agentService.startTaskAgent(task.id);
      return res.json({
        ok: true,
        task: started,
        agent: started.agent,
        warning: 'Agent modifies code in isolated development branch/worktree only',
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: 'Development agent unavailable' });
      if (msg.includes('worktree required')) return res.status(409).json({ ok: false, message: msg });
      if (msg.includes('unsafe agent branch')) return res.status(400).json({ ok: false, message: msg });
      if (msg.includes('active') || msg.includes('allow')) return res.status(409).json({ ok: false, message: msg });
      if (msg.includes('not found')) return res.status(404).json({ ok: false, message: msg });
      logger.error({ err }, 'POST /api/development/tasks/:id/agent/start failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot start agent' });
    }
  });

  app.get('/api/development/tasks/:id/agent', async (req, res) => {
    try {
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const agent = await agentService.getTaskAgent(task.id);
      const updatedTask = store.getById(task.id);
      return res.json({ ok: true, agent, task: updatedTask });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: 'Development agent unavailable' });
      logger.error({ err }, 'GET /api/development/tasks/:id/agent failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot get agent state' });
    }
  });

  app.post('/api/development/tasks/:id/agent/cancel', async (req, res) => {
    try {
      const confirm = req.body?.confirm === true;
      if (!confirm) {
        return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      }
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const agent = await agentService.cancelTaskAgent(task.id);
      if (agent?.not_supported) {
        return res.status(409).json({ ok: false, code: 'NOT_SUPPORTED', message: 'provider cancellation not supported' });
      }
      const updatedTask = store.getById(task.id);
      return res.json({ ok: true, agent, task: updatedTask });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: 'Development agent unavailable' });
      if (msg.includes('not started')) return res.status(409).json({ ok: false, message: msg });
      logger.error({ err }, 'POST /api/development/tasks/:id/agent/cancel failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot cancel agent' });
    }
  });

  app.post('/api/development/tasks/:id/worktree/create', (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const updated = testingService.createWorktree(task.id);
      return res.json({ ok: true, task: updated, worktree: updated.worktree_meta });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('already exists')) return res.status(409).json({ ok: false, message: msg });
      if (msg.includes('invalid task id') || msg.includes('unsafe') || msg.includes('escape')) {
        return res.status(400).json({ ok: false, message: msg });
      }
      logger.error({ err }, 'POST /api/development/tasks/:id/worktree/create failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot create worktree' });
    }
  });

  app.get('/api/development/tasks/:id/worktree', (req, res) => {
    try {
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const meta = testingService.getWorktreeStatus(task.id);
      const updated = store.getById(task.id);
      return res.json({ ok: true, worktree: meta, task: updated });
    } catch (err) {
      const msg = String(err?.message || '');
      logger.error({ err }, 'GET /api/development/tasks/:id/worktree failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot inspect worktree' });
    }
  });

  app.post('/api/development/tasks/:id/worktree/remove', (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const removed = testingService.removeWorktree(task.id);
      const updated = store.getById(task.id);
      return res.json({ ok: true, removed, task: updated });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('dirty')) return res.status(409).json({ ok: false, message: msg });
      logger.error({ err }, 'POST /api/development/tasks/:id/worktree/remove failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot remove worktree' });
    }
  });

  app.post('/api/development/tasks/:id/tests/run', async (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const profile = req.body?.profile;
      const run = await testingService.runTests(task.id, profile);
      const updated = store.getById(task.id);
      return res.json({ ok: true, run, task: updated });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('invalid testing profile') || msg.includes('worktree required')) return res.status(400).json({ ok: false, message: msg });
      if (msg.includes('agent must succeed')) return res.status(409).json({ ok: false, message: msg });
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: 'Testing provider unavailable' });
      logger.error({ err }, 'POST /api/development/tasks/:id/tests/run failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot run tests' });
    }
  });

  app.get('/api/development/tasks/:id/tests', async (req, res) => {
    try {
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const tests = await testingService.getTests(task.id);
      const updated = store.getById(task.id);
      return res.json({ ok: true, tests, task: updated });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: 'Testing provider unavailable' });
      logger.error({ err }, 'GET /api/development/tasks/:id/tests failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot get tests state' });
    }
  });

  app.post('/api/development/tasks/:id/tests/cancel', async (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = store.getById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, message: 'task not found' });
      const tests = await testingService.cancelTests(task.id);
      const updated = store.getById(task.id);
      return res.json({ ok: true, tests, task: updated });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('not started')) return res.status(409).json({ ok: false, message: msg });
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: 'Testing provider unavailable' });
      logger.error({ err }, 'POST /api/development/tasks/:id/tests/cancel failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot cancel tests' });
    }
  });

  app.post('/api/development/tasks/:id/release/approve', (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = releaseService.approveForRelease(req.params.id);
      return res.json({ ok: true, task });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('not found')) return res.status(404).json({ ok: false, message: msg });
      if (msg.includes('must be') || msg.includes('passed') || msg.includes('missing') || msg.includes('waiting')) {
        return res.status(409).json({ ok: false, message: msg });
      }
      logger.error({ err }, 'POST /api/development/tasks/:id/release/approve failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot approve release' });
    }
  });

  app.post('/api/development/tasks/:id/release/create', (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = releaseService.createRelease(req.params.id);
      return res.json({ ok: true, task, release: task.release });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('dirty') || msg.includes('unsafe') || msg.includes('not passed') || msg.includes('not ready')) {
        return res.status(409).json({ ok: false, message: msg });
      }
      if (msg.includes('missing')) return res.status(400).json({ ok: false, message: msg });
      logger.error({ err }, 'POST /api/development/tasks/:id/release/create failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot create release' });
    }
  });

  app.post('/api/development/tasks/:id/release/deploy', async (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ ok: false, message: 'explicit confirmation required' });
      const task = await releaseService.deployReleaseForTask(req.params.id);
      return res.json({ ok: true, task, deployment: task.deployment, release: task.release });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('not found')) return res.status(404).json({ ok: false, message: msg });
      if (msg.includes('not READY') || msg.includes('no release_id')) return res.status(409).json({ ok: false, message: msg });
      if (msg.includes('unavailable')) return res.status(503).json({ ok: false, message: msg });
      logger.error({ err }, 'POST /api/development/tasks/:id/release/deploy failed');
      return res.status(500).json({ ok: false, message: msg || 'cannot deploy release' });
    }
  });
}
