/** Explicit QA switch. Mock tracks, quiet external calls, and skipping the model chain. */

export function vlcQaEnabled(env = process.env) {
  const value = String(env.VLC_QA || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
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
