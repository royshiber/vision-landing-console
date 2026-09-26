/**
 * Gimbal pad on the optics cameras view. Speed and zoom are press-and-hold.
 * Lock is SIYI lock vs follow. Gimbal motion only.
 */

export const GIMBAL_SPEED = 40;
export const LINK_DOWN_HE = 'אין קישור למחשב המשימה';
export const NO_REPLY_HE = 'אין מענה מהגימבל';
export const CONTROL_OFF_HE = 'שליטת הגימבל כבויה';
export const LOCKED_HE = 'נעול';
export const UNLOCKED_HE = 'משוחרר';

const RATE_URL = '/api/jetson/v1/gimbal/rate';
const ZOOM_URL = '/api/jetson/v1/gimbal/zoom';
const MODE_URL = '/api/jetson/v1/gimbal/mode';
const STATUS_URL = '/api/jetson/v1/status/gimbal';
const HOLD_MS = 200;

export function gimbalMoveBody(dir) {
  if (dir === 'up') return { yaw: 0, pitch: GIMBAL_SPEED };
  if (dir === 'down') return { yaw: 0, pitch: -GIMBAL_SPEED };
  if (dir === 'left') return { yaw: -GIMBAL_SPEED, pitch: 0 };
  if (dir === 'right') return { yaw: GIMBAL_SPEED, pitch: 0 };
  return null;
}

export function gimbalStopBody() {
  return { yaw: 0, pitch: 0 };
}

export function gimbalZoomBody(dir) {
  if (dir === 'in') return { zoom: 1 };
  if (dir === 'out') return { zoom: -1 };
  return { zoom: 0 };
}

function gimbalSnapshot(companion) {
  if (!companion || typeof companion !== 'object') return null;
  return companion.health?.gimbal || companion.gimbal || null;
}

function rfWork() {
  return typeof document !== 'undefined' && document.body?.dataset?.workPath === 'rf';
}

export function gimbalPadView(companion) {
  if (rfWork()) {
    const locked = document.body?.dataset?.rfGimbalMode === 'lock';
    return { enabled: true, reasonHe: '', locked };
  }
  const reachable = companion?.reachable === true && companion?.mode !== 'off';
  const gimbal = gimbalSnapshot(companion);
  const locked = gimbal?.mode === 'lock';
  if (!reachable) {
    return { enabled: false, reasonHe: LINK_DOWN_HE, locked: false };
  }
  if (!gimbal || gimbal.present !== true) {
    return { enabled: false, reasonHe: NO_REPLY_HE, locked: false };
  }
  if (gimbal.control_enabled === false) {
    return { enabled: false, reasonHe: CONTROL_OFF_HE, locked };
  }
  return { enabled: true, reasonHe: '', locked };
}

export function applyGimbalPad(root, view) {
  if (!root) return;
  const enabled = view?.enabled === true;
  root.dataset.state = enabled ? 'live' : 'down';
  const reason = root.querySelector('.gimbal-pad-reason');
  if (reason) reason.textContent = enabled ? '' : (view?.reasonHe || LINK_DOWN_HE);
  const locked = view?.locked === true;
  for (const btn of root.querySelectorAll('[data-gimbal]')) {
    btn.disabled = !enabled;
    if (enabled) btn.removeAttribute('title');
    else btn.title = view?.reasonHe || LINK_DOWN_HE;
  }
  const lockBtn = root.querySelector('[data-gimbal="lock"]');
  if (lockBtn) {
    lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    lockBtn.textContent = locked ? LOCKED_HE : UNLOCKED_HE;
  }
}

function unwrap(body) {
  if (body && body.lane === 'NEW' && body.data && typeof body.data === 'object') return body.data;
  return body;
}

function postJson(url, body) {
  if (rfWork()) {
    let action = 'rate';
    if (String(url).includes('zoom')) action = 'zoom';
    else if (String(url).includes('mode')) action = 'mode';
    return postRf({ kind: 'gimbal', action, ...body });
  }
  return postHttp(url, body);
}

async function postRf(body) {
  const res = await fetch('/api/links/rf-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) {
    const err = new Error('gimbal');
    err.status = res.status;
    err.body = unwrap(parsed) || parsed;
    throw err;
  }
  return unwrap(parsed);
}

async function postHttp(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) {
    const err = new Error('gimbal');
    err.status = res.status;
    err.body = unwrap(parsed) || parsed;
    throw err;
  }
  return unwrap(parsed);
}

export function bindGimbalPad(doc, { post = postJson } = {}) {
  const root = doc.getElementById('gimbalPad');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  let generation = 0;
  let timer = null;
  let stamp = 0;
  let view = gimbalPadView(null);

  function paint(next) {
    view = next;
    stamp += 1;
    if (!view.enabled && timer != null) release();
    applyGimbalPad(root, view);
  }

  function release() {
    if (timer == null && generation === 0) return;
    generation += 1;
    if (timer != null) clearInterval(timer);
    timer = null;
    root.querySelectorAll('.is-held').forEach((el) => el.classList.remove('is-held'));
    const held = root.dataset.hold || '';
    root.dataset.hold = '';
    if (!held) return;
    const stop = held.startsWith('zoom') ? gimbalZoomBody('stop') : gimbalStopBody();
    const url = held.startsWith('zoom') ? ZOOM_URL : RATE_URL;
    post(url, stop).catch(() => {});
  }

  function hold(btn, key, url, body) {
    if (!view.enabled || btn.disabled) return;
    release();
    const token = generation;
    root.dataset.hold = key;
    btn.classList.add('is-held');
    const send = () => {
      if (token !== generation || !view.enabled) return;
      post(url, body).catch(() => {});
    };
    send();
    timer = setInterval(send, HOLD_MS);
  }

  for (const btn of root.querySelectorAll('[data-gimbal]')) {
    const kind = btn.dataset.gimbal;
    if (kind === 'lock') continue;
    const move = gimbalMoveBody(kind);
    const zoomDir = kind === 'zoom-in' ? 'in' : kind === 'zoom-out' ? 'out' : '';
    const start = (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      try { btn.setPointerCapture(event.pointerId); } catch { /* keyboard */ }
      if (move) hold(btn, kind, RATE_URL, move);
      else if (zoomDir) hold(btn, `zoom-${zoomDir}`, ZOOM_URL, gimbalZoomBody(zoomDir));
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('blur', release);
  }

  const lockBtn = root.querySelector('[data-gimbal="lock"]');
  lockBtn?.addEventListener('click', () => {
    if (!view.enabled || lockBtn.disabled) return;
    const next = lockBtn.getAttribute('aria-pressed') === 'true' ? 'follow' : 'lock';
    post(MODE_URL, { mode: next }).then(() => {
      paint({ ...view, locked: next === 'lock' });
    }).catch(() => {});
  });

  doc.addEventListener('vlc-companion-cameras', (event) => {
    paint(gimbalPadView(event.detail));
  });

  async function poll() {
    const panel = doc.getElementById('debriefRecordingsPanel');
    if (!panel || !panel.classList.contains('visible')) return;
    const seen = stamp;
    try {
      const res = await fetch(STATUS_URL);
      if (!res.ok) throw new Error('down');
      const body = unwrap(await res.json());
      if (stamp !== seen) return;
      paint(gimbalPadView({ reachable: true, mode: 'real', health: { gimbal: body } }));
    } catch {
      if (stamp !== seen) return;
      paint(gimbalPadView({ reachable: false }));
    }
  }
  setInterval(poll, 1000);
  paint(view);
}

if (typeof document !== 'undefined' && document.getElementById('gimbalPad')) {
  bindGimbalPad(document);
}
