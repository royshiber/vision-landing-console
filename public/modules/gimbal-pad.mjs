/**
 * Gimbal pad on the optics cameras view. Speed and zoom are press-and-hold.
 * Center recenters. Lock is SIYI lock vs follow. Gimbal motion only.
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
const CENTER_URL = '/api/jetson/v1/gimbal/center';
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

export function gimbalKeyAction(key) {
  if (key === 'ArrowUp') return { hold: 'up', kind: 'rate' };
  if (key === 'ArrowDown') return { hold: 'down', kind: 'rate' };
  if (key === 'ArrowLeft') return { hold: 'left', kind: 'rate' };
  if (key === 'ArrowRight') return { hold: 'right', kind: 'rate' };
  if (key === '+' || key === '=') return { hold: 'zoom-in', kind: 'zoom' };
  if (key === '-' || key === '_') return { hold: 'zoom-out', kind: 'zoom' };
  return null;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function gimbalSnapshot(companion) {
  if (!companion || typeof companion !== 'object') return null;
  return companion.health?.gimbal || companion.gimbal || null;
}

function attitudeOf(gimbal) {
  const att = gimbal && typeof gimbal.attitude === 'object' ? gimbal.attitude : null;
  return {
    yaw: att ? finite(att.yaw) : null,
    pitch: att ? finite(att.pitch) : null,
    zoom: gimbal ? finite(gimbal.zoom) : null,
  };
}

export function gimbalPadView(companion) {
  const reachable = companion?.reachable === true && companion?.mode !== 'off';
  const gimbal = gimbalSnapshot(companion);
  const locked = gimbal?.mode === 'lock';
  const angles = attitudeOf(gimbal);
  if (!reachable) {
    return { enabled: false, reasonHe: LINK_DOWN_HE, locked: false, yaw: null, pitch: null, zoom: null };
  }
  if (!gimbal || gimbal.present !== true) {
    return { enabled: false, reasonHe: NO_REPLY_HE, locked: false, ...angles };
  }
  if (gimbal.control_enabled === false) {
    return { enabled: false, reasonHe: CONTROL_OFF_HE, locked, ...angles };
  }
  return { enabled: true, reasonHe: '', locked, ...angles };
}

function paintNum(el, value) {
  if (!el) return;
  el.textContent = Number.isFinite(value) ? value.toFixed(1) : '—';
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
  paintNum(root.querySelector('#gimbalYaw'), finite(view?.yaw));
  paintNum(root.querySelector('#gimbalPitch'), finite(view?.pitch));
  paintNum(root.querySelector('#gimbalZoomValue'), finite(view?.zoom));
}

function unwrap(body) {
  if (body && body.lane === 'NEW' && body.data && typeof body.data === 'object') return body.data;
  return body;
}

async function postJson(url, body) {
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

function typingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
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
    if (!view.enabled || !btn || btn.disabled) return;
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
    if (kind === 'lock' || kind === 'center') continue;
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

  const centerBtn = root.querySelector('[data-gimbal="center"]');
  centerBtn?.addEventListener('click', () => {
    if (!view.enabled || centerBtn.disabled) return;
    post(CENTER_URL, {}).catch(() => {});
  });

  function opticsOpen() {
    const panel = doc.getElementById('optics');
    return Boolean(panel && panel.classList.contains('visible'));
  }

  doc.addEventListener('keydown', (event) => {
    if (event.repeat || !opticsOpen() || typingTarget(doc.activeElement)) return;
    const action = gimbalKeyAction(event.key);
    if (!action) return;
    event.preventDefault();
    const btn = root.querySelector(`[data-gimbal="${action.hold}"]`);
    if (action.kind === 'rate') {
      const body = gimbalMoveBody(action.hold);
      if (body) hold(btn, action.hold, RATE_URL, body);
    } else {
      const dir = action.hold === 'zoom-in' ? 'in' : 'out';
      hold(btn, action.hold, ZOOM_URL, gimbalZoomBody(dir));
    }
  });
  doc.addEventListener('keyup', (event) => {
    if (gimbalKeyAction(event.key)) release();
  });
  doc.defaultView?.addEventListener('blur', release);

  doc.addEventListener('vlc-companion-cameras', (event) => {
    paint(gimbalPadView(event.detail));
  });

  async function poll() {
    const panel = doc.getElementById('optics');
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
