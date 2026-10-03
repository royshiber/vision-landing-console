/**
 * Gimbal pad on the optics cameras view.
 * Direction is an absolute angle on the companion angle route.
 * Up sends a negative pitch so the picture rises on this upside-down A8.
 * Release stops repeating. It does not recenter.
 * Center uses the center route and returns the aim to zero.
 * Zoom is press-and-hold on the existing zoom route.
 * Lock is SIYI lock vs follow.
 */

export const GIMBAL_SPEED = 40;
export const GIMBAL_YAW_MIN = -135;
export const GIMBAL_YAW_MAX = 135;
export const GIMBAL_PITCH_MIN = -90;
export const GIMBAL_PITCH_MAX = 25;

let moveSpeed = GIMBAL_SPEED;

export function setGimbalMoveSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return moveSpeed;
  moveSpeed = Math.min(100, Math.max(1, Math.round(n)));
  return moveSpeed;
}
export const LINK_DOWN_HE = 'אין קישור למחשב המשימה';
export const NO_REPLY_HE = 'אין מענה מהגימבל';
export const CONTROL_OFF_HE = 'שליטת הגימבל כבויה';
export const LOCKED_HE = 'נעול';
export const UNLOCKED_HE = 'משוחרר';
export const RF_GIMBAL_REASON_HE = 'במצב RF אין וידאו';

const ANGLE_URL = '/api/jetson/v1/gimbal/angle';
const ZOOM_URL = '/api/jetson/v1/gimbal/zoom';
const MODE_URL = '/api/jetson/v1/gimbal/mode';
const CENTER_URL = '/api/jetson/v1/gimbal/center';
const STATUS_URL = '/api/jetson/v1/status/gimbal';
const HOLD_MS = 200;
const ZERO_AIM = Object.freeze({ yaw: 0, pitch: 0 });

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function gimbalMoveBody(dir, from = ZERO_AIM) {
  const baseYaw = Number(from?.yaw);
  const basePitch = Number(from?.pitch);
  let yaw = Number.isFinite(baseYaw) ? baseYaw : 0;
  let pitch = Number.isFinite(basePitch) ? basePitch : 0;
  const delta = moveSpeed;
  if (dir === 'up') pitch -= delta;
  else if (dir === 'down') pitch += delta;
  else if (dir === 'left') yaw -= delta;
  else if (dir === 'right') yaw += delta;
  else return null;
  return {
    yaw: clamp(yaw, GIMBAL_YAW_MIN, GIMBAL_YAW_MAX),
    pitch: clamp(pitch, GIMBAL_PITCH_MIN, GIMBAL_PITCH_MAX),
  };
}

export function gimbalZoomBody(dir) {
  if (dir === 'in') return { zoom: 1 };
  if (dir === 'out') return { zoom: -1 };
  return { zoom: 0 };
}

