/**
 * Compact camera cards for סטטוס מחשבים.
 * Reads cameras the companion status already carries. Missing fields stay omitted.
 * Names follow the optics tiles, not the companion role word.
 */
import { cameraDisplayName } from './camera-names.mjs';

const CAMERA_ORDER = ['cam0', 'cam1', 'cam2', 'cam3'];

const ERROR_HE = Object.freeze({
  disabled: 'כבוי',
  device_absent: 'אין התקן',
  ingest_module_absent: 'אין מודול',
  read_failed: 'קריאה נכשלה',
  opencv_unavailable: 'אין OpenCV',
  csi_requires_gstreamer_opencv: 'אין לכידה',
  no_reply: 'אין מענה',
  no_frame: 'אין פריים',
});

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readFinite(cam, key) {
  if (!Object.prototype.hasOwnProperty.call(cam, key)) return null;
  return finiteOrNull(cam[key]);
}

export function pulseCameraLink(companion) {
  const src = obj(companion) || {};
  const mode = src.mode || src.link?.mode || 'off';
  if (mode === 'real' && src.reachable === false) return { live: false, pill: 'לא מגיב' };
  const reachable = src.reachable === true || mode === 'mock';
  if (!reachable) return { live: false, pill: 'מנותק' };
  return { live: true, pill: null };
}

export function pulseCameraErrorText(error) {
  if (typeof error !== 'string') return null;
  const raw = error.trim();
  if (!raw) return null;
  return ERROR_HE[raw] || raw;
}

function cameraName(id) {
  return cameraDisplayName(id) || id;
}

function readStreaming(cam) {
  const state = typeof cam.state === 'string' ? cam.state.trim() : '';
  if (state) return state === 'streaming';
  if (cam.camera_ok === true || cam.camera_ok === false) return cam.camera_ok === true;
  return null;
}

function mergeCameraMaps(...maps) {
  const out = {};
  for (const map of maps) {
    const src = obj(map);
    if (!src) continue;
    for (const [id, cam] of Object.entries(src)) {
      const row = obj(cam);
      if (!row) continue;
      out[id] = { ...(out[id] || {}), ...row, id: row.id || out[id]?.id || id };
    }
  }
  return out;
}

function orderedIds(map) {
  return Object.keys(map).sort((a, b) => {
    const ia = CAMERA_ORDER.indexOf(a);
    const ib = CAMERA_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

export function formatPulseCameraFps(fps) {
  if (!Number.isFinite(fps)) return null;
  if (Number.isInteger(fps)) return String(fps);
  return String(Math.round(fps * 10) / 10);
}

export function formatPulseCameraAge(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function cardTone(streaming, error) {
  if (streaming === true && error) return 'warn';
  if (streaming === true) return 'ok';
  if (error) return 'bad';
  return 'off';
}

export function pulseCameraCards(companion) {
  const link = pulseCameraLink(companion);
  if (!link.live) return { live: false, pill: link.pill, cards: [] };
  const src = obj(companion) || {};
  const map = mergeCameraMaps(
    src.opticalNav?.cameras,
    src.optical_nav?.cameras,
    src.extras?.cameras,
    src.vision?.cameras,
  );
  const cards = orderedIds(map).map((id) => {
    const cam = map[id];
    const streaming = readStreaming(cam);
    const fps = readFinite(cam, 'fps');
    const ageMs = readFinite(cam, 'last_frame_age_ms');
    const error = pulseCameraErrorText(cam.error);
    return {
      id,
      name: cameraName(id, cam),
      streaming,
      fps,
      ageMs,
      error,
      tone: cardTone(streaming, error),
    };
  });
  if (!cards.length) return { live: true, pill: 'אין נתון', cards: [] };
  return { live: true, pill: null, cards };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function downTone(pill) {
  if (pill === 'לא מגיב') return 'bad';
  return 'off';
}

function appendCard(host, card) {
  const art = el('article', 'pulse-cam-card');
  art.dataset.cam = card.id;
  art.dataset.tone = card.tone;
  if (card.streaming === true) art.dataset.streaming = 'true';
  else if (card.streaming === false) art.dataset.streaming = 'false';
  const head = el('div', 'pulse-cam-head');
  head.append(el('span', 'pulse-cam-name', card.name));
  if (card.streaming === true) head.append(el('span', 'pulse-cam-pill', 'משדר'));
  else if (card.streaming === false) head.append(el('span', 'pulse-cam-pill', 'לא משדר'));
  art.append(head);
  const fps = formatPulseCameraFps(card.fps);
  const age = formatPulseCameraAge(card.ageMs);
  if (fps || age) {
    const facts = el('p', 'pulse-cam-facts');
    if (fps) {
      const bit = el('span', 'pulse-cam-fact');
      bit.append('קצב ');
      const num = el('bdi');
      num.dir = 'ltr';
      num.textContent = fps;
      bit.append(num);
      facts.append(bit);
    }
    if (age) {
      const bit = el('span', 'pulse-cam-fact');
      bit.append('גיל ');
      const num = el('bdi');
      num.dir = 'ltr';
      num.textContent = age;
      bit.append(num);
      facts.append(bit);
    }
    art.append(facts);
  }
  if (card.error) art.append(el('p', 'pulse-cam-error', card.error));
  host.append(art);
}

export function paintPulseCameraCards(host, model) {
  if (!host || !model) return;
  host.replaceChildren();
  if (!model.live || !model.cards.length) {
    host.dataset.link = model.live ? 'empty' : 'down';
    const art = el('article', 'pulse-cam-card');
    art.dataset.link = host.dataset.link;
    art.dataset.tone = downTone(model.pill);
    const head = el('div', 'pulse-cam-head');
    head.append(el('span', 'pulse-cam-name', 'מצלמות'));
    head.append(el('span', 'pulse-cam-pill', model.pill || 'מנותק'));
    art.append(head);
    host.append(art);
    return;
  }
  host.dataset.link = 'live';
  for (const card of model.cards) appendCard(host, card);
}

export function paintPulseCameraCardsFromCompanion(companion) {
  const src = obj(companion)
    || (typeof globalThis.latestCompanionFromServer === 'object' ? globalThis.latestCompanionFromServer : null);
  const host = document.getElementById('pulseCameraCards');
  paintPulseCameraCards(host, pulseCameraCards(src));
}

function boot() {
  globalThis.paintPulseCameraCardsFromCompanion = paintPulseCameraCardsFromCompanion;
  paintPulseCameraCardsFromCompanion();
  document.addEventListener('vlc:telemetry', () => {
    paintPulseCameraCardsFromCompanion();
  });
}

if (typeof document !== 'undefined') boot();
