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
const frameBooks = new Map();
const drawnBoxes = new WeakMap();
const fitMemory = new WeakMap();
let sortMode = 'class';
let menuCamera = '';
let timer = 0;
let painting = false;
let inflightRefresh = null;
let sawRefresh = false;
let lastGoodAsk = null;

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

export const TRACK_POLL_MS = 180;

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

export function hitDrawnBox(boxes, x, y) {
  const rows = Array.isArray(boxes) ? boxes : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const box = rows[i];
    if (!box) continue;
    const bx = Number(box.x);
    const by = Number(box.y);
    const bw = Number(box.w);
    const bh = Number(box.h);
    if (![bx, by, bw, bh].every(Number.isFinite)) continue;
    if (x >= bx && y >= by && x <= bx + bw && y <= by + bh) return box;
  }
  return null;
}

export function trackCaption(track) {
  const name = String(track?.label_he || '').trim();
  const id = track?.id != null && String(track.id) !== '' ? `#${track.id}` : '';
  const score = Number(track?.confidence);
  const pct = Number.isFinite(score) ? `${Math.round(score * 100)}%` : '';
  return [name, id, pct].filter(Boolean).join(' · ');
}

/**
 * Caption origin so the trailing score stays inside the tile.
 * A caption wider than the tile keeps its right edge on the tile edge.
 */
export function placeTrackCaption(boxX, textWidth, tileWidth) {
  const tile = Math.max(0, Number(tileWidth) || 0);
  const text = Math.max(0, Number(textWidth) || 0);
  let x = Number(boxX);
  if (!Number.isFinite(x)) x = 0;
  if (!(tile > 0)) return { x: 0, right: text };
  if (text <= tile) {
    if (x + text > tile) x = tile - text;
    if (x < 0) x = 0;
    return { x, right: x + text };
  }
  return { x: tile - text, right: tile };
}

