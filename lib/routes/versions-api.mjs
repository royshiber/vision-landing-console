import path from 'path';
import { isLoopbackRequest } from '../app-update.mjs';
import { getActiveConnection } from '../mavlink-connection.mjs';
import { logger } from '../logger.mjs';
import {
  assertRollbackConfirm,
  buildVersionsView,
  findPreviousConsole,
  idleRollback,
  isRollbackRunning,
  mapCompanionVersions,
  markKnownGood,
  maybeAutoKnownGood,
  noteConsoleVersion,
  readLastFcParamSnapshotAt,
  readVersionsState,
  reconcileRollback,
  rollbackBlockMessage,
  rollbackSafety,
  writeVersionsState,
} from '../versions-view.mjs';

function companionClient(ctx) {
  return ctx.companionService?.client || ctx.companionClient || null;
}

function mavFrom(ctx) {
  if (typeof ctx.getMavConn === 'function') return ctx.getMavConn();
  try {
    return getActiveConnection();
  } catch {
    return null;
  }
}

async function loadCompanion(ctx) {
  const client = companionClient(ctx);
  if (!client || typeof client.getVersions !== 'function') return null;
  try {
    const payload = await client.getVersions();
    return mapCompanionVersions(payload);
  } catch (err) {
    logger.warn({ message: err?.message || 'versions' }, 'companion versions unavailable');
    return null;
  }
}

function failureMessage(result) {
  const raw = result?.message || result?.body?.message || '';
  if (raw && !String(raw).includes('לעדכן')) return raw;
  return rollbackBlockMessage(result?.blockedReason || result?.reason || result?.body?.reason);
}

