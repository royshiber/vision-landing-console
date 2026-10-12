/**
 * Console runway-awareness routes.
 * The companion reports the picture. This process is the only place a roll
 * override can be built, and the connection method refuses anything that is
 * not SITL.
 */
import { getActiveConnection } from '../mavlink-connection.mjs';
import { logger } from '../logger.mjs';
import { createRunwayController } from '../runway-awareness.mjs';

const STALE_RC_MS = 500;

function freshRcChannels(conn, now) {
  const rc = conn?.lastRcChannels;
  if (!rc || typeof rc !== 'object') return null;
  const at = Number(conn.lastRcAt ?? rc.receivedWallMs);
  if (!Number.isFinite(at) || now - at > STALE_RC_MS) return null;
  return rc;
}

export function vehicleFromConnection(conn, now = Date.now()) {
  if (!conn) return { connected: false, simulator: false };
  let simulator = false;
  try {
    simulator = conn.simulatorDetection?.().simulator === true || conn.getStatus?.().simulator === true;
  } catch {
    simulator = false;
  }
  const pos = conn.lastGlobalPos || {};
  const alt = Number(pos.relativeAltM);
  const hudAlt = Number(conn.lastVfrHud?.alt);
  const stamp = Number(now);
  return {
    connected: conn.connected === true,
    simulator: simulator === true,
    customMode: Number.isFinite(Number(conn.lastCustomMode)) ? Number(conn.lastCustomMode) : null,
    rcChannels: freshRcChannels(conn, Number.isFinite(stamp) ? stamp : Date.now()),
    altAglM: Number.isFinite(alt) ? alt : (Number.isFinite(hudAlt) ? hudAlt : null),
    lat: Number.isFinite(Number(pos.lat)) ? Number(pos.lat) : null,
    lon: Number.isFinite(Number(pos.lon)) ? Number(pos.lon) : null,
    missionItems: Array.isArray(conn.missionItems) ? conn.missionItems : [],
    missionCurrent: Number.isFinite(Number(conn.missionCurrent)) ? Number(conn.missionCurrent) : null,
  };
}

export function registerRunwayAwarenessApi(app, ctx = {}) {
  const getConn = ctx.getConnection || (() => {
    try { return getActiveConnection?.() || null; } catch { return null; }
  });
  const controller = ctx.controller || createRunwayController({
    env: ctx.env || process.env,
    link: {
      sendGuidance(cmd) {
        const conn = getConn();
        if (!conn || typeof conn.sendRunwayRollOverride !== 'function') {
          return { sent: false, reason: 'no_link' };
        }
        try {
          if (cmd.kind === 'GO_AROUND') {
            if (typeof conn.sendRunwayGoAround !== 'function') return { sent: false, reason: 'no_link' };
            conn.sendRunwayGoAround();
            return { sent: true };
          }
          conn.sendRunwayRollOverride(cmd.rollPwm, { release: cmd.release === true });
          return { sent: true };
        } catch (err) {
          return { sent: false, reason: err?.code || 'not_sitl' };
        }
      },
    },
  });

  async function companionClient() {
    return ctx.companionService?.client || ctx.companionClient || null;
  }

  async function pullEstimate(camera) {
    const client = await companionClient();
    if (!client || typeof client.getRunwayAwareness !== 'function') return null;
    try {
      const body = await client.getRunwayAwareness(camera);
      return body?.estimate && typeof body.estimate === 'object' ? body.estimate : null;
    } catch (err) {
      logger.warn({ err: err?.message }, 'runway awareness read failed');
      return null;
    }
  }

  if (ctx.loop !== false) {
    const timer = setInterval(() => {
      const current = controller.status();
      if (current.level < 3 && !controller.holding()) return;
      pullEstimate('').then((estimate) => {
        try {
          controller.tick({ estimate, vehicle: vehicleFromConnection(getConn()) });
        } catch (err) {
          logger.warn({ err: err?.message }, 'runway awareness tick failed');
        }
      }).catch(() => {});
    }, 1000);
    timer.unref?.();
  }

  app.get('/api/runway/awareness', async (req, res) => {
    const camera = String(req.query?.camera || '');
    const estimate = await pullEstimate(camera);
    const body = controller.note({
      estimate,
      vehicle: vehicleFromConnection(getConn()),
    });
    body.flightCommands = false;
    body.allowSend = false;
    res.json(body);
  });

  app.post('/api/runway/level', async (req, res) => {
    const before = controller.status().level;
    const result = controller.setLevel(req.body || {});
    if (!result.ok) {
      res.status(result.status || 403).json({ ...result, flightCommands: false, commandsSent: controller.commandsSent() });
      return;
    }
    const client = await companionClient();
    if (client && typeof client.postRunwayLevel === 'function') {
      try {
        await client.postRunwayLevel(req.body || {});
        result.companionUpdated = true;
      } catch (err) {
        const remote = err?.body && typeof err.body === 'object' ? err.body : null;
        if (err?.status === 403 || err?.status === 400) {
          controller.setLevel({ level: before });
          res.status(err.status).json({
            ok: false,
            reason: remote?.reason || 'companion_refused',
            messageHe: remote?.message_he || remote?.messageHe || 'מחשב המשימה דחה את הרמה',
            flightCommands: false,
            ...controller.status(),
          });
          return;
        }
        result.companionUpdated = false;
        result.messageHe = 'הרמה נשמרה כאן. מחשב המשימה לא עודכן.';
      }
    }
    if (controller.holding() && controller.status().level < 3) {
      controller.tick({ vehicle: vehicleFromConnection(getConn()) });
    }
    res.status(200).json({ ...controller.status(), ...result, flightCommands: false });
  });

  app.post('/api/runway/vision-arm', (req, res) => {
    controller.setManualArm(req.body?.arm === true);
    const body = controller.tick({ vehicle: vehicleFromConnection(getConn()) });
    body.flightCommands = false;
    body.allowSend = false;
    res.json(body);
  });
}
