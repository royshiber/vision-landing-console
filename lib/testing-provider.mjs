import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

export const TEST_STATES = Object.freeze(['NOT_STARTED', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'CANCELLED']);
export const TEST_PROFILES = Object.freeze({
  CONSOLE_FULL: ['npm', ['test']],
  COMPANION_CONTRACT: ['npm', ['test', '--', 'tests/companion-proxy-api.test.mjs']],
  MAINTENANCE: ['npm', ['test', '--', 'tests/maintenance-release-ui.test.mjs']],
  DEVELOPMENT: ['npm', ['test', '--', 'tests/development-task-store.test.mjs', 'tests/development-tasks-api.test.mjs', 'tests/coding-agent-provider.test.mjs']],
});

function nowIso() {
  return new Date().toISOString();
}

function safeProfile(profile) {
  const key = String(profile || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(TEST_PROFILES, key)) throw new Error('invalid testing profile');
  return key;
}

function ensureLogDir(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
}

function boundedText(value, max = 16000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

const require = createRequire(import.meta.url);

function resolveCommand(baseCmd, args) {
  if (process.platform !== 'win32' || baseCmd !== 'npm') {
    return { cmd: baseCmd, args };
  }
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath && npmExecPath.toLowerCase().endsWith('npm-cli.js')) {
    return { cmd: process.execPath, args: [npmExecPath, ...args] };
  }
  const npmCli = require.resolve('npm/bin/npm-cli.js');
  return { cmd: process.execPath, args: [npmCli, ...args] };
}

export class TestingProvider {
  get providerName() {
    return 'abstract';
  }
  supportedProfiles() {
    return Object.keys(TEST_PROFILES);
  }
  async runApprovedSuite(_taskId, _ctx) {
    throw new Error('runApprovedSuite not implemented');
  }
  async getRun(_runId) {
    throw new Error('getRun not implemented');
  }
  async cancelRun(_runId) {
    throw new Error('cancelRun not implemented');
  }
}

export class MockTestingProvider extends TestingProvider {
  constructor(opts = {}) {
    super();
    this._scenario = String(opts.scenario || 'healthy').toLowerCase();
    this._runs = new Map();
  }
  get providerName() {
    return `mock:${this._scenario}`;
  }
  _checkAvailable() {
    if (this._scenario === 'disconnected') throw new Error('Testing provider unavailable');
  }
  async runApprovedSuite(taskId, ctx = {}) {
    this._checkAvailable();
    const profile = safeProfile(ctx.profile);
    const runId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const run = {
      run_id: runId,
      task_id: taskId,
      profile,
      state: 'RUNNING',
      started_at: nowIso(),
      ended_at: null,
      duration_ms: null,
      passed: null,
      failed: null,
      result: null,
      exit_status: null,
      log_ref: null,
      output_excerpt: null,
      _started_ms: Date.now(),
    };
    this._runs.set(runId, run);
    return run;
  }
  async getRun(runId) {
    this._checkAvailable();
    const run = this._runs.get(String(runId || ''));
    if (!run) throw new Error('test run not found');
    if (run.state === 'RUNNING' && Date.now() - run._started_ms > 900) {
      const failed = this._scenario === 'degraded';
      run.state = failed ? 'FAILED' : 'PASSED';
      run.ended_at = nowIso();
      run.duration_ms = Date.now() - run._started_ms;
      run.result = failed ? 'degraded mock failure' : 'mock success';
      run.passed = failed ? 0 : 1;
      run.failed = failed ? 1 : 0;
      run.exit_status = failed ? 1 : 0;
      run.output_excerpt = failed ? 'mock test failed' : 'mock test passed';
    }
    return { ...run };
  }
  async cancelRun(runId) {
    this._checkAvailable();
    const run = this._runs.get(String(runId || ''));
    if (!run) throw new Error('test run not found');
    run.state = 'CANCELLED';
    run.ended_at = nowIso();
    run.duration_ms = Date.now() - run._started_ms;
    run.result = 'cancelled';
    run.exit_status = null;
    run.output_excerpt = 'mock cancel requested';
    return { ...run };
  }
}