export function tracksMatchFrame(payload, seq, capturedAt, toleranceMs = FRAME_SYNC_TOLERANCE_MS) {
  const tagged = Number(payload?.frame_seq);
  const shown = Number(seq);
  if (tagged > 0 && shown > 0 && tagged === shown) return true;
  const stamp = Number(payload?.captured_at);
  const at = Number(capturedAt);
  if (!(stamp > 0) || !(at > 0)) return false;
  return Math.abs(stamp - at) <= toleranceMs;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(value) {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function encodeTracksHeader(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const compact = {
    ok: payload.ok === true,
    enabled: payload.enabled === true,
    camera: payload.camera || '',
    selected_camera: payload.selected_camera ?? null,
    stream: payload.stream === true,
    frame_seq: payload.frame_seq ?? null,
    captured_at: payload.captured_at ?? null,
    frame_width: payload.frame_width ?? null,
    frame_height: payload.frame_height ?? null,
    tracks: Array.isArray(payload.tracks) ? payload.tracks : [],
    lock: payload.lock && typeof payload.lock === 'object' ? payload.lock : null,
    reason_he: payload.reason_he || '',
    gimbal_steer: payload.gimbal_steer && typeof payload.gimbal_steer === 'object' ? payload.gimbal_steer : {},
    flight_commands: false,
  };
  const json = JSON.stringify(compact);
  if (json.length > 6000) return '';
  return bytesToBase64(new TextEncoder().encode(json));
}

export function decodeTracksHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const json = new TextDecoder().decode(base64ToBytes(raw));
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function cameraFromFrameUrl(src) {
  const match = String(src || '').match(/\/cameras\/(cam[0-3])\/frame/i);
  return match ? match[1].toLowerCase() : '';
}

/** How close a detection may be to the frame on screen, in milliseconds. */
export const FRAME_SYNC_TOLERANCE_MS = 80;

/**
 * Tracks for the frame on screen.
 * An untagged payload still paints. A tagged payload paints on that frame,
 * or on the nearest stored frame inside the tolerance. It does not paint
 * on a later frame the detector never saw.
 */
export function selectFrameTracks(latest, book, shownSeq, shownAt = 0) {
  const shown = Number(shownSeq);
  const tagged = Number(latest?.frame_seq);
  if (!(tagged > 0)) return latest || null;
  if (!(shown > 0) || shown === tagged) return latest || null;
  const exact = book?.get?.(shown) || null;
  if (exact) return exact;
  const at = Number(shownAt);
  if (!(at > 0)) return null;
  let best = null;
  let bestDelta = Infinity;
  const rows = [];
  if (typeof book?.forEach === 'function') book.forEach((payload) => rows.push(payload));
  if (latest) rows.push(latest);
  for (const payload of rows) {
    const stamp = Number(payload?.captured_at);
    if (!(stamp > 0)) continue;
    const delta = Math.abs(stamp - at);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = payload;
    }
  }
  if (best && bestDelta <= FRAME_SYNC_TOLERANCE_MS) return best;
  return null;
}

function emptyPayload(reason) {
  const unknown = reason === REASON_NO_STREAM;
  return {
    ok: false,
    ...(unknown ? {} : { enabled: false, stream: false }),
    tracks: [],
    lock: null,
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

const STREAM_IDS = ['cam0', 'cam1', 'cam3'];

export function visionStreamMap() {
  const out = {};
  for (const [camera, payload] of cache) {
    if (!STREAM_IDS.includes(camera) || typeof payload?.stream !== 'boolean') continue;
    if (payload.stream === false && String(payload.reason_he || '').trim() === REASON_NO_STREAM) continue;
    out[camera] = payload.stream;
  }
  return out;
}

export function visionAskSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  const camera = String(payload.camera || payload.selected_camera || '');
  if (STREAM_IDS.includes(camera)) out.camera = camera;
  const reason = String(payload.reason_he || '').trim();
  const unknownStream = reason === REASON_NO_STREAM;
  if (typeof payload.enabled === 'boolean' && !(unknownStream && payload.enabled === false)) out.enabled = payload.enabled;
  if (typeof payload.stream === 'boolean' && !(unknownStream && payload.stream === false)) out.stream = payload.stream;
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

export const VISION_ASK_WAIT_MS = 300;

function entryOf(entries, id) {
  if (!entries) return undefined;
  if (typeof entries.get === 'function') return entries.get(id);
  return entries[id];
}

function entryHas(entries, id) {
  if (!entries) return false;
  if (typeof entries.has === 'function') return entries.has(id);
  return entries[id] != null;
}

function entryValues(entries) {
  if (!entries) return [];
  if (typeof entries.values === 'function') return [...entries.values()];
  return Object.values(entries);
}

function selectedFrom(entries) {
  for (const payload of entryValues(entries)) {
    const id = payload?.selected_camera;
    if (STREAM_IDS.includes(id)) return id;
  }
  return '';
}

function liveCamera(row) {
  return Boolean(row) && (row.stream === true || (Array.isArray(row.tracks) && row.tracks.length > 0));
}

function chooseFocus(cameras, selected) {
  if (selected && liveCamera(cameras[selected])) return selected;
  for (const id of STREAM_IDS) {
    if (liveCamera(cameras[id])) return id;
  }
  if (selected && cameras[selected]) return selected;
  return STREAM_IDS.find((id) => cameras[id]) || '';
}

function packAsk(cameras, selected) {
  const ids = STREAM_IDS.filter((id) => cameras[id]);
  if (!ids.length) return null;
  const focusId = chooseFocus(cameras, selected);
  const focus = cameras[focusId];
  if (!focus) return null;
  const streams = {};
  for (const id of ids) {
    if (typeof cameras[id].stream === 'boolean') streams[id] = cameras[id].stream;
  }
  return {
    ...focus,
    camera: focus.camera || focusId,
    cameras,
    ...(Object.keys(streams).length ? { streams } : {}),
  };
}

/** Every camera that has a cached payload, with the live one at the top level. */
export function assembleVisionAsk(entries) {
  const cameras = {};
  for (const id of STREAM_IDS) {
    const snap = visionAskSnapshot(entryOf(entries, id));
    if (!snap) continue;
    if (!snap.camera) snap.camera = id;
    cameras[id] = snap;
  }
  return packAsk(cameras, selectedFrom(entries));
}

/** Fill cameras the latest read missed from the previous good ask. */
export function fillVisionAsk(state, lastGood) {
  const prior = lastGood?.cameras && typeof lastGood.cameras === 'object' ? lastGood.cameras : null;
  const next = state?.cameras && typeof state.cameras === 'object' ? state.cameras : null;
  if (!prior && !next) return state || lastGood || null;
  const cameras = { ...(prior || {}), ...(next || {}) };
  const selected = state?.camera || lastGood?.camera || '';
  return packAsk(cameras, selected);
}

export function cacheCoversAsk(entries) {
  return STREAM_IDS.every((id) => entryHas(entries, id));
}

function cacheEmpty(entries) {
  if (!entries) return true;
  if (typeof entries.size === 'number' && typeof entries.values === 'function') return entries.size === 0;
  return entryValues(entries).length === 0;
}

/**
 * Snapshot every camera. An empty or unfinished cache waits for one refresh,
 * and never longer than waitMs, then uses the last good payload.
 */
export async function waitForVisionAsk({
  read,
  refresh,
  lastGood = null,
  waitMs = VISION_ASK_WAIT_MS,
  settled = false,
} = {}) {
  const readNow = () => (typeof read === 'function' ? read() : new Map());
  const initial = readNow();
  if (cacheCoversAsk(initial) || (!cacheEmpty(initial) && settled)) {
    return fillVisionAsk(assembleVisionAsk(initial), settled ? null : lastGood);
  }
  let finished = false;
  const job = Promise.resolve().then(() => (typeof refresh === 'function' ? refresh() : null)).finally(() => {
    finished = true;
  });
  const started = Date.now();
  while (!finished && Date.now() - started < waitMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mid = readNow();
    if (cacheCoversAsk(mid)) break;
  }
  if (!finished) {
    await Promise.race([
      job,
      new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs - (Date.now() - started)))),
    ]);
  }
  return fillVisionAsk(assembleVisionAsk(readNow()), lastGood);
}

