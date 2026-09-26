import path from 'path';
import { isLoopbackRequest } from '../app-update.mjs';
import { getActiveConnection } from '../mavlink-connection.mjs';
import { logger } from '../logger.mjs';
import {
  assertRollbackConfirm,
  buildVersionsView,
  findPreviousConsole,
  mapCompanionVersions,
  markKnownGood,
  maybeAutoKnownGood,
  noteConsoleVersion,
  readLastFcParamSnapshotAt,
  readVersionsState,
  rollbackSafety,
  writeVersionsState,
  ARMED_HE,
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

export function registerVersionsApi(app, ctx = {}) {
  const appRoot = ctx.appRoot || process.cwd();
  const statePath = ctx.versionsStatePath || path.join(appRoot, 'data', 'versions-state.json');
  const getVersion = ctx.getAppVersion || (() => ctx.APP_VERSION || null);

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

  async function view(nowIso = new Date().toISOString()) {
    let state = loadState(nowIso);
    const companion = await loadCompanion(ctx);
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
    const state = markKnownGood(loadState(), {
      consoleVersion: snap.console.version,
      companionVersion: snap.companion.linked ? snap.companion.version : null,
      source: 'manual',
      at: new Date().toISOString(),
    });
    writeVersionsState(statePath, state);
    if (snap.companion.linked) {
      const client = companionClient(ctx);
      if (client && typeof client.postVersionsKnownGood === 'function') {
        try {
          await client.postVersionsKnownGood();
        } catch (err) {
          logger.warn({ message: err?.message || 'known-good' }, 'companion known-good mark failed');
        }
      }
    }
    res.json({ ok: true, knownGood: state.knownGood });
  });

  app.post('/api/versions/rollback/console', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ ok: false, message: 'החזרה זמינה רק מהמחשב הזה.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const previous = findPreviousConsole(appRoot);
    const from = currentVersion();
    const expected = { from, to: previous.version };
    const confirm = assertRollbackConfirm(body, expected);
    if (!confirm.ok) return res.status(confirm.status).json({ ok: false, message: confirm.message, from, to: previous.version });
    if (!previous.available) {
      return res.status(409).json({
        ok: false,
        available: false,
        message: 'אין עותק של הגרסה הקודמת. החזרה לא זמינה.',
        from,
        to: null,
      });
    }
    const safety = rollbackSafety(mavFrom(ctx), body.confirmUnknown);
    if (!safety.allowed) {
      return res.status(409).json({
        ok: false,
        message: safety.blockedReason === 'armed' ? ARMED_HE : safety.message,
        blockedReason: safety.blockedReason,
        needsConfirmation: safety.needsConfirmation,
        from,
        to: previous.version,
      });
    }
    if (!ctx.updateService || typeof ctx.updateService.rollbackPrevious !== 'function') {
      return res.status(409).json({
        ok: false,
        available: false,
        message: 'אין עותק של הגרסה הקודמת. החזרה לא זמינה.',
        from,
        to: previous.version,
      });
    }
    const state = loadState();
    state.rollback = {
      state: 'running',
      kind: 'console',
      from,
      to: previous.version,
      backupId: null,
      error: null,
    };
    writeVersionsState(statePath, state);
    const result = await ctx.updateService.rollbackPrevious({
      confirmUnknown: body.confirmUnknown === true,
      mavConn: mavFrom(ctx),
    });
    if (!result?.ok) {
      state.rollback = { ...state.rollback, state: 'failed', error: result?.message || 'ההחזרה נכשלה.' };
      writeVersionsState(statePath, state);
      return res.status(result?.status || 500).json({
        ok: false,
        message: result?.message || 'ההחזרה נכשלה.',
        from,
        to: previous.version,
      });
    }
    res.status(202).json({
      ok: true,
      state: 'running',
      from,
      to: previous.version,
      message: 'מחזירים את הקונסולה.',
    });
  });

  app.post('/api/versions/rollback/companion', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ ok: false, message: 'החזרה זמינה רק מהמחשב הזה.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const snap = await view();
    if (!snap.companion.linked) {
      return res.status(409).json({ ok: false, message: 'אין קישור למחשב המשימה' });
    }
    const backup = (snap.companion.backups || []).find((row) => row.id === body.backupId);
    const expected = {
      from: snap.companion.version,
      to: backup?.version || body.to || null,
    };
    const confirm = assertRollbackConfirm(
      { ...body, to: body.to || backup?.version },
      { from: expected.from, to: expected.to },
    );
    if (!confirm.ok) {
      return res.status(confirm.status).json({ ok: false, message: confirm.message, from: expected.from, to: expected.to });
    }
    if (!backup) {
      return res.status(404).json({ ok: false, message: 'הגיבוי לא נמצא.', from: expected.from, to: expected.to });
    }
    const safety = rollbackSafety(mavFrom(ctx), body.confirmUnknown);
    if (!safety.allowed && safety.blockedReason === 'armed') {
      return res.status(409).json({ ok: false, message: ARMED_HE, blockedReason: 'armed', from: expected.from, to: expected.to });
    }
    const client = companionClient(ctx);
    if (!client || typeof client.postVersionsRollback !== 'function') {
      return res.status(409).json({ ok: false, message: 'אין קישור למחשב המשימה' });
    }
    const state = loadState();
    state.rollback = {
      state: 'running',
      kind: 'companion',
      from: expected.from,
      to: expected.to,
      backupId: backup.id,
      error: null,
    };
    writeVersionsState(statePath, state);
    try {
      const wire = await client.postVersionsRollback(backup.id);
      const reverted = wire?.reverted === true || wire?.state === 'failed';
      const running = wire?.state === 'restarting' || wire?.state === 'running';
      if (reverted) {
        state.rollback = { ...state.rollback, state: 'failed', error: wire?.message || 'ההחזרה נכשלה.' };
        writeVersionsState(statePath, state);
        return res.status(200).json({
          ok: false,
          state: 'failed',
          from: wire?.from || expected.from,
          to: wire?.to || expected.to,
          message: wire?.message || 'ההחזרה נכשלה.',
          reverted: true,
        });
      }
      if (wire?.reason === 'armed') {
        state.rollback = { ...state.rollback, state: 'failed', error: ARMED_HE };
        writeVersionsState(statePath, state);
        return res.status(409).json({ ok: false, message: ARMED_HE, from: expected.from, to: expected.to });
      }
      if (running || wire?.ok === true) {
        if (wire?.state === 'done') {
          state.rollback = { ...state.rollback, state: 'idle', error: null };
          writeVersionsState(statePath, state);
        }
        return res.status(wire?.state === 'done' ? 200 : 202).json({
          ok: true,
          state: wire?.state === 'done' ? 'done' : 'running',
          from: wire?.from || expected.from,
          to: wire?.to || expected.to,
          message: wire?.message || 'מחזירים את מחשב המשימה.',
        });
      }
      state.rollback = { ...state.rollback, state: 'failed', error: wire?.message || 'ההחזרה נכשלה.' };
      writeVersionsState(statePath, state);
      return res.status(502).json({
        ok: false,
        state: 'failed',
        from: expected.from,
        to: expected.to,
        message: wire?.message || 'ההחזרה נכשלה.',
      });
    } catch (err) {
      const armed = err?.body?.reason === 'armed' || err?.status === 409;
      state.rollback = {
        ...state.rollback,
        state: 'failed',
        error: armed ? ARMED_HE : (err?.body?.message || err?.message || 'ההחזרה נכשלה.'),
      };
      writeVersionsState(statePath, state);
      return res.status(armed ? 409 : 502).json({
        ok: false,
        state: 'failed',
        from: expected.from,
        to: expected.to,
        message: state.rollback.error,
      });
    }
  });
}
