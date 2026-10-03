/**
 * Debrief camera grid. Live tiles show a companion frame or אין אות.
 * A loaded debrief file plays only in #flightVideo, never inside a live tile.
 * One missed JPEG keeps the last frame instead of flashing אין אות.
 */
import { frameMissShowsNoSignal, frameTilePresentation } from './camera-frame-hold.mjs';

const STORAGE_KEY = 'vlc.debrief.cameras.v2';
const LEGACY_KEY = 'vlc.debrief.cameras.v1';
const DEFAULT_OPEN = ['cam0', 'cam1'];
const CAM1_STREAM = '/api/jetson/v1/cam1/stream.mjpg';
const SLOTS = [
  { id: 'cam0', apiId: 'cam0', mono: true, hold: '' },
  { id: 'cam1', apiId: 'cam1', mono: true, hold: CAM1_STREAM },
  { id: 'a8', apiId: 'cam3', mono: false, hold: '', frameWhenOpen: true },
];
const streamHolds = new Map();

const grid = document.getElementById('debriefCamGrid');
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
  }
}

function releaseTile(tile) {
  const img = tile.querySelector('.debrief-cam-live');
  if (!img) return;
  img.hidden = true;
  img.removeAttribute('src');
  img.dataset.hold = '';
  img.dataset.primed = '';
  img.classList.remove('is-mono');
}

function ensureHold(url) {
  if (!url) return;
  let img = streamHolds.get(url);
  if (!img) {
    img = new Image();
    streamHolds.set(url, img);
  }
  if (!String(img.src || '').includes(url)) img.src = url;
}

function dropHold(url) {
  const img = streamHolds.get(url);
  if (!img) return;
  img.removeAttribute('src');
  streamHolds.delete(url);
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
  const apiId = tile.dataset.api;
  if (tile.hidden) {
    tile.dataset.signal = 'none';
    releaseTile(tile);
    if (slot.hold) dropHold(slot.hold);
    if (note) note.hidden = true;
    return;
  }
  if (slot.hold) ensureHold(slot.hold);
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
    const next = `/api/jetson/v1/cameras/${apiId}/frame?t=${Date.now()}`;
    if (!img.dataset.primed || Date.now() - Number(img.dataset.primed) > 700) {
      img.dataset.primed = String(Date.now());
      const probe = new Image();
      probe.onload = () => {
        img.src = probe.src;
        img.dataset.seen = String(Date.now());
        img.dataset.misses = '0';
        applyFramePresentation(tile, img, note, { showImage: true, showNote: false });
      };
      probe.onerror = () => {
        const nextMisses = Number(img.dataset.misses || 0) + 1;
        img.dataset.misses = String(nextMisses);
        const showNone = frameMissShowsNoSignal({
          seenAt: Number(img.dataset.seen || 0),
          now: Date.now(),
          streaming,
          consecutiveMisses: nextMisses,
        });
        if (!showNone) {
          const still = Number(img.dataset.seen || 0) > 0 && Boolean(img.getAttribute('src'));
          applyFramePresentation(tile, img, note, {
            showImage: still,
            showNote: false,
          });
          return;
        }
        img.removeAttribute('src');
        img.dataset.seen = '';
        applyFramePresentation(tile, img, note, { showImage: false, showNote: true });
      };
      probe.src = next;
    }
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

function openSlot(id) {
  if (!SLOTS.some((slot) => slot.id === id)) return;
  const cur = readOpen();
  if (cur.includes(id)) {
    render(latestCompanion);
    return;
  }
  const ordered = SLOTS.map((slot) => slot.id).filter((slotId) => cur.includes(slotId) || slotId === id);
  writeOpen(ordered);
  render(latestCompanion);
}

function bind() {
  if (!grid) return;
  const open = readOpen();
  applyLayout(open);
  render(null);
  for (const btn of document.querySelectorAll('[data-debrief-cam]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.debriefCam;
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
}

bind();

if (typeof window !== 'undefined') window.__vlcFrameMissShowsNoSignal = frameMissShowsNoSignal;

export { SLOTS, slotStreaming, readOpen };
