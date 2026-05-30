import {
  scoreUsbFcHint,
  classifySerialAccessError,
  buildAutoConnectFailureSuggestion,
  isLikelyNonFcSerialPort,
  baudOrderForPort,
  isJetsonCompanionOnline,
} from './auto-connect-utils.mjs';
import {
  activateConnection,
  deactivateConnection,
  getAllConnectionStatuses,
  getConnectionStatus,
  listSerialPorts,
} from './mavlink-connection.mjs';
import { buildJetsonRelayTargets, buildSitlFallbackTargets } from './jetson-companion-proxy.mjs';
import {
  beginAutoConnectProgress,
  completeAutoConnectProgress,
  finishAutoConnectPhase,
  patchAutoConnectAttempt,
  setAutoConnectPhaseActive,
  patchAutoConnectMeta,
} from './auto-connect-progress.mjs';

export { clientIpFromRequest } from './jetson-companion-proxy.mjs';
export { getAutoConnectProgress } from './auto-connect-progress.mjs';

const HB_MS = 5500;
const HB_MS_JETSON = 6500;
const POST_OPEN_SETTLE_MS = 140;
const MAX_PORTS = 8;

function disconnectDbAndLive(db) {
  const live = getAllConnectionStatuses();
  for (const s of live) deactivateConnection(s.id);
  db.prepare(`UPDATE connections SET active = 0`).run();
}

/**
 * @param {number} id
 * @param {(id:number, ms:number)=>Promise<boolean>} waitForFirstHeartbeat
 */
async function tryMavlinkConnection(db, cfg, waitForFirstHeartbeat, attempts, phases, attemptNo, hbMs = HB_MS) {
  const { type, host, port, serialPort, baudRate, label } = cfg;
  patchAutoConnectAttempt({
    target: label,
    subStatus: 'activate',
    attemptIndex: attemptNo,
    lastAttempt: { target: label, phase: 'activate', ok: false },
  });
  disconnectDbAndLive(db);
  const name = label || `Smart ${type}`;
  const ins = db
    .prepare(`INSERT INTO connections (name, type, host, port, serial_port, baud_rate) VALUES (?,?,?,?,?,?)`)
    .run(
      name,
      type,
      host ?? null,
      port != null ? Number(port) : null,
      serialPort ?? null,
      baudRate ?? null,
    );
  const id = Number(ins.lastInsertRowid);
  try {
    await activateConnection({
      id,
      name,
      type,
      host: host || '0.0.0.0',
      port: Number.isFinite(Number(port)) ? Number(port) : 14550,
      serialPort: serialPort || undefined,
      baudRate: baudRate || 57600,
    });
  } catch (err) {
    try {
      db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
    } catch {
      /* ignore */
    }
    const classified = classifySerialAccessError(err?.message);
    const failAttempt = {
      ok: false,
      phase: 'activate',
      target: label,
      type,
      host: host ?? null,
      port: port ?? null,
      portPath: serialPort ?? null,
      baud: baudRate ?? null,
      error: err?.message || 'activate failed',
      code: classified.code === 'port_busy' ? 'port_busy' : 'activate_failed',
      heMessage: classified.heMessage,
    };
    attempts.push(failAttempt);
    patchAutoConnectAttempt({ lastAttempt: failAttempt, subStatus: 'scanning' });
    return { ok: false, skipRestOfBaudsOnPort: classified.code === 'port_busy' };
  }

  patchAutoConnectAttempt({
    target: label,
    subStatus: 'heartbeat',
    attemptIndex: attemptNo,
    lastAttempt: { target: label, phase: 'heartbeat', ok: false },
  });
  await new Promise((r) => setTimeout(r, POST_OPEN_SETTLE_MS));
  const hb = await waitForFirstHeartbeat(id, hbMs);
  if (!hb) {
    deactivateConnection(id);
    try {
      db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
    } catch {
      /* ignore */
    }
    const hbFail = {
      ok: false,
      phase: 'heartbeat',
      target: label,
      type,
      host: host ?? null,
      port: port ?? null,
      portPath: serialPort ?? null,
      baud: baudRate ?? null,
      code: 'no_heartbeat',
    };
    attempts.push(hbFail);
    patchAutoConnectAttempt({ lastAttempt: hbFail, subStatus: 'scanning' });
    return { ok: false };
  }

  db.prepare(`UPDATE connections SET active = 1, last_connected = datetime('now') WHERE id = ?`).run(id);
  attempts.push({
    ok: true,
    phase: 'connected',
    target: label,
    type,
    host: host ?? null,
    port: port ?? null,
    portPath: serialPort ?? null,
    baud: baudRate ?? null,
  });
  phases.push({ step: 'connected', summary: `MAVLink heartbeat — ${label}` });
  return {
    ok: true,
    id,
    connectPath: label,
    connectionType: type,
    host: host ?? null,
    port: port ?? null,
    serialPort: serialPort ?? null,
    baudRate: baudRate ?? null,
    status: getConnectionStatus(id),
    winner:
      type === 'serial'
        ? { port: serialPort, baud: baudRate }
        : { host, port, type },
  };
}

