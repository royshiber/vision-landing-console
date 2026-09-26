/**
 * Windows ArduPlane SITL launch plan.
 * The binary is the Mission Planner stable build on firmware.ardupilot.org.
 * This module only builds the plan. The PowerShell launcher downloads and starts it.
 */

export const SITL_STABLE_BASE_URL = 'https://firmware.ardupilot.org/Tools/MissionPlanner/sitl/Stable/';

/** Cygwin runtime shipped next to ArduPlane.elf in the Mission Planner stable folder. */
export const SITL_STABLE_FILES = Object.freeze([
  Object.freeze({ name: 'ArduPlane.elf', minBytes: 1_000_000 }),
  Object.freeze({ name: 'cygwin1.dll', minBytes: 100_000 }),
  Object.freeze({ name: 'cyggcc_s-seh-1.dll', minBytes: 10_000 }),
  Object.freeze({ name: 'cygstdc++-6.dll', minBytes: 100_000 }),
  Object.freeze({ name: 'cygiconv-2.dll', minBytes: 10_000 }),
  Object.freeze({ name: 'cygintl-8.dll', minBytes: 10_000 }),
  Object.freeze({ name: 'cygatomic-1.dll', minBytes: 1_000 }),
  Object.freeze({ name: 'cyggcc_s-1.dll', minBytes: 1_000 }),
  Object.freeze({ name: 'cyggomp-1.dll', minBytes: 1_000 }),
  Object.freeze({ name: 'cygquadmath-0.dll', minBytes: 1_000 }),
  Object.freeze({ name: 'cygssp-0.dll', minBytes: 1_000 }),
  Object.freeze({ name: 'git.txt', minBytes: 8 }),
]);

/** Near Tel Aviv, a few metres above the field, heading east. */
export const DEFAULT_SITL_HOME = Object.freeze({
  lat: 32.0853,
  lon: 34.7818,
  altM: 15,
  hdg: 90,
});

export const SITL_BINARY_NAME = 'ArduPlane.elf';
export const SITL_CACHE_DIR_NAME = 'Stable';

function fail(message) {
  const err = new Error(message);
  err.hebrew = true;
  throw err;
}

function finite(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) fail('ערך מספרי לא תקין בהגדרות ההפעלה.');
  return n;
}

function formatNum(n) {
  const rounded = Math.round(n * 1e4) / 1e4;
  return String(rounded);
}

export function formatSitlHome(home) {
  return `${formatNum(home.lat)},${formatNum(home.lon)},${formatNum(home.altM)},${formatNum(home.hdg)}`;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.lat]
 * @param {number} [opts.lon]
 * @param {number} [opts.altM]
 * @param {number} [opts.hdg]
 * @param {'plane'|'flightaxis'} [opts.physics]
 * @param {string} [opts.flightAxisHost]
 * @param {number} [opts.tcpPort]
 * @param {number} [opts.gcsUdpPort]
 * @param {boolean} [opts.gcsUdp]
 * @param {number} [opts.speedup]
 * @param {string} [opts.defaultsPath]
 */
