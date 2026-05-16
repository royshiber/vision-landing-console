/**
 * Why: /api/health/compatibility and Jetson/FC version checks. What: small semver helpers (x.y) — not full node-semver.
 */

export const COMPAT = {
  nodejsMinMajor: 18,
  agentMinVersion: '1.0.0',
  agentWarnVersion: '1.2.0',
  ardupilotMinMajor: 4,
  ardupilotMinMinor: 3,
};

export function semverParts(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

export function semverGte(v, min) {
  const a = semverParts(v);
  const b = semverParts(min);
  if (!a || !b) return false;
  return a.major > b.major || (a.major === b.major && a.minor >= b.minor);
}
