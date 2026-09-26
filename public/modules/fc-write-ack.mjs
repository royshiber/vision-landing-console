/** Shared decision for every FC parameter write. Success is a full read-back match. */

export const FC_NO_LINK_HE = 'אין חיבור לבקר הטיסה';
const READBACK_TOLERANCE = 0.001;

export function fcReadbackAck(requested, data) {
  const verified = data?.verified && typeof data.verified === 'object' ? data.verified : {};
  const missed = [];
  const acked = {};
  for (const [key, wantRaw] of Object.entries(requested || {})) {
    const want = Number(wantRaw);
    const has = Object.prototype.hasOwnProperty.call(verified, key);
    const got = has ? Number(verified[key]) : Number.NaN;
    if (!has || !Number.isFinite(want) || !Number.isFinite(got) || Math.abs(want - got) > READBACK_TOLERANCE) {
      missed.push(key);
    } else {
      acked[key] = got;
    }
  }
  return { missed, acked };
}

export function classifyFcWrite({ linked, requested, httpOk, data }) {
  const keys = Object.keys(requested || {});
  const keepAll = { level: 'fail', posted: false, history: false, clear: [], keep: keys, acked: {}, data: data || null };
  if (!linked) {
    return { ...keepAll, text: FC_NO_LINK_HE, posted: false };
  }
  if (data?.simulated === true || data?.via === 'offline' || data?.code === 'not_connected') {
    return { ...keepAll, text: FC_NO_LINK_HE, posted: true };
  }
  if (!httpOk && data?.code === 'armed') {
    return { ...keepAll, text: 'המטוס חמוש. הכתיבה חסומה עד לניטרול.', posted: true };
  }
  if (!httpOk && data?.code === 'armed_unknown') {
    return { ...keepAll, text: 'מצב החימוש לא ידוע. הכתיבה חסומה עד לדופק תקין.', posted: true };
  }
  if (!httpOk && data?.code === 'bulk_cap') {
    return { ...keepAll, text: data.message || 'הכתיבה חסומה. יותר מדי פרמטרים בבת אחת.', posted: true };
  }
  if (!keys.length) {
    return {
      level: 'none',
      text: 'אין שינוי',
      posted: true,
      history: false,
      clear: [],
      keep: [],
      acked: {},
      data: data || null,
    };
  }
  const { missed, acked } = fcReadbackAck(requested, data);
  const ackedKeys = Object.keys(acked);
  if (missed.length === 0 && data?.ok === true && httpOk) {
    return {
      level: 'ok',
      text: 'נכתב לבקר ואומת',
      posted: true,
      history: true,
      clear: keys,
      keep: [],
      acked,
      data,
    };
  }
  if (ackedKeys.length) {
    return {
      level: 'partial',
      text: `הכתיבה לבקר חלקית. ${missed.length} פרמטרים לא אושרו.`,
      posted: true,
      history: true,
      clear: ackedKeys,
      keep: missed,
      acked,
      data,
    };
  }
  return {
    ...keepAll,
    text: 'הכתיבה לבקר נכשלה. הבקר לא אישר את הפרמטרים.',
    posted: true,
  };
}

if (typeof window !== 'undefined') {
  window.classifyFcWrite = classifyFcWrite;
  window.FC_NO_LINK_HE = FC_NO_LINK_HE;
}
