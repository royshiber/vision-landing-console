/**
 * Why: Vision Landing Console needs the same canonical release list as Aero-Lab for upgrades/rollback UI.
 * What: exported catalog of Jetson bundle versions with Hebrew/English notes (sync with aero-lab when bumping).
 *
 * Keep in sync with: apps/aero-lab-web/lib/jetson-release-catalog.ts
 */
export const DEFAULT_RELEASES = [
  {
    version: '1.02.57',
    channel: 'stable',
    date: '2026-04-03',
    notesHe: 'ניהול גרסאות Jetson + מסך סטטוס חי',
    notesEn: 'Jetson version manager + live status screen',
  },
  {
    version: '1.02.56',
    channel: 'stable',
    date: '2026-04-03',
    notesHe: 'שיפור telemetry bridge ויציבות כללית',
    notesEn: 'Telemetry bridge and runtime stability improvements',
  },
  {
    version: '1.02.54',
    channel: 'stable',
    date: '2026-03-25',
    notesHe: 'יישור עיצוב Aero-Lab',
    notesEn: 'Aero-Lab design alignment',
  },
  {
    version: '1.02.50',
    channel: 'legacy',
    date: '2026-03-24',
    notesHe: 'גרסת Rollback בטוחה',
    notesEn: 'Known-good rollback baseline',
  },
];

/** Why: install route must reject unknown bundle tags. What: true if version string matches a catalog entry. */
export function isKnownJetsonVersion(version) {
  return DEFAULT_RELEASES.some((r) => r.version === version);
}

/** Why: UI needs release metadata for notes/diff. What: returns release object or undefined. */
export function getJetsonReleaseByVersion(version) {
  return DEFAULT_RELEASES.find((r) => r.version === version);
}
