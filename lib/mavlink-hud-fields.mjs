/**
 * Why: VFR_HUD may be absent or sparse on USB/low-rate links; GLOBAL_POSITION_INT + ATTITUDE provide HUD fallbacks.
 * What: single composition used by SSE, advisor context, and flight engineer snapshots.
 * Reality-check: pitot IAS is authoritative when present; groundspeed-as-IAS is labeled downstream via airspeedIsGroundspeedProxy.
 * Temporal: ATTITUDE / GLOBAL_POSITION_INT / VFR_HUD arrive at different rates — gate mixed sources using FC time_boot_ms + receive timestamps.
 */

/** Wall-clock spread across concurrent MAVLink streams beyond which we warn / tighten blending (ms). */
export const HUD_MAX_SOURCE_SPREAD_MS = 140;

/** Max delta between ATTITUDE.time_boot_ms and GLOBAL_POSITION_INT.time_boot_ms to treat pose+nav as one epoch (ms). */
export const HUD_MAX_BOOT_SKEW_MS = 260;

export function sseFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rxWall(obj) {
  const w = obj?.receivedWallMs;
  return typeof w === 'number' && Number.isFinite(w) ? w : null;
}

/** Attitude vs global navigation packets aligned on FC boot timeline when both expose time_boot_ms. */
function bootAligned(attBoot, navBoot) {
  if (attBoot == null || navBoot == null) return true;
  return Math.abs(navBoot - attBoot) <= HUD_MAX_BOOT_SKEW_MS;
}

/** Receive-time alignment: optional streams missing timestamps stay permissive. */
function wallAligned(attWall, otherWall) {
  if (attWall == null || otherWall == null) return true;
  return Math.abs(otherWall - attWall) <= HUD_MAX_SOURCE_SPREAD_MS;
}

function normalizeHeadingDeg(yawDeg) {
  const c = sseFiniteNumber(yawDeg);
  if (c == null) return null;
  return ((c % 360) + 360) % 360;
}

/**
 * @param {object|null|undefined} mavConn active mavlink connection
 * @returns {{
 *   airspeed: number|null,
 *   groundspeed: number|null,
 *   altitude: number|null,
 *   heading: number|null,
 *   airspeedIsGroundspeedProxy: boolean,
 *   hudTimeSkewMs: number|null,
 *   hudTimeSkewWarn: boolean,
 * }}
 */
export function composeHudTelemetryFields(mavConn) {
  const empty = () => ({
    airspeed: null,
    groundspeed: null,
    altitude: null,
    heading: null,
    airspeedIsGroundspeedProxy: false,
    hudTimeSkewMs: null,
    hudTimeSkewWarn: false,
  });

  if (!mavConn) return empty();

  const att = mavConn.lastAttitude;
  const gpi = mavConn.lastGlobalPos;
  const vfr = mavConn.lastVfrHud;

  const attWall = rxWall(att);
  const gWall = rxWall(gpi);
  const vWall = rxWall(vfr);
  const walls = [attWall, gWall, vWall].filter((x) => x != null);
  let hudTimeSkewMs = null;
  if (walls.length >= 2) {
    hudTimeSkewMs = Math.max(...walls) - Math.min(...walls);
  }
  const hudTimeSkewWarn = hudTimeSkewMs != null && hudTimeSkewMs > HUD_MAX_SOURCE_SPREAD_MS;

  const attBoot = att?.timeBootMs ?? null;
  const gBoot = gpi?.timeBootMs ?? null;
  const bootOk = bootAligned(attBoot, gBoot);

  const vfrUsable = vfr != null && wallAligned(attWall, vWall);
  const gpiUsable = gpi != null && bootOk && wallAligned(attWall, gWall);

  let heading = null;
  if (vfrUsable && sseFiniteNumber(vfr?.heading) != null) {
    heading = normalizeHeadingDeg(vfr.heading);
  } else if (gpiUsable && sseFiniteNumber(gpi?.hdgDeg) != null) {
    heading = normalizeHeadingDeg(gpi.hdgDeg);
  } else if (sseFiniteNumber(att?.yawDeg) != null) {
    heading = normalizeHeadingDeg(att.yawDeg);
  }

  let altitude = null;
  if (vfrUsable) {
    altitude =
      sseFiniteNumber(vfr?.alt)
      ?? (gpiUsable ? sseFiniteNumber(gpi?.relativeAltM) : null)
      ?? (gpiUsable ? sseFiniteNumber(gpi?.altMslM) : null);
  } else if (gpiUsable) {
    altitude = sseFiniteNumber(gpi?.relativeAltM) ?? sseFiniteNumber(gpi?.altMslM);
  } else {
    altitude =
      sseFiniteNumber(vfr?.alt)
      ?? sseFiniteNumber(gpi?.relativeAltM)
      ?? sseFiniteNumber(gpi?.altMslM);
  }

  let groundspeed = null;
  if (vfrUsable) {
    groundspeed =
      sseFiniteNumber(vfr?.groundspeed)
      ?? (gpiUsable ? sseFiniteNumber(gpi?.groundspeedMs) : null);
  } else if (gpiUsable) {
    groundspeed = sseFiniteNumber(gpi?.groundspeedMs);
  } else {
    groundspeed = sseFiniteNumber(vfr?.groundspeed)
      ?? (bootOk ? sseFiniteNumber(gpi?.groundspeedMs) : null);
  }

  /** Pitot / FC-reported IAS: never tagged as proxy even under skew — critical for ArduPlane semantics. */
  let airspeed = sseFiniteNumber(vfr?.airspeed);
  let airspeedIsGroundspeedProxy = false;
  if (airspeed == null) {
    let gsCand = null;
    if (vfrUsable && sseFiniteNumber(vfr?.groundspeed) != null) gsCand = vfr.groundspeed;
    else if (gpiUsable && sseFiniteNumber(gpi?.groundspeedMs) != null) gsCand = gpi.groundspeedMs;
    else {
      gsCand = sseFiniteNumber(vfr?.groundspeed);
      if (gsCand == null && bootOk) gsCand = sseFiniteNumber(gpi?.groundspeedMs);
    }
    if (gsCand != null) {
      airspeed = gsCand;
      airspeedIsGroundspeedProxy = true;
    }
  }

  return {
    airspeed,
    groundspeed,
    altitude,
    heading,
    airspeedIsGroundspeedProxy,
    hudTimeSkewMs,
    hudTimeSkewWarn,
  };
}
