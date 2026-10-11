/**
 * Optics controls live in a right-click menu on the camera tile.
 * The standing settings column and gimbal pad stay out of the layout.
 * Existing control ids move into the menu; they are not cloned.
 */
import { onGimbalView } from './gimbal-pad.mjs';

const HOST = {
  cam0: ['cam0Panel'],
  cam1: ['cam1Panel'],
  cam3: ['gimbalSettings', 'gimbalPad'],
};

const menu = document.getElementById('opticsContext');
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

function place(anchor) {
  if (!menu) return;
  menu.hidden = false;
  menu.style.boxSizing = 'border-box';
  menu.style.overflowY = 'auto';
  menu.style.width = '228px';
  menu.style.maxWidth = '228px';
  menu.style.maxHeight = '210px';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const tile = anchor?.getBoundingClientRect?.() || null;
  const width = 228;
  const height = Math.min(menu.getBoundingClientRect().height || 210, 210);
  let left = 8;
  let top = 8;
  if (tile && tile.width > 0) {
    left = tile.right - width - 8;
    top = tile.top + 8;
    if (left < tile.left) left = tile.left + 8;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
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

bind();