async function runSerialPhase(db, preferredPath, waitForFirstHeartbeat, attempts, phases, attemptCounter) {
  setAutoConnectPhaseActive('usb_serial', {
    subStatus: 'scanning',
    message: 'סורק יציאות USB / FC…',
  });
  let ports = await listSerialPorts();
  if (!ports.length) {
    phases.push({ step: 'usb_serial', summary: 'לא נמצאו יציאות COM/USB' });
    finishAutoConnectPhase('usb_serial', 'skipped', 'לא נמצאו יציאות COM/USB');
    return null;
  }
  if (preferredPath) {
    ports = ports.filter((p) => p.path === preferredPath);
    if (!ports.length) {
      phases.push({ step: 'usb_serial', summary: `יציאה ${preferredPath} לא נמצאה` });
      finishAutoConnectPhase('usb_serial', 'skipped', `יציאה ${preferredPath} לא נמצאה`);
      return null;
    }
  } else {
    const fcLike = ports.filter((p) => !isLikelyNonFcSerialPort(p));
    const skipped = ports.filter((p) => isLikelyNonFcSerialPort(p));
    ports = [...fcLike, ...skipped].sort((a, b) => scoreUsbFcHint(b) - scoreUsbFcHint(a));
    if (skipped.length && !fcLike.length) {
      phases.push({
        step: 'usb_serial',
        summary: `רק יציאות וירטואליות (${skipped.map((p) => p.path).join(', ')}) — מנסה בכל זאת`,
      });
    } else if (skipped.length) {
      phases.push({
        step: 'usb_serial',
        summary: `דילוג על ${skipped.length} יציאות וירטואליות (Microsoft/BT) — עדיפות ל-FC`,
      });
    }
  }

  const scanSummary =
    ports.length <= 4
      ? `סריקת ${ports.length} יציאות USB (עדיפות FC)`
      : `סריקת עד ${MAX_PORTS} יציאות USB`;
  phases.push({ step: 'usb_serial', summary: scanSummary });
  setAutoConnectPhaseActive('usb_serial', { subStatus: 'scanning', message: scanSummary });

  let n = 0;
  for (const p of ports) {
    if (n >= MAX_PORTS) break;
    if (!preferredPath && isLikelyNonFcSerialPort(p)) {
      const hasFcLike = ports.some((x) => !isLikelyNonFcSerialPort(x));
      if (hasFcLike) continue;
    }
    n++;
    let skipRest = false;
    const bauds = baudOrderForPort(p);
    for (const baud of bauds) {
      if (skipRest) break;
      const label = `USB ${p.path} @ ${baud}`;
      attemptCounter.n += 1;
      const r = await tryMavlinkConnection(
        db,
        { type: 'serial', serialPort: p.path, baudRate: baud, label },
        waitForFirstHeartbeat,
        attempts,
        phases,
        attemptCounter.n,
      );
      if (r.ok) return { ...r, smartPhase: 'usb_serial' };
      if (r.skipRestOfBaudsOnPort) skipRest = true;
    }
  }
  finishAutoConnectPhase('usb_serial', 'failed', 'USB — לא נמצא heartbeat');
  return null;
}

