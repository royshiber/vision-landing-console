/**
 * Cam0 panel. Numbers come from the companion. No stream shows אין אות.
 */
import { bindCameraSourcePickers, cameraFrameUrl } from './camera-sources.mjs';

const NO_SIGNAL = 'אין אות';
const DRILL = 'תרגיל. לא מצלמה אמיתית.';

function unwrap(body) {
  if (body && body.lane === 'NEW' && body.data && typeof body.data === 'object') return body.data;
  return body;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('json')) {
    const body = unwrap(await res.json());
    if (!res.ok) {
      const err = new Error(body?.reason || 'error');
      err.body = body;
      throw err;
    }
    return body;
  }
  if (!res.ok) throw new Error('http');
  return res;
}

function text(id, value, ltr) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value == null || value === '') {
    el.textContent = '—';
    return;
  }
  el.textContent = String(value);
  if (ltr) el.dir = 'ltr';
}

function drawHist(canvas, img) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!img || img.hidden || !img.naturalWidth) return;
  const scratch = document.createElement('canvas');
  scratch.width = 64;
  scratch.height = 48;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!sctx) return;
  sctx.drawImage(img, 0, 0, scratch.width, scratch.height);
  let data;
  try {
    data = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
  } catch {
    return;
  }
  const bins = new Array(16).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    bins[Math.min(15, y >> 4)] += 1;
  }
  const max = Math.max(...bins, 1);
  ctx.fillStyle = 'rgba(125, 211, 252, 0.85)';
  bins.forEach((n, i) => {
    const bh = Math.max(1, Math.round((n / max) * (h - 2)));
    ctx.fillRect(i * (w / 16) + 1, h - bh, (w / 16) - 2, bh);
  });
}

function drawDetections(canvas, img, detections, enabled) {
  if (!canvas) return;
  const show = enabled && img && !img.hidden && detections?.length;
  canvas.hidden = !show;
  if (!show) return;
  const rect = img.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = img.naturalWidth / (Number(img.dataset.srcW) || img.naturalWidth);
  const sy = img.naturalHeight / (Number(img.dataset.srcH) || img.naturalHeight);
  const dx = canvas.width / img.naturalWidth;
  const dy = canvas.height / img.naturalHeight;
  ctx.strokeStyle = '#fbbf24';
  ctx.fillStyle = '#fbbf24';
  ctx.lineWidth = 2;
  ctx.font = '12px sans-serif';
  for (const det of detections) {
    const pts = (det.corners || []).map((p) => [p[0] * sx * dx, p[1] * sy * dy]);
    if (pts.length < 4) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.stroke();
    const label = det.distance_m == null
      ? String(det.id)
      : `${det.id}  ${Number(det.distance_m).toFixed(2)} m`;
    ctx.fillText(label, pts[0][0] + 4, Math.max(12, pts[0][1] - 4));
  }
}

