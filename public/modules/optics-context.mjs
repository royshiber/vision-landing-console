/**
 * Optics controls live in a right-click menu on the camera tile.
 * The standing settings column and gimbal pad stay out of the layout.
 * Existing control ids move into the menu; they are not cloned.
 */
import { onGimbalView } from './gimbal-pad.mjs';

const MENU_W = 228;
const MENU_H = 210;
const GAP = 8;

export function rectsOverlap(a, b, slack = 1) {
  if (!a || !b || a.width < 2 || b.width < 2 || a.height < 2 || b.height < 2) return false;
  return a.left < b.right - slack
    && a.right > b.left + slack
    && a.top < b.bottom - slack
    && a.bottom > b.top + slack;
}

function packBox(left, top, width, height, mode) {
  return {
    mode,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/** Popover box that stays inside the viewport and off every video rect. */
export function placeOpticsPopover({ tile, tiles = [], viewport, width = MENU_W, height = MENU_H, gap = GAP } = {}) {
  const vw = Math.max(0, Number(viewport?.width) || 0);
  const vh = Math.max(0, Number(viewport?.height) || 0);
  const videos = (tiles || []).filter((item) => item && item.width > 1 && item.height > 1);
  const inside = (box) => box.left >= gap - 0.5
    && box.top >= gap - 0.5
    && box.right <= vw - gap + 0.5
    && box.bottom <= vh - gap + 0.5;
  const clear = (box) => inside(box) && !videos.some((video) => rectsOverlap(box, video, 0.5));
  if (vw > 0 && vw < 600) {
    const sheetH = Math.min(height, Math.max(140, Math.round(vh * 0.32)));
    return packBox(gap, Math.max(gap, vh - sheetH - gap), Math.max(120, vw - gap * 2), sheetH, 'sheet');
  }
  const spots = [];
  if (tile && tile.width > 0) {
    spots.push([tile.right + gap, tile.top]);
    spots.push([tile.left - width - gap, tile.top]);
    spots.push([tile.left, tile.bottom + gap]);
    spots.push([tile.left, tile.top - height - gap]);
  }
  spots.push([vw - width - gap, gap], [gap, gap], [vw - width - gap, vh - height - gap], [gap, vh - height - gap]);
  for (const [left, top] of spots) {
    const box = packBox(left, top, width, height, 'side');
    if (clear(box)) return box;
  }
  const sheetH = Math.min(height, Math.max(140, Math.round(vh * 0.28)));
  return packBox(gap, Math.max(gap, vh - sheetH - gap), Math.max(120, vw - gap * 2), sheetH, 'sheet');
}

const HOST = {
  cam0: ['cam0Panel'],
  cam1: ['cam1Panel'],
  cam3: ['gimbalSettings', 'gimbalPad'],
};

const menu = typeof document === 'undefined' ? null : document.getElementById('opticsContext');
const homes = new Map();

function remember(id) {
  const node = document.getElementById(id);
  if (!node || homes.has(id)) return node;
  homes.set(id, node.parentElement);
  return node;
}

function restoreAll() {
  for (const [id, parent] of homes) {
    const node = document.getElementById(id);
    if (node && parent && node.parentElement !== parent) parent.appendChild(node);
  }
}

function videoRects() {
  return [...document.querySelectorAll('#debriefCamGrid .debrief-cam-tile, #debriefCamGrid [data-camera-stage]')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const box = el.getBoundingClientRect();
      return box.width > 2 && box.height > 2;
    })
    .map((el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    });
}

function clearLayout() {
  const root = document.documentElement;
  root.removeAttribute('data-optics-sheet');
  root.removeAttribute('data-optics-pad');
  root.style.removeProperty('--optics-grid-h');
  root.style.removeProperty('--optics-sheet-h');
  const grid = document.getElementById('debriefCamGrid');
  if (!grid) return;
  grid.style.removeProperty('--optics-grid-h');
  grid.style.removeProperty('height');
  grid.style.removeProperty('max-height');
  grid.style.removeProperty('min-height');
  grid.style.removeProperty('overflow');
}

function limitGrid(px) {
  const grid = document.getElementById('debriefCamGrid');
  if (!grid) return;
  const height = `${Math.round(px)}px`;
  grid.style.setProperty('height', height, 'important');
  grid.style.setProperty('max-height', height, 'important');
  grid.style.setProperty('min-height', '0', 'important');
  grid.style.setProperty('overflow', 'hidden', 'important');
}

function reserveSpace(anchor) {
  clearLayout();
  const root = document.documentElement;
  const grid = document.getElementById('debriefCamGrid');
  const narrow = window.innerWidth < 600;
  if (narrow) {
    const sheetH = Math.min(MENU_H, Math.max(160, Math.round(window.innerHeight * 0.32)));
    root.dataset.opticsSheet = '1';
    root.style.setProperty('--optics-sheet-h', `${sheetH}px`);
    if (grid) {
      const top = grid.getBoundingClientRect().top;
      const limit = Math.max(96, Math.round(window.innerHeight - top - sheetH - 12));
      root.style.setProperty('--optics-grid-h', `${limit}px`);
      limitGrid(limit);
    }
    return;
  }
  if (!grid) return;
  const gridBox = grid.getBoundingClientRect();
  const spaceRight = window.innerWidth - gridBox.right;
  const spaceLeft = gridBox.left;
  if (Math.max(spaceRight, spaceLeft) < MENU_W + 16) {
    root.dataset.opticsPad = spaceRight >= spaceLeft ? 'right' : 'left';
  }
  void anchor;
}

function applyBox(box) {
  menu.style.boxSizing = 'border-box';
  menu.style.overflowY = 'auto';
  menu.style.minWidth = '0px';
  menu.style.width = `${Math.round(box.width)}px`;
  menu.style.maxWidth = `${Math.round(box.width)}px`;
  menu.style.height = `${Math.round(box.height)}px`;
  menu.style.maxHeight = `${Math.round(box.height)}px`;
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  menu.style.left = `${Math.round(box.left)}px`;
  menu.style.top = `${Math.round(box.top)}px`;
}

function place(anchor) {
  if (!menu) return;
  menu.hidden = false;
  reserveSpace(anchor);
  void menu.offsetHeight;
  const grid = document.getElementById('debriefCamGrid');
  const tile = anchor?.getBoundingClientRect?.() || null;
  let box = placeOpticsPopover({
    tile: tile && tile.width > 0
      ? { left: tile.left, top: tile.top, right: tile.right, bottom: tile.bottom, width: tile.width, height: tile.height }
      : null,
    tiles: videoRects(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  const pad = document.documentElement.dataset.opticsPad;
  if (pad && grid) {
    const gridBox = grid.getBoundingClientRect();
    const height = Math.min(MENU_H, Math.max(140, window.innerHeight - Math.max(GAP, gridBox.top) - GAP));
    const top = Math.max(GAP, Math.min(gridBox.top, window.innerHeight - height - GAP));
    if (pad === 'right') {
      box = packBox(gridBox.right + GAP, top, MENU_W, height, 'side');
    } else {
      box = packBox(Math.max(GAP, gridBox.left - MENU_W - GAP), top, MENU_W, height, 'side');
    }
  }
  if (document.documentElement.dataset.opticsSheet === '1') {
    const sheetH = box.height;
    box = packBox(GAP, window.innerHeight - sheetH - GAP, Math.max(120, window.innerWidth - GAP * 2), sheetH, 'sheet');
    const overlap = videoRects().reduce((hit, video) => Math.max(hit, video.bottom - box.top), 0);
    if (overlap > 1 && grid) {
      const current = grid.getBoundingClientRect().height;
      const next = Math.max(96, Math.round(current - overlap - 8));
      document.documentElement.style.setProperty('--optics-grid-h', `${next}px`);
      limitGrid(next);
      void grid.offsetHeight;
    }
  }
  applyBox(box);
  for (const id of ['cam0Panel', 'cam1Panel', 'gimbalSettings']) {
    const node = menu.querySelector(`#${id}`);
    if (!node) continue;
    node.style.maxHeight = '';
  }
}

let placing = false;

function ensureVisionFold(cam) {
  if (!menu) return null;
  let fold = menu.querySelector('.optics-vision-fold');
  if (!fold) {
    fold = document.createElement('details');
    fold.className = 'optics-vision-fold';
    const summary = document.createElement('summary');
    summary.textContent = 'זיהוי';
    const slot = document.createElement('div');
    slot.dataset.visionMenuSlot = '';
    fold.append(summary, slot);
    menu.appendChild(fold);
  }
  fold.open = false;
  menu.appendChild(fold);
  const slot = fold.querySelector('[data-vision-menu-slot]');
  const fill = window.__vlcFillVisionMenu;
  if (slot && typeof fill === 'function') fill(slot, cam);
  else document.dispatchEvent(new CustomEvent('vlc-tile-menu', { detail: { slot, camera: cam } }));
  return fold;
}

function openFor(cam, anchor) {
  if (!menu || placing) return;
  const ids = HOST[cam];
  if (!ids) return;
  placing = true;
  try {
    const vision = document.getElementById('visionTrackMenu');
    if (vision) vision.hidden = true;
    restoreAll();
    const switcher = document.querySelector('.optics-cam-switch');
    if (switcher && switcher.parentElement !== menu) menu.prepend(switcher);
    for (const id of ids) {
      const node = remember(id);
      if (node) menu.appendChild(node);
    }
    menu.dataset.cam = cam;
    const switchId = cam === 'cam0' ? 'opticsCam0Btn' : cam === 'cam1' ? 'opticsCam1Btn' : 'opticsGimbalBtn';
    document.getElementById(switchId)?.click();
    ensureVisionFold(cam);
    place(anchor);
  } finally {
    placing = false;
  }
}

function close() {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  clearLayout();
  restoreAll();
}

function bind() {
  const grid = document.getElementById('debriefCamGrid');
  if (!grid || !menu) return;
  for (const id of ['cam0Panel', 'cam1Panel', 'gimbalSettings', 'gimbalPad']) remember(id);
  grid.addEventListener('contextmenu', (event) => {
    const tile = event.target.closest?.('.debrief-cam-tile');
    if (!tile || !grid.contains(tile)) return;
    if (event.defaultPrevented) return;
    event.preventDefault();
    const cam = tile.dataset.cam;
    tile.classList.add('is-selected');
    openFor(cam, tile);
  });
  document.querySelector('.optics-cam-switch')?.addEventListener('click', (event) => {
    if (placing) return;
    const btn = event.target.closest?.('.optics-cam-btn');
    if (!btn) return;
    const cam = btn.id === 'opticsCam1Btn' ? 'cam1' : btn.id === 'opticsGimbalBtn' ? 'cam3' : 'cam0';
    openFor(cam, btn);
  });
  document.addEventListener('vlc-open-optics', (event) => {
    const cam = event.detail?.cam || 'cam3';
    const anchor = document.querySelector(`.debrief-cam-tile[data-cam="${cam}"]`) || menu;
    openFor(cam, anchor);
  });
  document.addEventListener('vlc-close-optics', () => close());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden) return;
    if (menu.contains(event.target)) return;
    if (event.target.closest?.('.debrief-cam-tile')) return;
    close();
  });
  onGimbalView((view) => {
    const chip = document.querySelector('.debrief-cam-tile[data-cam="cam3"] .debrief-cam-chip');
    if (!chip) return;
    const tile = chip.closest('.debrief-cam-tile');
    const img = tile?.querySelector('.debrief-cam-live');
    const live = tile?.dataset.signal === 'live' || (img && img.hidden !== true && Number(img.naturalWidth) >= 16);
    let reason = String(view?.reasonHe || '');
    if (reason.includes('אין קשור')) reason = reason.replace('אין קשור', 'אין קישור');
    const noLink = reason.startsWith('אין קישור');
    const show = view?.enabled !== true && reason.length > 0 && !(live && noLink);
    chip.hidden = !show;
    if (show) chip.textContent = reason;
  });
}

if (typeof document !== 'undefined') bind();
