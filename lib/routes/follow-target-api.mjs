/**
 * Follow-target HTTP. The loop sends GUIDED waypoints only while the SITL flag is on
 * and the active link is a simulator.
 */
import { getActiveConnection } from '../mavlink-connection.mjs';
import { logger } from '../logger.mjs';
import {
  FOLLOW_COPY,
  FOLLOW_LIMITS,
  createFollowController,
  followTargetFlagOn,
  vehicleFromConnection,
} from '../follow-target.mjs';

export function registerFollowTargetApi(app, ctx = {}) {
  const getVehicle = ctx.getVehicle || (() => vehicleFromConnection(getActiveConnection?.()));
  const controller = ctx.followController || createFollowController({
    enabled: () => followTargetFlagOn(process.env),
    link: {
      flyTo(lat, lon, altM) {
        const conn = getActiveConnection?.();
        if (!conn?.connected) throw new Error('no link');
        if (conn.simulatorDetection?.().simulator !== true && conn.getStatus?.().simulator !== true) {
          throw new Error('not simulator');
        }
        if (Number(altM) < FOLLOW_LIMITS.minAglM) throw new Error('agl');
        conn.flyTo(lat, lon, altM);
      },
      rtl() {
        const conn = getActiveConnection?.();
        if (!conn?.connected) throw new Error('no link');
        if (conn.simulatorDetection?.().simulator !== true && conn.getStatus?.().simulator !== true) {
          throw new Error('not simulator');
        }
        conn.setArduPlaneMode(FOLLOW_LIMITS.rtlMode, { reason: 'RTL' });
      },
    },
  });

  if (ctx.followLoop !== false && followTargetFlagOn(process.env)) {
    const timer = setInterval(() => {
      try {
        controller.tick(getVehicle());
      } catch (err) {
        logger.warn({ err: err?.message }, 'follow-target tick failed');
      }
    }, 1000);
    timer.unref?.();
  }

  app.get('/api/follow-target/status', (_req, res) => {
    res.json({ ok: true, ...controller.status(), bannerHe: FOLLOW_COPY.banner });
  });

  app.post('/api/follow-target/detection', (req, res) => {
    const noted = controller.noteDetection(req.body || {});
    res.status(noted.ok ? 200 : 400).json({ ...controller.status(), ...noted });
  });

  app.post('/api/follow-target/target', (req, res) => {
    try {
      const result = controller.selectTarget(req.body || {}, getVehicle());
      res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      logger.warn({ err: err?.message }, 'follow-target target failed');
      res.status(409).json({ ok: false, messageHe: FOLLOW_COPY.notSim });
    }
  });

  app.post('/api/follow-target/stop', (_req, res) => {
    res.json(controller.stop());
  });
}
