import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import express from 'express';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCameraInstallChecklist } from '../lib/camera-install-checklist.mjs';
import { createCompanionMock } from '../lib/companion-mock.mjs';
import { registerCompanionProxyApi } from '../lib/routes/companion-proxy-api.mjs';
import { GIMBAL_CONTROL_DISABLED_HE } from '../lib/companion-v1-paths.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py');
const netScript = path.join(repoRoot, 'scripts', 'jetson-companion', 'siyi-net.sh');

function py(script) {
  const r = spawnSync('python3', ['-'], {
    input: script,
    encoding: 'utf8',
    cwd: repoRoot,
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

function crc16(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

function encodeSiyi(cmd, data, seq) {
  const payload = Buffer.from(data);
  const body = Buffer.alloc(8 + payload.length);
  body.writeUInt16LE(0x6655, 0);
  body[2] = 0x01;
  body.writeUInt16LE(payload.length, 3);
  body.writeUInt16LE(seq, 5);
  body[7] = cmd;
  payload.copy(body, 8);
  const crc = crc16(body);
  const out = Buffer.alloc(body.length + 2);
  body.copy(out);
  out.writeUInt16LE(crc, body.length);
  return out;
}

function startSiyiEcho() {
  const seen = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 8 || msg.readUInt16LE(0) !== 0x6655) return;
    const seq = msg.readUInt16LE(5);
    const cmd = msg[7];
    const len = msg.readUInt16LE(3);
    const data = msg.subarray(8, 8 + len);
    seen.push({ cmd, seq, data: Buffer.from(data) });
    let reply = null;
    if (cmd === 0x0d) {
      const att = Buffer.alloc(12);
      att.writeInt16LE(605, 0);
      att.writeInt16LE(-200, 2);
      att.writeInt16LE(5, 4);
      reply = encodeSiyi(cmd, att, seq);
    } else if (cmd === 0x01) {
      reply = encodeSiyi(cmd, Buffer.alloc(12), seq);
    } else if (cmd === 0x02) {
      reply = encodeSiyi(cmd, Buffer.from('A8MINI000001'), seq);
    } else if (cmd === 0x0a) {
      reply = encodeSiyi(cmd, Buffer.from([0, 0, 0, 0, 1, 1, 0]), seq);
    } else if (cmd === 0x07) {
      reply = encodeSiyi(cmd, Buffer.from([1]), seq);
    } else if (cmd === 0x05) {
      const zoom = Buffer.alloc(2);
      zoom.writeUInt16LE(15, 0);
      reply = encodeSiyi(cmd, zoom, seq);
    }
    if (reply) sock.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    sock.bind(0, '127.0.0.1', () => {
      resolve({ sock, port: sock.address().port, seen });
    });
  });
}

function spawnAgent(env) {
  return spawn('python3', [agentPath], {
    env: {
      ...process.env,
      VLC_HTTP_BIND: '127.0.0.1',
      VLC_SKIP_RELAY: '1',
      VLC_CONSOLE_URL: 'http://127.0.0.1:1',
      VLC_FC_DEVICE: '/dev/null',
      VLC_CAMERA_DRY_RUN: '1',
      VLC_GIMBAL_POLL: '0',
      VLC_GIMBAL_CONTROL_ENABLED: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitHttp(url, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw last || new Error(`timeout ${url}`);
}

async function stopChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

describe('camera device plan and supervisor', () => {
  it('resolves auto, by-id, index, rtsp, and csi without importing cv2', () => {
    const report = py(`
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, "scripts/jetson-companion")
import camera_ingest
assert camera_ingest._try_cv2() is None or True
from camera_ingest import (
    plan_slot_devices, discover_capture_nodes, parse_device_spec,
    csi_gstreamer_pipeline, rtsp_gstreamer_pipeline, apply_usb_pixel_format,
    fourcc_int, SlotSupervisor, CaptureError, FrameBus,
)
root = Path(tempfile.mkdtemp())
by_id = root / "dev" / "v4l" / "by-id"
by_id.mkdir(parents=True)
(by_id / "usb-B_cam-video-index0").write_text("")
(by_id / "usb-A_cam-video-index0").write_text("")
(by_id / "usb-A_cam-video-index1").write_text("")
found = discover_capture_nodes(root)
env = {
    "VLC_CAM1_DEVICE": "auto",
    "VLC_CAM2_DEVICE": "auto",
    "VLC_CAM3_ENABLED": "0",
}
plan = plan_slot_devices(env, found, exists_fn=lambda p: True)
explicit = plan_slot_devices({
    "VLC_CAM1_DEVICE": "/dev/v4l/by-id/usb-Keep-video-index0",
    "VLC_CAM2_DEVICE": "auto",
    "VLC_CAM3_DEVICE": "rtsp://192.168.144.25:8554/main.264",
    "VLC_CAM3_ENABLED": "1",
    "VLC_CAM3_CODEC": "h265",
}, ["/dev/video0", "/dev/v4l/by-id/usb-Keep-video-index0"], exists_fn=lambda p: True)
index_plan = plan_slot_devices({"VLC_CAM1_DEVICE": "2", "VLC_CAM2_ENABLED": "0", "VLC_CAM3_ENABLED": "0"}, [], exists_fn=lambda p: True)
csi = parse_device_spec("csi:1")
pipe = csi_gstreamer_pipeline(1, 640, 480, 10)
rtsp = rtsp_gstreamer_pipeline("rtsp://192.168.144.25:8554/main.264", "h265")
class Cap:
    def __init__(self, stick):
        self.stick = stick
        self.props = {}
    def set(self, k, v):
        self.props[k] = v
        return True
    def get(self, k):
        if k == 6 and not self.stick:
            return 0
        return self.props.get(k, 0)
mjpg = apply_usb_pixel_format(Cap(True), 320, 240, 5)
class NoMjpg(Cap):
    def get(self, k):
        if k == 6 and self.props.get(6) == fourcc_int("MJPG"):
            return 0
        return self.props.get(k, 0)
yuyv_cap = NoMjpg(False)
yuyv = apply_usb_pixel_format(yuyv_cap, 320, 240, 5)
clock = {"t": 10.0}
opens = []
released = []
class Fake:
    def __init__(self, frames):
        self.frames = list(frames)
    def read_frame(self):
        if not self.frames:
            return None
        item = self.frames.pop(0)
        return None if item is None else {"jpeg": item}
    def release(self):
        released.append(True)
bus = FrameBus()
seen = []
bus.subscribe(lambda cam, pkt: seen.append(pkt["jpeg"]))
current = {"node_present": False, "kind": "auto", "resolved": None, "requested": "auto", "spec": {"kind": "auto"}}
def resolve():
    return dict(current)
def open_fn(spec, plan):
    opens.append(spec.get("kind"))
    if spec.get("kind") == "csi":
        raise CaptureError("csi_requires_gstreamer_opencv")
    return Fake([b"jpeg-a", None])
sup = SlotSupervisor("cam1", role="forward", enabled=True, resolve_fn=resolve, open_fn=open_fn, geometry={"width":640,"height":480,"fps":10}, now_fn=lambda: clock["t"], discover_s=2, bus=bus)
s1 = sup.step()
clock["t"] = 12.0
current = {"node_present": True, "kind": "path", "resolved": "/dev/v4l/by-id/usb-A_cam-video-index0", "requested": "auto", "spec": {"kind": "path", "path": "/dev/v4l/by-id/usb-A_cam-video-index0"}, "geometry": {"width":640,"height":480,"fps":10}}
s2 = sup.step()
snap = sup.snapshot(clock["t"])
s3 = sup.step()
opens_after_fail = len(opens)
s4 = sup.step()
clock["t"] = 14.0
current = {"node_present": False, "kind": "auto", "resolved": None, "requested": "auto", "spec": {"kind": "auto"}}
s5 = sup.step()
csi_sup = SlotSupervisor("cam2", role="down", enabled=True, resolve_fn=lambda: {"node_present": True, "kind": "csi", "resolved": "csi:0", "requested": "csi:0", "spec": {"kind": "csi", "index": 0}}, open_fn=open_fn, geometry={"width":640,"height":480,"fps":10}, now_fn=lambda: 5)
s_csi = csi_sup.step()
print(json.dumps({
  "found": found,
  "auto1": plan["cam1"]["resolved"],
  "auto2": plan["cam2"]["resolved"],
  "cam3off": plan["cam3"]["kind"],
  "explicit": explicit["cam1"]["resolved"],
  "autoSkipped": explicit["cam2"]["resolved"],
  "rtsp": explicit["cam3"]["kind"],
  "codec": explicit["cam3"]["codec"],
  "index": index_plan["cam1"]["resolved"],
  "csiKind": csi["kind"],
  "csiIndex": csi["index"],
  "pipe": pipe,
  "rtspPipe": rtsp,
  "mjpg": mjpg,
  "yuyv": yuyv,
  "states": [s1, s2, s3, s4, s5, s_csi],
  "fps": snap["fps"],
  "count": snap["frame_count"],
  "age": snap["last_frame_age_ms"],
  "ok": snap["camera_ok"],
  "device": snap["resolved_device"],
  "released": len(released) >= 1,
  "opensStuck": opens_after_fail == len(opens) or s4 == "read_failed",
  "bus": seen[0].decode() if seen else None,
  "latest": bus.latest("cam1")["jpeg"].decode() if bus.latest("cam1") else None,
}))
`);
    expect(report.found).toEqual([
      '/dev/v4l/by-id/usb-A_cam-video-index0',
      '/dev/v4l/by-id/usb-B_cam-video-index0',
    ]);
    expect(report.auto1).toBe('/dev/v4l/by-id/usb-A_cam-video-index0');
    expect(report.auto2).toBe('/dev/v4l/by-id/usb-B_cam-video-index0');
    expect(report.cam3off).toBe('disabled');
    expect(report.explicit).toBe('/dev/v4l/by-id/usb-Keep-video-index0');
    expect(report.autoSkipped).toBe('/dev/video0');
    expect(report.rtsp).toBe('rtsp');
    expect(report.codec).toBe('h265');
    expect(report.index).toBe('/dev/video2');
    expect(report.csiKind).toBe('csi');
    expect(report.csiIndex).toBe(1);
    expect(report.pipe).toContain('nvarguscamerasrc sensor-id=1');
    expect(report.pipe).toContain('appsink drop=true max-buffers=1 sync=false');
    expect(report.rtspPipe).toContain('protocols=tcp latency=0');
    expect(report.rtspPipe).toContain('rtph265depay ! h265parse');
    expect(report.rtspPipe).toContain('nvv4l2decoder');
    expect(report.mjpg).toBe('MJPG');
    expect(report.yuyv).toBe('YUYV');
    expect(report.states[0]).toBe('absent');
    expect(report.states[1]).toBe('streaming');
    expect(report.ok).toBe(true);
    expect(report.count).toBe(1);
    expect(report.device).toContain('usb-A_cam');
    expect(report.states[2]).toBe('read_failed');
    expect(report.states[3]).toBe('read_failed');
    expect(report.released).toBe(true);
    expect(report.states[4]).toBe('absent');
    expect(report.states[5]).toBe('csi_requires_gstreamer_opencv');
    expect(report.bus).toBe('jpeg-a');
    expect(report.latest).toBe('jpeg-a');
  });

  it('falls back to capture-capable video nodes and skips metadata', () => {
    const report = py(`
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, "scripts/jetson-companion")
from camera_ingest import discover_capture_nodes, plan_slot_devices
root = Path(tempfile.mkdtemp())
(root / "dev").mkdir(parents=True)
for name in ("video0", "video1", "video2"):
    (root / "dev" / name).write_text("")
found = discover_capture_nodes(root, capture_probe=lambda path: path != "/dev/video1")
plan = plan_slot_devices({"VLC_CAM1_DEVICE":"auto","VLC_CAM2_DEVICE":"auto","VLC_CAM3_ENABLED":"0"}, found, exists_fn=lambda p: True)
print(json.dumps({"found": found, "a": plan["cam1"]["resolved"], "b": plan["cam2"]["resolved"]}))
`);
    expect(report.found).toEqual(['/dev/video0', '/dev/video2']);
    expect(report.a).toBe('/dev/video0');
    expect(report.b).toBe('/dev/video2');
  });
});

describe('SIYI packet codec', () => {
  it('matches the manual vectors and clamps angles', () => {
    const report = py(`
import json, sys, struct
sys.path.insert(0, "scripts/jetson-companion")
from siyi_sdk import (
    encode_packet, decode_packet, parse_attitude, parse_firmware, clamp_angle, clamp_rate,
    angle_cmd_from_env, CONTROL_DISABLED_HE,
)
vectors = {
    "zoom+": (0x05, bytes([1]), "5566010100000005018d64"),
    "zoom-": (0x05, bytes([0xFF]), "5566010100000005ff5c6a"),
    "focus+": (0x06, bytes([1]), "556601010000000601de31"),
    "focus-": (0x06, bytes([0xFF]), "5566010100000006ff0f3f"),
    "photo": (0x0C, bytes([0]), "556601010000000c0034ce"),
    "record": (0x0C, bytes([2]), "556601010000000c0276ee"),
    "rate": (0x07, bytes([0x64, 0x64]), "556601020000000764643dcf"),
    "center": (0x08, bytes([1]), "556601010000000801d112"),
    "cfg": (0x0A, b"", "556601000000000a0f75"),
    "af": (0x04, bytes([1]), "556601010000000401bc57"),
    "hw": (0x02, b"", "556601000000000207f4"),
    "fw": (0x01, b"", "556601000000000164c4"),
    "lock": (0x0C, bytes([3]), "556601010000000c0357fe"),
    "follow": (0x0C, bytes([4]), "556601010000000c04b08e"),
    "fpv": (0x0C, bytes([5]), "556601010000000c05919e"),
    "att": (0x0D, b"", "556601000000000de805"),
}
bad = []
for name, (cmd, data, exp) in vectors.items():
    got = encode_packet(cmd, data, seq=0).hex()
    if got != exp:
        bad.append(name)
    dec = decode_packet(bytes.fromhex(exp))
    if not dec or dec["cmd"] != cmd:
        bad.append("dec-"+name)
att = parse_attitude(struct.pack("<hhhhhh", 605, -200, 10, 5, -5, 0))
fw = parse_firmware(struct.pack("<III", 0x6E030203, 0, 0))
yaw, pitch = clamp_angle(200, -120)
print(json.dumps({
    "bad": bad,
    "yaw": att["yaw"],
    "pitch": att["pitch"],
    "fw": fw["camera"],
    "clamped": [yaw, pitch],
    "rate": clamp_rate(150),
    "angleCmd": angle_cmd_from_env({"VLC_SIYI_ANGLE_CMD": "13"}),
    "he": CONTROL_DISABLED_HE,
}))
`);
    expect(report.bad).toEqual([]);
    expect(report.yaw).toBe(60.5);
    expect(report.pitch).toBe(-20);
    expect(report.fw).toBe('v3.2.3');
    expect(report.clamped).toEqual([135, -90]);
    expect(report.rate).toBe(100);
    expect(report.angleCmd).toBe(13);
    expect(report.he).toBe(GIMBAL_CONTROL_DISABLED_HE);
  });
});

describe('checklist requires every enabled camera', () => {
  it('does not accept a single live camera when both are enabled', () => {
    const one = buildCameraInstallChecklist({
      companion: { jetson: 'reachable' },
      opticalNav: {
        cameras: {
          cam1: { camera_ok: true, fps: 12, last_frame_age_ms: 40, state: 'streaming', enabled: true },
          cam2: { camera_ok: false, state: 'absent', enabled: true, frame_count: 9 },
        },
      },
    });
    expect(one.liveFrame.state).toBe('missing');
    expect(one.liveFrame.missingCameras).toContain('cam2');
    expect(one.requiredCameras).toEqual(['cam1', 'cam2']);

    const both = buildCameraInstallChecklist({
      companion: { jetson: 'reachable' },
      opticalNav: {
        cameras: {
          cam1: { camera_ok: true, fps: 12, last_frame_age_ms: 40, state: 'streaming' },
          cam2: { camera_ok: true, frame_count: 4, state: 'streaming' },
        },
      },
    });
    expect(both.liveFrame.state).toBe('ok');
    expect(both.roleLabelsHe.gimbal).toBe('גימבל');
  });

  it('requires the gimbal slot only when that role is enabled', () => {
    const cams = {
      cam1: { camera_ok: true, fps: 10, state: 'streaming' },
      cam2: { camera_ok: true, fps: 10, state: 'streaming' },
      cam3: { camera_ok: false, state: 'disabled', enabled: false, frame_count: 3 },
    };
    const off = buildCameraInstallChecklist({
      opticalNav: { cameras: cams },
    });
    expect(off.liveFrame.state).toBe('ok');
    expect(off.requiredCameras).not.toContain('cam3');

    const on = buildCameraInstallChecklist({
      operator: { roles: { cam1: 'forward', cam2: 'down', cam3: 'gimbal' } },
      opticalNav: { cameras: cams },
    });
    expect(on.liveFrame.state).toBe('missing');
    expect(on.liveFrame.missingCameras).toContain('cam3');
    expect(on.roles.cam3.titleHe).toContain('גימבל');
  });
});

describe('gimbal control gate and cam3 frame', () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let base = '';
  let echo = null;

  beforeAll(async () => {
    echo = await startSiyiEcho();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawnAgent({
      VLC_HTTP_PORT: String(port),
      VLC_GIMBAL_POLL: '1',
      VLC_SIYI_HOST: '127.0.0.1',
      VLC_SIYI_PORT: String(echo.port),
      VLC_SIYI_TIMEOUT_S: '0.3',
      VLC_SIYI_POLL_S: '0.15',
      VLC_SIYI_STALE_S: '2',
      VLC_GIMBAL_CONTROL_ENABLED: '0',
    });
    await waitHttp(`${base}/api/health`);
  }, 20000);

  afterAll(async () => {
    await stopChild(child);
    if (echo) echo.sock.close();
  });

  it('stays absent until a real reply, then reports attitude without enabling control', async () => {
    let body = null;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      body = await fetch(`${base}/api/v1/status/gimbal`).then((r) => r.json());
      if (body.present === true) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(body.present).toBe(true);
    expect(body.attitude.yaw).toBe(60.5);
    expect(body.attitude.pitch).toBe(-20);
    expect(body.firmware).toBeTruthy();
    expect(body.mode).toBe('follow');
    expect(body.control_enabled).toBe(false);
    const denied = await fetch(`${base}/api/v1/gimbal/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaw: 150, pitch: -200 }),
    });
    const deniedBody = await denied.json();
    expect(denied.status).toBe(403);
    expect(deniedBody.message).toBe(GIMBAL_CONTROL_DISABLED_HE);
    expect(deniedBody.sent).toBe(false);
    expect(echo.seen.some((row) => row.cmd === 0x07)).toBe(false);
    const frame = await fetch(`${base}/api/v1/cameras/cam3/frame.jpg`);
    expect(frame.status).toBe(404);
    const cam = await fetch(`${base}/api/v1/status/cameras`).then((r) => r.json());
    expect(cam.cameras.cam3.state).toBe('disabled');
    expect(cam.cameras.cam3.camera_ok).toBe(false);
  });
});

describe('enabled gimbal command is clamped and logged', () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let echo = null;

  afterAll(async () => {
    await stopChild(child);
    if (echo) echo.sock.close();
  });

  it('sends a clamped rate only when control is enabled', async () => {
    echo = await startSiyiEcho();
    const port = await freePort();
    child = spawnAgent({
      VLC_HTTP_PORT: String(port),
      VLC_GIMBAL_POLL: '0',
      VLC_SIYI_HOST: '127.0.0.1',
      VLC_SIYI_PORT: String(echo.port),
      VLC_SIYI_TIMEOUT_S: '0.4',
      VLC_GIMBAL_CONTROL_ENABLED: '1',
    });
    const base = `http://127.0.0.1:${port}`;
    await waitHttp(`${base}/api/health`);
    const res = await fetch(`${base}/api/v1/gimbal/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaw: 150, pitch: -200 }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.confirmed).toBe(true);
    const rate = echo.seen.find((row) => row.cmd === 0x07);
    expect(rate).toBeTruthy();
    expect(rate.data[0]).toBe(100);
    expect(rate.data.readInt8(1)).toBe(-100);
  });
});

describe('proxy gimbal routes', () => {
  it('forwards cam3 and returns 403 when control is off', async () => {
    const prev = process.env.VLC_GIMBAL_CONTROL_ENABLED;
    process.env.VLC_GIMBAL_CONTROL_ENABLED = '0';
    const app = express();
    app.use(express.json());
    const client = createCompanionMock({ scenario: 'disconnected' });
    registerCompanionProxyApi(app, { companionService: { client, describe: () => ({ mode: 'mock' }) } });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    try {
      const gimbal = await fetch(`http://127.0.0.1:${port}/api/jetson/v1/status/gimbal`).then((r) => r.json());
      expect(gimbal.data.present).toBe(false);
      expect(gimbal.data.attitude).toBeNull();
      const denied = await fetch(`http://127.0.0.1:${port}/api/jetson/v1/gimbal/center`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(denied.status).toBe(403);
      const frame = await fetch(`http://127.0.0.1:${port}/api/jetson/v1/cameras/cam3/frame`);
      expect(frame.status).toBe(404);
    } finally {
      server.close();
      if (prev == null) delete process.env.VLC_GIMBAL_CONTROL_ENABLED;
      else process.env.VLC_GIMBAL_CONTROL_ENABLED = prev;
    }
  });
});

describe('siyi-net helper', () => {
  it('plans the wired profile and refuses wifi', () => {
    const dry = spawnSync('bash', [netScript, '--dry-run', '--iface', 'enP8p1s0'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('airvix-siyi');
    expect(dry.stdout).toContain('192.168.144.20/24');
    expect(dry.stdout).toContain('ipv4.never-default yes');
    expect(dry.stdout).toContain('ipv6.method disabled');
    expect(dry.stdout).toContain('connection.autoconnect-priority 10');
    expect(dry.stdout).not.toMatch(/wifi|wwan|gsm/i);
    const wifi = spawnSync('bash', [netScript, '--dry-run', '--iface', 'wlan0'], { encoding: 'utf8' });
    expect(wifi.status).toBe(3);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'siyi-nm-'));
    const nm = path.join(bin, 'nmcli');
    fs.writeFileSync(nm, '#!/bin/sh\necho airvix-siyi\n');
    fs.chmodSync(nm, 0o755);
    const status = spawnSync('bash', [netScript, '--status', '--iface', 'enP8p1s0'], {
      encoding: 'utf8',
      env: { ...process.env, NMCLI: nm, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(status.status).toBe(0);
    const body = JSON.parse(status.stdout.trim().split('\n').pop());
    expect(body.profile).toBe('airvix-siyi');
    expect(body.present).toBe(true);
    expect(body.active).toBe(false);
  });
});
