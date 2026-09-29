/**
 * Gimbal settings, same groups as a camera panel. SIYI A8 commands go
 * through the gimbal pad client. The panel stays off until a gimbal answers.
 * Tracking is a placeholder and never sends.
 */
import {
  LOCKED_HE,
  NO_REPLY_HE,
  UNLOCKED_HE,
  onGimbalView,
  postGimbal,
  setGimbalMoveSpeed,
} from './gimbal-pad.mjs';

const CENTER_URL = '/api/jetson/v1/gimbal/center';
const ZOOM_URL = '/api/jetson/v1/gimbal/zoom';
const MODE_URL = '/api/jetson/v1/gimbal/mode';
const PHOTO_URL = '/api/jetson/v1/gimbal/photo';
const RECORD_URL = '/api/jetson/v1/gimbal/record';
export const TRACK_PLACEHOLDER_HE = 'מעקב עדיין לא זמין';

const ACTION_IDS = [
  'gimbalSpeed',
  'gimbalSettingsCenter',
  'gimbalSettingsZoomIn',
  'gimbalSettingsZoomOut',
  'gimbalSettingsMode',
  'gimbalSettingsRecord',
  'gimbalSettingsSnap',
];

function paintNum(el, value) {
  if (!el) return;
  el.textContent = Number.isFinite(value) ? value.toFixed(1) : '—';
}

export function bindGimbalSettings(doc, { post = postGimbal } = {}) {
  const root = doc.getElementById('gimbalSettings');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  const reason = doc.getElementById('gimbalSettingsReason');
  const honesty = doc.getElementById('gimbalSettingsHonesty');
  const speed = doc.getElementById('gimbalSpeed');
  const modeBtn = doc.getElementById('gimbalSettingsMode');
  const track = doc.getElementById('gimbalTrack');
  const trackNote = doc.getElementById('gimbalTrackNote');
  let view = { enabled: false, reasonHe: NO_REPLY_HE, locked: false };
  let recording = false;

  function paint(next) {
    view = next || view;
    const enabled = view.enabled === true;
    root.dataset.state = enabled ? 'live' : 'down';
    const why = enabled ? '' : (view.reasonHe || NO_REPLY_HE);
    if (reason) {
      reason.hidden = enabled;
      reason.textContent = why;
    }
    if (honesty) honesty.textContent = enabled ? 'מחובר' : 'אין מענה';
    for (const id of ACTION_IDS) {
      const el = doc.getElementById(id);
      if (!el) continue;
      el.disabled = !enabled;
      if (enabled) el.removeAttribute('title');
      else el.title = why;
    }
    if (track) {
      track.disabled = true;
      track.checked = false;
      track.title = TRACK_PLACEHOLDER_HE;
    }
    if (trackNote) trackNote.textContent = TRACK_PLACEHOLDER_HE;
    if (modeBtn) modeBtn.textContent = view.locked === true ? LOCKED_HE : UNLOCKED_HE;
    paintNum(doc.getElementById('gimbalSettingsYaw'), view.yaw);
    paintNum(doc.getElementById('gimbalSettingsPitch'), view.pitch);
    paintNum(doc.getElementById('gimbalSettingsZoom'), view.zoom);
  }

  function send(url, body) {
    if (!view.enabled) return;
    post(url, body).catch(() => {});
  }

  const applySpeed = () => {
    if (speed.disabled) return;
    const next = setGimbalMoveSpeed(speed.value);
    speed.dataset.speed = String(next);
    if (document.activeElement !== speed) speed.value = String(next);
  };
  speed?.addEventListener('input', applySpeed);
  speed?.addEventListener('change', applySpeed);
  doc.getElementById('gimbalSettingsCenter')?.addEventListener('click', () => send(CENTER_URL, {}));
  doc.getElementById('gimbalSettingsZoomIn')?.addEventListener('click', () => send(ZOOM_URL, { zoom: 1 }));
  doc.getElementById('gimbalSettingsZoomOut')?.addEventListener('click', () => send(ZOOM_URL, { zoom: -1 }));
  modeBtn?.addEventListener('click', () => {
    const next = view.locked === true ? 'follow' : 'lock';
    send(MODE_URL, { mode: next });
  });
  doc.getElementById('gimbalSettingsRecord')?.addEventListener('click', () => {
    recording = !recording;
    const btn = doc.getElementById('gimbalSettingsRecord');
    if (btn) btn.textContent = recording ? 'מקליט' : 'הקלטה';
    send(RECORD_URL, { recording });
  });
  doc.getElementById('gimbalSettingsSnap')?.addEventListener('click', () => send(PHOTO_URL, {}));
  track?.addEventListener('change', (event) => {
    event.preventDefault();
    track.checked = false;
    track.disabled = true;
  });

  onGimbalView(paint);
}

if (typeof document !== 'undefined' && document.getElementById('gimbalSettings')) {
  bindGimbalSettings(document);
}
