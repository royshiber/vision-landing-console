/**
 * Arm and disarm on the active MAVLink connection.
 * Same COMMAND_LONG path as other FC commands. No second transport.
 * Force disarm is refused before a frame is built.
 */
import { getActiveConnection } from '../mavlink-connection.mjs';
import {
  ARM_DISARM_FORCE_MAGIC,
  assertNotForceDisarm,
  flightStateForDisarm,
  prearmFailureText,
} from '../arm-disarm.mjs';
import { logger } from '../logger.mjs';

const NO_TELEMETRY_HE = 'אין טלמטריה מהבקר';
const FLYING_HE = 'אשרו שוב נטרול';
const UNKNOWN_FLIGHT_HE = 'מצב הטיסה לא ידוע. אשרו שוב נטרול';

export function registerArmDisarmApi(app) {
  app.post('/api/mavlink/arm-disarm', async (req, res) => {
    const body = req.body || {};
    try {
      assertNotForceDisarm(body.param2);
      assertNotForceDisarm(body.forceMagic);
    } catch {
      return res.status(400).json({ ok: false, sent: false, error: 'force_disarm_blocked' });
    }
    if (body.force === true || Number(body.param2) === ARM_DISARM_FORCE_MAGIC) {
      return res.status(400).json({ ok: false, sent: false, error: 'force_disarm_blocked' });
    }
    const action = body.action === 'arm' ? 'arm' : (body.action === 'disarm' ? 'disarm' : '');
    if (!action) {
      return res.status(400).json({ ok: false, sent: false, error: 'bad_action' });
    }
    const conn = getActiveConnection();
    if (!conn?.connected || typeof conn.lastBaseMode !== 'number') {
      return res.status(422).json({
        ok: false,
        sent: false,
        error: 'no_telemetry',
        message: NO_TELEMETRY_HE,
      });
    }
    const flight = flightStateForDisarm(conn);
    const flying = flight.flying === true;
    if (action === 'disarm' && flight.needsSecondConfirm && body.confirmFlying !== true) {
      return res.status(409).json({
        ok: false,
        sent: false,
        error: flight.uncertain ? 'flight_state_unknown' : 'flying',
        flying,
        flightStateUnknown: flight.uncertain === true,
        message: flight.uncertain ? UNKNOWN_FLIGHT_HE : FLYING_HE,
      });
    }
    try {
      const { ack, texts } = await conn.sendComponentArmDisarm({ arm: action === 'arm' });
      const prior = Array.isArray(conn.statusTexts) ? conn.statusTexts : [];
      const prearm = prearmFailureText([...(texts || []).map((text) => ({ text })), ...prior]);
      const accepted = ack?.result === 0;
      if (!accepted) {
        logger.info({ action, result: ack?.result ?? null }, 'ARM_DISARM refused');
      }
      return res.json({
        ok: accepted,
        sent: true,
        action,
        result: ack?.result ?? null,
        prearm,
        flying,
      });
    } catch (err) {
      const code = err?.code === 'no_telemetry' ? 'no_telemetry' : 'send_failed';
      const status = code === 'no_telemetry' ? 422 : 500;
      return res.status(status).json({
        ok: false,
        sent: false,
        error: code,
        message: code === 'no_telemetry' ? NO_TELEMETRY_HE : 'השליחה נכשלה',
      });
    }
  });
}