export function gimbalKeyAction(key) {
  if (key === 'ArrowUp') return { hold: 'up', kind: 'angle' };
  if (key === 'ArrowDown') return { hold: 'down', kind: 'angle' };
  if (key === 'ArrowLeft') return { hold: 'left', kind: 'angle' };
  if (key === 'ArrowRight') return { hold: 'right', kind: 'angle' };
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

function rfWork() {
  return typeof document !== 'undefined' && document.body?.dataset?.workPath === 'rf';
}

export function gimbalPadView(companion) {
  if (rfWork()) {
    return { enabled: false, reasonHe: RF_GIMBAL_REASON_HE, locked: false };
  }
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
  paintNum(root.querySelector('#gimbalYaw') || root.querySelector('.gimbal-yaw-value'), finite(view?.yaw));
  paintNum(root.querySelector('#gimbalPitch') || root.querySelector('.gimbal-pitch-value'), finite(view?.pitch));
  paintNum(root.querySelector('#gimbalZoomValue') || root.querySelector('.gimbal-zoom-value'), finite(view?.zoom));
}

function unwrap(body) {
  if (body && body.lane === 'NEW' && body.data && typeof body.data === 'object') return body.data;
  return body;
}

const gimbalViewListeners = new Set();
let lastGimbalView = null;

export function onGimbalView(fn) {
  gimbalViewListeners.add(fn);
  if (lastGimbalView) fn(lastGimbalView);
  return () => gimbalViewListeners.delete(fn);
}

function emitGimbalView(view) {
  lastGimbalView = view;
  for (const fn of gimbalViewListeners) fn(view);
}

export function postGimbal(url, body) {
  return postJson(url, body);
}

function rfAction(url) {
  const u = String(url);
  if (u.includes('zoom')) return 'zoom';
  if (u.includes('mode')) return 'mode';
  if (u.includes('center')) return 'center';
  if (u.includes('angle')) return 'angle';
  return 'rate';
}

function postJson(url, body) {
  if (rfWork()) {
    return postRf({ kind: 'gimbal', action: rfAction(url), ...body });
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

function typingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

let padSession = null;

function createPadSession(doc, post) {
  const roots = new Set();
  let generation = 0;
  let timer = null;
  let stamp = 0;
  let aim = { yaw: 0, pitch: 0 };
  let view = gimbalPadView(null);

  function paint(next) {
    view = next;
    stamp += 1;
    if (!view.enabled && timer != null) release();
    for (const root of roots) applyGimbalPad(root, view);
    emitGimbalView(view);
  }

  function release() {
    let held = '';
    for (const root of roots) {
      if (root.dataset.hold) held = root.dataset.hold;
    }
    if (timer == null && !held) return;
    generation += 1;
    if (timer != null) clearInterval(timer);
    timer = null;
    for (const root of roots) {
      root.querySelectorAll('.is-held').forEach((el) => el.classList.remove('is-held'));
      root.dataset.hold = '';
    }
    if (held.startsWith('zoom')) post(ZOOM_URL, gimbalZoomBody('stop')).catch(() => {});
  }

  function rootOf(btn) {
    return btn?.closest('[data-gimbal-root]') || null;
  }

  function holdRepeat(btn, key, tick) {
    const root = rootOf(btn);
    if (!view.enabled || !root || !btn || btn.disabled) return;
    release();
    const token = generation;
    root.dataset.hold = key;
    btn.classList.add('is-held');
    const send = () => {
      if (token !== generation || !view.enabled) return;
      tick();
    };
    send();
    timer = setInterval(send, HOLD_MS);
  }

  function startAngle(btn, dir) {
    holdRepeat(btn, dir, () => {
      const prev = aim;
      const next = gimbalMoveBody(dir, aim);
      if (!next) return;
      aim = next;
      post(ANGLE_URL, next).catch(() => {
        if (aim === next) aim = prev;
      });
    });
  }

  function startZoom(btn, key, dir) {
    holdRepeat(btn, key, () => {
      post(ZOOM_URL, gimbalZoomBody(dir)).catch(() => {});
    });
  }

  function attach(root) {
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    root.dataset.gimbalRoot = '1';
    roots.add(root);
    for (const btn of root.querySelectorAll('[data-gimbal]')) {
      const kind = btn.dataset.gimbal;
      if (kind === 'lock' || kind === 'center') continue;
      const zoomDir = kind === 'zoom-in' ? 'in' : kind === 'zoom-out' ? 'out' : '';
      const start = (event) => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault();
        try { btn.setPointerCapture(event.pointerId); } catch { /* keyboard */ }
        if (zoomDir) startZoom(btn, `zoom-${zoomDir}`, zoomDir);
        else if (kind === 'up' || kind === 'down' || kind === 'left' || kind === 'right') startAngle(btn, kind);
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
      const prev = aim;
      aim = { yaw: 0, pitch: 0 };
      post(CENTER_URL, {}).catch(() => { aim = prev; });
    });
    applyGimbalPad(root, view);
  }

  function opticsOpen() {
    const panel = doc.getElementById('optics');
    return Boolean(panel && panel.classList.contains('visible'));
  }

  function keyRoot() {
    if (opticsOpen()) return doc.getElementById('gimbalPad');
    const screen = doc.getElementById('gimbalScreen');
    if (screen && !screen.hidden) return screen;
    return null;
  }

  doc.addEventListener('keydown', (event) => {
    const root = keyRoot();
    if (event.repeat || !root || typingTarget(doc.activeElement)) return;
    const action = gimbalKeyAction(event.key);
    if (!action) return;
    event.preventDefault();
    const btn = root.querySelector(`[data-gimbal="${action.hold}"]`);
    if (action.kind === 'angle') startAngle(btn, action.hold);
    else {
      const dir = action.hold === 'zoom-in' ? 'in' : 'out';
      startZoom(btn, action.hold, dir);
    }
  });
  doc.addEventListener('keyup', (event) => {
    if (gimbalKeyAction(event.key)) release();
  });
  doc.defaultView?.addEventListener('blur', release);

  doc.addEventListener('vlc-companion-cameras', (event) => {
    const detail = event.detail;
    const gimbal = detail?.health?.gimbal || detail?.gimbal;
    if (!gimbal && detail?.reachable !== true) return;
    paint(gimbalPadView(detail));
  });

  async function poll() {
    const panel = doc.getElementById('optics');
    if (!panel || !panel.classList.contains('visible')) return;
    const seen = stamp;
    try {
      const res = await fetch(STATUS_URL, { cache: 'no-store' });
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

  return { attach, paint };
}

function ensurePadSession(doc, post) {
  if (!padSession) padSession = createPadSession(doc, post);
  return padSession;
}

export function bindGimbalPad(doc, { post = postJson } = {}) {
  const root = doc.getElementById('gimbalPad');
  if (!root) return;
  ensurePadSession(doc, post).attach(root);
}

/** Same hold, center, zoom, and lock actions as the optics pad. */
export function bindGimbalPadRoot(root, doc = root?.ownerDocument, { post = postJson } = {}) {
  if (!root || !doc) return;
  ensurePadSession(doc, post).attach(root);
}

if (typeof document !== 'undefined' && document.getElementById('gimbalPad')) {
  bindGimbalPad(document);
}
