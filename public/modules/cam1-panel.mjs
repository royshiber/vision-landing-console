/**
 * CAM1 panel. The stream request is the only thing that starts capture.
 * A failed health check stays "לא מחובר" and never invents a rate.
 */
import {
  honestyText,
  nextStreamDelayMs,
  settingsPayload,
  statusPhrase,
  targetFpsValue,
} from './cam1-status.mjs';
import { readStoredFov, writeStoredFov } from './camera-fov.mjs';

const REASON_LINK = 'אין קישור למחשב המשימה. הפקדים כבויים.';
const REASON_CAM = 'אין אות מהמצלמה. הפקדים כבויים.';
const ERR_SETTING = 'ההגדרה לא נשמרה. הערך חזר לקודם.';
const ERR_SNAP = 'הצילום נכשל.';
const STREAM = '/api/jetson/v1/cam1/stream.mjpg';
const CONTROL_IDS = ['cam1Ae', 'cam1Exposure', 'cam1Gain', 'cam1Res', 'cam1FpsSet', 'cam1Snap'];

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

function text(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value == null || value === '' ? '—' : String(value);
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

function init() {
  const panel = document.getElementById('cam1Panel');
  const cam0 = document.getElementById('cam0Panel');
  const btn0 = document.getElementById('opticsCam0Btn');
  const btn1 = document.getElementById('opticsCam1Btn');
  if (!panel || !btn0 || !btn1) return;
  const img = document.getElementById('cam1Frame');
  const empty = document.getElementById('cam1Empty');
  const honesty = document.getElementById('cam1Honesty');
  const hist = document.getElementById('cam1Hist');
  const histEmpty = document.getElementById('cam1HistEmpty');
  const ae = document.getElementById('cam1Ae');
  const exposure = document.getElementById('cam1Exposure');
  const gain = document.getElementById('cam1Gain');
  const fov = document.getElementById('cam1Fov');
  if (fov) fov.value = String(readStoredFov(localStorage, 'cam1'));
  const res = document.getElementById('cam1Res');
  const fpsSet = document.getElementById('cam1FpsSet');
  const reason = document.getElementById('cam1Reason');
  const error = document.getElementById('cam1Error');
  let applied = { ae: false, exposure: '', gain: '', res: '1280x800', fps: '' };
  let pushing = false;
  let polling = false;
  let pollMs = 700;
  let nextAt = 0;
  let lastBody = null;
  let streamError = false;
  let streamAttempt = 0;
  let fpsTouched = false;
  let retryTimer = 0;

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

  function paintStatusLine(body) {
    const line = document.getElementById('cam1StatusText');
    if (!line) return;
    line.textContent = statusPhrase(body, streamError);
  }

  function paintHonesty(body) {
    const textValue = honestyText(body, streamError);
    if (honesty) honesty.textContent = textValue;
    const has = !streamError && body?.camera_ok === true && body?.has_frame === true && textValue !== 'השידור נכשל. ננסה שוב.';
    if (empty) {
      empty.hidden = has;
      empty.textContent = 'אין אות';
    }
    if (img) img.hidden = !has;
    if (histEmpty) histEmpty.hidden = has;
  }

  function stopStream() {
    if (!img) return;
    img.hidden = true;
    img.removeAttribute('src');
  }

  function selectCam(which) {
    const on1 = which === 'cam1';
    btn0.classList.toggle('is-active', !on1);
    btn1.classList.toggle('is-active', on1);
    btn0.setAttribute('aria-selected', String(!on1));
    btn1.setAttribute('aria-selected', String(on1));
    document.dispatchEvent(new CustomEvent('vlc-debrief-open-cam', { detail: which }));
    nextAt = 0;
    void tick();
  }

  btn0.addEventListener('click', () => selectCam('cam0'));
  btn1.addEventListener('click', () => selectCam('cam1'));

  async function refresh() {
    let body = null;
    try {
      body = await api('/api/jetson/v1/cam1/status');
    } catch {
      body = null;
    }
    lastBody = body;
    const connected = body?.camera_ok === true && !streamError && body?.state !== 'error';
    const fps = connected && body.fps != null ? body.fps : null;
    paintStatusLine(body);
    setControls(connected, body ? REASON_CAM : REASON_LINK);
    text('cam1Fps', fps);
    text('cam1Latency', connected && body.latency_ms != null ? body.latency_ms : null);
    text('cam1Drops', connected && body.dropped != null ? body.dropped : null);
    const visible = panel.getClientRects().length > 0;
    const canStream = visible && body && body.ok !== false && body.state !== 'absent';
    if (!canStream) {
      streamError = false;
      streamAttempt = 0;
      clearTimeout(retryTimer);
      stopStream();
      paintHonesty(body);
      return body != null;
    }
    if (!streamError && img && !String(img.src || '').includes('cam1/stream.mjpg')) img.src = STREAM;
    paintHonesty(body);
    if (ae && document.activeElement !== ae) ae.checked = body.ae?.enabled === true;
    if (exposure && document.activeElement !== exposure && body.exposure_us != null) exposure.value = String(body.exposure_us);
    if (gain && document.activeElement !== gain && body.gain != null) gain.value = String(body.gain);
    if (res && document.activeElement !== res && body.width && body.height) {
      const next = `${body.width}x${body.height}`;
      if ([...res.options].some((opt) => opt.value === next)) res.value = next;
    }
    const captureFps = targetFpsValue(body);
    if (fpsSet && document.activeElement !== fpsSet && !fpsTouched && captureFps != null) fpsSet.value = captureFps;
    if (!pushing && ![ae, exposure, gain, res, fpsSet].includes(document.activeElement)) applied = readForm();
    drawHist(hist, img);
    return true;
  }

  function scheduleStreamRetry() {
    clearTimeout(retryTimer);
    const wait = nextStreamDelayMs(streamAttempt);
    streamAttempt += 1;
    retryTimer = setTimeout(() => {
      if (panel.hidden || panel.getClientRects().length === 0 || !lastBody || lastBody.state === 'absent') return;
      streamError = false;
      if (img) img.src = `${STREAM}?t=${Date.now()}`;
    }, wait);
  }

  img?.addEventListener('load', () => {
    streamError = false;
    streamAttempt = 0;
    paintHonesty(lastBody);
    paintStatusLine(lastBody);
    drawHist(hist, img);
  });
  img?.addEventListener('error', () => {
    if (!img.getAttribute('src')) return;
    streamError = true;
    img.hidden = true;
    paintHonesty(lastBody);
    paintStatusLine(lastBody);
    text('cam1Fps', null);
    scheduleStreamRetry();
  });

  async function pushSettings(extra) {
    const quiet = extra?.quiet === true;
    pushing = true;
    const [w, h] = String(res?.value || '1280x800').split('x').map((n) => Number(n));
    const body = settingsPayload({
      ae: ae?.checked === true,
      exposure: exposure?.value || '',
      gain: gain?.value || '',
      width: w,
      height: h,
      fps: fpsSet?.value || '',
      fpsTouched,
      fov: readStoredFov(localStorage, 'cam1'),
    });
    try {
      await api('/api/jetson/v1/cam1/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      applied = readForm();
      showError('');
    } catch {
      if (!quiet) {
        writeForm(applied);
        showError(ERR_SETTING);
      }
    } finally {
      pushing = false;
    }
  }

  fpsSet?.addEventListener('input', () => { fpsTouched = true; });
  ae?.addEventListener('change', () => { void pushSettings(); });
  exposure?.addEventListener('change', () => { void pushSettings(); });
  gain?.addEventListener('change', () => { void pushSettings(); });
  res?.addEventListener('change', () => { void pushSettings(); });
  fpsSet?.addEventListener('change', () => { void pushSettings(); });
  fov?.addEventListener('change', () => {
    const saved = writeStoredFov(localStorage, 'cam1', fov.value);
    fov.value = String(saved.value);
    if (!saved.ok) {
      showError('הזווית חייבת להיות בין 20 ל-180 מעלות.');
      return;
    }
    showError('');
    void pushSettings({ quiet: true });
  });
  document.getElementById('cam1Snap')?.addEventListener('click', async () => {
    try {
      const snap = await fetch(`/api/jetson/v1/cam1/snapshot.png?t=${Date.now()}`);
      const ctype = snap.headers.get('content-type') || '';
      if (!snap.ok || !ctype.includes('image')) {
        showError(ERR_SNAP);
        return;
      }
      const blob = await snap.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cam1.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showError('');
    } catch {
      showError(ERR_SNAP);
    }
  });

  function lineShown() {
    const line = document.getElementById('cam1StatusLine');
    return !!line && line.getClientRects().length > 0;
  }

  async function tick() {
    if (polling || pushing) return;
    const panelShown = panel.getClientRects().length > 0;
    if (!panelShown && !lineShown()) {
      pollMs = 700;
      nextAt = 0;
      stopStream();
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
