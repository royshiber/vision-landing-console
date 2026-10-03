/**
 * Roy's camera names. The optics tiles already show each camera's own picture.
 * cam0 is קדמית, cam1 is מטה, cam3 is גימבל.
 * Companion role words are not the name. A ceiling role never renames the gimbal.
 */

export const CAMERA_NAME_HE = Object.freeze({
  cam0: 'קדמית',
  cam1: 'מטה',
  cam3: 'גימבל',
});

const ID_ALIAS = Object.freeze({
  a8: 'cam3',
  gimbal: 'cam3',
});

export function cameraDisplayName(id) {
  const raw = String(id || '').trim().toLowerCase();
  const key = ID_ALIAS[raw] || raw;
  return CAMERA_NAME_HE[key] || '';
}