export function buildSitlLaunchPlan(opts = {}) {
  const lat = finite(opts.lat, DEFAULT_SITL_HOME.lat);
  const lon = finite(opts.lon, DEFAULT_SITL_HOME.lon);
  const altM = finite(opts.altM, DEFAULT_SITL_HOME.altM);
  const hdg = finite(opts.hdg, DEFAULT_SITL_HOME.hdg);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    fail('מיקום הבית מחוץ לטווח. בדקו קו רוחב וקו אורך.');
  }
  if (altM < -500 || altM > 10000) fail('גובה הבית לא סביר.');
  if (hdg < 0 || hdg > 360) fail('כיוון הבית חייב להיות בין אפס לשלוש מאות ושישים.');

  const physics = opts.physics == null || opts.physics === '' ? 'plane' : String(opts.physics);
  if (physics !== 'plane' && physics !== 'flightaxis') {
    fail('סוג הפיזיקה חייב להיות מטוס מובנה או ריאלפלייט.');
  }
  const flightAxisHost = String(opts.flightAxisHost || '127.0.0.1').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(flightAxisHost)) {
    fail('כתובת ריאלפלייט אינה תקינה.');
  }

  const tcpPort = finite(opts.tcpPort, 5760);
  const gcsUdp = opts.gcsUdp !== false;
  const gcsUdpPort = finite(opts.gcsUdpPort, 14550);
  for (const port of [tcpPort, gcsUdpPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('פורט לא תקין.');
  }
  if (gcsUdp && tcpPort === gcsUdpPort) fail('פורט הקונסולה ופורט התחנה השנייה חייבים להיות שונים.');

  const speedup = finite(opts.speedup, 1);
  if (speedup < 0.1 || speedup > 20) fail('מהירות הסימולציה מחוץ לטווח.');

  const defaultsPath = opts.defaultsPath != null && String(opts.defaultsPath).trim()
    ? String(opts.defaultsPath).trim()
    : '';
  if (defaultsPath.startsWith('-')) fail('נתיב קובץ ברירת המחדל אינו תקין.');

  const model = physics === 'flightaxis' ? `flightaxis:${flightAxisHost}` : 'plane';
  const home = { lat, lon, altM, hdg };
  const argv = [
    '--model', model,
    '--speedup', String(speedup),
    '--home', formatSitlHome(home),
    '--serial0', `tcp:${tcpPort}`,
  ];
  if (gcsUdp) argv.push('--serial1', `udpclient:127.0.0.1:${gcsUdpPort}`);
  if (defaultsPath) argv.push('--defaults', defaultsPath);

  const messages = {
    downloading: 'מורידים את הסימולטור הרשמי. זה יכול לקחת דקה.',
    cached: 'העותק השמור תקין. לא מורידים שוב.',
    offlineCache: 'אין רשת. משתמשים בעותק השמור.',
    downloadFailed: 'ההורדה נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.',
    fileTooSmall: 'הקובץ שהתקבל קטן מדי. ההורדה לא הושלמה.',
    starting: 'מפעילים את הסימולטור.',
    running: 'הסימולטור רץ. בקונסולה לחצו על סימולטור.',
    alreadyRunning: 'הסימולטור כבר רץ. בקונסולה לחצו על סימולטור.',
    processDied: 'הסימולטור נסגר מיד. הפרטים למטה.',
    portClosed: 'הסימולטור לא פתח את פורט הקונסולה. הפרטים למטה.',
    nodeMissing: 'לא נמצא נוד. התקינו אותו ואז נסו שוב.',
    realflight: 'ריאלפלייט: פתחו את המשחק והפעילו את קישור פלייטאקסיס לפני ההפעלה. בלי זה הסימולטור ייסגר.',
  };

  return {
    baseUrl: SITL_STABLE_BASE_URL,
    cacheDirName: SITL_CACHE_DIR_NAME,
    binary: SITL_BINARY_NAME,
    files: SITL_STABLE_FILES.map((file) => ({
      name: file.name,
      minBytes: file.minBytes,
      url: `${SITL_STABLE_BASE_URL}${file.name}`,
    })),
    physics,
    model,
    home,
    homeArg: formatSitlHome(home),
    speedup,
    tcp: { host: '127.0.0.1', port: tcpPort },
    gcsUdp: gcsUdp ? { host: '127.0.0.1', port: gcsUdpPort } : null,
    defaultsPath: defaultsPath || null,
    argv,
    messages,
  };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function parseCli(argv) {
  const physics = argValue(argv, '--physics');
  return buildSitlLaunchPlan({
    lat: argValue(argv, '--home-lat'),
    lon: argValue(argv, '--home-lon'),
    altM: argValue(argv, '--home-alt'),
    hdg: argValue(argv, '--home-hdg'),
    physics,
    flightAxisHost: argValue(argv, '--flightaxis-host'),
    tcpPort: argValue(argv, '--tcp-port'),
    gcsUdpPort: argValue(argv, '--gcs-udp-port'),
    gcsUdp: !argv.includes('--no-gcs-udp'),
    speedup: argValue(argv, '--speedup'),
    defaultsPath: argValue(argv, '--defaults'),
  });
}

const isDirect = process.argv[1] && process.argv[1].endsWith('sitl-launch-plan.mjs');
if (isDirect) {
  try {
    const plan = parseCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message || 'ההפעלה נכשלה.'}\n`);
    process.exit(1);
  }
}
