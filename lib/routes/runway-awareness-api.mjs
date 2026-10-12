/**
 * Console runway-awareness routes.
 * The companion reports the picture. This process is the only place a roll
 * override can be built, and the connection method refuses anything that is
 * not SITL.
 */
import { getActiveConnection } from '../mavlink-connection.mjs';
import { logger } from '../logger.mjs';
import { createRunwayController } from '../runway-awareness.mjs';

function vehicleFromConnection(conn) {
  if (!conn) return { connected: false, simulator: false };
  let simulator = false;
  try {
    simulator = conn.simulatorDetection?.().simulator === true || conn.getStatus?.().simulator === true;
  } catch {
    simulator = false;
  }
  return { connected: conn.connected === true, simulator: simulator === true };
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
}
