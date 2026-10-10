/**
 * Debrief camera grid. Live tiles show a companion frame or אין אות.
 * A loaded debrief file plays only in #flightVideo, never inside a live tile.
 * One missed JPEG keeps the last frame instead of flashing אין אות.
 */
import { frameMissShowsNoSignal, frameTilePresentation } from './camera-frame-hold.mjs';
import { createLatestJpegPump } from './camera-latest-frame.mjs';
import { fitCameraPanes } from './camera-pane-fit.mjs';

const STORAGE_KEY = 'vlc.debrief.cameras.v2';
const LEGACY_KEY = 'vlc.debrief.cameras.v1';
const DEFAULT_OPEN = ['cam0', 'cam1'];
const CAM1_STREAM = '/api/jetson/v1/cam1/stream.mjpg';
const PHONE_STRIP_QUERY = '(max-width: 720px)';
// Names stay put: cam0 is קדמית, cam1 is מטה, cam3 is גימבל.
const SLOTS = [
  { id: 'cam0', apiId: 'cam0', mono: true, hold: '' },
  { id: 'cam1', apiId: 'cam1', mono: true, hold: CAM1_STREAM },
  { id: 'a8', apiId: 'cam3', mono: false, hold: '', frameWhenOpen: true },
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
    const ids = SLOTS.map((slot) => slot.id);
    return ids.filter((id) => parsed.includes(id));
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

function phoneCameraStrip() {
  return window.matchMedia(PHONE_STRIP_QUERY).matches;
}

function settingsButtonId(id) {
  if (id === 'a8') return 'opticsGimbalBtn';
  if (id === 'cam1') return 'opticsCam1Btn';
  return 'opticsCam0Btn';
}

function visibleTiles() {
  if (!grid) return [];
  return [...grid.querySelectorAll('.debrief-cam-tile')].filter((tile) => !tile.hidden);
}

function opticsRoom() {
  const panel = document.getElementById('optics');
  const calib = panel?.querySelector('.optics-calib');
  const toolbar = grid?.previousElementSibling;
  const panelH = panel?.clientHeight || 0;
  const used = (calib?.offsetHeight || 0) + (toolbar?.offsetHeight || 0) + 16;
  return Math.max(0, panelH - used);
}

export function layoutCameraPanes() {
  if (!grid) return;
  const tiles = visibleTiles();
  const areaWidth = grid.clientWidth;
  if (!(areaWidth > 8) || !tiles.length) return;
  const boxes = fitCameraPanes({
    frames: tiles.map((tile) => {
      const img = tile.querySelector('.debrief-cam-live');
      return {
        width: img?.naturalWidth || 0,
        height: img?.naturalHeight || 0,
      };
    }),
    areaWidth,
    areaHeight: opticsRoom(),
    gap: 4,
  });
  tiles.forEach((tile, index) => {
    const box = boxes[index];
    if (!box) return;
    const w = Math.floor(box.width);
    const h = Math.floor(box.height);
    if ((w < 32 || h < 32) && areaWidth >= 160) {
      tile.style.width = '';
      tile.style.height = '';
      return;
    }
    tile.style.width = `${Math.max(1, w)}px`;
    tile.style.height = `${Math.max(1, h)}px`;
    tile.style.flex = '0 0 auto';
    tile.style.setProperty('--frame-aspect', String(box.aspect));
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
  let slot = 0;
  for (const tile of tiles) {
    const on = open.includes(tile.dataset.cam);
    tile.hidden = !on;
    tile.dataset.slot = on ? String(slot) : '';
    if (on) slot += 1;
  }
  grid.dataset.count = String(slot);
  const empty = document.getElementById('debriefCamEmpty');
  if (empty) empty.hidden = slot !== 0;
  for (const btn of document.querySelectorAll('[data-debrief-cam]')) {
    const on = open.includes(btn.dataset.debriefCam);
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
  if (phoneCameraStrip()) {
    writeOpen([id]);
    render(latestCompanion);
    return;
  }
  const cur = readOpen();
  if (cur.includes(id)) {
    render(latestCompanion);
    return;
  }
  const ordered = SLOTS.map((slot) => slot.id).filter((slotId) => cur.includes(slotId) || slotId === id);
  writeOpen(ordered);
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
      const id = btn.dataset.debriefCam;
      if (phoneCameraStrip()) {
        writeOpen([id]);
        render(latestCompanion);
        const tab = document.getElementById(settingsButtonId(id));
        if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
        return;
      }
      const cur = readOpen();
      const next = cur.includes(id) ? cur.filter((item) => item !== id) : [...cur, id];
      const ordered = SLOTS.map((slot) => slot.id).filter((slotId) => next.includes(slotId));
      writeOpen(ordered);
      render(latestCompanion);
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
