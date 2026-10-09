/**
 * Boxes on the live camera tiles. The list and the switches live in the
 * right-click menu. No standing panel. Empty when detection is off or the
 * camera has no frame.
 *
 * A later optics menu can call __vlcFillVisionMenu(slot, camera) or dispatch
 * vlc-tile-menu with { slot, camera } to drop the same group into its menu.
 */
export const REASON_OFF = 'הזיהוי כבוי';
export const REASON_NO_STREAM = 'אין נתון על זרם המצלמות';

const TRACKS_URL = '/api/jetson/v1/vision/tracks';
const CONFIG_URL = '/api/jetson/v1/vision/config';
const LOCK_URL = '/api/jetson/v1/vision/lock';

const cache = new Map();
let sortMode = 'class';
let menuCamera = '';
let timer = 0;
let painting = false;

export function unwrapTracks(body) {
  if (body && body.lane === 'NEW' && body.data && typeof body.data === 'object') return body.data;
  return body && typeof body === 'object' ? body : null;
}

export function mediaFit(media, boxW, boxH) {
  const nw = media?.naturalWidth || media?.videoWidth || 0;
  const nh = media?.naturalHeight || media?.videoHeight || 0;
  if (!(nw > 0) || !(nh > 0) || !(boxW > 0) || !(boxH > 0)) return null;
  let fit = 'contain';
  if (typeof getComputedStyle === 'function') fit = getComputedStyle(media).objectFit || 'contain';
  if (fit === 'fill') return { x: 0, y: 0, scaleX: boxW / nw, scaleY: boxH / nh, nw, nh };
  const scale = fit === 'cover' ? Math.max(boxW / nw, boxH / nh) : Math.min(boxW / nw, boxH / nh);
  return {
    x: (boxW - nw * scale) / 2,
    y: (boxH - nh * scale) / 2,
    scaleX: scale,
    scaleY: scale,
    nw,
    nh,
  };
}

export function framePoint(localX, localY, fit, frameW, frameH) {
  if (!fit) return null;
  const srcX = (localX - fit.x) / fit.scaleX;
  const srcY = (localY - fit.y) / fit.scaleY;
  const sx = frameW > 0 ? frameW / fit.nw : 1;
  const sy = frameH > 0 ? frameH / fit.nh : 1;
  return { x: srcX * sx, y: srcY * sy };
}

export function hitTrack(tracks, x, y) {
  const rows = Array.isArray(tracks) ? tracks : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const box = rows[i]?.bbox;
    if (!box || box.length < 4) continue;
    const [bx, by, bw, bh] = box.map(Number);
    if (![bx, by, bw, bh].every(Number.isFinite)) continue;
    if (x >= bx && y >= by && x <= bx + bw && y <= by + bh) return rows[i];
  }
  return null;
}

function emptyPayload(reason) {
  return {
    ok: false,
    enabled: false,
    tracks: [],
    lock: null,
    stream: false,
    reason_he: reason,
    gimbal_steer: { enabled: false, sent: false, blocked: true, reason_he: '', flight_commands: false },
    flight_commands: false,
  };
}

function hostList(doc) {
  const list = [];
  doc.querySelectorAll('[data-camera-stage]').forEach((host) => {
    const stage = host.dataset.cameraStage || '';
    if (!stage) return;
    if (stage === 'horizon') {
      list.push({ host, camera: '', kind: 'horizon' });
      return;
    }
    list.push({ host, camera: stage, kind: 'tile' });
  });
  return list;
}

export function placeMenuBox({ x = 0, y = 0, menuW = 0, menuH = 0, viewW = 0, viewH = 0, margin = 8 } = {}) {
  const viewWidth = Math.max(0, Number(viewW) || 0);
  const viewHeight = Math.max(0, Number(viewH) || 0);
  const pad = Math.min(Math.max(0, Number(margin) || 0), Math.floor(Math.min(viewWidth, viewHeight) / 4) || 0);
  const maxW = Math.max(0, viewWidth - pad * 2);
  const maxH = Math.max(0, viewHeight - pad * 2);
  const width = Math.min(Math.max(0, Number(menuW) || 0), maxW || Math.max(0, Number(menuW) || 0));
  const naturalH = Math.max(0, Number(menuH) || 0);
  const height = maxH > 0 ? Math.min(naturalH, maxH) : naturalH;
  const scrolls = naturalH > height + 0.5;
  let top = Number(y) || 0;
  const bottomLimit = viewHeight - pad;
  if (top + height > bottomLimit) {
    const above = top - height;
    top = above >= pad ? above : Math.max(pad, bottomLimit - height);
  }
  if (top < pad) top = pad;
  let left = Number(x) || 0;
  const rightLimit = viewWidth - pad;
  if (left + width > rightLimit) {
    const flipped = left - width;
    left = flipped >= pad ? flipped : Math.max(pad, rightLimit - width);
  }
  if (left < pad) left = pad;
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
    maxHeight: Math.round(height),
    scrolls,
  };
}

