/**
 * Debrief camera grid: Cam0 (CSI slot cam1, mono), Cam1 (CSI slot cam2), A8 (SIYI RTSP cam3).
 * Live frames come only from the companion camera API. A loaded debrief file keeps the
 * existing playback clock on #flightVideo and synced clones. No invented signal.
 */

const STORAGE_KEY = 'vlc.debrief.cameras.v1';
const SLOTS = [
  { id: 'cam0', apiId: 'cam1', mono: true },
  { id: 'cam1', apiId: 'cam2', mono: false },
  { id: 'a8', apiId: 'cam3', mono: false },
];

const grid = document.getElementById('debriefCamGrid');
const master = document.getElementById('flightVideo');

function readOpen() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '');
    if (!Array.isArray(raw)) return ['cam0'];
    const ids = raw.filter((id) => SLOTS.some((slot) => slot.id === id));
    return ids;
  } catch {
    return ['cam0'];
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

function placeRecording(open) {
  if (!master || !grid) return;
  const hasFile = recordingActive();
  const tiles = SLOTS.map((slot) => grid.querySelector(`.debrief-cam-tile[data-cam="${slot.id}"]`)).filter(Boolean);
  const host = tiles.find((tile) => open.includes(tile.dataset.cam) && tile.dataset.signal !== 'live') || null;
  const canvas = document.getElementById('annotationCanvas');
  const lock = document.getElementById('lockIndicator');
  if (host) {
    const stage = host.querySelector('.debrief-cam-stage');
    if (stage && master.parentElement !== stage) stage.insertBefore(master, stage.firstChild);
    if (canvas && stage && canvas.parentElement !== stage) stage.appendChild(canvas);
    if (lock && stage && lock.parentElement !== stage) stage.appendChild(lock);
  }
  master.hidden = !hasFile || !host;
  for (const tile of tiles) {
    const clone = tile.querySelector('.debrief-cam-clone');
    const showClone = hasFile && open.includes(tile.dataset.cam) && tile.dataset.signal !== 'live' && tile !== host;
    if (!clone) continue;
    if (showClone) {
      if (clone.src !== master.currentSrc && master.currentSrc) clone.src = master.currentSrc;
      clone.hidden = false;
    } else {
      clone.hidden = true;
      clone.pause?.();
    }
  }
  syncClones();
}

function syncClones() {
  if (!master || !recordingActive()) return;
  const t = master.currentTime;
  for (const clone of grid?.querySelectorAll('.debrief-cam-clone') || []) {
    if (clone.hidden) continue;
    if (clone.readyState >= 1 && Number.isFinite(t) && Math.abs(clone.currentTime - t) > 0.35) {
      try { clone.currentTime = t; } catch { /* ignore */ }
    }
    if (master.paused) clone.pause();
    else clone.play().catch(() => {});
  }
}

function paintTile(tile, detail, streaming) {
  const img = tile.querySelector('.debrief-cam-live');
  const note = tile.querySelector('.debrief-cam-nosignal');
  const apiId = tile.dataset.api;
  if (streaming && img) {
    tile.dataset.signal = 'live';
    img.hidden = false;
    if (tile.dataset.mono === '1') img.classList.add('is-mono');
    const next = `/api/jetson/v1/cameras/${apiId}/frame?t=${Date.now()}`;
    if (!img.dataset.primed || Date.now() - Number(img.dataset.primed) > 700) {
      img.dataset.primed = String(Date.now());
      img.src = next;
    }
    img.onerror = () => {
      tile.dataset.signal = 'none';
      img.hidden = true;
      img.removeAttribute('src');
      if (note) note.hidden = recordingActive();
    };
    if (note) note.hidden = true;
  } else {
    tile.dataset.signal = 'none';
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
      img.dataset.primed = '';
    }
    if (note) note.hidden = recordingActive() && !tile.hidden;
  }
}

let latestCompanion = null;

function render(companion) {
  latestCompanion = companion && typeof companion === 'object' ? companion : latestCompanion;
  const open = readOpen();
  applyLayout(open);
  if (!grid) return;
  for (const slot of SLOTS) {
    const tile = grid.querySelector(`.debrief-cam-tile[data-cam="${slot.id}"]`);
    if (!tile) continue;
    const detail = slotDetail(latestCompanion, slot.apiId);
    paintTile(tile, detail, !tile.hidden && slotStreaming(detail));
  }
  placeRecording(open);
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
  master?.addEventListener('play', syncClones);
  master?.addEventListener('pause', syncClones);
  master?.addEventListener('seeked', syncClones);
  master?.addEventListener('timeupdate', syncClones);
  master?.addEventListener('loadedmetadata', () => render(latestCompanion));
  master?.addEventListener('emptied', () => render(latestCompanion));
  document.getElementById('videoInput')?.addEventListener('change', () => {
    setTimeout(() => render(latestCompanion), 0);
  });
  document.addEventListener('vlc-companion-cameras', (event) => {
    render(event.detail);
  });
  window.addEventListener('resize', () => {
    if (master && document.getElementById('annotationCanvas')) {
      master.dispatchEvent(new Event('timeupdate'));
    }
  });
}

bind();

export { SLOTS, slotStreaming, readOpen };
