/**
 * Build tests/fixtures/flight-logs in the v1 bucket layout.
 * Deterministic. Israeli field coordinates, not a street address.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/flight-logs');
const FIELD = { lat: 31.8234, lon: 34.7762 };

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function iso(baseMs, rel) {
  return new Date(baseMs + rel * 1000).toISOString();
}
function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}
function gz(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return zlib.gzipSync(Buffer.from(text));
}
function write(rel, buf) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  return { bytes: buf.length, sha256: sha256(buf) };
}
function modeAt(modes, t) {
  return modes.find((m) => t >= m.from && t < m.to)?.mode || modes[modes.length - 1].mode;
}

function buildSeries(armMs, dur, _modes, opts = {}) {
  const { altPeak = 80, spd = 18, omit = [], ground = false } = opts;
  const names = {
    alt_rel_m: 'm',
    airspeed_mps: 'm/s',
    groundspeed_mps: 'm/s',
    climb_mps: 'm/s',
    throttle_pct: '%',
    roll_deg: 'deg',
    pitch_deg: 'deg',
    batt_v: 'V',
    batt_a: 'A',
    gps_sats: '',
    gps_hdop: '',
  };
  const t = [];
  const cols = Object.fromEntries(Object.keys(names).map((k) => [k, []]));
  for (let s = 0; s <= dur; s += 0.5) {
    const u = dur ? s / dur : 0;
    const airborne = !ground && s >= 40 && s < dur - 40;
    const alt = airborne ? altPeak * Math.sin(Math.PI * Math.min(1, Math.max(0, (s - 40) / (dur - 80)))) : 1.2 + 0.3 * Math.sin(s);
    t.push(round(s, 1));
    cols.alt_rel_m.push(round(Math.max(0, alt), 2));
    cols.airspeed_mps.push(round(airborne ? spd + 2 * Math.sin(s / 40) : 3 + Math.sin(s), 2));
    cols.groundspeed_mps.push(round(airborne ? spd + 1.5 + Math.sin(s / 30) : 0.4, 2));
    cols.climb_mps.push(round(airborne ? (u < 0.5 ? 1.2 : -1.1) : 0, 2));
    cols.throttle_pct.push(round(airborne ? 62 + 8 * Math.sin(s / 20) : 0, 1));
    cols.roll_deg.push(round(airborne ? 12 * Math.sin(s / 25) : 0.4, 2));
    cols.pitch_deg.push(round(airborne ? 4 * Math.sin(s / 18) : 1, 2));
    cols.batt_v.push(round(25.2 - u * 1.4, 2));
    cols.batt_a.push(round(airborne ? 18 + Math.sin(s / 15) : 1.2, 2));
    cols.gps_sats.push(s > dur * 0.62 && s < dur * 0.64 ? 7 : 14);
    cols.gps_hdop.push(round(s > dur * 0.62 && s < dur * 0.64 ? 2.4 : 0.9, 2));
  }
  const series = {};
  for (const [name, unit] of Object.entries(names)) {
    if (omit.includes(name)) continue;
    series[name] = { t, v: cols[name], unit, src: 'tlog' };
  }
  return { t0_utc: new Date(armMs).toISOString(), series };
}

function buildTrack(dur, modes, altPeak) {
  const features = [];
  for (const band of modes) {
    const coords = [];
    for (let s = band.from; s <= band.to; s += 1) {
      const u = dur ? s / dur : 0;
      const lat = FIELD.lat + 0.02 * Math.sin(u * Math.PI);
      const lon = FIELD.lon + 0.03 * u;
      const alt = altPeak * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
      coords.push([round(lon, 5), round(lat, 5), round(Math.max(0, alt), 1)]);
    }
    if (coords.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { mode: band.mode, from_rel_s: band.from, to_rel_s: band.to },
      });
    }
  }
  const take = features[0]?.geometry.coordinates[1] || [FIELD.lon, FIELD.lat, 0];
  const lastLine = features[features.length - 1];
  const land = lastLine ? lastLine.geometry.coordinates[lastLine.geometry.coordinates.length - 1] : take;
  features.push(
    { type: 'Feature', geometry: { type: 'Point', coordinates: [FIELD.lon, FIELD.lat, 0] }, properties: { kind: 'home' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: take }, properties: { kind: 'takeoff' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: land }, properties: { kind: 'landing' } },
  );
  return { type: 'FeatureCollection', features };
}

function ev(id, armMs, rel, src, type, sev, msg, msgHe, extra = {}) {
  return {
    id,
    t_utc: iso(armMs, rel),
    t_rel_s: rel,
    src,
    type,
    sev,
    msg,
    msg_he: msgHe,
    data: extra.data || null,
    origin: extra.origin || 'tlog',
    cause_id: extra.cause_id || null,
    count: extra.count || 1,
    last_t_rel_s: extra.last_t_rel_s ?? null,
  };
}

function art(vehicle, id, name, kind, file, state, reason, chunked = false) {
  const key = `v1/${vehicle}/flights/${id}/${name}`;
  return {
    name,
    kind,
    key,
    bytes: file ? file.bytes : null,
    sha256: file ? file.sha256 : null,
    state,
    reason,
    chunked,
  };
}

function emitFlight(spec) {
  const vehicle = 'airvix01';
  const base = `v1/${vehicle}`;
  const id = spec.id;
  const armMs = Date.parse(spec.arm);
  const events = spec.events(armMs);
  const series = buildSeries(armMs, spec.dur, spec.modeBands, {
    altPeak: spec.altPeak,
    spd: 18,
    ground: spec.classification === 'bench',
    ...(spec.seriesOpts || {}),
  });
  const track = spec.classification === 'bench'
    ? { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [FIELD.lon, FIELD.lat, 0] }, properties: { kind: 'home', mode: 'MANUAL' } },
    ] }
    : buildTrack(spec.dur, spec.modeBands, spec.altPeak || 80);
  if (spec.warningPoint) {
    track.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round(FIELD.lon + 0.01, 5), round(FIELD.lat + 0.008, 5), 90] },
      properties: { kind: 'warning', sev: 'warning', t_rel_s: spec.warningPoint, id: spec.warningId },
    });
  }
  const eventsGz = write(`${base}/flights/${id}/events.jsonl.gz`, gz(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  const seriesGz = write(`${base}/flights/${id}/series.json.gz`, gz(series));
  const trackGz = write(`${base}/flights/${id}/track.geojson.gz`, gz(track));
  const tlogGz = write(`${base}/flights/${id}/telemetry.tlog.gz`, gz(`tlog-fixture ${id}\n`));
  let bin = null;
  if (spec.chunkedBin) {
    const payload = zlib.gzipSync(Buffer.from(`AIRVIX FC LOG ${id} `.repeat(40)));
    const mid = Math.floor(payload.length / 2);
    const p1 = payload.subarray(0, mid);
    const p2 = payload.subarray(mid);
    const n1 = write(`${base}/flights/${id}/fc/00000042.BIN.gz.part0001`, p1);
    const n2 = write(`${base}/flights/${id}/fc/00000042.BIN.gz.part0002`, p2);
    const parts = {
      parts: [
        { n: 1, bytes: p1.length, sha256: n1.sha256 },
        { n: 2, bytes: p2.length, sha256: n2.sha256 },
      ],
      bytes: payload.length,
      sha256: sha256(payload),
    };
    write(`${base}/flights/${id}/fc/00000042.BIN.gz.parts.json`, Buffer.from(JSON.stringify(parts)));
    bin = { bytes: payload.length, sha256: parts.sha256 };
  }
  const summary = {
    schema: 'airvix.flight.summary/1',
    derive_rev: 1,
    sources: ['tlog'],
    stats: spec.stats,
    modes: spec.modeBands.map((m) => ({
      mode: m.mode, from_rel_s: m.from, to_rel_s: m.to, dur_s: round(m.to - m.from, 1),
    })),
    takeoff: spec.takeoff,
    landing: spec.landing,
    facts: spec.facts,
    insights: spec.insights,
    coverage: spec.coverage,
  };
  const summaryFile = write(`${base}/flights/${id}/summary.json`, Buffer.from(JSON.stringify(summary)));
  const artifacts = [
    art(vehicle, id, 'summary.json', 'summary', summaryFile, 'uploaded', null),
    art(vehicle, id, 'events.jsonl.gz', 'events', eventsGz, 'uploaded', null),
    art(vehicle, id, 'series.json.gz', 'series', seriesGz, 'uploaded', null),
    art(vehicle, id, 'track.geojson.gz', 'track', trackGz, 'uploaded', null),
    art(vehicle, id, 'telemetry.tlog.gz', 'tlog', tlogGz, 'uploaded', null),
  ];
  if (spec.chunkedBin) {
    artifacts.push({
      name: 'fc/00000042.BIN.gz',
      kind: 'fc_bin',
      key: `v1/${vehicle}/flights/${id}/fc/00000042.BIN.gz`,
      bytes: bin.bytes,
      sha256: bin.sha256,
      state: 'uploaded',
      reason: null,
      chunked: true,
    });
  }
  if (spec.binPending) {
    artifacts.push({
      name: 'fc/00000043.BIN.gz',
      kind: 'fc_bin',
      key: `v1/${vehicle}/flights/${id}/fc/00000043.BIN.gz`,
      bytes: null,
      sha256: null,
      state: 'pending',
      reason: 'fc_off',
      chunked: false,
    });
  }
  if (spec.journal === 'ok') {
    const j = write(`${base}/flights/${id}/jetson/journal.jsonl.gz`, gz('{"MESSAGE":"flightlog ok"}\n'));
    artifacts.push(art(vehicle, id, 'jetson/journal.jsonl.gz', 'journal', j, 'uploaded', null));
  } else if (spec.journal === 'denied') {
    artifacts.push({
      name: 'jetson/journal.jsonl.gz',
      kind: 'journal',
      key: `v1/${vehicle}/flights/${id}/jetson/journal.jsonl.gz`,
      bytes: null,
      sha256: null,
      state: 'unavailable',
      reason: 'no_journal_permission',
      chunked: false,
    });
  }
  const manifest = {
    schema: 'airvix.flight.manifest/1',
    manifest_rev: spec.rev,
    flight_id: id,
    vehicle_id: vehicle,
    classification: spec.classification,
    state: spec.state,
    end_reason: spec.end,
    times: {
      arm_utc: spec.arm,
      takeoff_utc: spec.takeoffUtc,
      landed_utc: spec.landedUtc,
      disarm_utc: spec.disarmUtc,
      window_start_utc: iso(armMs, -60),
      window_end_utc: iso(armMs, spec.dur + 30),
      time_source: spec.timeSource,
      jetson_minus_fc_s: spec.timeSource === 'jetson_unsynced' ? null : 0.12,
    },
    segments: spec.segments,
    detector: {
      version: '1.0.0',
      params: { ASPD_MIN: 9, GSPD_MIN: 8, ALT_MIN: 8, CONFIRM_S: 5 },
      evidence: spec.evidence,
    },
    versions: { companion_agent: '2.3.6', flightlog: '0.1.0', derive_rev: 1, fc_firmware: 'ArduPlane V4.5.7', fc_sysid: 1 },
    artifacts,
    counts: {
      events: events.length,
      warnings: spec.warnings,
      errors: spec.errors,
      critical: spec.critical,
    },
    upload: { network_used: ['wifi'], cellular_bytes: 0 },
    created_utc: spec.disarmUtc || spec.arm,
    updated_utc: spec.updated,
  };
  write(`${base}/flights/${id}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
  const index = {
    schema: 'airvix.flight.index/1',
    flight_id: id,
    vehicle_id: vehicle,
    classification: spec.classification,
    state: spec.state,
    manifest_rev: spec.rev,
    arm_utc: spec.arm,
    takeoff_utc: spec.takeoffUtc,
    landed_utc: spec.landedUtc,
    disarm_utc: spec.disarmUtc,
    time_source: spec.timeSource,
    duration_s: spec.stats.duration_s,
    air_time_s: spec.stats.air_time_s,
    max_rel_alt_m: spec.stats.max_rel_alt_m,
    max_airspeed_mps: spec.stats.max_airspeed_mps,
    max_groundspeed_mps: spec.stats.max_groundspeed_mps,
    distance_m: spec.stats.distance_m,
    modes: spec.modeBands.map((m) => m.mode),
    warnings: spec.warnings,
    errors: spec.errors,
    critical: spec.critical,
    end_reason: spec.end,
    has_fc_log: Boolean(spec.chunkedBin),
    artifacts_pending: spec.binPending ? 1 : 0,
    updated_utc: spec.updated,
  };
  write(`${base}/index/${id}.json`, Buffer.from(JSON.stringify(index)));
}

fs.rmSync(root, { recursive: true, force: true });

const A_ARM = '2026-09-20T07:00:00.000Z';
const A_MS = Date.parse(A_ARM);
emitFlight({
  id: '20260920T070000Z-airvix01-a1b2',
  arm: A_ARM,
  dur: 1140,
  rev: 4,
  classification: 'flight',
  state: 'complete',
  end: 'disarmed',
  timeSource: 'ntp',
  takeoffUtc: iso(A_MS, 42),
  landedUtc: iso(A_MS, 1100),
  disarmUtc: iso(A_MS, 1140),
  updated: '2026-09-20T07:22:00.000Z',
  warnings: 3,
  errors: 0,
  critical: 0,
  altPeak: 121.6,
  chunkedBin: true,
  journal: 'ok',
  warningPoint: 720,
  warningId: 'E0006',
  modeBands: [
    { mode: 'FBWA', from: 0, to: 180 },
    { mode: 'AUTO', from: 180, to: 900 },
    { mode: 'RTL', from: 900, to: 1140 },
  ],
  segments: [{ n: 1, takeoff_utc: iso(A_MS, 42), landed_utc: iso(A_MS, 1100), air_time_s: 1058 }],
  takeoff: { lat: 31.824, lon: 34.777, t_rel_s: 42 },
  landing: { lat: 31.838, lon: 34.804, t_rel_s: 1100 },
  stats: {
    duration_s: 1140, air_time_s: 1058, max_rel_alt_m: 121.6, max_airspeed_mps: 22.4,
    max_groundspeed_mps: 24.1, distance_m: 18420, max_dist_home_m: 2310,
    batt_min_v: 23.8, batt_used_mah: 3120, gps_min_sats: 7, gps_max_hdop: 2.4, hb_max_gap_s: 0.9,
  },
  facts: [
    { id: 'F1', key: 'max_rel_alt_m', value: 121.6, unit: 'm', t_rel_s: 570, src: 'tlog.GLOBAL_POSITION_INT' },
    { id: 'F2', key: 'distance_m', value: 18420, unit: 'm', t_rel_s: 1100, src: 'tlog' },
  ],
  insights: [
    { id: 'I1', rule: 'gps_low_sats', sev: 'warning', text_he: 'לווייני GPS ירדו ל־7 לזמן קצר באמצע הטיסה.', from_rel_s: 700, to_rel_s: 730, evidence: ['E0006', 'F1'] },
    { id: 'I2', rule: 'battery_sag', sev: 'warning', text_he: 'המתח ירד במהלך הטיסה אך נשאר מעל סף האזהרה הקשה.', from_rel_s: 800, to_rel_s: 900, evidence: ['E0007'] },
  ],
  coverage: { VFR_HUD: 0.99, GLOBAL_POSITION_INT: 0.99, GPS_RAW_INT: 0.98, SYSTEM_TIME: 1 },
  evidence: { takeoff: { rule: 'alt_and_speed', t_utc: iso(A_MS, 42), values: { rel_alt_m: 9.4, airspeed_mps: 14.2, groundspeed_mps: 13.1, disp_m: 61 } } },
  events(armMs) {
    const rows = [
      ev('E0001', armMs, 0, 'fc', 'fc.arm', 'notice', 'Armed', 'הבקר חומש', { data: { armed: true } }),
      ev('E0002', armMs, 1, 'fc', 'fc.home_set', 'info', 'Home set', 'נקודת הבית נקבעה'),
      ev('E0003', armMs, 42, 'flight', 'flight.takeoff', 'notice', 'Takeoff', 'המראה', { data: { rule: 'alt_and_speed' } }),
      ev('E0004', armMs, 180, 'fc', 'fc.mode_change', 'info', 'Mode FBWA → AUTO', 'מצב טיסה FBWA ← AUTO', { data: { from: 'FBWA', to: 'AUTO' } }),
      ev('E0005', armMs, 640, 'fc', 'fc.ekf_flags', 'warning', 'EKF lane switch', 'EKF החליף נתיב', { data: { flags: 'lane' } }),
      ev('E0006', armMs, 710, 'fc', 'fc.statustext', 'warning', 'GPS sats low', 'מעט לווייני GPS', { data: { sats: 7 } }),
      ev('E0007', armMs, 860, 'fc', 'fc.battery', 'warning', 'Battery 23.9V', 'מתח סוללה 23.9V', { data: { v: 23.9 } }),
      ev('E0008', armMs, 900, 'fc', 'fc.mode_change', 'notice', 'Mode AUTO → RTL', 'מצב טיסה AUTO ← RTL', { data: { from: 'AUTO', to: 'RTL' } }),
      ev('E0009', armMs, 1100, 'flight', 'flight.landed', 'notice', 'Landed', 'נחיתה'),
      ev('E0010', armMs, 1140, 'fc', 'fc.disarm', 'notice', 'Disarmed', 'הבקר כובה'),
    ];
    for (let i = 0; i < 28; i++) {
      const rel = 200 + i * 24;
      rows.push(ev(`E01${String(i).padStart(2, '0')}`, armMs, rel, 'fc', 'fc.mission_item_reached', 'info', `WP ${i + 1}`, `נקודת מסלול ${i + 1}`, { data: { seq: i + 1 } }));
    }
    rows.sort((a, b) => a.t_rel_s - b.t_rel_s || a.id.localeCompare(b.id));
    return rows;
  },
});

const B_ARM = '2026-09-21T08:00:00.000Z';
const B_MS = Date.parse(B_ARM);
emitFlight({
  id: '20260921T080000Z-airvix01-c3d4',
  arm: B_ARM,
  dur: 480,
  rev: 2,
  classification: 'flight',
  state: 'awaiting_fc_log',
  end: 'disarmed',
  timeSource: 'fc_system_time',
  takeoffUtc: iso(B_MS, 36),
  landedUtc: iso(B_MS, 450),
  disarmUtc: iso(B_MS, 480),
  updated: '2026-09-21T08:12:00.000Z',
  warnings: 1,
  errors: 1,
  critical: 0,
  altPeak: 86,
  binPending: true,
  journal: 'ok',
  warningPoint: 210,
  warningId: 'E0004',
  seriesOpts: { spd: 18, altPeak: 86 },
  modeBands: [
    { mode: 'FBWA', from: 0, to: 210 },
    { mode: 'RTL', from: 210, to: 480 },
  ],
  segments: [{ n: 1, takeoff_utc: iso(B_MS, 36), landed_utc: iso(B_MS, 450), air_time_s: 414 }],
  takeoff: { lat: 31.824, lon: 34.777, t_rel_s: 36 },
  landing: { lat: 31.83, lon: 34.786, t_rel_s: 450 },
  stats: {
    duration_s: 480, air_time_s: 414, max_rel_alt_m: 86, max_airspeed_mps: 20.2,
    max_groundspeed_mps: 27.4, distance_m: 6400, batt_min_v: 24.1, gps_min_sats: 5, gps_max_hdop: 3.1,
  },
  facts: [
    { id: 'F1', key: 'max_rel_alt_m', value: 86, unit: 'm', t_rel_s: 240, src: 'tlog.GLOBAL_POSITION_INT' },
  ],
  insights: [
    { id: 'I1', rule: 'failsafe_mode', sev: 'error', text_he: 'אובדן רדיו הוביל למעבר ל־RTL תוך שניות.', from_rel_s: 208, to_rel_s: 212, evidence: ['E0005', 'E0006'] },
    { id: 'I2', rule: 'gps_glitch', sev: 'warning', text_he: 'חשד לגליץ GPS: קפיצת מהירות קרקע בלי שינוי במהירות אוויר.', from_rel_s: 200, to_rel_s: 206, evidence: ['E0004'] },
  ],
  coverage: { VFR_HUD: 0.97, GLOBAL_POSITION_INT: 0.95, GPS_RAW_INT: 0.9, SYSTEM_TIME: 1 },
  evidence: { takeoff: { rule: 'alt_and_speed', t_utc: iso(B_MS, 36), values: { rel_alt_m: 11, airspeed_mps: 15, groundspeed_mps: 14, disp_m: 40 } } },
  events(armMs) {
    return [
      ev('E0001', armMs, 0, 'fc', 'fc.arm', 'notice', 'Armed', 'הבקר חומש'),
      ev('E0002', armMs, 36, 'flight', 'flight.takeoff', 'notice', 'Takeoff', 'המראה'),
      ev('E0003', armMs, 80, 'fc', 'fc.mode_change', 'info', 'Mode MANUAL → FBWA', 'מצב טיסה MANUAL ← FBWA', { data: { from: 'MANUAL', to: 'FBWA' } }),
      ev('E0004', armMs, 200, 'fc', 'fc.gps_glitch_suspected', 'warning', 'GPS glitch suspected', 'חשד לגליץ GPS', { data: { groundspeed_mps: 27 } }),
      ev('E0005', armMs, 208, 'fc', 'fc.failsafe', 'error', 'Radio failsafe', 'כשל רדיו', { data: { kind: 'radio' } }),
      ev('E0006', armMs, 210, 'fc', 'fc.mode_change', 'warning', 'Mode FBWA → RTL', 'מצב טיסה FBWA ← RTL', { data: { from: 'FBWA', to: 'RTL' }, cause_id: 'E0005' }),
      ev('E0007', armMs, 450, 'flight', 'flight.landed', 'notice', 'Landed', 'נחיתה'),
      ev('E0008', armMs, 480, 'fc', 'fc.disarm', 'notice', 'Disarmed', 'הבקר כובה'),
      ev('E0009', armMs, 300, 'link', 'link.modem_state', 'info', 'Wi-Fi', 'קישור אלחוטי'),
    ].sort((a, b) => a.t_rel_s - b.t_rel_s);
  },
});

const C_ARM = '2026-09-22T06:00:00.000Z';
const C_MS = Date.parse(C_ARM);
emitFlight({
  id: '20260922T060000Z-airvix01-e5f6',
  arm: C_ARM,
  dur: 180,
  rev: 1,
  classification: 'bench',
  state: 'complete',
  end: 'disarmed',
  timeSource: 'jetson_unsynced',
  takeoffUtc: null,
  landedUtc: null,
  disarmUtc: iso(C_MS, 180),
  updated: '2026-09-22T06:04:00.000Z',
  warnings: 0,
  errors: 0,
  critical: 0,
  altPeak: 2,
  journal: 'ok',
  seriesOpts: { spd: 2, altPeak: 2 },
  modeBands: [{ mode: 'MANUAL', from: 0, to: 180 }],
  segments: [],
  takeoff: null,
  landing: null,
  stats: {
    duration_s: 180, air_time_s: 0, max_rel_alt_m: 1.6, max_airspeed_mps: 4.2,
    max_groundspeed_mps: 0.8, distance_m: 6,
  },
  facts: [
    { id: 'F1', key: 'max_rel_alt_m', value: 1.6, unit: 'm', t_rel_s: 90, src: 'tlog.GLOBAL_POSITION_INT' },
  ],
  insights: [
    { id: 'I1', rule: 'bench', sev: 'info', text_he: 'סשן קרקע: לא זוהתה המראה.', from_rel_s: 0, to_rel_s: 180, evidence: ['E0001'] },
  ],
  coverage: { VFR_HUD: 1, GLOBAL_POSITION_INT: 1, GPS_RAW_INT: 1, SYSTEM_TIME: 0 },
  evidence: { takeoff: { rule: 'none', t_utc: null, values: { rel_alt_m: 1.1, airspeed_mps: 3.2, groundspeed_mps: 0.4, disp_m: 4 } } },
  events(armMs) {
    return [
      ev('E0001', armMs, 0, 'fc', 'fc.arm', 'notice', 'Armed on bench', 'חימוש על הקרקע'),
      ev('E0002', armMs, 40, 'fc', 'fc.statustext', 'info', 'PreArm OK', 'בדיקות לפני חימוש תקינות'),
      ev('E0003', armMs, 180, 'fc', 'fc.disarm', 'notice', 'Disarmed', 'הבקר כובה'),
    ];
  },
});

const D_ARM = '2026-09-23T10:00:00.000Z';
const D_MS = Date.parse(D_ARM);
emitFlight({
  id: '20260923T100000Z-airvix01-0789',
  arm: D_ARM,
  dur: 600,
  rev: 3,
  classification: 'flight',
  state: 'partial',
  end: 'disarmed',
  timeSource: 'ntp',
  takeoffUtc: iso(D_MS, 30),
  landedUtc: iso(D_MS, 560),
  disarmUtc: iso(D_MS, 600),
  updated: '2026-09-23T10:14:00.000Z',
  warnings: 1,
  errors: 0,
  critical: 0,
  altPeak: 70,
  journal: 'denied',
  seriesOpts: { spd: 16, altPeak: 70, omit: ['throttle_pct'] },
  modeBands: [
    { mode: 'FBWA', from: 0, to: 120 },
    { mode: 'AUTO', from: 120, to: 600 },
  ],
  segments: [{ n: 1, takeoff_utc: iso(D_MS, 30), landed_utc: iso(D_MS, 560), air_time_s: 530 }],
  takeoff: { lat: 31.824, lon: 34.778, t_rel_s: 30 },
  landing: { lat: 31.832, lon: 34.792, t_rel_s: 560 },
  stats: {
    duration_s: 600, air_time_s: 530, max_rel_alt_m: 70, max_airspeed_mps: 18.4,
    max_groundspeed_mps: 19.1, distance_m: 9200,
  },
  facts: [
    { id: 'F1', key: 'max_rel_alt_m', value: 70, unit: 'm', t_rel_s: 300, src: 'tlog.GLOBAL_POSITION_INT' },
  ],
  insights: [
    { id: 'I1', rule: 'journal_missing', sev: 'warning', text_he: 'יומן המערכת חסר: אין הרשאת journal. התמונה חלקית.', from_rel_s: 0, to_rel_s: 600, evidence: ['E0004'] },
  ],
  coverage: { VFR_HUD: 0.96, GLOBAL_POSITION_INT: 0.96, GPS_RAW_INT: 0.94, SYSTEM_TIME: 0.5 },
  evidence: { takeoff: { rule: 'alt_and_speed', t_utc: iso(D_MS, 30), values: { rel_alt_m: 10, airspeed_mps: 13, groundspeed_mps: 12, disp_m: 35 } } },
  events(armMs) {
    return [
      ev('E0001', armMs, 0, 'fc', 'fc.arm', 'notice', 'Armed', 'הבקר חומש'),
      ev('E0002', armMs, 30, 'flight', 'flight.takeoff', 'notice', 'Takeoff', 'המראה'),
      ev('E0003', armMs, 120, 'fc', 'fc.mode_change', 'info', 'Mode FBWA → AUTO', 'מצב טיסה FBWA ← AUTO', { data: { from: 'FBWA', to: 'AUTO' } }),
      ev('E0004', armMs, 10, 'system', 'companion.disk_low', 'warning', 'Journal unavailable', 'יומן המערכת לא זמין', { origin: 'journal', data: { reason: 'no_journal_permission' } }),
      ev('E0005', armMs, 560, 'flight', 'flight.landed', 'notice', 'Landed', 'נחיתה'),
      ev('E0006', armMs, 600, 'fc', 'fc.disarm', 'notice', 'Disarmed', 'הבקר כובה'),
    ];
  },
});

console.log('fixtures written', root);