export function visionAskState() {
  const fresh = assembleVisionAsk(cache);
  const state = cacheCoversAsk(cache) ? fresh : fillVisionAsk(fresh, lastGoodAsk);
  if (state && (cacheCoversAsk(cache) || (sawRefresh && fresh))) lastGoodAsk = state;
  return state;
}

export async function visionAskReady(doc = typeof document !== 'undefined' ? document : null, waitMs = VISION_ASK_WAIT_MS) {
  const state = await waitForVisionAsk({
    read: () => cache,
    refresh: () => (doc ? refresh(doc) : null),
    lastGood: lastGoodAsk,
    waitMs,
    settled: sawRefresh,
  });
  if (state) lastGoodAsk = state;
  return state;
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

function geometryFor(host, layer, payload) {
  const media = mediaOf(host);
  const width = layer?.clientWidth || host.clientWidth || 0;
  const height = layer?.clientHeight || host.clientHeight || 0;
  const fit = media ? mediaFit(media, width, height) : null;
  if (fit) {
    const geom = { fit, frameW: payload?.frame_width, frameH: payload?.frame_height };
    fitMemory.set(host, geom);
    return geom;
  }
  return fitMemory.get(host) || null;
}

function shownSeq(host) {
  const media = mediaOf(host);
  const seq = Number(media?.dataset?.frameSeq || 0);
  return Number.isFinite(seq) ? seq : 0;
}

function shownCapturedAt(host) {
  const media = mediaOf(host);
  const at = Number(media?.dataset?.capturedAt || 0);
  return Number.isFinite(at) ? at : 0;
}

function lockAtPoint(host, clientX, clientY) {
  const camera = host.dataset.visionCamera || '';
  const layer = host.querySelector(':scope > .vision-hit-layer');
  const rect = (layer || host).getBoundingClientRect();
  if (!(rect.width >= 32) || !(rect.height >= 32)) return null;
  const hit = hitDrawnBox(drawnBoxes.get(host), clientX - rect.left, clientY - rect.top);
  if (!hit || hit.id == null || hit.id === '') return null;
  return { camera, id: hit.id };
}

function ensureChrome(host, camera) {
  if (camera && !host.dataset.visionCamera) host.dataset.visionCamera = camera;
  if (host.dataset.visionBound === '1') return;
  host.dataset.visionBound = '1';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const canvas = host.ownerDocument.createElement('canvas');
  canvas.className = 'vision-box-layer';
  canvas.hidden = true;
  const layer = host.ownerDocument.createElement('div');
  layer.className = 'vision-hit-layer';
  layer.dataset.hit = '0';
  const note = host.ownerDocument.createElement('p');
  note.className = 'vision-box-note';
  note.hidden = true;
  host.appendChild(canvas);
  host.appendChild(layer);
  host.appendChild(note);
  const repaint = () => {
    const camera = host.dataset.visionCamera || '';
    const kind = host.id === 'pfdHorizonStage' ? 'horizon' : 'tile';
    const latest = payloadFor(camera);
    const chosen = selectFrameTracks(latest, frameBooks.get(camera), shownSeq(host), shownCapturedAt(host));
    if (!chosen) return;
    paintHost(host, chosen, { kind });
  };
  host.addEventListener('load', (event) => {
    if (event.target instanceof Element && host.contains(event.target)) repaint();
  }, true);
  host.addEventListener('vlc-frame-tracks', (event) => {
    applyBundledTracks(host, event.detail);
  });
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
  if (typeof ResizeObserver === 'function') {
    const resize = new ResizeObserver(() => repaint());
    resize.observe(host);
  }
  const opener = host.closest?.('.debrief-cam-tile') || host;
  if (opener.dataset.visionMenuBound === '1') return;
  opener.dataset.visionMenuBound = '1';
  opener.addEventListener('contextmenu', (event) => {
    if (!(event.target instanceof Element) || !opener.contains(event.target)) return;
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
  const layer = host.querySelector(':scope > .vision-hit-layer');
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
  host.dataset.visionFrame = payload?.frame_seq ? String(payload.frame_seq) : '';
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
  const fitNow = media ? mediaFit(media, width, height) : null;
  if (fitNow) fitMemory.set(host, { fit: fitNow, frameW: payload?.frame_width, frameH: payload?.frame_height });
  const remembered = fitMemory.get(host);
  const fit = fitNow || remembered?.fit || null;
  const lostLock = showHorizon && !reason && payload?.lock?.lost === true
    && lockId != null
    && !tracks.some((row) => row.id === lockId)
    && Array.isArray(payload.lock?.bbox)
    ? payload.lock
    : null;
  host.dataset.visionLost = lostLock ? String(lockId) : '';
  const keepLast = showHorizon && !reason && tracks.length > 0 && drawnBoxes.get(host)?.length;
  if (!fit || !showHorizon || (!tracks.length && !lostLock)) {
    if (keepLast && !fit) {
      if (layer) layer.dataset.hit = '1';
      canvas.hidden = false;
      canvas.dataset.hit = '1';
      return;
    }
    drawnBoxes.delete(host);
    if (layer) layer.dataset.hit = '0';
    canvas.hidden = true;
    canvas.dataset.hit = '0';
    const cleared = canvas.getContext('2d');
    if (cleared) cleared.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    return;
  }
  const sized = width >= 32 && height >= 32;
  canvas.hidden = false;
  const ratio = doc.defaultView?.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const fw = payload.frame_width || remembered?.frameW || fit.nw;
  const fh = payload.frame_height || remembered?.frameH || fit.nh;
  const ordered = [...tracks].sort((a, b) => (a.id === lockId ? 1 : 0) - (b.id === lockId ? 1 : 0));
  const boxes = [];
  const drawCaption = (caption, boxX, boxY) => {
    if (!caption) return;
    ctx.save();
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.font = '700 13px Heebo, sans-serif';
    const textW = ctx.measureText(caption).width;
    const pad = 4;
    const capH = 16;
    const placed = placeTrackCaption(boxX, textW + pad * 2, width);
    let capY = boxY - 18;
    if (capY < 0) capY = Math.min(Math.max(0, height - capH), Math.max(0, boxY + 2));
    if (capY + capH > height) capY = Math.max(0, height - capH);
    const rectX = Math.max(0, placed.x);
    const rectR = Math.min(width, placed.right);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(rectX, capY, Math.max(0, rectR - rectX), capH);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(caption, placed.x + pad, capY + 12);
    ctx.restore();
  };
  for (const track of ordered) {
    const box = track.bbox || [];
    if (box.length < 4) continue;
    const x = fit.x + (box[0] * fit.nw / fw) * fit.scaleX;
    const y = fit.y + (box[1] * fit.nh / fh) * fit.scaleY;
    const w = (box[2] * fit.nw / fw) * fit.scaleX;
    const h = (box[3] * fit.nh / fh) * fit.scaleY;
    boxes.push({ id: track.id, x, y, w, h });
    const locked = lockId != null && track.id === lockId;
    ctx.lineWidth = locked ? 4 : 2;
    ctx.strokeStyle = locked ? '#67e8f9' : '#facc15';
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);
    drawCaption(trackCaption(track), x, y);
  }
  if (lostLock) {
    const box = lostLock.bbox;
    const x = fit.x + (box[0] * fit.nw / fw) * fit.scaleX;
    const y = fit.y + (box[1] * fit.nh / fh) * fit.scaleY;
    const w = (box[2] * fit.nw / fw) * fit.scaleX;
    const h = (box[3] * fit.nh / fh) * fit.scaleY;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#94a3b8';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    drawCaption('אבד', x, y);
  }
  const clickable = sized && boxes.some((box) => box.w >= 4 && box.h >= 4);
  if (boxes.length) drawnBoxes.set(host, boxes);
  else drawnBoxes.delete(host);
  canvas.dataset.hit = clickable ? '1' : '0';
  if (layer) layer.dataset.hit = clickable ? '1' : '0';
}

function applyBundledTracks(host, detail) {
  const payload = detail?.tracks;
  if (!host || !payload || typeof payload !== 'object') return;
  const stage = host.dataset.cameraStage || '';
  const camera = stage && stage !== 'horizon'
    ? stage
    : (payload.camera || host.dataset.visionCamera || selectedCamera() || '');
  if (!camera) return;
  const seq = Number(detail.seq) || Number(payload.frame_seq) || 0;
  const capturedAt = Number(detail.capturedAt) || Number(payload.captured_at) || 0;
  if (seq > 0 && !tracksMatchFrame(payload, seq, capturedAt)) return;
  cache.set(camera, payload);
  rememberFrame(camera, payload);
  const kind = host.id === 'pfdHorizonStage' ? 'horizon' : 'tile';
  paintHost(host, payload, { kind });
}

export async function waitFrameTracks({ seq, capturedAt, src, camera } = {}) {
  const id = camera || cameraFromFrameUrl(src);
  if (!id) return null;
  const shown = Number(seq) || 0;
  const at = Number(capturedAt) || 0;
  if (!(shown > 0)) return null;
  const ready = (payload) => tracksMatchFrame(payload, shown, at);
  const cached = cache.get(id);
  if (ready(cached)) return cached;
  const deadline = Date.now() + FRAME_SYNC_TOLERANCE_MS;
  const first = await fetchTracks(id);
  cache.set(id, first);
  rememberFrame(id, first);
  if (ready(first)) return first;
  const left = deadline - Date.now();
  if (left <= 8) return null;
  await new Promise((resolve) => setTimeout(resolve, Math.min(left, 40)));
  const again = await fetchTracks(id);
  cache.set(id, again);
  rememberFrame(id, again);
  return ready(again) ? again : null;
}

function rememberFrame(camera, payload) {
  const seq = Number(payload?.frame_seq);
  if (!camera || !(seq > 0)) return;
  let book = frameBooks.get(camera);
  if (!book) {
    book = new Map();
    frameBooks.set(camera, book);
  }
  book.set(seq, payload);
  while (book.size > 12) book.delete(book.keys().next().value);
}

function paintAll(doc) {
  for (const item of hostList(doc)) {
    const camera = item.kind === 'horizon' ? (selectedCamera() || '') : item.camera;
    const latest = camera ? payloadFor(camera) : emptyPayload(REASON_OFF);
    if (item.kind === 'horizon' && !camera) {
      paintHost(item.host, emptyPayload(REASON_OFF), item);
      continue;
    }
    const chosen = selectFrameTracks(latest, frameBooks.get(camera), shownSeq(item.host), shownCapturedAt(item.host));
    if (!chosen) continue;
    if (item.kind === 'horizon' && camera) chosen.camera = camera;
    paintHost(item.host, chosen, item);
  }
}

async function readJson(res) {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('json')) return null;
  return unwrapTracks(await res.json());
}

async function fetchTracks(camera) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch(`${TRACKS_URL}?camera=${encodeURIComponent(camera)}&sort=${encodeURIComponent(sortMode)}`, {
      cache: 'no-store',
      signal: ac.signal,
    });
    const body = await readJson(res);
    if (!res.ok || !body) return emptyPayload(REASON_NO_STREAM);
    body.camera = body.camera || camera;
    return body;
  } catch {
    return emptyPayload(REASON_NO_STREAM);
  } finally {
    clearTimeout(timer);
  }
}

