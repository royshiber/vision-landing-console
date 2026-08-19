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

  it('exposes transition helper', () => {
    expect(canTransitionStatus('DRAFT', 'QUEUED')).toBe(true);
    expect(canTransitionStatus('DRAFT', 'DEPLOYED')).toBe(false);
  });
});
