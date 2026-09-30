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

/** cam1 shares exposure, image, snapshot, and calibration. Record and detections do not. */
export const CAMERA_SUPPORT = Object.freeze({
  cam0: Object.freeze({ record: true, detections: true, calibration: true, snapshot: true }),
  cam1: Object.freeze({ record: false, detections: false, calibration: true, snapshot: true }),
});

const KINDS = Object.freeze({
  record: ['Record'],
  detections: ['OverlayToggle'],
  calibration: ['CalibStart'],
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

function opticsNumber(inputHtml) {
  return `<span class="optics-stepper"><button type="button" class="optics-step" data-optics-step="-1" aria-label="הפחיתו">−</button>${inputHtml}<button type="button" class="optics-step" data-optics-step="1" aria-label="הגדילו">+</button></span>`;
}

export function bindOpticsSteppers(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('.optics-stepper').forEach((wrap) => {
    if (wrap.dataset.bound === '1') return;
    const input = wrap.querySelector('input[type="number"]');
    if (!input) return;
    wrap.dataset.bound = '1';
    const sync = () => {
      wrap.querySelectorAll('.optics-step').forEach((btn) => { btn.disabled = input.disabled; });
    };
    sync();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled'] });
    }
    wrap.addEventListener('click', (event) => {
      const btn = event.target.closest('.optics-step');
      if (!btn || input.disabled || btn.disabled) return;
      const dir = Number(btn.dataset.opticsStep);
      if (!Number.isFinite(dir) || dir === 0) return;
      const step = Number(input.step);
      const delta = Number.isFinite(step) && step > 0 ? step : 1;
      const current = input.value === '' ? Number(input.min) : Number(input.value);
      if (!Number.isFinite(current)) return;
      let next = current + dir * delta;
      const min = Number(input.min);
      const max = Number(input.max);
      if (input.min !== '' && Number.isFinite(min)) next = Math.max(min, next);
      if (input.max !== '' && Number.isFinite(max)) next = Math.min(max, next);
      const digits = (String(input.step).split('.')[1] || '').length;
      input.value = digits ? String(Number(next.toFixed(digits))) : String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
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
      <label><span class="optics-field-name">חשיפה</span> ${opticsNumber(`<input id="${camId}Exposure" type="number" min="10" max="100001" step="10" dir="ltr" disabled />`)}</label>
      <label><span class="optics-field-name">הגבר</span> ${opticsNumber(`<input id="${camId}Gain" type="number" min="16" max="256" step="1" dir="ltr" disabled />`)}</label>
    </div>
    <div class="optics-field-group" data-settings-group="image">
      <p class="optics-field-kicker">תמונה</p>
      <label><span class="optics-field-name">זווית ראייה (מעלות)</span> ${opticsNumber(`<input id="${camId}Fov" type="number" min="20" max="180" step="1" dir="ltr" value="${fov}" title="${FOV_META_HE}" />`)} <span id="${camId}FovHint" class="optics-fov-hint" hidden>טווח 20–180°</span></label>
      <label><span class="optics-field-name">רזולוציה</span>
        <select id="${camId}Res" dir="ltr" disabled>
          <option value="1280x800">1280×800</option>
          <option value="1280x720">1280×720</option>
        </select>
      </label>
      <label><span class="optics-field-name">קצב יעד</span> ${opticsNumber(`<input id="${camId}FpsSet" type="number" min="1" max="60" step="1" dir="ltr" disabled />`)}</label>
    </div>
    <div class="optics-field-group" data-settings-group="record">
      <p class="optics-field-kicker">הקלטה</p>
      <button type="button" id="${camId}Record" class="cam0-btn" disabled>הקלטה</button>
      <span id="${camId}RecDot" class="cam0-rec" hidden>מקליט</span>
      <button type="button" id="${camId}Snap" class="cam0-btn" disabled>צילום</button>
      <label class="cam0-check"><input type="checkbox" id="${camId}OverlayToggle"${detectChecked}${detectDisabled} /> <span class="optics-field-name">זיהויים</span></label>
      ${note(camId, 'record')}
      ${note(camId, 'detections')}
    </div>
    <section class="cam0-calib" id="${camId}Calib" aria-label="כיול" data-settings-group="calibration" data-phase="idle">
      <h4>כיול</h4>
      <label><span class="optics-field-name">פינות</span> ${opticsNumber(`<input id="${camId}CalibCols" type="number" min="3" max="15" step="1" dir="ltr" value="9" />`)} <span>×</span> ${opticsNumber(`<input id="${camId}CalibRows" type="number" min="3" max="15" step="1" dir="ltr" value="6" />`)}</label>
      <label><span class="optics-field-name">צלע מ״מ</span> ${opticsNumber(`<input id="${camId}CalibSquare" type="number" min="5" max="100" step="1" dir="ltr" value="25" />`)}</label>
      <button type="button" id="${camId}CalibStart" class="cam0-btn" disabled>התחל כיול</button>
      <span id="${camId}CalibProgress" class="optics-field-name">0/20</span>
      <button type="button" id="${camId}CalibSave" class="cam0-btn" disabled>שמירה</button>
      <button type="button" id="${camId}CalibRetry" class="cam0-btn" disabled>שוב</button>
      <a id="${camId}CalibBoard" class="optics-calib-board" href="/docs/calibration-board.pdf">לוח להדפסה</a>
      <p id="${camId}CalibHint" class="optics-field-note" hidden></p>
      <p id="${camId}CalibState" class="cam0-calib-state">עדיין אין כיול.</p>
    </section>
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
    bindOpticsSteppers(host);
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

if (typeof document !== 'undefined') {
  mountCameraSettings(document);
  bindOpticsSteppers(document);
}
