import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, getConfig } from '../lib/db.mjs';
import { registerAssistApi } from '../lib/routes/assist-api.mjs';
import { MockCodingAgentProvider, UnavailableCodingAgentProvider, createCodingAgentProvider } from '../lib/coding-agent-provider.mjs';
import {
  CODING_AGENT_CONNECTION_KEY,
  maskConnectionKey,
  mergeAgentEnv,
  payloadContainsSecret,
  readStoredConnection,
  validateConnectionKey,
} from '../lib/coding-agent-connection.mjs';
import { logger } from '../lib/logger.mjs';
import { ASSIST_HE } from '../lib/assist/assist-hebrew.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function memoryWorktreeManager() {
  const byId = new Map();
  function paths(taskId) {
    const slug = String(taskId || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'task';
    return { branch: `development/tasks/${slug}`, worktree_id: `.worktrees/${slug}` };
  }
  return {
    create(taskId) {
      const id = String(taskId);
      if (byId.has(id)) throw new Error('worktree already exists');
      const p = paths(id);
      const meta = {
        exists: true,
        ...p,
        clean: true,
        changed_files: 0,
        base_commit: 'abc123',
        created_at: new Date().toISOString(),
      };
      byId.set(id, meta);
      return meta;
    },
    status(taskId) {
      const id = String(taskId);
      const p = paths(id);
      return byId.get(id) || { exists: false, ...p, clean: null, changed_files: 0, base_commit: null };
    },
    remove(taskId) {
      const id = String(taskId);
      const p = paths(id);
      return { removed: byId.delete(id), ...p };
    },
  };
}

function testProviderFactory(env) {
  const key = String(env.CURSOR_API_KEY || '').trim();
  const requested = String(env.DEVELOPMENT_AGENT_PROVIDER || '').trim().toLowerCase();
  if (requested === 'cursor-sdk' && key) {
    return new MockCodingAgentProvider({ scenario: 'healthy' });
  }
  if (requested === 'mock') {
    return new MockCodingAgentProvider({ scenario: env.DEVELOPMENT_AGENT_MOCK_SCENARIO || 'healthy' });
  }
  return createCodingAgentProvider(env);
}

async function confirmDevelopment(base) {
  const msg = await fetch(`${base}/api/assist/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Add a tab for landing confidence.',
      context: { current_tab: 'development' },
    }),
  }).then((r) => r.json());
  const conf = await fetch(`${base}/api/assist/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposal_id: msg.response.action_proposal.id,
      confirm: true,
    }),
  }).then((r) => r.json());
  return { msg, conf };
}

describe('coding-agent connection helpers', () => {
  it('masks keys and never returns the raw secret', () => {
    const key = 'connect-secret-key-1234';
    const hint = maskConnectionKey(key);
    expect(hint).toBe('••••1234');
    expect(hint).not.toBe(key);
    expect(maskConnectionKey('abcd')).toBe('••••');
    expect(maskConnectionKey('')).toBe(null);
  });

  it('rejects empty and short keys in Hebrew', () => {
    expect(validateConnectionKey('').status_he).toBe(ASSIST_HE.agentKeyEmpty);
    expect(validateConnectionKey('   ').error).toBe('key_empty');
    expect(validateConnectionKey('short').error).toBe('key_invalid');
    expect(validateConnectionKey('short').status_he).toBe(ASSIST_HE.agentKeyInvalid);
    expect(validateConnectionKey('long-enough-key').ok).toBe(true);
  });

  it('prefers a stored key over env and falls back to env when store is empty', () => {
    const env = {
      DEVELOPMENT_AGENT_PROVIDER: 'cursor-sdk',
      CURSOR_API_KEY: 'env-fallback-key-9999',
    };
    const fromStore = mergeAgentEnv(env, { connected: true, apiKey: 'stored-connect-key-1111' });
    expect(fromStore.CURSOR_API_KEY).toBe('stored-connect-key-1111');
    expect(fromStore.DEVELOPMENT_AGENT_PROVIDER).toBe('cursor-sdk');
    const fromEnv = mergeAgentEnv(env, { connected: false, apiKey: null });
    expect(fromEnv.CURSOR_API_KEY).toBe('env-fallback-key-9999');
  });
});