export function visionAskSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  if (typeof payload.enabled === 'boolean') out.enabled = payload.enabled;
  if (typeof payload.stream === 'boolean') out.stream = payload.stream;
  const reason = String(payload.reason_he || '').trim();
  if (reason) out.reason_he = reason;
  if (payload.backend === 'unavailable' || reason === 'אין מודל זיהוי') out.model = false;
  else if (payload.enabled === true && payload.stream === true && payload.backend && payload.backend !== 'off') {
    out.model = true;
  }
  if (Array.isArray(payload.tracks)) {
    out.tracks = payload.tracks.slice(0, 40).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = {};
      if (row.id != null && String(row.id) !== '') item.id = row.id;
      if (row.class) item.class = String(row.class);
      if (row.label_he) item.label_he = String(row.label_he);
      const color = String(row.color_he || '').trim();
      if (color) item.color_he = color.slice(0, 24);
      return Object.keys(item).length ? item : null;
    }).filter(Boolean);
  }
  if (payload.lock == null) out.lock = null;
  else if (payload.lock && payload.lock.id != null && String(payload.lock.id) !== '') out.lock = { id: payload.lock.id };
  return Object.keys(out).length ? out : null;
}

export function visionAskState() {
  const camera = selectedCamera();
  if (!camera) return null;
  return visionAskSnapshot(cache.get(camera));
}

function selectedCamera() {
  for (const payload of cache.values()) {
    if (payload?.selected_camera) return payload.selected_camera;
  }
  return '';
}

function payloadFor(camera) {
  return cache.get(camera) || emptyPayload(REASON_NO_STREAM);
}

function mediaOf(host) {
  const nodes = host.querySelectorAll('img, video');
  for (const node of nodes) {
    if (node.classList?.contains('vision-box-layer')) continue;
    if (node.hidden) continue;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
    return node;
  }
  return host.querySelector('img, video');
}

function horizonMediaOn(host) {
  const ids = ['horizonVideoEl', 'horizonCameraBg', 'instrumentVideoFrame'];
  return ids.some((id) => {
    const el = host.ownerDocument.getElementById(id);
    if (!el || el.hidden || !host.contains(el)) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function ensureChrome(host, camera) {
  if (camera && !host.dataset.visionCamera) host.dataset.visionCamera = camera;
  if (host.dataset.visionBound === '1') return;
  host.dataset.visionBound = '1';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const canvas = host.ownerDocument.createElement('canvas');
  canvas.className = 'vision-box-layer';
  canvas.hidden = true;
  const note = host.ownerDocument.createElement('p');
  note.className = 'vision-box-note';
  note.hidden = true;
  host.appendChild(canvas);
  host.appendChild(note);
  const repaint = () => {
    const camera = host.dataset.visionCamera || '';
    const kind = host.id === 'pfdHorizonStage' ? 'horizon' : 'tile';
    paintHost(host, payloadFor(camera), { kind });
  };
  host.addEventListener('load', (event) => {
    if (event.target instanceof Element && host.contains(event.target)) repaint();
  }, true);
  if (typeof MutationObserver === 'function') {
    const watch = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const node = record.target;
        if (!(node instanceof Element)) return false;
        if (node.classList.contains('vision-box-layer') || node.classList.contains('vision-box-note')) return false;
        return true;
      });
      if (relevant) repaint();
    });
    watch.observe(host, { attributes: true, subtree: true, attributeFilter: ['hidden', 'src'] });
  }
  canvas.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const camera = host.dataset.visionCamera || '';
    const payload = payloadFor(camera);
    const fit = mediaFit(mediaOf(host), canvas.clientWidth, canvas.clientHeight);
    const rect = canvas.getBoundingClientRect();
    const point = framePoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
      fit,
      payload.frame_width,
      payload.frame_height,
    );
    const track = point ? hitTrack(payload.tracks, point.x, point.y) : null;
    if (!track) return;
    void postLock({ camera, id: track.id });
  });
  host.addEventListener('contextmenu', (event) => {
    if (!(event.target instanceof Element) || !host.contains(event.target)) return;
    const camera = host.dataset.visionCamera || host.dataset.visionFollow || selectedCamera() || 'cam3';
    if (event.defaultPrevented) {
      const slot = host.ownerDocument.querySelector('[data-vision-menu-slot]');
      if (slot) fillVisionMenu(slot, camera);
      return;
    }
    event.preventDefault();
    openMenu(host.ownerDocument, camera, event.clientX, event.clientY);
  });
}

