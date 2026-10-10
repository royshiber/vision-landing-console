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

function place(x, y) {
  if (!menu) return;
  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const limit = Math.max(140, window.innerHeight - 16);
  menu.style.boxSizing = 'border-box';
  menu.style.overflowY = 'auto';
  menu.style.maxHeight = `${limit}px`;
  const narrow = window.innerWidth <= 720;
  if (narrow) {
    const centers = [...document.querySelectorAll('#debriefCamGrid .debrief-cam-tile')].map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    }).filter((n) => n > 0);
    const below = centers.length ? Math.max(...centers) + 8 : y;
    menu.style.maxHeight = `${Math.floor(Math.max(140, window.innerHeight - below - 8))}px`;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(below, window.innerHeight - rect.height - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  } else {
    const rect = menu.getBoundingClientRect();
    const height = Math.min(rect.height, limit);
    const ceiling = Math.max(8, window.innerHeight - limit - 8);
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8), ceiling);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }
  for (const id of ['cam0Panel', 'cam1Panel']) {
    const node = menu.querySelector(`#${id}`);
    if (!node) continue;
    const panelTop = node.getBoundingClientRect().top;
    node.style.maxHeight = `${Math.max(80, Math.floor(window.innerHeight - panelTop - 8))}px`;
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

function openFor(cam, x, y) {
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
    place(x, y);
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
    openFor(cam, event.clientX, event.clientY);
  });
  document.querySelector('.optics-cam-switch')?.addEventListener('click', (event) => {
    if (placing) return;
    const btn = event.target.closest?.('.optics-cam-btn');
    if (!btn) return;
    const cam = btn.id === 'opticsCam1Btn' ? 'cam1' : btn.id === 'opticsGimbalBtn' ? 'cam3' : 'cam0';
    const rect = btn.getBoundingClientRect();
    openFor(cam, rect.left, rect.bottom + 8);
  });
  document.addEventListener('vlc-open-optics', (event) => {
    const cam = event.detail?.cam || 'cam3';
    openFor(cam, Number(event.detail?.x) || 24, Number(event.detail?.y) || 80);
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