describe('Assist in-product agent connect', () => {
  const SECRET = 'assist-connect-secret-9f3a2c1b';
  let server;
  let base;
  let root;
  let db;
  let dbPath;
  let logChunks;

  async function start(extra = {}) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-connect-'));
    dbPath = path.join(root, 'app.sqlite');
    db = openDatabase(dbPath);
    const app = express();
    app.use(express.json());
    registerAssistApi(app, {
      repoRoot: root,
      db,
      developmentTaskStorePath: path.join(root, 'tasks.json'),
      worktreeManager: memoryWorktreeManager(),
      agentEnv: extra.agentEnv || {},
      codingAgentProviderFactory: extra.factory || testProviderFactory,
      codingAgentProvider: extra.codingAgentProvider,
    });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  }

  async function restartFromDb(extra = {}) {
    await new Promise((r) => server.close(r));
    server = null;
    const app = express();
    app.use(express.json());
    registerAssistApi(app, {
      repoRoot: root,
      db,
      developmentTaskStorePath: path.join(root, 'tasks.json'),
      worktreeManager: memoryWorktreeManager(),
      agentEnv: extra.agentEnv || {},
      codingAgentProviderFactory: extra.factory || testProviderFactory,
    });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  }

  beforeEach(() => {
    logChunks = [];
    const origInfo = logger.info.bind(logger);
    const origError = logger.error.bind(logger);
    logger.info = (...args) => {
      logChunks.push(JSON.stringify(args));
      return origInfo(...args);
    };
    logger.error = (...args) => {
      logChunks.push(JSON.stringify(args));
      return origError(...args);
    };
    logger.__restore = () => {
      logger.info = origInfo;
      logger.error = origError;
    };
  });

  afterEach(async () => {
    logger.__restore?.();
    if (server) await new Promise((r) => server.close(r));
    server = null;
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('persists connect, hydrates READY, and never echoes the raw key', async () => {
    await start();
    const before = await fetch(`${base}/api/assist/agent`).then((r) => r.json());
    expect(before.runtime).toBe('UNAVAILABLE');
    expect(before.connect_available).toBe(true);
    expect(JSON.stringify(before)).not.toContain(SECRET);

    const connected = await fetch(`${base}/api/assist/agent/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    }).then((r) => r.json());
    expect(connected.ok).toBe(true);
    expect(connected.runtime).toBe('READY');
    expect(connected.connected).toBe(true);
    expect(connected.status_he).toMatch(/מחובר/);
    expect(connected.key_hint).toBe(maskConnectionKey(SECRET));
    expect(JSON.stringify(connected)).not.toContain(SECRET);
    expect(connected.live_applied).toBe(true);

    const stored = getConfig(db, CODING_AGENT_CONNECTION_KEY);
    expect(stored.apiKey).toBe(SECRET);

    const after = await fetch(`${base}/api/assist/agent`).then((r) => r.json());
    expect(after.runtime).toBe('READY');
    expect(JSON.stringify(after)).not.toContain(SECRET);

    await restartFromDb();
    const hydrated = await fetch(`${base}/api/assist/agent`).then((r) => r.json());
    expect(hydrated.runtime).toBe('READY');
    expect(hydrated.key_hint).toBe('••••2c1b');
    expect(JSON.stringify(hydrated)).not.toContain(SECRET);
    expect(logChunks.join('\n')).not.toContain(SECRET);
  });

  it('keeps Assist confirm honest before connect and starts the agent after connect', async () => {
    await start();
    const before = await confirmDevelopment(base);
    expect(before.conf.ok).toBe(true);
    expect(before.conf.result.agent_started).toBe(false);
    expect(before.conf.result.agent_runtime).toBe('UNAVAILABLE');
    expect(before.conf.result.connect_available).toBe(true);
    expect(before.conf.answer).toMatch(/לא הופעל סוכן/);
    expect(JSON.stringify(before.conf)).not.toContain(SECRET);

    const connected = await fetch(`${base}/api/assist/agent/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    }).then((r) => r.json());
    expect(connected.runtime).toBe('READY');

    const after = await confirmDevelopment(base);
    expect(after.conf.result.agent_started).toBe(true);
    expect(after.conf.result.agent_runtime).toBe('READY');
    expect(after.conf.result.worktree.branch.startsWith('development/tasks/')).toBe(true);
    expect(JSON.stringify(after.conf)).not.toContain(SECRET);
  });

  it('disconnects to UNAVAILABLE without pretending the agent is running', async () => {
    await start();
    await fetch(`${base}/api/assist/agent/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    });
    const disconnected = await fetch(`${base}/api/assist/agent/disconnect`, {
      method: 'POST',
    }).then((r) => r.json());
    expect(disconnected.runtime).toBe('UNAVAILABLE');
    expect(disconnected.connected).toBe(false);
    expect(disconnected.status_he).toMatch(/מנותק/);
    expect(disconnected.key_hint).toBe(null);
    expect(JSON.stringify(disconnected)).not.toContain(SECRET);
    expect(readStoredConnection(db).apiKey).toBe(null);

    const conf = (await confirmDevelopment(base)).conf;
    expect(conf.result.agent_started).toBe(false);
    expect(conf.result.agent_runtime).toBe('UNAVAILABLE');
  });

  it('uses env fallback when no stored key is present', async () => {
    await start({
      agentEnv: {
        DEVELOPMENT_AGENT_PROVIDER: 'cursor-sdk',
        CURSOR_API_KEY: SECRET,
      },
    });
    const status = await fetch(`${base}/api/assist/agent`).then((r) => r.json());
    expect(status.runtime).toBe('READY');
    expect(status.key_hint).toBe(maskConnectionKey(SECRET));
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const conf = (await confirmDevelopment(base)).conf;
    expect(conf.result.agent_started).toBe(true);
  });

  it('rejects empty and invalid keys without becoming READY', async () => {
    await start();
    const empty = await fetch(`${base}/api/assist/agent/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: '' }),
    });
    const emptyBody = await empty.json();
    expect(empty.status).toBe(400);
    expect(emptyBody.runtime).toBe('UNAVAILABLE');
    expect(emptyBody.status_he).toBe(ASSIST_HE.agentKeyEmpty);

    const invalid = await fetch(`${base}/api/assist/agent/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'abc' }),
    });
    const invalidBody = await invalid.json();
    expect(invalid.status).toBe(400);
    expect(invalidBody.status_he).toBe(ASSIST_HE.agentKeyInvalid);
    const status = await fetch(`${base}/api/assist/agent`).then((r) => r.json());
    expect(status.runtime).toBe('UNAVAILABLE');
  });

  it('does not leak the key in JSON logs', async () => {
    await start();
    await fetch(`${base}/api/assist/agent/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    });
    expect(payloadContainsSecret(logChunks.join('\n'), [SECRET])).toBe(false);
    expect(logChunks.join('\n')).not.toMatch(/CURSOR_API_KEY\s*=/);
  });
});