export function registerVersionsApi(app, ctx = {}) {
  const appRoot = ctx.appRoot || process.cwd();
  const statePath = ctx.versionsStatePath || path.join(appRoot, 'data', 'versions-state.json');
  const getVersion = ctx.getAppVersion || (() => ctx.APP_VERSION || null);
  let rollbackDepth = 0;

  function currentVersion() {
    return String(getVersion() || '') || null;
  }

  function loadState(nowIso = new Date().toISOString()) {
    const version = currentVersion();
    let state = readVersionsState(statePath);
    const noted = noteConsoleVersion(state, version, nowIso);
    if (JSON.stringify(noted) !== JSON.stringify(state)) {
      state = noted;
      writeVersionsState(statePath, state);
    }
    return state;
  }

  function saveRollback(state, rollback) {
    state.rollback = rollback;
    writeVersionsState(statePath, state);
    return state;
  }

  function busyBody(from, to) {
    return {
      ok: false,
      reason: 'busy',
      blockedReason: 'busy',
      needsConfirmation: false,
      message: rollbackBlockMessage('busy'),
      from: from || null,
      to: to || null,
    };
  }

  async function view(nowIso = new Date().toISOString()) {
    let state = loadState(nowIso);
    const companion = await loadCompanion(ctx);
    const reconciled = reconcileRollback(state, {
      companion,
      consoleVersion: currentVersion(),
      nowMs: Date.now(),
    });
    if (reconciled.changed) {
      state = reconciled.state;
      writeVersionsState(statePath, state);
    }
    const auto = maybeAutoKnownGood(state, ctx.db, {
      consoleVersion: currentVersion(),
      companionVersion: companion?.version || null,
      nowIso,
    });
    if (auto.marked) {
      state = auto.state;
      writeVersionsState(statePath, state);
      const client = companionClient(ctx);
      if (client && typeof client.postVersionsKnownGood === 'function') {
        try {
          await client.postVersionsKnownGood();
        } catch (err) {
          logger.warn({ message: err?.message || 'known-good' }, 'companion known-good mark failed');
        }
      }
    }
    return buildVersionsView({
      appVersion: currentVersion(),
      state,
      previousConsole: findPreviousConsole(appRoot),
      companion,
      fcSnapshotAt: readLastFcParamSnapshotAt(ctx.db),
    });
  }

  function rejectIfBusy(from, to) {
    const state = readVersionsState(statePath);
    if (rollbackDepth > 0 || isRollbackRunning(state.rollback)) return busyBody(from, to);
    return null;
  }

  app.get('/api/versions', async (_req, res) => {
    try {
      res.json(await view());
    } catch (err) {
      logger.warn({ message: err?.message || 'versions' }, 'versions view failed');
      res.status(200).json(buildVersionsView({
        appVersion: currentVersion(),
        state: readVersionsState(statePath),
        previousConsole: { available: false, version: null },
        companion: null,
        fcSnapshotAt: null,
      }));
    }
  });

  app.post('/api/versions/known-good', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ ok: false, message: 'סימון זמין רק מהמחשב הזה.' });
    }
    const snap = await view();
    if (snap.companion.linked) {
      const client = companionClient(ctx);
      if (client && typeof client.postVersionsKnownGood === 'function') {
        try {
          await client.postVersionsKnownGood();
        } catch (err) {
          return res.status(err?.status || 502).json({
            ok: false,
            message: err?.body?.message || err?.message || 'הסימון נכשל.',
          });
        }
      }
    }
    const state = markKnownGood(loadState(), {
      consoleVersion: snap.console.version,
      companionVersion: snap.companion.linked ? snap.companion.version : null,
      source: 'manual',
      at: new Date().toISOString(),
    });
    writeVersionsState(statePath, state);
    res.json({ ok: true, knownGood: state.knownGood });
  });

  app.post('/api/versions/rollback/dismiss', (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ ok: false, message: 'שחזור זמין רק מהמחשב הזה.' });
    }
    const state = loadState();
    if (isRollbackRunning(state.rollback)) {
      return res.status(409).json(busyBody(state.rollback.from, state.rollback.to));
    }
    saveRollback(state, idleRollback());
    res.json({ ok: true, rollback: state.rollback });
  });

  app.post('/api/versions/rollback/console', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ ok: false, message: 'שחזור זמין רק מהמחשב הזה.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const previous = findPreviousConsole(appRoot);
    const from = currentVersion();
    const expected = { from, to: previous.version };
    const held = rejectIfBusy(from, previous.version);
    if (held) return res.status(409).json(held);
    const confirm = assertRollbackConfirm(body, expected);
    if (!confirm.ok) return res.status(confirm.status).json({ ok: false, message: confirm.message, from, to: previous.version });
    if (!previous.available) {
      return res.status(409).json({
        ok: false,
        available: false,
        message: 'אין גרסה קודמת לשחזור',
        from,
        to: null,
      });
    }
    const safety = rollbackSafety(mavFrom(ctx));
    if (!safety.allowed) {
      return res.status(409).json({
        ok: false,
        message: safety.message,
        blockedReason: safety.blockedReason,
        needsConfirmation: false,
        from,
        to: previous.version,
      });
    }
    if (!ctx.updateService || typeof ctx.updateService.rollbackPrevious !== 'function') {
      return res.status(409).json({
        ok: false,
        available: false,
        message: 'אין גרסה קודמת לשחזור',
        from,
        to: previous.version,
      });
    }
    rollbackDepth += 1;
    const state = loadState();
    const startedAt = new Date().toISOString();
    saveRollback(state, {
      state: 'running',
      kind: 'console',
      from,
      to: previous.version,
      backupId: null,
      error: null,
      startedAt,
    });
    let result;
    try {
      result = await ctx.updateService.rollbackPrevious({
        confirmUnknown: false,
        mavConn: mavFrom(ctx),
      });
    } catch (err) {
      result = { ok: false, status: 500, message: err?.message || 'השחזור נכשל.' };
    } finally {
      rollbackDepth = Math.max(0, rollbackDepth - 1);
    }
    if (!result?.ok) {
      const message = failureMessage(result);
      saveRollback(state, { ...state.rollback, state: 'failed', error: message });
      return res.status(result?.status || 500).json({
        ok: false,
        state: 'failed',
        needsConfirmation: false,
        message,
        blockedReason: result?.blockedReason || null,
        from,
        to: previous.version,
      });
    }
    res.status(202).json({
      ok: true,
      state: 'running',
      from,
      to: previous.version,
      message: 'משחזרים את הקונסולה.',
    });
  });

  app.post('/api/versions/rollback/companion', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ ok: false, message: 'שחזור זמין רק מהמחשב הזה.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const held = rejectIfBusy(body.from, body.to);
    if (held) return res.status(409).json(held);
    rollbackDepth += 1;
    try {
      const snap = await view();
      if (isRollbackRunning(readVersionsState(statePath).rollback)) {
        return res.status(409).json(busyBody(snap.companion?.version, body.to));
      }
      if (!snap.companion.linked) {
        return res.status(409).json({ ok: false, message: 'אין קישור למחשב המשימה' });
      }
      const backup = (snap.companion.backups || []).find((row) => row.id === body.backupId);
      const expected = {
        from: snap.companion.version,
        to: backup?.version || body.to || null,
      };
      const confirm = assertRollbackConfirm(
        { ...body, to: body.to || backup?.version || '' },
        { from: expected.from, to: expected.to || '' },
      );
      if (!confirm.ok) {
        return res.status(confirm.status).json({ ok: false, message: confirm.message, from: expected.from, to: expected.to });
      }
      if (!backup) {
        return res.status(404).json({ ok: false, message: 'הגיבוי לא נמצא.', from: expected.from, to: expected.to });
      }
      const safety = rollbackSafety(mavFrom(ctx));
      if (!safety.allowed) {
        return res.status(409).json({
          ok: false,
          message: safety.message,
          blockedReason: safety.blockedReason,
          needsConfirmation: false,
          from: expected.from,
          to: expected.to,
        });
      }
      const client = companionClient(ctx);
      if (!client || typeof client.postVersionsRollback !== 'function') {
        return res.status(409).json({ ok: false, message: 'אין קישור למחשב המשימה' });
      }
      const state = loadState();
      const startedAt = new Date().toISOString();
      saveRollback(state, {
        state: 'running',
        kind: 'companion',
        from: expected.from,
        to: expected.to,
        backupId: backup.id,
        error: null,
        startedAt,
      });
      let wire;
      try {
        wire = await client.postVersionsRollback(backup.id);
      } catch (err) {
        const message = failureMessage(err);
        saveRollback(state, { ...state.rollback, state: 'failed', error: message });
        return res.status(err?.status || 502).json({
          ok: false,
          state: 'failed',
          needsConfirmation: false,
          from: expected.from,
          to: expected.to,
          message,
          blockedReason: err?.body?.reason || null,
        });
      }
      const reason = wire?.reason;
      if (reason === 'busy') {
        saveRollback(state, { ...state.rollback, state: 'failed', error: rollbackBlockMessage('busy') });
        return res.status(409).json({
          ok: false,
          state: 'failed',
          reason: 'busy',
          message: wire?.message || rollbackBlockMessage('busy'),
          from: expected.from,
          to: expected.to,
        });
      }
      if (reason === 'armed' || reason === 'in_flight' || reason === 'unknown') {
        const message = wire?.message || rollbackBlockMessage(reason);
        saveRollback(state, { ...state.rollback, state: 'failed', error: message });
        return res.status(409).json({
          ok: false,
          state: 'failed',
          needsConfirmation: false,
          blockedReason: reason,
          message,
          from: expected.from,
          to: expected.to,
        });
      }
      const reverted = wire?.reverted === true || wire?.state === 'failed';
      if (reverted) {
        const message = wire?.message || 'השחזור נכשל.';
        saveRollback(state, { ...state.rollback, state: 'failed', error: message });
        return res.status(200).json({
          ok: false,
          state: 'failed',
          from: wire?.from || expected.from,
          to: wire?.to || expected.to,
          message,
          reverted: wire?.reverted === true,
        });
      }
      if (wire?.state === 'done') {
        saveRollback(state, idleRollback());
        return res.status(200).json({
          ok: true,
          state: 'done',
          from: wire?.from || expected.from,
          to: wire?.to || expected.to,
          message: wire?.message || 'הגרסה שוחזרה.',
        });
      }
      if (wire?.state === 'restarting' || wire?.state === 'running' || wire?.ok === true) {
        return res.status(202).json({
          ok: true,
          state: 'running',
          from: wire?.from || expected.from,
          to: wire?.to || expected.to,
          message: wire?.message || 'משחזרים את מחשב המשימה.',
        });
      }
      const message = wire?.message || 'השחזור נכשל.';
      saveRollback(state, { ...state.rollback, state: 'failed', error: message });
      return res.status(502).json({
        ok: false,
        state: 'failed',
        from: expected.from,
        to: expected.to,
        message,
      });
    } finally {
      rollbackDepth = Math.max(0, rollbackDepth - 1);
    }
  });
}
