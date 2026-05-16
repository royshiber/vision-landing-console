/**
 * Extract pose timeline from MAVLink telemetry logs (.tlog often = raw MAVLink or MP timestamped stream).
 */

import {
  parseMavlinkFrames,
  parseAttitude,
  parseHeartbeat,
  parseStatusText,
  parseVfrHud,
  parseGlobalPositionInt,
  parseGpsRawInt,
} from './mavlink-connection.mjs';
import { replayFlightModeLabel } from './arduplane-flight-modes.mjs';

const MSG_HEARTBEAT = 0;
const MSG_ATTITUDE = 30;
const MSG_GPS_RAW_INT = 24;
const MSG_GLOBAL_POSITION_INT = 33;
const MSG_VFR_HUD = 74;
const MSG_STATUSTEXT = 253;

const MAV_MODE_FLAG_ARMED = 128;

/** MAVLink logs can be noisy; cap UI payloads. */
const MAX_REPLAY_EVENTS = 400;

/**
 * Walk buffer for MAVLink frames — supports Mission Planner optional 8-byte µs timestamp immediately before each packet.
 *
 * @param {Buffer} buf
 * @returns {{ frames: { msgId: number, payload: Buffer, tMs: number|null }[] }}
 */
export function extractFramesFromLog(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    while (o < buf.length && buf[o] !== 0xfe && buf[o] !== 0xfd) o++;
    if (o >= buf.length) break;

    let tsMs = null;
    if (o >= 8) {
      try {
        const us = Number(buf.readBigUInt64LE(o - 8));
        if (Number.isFinite(us) && us > 1e6 && us < 1e16) tsMs = Math.floor(us / 1000);
      } catch {
        /* ignore */
      }
    }

    const sub = buf.subarray(o);
    const parsed = parseMavlinkFrames(sub);
    if (!parsed.length) {
      o++;
      continue;
    }
    const f = parsed[0];

    let tMs = tsMs;
    if (f.msgId === MSG_GPS_RAW_INT && f.payload.length >= 8) {
      const us = f.payload.readUInt32LE(0);
      tMs = Math.floor(us / 1000);
    } else if (f.msgId === MSG_ATTITUDE && f.payload.length >= 4) {
      tMs = f.payload.readUInt32LE(0);
    }

    frames.push({ msgId: f.msgId, payload: f.payload, tMs });
    o += f.end;
  }

  return { frames };
}

/**
 * @param {{ tMs?: number|null }[]} samples
 * @param {number} targetT
 */
function nearestSampleIndex(samples, targetT) {
  if (!samples.length) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].tMs ?? 0;
    const d = Math.abs(t - targetT);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * @param {{ tMs?: number|null }[]} samples
 * @param {object[]} replayEvents
 */
function annotateReplayEventsWithApproxSample(samples, replayEvents) {
  if (!Array.isArray(replayEvents)) return;
  for (const ev of replayEvents) {
    const t = ev.tMs ?? 0;
    ev.sampleIndexApprox = nearestSampleIndex(samples, t);
  }
}

/**
 * Build downsampled samples + replay markers (STATUSTEXT, heartbeat arm / flight-mode edges).
 *
 * @param {Buffer} buf
 * @param {{ maxSamples?: number, minStepMs?: number }} opts
 */