describe('Assist connect chrome', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('puts a Hebrew connect control on the Assist rail', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
    expect(html).toMatch(/id="assistAgentConnect"/);
    expect(html).toMatch(/id="assistAgentKey"[^>]*type="password"/);
    expect(html).toMatch(/id="assistAgentConnectBtn"[^>]*>חיבור</);
    expect(html).toMatch(/id="assistAgentDisconnectBtn"[^>]*>ניתוק</);
    expect(html).toMatch(/מפתח חיבור/);
    expect(html).toMatch(/id="assistMessagesEmpty"[^>]*>אין הודעות עדיין\.</);
    expect(html).toMatch(/id="assistProposalWarn"/);
    expect(html).toMatch(/חברו מפתח לפני אישור/);
    expect(html).not.toMatch(/CURSOR_API_KEY/);
    expect(html).not.toMatch(/DEVELOPMENT_AGENT_PROVIDER/);
  });

  it('keeps Assist send / chip / run-state copy in Hebrew', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    expect(js).toContain("data.message || 'שליחת ההודעה נכשלה.'");
    expect(js).not.toContain('ASSIST request failed');
    expect(js).toContain("MISSION: 'משימה'");
    expect(js).toContain("terrain: 'הטסה'");
    expect(js).toContain("NOT_STARTED: 'לא הופעל'");
    expect(js).toContain('assistSyncProposalWarn');
    expect(js).toContain('assistSyncMessagesEmpty');
  });
});

describe('Unavailable inject still reports Hebrew connect affordance', () => {
  let server;
  let base;
  let root;

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes connect_available when confirm cannot start the agent', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-assist-unavail-'));
    const app = express();
    app.use(express.json());
    registerAssistApi(app, {
      repoRoot: root,
      developmentTaskStorePath: path.join(root, 'tasks.json'),
      worktreeManager: memoryWorktreeManager(),
      codingAgentProvider: new UnavailableCodingAgentProvider({ reason: 'CURSOR_API_KEY is not configured' }),
      agentEnv: {},
    });
    server = await listen(app);
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
    const conf = (await confirmDevelopment(base)).conf;
    expect(conf.result.agent_started).toBe(false);
    expect(conf.result.connect_available).toBe(true);
    expect(conf.result.agent_unavailable_reason).toMatch(/מפתח החיבור לסוכן לא הוגדר/);
  });
});
