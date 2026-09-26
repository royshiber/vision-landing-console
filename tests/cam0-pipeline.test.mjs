import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFrame } from '../public/modules/cam0-replay.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pyRoot = path.join(repoRoot, 'scripts', 'jetson-companion');
const agentPath = path.join(pyRoot, 'companion_agent.py');

function py(script) {
  const r = spawnSync('python3', ['-'], {
    input: script,
    encoding: 'utf8',
    cwd: pyRoot,
    env: { ...process.env, PYTHONPATH: pyRoot },
  });
  expect(r.status, r.stderr || r.stdout).toBe(0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('cam0 library', () => {
  it('keeps the 16-bit left-justified sample and a 1280x800 frame', () => {
    const out = py(`
import json, numpy as np
from cam0.rawfmt import pack_code10, to_code10, to_container12, to_mono8
from cam0.synthetic import roundtrip_sample
code = np.array([[0, 512, 1023]], np.uint16)
raw = pack_code10(code)
full, back = roundtrip_sample()
print(json.dumps({
  "code": to_code10(raw)[0].tolist(),
  "c12": int(to_container12(raw)[0,1]),
  "mono": int(to_mono8(raw)[0,2]),
  "shape": list(full.shape),
  "stored": int(full[0,0]),
  "back": int(back[0,0]),
}))
`);
    expect(out.code).toEqual([0, 512, 1023]);
    expect(out.c12).toBe(512 << 2);
    expect(out.mono).toBe(255);
    expect(out.shape).toEqual([800, 1280]);
    expect(out.stored).toBe(512 << 6);
    expect(out.back).toBe(512);
  });

  it('converges AE toward the mean target and prefers a short exposure', () => {
    const out = py(`
import json
from cam0.ae import AutoExposure
from cam0.rawfmt import mean_and_percentile
from cam0.synthetic import SyntheticSource
ae = AutoExposure(exposure_us=200, gain=16)
src = SyntheticSource(width=80, height=60, fps=200, marker_px=24)
for _ in range(30):
    src.set_exposure_gain(ae.state.exposure_us, ae.state.gain)
    frame = src.read()
    mean, pct = mean_and_percentile(frame["code10"], 90)
    ae.update(mean, pct)
ae.set_manual(1500, 48)
print(json.dumps({
  "exposure": ae.state.exposure_us,
  "gain": ae.state.gain,
  "mean": ae.state.mean,
  "manual": ae.state.manual,
  "prefer": ae.config.limits.prefer_exposure_us_max,
}))
`);
    expect(out.mean).toBeGreaterThan(0.2);
    expect(out.exposure).toBe(1500);
    expect(out.gain).toBe(48);
    expect(out.manual).toBe(true);
    expect(out.prefer).toBeLessThanOrEqual(8000);
  });

  it('detects a synthetic marker and does not send a vehicle command', () => {
    const marker = fs.readFileSync(path.join(pyRoot, 'cam0', 'marker.py'), 'utf8');
    expect(marker).not.toMatch(/command_long|set_mode_send|mavutil/);
    const out = py(`
import json
from cam0.marker import detect
from cam0.synthetic import SyntheticSource
src = SyntheticSource(width=160, height=120, fps=200, marker_px=54)
src.exposure_us = 2000
src.gain = 32
frame = src.read()
hits = detect(frame["mono8"], {"fx": 800, "fy": 800, "cx": 79.5, "cy": 59.5}, 0.16)
print(json.dumps({"id": hits[0]["id"] if hits else None, "n": len(hits), "distance": None if not hits else hits[0]["distance_m"], "commands": 0}))
`);
    expect(out.n).toBeGreaterThan(0);
    expect(out.id).toBe(7);
    expect(out.distance).toBeGreaterThan(0.2);
    expect(out.commands).toBe(0);
  });

  it('tags attitude from observed MAVLink and reports latency', () => {
    const out = py(`
import json, struct, time
from cam0.attitude import AttitudeTagger, CRC_EXTRA, MSG_ATTITUDE, MSG_SYSTEM_TIME, x25
def pack(msgid, payload, seq=1):
    head = bytes([0xFD, len(payload), 0, 0, seq, 51, 1]) + msgid.to_bytes(3, "little")
    crc = x25(head[1:] + payload + bytes([CRC_EXTRA[msgid]]))
    return head + payload + crc.to_bytes(2, "little")
tag = AttitudeTagger()
now = time.monotonic_ns()
unix_us = 1_700_000_000_000_000
sys = struct.pack("<QI", unix_us, 1000)
att = struct.pack("<Iffffff", 1000, 0.1, -0.2, 1.0, 0, 0, 0)
tag.observe(pack(MSG_SYSTEM_TIME, sys) + pack(MSG_ATTITUDE, att, 2), mono_ns=now, utc_ns=unix_us * 1000)
got = tag.tag(now + 1_000_000, unix_us * 1000 + 1_000_000)
print(json.dumps({
  "hb": CRC_EXTRA[0],
  "roll": None if not got["attitude"] else round(got["attitude"]["roll"], 3),
  "offset": got["clock_offset_ns"],
  "latency": got["latency_ms"],
  "source": got["clock_source"],
}))
`);
    expect(out.hb).toBe(50);
    expect(out.roll).toBeCloseTo(0.1, 2);
    expect(out.source).toBe('system_time');
    expect(out.latency).toBeGreaterThanOrEqual(0);
  });

  it('lets a slow subscriber drop frames without blocking publish', () => {
    const out = py(`
import json, time
import numpy as np
from cam0.bus import FrameBus
bus = FrameBus(name="cam0-test-bus", width=16, height=16, slots=2, keep_u16=False)
sub = bus.subscribe()
for i in range(5):
    bus.publish(np.full((16, 16), i, np.uint8), {"index": i})
time.sleep(0.05)
view = sub.poll()
print(json.dumps({"seq": None if view is None else view.seq, "dropped": sub.dropped, "index": None if view is None else view.index}))
bus.unlink()
`);
    expect(out.seq).toBe(5);
    expect(out.dropped).toBe(4);
    expect(out.index).toBe(4);
  });

  it('solves a checkerboard and writes a versioned calibration', () => {
    const out = py(`
import json, tempfile
from pathlib import Path
from cam0.calibration import find_checkerboard, render_checkerboard, solve_intrinsics, calibration_document, save_calibration, load_latest
img, known = render_checkerboard(160, 120, 5, 4, 12)
found = find_checkerboard(img, 5, 4)
err = max(abs(a-b) for p, q in zip(found, known) for a, b in zip(p, q))
solved = solve_intrinsics([{"corners": found, "inner_cols": 5, "inner_rows": 4, "square_m": 0.02}], 160, 120)
doc = calibration_document(solved, 160, 120, 1)
dest = Path(tempfile.mkdtemp())
save_calibration(dest, doc)
loaded = load_latest(dest)
print(json.dumps({"err": err, "n": len(found), "fx": loaded["intrinsics"]["fx"], "body": loaded["camera_to_body"], "schema": loaded["schema"]}))
`);
    expect(out.n).toBe(20);
    expect(out.err).toBeLessThan(1.5);
    expect(out.fx).toBeGreaterThan(10);
    expect(out.body).toBeNull();
    expect(out.schema).toBe('airvix.cam0.calibration/1');
  });
});

describe('cam0 replay sync', () => {
  it('picks the sidecar row nearest the flight cursor', () => {
    const frames = [{ i: 0, t_rel_s: 0 }, { i: 1, t_rel_s: 1.2 }, { i: 2, t_rel_s: 4 }];
    expect(pickFrame(frames, 1.0).i).toBe(1);
    expect(pickFrame([], 1)).toBeNull();
    expect(pickFrame(frames, null)).toBeNull();
  });
});

describe('cam0 companion HTTP', () => {
  let child = null;
  let base = '';
  const token = 'cam0-test-token';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cam0-rec-'));

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('python3', [agentPath], {
      cwd: pyRoot,
      env: {
        ...process.env,
        PYTHONPATH: pyRoot,
        VLC_HTTP_PORT: String(port),
        VLC_SKIP_RELAY: '1',
        VLC_COMPANION_TOKEN: token,
        VLC_CAM0_SOURCE: 'synthetic',
        VLC_CAM0_RECORD_ROOT: root,
        VLC_CAM0_CALIBRATION_DIR: path.join(root, 'cal'),
        VLC_CAMERA_DRY_RUN: '1',
      },
      stdio: 'ignore',
    });
    const headers = { Authorization: `Bearer ${token}` };
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/v1/cam0/status`, { headers });
        const body = await res.json();
        if (body.camera_ok === true && body.has_frame === true) {
          ready = true;
          break;
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(ready).toBe(true);
  }, 15000);

  afterAll(async () => {
    if (child) child.kill('SIGTERM');
  });

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  it('rejects a missing token and still serves health with one', async () => {
    const denied = await fetch(`${base}/api/v1/cam0/status`);
    expect(denied.status).toBe(401);
    const health = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await health.json();
    expect(body.agentVersion).toBe('2.5.1');
    expect(body.ok).toBe(true);
  });

  it('streams a jpeg, a 16-bit snapshot, and a marker detection', async () => {
    const frame = await fetch(`${base}/api/v1/cameras/cam0/frame.jpg`, { headers });
    expect(frame.status).toBe(200);
    const bytes = Buffer.from(await frame.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    const snap = await fetch(`${base}/api/v1/cam0/snapshot.png`, { headers });
    expect(snap.headers.get('content-type')).toMatch(/png/);
    const png = Buffer.from(await snap.arrayBuffer());
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    let hit = null;
    for (let i = 0; i < 20; i += 1) {
      const det = await fetch(`${base}/api/v1/cam0/detections`, { headers }).then((r) => r.json());
      hit = (det.detections || []).find((d) => d.id === 7);
      if (hit) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(hit).toBeTruthy();
    expect(hit.distance_m).toBeGreaterThan(0);
    expect(hit.corners).toHaveLength(4);
  });

  it('records a sidecar in the flight-log layout and seeks a frame', async () => {
    const start = await fetch(`${base}/api/v1/cam0/record/start`, { method: 'POST', headers, body: '{}' }).then((r) => r.json());
    expect(start.recording).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const stop = await fetch(`${base}/api/v1/cam0/record/stop`, { method: 'POST', headers, body: '{}' }).then((r) => r.json());
    expect(stop.recording).toBe(false);
    const list = await fetch(`${base}/api/v1/cam0/recordings`, { headers }).then((r) => r.json());
    expect(list.recordings.length).toBeGreaterThan(0);
    const id = list.recordings[0].flight_id;
    const meta = await fetch(`${base}/api/v1/cam0/recordings/${id}`, { headers }).then((r) => r.json());
    expect(meta.frames.length).toBeGreaterThan(0);
    expect(meta.frames[0].jpeg_length).toBeGreaterThan(20);
    const jpg = await fetch(`${base}/api/v1/cam0/recordings/${id}/frame.jpg?i=0`, { headers });
    expect(jpg.status).toBe(200);
    const sidecar = path.join(root, 'v1', 'airvix', 'flights', id, 'cam0', 'frames.jsonl');
    expect(fs.existsSync(sidecar)).toBe(true);
  });

  it('captures a synthetic board and saves calibration json', async () => {
    const cap = await fetch(`${base}/api/v1/cam0/calibration/capture`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ synthetic_board: true, inner_cols: 5, inner_rows: 4, square_m: 0.02, square_px: 12 }),
    }).then((r) => r.json());
    expect(cap.ok).toBe(true);
    const solved = await fetch(`${base}/api/v1/cam0/calibration/solve`, { method: 'POST', headers, body: '{}' }).then((r) => r.json());
    expect(solved.ok).toBe(true);
    expect(solved.calibration.camera_to_body).toBeNull();
    expect(solved.calibration.version).toBe(1);
  });

  it('manual exposure override disables the AE loop', async () => {
    const body = await fetch(`${base}/api/v1/cam0/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ae: { enabled: false }, manual: true, exposure_us: 2500, gain: 64 }),
    }).then((r) => r.json());
    expect(body.ae.enabled).toBe(false);
    expect(body.ae.exposure_us).toBe(2500);
    expect(body.ae.gain).toBe(64);
    expect(body.flight_commands).toBe(false);
  });
});