let paintAgain = false;

function scheduleSizedRepaint(doc) {
  const view = doc.defaultView;
  if (!view?.requestAnimationFrame) return;
  let left = 12;
  const step = () => {
    paintAll(doc);
    left -= 1;
    const waiting = hostList(doc).some((item) => {
      if (item.kind === 'horizon') return false;
      const host = item.host;
      if (!host?.dataset?.visionTracks) return false;
      const layer = host.querySelector(':scope > .vision-hit-layer');
      return layer?.dataset?.hit !== '1';
    });
    if (waiting && left > 0) view.requestAnimationFrame(step);
  };
  view.requestAnimationFrame(step);
}

async function refresh(doc) {
  if (!doc || doc.visibilityState === 'hidden') return;
  if (inflightRefresh) {
    paintAgain = true;
    return inflightRefresh;
  }
  inflightRefresh = (async () => {
    painting = true;
    try {
      do {
        paintAgain = false;
        const cameras = new Set(hostList(doc).filter((item) => item.kind !== 'horizon' && item.camera).map((item) => item.camera));
        await Promise.all([...cameras].map(async (camera) => {
          const payload = await fetchTracks(camera);
          cache.set(camera, payload);
          rememberFrame(camera, payload);
        }));
        paintAll(doc);
        if (!doc.getElementById('visionTrackMenu')?.hidden) renderMenu(doc);
      } while (paintAgain);
      sawRefresh = true;
    } finally {
      painting = false;
      scheduleSizedRepaint(doc);
    }
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
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
    <p class="vision-menu-sort">מיון: <button type="button" class="vision-track-menu-item" data-vision-sort="class">סוג</button><span aria-hidden="true"> | </span><button type="button" class="vision-track-menu-item" data-vision-sort="confidence">ביטחון</button></p>
    <div data-vision-list></div>
    <p class="vision-menu-kicker">נעילה</p>
    <button type="button" class="vision-track-menu-item" data-vision-action="next">אובייקט הבא</button>
    <button type="button" class="vision-track-menu-item" data-vision-action="unlock">שחררו נעילה</button>
    <button type="button" class="vision-track-menu-item" data-vision-action="steer"></button>
    <p class="vision-menu-note" data-vision-steer-note hidden></p>
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
    const rows = Array.isArray(payload.tracks) ? payload.tracks : [];
    const listKey = `${payload.reason_he || ''}|${payload.lock?.id ?? ''}|${rows.map((row) => `${row.id}:${trackCaption(row)}`).join(',')}`;
    if (list.dataset.visionKey === listKey) {
      /* the open list stays put while the same tracks are on screen */
    } else {
    list.dataset.visionKey = listKey;
    list.replaceChildren();
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
        button.textContent = trackCaption(row);
        list.appendChild(button);
      }
    }
    }
  }
  const steer = menu.querySelector('[data-vision-action="steer"]');
  const steerOn = payload.gimbal_steer?.enabled === true;
  if (steer) steer.textContent = `היגוי גימבל: ${steerOn ? 'פעיל' : 'כבוי'}`;
  const steerNote = menu.querySelector('[data-vision-steer-note]');
  if (steerNote) {
    const reason = String(payload.gimbal_steer?.reason_he || '').trim();
    const offReason = !reason || reason === 'היגוי הגימבל כבוי' || payload.gimbal_steer?.reason === 'steer_off';
    const show = payload.gimbal_steer?.blocked === true && !offReason;
    steerNote.hidden = !show;
    steerNote.textContent = show ? reason : '';
  }
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
  doc.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('#visionTrackMenu, [data-vision-menu-slot]')) return;
    const host = target.closest('[data-camera-stage]')
      || target.closest('.debrief-cam-tile')?.querySelector('[data-camera-stage]');
    if (!(host instanceof Element)) return;
    const hit = lockAtPoint(host, event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    void postLock(hit);
  }, true);
  if (typeof MutationObserver === 'function' && doc.body) {
    const observer = new MutationObserver(() => bind());
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  const tick = () => { void refresh(doc); };
  tick();
  timer = doc.defaultView?.setInterval(tick, TRACK_POLL_MS) || 0;
  if (doc.defaultView) {
    doc.defaultView.__vlcFillVisionMenu = (slot, camera) => fillVisionMenu(slot, camera);
    doc.defaultView.__vlcVisionAskState = () => visionAskState();
    doc.defaultView.__vlcVisionAskReady = (waitMs) => visionAskReady(doc, waitMs);
    doc.defaultView.__vlcVisionStreamMap = () => visionStreamMap();
    doc.defaultView.__vlcWaitFrameTracks = (opts) => waitFrameTracks(opts);
  }
}

if (typeof document !== 'undefined') mountVisionTracks(document);