async function runNetworkPhase(
  db,
  targets,
  waitForFirstHeartbeat,
  attempts,
  phases,
  stepName,
  attemptCounter,
  hbMs = HB_MS,
) {
  if (!targets.length) {
    finishAutoConnectPhase(stepName, 'skipped', 'אין יעדי רשת לשלב זה');
    return null;
  }
  const netSummary = `מנסה ${targets.length} יעדי רשת`;
  phases.push({ step: stepName, summary: netSummary });
  setAutoConnectPhaseActive(stepName, { subStatus: 'scanning', message: netSummary });
  for (const t of targets) {
    attemptCounter.n += 1;
    const r = await tryMavlinkConnection(
      db,
      t,
      waitForFirstHeartbeat,
      attempts,
      phases,
      attemptCounter.n,
      hbMs,
    );
    if (r.ok) return { ...r, smartPhase: stepName };
  }
  const failMsg =
    stepName === 'jetson_relay' ? 'Jetson relay — ללא heartbeat' : 'SITL מקומי — ללא heartbeat';
  finishAutoConnectPhase(stepName, 'failed', failMsg);
  return null;
}

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {object} opts.jetsonState
 * @param {object} [opts.env]
 * @param {string} [opts.preferredSerialPort]
 * @param {(id:number, ms:number)=>Promise<boolean>} opts.waitForFirstHeartbeat
 */
export async function runSmartConnect({ db, jetsonState, env = process.env, preferredSerialPort, waitForFirstHeartbeat }) {
  /** @type {object[]} */
  const attempts = [];
  /** @type {{ step: string, summary: string }[]} */
  const phases = [];
  const attemptCounter = { n: 0 };

  beginAutoConnectProgress();
  try {
    const jetsonOnline = isJetsonCompanionOnline(jetsonState);
    const jetsonTargets = buildJetsonRelayTargets(jetsonState, env);
    patchAutoConnectMeta({ jetsonOnline });

    /** @type {(() => Promise<object|null>)[]} */
    const phaseRunners = [];

    const runUsb = () =>
      runSerialPhase(
        db,
        preferredSerialPort,
        waitForFirstHeartbeat,
        attempts,
        phases,
        attemptCounter,
      );
    const runJetson = () =>
      runNetworkPhase(
        db,
        jetsonTargets,
        waitForFirstHeartbeat,
        attempts,
        phases,
        'jetson_relay',
        attemptCounter,
        HB_MS_JETSON,
      );
    const runSitl = () =>
      runNetworkPhase(
        db,
        buildSitlFallbackTargets(),
        waitForFirstHeartbeat,
        attempts,
        phases,
        'sitl_local',
        attemptCounter,
      );

    if (jetsonOnline && jetsonTargets.length) {
      phaseRunners.push(runJetson, runUsb, runSitl);
      patchAutoConnectAttempt({
        subStatus: 'scanning',
        target: 'Jetson online — מנסה relay לפני USB',
      });
    } else {
      phaseRunners.push(runUsb, runJetson, runSitl);
      if (!jetsonTargets.length) {
        patchAutoConnectAttempt({
          subStatus: 'scanning',
          target: 'Jetson offline — דילוג על relay עד heartbeat',
        });
      }
    }

    for (const run of phaseRunners) {
      const win = await run();
      if (win?.ok) {
        completeAutoConnectProgress({
          ok: true,
          winningPhase: win.smartPhase || 'usb_serial',
          message: `מחובר — ${win.connectPath || 'MAVLink'}`,
        });
        return { ok: true, ...win, attempts, phases, suggestion: null };
      }
    }

    disconnectDbAndLive(db);
    const suggestion = buildAutoConnectFailureSuggestion(attempts, {
      jetsonOnline,
      hadJetsonTargets: jetsonTargets.length > 0,
    });
    phases.push({ step: 'exhausted', summary: `סיום אחרי ${attempts.length} ניסויים` });
    const busyHe = attempts.find((a) => a.code === 'port_busy')?.heMessage;
    const message =
      busyHe ||
      suggestion.headline ||
      'לא נמצא MAVLink — ניסינו USB, Jetson relay, ו-SITL מקומי.';
    completeAutoConnectProgress({ ok: false, message });
    return { ok: false, message, attempts, phases, suggestion };
  } catch (err) {
    completeAutoConnectProgress({ ok: false, message: err?.message || 'שגיאת חיבור חכם' });
    throw err;
  }
}
