/**
 * Mission / PFD HUD honesty — never invent altitude, IAS, or GPS coordinates.
 * Distinguishes no-link vs connected-but-FC-has-not-produced-the-field vs a real value.
 */

export const HUD_REASON_NO_LINK = 'אין קישור';
export const HUD_REASON_ALT_WAITING = 'מחובר אך אין גובה מהבקר עדיין';
export const HUD_REASON_SPD_WAITING = 'מחובר אך אין מהירות מהבקר עדיין';
export const HUD_REASON_GPS_WAITING = 'מחובר אך אין מיקום לוויין מהבקר עדיין';
export const HUD_REASON_FIELD_WAITING = 'מחובר אך אין נתון מהבקר עדיין';
export const HUD_REASON_EKF_WAIT_GPS = 'הבקר ממתין ללוויין';
export const HUD_REASON_EKF_NO_FIX = 'הבקר מדווח שאין נעילת לוויין';
export const HUD_REASON_EKF_POS_FAULT = 'הבקר מדווח על תקלת מיקום';

export const GPS_FIX_LABELS = ['אין GPS', 'אין Fix', '2D Fix', '3D Fix', 'DGPS', 'RTK Float', 'RTK Fixed'];

const WAIT_BY_KIND = {
  altitude: HUD_REASON_ALT_WAITING,
  airspeed: HUD_REASON_SPD_WAITING,
  gps: HUD_REASON_GPS_WAITING,
  gpsVisionDelta: HUD_REASON_GPS_WAITING,
};

export function hudFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Link is live enough that dashes mean "FC has not produced this field", not "no radio". */
export function hudLinkLive(mav) {
  if (!mav || typeof mav !== 'object') return false;
  if (mav.connected === true || mav.listening === true) return true;
  return Number(mav.heartbeatCount) > 0;
}

export function hudFieldHonesty(kind, mav, value) {
  const finite = hudFiniteNumber(value);
  if (finite) {
    return {
      state: 'value',
      title: '',
      dash: false,
    };
  }
  if (hudLinkLive(mav)) {
    return {
      state: 'waiting',
      title: WAIT_BY_KIND[kind] || HUD_REASON_FIELD_WAITING,
      dash: true,
    };
  }
  return {
    state: 'no_link',
    title: HUD_REASON_NO_LINK,
    dash: true,
  };
}

export function altitudeHonestyTitle(mav) {
  if (hudFiniteNumber(mav?.altitude)) {
    return mav?.hudTimeSkewWarn ? 'פער זמן בין חבילות MAVLink — ייתכן עיוות זמני בין אופק לשאר מדי ה-HUD.' : '';
  }
  return hudFieldHonesty('altitude', mav, mav?.altitude).title;
}

export function airspeedHonestyTitle(mav) {
  if (hudFiniteNumber(mav?.airspeed)) {
    return mav?.airspeedIsGroundspeedProxy
      ? 'מהירות מוצגת כפרוקסי ממהירות קרקע — לא מד טיוח אוויר.'
      : '';
  }
  return hudFieldHonesty('airspeed', mav, mav?.airspeed).title;
}

export function classifyEkfGpsStatusText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/\borigin set\b/.test(t) || /\bgps\b.*\bdetected\b/.test(t)) return null;
  if (/\bwaiting for gps\b/.test(t) || /\bgps config\b/.test(t) || /\bahrs:\s*waiting\b/.test(t)) {
    return HUD_REASON_EKF_WAIT_GPS;
  }
  if (/\bno gps\b/.test(t) || /\bno fix\b/.test(t) || /\bgps.*lost\b/.test(t)) {
    return HUD_REASON_EKF_NO_FIX;
  }
  if (/\bekf\b.*\b(fail|error|lane)\b/.test(t) || /\bahrs\b.*\b(fail|error)\b/.test(t)) {
    return HUD_REASON_EKF_POS_FAULT;
  }
  if (/\bekf\b/.test(t) && /\bgps\b/.test(t)) return HUD_REASON_EKF_WAIT_GPS;
  return null;
}

/** Latest EKF/GPS STATUSTEXT classified into a short Hebrew HUD hint. No invented numbers. */
export function pickHudEkfGpsHint(statusTexts) {
  const rows = Array.isArray(statusTexts) ? statusTexts : [];
  for (const row of rows) {
    const hint = classifyEkfGpsStatusText(row?.text ?? row);
    if (hint) {
      return {
        hint,
        sourceText: String(row?.text ?? row).trim(),
      };
    }
  }
  return null;
}

export function formatGpsHudReadout(mav) {
  const fix = mav?.gpsFixType;
  const sats = mav?.gpsSats;
  const hasFix = hudFiniteNumber(fix);
  const satsOk = hudFiniteNumber(sats);
  if (!hasFix) {
    const honesty = hudFieldHonesty('gps', mav, null);
    return {
      text: '--',
      title: honesty.title,
      status: hudLinkLive(mav) ? 'unknown' : 'unknown',
      dash: true,
    };
  }
  const label = GPS_FIX_LABELS[fix] ?? `Fix ${fix}`;
  const satsStr = satsOk ? ` ${sats}` : '';
  const honesty = hudFieldHonesty('gps', mav, fix >= 2 ? 1 : null);
  return {
    text: `${label}${satsStr}`.trim(),
    title: fix >= 2 ? '' : honesty.title,
    status: !hudLinkLive(mav) ? 'unknown' : fix >= 3 ? 'ok' : fix === 2 ? 'warn' : 'fail',
    dash: false,
  };
}

/**
 * Decide whether the GCS should (re)ask the FC for HUD stream rates.
 * Re-request on first heartbeat, MAVLink1→2 upgrade, radio reconnect gap, or still-missing HUD.
 */
export const HUD_RATE_RECONNECT_GAP_MS = 3000;
export const HUD_RATE_MISSING_RETRY_MS = 2000;
export const HUD_RATE_MAX_REQUESTS = 4;

export function shouldReRequestHudRates({
  lastRequestAt = null,
  lastRequestTxVersion = null,
  preferredTxVersion = 1,
  heartbeatGapMs = 0,
  missingHud = false,
  now = Date.now(),
  requestCount = 0,
} = {}) {
  if (lastRequestAt == null) return true;
  if (Number(preferredTxVersion) === 2 && Number(lastRequestTxVersion) !== 2) return true;
  if (Number(heartbeatGapMs) >= HUD_RATE_RECONNECT_GAP_MS) return true;
  if (
    missingHud
    && Number(requestCount) < HUD_RATE_MAX_REQUESTS
    && (Number(now) - Number(lastRequestAt)) >= HUD_RATE_MISSING_RETRY_MS
  ) {
    return true;
  }
  return false;
}
