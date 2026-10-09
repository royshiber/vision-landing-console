/**
 * Debrief camera grid. Live tiles show a companion frame or אין אות.
 * A loaded debrief file plays only in #flightVideo, never inside a live tile.
 * One missed JPEG keeps the last frame instead of flashing אין אות.
 */
import { canonicalCameraId } from './camera-names.mjs';
import { frameMissShowsNoSignal, frameTilePresentation } from './camera-frame-hold.mjs';
import { createLatestJpegPump } from './camera-latest-frame.mjs';

const STORAGE_KEY = 'vlc.debrief.cameras.v2';
const LEGACY_KEY = 'vlc.debrief.cameras.v1';
const DEFAULT_OPEN = ['cam0', 'cam1'];
const CAM1_STREAM = '/api/jetson/v1/cam1/stream.mjpg';
// Names stay put: cam0 is קדמית, cam1 is מטה, cam3 is גימבל.
const SLOTS = [
  { id: 'cam0', apiId: 'cam0', mono: true, hold: '' },
  { id: 'cam1', apiId: 'cam1', mono: true, hold: CAM1_STREAM },
  { id: 'cam3', apiId: 'cam3', mono: false, hold: '', frameWhenOpen: true },
];
const grid = document.getElementById('debriefCamGrid');
const tilePumps = new WeakMap();
const master = document.getElementById('flightVideo');

function readOpen() {
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_OPEN];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_OPEN];
    const migrated = parsed.map((id) => canonicalCameraId(id));
    const ids = SLOTS.map((slot) => slot.id);
    const open = ids.filter((id) => migrated.includes(id));
    if (migrated.some((id, index) => id !== parsed[index])) writeOpen(open);
    return open;
  } catch {
    return [...DEFAULT_OPEN];
  }
}

function writeOpen(ids) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
}

function slotDetail(companion, apiId) {
  const src = companion && typeof companion === 'object' ? companion : {};
  return src.vision?.cameras?.[apiId]
    || src.opticalNav?.cameras?.[apiId]
    || src.optical_nav?.cameras?.[apiId]
    || src.extras?.cameras?.[apiId]
    || src.cameras?.[apiId]
    || null;
}

function slotStreaming(detail) {
  if (!detail || detail.camera_ok !== true) return false;
  if (detail.enabled === false) return false;
  if (detail.state && detail.state !== 'streaming') return false;
  if (detail.has_frame === false) return false;
  const fps = Number(detail.fps);
  const age = Number(detail.last_frame_age_ms);
  const count = Number(detail.frame_count);
  return (Number.isFinite(fps) && fps > 0)
    || (Number.isFinite(age) && age >= 0)
    || (Number.isFinite(count) && count > 0);
}

function recordingActive() {
  if (!master) return false;
  const src = master.currentSrc || master.getAttribute('src') || '';
  return src.length > 0 && !src.endsWith('/');
}

function paintPlayer() {
  const empty = document.getElementById('debriefPlayerEmpty');
  const has = recordingActive();
  if (master) master.hidden = !has;
  if (empty) empty.hidden = has;
}

export function layoutCameraPanes() {
  if (!grid) return;
  grid.querySelectorAll('.debrief-cam-tile').forEach((tile) => {
    tile.hidden = false;
    tile.style.width = '';
    tile.style.height = '';
    tile.style.flex = '';
  });
}

function followLoadedFrame(tile, img) {
  if (!tile || !img) return;
  if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return;
  layoutCameraPanes();
}

function applyLayout(open) {
  if (!grid) return;
  const tiles = [...grid.querySelectorAll('.debrief-cam-tile')];
  const selected = SLOTS.map((slot) => slot.id).find((id) => open.includes(id)) || 'cam0';
  tiles.forEach((tile, index) => {
    tile.hidden = false;
    tile.dataset.slot = String(index);
    tile.classList.toggle('is-selected', tile.dataset.cam === selected);
  });
  grid.dataset.count = String(tiles.length);
  const empty = document.getElementById('debriefCamEmpty');
  if (empty) empty.hidden = true;
  for (const btn of document.querySelectorAll('[data-debrief-cam]')) {
    const on = btn.dataset.debriefCam === selected;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  }
  layoutCameraPanes();
}

function releaseTile(tile) {
  const img = tile.querySelector('.debrief-cam-live');
  tilePumps.get(tile)?.stop();
  if (!img) return;
  if (img.dataset.objectUrl) {
    try { URL.revokeObjectURL(img.dataset.objectUrl); } catch { /* already revoked */ }
    img.dataset.objectUrl = '';
  }
  img.dataset.liveFrame = '';
  img.hidden = true;
  img.removeAttribute('src');
  img.dataset.hold = '';
  img.dataset.primed = '';
  img.classList.remove('is-mono');
}

