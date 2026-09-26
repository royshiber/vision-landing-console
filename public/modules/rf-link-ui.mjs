/** RF reduced UI. The console keeps telemetry and the existing command allowlist. */

export const RF_REDUCED_REASON_HE = 'במצב RF אין וידאו ואין גישה למחשב המשימה';

export function rfUiLocked() {
  return typeof document !== 'undefined' && document.body?.dataset?.workPath === 'rf';
}