function init() {
  const panel = document.getElementById('cam0Panel');
  if (!panel) return;
  bindCameraSourcePickers(document);
  const img = document.getElementById('cam0Frame');
  const empty = document.getElementById('cam0Empty');
  const honesty = document.getElementById('cam0Honesty');
  const overlay = document.getElementById('cam0Overlay');
  const hist = document.getElementById('cam0Hist');
  const slotImg = document.getElementById('liveCameraCam0Frame');
  const slotMeta = document.getElementById('liveCameraCam0Meta');
  const slotOverlay = document.getElementById('liveCameraCam0Overlay');
  const ae = document.getElementById('cam0Ae');
  const exposure = document.getElementById('cam0Exposure');
  const gain = document.getElementById('cam0Gain');
  const res = document.getElementById('cam0Res');
  const fpsSet = document.getElementById('cam0FpsSet');
  const rec = document.getElementById('cam0Record');
  const recDot = document.getElementById('cam0RecDot');
  const overlayToggle = document.getElementById('cam0OverlayToggle');
  let status = null;
  let detections = [];
  let recording = false;

  function paintSignal(has, drill) {
    if (empty) empty.hidden = has;
    if (empty && !has) empty.textContent = NO_SIGNAL;
    if (honesty) honesty.textContent = has ? (drill ? DRILL : 'פריים חי') : NO_SIGNAL;
    if (img) img.hidden = !has;
    if (slotImg) slotImg.hidden = !has;
    if (slotMeta) slotMeta.textContent = has ? (drill ? DRILL : '') : NO_SIGNAL;
  }

  async function refresh() {
    try {
      status = await api('/api/jetson/v1/cam0/status');
    } catch {
      status = null;
      paintSignal(false, false);
      text('cam0Fps', null);
      text('cam0Latency', null);
      text('cam0Drops', null);
      return;
    }
    const has = status.camera_ok === true && status.has_frame === true;
    const drill = status.real !== true || status.dry_run === true || status.source === 'synthetic';
    paintSignal(has, drill && has);
    text('cam0Fps', has && status.fps != null ? status.fps : null, true);
    text('cam0Latency', has && status.latency_ms != null ? status.latency_ms : null, true);
    text('cam0Drops', status.dropped != null ? status.dropped : null, true);
    if (ae && document.activeElement !== ae) ae.checked = status.ae?.enabled === true;
    if (exposure && document.activeElement !== exposure && status.exposure_us != null) exposure.value = String(status.exposure_us);
    if (gain && document.activeElement !== gain && status.gain != null) gain.value = String(status.gain);
    if (fpsSet && document.activeElement !== fpsSet && status.stream?.fps != null) fpsSet.value = String(status.stream.fps);
    recording = status.recording?.recording === true;
    if (recDot) recDot.hidden = !recording;
    if (has) {
      const url = cameraFrameUrl('cam0');
      if (img) {
        img.dataset.srcW = String(status.width || '');
        img.dataset.srcH = String(status.height || '');
        img.src = url;
      }
      if (slotImg) slotImg.src = url;
    } else if (img) {
      img.removeAttribute('src');
    }
    try {
      const det = await api('/api/jetson/v1/cam0/detections');
      detections = det.detections || [];
    } catch {
      detections = [];
    }
    drawDetections(overlay, img, detections, overlayToggle?.checked !== false);
    drawDetections(slotOverlay, slotImg || img, detections, overlayToggle?.checked !== false);
    drawHist(hist, img);
  }

  img?.addEventListener('load', () => {
    drawDetections(overlay, img, detections, overlayToggle?.checked !== false);
    drawHist(hist, img);
  });
  overlayToggle?.addEventListener('change', () => {
    drawDetections(overlay, img, detections, overlayToggle.checked);
    drawDetections(slotOverlay, slotImg || img, detections, overlayToggle.checked);
  });

  async function pushSettings(extra) {
    const [w, h] = String(res?.value || '1280x800').split('x').map((n) => Number(n));
    const body = {
      ae: { enabled: ae?.checked === true },
      exposure_us: exposure?.value === '' ? undefined : Number(exposure.value),
      gain: gain?.value === '' ? undefined : Number(gain.value),
      width: w,
      height: h,
      fps: fpsSet?.value === '' ? undefined : Number(fpsSet.value),
      manual: ae?.checked !== true,
      stream: { fps: fpsSet?.value === '' ? undefined : Number(fpsSet.value) },
      ...extra,
    };
    try {
      await api('/api/jetson/v1/cam0/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      /* the next poll shows the last accepted state */
    }
  }

  ae?.addEventListener('change', () => { void pushSettings(); });
  exposure?.addEventListener('change', () => { void pushSettings(); });
  gain?.addEventListener('change', () => { void pushSettings(); });
  res?.addEventListener('change', () => { void pushSettings(); });
  fpsSet?.addEventListener('change', () => { void pushSettings(); });
  rec?.addEventListener('click', async () => {
    const path = recording ? '/api/jetson/v1/cam0/record/stop' : '/api/jetson/v1/cam0/record/start';
    try {
      await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch { /* status poll reports the truth */ }
    void refresh();
  });
  document.getElementById('cam0Snap')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/jetson/v1/cam0/snapshot.png?t=${Date.now()}`;
    a.download = 'cam0.png';
    a.click();
  });
  document.getElementById('cam0CalibCap')?.addEventListener('click', async () => {
    const state = document.getElementById('cam0CalibState');
    try {
      const body = await api('/api/jetson/v1/cam0/calibration/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inner_cols: 5, inner_rows: 4, square_m: 0.025 }),
      });
      if (state) state.textContent = body.ok ? `נשמרו ${body.captured}` : 'הלוח לא נמצא';
    } catch {
      if (state) state.textContent = NO_SIGNAL;
    }
  });
  document.getElementById('cam0CalibSolve')?.addEventListener('click', async () => {
    const state = document.getElementById('cam0CalibState');
    try {
      const body = await api('/api/jetson/v1/cam0/calibration/solve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (state) state.textContent = body.ok ? 'הכיול נשמר' : 'אין מספיק צילומים';
    } catch {
      if (state) state.textContent = NO_SIGNAL;
    }
  });

  void refresh();
  setInterval(() => { void refresh(); }, 700);
}

init();