export function paintHost(host, payload, { kind = 'tile' } = {}) {
  if (!host) return;
  ensureChrome(host);
  const doc = host.ownerDocument;
  const canvas = host.querySelector(':scope > .vision-box-layer');
  const note = host.querySelector(':scope > .vision-box-note');
  const camera = kind === 'horizon'
    ? (payload?.selected_camera || selectedCamera() || host.dataset.visionCamera || 'cam3')
    : (host.dataset.visionCamera || payload?.camera || '');
  host.dataset.visionCamera = camera;
  const showHorizon = kind !== 'horizon' || horizonMediaOn(host);
  const reason = payload?.reason_he || '';
  const tracks = showHorizon && !reason ? (payload?.tracks || []) : [];
  const lockId = payload?.lock?.id;
  host.dataset.visionReason = showHorizon ? reason : '';
  host.dataset.visionTracks = tracks.map((row) => row.id).join(',');
  host.dataset.visionLock = lockId == null || !showHorizon ? '' : String(lockId);
  if (note) {
    const text = showHorizon ? reason : '';
    note.hidden = !text;
    note.textContent = text;
  }
  if (!canvas) return;
  const media = mediaOf(host);
  const width = Math.max(1, Math.round(host.clientWidth || canvas.clientWidth || 1));
  const height = Math.max(1, Math.round(host.clientHeight || canvas.clientHeight || 1));
  const fit = media ? mediaFit(media, width, height) : null;
  const drawable = showHorizon && fit && tracks.length > 0 && media && !media.hidden;
  canvas.hidden = !drawable;
  canvas.dataset.hit = drawable ? '1' : '0';
  if (!drawable) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    return;
  }
  const ratio = doc.defaultView?.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const fw = payload.frame_width || fit.nw;
  const fh = payload.frame_height || fit.nh;
  const ordered = [...tracks].sort((a, b) => (a.id === lockId ? 1 : 0) - (b.id === lockId ? 1 : 0));
  for (const track of ordered) {
    const box = track.bbox || [];
    if (box.length < 4) continue;
    const x = fit.x + (box[0] * fit.nw / fw) * fit.scaleX;
    const y = fit.y + (box[1] * fit.nh / fh) * fit.scaleY;
    const w = (box[2] * fit.nw / fw) * fit.scaleX;
    const h = (box[3] * fit.nh / fh) * fit.scaleY;
    const locked = lockId != null && track.id === lockId;
    ctx.lineWidth = locked ? 4 : 2;
    ctx.strokeStyle = locked ? '#67e8f9' : '#facc15';
    ctx.strokeRect(x, y, w, h);
    const label = track.label_he || '';
    const idText = String(track.id ?? '');
    ctx.font = '700 13px Heebo, sans-serif';
    const labelW = label ? ctx.measureText(label).width : 0;
    const idW = ctx.measureText(idText).width;
    const pad = 4;
    const textW = labelW + (label && idText ? 8 : 0) + idW;
    const top = Math.max(0, y - 18);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(x, top, textW + pad * 2, 16);
    ctx.fillStyle = '#f8fafc';
    let cursor = x + pad;
    if (label) {
      ctx.fillText(label, cursor, top + 12);
      cursor += labelW + 8;
    }
    ctx.fillText(idText, cursor, top + 12);
  }
}

function paintAll(doc) {
  for (const item of hostList(doc)) {
    const camera = item.kind === 'horizon' ? (selectedCamera() || '') : item.camera;
    const payload = camera ? payloadFor(camera) : emptyPayload(REASON_OFF);
    if (item.kind === 'horizon' && camera) payload.camera = camera;
    paintHost(item.host, item.kind === 'horizon' && !camera ? emptyPayload(REASON_OFF) : payload, item);
  }
}