export function buildReplaySamplesFromBuffer(buf, opts = {}) {
  const maxSamples = Math.min(Math.max(opts.maxSamples ?? 20000, 100), 50000);
  const minStepMs = opts.minStepMs ?? 80;

  const { frames } = extractFramesFromLog(buf);
  const samples = [];
  const replayEvents = [];
  /** @type {number|null} */
  let runningMs = null;

  /** @type {boolean|null} */
  let lastArmedKnown = null;
  /** @type {number|null} */
  let lastCustomMode = null;

  let last = {
    rollDeg:     0,
    pitchDeg:    0,
    heading:     null,
    altitude:    null,
    lat:         null,
    lon:         null,
    airspeed:    null,
    groundspeed: null,
  };
  let lastPushT = -Infinity;
  let samplesFull = false;

  for (const fr of frames) {
    const { msgId, payload, tMs } = fr;

    if (tMs != null && Number.isFinite(tMs)) {
      runningMs = tMs;
    }

    if (msgId === MSG_ATTITUDE) {
      const a = parseAttitude(payload);
      if (a) {
        last.rollDeg = a.rollDeg;
        last.pitchDeg = a.pitchDeg;
      }
      if (payload.length >= 16) {
        const yawRad = payload.readFloatLE(12);
        last.heading = Math.round((((yawRad * 180) / Math.PI) * 10)) / 10;
      }
    } else if (msgId === MSG_VFR_HUD) {
      const v = parseVfrHud(payload);
      if (v) {
        if (v.heading != null) last.heading = v.heading;
        if (v.alt != null) last.altitude = v.alt;
        if (v.airspeed != null) last.airspeed = v.airspeed;
        if (v.groundspeed != null) last.groundspeed = v.groundspeed;
      }
    } else if (msgId === MSG_GLOBAL_POSITION_INT) {
      const g = parseGlobalPositionInt(payload);
      if (g) {
        last.lat = g.lat;
        last.lon = g.lon;
        if (g.relativeAltM != null) last.altitude = g.relativeAltM;
        else if (g.altMslM != null && last.altitude == null) last.altitude = g.altMslM;
        if (g.groundspeedMs != null) last.groundspeed = g.groundspeedMs;
        if (g.hdgDeg != null) last.heading = g.hdgDeg;
      }
    } else if (msgId === MSG_GPS_RAW_INT) {
      const g = parseGpsRawInt(payload);
      if (g?.lat && g?.lon) {
        last.lat = g.lat;
        last.lon = g.lon;
      }
    }

    const evTMs = runningMs != null ? runningMs : tMs != null ? tMs : null;
    if (replayEvents.length < MAX_REPLAY_EVENTS && evTMs != null) {
      if (msgId === MSG_STATUSTEXT) {
        const st = parseStatusText(payload);
        if (st?.text) {
          replayEvents.push({
            kind:     'statustext',
            severity: st.severity,
            tMs:      evTMs,
            label:    st.text.length > 200 ? `${st.text.slice(0, 199)}…` : st.text,
          });
        }
      } else if (msgId === MSG_HEARTBEAT) {
        const hb = parseHeartbeat(payload);
        if (hb) {
          const armed = (hb.baseMode & MAV_MODE_FLAG_ARMED) !== 0;
          if (lastArmedKnown == null) {
            lastArmedKnown = armed;
          } else if (armed !== lastArmedKnown) {
            replayEvents.push({
              kind:  armed ? 'arm' : 'disarm',
              tMs:   evTMs,
              label: armed ? 'ARMED' : 'DISARMED',
            });
            lastArmedKnown = armed;
          }
          if (lastCustomMode == null) {
            lastCustomMode = hb.customMode;
          } else if (hb.customMode !== lastCustomMode) {
            replayEvents.push({
              kind:  'flight_mode',
              tMs:   evTMs,
              label: replayFlightModeLabel(hb.customMode),
            });
            lastCustomMode = hb.customMode;
          }
        }
      }
    }

    if (!samplesFull && msgId === MSG_ATTITUDE) {
      const t = tMs != null ? tMs : samples.length * minStepMs;
      if (t - lastPushT >= minStepMs || samples.length === 0) {
        lastPushT = t;
        samples.push({
          tMs:         t,
          rollDeg:     last.rollDeg,
          pitchDeg:    last.pitchDeg,
          heading:     last.heading,
          altitude:    last.altitude,
          lat:         last.lat,
          lon:         last.lon,
          airspeed:    last.airspeed,
          groundspeed: last.groundspeed,
        });
        if (samples.length >= maxSamples) samplesFull = true;
      }
    }
  }

  annotateReplayEventsWithApproxSample(samples, replayEvents);

  return {
    samples,
    replayEvents,
    durationMs: samples.length ? samples[samples.length - 1].tMs - samples[0].tMs : 0,
    frameCount: frames.length,
  };
}
