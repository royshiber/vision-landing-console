/**
 * Cam0 panel. Numbers come from the companion. No stream shows אין אות.
 */
import { bindCameraSourcePickers, cameraFrameUrl } from './camera-sources.mjs';

const NO_SIGNAL = 'אין אות';
const DRILL = 'תרגיל. לא מצלמה אמיתית.';
const REASON_LINK = 'אין קישור למחשב המשימה. הפקדים כבויים.';
const REASON_CAM = 'אין אות מהמצלמה. הפקדים כבויים.';
const ERR_SETTING = 'ההגדרה לא נשמרה. הערך חזר לקודם.';
const ERR_SNAP = 'הצילום נכשל.';
const ERR_REC_START = 'ההקלטה לא התחילה.';
const ERR_REC_STOP = 'עצירת ההקלטה נכשלה.';
const CONTROL_IDS = ['cam0Ae', 'cam0Exposure', 'cam0Gain', 'cam0Res', 'cam0FpsSet', 'cam0Record', 'cam0Snap', 'cam0CalibCap', 'cam0CalibSolve'];

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
  const reason = document.getElementById('cam0Reason');
  const error = document.getElementById('cam0Error');
  const histEmpty = document.getElementById('cam0HistEmpty');
  let status = null;
  let detections = [];
  let recording = false;
  let applied = { ae: false, exposure: '', gain: '', res: '1280x800', fps: '' };
  let pollMs = 700;
  let nextAt = 0;
  let polling = false;
  let pushing = false;

  function showError(message) {
    if (!error) return;
    error.hidden = !message;
    error.textContent = message || '';
  }

  function readForm() {
    return {
      ae: ae?.checked === true,
      exposure: exposure?.value || '',
      gain: gain?.value || '',
      res: res?.value || '1280x800',
      fps: fpsSet?.value || '',
    };
  }

  function writeForm(values) {
    if (!values) return;
    if (ae) ae.checked = values.ae === true;
    if (exposure) exposure.value = values.exposure || '';
    if (gain) gain.value = values.gain || '';
    if (res) res.value = values.res || '1280x800';
    if (fpsSet) fpsSet.value = values.fps || '';
  }

  function setControls(on, why) {
    for (const id of CONTROL_IDS) {
      const el = document.getElementById(id);
      if (el) el.disabled = !on;
    }
    if (reason) {
      reason.hidden = !!on;
      reason.textContent = on ? '' : why;
    }
  }

  function paintStatusLine(connected, fps) {
    const line = document.getElementById('cam0StatusText');
    if (!line) return;
    const rate = fps == null || fps === '' ? '—' : String(fps);
    line.textContent = `מצלמה אפס · ${connected ? 'מחובר' : 'לא מחובר'} · קצב ${rate}`;
  }

  function paintSignal(has, drill) {
    if (empty) empty.hidden = has;
    if (empty && !has) empty.textContent = NO_SIGNAL;
    if (honesty) honesty.textContent = has ? (drill ? DRILL : 'פריים חי') : NO_SIGNAL;
    if (histEmpty) histEmpty.hidden = has;
    if (img) img.hidden = !has;
    if (slotImg) slotImg.hidden = !has;
    if (slotMeta) slotMeta.textContent = has ? (drill ? DRILL : '') : NO_SIGNAL;
  }

  async function refresh() {
    let body = null;
    try {
      body = await api('/api/jetson/v1/cam0/status');
    } catch {
      body = null;
    }
    status = body;
    const cameraOk = body?.camera_ok === true;
    const fps = cameraOk && body.fps != null ? body.fps : null;
    paintStatusLine(cameraOk, fps);
    setControls(cameraOk, body ? REASON_CAM : REASON_LINK);
    if (!body) {
      paintSignal(false, false);
      text('cam0Fps', null);
      text('cam0Latency', null);
      text('cam0Drops', null);
      recording = false;
      if (recDot) recDot.hidden = true;
      return false;
    }
    const has = cameraOk && body.has_frame === true;
    const drill = body.real !== true || body.dry_run === true || body.source === 'synthetic';
    paintSignal(has, drill && has);
    text('cam0Fps', fps, true);
    text('cam0Latency', has && body.latency_ms != null ? body.latency_ms : null, true);
    text('cam0Drops', body.dropped != null ? body.dropped : null, true);
    if (ae && document.activeElement !== ae) ae.checked = body.ae?.enabled === true;
    if (exposure && document.activeElement !== exposure && body.exposure_us != null) exposure.value = String(body.exposure_us);
    if (gain && document.activeElement !== gain && body.gain != null) gain.value = String(body.gain);
    if (res && document.activeElement !== res && body.width && body.height) {
      const next = `${body.width}x${body.height}`;
      if ([...res.options].some((opt) => opt.value === next)) res.value = next;
    }
    if (fpsSet && document.activeElement !== fpsSet && body.stream?.fps != null) fpsSet.value = String(body.stream.fps);
    if (!pushing && ![ae, exposure, gain, res, fpsSet].includes(document.activeElement)) applied = readForm();
    recording = body.recording?.recording === true;
    if (recDot) recDot.hidden = !recording;
    if (!panelShown()) return true;
    if (has) {
      const url = cameraFrameUrl('cam0');
      if (img) {
        img.dataset.srcW = String(status.width || '');
        img.dataset.srcH = String(body.height || '');
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
    return true;
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
    pushing = true;
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
      applied = readForm();
      showError('');
    } catch {
      writeForm(applied);
      showError(ERR_SETTING);
    } finally {
      pushing = false;
    }
  }

  ae?.addEventListener('change', () => { void pushSettings(); });
  exposure?.addEventListener('change', () => { void pushSettings(); });
  gain?.addEventListener('change', () => { void pushSettings(); });
  res?.addEventListener('change', () => { void pushSettings(); });
  fpsSet?.addEventListener('change', () => { void pushSettings(); });
  rec?.addEventListener('click', async () => {
    const path = recording ? '/api/jetson/v1/cam0/record/stop' : '/api/jetson/v1/cam0/record/start';
    const stopping = recording;
    try {
      await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      showError('');
    } catch {
      showError(stopping ? ERR_REC_STOP : ERR_REC_START);
    }
    void refresh();
  });
  document.getElementById('cam0Snap')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/jetson/v1/cam0/snapshot.png?t=${Date.now()}`);
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || !ctype.includes('image')) {
        showError(ERR_SNAP);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cam0.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showError('');
    } catch {
      showError(ERR_SNAP);
    }
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

  function panelShown() {
    return panel.getClientRects().length > 0;
  }

  function lineShown() {
    const line = document.getElementById('cam0StatusLine');
    return !!line && line.getClientRects().length > 0;
  }

  document.getElementById('cam0StatusLink')?.addEventListener('click', () => {
    document.querySelector('[data-tab="recordings"]')?.click();
    document.getElementById('debriefRecBtn')?.click();
  });

  async function tick() {
    if (polling || pushing) return;
    if (!panelShown() && !lineShown()) {
      pollMs = 700;
      nextAt = 0;
      return;
    }
    if (Date.now() < nextAt) return;
    polling = true;
    const ok = await refresh();
    polling = false;
    pollMs = ok ? 700 : Math.min(15000, Math.max(1400, pollMs * 2));
    nextAt = Date.now() + pollMs;
  }

  void tick();
  setInterval(() => { void tick(); }, 700);
}

init();
