/**
 * One settings form for every camera. Unsupported companion actions stay
 * in the form, disabled, with a short reason. They are never removed.
 */
import { FOV_DEFAULTS } from './camera-fov.mjs';

export const CAMERA_UNSUPPORTED_HE = Object.freeze({
  record: 'המצלמה הזו לא מקליטה',
  detections: 'אין זיהויים במצלמה הזו',
  calibration: 'אין כיול במצלמה הזו',
});

export const AE_LOCK_HE = 'חשיפה אוטומטית דולקת';
export const FOV_META_HE = 'זווית הראייה היא נתון, לא בקרת מצלמה';
export const APPLIED_HE = 'הוחל';
export const FAILED_HE = 'נכשל';

/** cam1 has exposure, image, and snapshot. Record, detections, and calibration do not. */
export const CAMERA_SUPPORT = Object.freeze({
  cam0: Object.freeze({ record: true, detections: true, calibration: true, snapshot: true }),
  cam1: Object.freeze({ record: false, detections: false, calibration: false, snapshot: true }),
});

const KINDS = Object.freeze({
  record: ['Record'],
  detections: ['OverlayToggle'],
  calibration: ['CalibCap', 'CalibSolve'],
  snapshot: ['Snap'],
});

export function cameraControlSupported(camId, kind) {
  const row = CAMERA_SUPPORT[camId];
  if (!row || !Object.prototype.hasOwnProperty.call(row, kind)) return true;
  return row[kind] === true;
}

function note(camId, kind) {
  if (cameraControlSupported(camId, kind)) return '';
  return `<p class="optics-field-note" data-unsupported="${kind}">${CAMERA_UNSUPPORTED_HE[kind]}</p>`;
}

export function cameraSettingsHtml(camId) {
  const fov = FOV_DEFAULTS[camId] ?? FOV_DEFAULTS.cam0;
  const detectDisabled = cameraControlSupported(camId, 'detections') ? '' : ' disabled';
  const detectChecked = cameraControlSupported(camId, 'detections') ? ' checked' : '';
  return `<div class="cam0-controls optics-groups">
    <div class="optics-field-group" data-settings-group="exposure">
      <p class="optics-field-kicker">חשיפה</p>
      <label class="cam0-check"><input type="checkbox" id="${camId}Ae" disabled /> <span class="optics-field-name">חשיפה אוטומטית</span></label>
      <p id="${camId}AeLock" class="optics-field-note" hidden>${AE_LOCK_HE}</p>
      <span id="${camId}ApplyBadge" class="optics-apply-badge" hidden></span>
      <label><span class="optics-field-name">חשיפה</span> <input id="${camId}Exposure" type="number" min="10" max="100001" step="10" dir="ltr" disabled /></label>
      <label><span class="optics-field-name">הגבר</span> <input id="${camId}Gain" type="number" min="16" max="256" step="1" dir="ltr" disabled /></label>
    </div>
    <div class="optics-field-group" data-settings-group="image">
      <p class="optics-field-kicker">תמונה</p>
      <label><span class="optics-field-name">זווית ראייה (מעלות)</span> <input id="${camId}Fov" type="number" min="20" max="180" step="1" dir="ltr" value="${fov}" title="${FOV_META_HE}" /> <span id="${camId}FovHint" class="optics-fov-hint" hidden>טווח 20–180°</span></label>
      <label><span class="optics-field-name">רזולוציה</span>
        <select id="${camId}Res" dir="ltr" disabled>
          <option value="1280x800">1280×800</option>
          <option value="1280x720">1280×720</option>
        </select>
      </label>
      <label><span class="optics-field-name">קצב יעד</span> <input id="${camId}FpsSet" type="number" min="1" max="60" step="1" dir="ltr" disabled /></label>
    </div>
    <div class="optics-field-group" data-settings-group="record">
      <p class="optics-field-kicker">הקלטה</p>
      <button type="button" id="${camId}Record" class="cam0-btn" disabled>הקלטה</button>
      <span id="${camId}RecDot" class="cam0-rec" hidden>מקליט</span>
      <button type="button" id="${camId}Snap" class="cam0-btn" disabled>צילום</button>
      <label class="cam0-check"><input type="checkbox" id="${camId}OverlayToggle"${detectChecked}${detectDisabled} /> <span class="optics-field-name">זיהויים</span></label>
      ${note(camId, 'record')}
      ${note(camId, 'detections')}
      <section class="cam0-calib" aria-label="כיול" data-settings-group="calibration">
        <h4>כיול</h4>
        <p class="cam0-calib-lead">החזיקו לוח שחמט מול המצלמה.</p>
        <p id="${camId}CalibState" class="cam0-calib-state">עדיין אין כיול.</p>
        <button type="button" id="${camId}CalibCap" class="cam0-btn" disabled>צילום לוח</button>
        <button type="button" id="${camId}CalibSolve" class="cam0-btn" disabled>פתרון</button>
        ${note(camId, 'calibration')}
      </section>
    </div>
  </div>`;
}