function pumpFor(tile) {
  let pump = tilePumps.get(tile);
  if (pump) return pump;
  pump = createLatestJpegPump({
    image: () => tile.querySelector('.debrief-cam-live'),
    follow: () => tile.hidden !== true,
    urlFor(gen, seenSeq, info) {
      const newest = info?.replace ? '&newest=1' : '';
      return `/api/jetson/v1/cameras/${tile.dataset.api}/frame?since=${seenSeq || 0}&t=${gen}${newest}`;
    },
    onFrame() {
      const img = tile.querySelector('.debrief-cam-live');
      const note = tile.querySelector('.debrief-cam-nosignal');
      if (!img || tile.hidden) return;
      if (tile.dataset.mono === '1') img.classList.add('is-mono');
      img.dataset.seen = String(Date.now());
      img.dataset.misses = '0';
      applyFramePresentation(tile, img, note, { showImage: true, showNote: false });
      followLoadedFrame(tile, img);
    },
    onMiss() {
      const img = tile.querySelector('.debrief-cam-live');
      const note = tile.querySelector('.debrief-cam-nosignal');
      if (!img) return;
      const nextMisses = Number(img.dataset.misses || 0) + 1;
      img.dataset.misses = String(nextMisses);
      const showNone = frameMissShowsNoSignal({
        seenAt: Number(img.dataset.seen || 0),
        now: Date.now(),
        streaming: pump.state.streaming === true,
        consecutiveMisses: nextMisses,
      });
      if (!showNone) {
        const still = Number(img.dataset.seen || 0) > 0 && Boolean(img.getAttribute('src'));
        applyFramePresentation(tile, img, note, { showImage: still, showNote: false });
        return;
      }
      img.removeAttribute('src');
      img.dataset.seen = '';
      applyFramePresentation(tile, img, note, { showImage: false, showNote: true });
    },
  });
  tilePumps.set(tile, pump);
  return pump;
}

function applyFramePresentation(tile, img, note, presentation) {
  tile.dataset.signal = presentation.showNote ? 'none' : 'live';
  if (img) img.hidden = presentation.showImage !== true;
  if (!note) return;
  note.hidden = presentation.showNote !== true;
  if (presentation.showNote) note.textContent = 'אין אות';
}

function paintTile(tile, slot, streaming) {
  const img = tile.querySelector('.debrief-cam-live');
  const note = tile.querySelector('.debrief-cam-nosignal');
  if (tile.hidden) {
    tile.dataset.signal = 'none';
    releaseTile(tile);
    if (note) note.hidden = true;
    return;
  }
  const wantFrames = streaming || Boolean(slot.hold) || slot.frameWhenOpen === true;
  if (wantFrames && img && !tile.hidden) {
    if (tile.dataset.mono === '1') img.classList.add('is-mono');
    const seen = Number(img.dataset.seen || 0);
    const misses = Number(img.dataset.misses || 0);
    const hasPicture = seen > 0 && Boolean(img.getAttribute('src'));
    const presentation = frameTilePresentation({
      seenAt: seen,
      now: Date.now(),
      streaming,
      consecutiveMisses: misses,
      hasPicture,
    });
    applyFramePresentation(tile, img, note, presentation);
    const pump = pumpFor(tile);
    pump.state.streaming = streaming === true;
    pump.start();
    return;
  }
  if (img && !tile.hidden) {
    const seen = Number(img.dataset.seen || 0);
    const misses = Number(img.dataset.misses || 0);
    const hasPicture = seen > 0 && Boolean(img.getAttribute('src'));
    const presentation = frameTilePresentation({
      seenAt: seen,
      now: Date.now(),
      streaming,
      consecutiveMisses: misses,
      hasPicture,
    });
    if (presentation.showImage) {
      applyFramePresentation(tile, img, note, presentation);
      return;
    }
  }
  tile.dataset.signal = 'none';
  if (img) {
    img.hidden = true;
    img.removeAttribute('src');
    img.classList.remove('is-mono');
    img.dataset.primed = '';
  }
  if (note) {
    note.hidden = tile.hidden;
    note.textContent = 'אין אות';
  }
}

let latestCompanion = null;

function render(companion) {
  latestCompanion = companion && typeof companion === 'object' ? companion : latestCompanion;
  const open = readOpen();
  applyLayout(open);
  paintPlayer();
  if (!grid) return;
  for (const slot of SLOTS) {
    const tile = grid.querySelector(`.debrief-cam-tile[data-cam="${slot.id}"]`);
    if (!tile) continue;
    const detail = slotDetail(latestCompanion, slot.apiId);
    paintTile(tile, slot, slotStreaming(detail));
  }
}

function chooseCamera(id) {
  if (!SLOTS.some((slot) => slot.id === id)) return;
  writeOpen([id]);
  render(latestCompanion);
}

function openSlot(id) {
  chooseCamera(id);
}

function bind() {
  if (!grid) return;
  const open = readOpen();
  applyLayout(open);
  render(null);
  for (const btn of document.querySelectorAll('[data-debrief-cam]')) {
    btn.addEventListener('click', () => {
      chooseCamera(btn.dataset.debriefCam);
    });
  }
  master?.addEventListener('loadedmetadata', () => paintPlayer());
  master?.addEventListener('emptied', () => paintPlayer());
  document.getElementById('videoInput')?.addEventListener('change', () => {
    setTimeout(() => render(latestCompanion), 0);
  });
  document.addEventListener('vlc-companion-cameras', (event) => {
    render(event.detail);
  });
  document.addEventListener('vlc-debrief-open-cam', (event) => {
    openSlot(event.detail);
  });
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(() => layoutCameraPanes());
    watch.observe(grid);
    const panel = document.getElementById('optics');
    if (panel) watch.observe(panel);
  }
  document.querySelector('[data-tab="optics"]')?.addEventListener('click', () => {
    requestAnimationFrame(() => {
      layoutCameraPanes();
      requestAnimationFrame(() => layoutCameraPanes());
    });
  });
}

bind();

if (typeof window !== 'undefined') window.__vlcFrameMissShowsNoSignal = frameMissShowsNoSignal;

export { SLOTS, slotStreaming, readOpen };
