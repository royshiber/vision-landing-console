/**
 * CAM1 panel. The stream request is the only thing that starts capture.
 * A failed health check stays "לא מחובר" and never invents a rate.
 */
const NO_SIGNAL = 'אין אות';
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
  const res = document.getElementById('cam1Res');
  const fpsSet = document.getElementById('cam1FpsSet');
  const reason = document.getElementById('cam1Reason');
  const error = document.getElementById('cam1Error');
  let applied = { ae: false, exposure: '', gain: '', res: '1280x800', fps: '' };
  let pushing = false;
  let polling = false;
  let pollMs = 700;
  let nextAt = 0;

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
    const line = document.getElementById('cam1StatusText');
    if (!line) return;
    const rate = fps == null || fps === '' ? '—' : String(fps);
    line.textContent = `מצלמה אחת · ${connected ? 'מחובר' : 'לא מחובר'} · קצב ${rate}`;
  }

  function stopStream() {
    if (!img) return;
    img.hidden = true;
    img.removeAttribute('src');
  }

  function selectCam(which) {
    const on1 = which === 'cam1';
    if (cam0) cam0.hidden = on1;
    panel.hidden = !on1;
    btn0.classList.toggle('is-active', !on1);
    btn1.classList.toggle('is-active', on1);
    btn0.setAttribute('aria-selected', String(!on1));
    btn1.setAttribute('aria-selected', String(on1));
    if (!on1) stopStream();
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
    const connected = body?.camera_ok === true;
    const fps = connected && body.fps != null ? body.fps : null;
    paintStatusLine(connected, fps);
    setControls(connected, body ? REASON_CAM : REASON_LINK);
    text('cam1Fps', fps);
    text('cam1Latency', connected && body.latency_ms != null ? body.latency_ms : null);
    text('cam1Drops', connected && body.dropped != null ? body.dropped : null);
    const visible = panel.getClientRects().length > 0;
    const canStream = visible && body && body.ok !== false && body.state !== 'absent';
    if (!canStream) {
      stopStream();
      if (empty) {
        empty.hidden = false;
        empty.textContent = NO_SIGNAL;
      }
      if (honesty) honesty.textContent = NO_SIGNAL;
      if (histEmpty) histEmpty.hidden = false;
      return body != null;
    }
    if (img && !String(img.src || '').includes('cam1/stream.mjpg')) img.src = STREAM;
    const has = connected && body.has_frame === true;
    if (img) img.hidden = !has;
    if (empty) empty.hidden = has;
    if (honesty) honesty.textContent = has ? (body.real === true ? 'פריים חי' : 'פריים חי') : NO_SIGNAL;
    if (histEmpty) histEmpty.hidden = has;
    if (ae && document.activeElement !== ae) ae.checked = body.ae?.enabled === true;
    if (exposure && document.activeElement !== exposure && body.exposure_us != null) exposure.value = String(body.exposure_us);
    if (gain && document.activeElement !== gain && body.gain != null) gain.value = String(body.gain);
    if (res && document.activeElement !== res && body.width && body.height) {
      const next = `${body.width}x${body.height}`;
      if ([...res.options].some((opt) => opt.value === next)) res.value = next;
    }
    if (fpsSet && document.activeElement !== fpsSet && body.stream?.fps != null) fpsSet.value = String(body.stream.fps);
    if (!pushing && ![ae, exposure, gain, res, fpsSet].includes(document.activeElement)) applied = readForm();
    drawHist(hist, img);
    return true;
  }

  img?.addEventListener('load', () => {
    img.hidden = false;
    if (empty) empty.hidden = true;
    if (honesty) honesty.textContent = 'פריים חי';
    if (histEmpty) histEmpty.hidden = true;
    drawHist(hist, img);
  });

  async function pushSettings() {
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
      stream: { fps: 15 },
    };
    try {
      await api('/api/jetson/v1/cam1/settings', {
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
