export const RF_VIDEO_REASON_HE = 'במצב RF אין וידאו';

export function rfVideoLocked() {
  return typeof document !== 'undefined' && document.body?.dataset?.workPath === 'rf';
}