async function readJson(res) {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('json')) return null;
  return unwrapTracks(await res.json());
}

async function fetchTracks(camera) {
  try {
    const res = await fetch(`${TRACKS_URL}?camera=${encodeURIComponent(camera)}&sort=${encodeURIComponent(sortMode)}`, { cache: 'no-store' });
    const body = await readJson(res);
    if (!res.ok || !body) return emptyPayload(REASON_NO_STREAM);
    body.camera = body.camera || camera;
    return body;
  } catch {
    return emptyPayload(REASON_NO_STREAM);
  }
}

async function refresh(doc) {
  if (painting || doc.visibilityState === 'hidden') return;
  painting = true;
  try {
    const cameras = new Set(hostList(doc).filter((item) => item.kind !== 'horizon' && item.camera).map((item) => item.camera));
    await Promise.all([...cameras].map(async (camera) => {
      cache.set(camera, await fetchTracks(camera));
    }));
    paintAll(doc);
    if (!doc.getElementById('visionTrackMenu')?.hidden) renderMenu(doc);
  } finally {
    painting = false;
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await readJson(res);
  return { ok: res.ok, data };
}

async function postConfig(doc, body) {
  const result = await postJson(CONFIG_URL, body);
  await refresh(doc);
  return result;
}

async function postLock(body) {
  const doc = document;
  const result = await postJson(LOCK_URL, body);
  await refresh(doc);
  return result;
}

const MENU_HTML = `
    <p class="vision-menu-kicker">זיהוי</p>
    <button type="button" class="vision-track-menu-item" data-vision-action="toggle"></button>
    <p class="vision-menu-kicker">עצמים</p>
    <div class="vision-menu-sort">
      <button type="button" class="vision-track-menu-item" data-vision-sort="class">מיינו לפי סוג</button>
      <button type="button" class="vision-track-menu-item" data-vision-sort="confidence">מיינו לפי ביטחון</button>
    </div>
    <div data-vision-list></div>
    <p class="vision-menu-kicker">נעילה</p>
    <button type="button" class="vision-track-menu-item" data-vision-action="next">עברו לעצם הבא</button>
    <button type="button" class="vision-track-menu-item" data-vision-action="unlock">שחררו נעילה</button>
    <p class="vision-menu-kicker">היגוי</p>
    <button type="button" class="vision-track-menu-item" data-vision-action="steer"></button>
    <p class="vision-menu-note" data-vision-steer-note></p>
  `;

function onMenuClick(event) {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  const doc = event.currentTarget?.ownerDocument || document;
  if (!button || !doc) return;
  event.preventDefault();
    const action = button.dataset.visionAction || '';
    const sort = button.dataset.visionSort || '';
    const id = button.dataset.visionId || '';
    if (sort) {
      sortMode = sort;
      void refresh(doc);
      return;
    }
    if (action === 'toggle') {
      const payload = payloadFor(menuCamera);
      const on = payload.enabled === true && payload.selected_camera === menuCamera;
      void postConfig(doc, on ? { enabled: false } : { enabled: true, camera: menuCamera });
      return;
    }
    if (action === 'steer') {
      const payload = payloadFor(menuCamera);
      void postConfig(doc, { gimbal_steer: payload.gimbal_steer?.enabled !== true });
      return;
    }
    if (action === 'next') {
      void postLock({ action: 'next', camera: menuCamera, sort: sortMode });
      return;
    }
    if (action === 'unlock') {
      void postLock({ action: 'unlock', camera: menuCamera });
      return;
    }
    if (id) void postLock({ camera: menuCamera, id: Number(id) });
}

function menuRoot(doc) {
  let menu = doc.getElementById('visionTrackMenu');
  if (!menu) {
    menu = doc.createElement('div');
    menu.id = 'visionTrackMenu';
    menu.className = 'vision-track-menu';
    menu.hidden = true;
    menu.dir = 'rtl';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'זיהוי');
    doc.body.appendChild(menu);
    menu.addEventListener('click', onMenuClick);
    doc.addEventListener('pointerdown', (event) => {
      if (menu.hidden) return;
      if (event.target instanceof Element && (menu.contains(event.target) || event.target.closest('[data-vision-menu-slot]'))) return;
      menu.hidden = true;
    });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') menu.hidden = true;
    });
    doc.addEventListener('vlc-tile-menu', (event) => {
      const slot = event.detail?.slot;
      if (slot) fillVisionMenu(slot, event.detail.camera || menuCamera);
    });
  }
  if (!menu.querySelector('[data-vision-action="toggle"]')) menu.innerHTML = MENU_HTML;
  return menu;
}

