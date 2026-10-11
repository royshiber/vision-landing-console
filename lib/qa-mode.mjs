/** Explicit QA switch. Mock tracks, quiet external calls, and skipping the model chain. */

export function vlcQaEnabled(env = process.env) {
  const value = String(env.VLC_QA || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * QA and tests must not open the GitHub update check.
 * The guard lives in check() so a page refresh cannot fetch after boot is skipped.
 * That fetch is the outbound HTTPS the box proxy holds (raw.githubusercontent.com via 198.18.0.1:443).
 */
export function remoteUpdateCheckPaused(env = process.env) {
  if (env.VITEST) return true;
  if (vlcQaEnabled(env)) return true;
  const test = String(env.VLC_TEST || '').trim().toLowerCase();
  return test === '1' || test === 'true' || test === 'yes';
}

/** Vitest, the QA flag, or a mock companion. Ask must not wait on a model. */
export function askRemotePaused(env = process.env) {
  if (env.VITEST) return true;
  if (vlcQaEnabled(env)) return true;
  return String(env.COMPANION_MODE || '').trim().toLowerCase() === 'mock';
}

/** Fixture tracks are allowed under Vitest or the explicit QA flag. */
export function visionFixtureAllowed(env = process.env) {
  return Boolean(env.VITEST) || vlcQaEnabled(env);
}
