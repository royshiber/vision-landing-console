/**
 * Policy state model — presentation + editing only.
 * Authoritative validation/generation stays on the Jetson.
 */

import { MAVLINK_DISPLAY_CATEGORIES, policyTokenState } from './companion-display.mjs';

export const POLICY_UI_STATES = Object.freeze({
  LOADING: 'LOADING',
  AVAILABLE: 'AVAILABLE',
  DIRTY: 'DIRTY',
  VALIDATING: 'VALIDATING',
  INVALID: 'INVALID',
  SAVED_NOT_APPLIED: 'SAVED_NOT_APPLIED',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
});

export const POLICY_CHANNELS = Object.freeze({
  gcs_4g: {
    id: 'gcs_4g',
    label: 'ערוץ רשת מאובטחת',
    channelNum: 3,
    channelLabel: 'CHANNEL 3 — 4G / TAILSCALE',
    description: 'GCS ↔ Tailscale ↔ Jetson ↔ FC',
    jetsonInPath: true,
    editable: true,
  },
  rfd900x: {
    id: 'rfd900x',
    label: 'ערוץ רדיו ישיר',
    channelNum: 2,
    channelLabel: 'CHANNEL 2 — RFD900X',
    description: 'GCS ↔ RFD900X ↔ FC — Jetson is not the radio endpoint',
    jetsonInPath: false,
    editable: true,
  },
});

export const POLICY_DIRECTIONS = Object.freeze({
  BOTH: { id: 'BOTH', field: 'deny', label: 'שני הכיוונים', labelEn: 'Both' },
  INBOUND: { id: 'INBOUND', field: 'deny_in', label: 'כניסה (GCS→FC)', labelEn: 'GCS → FC' },
  OUTBOUND: { id: 'OUTBOUND', field: 'deny_out', label: 'יציאה (FC→GCS)', labelEn: 'FC → GCS' },
});

export const CATEGORY_LABELS_HE = Object.freeze({
  HEARTBEAT: 'דופק',
  STATUS: 'סטטוס',
  GPS: 'GPS',
  ATTITUDE: 'תנוחה',
  BATTERY: 'סוללה',
  PARAMETERS: 'פרמטרים',
  MISSIONS: 'משימות',
  COMMANDS: 'פקודות',
  RC: 'שלט רחוק',
  VISION: 'ראייה',
  LANDING_TARGET: 'מטרת נחיתה',
  HIGH_RATE: 'תדר גבוה',
});

/**
 * For each category in a channel, determine the effective deny direction.
 * Returns { category, denied: boolean, direction: 'BOTH'|'INBOUND'|'OUTBOUND'|null }
 */
export function channelCategoryStates(channelPolicy) {
  const ch = channelPolicy && typeof channelPolicy === 'object' ? channelPolicy : {};
  const deny = (ch.deny || []).map((s) => String(s).toUpperCase());
  const denyIn = (ch.deny_in || []).map((s) => String(s).toUpperCase());
  const denyOut = (ch.deny_out || []).map((s) => String(s).toUpperCase());
  const allow = (ch.allow || []).map((s) => String(s).toUpperCase());

  return MAVLINK_DISPLAY_CATEGORIES.map((cat) => {
    const inDeny = deny.includes(cat);
    const inDenyIn = denyIn.includes(cat);
    const inDenyOut = denyOut.includes(cat);
    const inAllow = allow.includes(cat);
    const st = policyTokenState(ch, cat);

    let direction = null;
    if (inDeny) direction = 'BOTH';
    else if (inDenyIn && inDenyOut) direction = 'BOTH';
    else if (inDenyIn) direction = 'INBOUND';
    else if (inDenyOut) direction = 'OUTBOUND';

    return {
      category: cat,
      labelHe: CATEGORY_LABELS_HE[cat] || cat,
      denied: st === 'denied',
      allowed: st === 'allowed',
      unspecified: st === 'unspecified',
      direction,
      tokenState: st,
    };
  });
}

/**
 * Build a wire-format channel policy from UI toggle states.
 * @param {Array<{category: string, denied: boolean, direction: string|null}>} states
 * @param {object} baseChannel  existing channel for implementation/endpoint/mode/notes
 */
export function buildChannelPolicyFromUi(states, baseChannel = {}) {
  const deny = [];
  const denyIn = [];
  const denyOut = [];
  for (const s of states) {
    if (!s.denied) continue;
    const dir = s.direction || 'BOTH';
    if (dir === 'BOTH') deny.push(s.category);
    else if (dir === 'INBOUND') denyIn.push(s.category);
    else if (dir === 'OUTBOUND') denyOut.push(s.category);
  }
  return {
    implementation: baseChannel.implementation ?? null,
    endpoint: baseChannel.endpoint ?? null,
    mode: baseChannel.mode ?? null,
    deny,
    deny_in: denyIn,
    deny_out: denyOut,
    allow: baseChannel.allow || [],
    notes: baseChannel.notes ?? null,
  };
}

/**
 * Build full policy wire object from per-channel UI states.
 */
export function buildPolicyFromUi(version, channelsUi, basePolicy = {}) {
  const baseCh = basePolicy?.channels || {};
  return {
    version: version ?? basePolicy?.version ?? 1,
    channels: {
      gcs_4g: buildChannelPolicyFromUi(channelsUi.gcs_4g || [], baseCh.gcs_4g || {}),
      rfd900x: buildChannelPolicyFromUi(channelsUi.rfd900x || [], baseCh.rfd900x || {}),
    },
  };
}

/**
 * Diff two policies to detect dirty state.
 */
export function isPolicyDirty(original, edited) {
  if (!original || !edited) return false;
  try {
    return JSON.stringify(original) !== JSON.stringify(edited);
  } catch {
    return true;
  }
}
