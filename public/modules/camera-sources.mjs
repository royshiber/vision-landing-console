/**
 * Generic camera source list. PR #147 can bind its horizon picker to
 * [data-camera-source-picker]. Cam0 uses אין אות when the stream is absent.
 */

export const CAMERA_SOURCES = Object.freeze([
  { id: 'cam0', labelHe: 'אפס', emptyHe: 'אין אות' },
  { id: 'cam1', labelHe: 'קדמית', emptyHe: 'אין פריים' },
  { id: 'cam2', labelHe: 'מטה', emptyHe: 'אין פריים' },
  { id: 'cam3', labelHe: 'גימבל', emptyHe: 'אין פריים' },
]);

export function cameraFrameUrl(id, stamp = Date.now()) {
  return `/api/jetson/v1/cameras/${encodeURIComponent(id)}/frame.jpg?t=${stamp}`;
}

export function fillCameraSourcePicker(select, sources = CAMERA_SOURCES) {
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  for (const src of sources) {
    const opt = document.createElement('option');
    opt.value = src.id;
    opt.textContent = src.labelHe;
    select.append(opt);
  }
  if (current) select.value = current;
}

export function bindCameraSourcePickers(root = document) {
  const nodes = root.querySelectorAll('[data-camera-source-picker], #horizonBgPicker');
  nodes.forEach((node) => fillCameraSourcePicker(node));
}