export class LocalTestingProvider extends TestingProvider {
  constructor(opts = {}) {
    super();
    this.repoRoot = path.resolve(opts.repoRoot || process.cwd());
    this.logDir = path.resolve(opts.logDir || path.join(this.repoRoot, 'var', 'development', 'test-logs'));
    ensureLogDir(this.logDir);
    this._runs = new Map();
  }
  get providerName() {
    return 'local';
  }
  async runApprovedSuite(taskId, ctx = {}) {
    const profile = safeProfile(ctx.profile);
    const worktreeAbsPath = path.resolve(String(ctx.worktreeAbsPath || ''));
    if (!worktreeAbsPath) throw new Error('worktree path required');
    const runId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const [baseCmd, args] = TEST_PROFILES[profile];
    const command = resolveCommand(baseCmd, args);
    const logRef = path.join('var', 'development', 'test-logs', `${runId}.log`).replaceAll('\\', '/');
    const logAbs = path.resolve(this.repoRoot, logRef);
    let output = '';
    const startedMs = Date.now();
    const child = spawn(command.cmd, command.args, { cwd: worktreeAbsPath, shell: false });
    child.stdout.on('data', (d) => { output += d.toString('utf8'); });
    child.stderr.on('data', (d) => { output += d.toString('utf8'); });
    const run = {
      run_id: runId,
      task_id: taskId,
      profile,
      state: 'RUNNING',
      started_at: nowIso(),
      ended_at: null,
      duration_ms: null,
      passed: null,
      failed: null,
      result: null,
      exit_status: null,
      log_ref: logRef,
      output_excerpt: null,
      _started_ms: startedMs,
      _child: child,
      _output_getter: () => output,
      _log_abs: logAbs,
    };
    this._runs.set(runId, run);
    child.on('close', (code) => {
      const done = this._runs.get(runId);
      if (!done) return;
      if (done.state === 'CANCELLED') return;
      done.ended_at = nowIso();
      done.duration_ms = Date.now() - done._started_ms;
      done.exit_status = code;
      done.state = code === 0 ? 'PASSED' : 'FAILED';
      done.result = code === 0 ? 'tests passed' : 'tests failed';
      done.passed = code === 0 ? 1 : 0;
      done.failed = code === 0 ? 0 : 1;
      done.output_excerpt = boundedText(done._output_getter());
      ensureLogDir(path.dirname(done._log_abs));
      fs.writeFileSync(done._log_abs, done.output_excerpt || '', 'utf8');
    });
    return { ...run, _child: undefined, _output_getter: undefined, _log_abs: undefined };
  }
  async getRun(runId) {
    const run = this._runs.get(String(runId || ''));
    if (!run) throw new Error('test run not found');
    return {
      ...run,
      _child: undefined,
      _output_getter: undefined,
      _log_abs: undefined,
    };
  }
  async cancelRun(runId) {
    const run = this._runs.get(String(runId || ''));
    if (!run) throw new Error('test run not found');
    if (run.state !== 'RUNNING') return this.getRun(runId);
    run._child.kill('SIGTERM');
    run.state = 'CANCELLED';
    run.ended_at = nowIso();
    run.duration_ms = Date.now() - run._started_ms;
    run.result = 'cancelled';
    run.exit_status = null;
    run.output_excerpt = boundedText(run._output_getter());
    ensureLogDir(path.dirname(run._log_abs));
    fs.writeFileSync(run._log_abs, run.output_excerpt || '', 'utf8');
    return this.getRun(runId);
  }
}

export function createTestingProvider(env = process.env, opts = {}) {
  const mode = String(env.DEVELOPMENT_TESTING_PROVIDER || 'local').trim().toLowerCase();
  if (mode === 'mock') {
    return new MockTestingProvider({ scenario: env.DEVELOPMENT_TESTING_MOCK_SCENARIO || 'healthy' });
  }
  if (mode === 'disconnected') {
    return new MockTestingProvider({ scenario: 'disconnected' });
  }
  return new LocalTestingProvider({ repoRoot: opts.repoRoot, logDir: opts.logDir });
}