function renderMenu(doc) {
  const menu = menuRoot(doc);
  const payload = payloadFor(menuCamera);
  const on = payload.enabled === true && payload.selected_camera === menuCamera;
  const toggle = menu.querySelector('[data-vision-action="toggle"]');
  if (toggle) toggle.textContent = on ? 'כבו זיהוי' : 'הפעילו זיהוי';
  menu.querySelectorAll('[data-vision-sort]').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.visionSort === sortMode);
    button.setAttribute('aria-pressed', button.dataset.visionSort === sortMode ? 'true' : 'false');
  });
  const list = menu.querySelector('[data-vision-list]');
  if (list) {
    list.replaceChildren();
    const rows = Array.isArray(payload.tracks) ? payload.tracks : [];
    if (!rows.length) {
      const empty = doc.createElement('p');
      empty.className = 'vision-menu-note';
      empty.textContent = payload.reason_he || 'אין עצמים';
      list.appendChild(empty);
    } else {
      for (const row of rows) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'vision-track-menu-item';
        button.dataset.visionId = String(row.id);
        if (payload.lock?.id === row.id) button.classList.add('is-locked');
        const name = doc.createElement('span');
        name.textContent = row.label_he || '';
        const id = doc.createElement('span');
        id.dir = 'ltr';
        id.textContent = String(row.id);
        const conf = doc.createElement('span');
        conf.dir = 'ltr';
        const score = Number(row.confidence);
        conf.textContent = Number.isFinite(score) ? score.toFixed(2) : '';
        button.append(name, id, conf);
        list.appendChild(button);
      }
    }
  }
  const steer = menu.querySelector('[data-vision-action="steer"]');
  if (steer) steer.textContent = payload.gimbal_steer?.enabled ? 'כבו היגוי גימבל' : 'הפעילו היגוי גימבל';
  const steerNote = menu.querySelector('[data-vision-steer-note]');
  if (steerNote) steerNote.textContent = payload.gimbal_steer?.reason_he || '';
}

export function fillVisionMenu(slot, camera) {
  if (!slot) return;
  menuCamera = camera || menuCamera;
  const doc = slot.ownerDocument;
  renderMenu(doc);
  const menu = doc.getElementById('visionTrackMenu');
  slot.replaceChildren();
  if (!menu) return;
  for (const child of menu.children) slot.appendChild(child.cloneNode(true));
  if (slot.dataset.visionClick !== '1') {
    slot.dataset.visionClick = '1';
    slot.addEventListener('click', onMenuClick);
  }
}

function openMenu(doc, camera, x, y) {
  menuCamera = camera || 'cam3';
  menuRoot(doc);
  renderMenu(doc);
  const node = doc.getElementById('visionTrackMenu');
  if (!node) return;
  const view = doc.defaultView || {};
  const viewW = view.innerWidth || 800;
  const viewH = view.innerHeight || 600;
  node.hidden = false;
  node.style.overflowY = 'auto';
  node.style.maxHeight = 'none';
  node.style.width = '240px';
  const menuW = node.offsetWidth || 240;
  const menuH = node.scrollHeight || node.offsetHeight || 0;
  const box = placeMenuBox({ x, y, menuW, menuH, viewW, viewH, margin: 8 });
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.maxHeight = `${box.maxHeight}px`;
}

export function mountVisionTracks(doc = document) {
  if (!doc?.querySelectorAll || doc.documentElement?.dataset?.visionTracks === '1') return;
  if (doc.documentElement) doc.documentElement.dataset.visionTracks = '1';
  menuRoot(doc);
  const bind = () => {
    for (const item of hostList(doc)) ensureChrome(item.host, item.camera);
  };
  bind();
  if (typeof MutationObserver === 'function' && doc.body) {
    const observer = new MutationObserver(() => bind());
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  const tick = () => { void refresh(doc); };
  tick();
  timer = doc.defaultView?.setInterval(tick, 700) || 0;
  if (doc.defaultView) {
    doc.defaultView.__vlcFillVisionMenu = (slot, camera) => fillVisionMenu(slot, camera);
    doc.defaultView.__vlcVisionAskState = () => visionAskState();
  }
}

if (typeof document !== 'undefined') mountVisionTracks(document);
