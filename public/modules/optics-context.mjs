/**
 * Optics controls live in a right-click menu on the camera tile.
 * The standing settings column and gimbal pad stay out of the layout.
 * Existing control ids move into the menu; they are not cloned.
 */
import { onGimbalView } from './gimbal-pad.mjs';

const HOST = {
  cam0: ['cam0Panel'],
  cam1: ['cam1Panel'],
  a8: ['gimbalSettings', 'gimbalPad'],
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
  menu.style.maxHeight = `${Math.max(120, window.innerHeight - 16)}px`;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openFor(cam, x, y) {
  if (!menu) return;
  const ids = HOST[cam];
  if (!ids) return;
  restoreAll();
  for (const id of ids) {
    const node = remember(id);
    if (node) menu.appendChild(node);
  }
  menu.dataset.cam = cam;
  place(x, y);
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
    event.preventDefault();
    const cam = tile.dataset.cam;
    tile.classList.add('is-selected');
    openFor(cam, event.clientX, event.clientY);
  });
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
    const chip = document.querySelector('.debrief-cam-tile[data-cam="a8"] .debrief-cam-chip');
    if (!chip) return;
    const reason = view?.reasonHe || '';
    const show = view?.enabled !== true && reason.length > 0;
    chip.hidden = !show;
    if (show) chip.textContent = reason;
  });
}

bind();