export function mountCameraSettings(root = document) {
  if (!root?.querySelectorAll) return;
  for (const host of root.querySelectorAll('[data-camera-settings]')) {
    if (host.dataset.mounted === '1') continue;
    const camId = host.dataset.cameraSettings;
    if (camId !== 'cam0' && camId !== 'cam1') continue;
    host.innerHTML = cameraSettingsHtml(camId);
    host.dataset.mounted = '1';
  }
}

/** Keep an unsupported control disabled and titled, even when the camera is live. */
export function applyCameraSupport(camId) {
  for (const [kind, suffixes] of Object.entries(KINDS)) {
    if (cameraControlSupported(camId, kind)) continue;
    const reason = CAMERA_UNSUPPORTED_HE[kind] || '';
    for (const suffix of suffixes) {
      const el = document.getElementById(`${camId}${suffix}`);
      if (!el) continue;
      el.disabled = true;
      el.title = reason;
    }
  }
}

/** Manual exposure and gain stay off while auto exposure owns the picture. */
export function syncManualExposureLock(camId, { aeOn, live } = {}) {
  const lock = aeOn === true;
  const note = document.getElementById(`${camId}AeLock`);
  if (note) note.hidden = !lock;
  for (const suffix of ['Exposure', 'Gain']) {
    const el = document.getElementById(`${camId}${suffix}`);
    if (!el) continue;
    el.disabled = live !== true || lock;
    el.title = lock ? AE_LOCK_HE : '';
  }
}

/** Badge text comes from device read-back, never from the field the operator typed. */
export function applyOutcome(controls) {
  const rows = controls && typeof controls === 'object' ? controls : null;
  if (!rows) return { state: 'failed', text: FAILED_HE, fov: false };
  const judged = ['ae', 'exposure_us', 'gain', 'width', 'height', 'fps']
    .map((key) => rows[key])
    .filter((row) => row && row.skipped !== true && row.requested != null);
  const fov = rows.fov_deg?.metadata_only === true && rows.fov_deg?.applied === true;
  const hardwareFailed = judged.some((row) => row.applied !== true);
  const nothing = judged.length === 0 && !fov;
  const state = nothing || hardwareFailed ? 'failed' : 'applied';
  return { state, text: state === 'applied' ? APPLIED_HE : FAILED_HE, fov };
}

export function paintCameraApply(camId, controls) {
  const badge = document.getElementById(`${camId}ApplyBadge`);
  const hint = document.getElementById(`${camId}FovHint`);
  const outcome = applyOutcome(controls);
  if (badge) {
    badge.hidden = false;
    badge.dataset.state = outcome.state;
    badge.textContent = outcome.text;
  }
  if (hint && outcome.fov) {
    hint.hidden = false;
    hint.textContent = FOV_META_HE;
  }
  return outcome;
}

if (typeof document !== 'undefined') mountCameraSettings(document);
