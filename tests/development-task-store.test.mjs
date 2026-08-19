import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createDevelopmentTaskStore,
  canTransitionStatus,
} from '../lib/development-task-store.mjs';

function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-devtasks-'));
  const filePath = path.join(root, 'tasks.json');
  return { root, filePath, store: createDevelopmentTaskStore({ filePath }) };
}

describe('development-task-store', () => {
  let ctx;
  beforeEach(() => {
    ctx = mkStore();
  });

  it('creates and retrieves a task', () => {
    const created = ctx.store.create({
      title: 'Improve landing card',
      description: 'Adjust layout for better readability',
      target_area: 'UI',
      priority: 'HIGH',
    });
    const got = ctx.store.getById(created.id);
    expect(got).toBeTruthy();
    expect(got.status).toBe('DRAFT');
    expect(got.audit.length).toBeGreaterThan(0);
  });

  it('lists tasks with filters and sorting', () => {
    const t1 = ctx.store.create({ title: 'A', description: 'A desc', target_area: 'UI', priority: 'LOW' });
    const t2 = ctx.store.create({ title: 'B', description: 'B desc', target_area: 'API', priority: 'CRITICAL' });
    ctx.store.patch(t2.id, { status: 'QUEUED' });
    const byStatus = ctx.store.list({ status: 'QUEUED' });
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0].id).toBe(t2.id);
    const byTarget = ctx.store.list({ target: 'UI' });
    expect(byTarget).toHaveLength(1);
    expect(byTarget[0].id).toBe(t1.id);
    const asc = ctx.store.list({ sort: 'updated_asc' });
    expect(asc[0].id).toBe(t1.id);
  });

  it('validates status transitions and rejects invalid jumps', () => {
    const t = ctx.store.create({ title: 'Flow', description: 'Flow desc', target_area: 'API', priority: 'NORMAL' });
    ctx.store.patch(t.id, { status: 'QUEUED' });
    ctx.store.patch(t.id, { status: 'IN_PROGRESS' });
    expect(() => ctx.store.patch(t.id, { status: 'DEPLOYED' })).toThrow(/invalid status transition/);
  });

  it('creates audit history for status and priority changes', () => {
    const t = ctx.store.create({ title: 'Audit', description: 'Audit desc', target_area: 'OTHER', priority: 'NORMAL' });
    ctx.store.patch(t.id, { priority: 'HIGH' });
    ctx.store.patch(t.id, { status: 'QUEUED' });
    const got = ctx.store.getById(t.id);
    const actions = got.audit.map((a) => a.action);
    expect(actions).toContain('priority_changed');
    expect(actions).toContain('status_changed');
  });

  it('rejects duplicate task id', () => {
    ctx.store.create({ id: 'dev-fixed-1', title: 'One', description: 'x', target_area: 'UI', priority: 'LOW' });
    expect(() => ctx.store.create({ id: 'dev-fixed-1', title: 'Two', description: 'y', target_area: 'API', priority: 'HIGH' }))
      .toThrow(/duplicate task id/);
  });

  it('persists to disk and can be read by new instance', () => {
    const created = ctx.store.create({
      title: 'Persist',
      description: 'persist check',
      target_area: 'MAINTENANCE',
      priority: 'NORMAL',
    });
    const second = createDevelopmentTaskStore({ filePath: ctx.filePath });
    const got = second.getById(created.id);
    expect(got?.title).toBe('Persist');
  });

  it('rejects malformed task store data', () => {
    fs.mkdirSync(path.dirname(ctx.filePath), { recursive: true });
    fs.writeFileSync(ctx.filePath, '{"tasks":"bad"}', 'utf8');
    expect(() => ctx.store.list({})).toThrow(/malformed task store schema/);
  });

  it('recovers from malformed schema using backup snapshot', () => {
    const created = ctx.store.create({
      id: 'dev-recover-1',
      title: 'Recover',
      description: 'Recover path',
      target_area: 'API',
      priority: 'NORMAL',
    });
    const valid = fs.readFileSync(ctx.filePath, 'utf8');
    fs.writeFileSync(`${ctx.filePath}.bak`, valid, 'utf8');
    fs.writeFileSync(ctx.filePath, '{"tasks":"broken"}', 'utf8');
    const tasks = ctx.store.list({});
    expect(tasks.some((t) => t.id === created.id)).toBe(true);
    const repairedRaw = fs.readFileSync(ctx.filePath, 'utf8');
    expect(JSON.parse(repairedRaw).tasks.length).toBeGreaterThan(0);
  });

  it('preserves existing file when write fails mid-commit', () => {
    ctx.store.create({
      id: 'dev-stable-1',
      title: 'Stable',
      description: 'Stable path',
      target_area: 'UI',
      priority: 'LOW',
    });
    const before = fs.readFileSync(ctx.filePath, 'utf8');
    const realRename = fs.renameSync;
    let injected = false;
    fs.renameSync = (...args) => {
      if (!injected && String(args[0]).endsWith('.tmp')) {
        injected = true;
        throw new Error('simulated rename failure');
      }
      return realRename(...args);
    };
    try {
      expect(() => ctx.store.create({
        id: 'dev-stable-2',
        title: 'Fails once',
        description: 'Expected failure',
        target_area: 'API',
        priority: 'NORMAL',
      })).toThrow(/simulated rename failure/);
    } finally {
      fs.renameSync = realRename;
    }
    const after = fs.readFileSync(ctx.filePath, 'utf8');
    expect(after).toBe(before);
    expect(ctx.store.getById('dev-stable-1')).toBeTruthy();
    expect(ctx.store.getById('dev-stable-2')).toBeNull();
  });

  it('keeps state coherent across sequential updates from separate instances', () => {
    const first = createDevelopmentTaskStore({ filePath: ctx.filePath });
    const second = createDevelopmentTaskStore({ filePath: ctx.filePath });
    const task = first.create({
      id: 'dev-concurrency-1',
      title: 'Concurrent',
      description: 'Concurrent edits',
      target_area: 'OTHER',
      priority: 'NORMAL',
    });
    first.patch(task.id, { status: 'QUEUED' });
    second.patch(task.id, { status: 'IN_PROGRESS', priority: 'HIGH' });
    const finalTask = first.getById(task.id);
    expect(finalTask.status).toBe('IN_PROGRESS');
    expect(finalTask.priority).toBe('HIGH');
  });

  it('exposes transition helper', () => {
    expect(canTransitionStatus('DRAFT', 'QUEUED')).toBe(true);
    expect(canTransitionStatus('DRAFT', 'DEPLOYED')).toBe(false);
  });

  it('recovers from empty store file', () => {
    fs.mkdirSync(path.dirname(ctx.filePath), { recursive: true });
    fs.writeFileSync(ctx.filePath, '', 'utf8');
    expect(ctx.store.list({})).toEqual([]);
  });

  it('recovers from whitespace-only store file', () => {
    fs.mkdirSync(path.dirname(ctx.filePath), { recursive: true });
    fs.writeFileSync(ctx.filePath, '   \n  ', 'utf8');
    expect(ctx.store.list({})).toEqual([]);
  });

  it('recovers from malformed JSON using backup', () => {
    const t = ctx.store.create({ id: 'dev-bak-1', title: 'Bak', description: 'Bak', target_area: 'UI', priority: 'NORMAL' });
    const valid = fs.readFileSync(ctx.filePath, 'utf8');
    fs.writeFileSync(`${ctx.filePath}.bak`, valid, 'utf8');
    fs.writeFileSync(ctx.filePath, '{corrupt', 'utf8');
    const tasks = ctx.store.list({});
    expect(tasks.some((x) => x.id === t.id)).toBe(true);
  });

  it('throws when both store and backup are corrupt', () => {
    fs.mkdirSync(path.dirname(ctx.filePath), { recursive: true });
    fs.writeFileSync(ctx.filePath, '{bad', 'utf8');
    fs.writeFileSync(`${ctx.filePath}.bak`, '{also bad', 'utf8');
    expect(() => ctx.store.list({})).toThrow(/malformed/);
  });

  it('sanitizes malicious strings in task fields without executing them', () => {
    const t = ctx.store.create({
      title: 'rm -rf / && echo PWNED',
      description: '$(calc) `id` ; DROP TABLE tasks;',
      target_area: 'API',
      priority: 'NORMAL',
      notes: '<script>alert(1)</script>',
    });
    expect(t.title).toBe('rm -rf / && echo PWNED');
    expect(t.description).toBe('$(calc) `id` ; DROP TABLE tasks;');
    expect(t.notes).toBe('<script>alert(1)</script>');
    expect(typeof t.id).toBe('string');
    expect(t.id.startsWith('dev-')).toBe(true);
  });

  it('task input fields do not influence store file path', () => {
    const t = ctx.store.create({
      id: 'dev-../../etc/passwd',
      title: 'Path escape',
      description: '/tmp/../../../etc/shadow',
      target_area: 'API',
      priority: 'NORMAL',
    });
    expect(t.id).toBe('dev-../../etc/passwd');
    const raw = JSON.parse(fs.readFileSync(ctx.filePath, 'utf8'));
    expect(raw.tasks.length).toBe(1);
    expect(raw.tasks[0].id).toBe('dev-../../etc/passwd');
    const dir = path.dirname(ctx.filePath);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.includes('passwd'))).toBe(false);
  });

  it('handles two sequential rapid updates from separate store instances', () => {
    const a = createDevelopmentTaskStore({ filePath: ctx.filePath });
    const b = createDevelopmentTaskStore({ filePath: ctx.filePath });
    a.create({ id: 'dev-seq-1', title: 'S1', description: 'S1', target_area: 'UI', priority: 'LOW' });
    b.create({ id: 'dev-seq-2', title: 'S2', description: 'S2', target_area: 'API', priority: 'HIGH' });
    a.patch('dev-seq-1', { priority: 'CRITICAL' });
    b.patch('dev-seq-2', { priority: 'CRITICAL' });
    const final = a.list({});
    expect(final).toHaveLength(2);
    expect(final.find((t) => t.id === 'dev-seq-1').priority).toBe('CRITICAL');
    expect(final.find((t) => t.id === 'dev-seq-2').priority).toBe('CRITICAL');
  });
});
