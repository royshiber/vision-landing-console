/**
 * Runway overlay on the flight horizon, three tiles, and the level group
 * in the horizon right-click menu. Hidden while the level is off.
 */
import { mediaFit } from './vision-tracks.mjs';

const LEVELS = [
  { level: 0, label: 'כבוי', desc: 'בלי זיהוי ובלי ציור' },
  { level: 1, label: 'תצוגה', desc: 'קו האמצע, הסטייה ותיבות הסכנה' },
  { level: 2, label: 'התראות', desc: 'אזהרה והמלצה ללכת סביב' },
  { level: 3, label: 'הנחיית סימולטור', desc: 'חישוב היגוי. פקודה רק מול סימולטור' },
  { level: 4, label: 'הנחיה אמיתית', desc: 'נעול עד אישור מפורש' },
];

const STATUS_URL = '/api/runway/awareness';
const LEVEL_URL = '/api/runway/level';

let latest = { level: 0, estimate: null, adviceHe: '', level4Unlocked: false };
let timer = 0;

function el(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function bdi(doc, text) {
  const node = el(doc, 'bdi');
  node.dir = 'ltr';
  node.textContent = text;
  return node;
}

function sideWord(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.4) return 'על הקו';
  return value > 0 ? 'ימינה' : 'שמאלה';
}

function sideMark(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.4) return '';
  return value > 0 ? 'י' : 'ש';
}

function fillMeasure(doc, node, side, amount, confidence) {
  node.replaceChildren();
  const word = el(doc, 'span');
  word.textContent = side;
  node.append(word);
  if (amount) node.append(doc.createTextNode(' '), bdi(doc, amount));
  if (confidence) {
    const line = el(doc, 'span', 'runway-awareness-c');
    line.append(doc.createTextNode('ביטחון '), bdi(doc, `${confidence}%`));
    node.append(line);
  }
}

function stageIsShort(doc) {
  const stage = doc.getElementById('pfdHorizonStage');
  return !!stage && stage.clientHeight > 0 && stage.clientHeight < 280;
}

function fillShort(doc, node, amount, confidence, mark) {
  node.replaceChildren();
  if (mark) {
    const side = el(doc, 'span');
    side.textContent = mark;
    node.append(side);
  }
  if (amount) node.append(doc.createTextNode(mark ? ' ' : ''), bdi(doc, amount));
  if (confidence) {
    const line = el(doc, 'span', 'runway-awareness-c');
    line.append(bdi(doc, `${confidence}%`));
    node.append(line);
  }
}

function paintTiles(doc, status) {
  const tiles = doc.getElementById('runwayAwarenessTiles');
  const alert = doc.getElementById('runwayAwarenessAlert');
  if (!tiles) return;
  const on = Number(status?.level) >= 1;
  tiles.hidden = !on;
  const est = on && status?.estimate?.detected === true ? status.estimate : null;
  const conf = est?.confidence || {};
  const offset = doc.getElementById('runwayOffsetValue');
  const heading = doc.getElementById('runwayHeadingValue');
  const hazard = doc.getElementById('runwayHazardValue');
  const short = stageIsShort(doc);
  if (!est) {
    if (offset) offset.textContent = on ? (short ? 'אין' : 'אין מסלול') : '';
    if (heading) heading.textContent = on ? (short ? 'אין' : 'אין כיוון') : '';
    if (hazard) hazard.textContent = on ? 'אין' : '';
  } else if (short) {
    const meters = Number(est.offset_m);
    const amount = Number.isFinite(meters) ? `${Math.abs(meters).toFixed(1)}` : '';
    if (offset) fillShort(doc, offset, amount, Math.round(Number(conf.offset || 0) * 100), sideMark(Number(est.offset_px)));
    const deg = Number(est.heading_error_deg);
    if (heading) fillShort(doc, heading, Number.isFinite(deg) ? `${Math.abs(deg).toFixed(0)}°` : '', Math.round(Number(conf.heading || 0) * 100), sideMark(deg));
    const row = Array.isArray(status.hazards) && status.hazards[0];
    if (hazard) {
      hazard.replaceChildren();
      const word = el(doc, 'span');
      word.textContent = row?.label_he || 'נקי';
      hazard.append(word);
    }
  } else {
    const meters = Number(est.offset_m);
    const amount = Number.isFinite(meters) ? `${Math.abs(meters).toFixed(1)} מ׳` : '';
    if (offset) fillMeasure(doc, offset, sideWord(Number(est.offset_px)), amount, Math.round(Number(conf.offset || 0) * 100));
    const deg = Number(est.heading_error_deg);
    const turn = sideWord(deg);
    if (heading) fillMeasure(doc, heading, turn === 'על הקו' ? 'ישר' : turn, Number.isFinite(deg) ? `${Math.abs(deg).toFixed(0)}°` : '', Math.round(Number(conf.heading || 0) * 100));
    const row = Array.isArray(status.hazards) && status.hazards[0];
    if (hazard) {
      hazard.replaceChildren();
      const word = el(doc, 'span');
      word.textContent = row?.label_he || 'נקי';
      hazard.append(word);
      if (row && Number.isFinite(Number(row.confidence))) {
        const line = el(doc, 'span', 'runway-awareness-c');
        line.append(doc.createTextNode('ביטחון '), bdi(doc, `${Math.round(Number(row.confidence) * 100)}%`));
        hazard.append(line);
      }
    }
  }
  if (alert) {
    const text = on && Number(status.level) >= 2 ? String(status.adviceHe || '') : '';
    alert.hidden = !text;
    alert.textContent = text;
  }
  const state = doc.getElementById('runwayVisionState');
  const word = doc.getElementById('runwayVisionStateWord');
  const arm = doc.getElementById('runwayVisionArm');
  const active = on && status?.vision?.state === 'active';
  const mission = active && status?.vision?.optical === false;
  const goneAround = on && status?.vision?.state === 'go_around';
  const released = on && status?.vision?.state === 'released';
  const ready = on && status?.vision?.buttonReady === true;
  const blockHe = on && !active && !goneAround ? String(status?.vision?.blockHe || '') : '';
  const levelLow = on && Number(status?.level) < 3;
  const noLand = on && (
    status?.vision?.hasLand === false
    || status?.vision?.reason === 'no_land'
    || status?.vision?.labelHe === 'אין נחיתה במשימה'
  );
  const label = !on
    ? ''
    : active
      ? (mission
        ? 'נחיתת משימה: הנחיית גלגול'
        : (stageIsShort(doc) ? 'אופטית פעילה' : 'נחיתה אופטית פעילה. לביטול: החלפת מצב טיסה'))
      : goneAround
        ? 'סבוב מחדש'
        : levelLow
          ? 'רמה 3 נדרשת לנחיתה אופטית'
          : noLand
            ? 'אין נחיתה במשימה'
            : blockHe
              ? blockHe
              : released
                ? 'שוחרר'
                : ready
                  ? 'ממתין'
                  : 'אין מסלול במסגרת';
  const bar = doc.getElementById('runwayVisionBar');
  if (bar) bar.hidden = !on;
  if (state) {
    state.hidden = !on;
    state.dataset.visionState = String(status?.vision?.state || 'waiting');
  }
  if (word) word.textContent = label;
  const hold = doc.getElementById('runwayVisionHold');
  const takeover = doc.getElementById('runwayVisionTakeover');
  if (hold) {
    hold.hidden = true;
    hold.textContent = '';
  }
  if (takeover) {
    takeover.hidden = true;
    takeover.textContent = '';
  }
  if (arm) {
    arm.hidden = !on;
    const disabled = levelLow || noLand || !ready || active || blockHe !== '';
    arm.disabled = disabled;
    arm.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    const missionShort = mission && stageIsShort(doc);
    arm.textContent = missionShort ? 'משימה פעילה' : (mission ? 'נחיתת משימה פעילה' : 'נחיתה אופטית');
    if (missionShort) arm.dataset.armLabel = 'mission';
    else delete arm.dataset.armLabel;
    arm.classList.toggle('runway-arm-mission', missionShort);
    arm.setAttribute('aria-pressed', active && !mission ? 'true' : 'false');
  }
}

function mapPoint(point, fit, frameW, frameH) {
  if (!fit || !point) return null;
  const sx = frameW > 0 ? fit.nw / frameW : 1;
  const sy = frameH > 0 ? fit.nh / frameH : 1;
  return {
    x: fit.x + point[0] * sx * fit.scaleX,
    y: fit.y + point[1] * sy * fit.scaleY,
  };
}

function paintOverlay(doc, status) {
  const stage = doc.getElementById('pfdHorizonStage');
  const canvas = doc.getElementById('runwayAwarenessLayer');
  if (!stage || !canvas) return;
  const show = Number(status?.level) >= 1 && status?.estimate?.detected === true && Array.isArray(status.estimate.polygon);
  if (!show) {
    canvas.hidden = true;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    return;
  }
  const media = [...stage.querySelectorAll('img, video')].find((node) => node.hidden !== true && ((node.naturalWidth || node.videoWidth || 0) >= 2));
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  const fit = media ? mediaFit(media, width, height) : null;
  if (!fit) {
    canvas.hidden = true;
    return;
  }
  canvas.hidden = false;
  const ratio = doc.defaultView?.devicePixelRatio || 1;
  const nextW = Math.round(width * ratio);
  const nextH = Math.round(height * ratio);
  if (canvas.width !== nextW || canvas.height !== nextH) {
    canvas.width = nextW;
    canvas.height = nextH;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const frameW = media.naturalWidth || media.videoWidth || width;
  const frameH = media.naturalHeight || media.videoHeight || height;
  const poly = status.estimate.polygon.map((point) => mapPoint(point, fit, frameW, frameH)).filter(Boolean);
  if (poly.length >= 4) {
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    poly.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const line = (status.estimate.centerline || []).map((point) => mapPoint(point, fit, frameW, frameH)).filter(Boolean);
  if (line.length === 2) {
    ctx.beginPath();
    ctx.moveTo(line[0].x, line[0].y);
    ctx.lineTo(line[1].x, line[1].y);
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const craft = mapPoint(status.estimate.aircraft || [frameW / 2, frameH / 2], fit, frameW, frameH);
  if (craft && line.length === 2) {
    const span = line[1].y - line[0].y || 1;
    const t = Math.max(0, Math.min(1, (craft.y - line[0].y) / span));
    const hit = { x: line[0].x + (line[1].x - line[0].x) * t, y: line[0].y + (line[1].y - line[0].y) * t };
    ctx.beginPath();
    ctx.moveTo(craft.x, craft.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.arc(craft.x, craft.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2;
  for (const hazard of status.hazards || []) {
    const box = hazard.bbox;
    if (!box || box.length < 4) continue;
    const a = mapPoint([box[0], box[1]], fit, frameW, frameH);
    const b = mapPoint([box[0] + box[2], box[1] + box[3]], fit, frameW, frameH);
    if (!a || !b) continue;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
}

function syncMenu(doc, status) {
  const level = Number(status?.level);
  doc.querySelectorAll('[data-awareness-level]').forEach((btn) => {
    const on = Number(btn.dataset.awarenessLevel) === level;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  });
}

function paint(doc, status) {
  latest = status || latest;
  paintTiles(doc, latest);
  paintOverlay(doc, latest);
  syncMenu(doc, latest);
  const stage = doc.getElementById('pfdHorizonStage');
  if (stage) stage.dataset.awarenessMode = String(latest.level ?? 0);
  syncStage(doc);
}

function syncStage(doc) {
  const stage = doc.getElementById('pfdHorizonStage');
  if (!stage) return;
  stage.dataset.awarenessStage = stage.clientHeight > 0 && stage.clientHeight < 280 ? 'short' : 'full';
}

async function readStatus(camera) {
  const query = camera ? `?camera=${encodeURIComponent(camera)}` : '';
  const res = await fetch(`${STATUS_URL}${query}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

function horizonCamera(doc) {
  const selected = doc.querySelector('#horizonCameraMenu [data-horizon-cam][aria-checked="true"]');
  const id = selected?.dataset?.horizonCam || '';
  return id === 'cam1' || id === 'cam2' || id === 'cam3' ? id : '';
}

async function postLevelArm(arm) {
  const res = await fetch('/api/runway/vision-arm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arm: arm === true }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, data };
}

async function postLevel(body) {
  const res = await fetch(LEVEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, data };
}

function ensureDialog(doc) {
  let dialog = doc.getElementById('runwayLevelConfirm');
  if (dialog) return dialog;
  dialog = el(doc, 'div', 'runway-level-confirm');
  dialog.id = 'runwayLevelConfirm';
  dialog.hidden = true;
  dialog.dir = 'rtl';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'אישור הנחיה');
  const card = el(doc, 'div', 'runway-level-confirm-card');
  const text = el(doc, 'p');
  text.id = 'runwayLevelConfirmText';
  const actions = el(doc, 'div', 'runway-level-confirm-actions');
  const yes = el(doc, 'button');
  yes.type = 'button';
  yes.id = 'runwayLevelConfirmYes';
  yes.textContent = 'מאשר';
  const no = el(doc, 'button');
  no.type = 'button';
  no.id = 'runwayLevelConfirmNo';
  no.textContent = 'ביטול';
  actions.append(yes, no);
  card.append(text, actions);
  dialog.append(card);
  doc.body.append(dialog);
  no.addEventListener('click', () => { dialog.hidden = true; });
  yes.addEventListener('click', async () => {
    const { ok, data } = await postLevel({ level: 4, confirm: true, phrase: 'מאשר' });
    dialog.hidden = true;
    if (!ok) {
      text.textContent = data.messageHe || 'הנחיה אמיתית נעולה. הרמה לא השתנתה.';
      dialog.hidden = false;
      yes.hidden = true;
      no.textContent = 'סגור';
      return;
    }
    paint(doc, data);
  });
  return dialog;
}

function openLevel4(doc) {
  const dialog = ensureDialog(doc);
  const text = doc.getElementById('runwayLevelConfirmText');
  const yes = doc.getElementById('runwayLevelConfirmYes');
  const no = doc.getElementById('runwayLevelConfirmNo');
  const menu = doc.getElementById('horizonCameraMenu');
  if (menu) menu.hidden = true;
  if (latest.level4Unlocked !== true) {
    if (text) text.textContent = 'הנחיה אמיתית נעולה. הרמה לא השתנתה.';
    if (yes) yes.hidden = true;
    if (no) no.textContent = 'סגור';
  } else {
    if (text) text.textContent = 'הנחיה אמיתית יכולה להזיז את המטוס. לאשר את הרמה?';
    if (yes) yes.hidden = false;
    if (no) no.textContent = 'ביטול';
  }
  dialog.hidden = false;
}

function ensureMenu(doc) {
  const menu = doc.getElementById('horizonCameraMenu');
  if (!menu || menu.querySelector('[data-awareness-level]')) return;
  const group = el(doc, 'div', 'horizon-menu-group horizon-menu-group--runway');
  group.id = 'runwayLevelGroup';
  const head = el(doc, 'p', 'horizon-menu-heading');
  head.textContent = 'מודעות מסלול';
  group.append(head);
  for (const row of LEVELS) {
    const btn = el(doc, 'button', 'horizon-cam-menu-item');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitemradio');
    btn.dataset.awarenessLevel = String(row.level);
    const name = el(doc, 'span', 'horizon-menu-label');
    name.textContent = row.label;
    const desc = el(doc, 'span', 'horizon-menu-desc');
    desc.textContent = row.desc;
    btn.append(name, desc);
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (row.level === 4) {
        openLevel4(doc);
        return;
      }
      const { data } = await postLevel({ level: row.level });
      paint(doc, data);
      menu.hidden = true;
    });
    group.append(btn);
  }
  menu.append(group);
  syncMenu(doc, latest);
}

function ensureChrome(doc) {
  const stage = doc.getElementById('pfdHorizonStage');
  if (!stage) return;
  if (!doc.getElementById('runwayAwarenessLayer')) {
    const canvas = el(doc, 'canvas', 'runway-awareness-layer');
    canvas.id = 'runwayAwarenessLayer';
    canvas.hidden = true;
    const stack = el(doc, 'div', 'runway-awareness-stack');
    stack.id = 'runwayAwarenessStack';
    const alert = el(doc, 'p', 'runway-awareness-alert');
    alert.id = 'runwayAwarenessAlert';
    alert.hidden = true;
    const tiles = el(doc, 'div', 'runway-awareness-tiles');
    tiles.id = 'runwayAwarenessTiles';
    tiles.hidden = true;
    tiles.dir = 'rtl';
    const bar = el(doc, 'div', 'runway-vision-bar');
    bar.id = 'runwayVisionBar';
    bar.hidden = true;
    bar.dir = 'rtl';
    const state = el(doc, 'div', 'runway-awareness-state');
    state.id = 'runwayVisionState';
    state.hidden = true;
    const stateKey = el(doc, 'span', 'runway-awareness-k');
    stateKey.textContent = 'מצב';
    const stateWord = el(doc, 'strong', 'runway-awareness-v');
    stateWord.id = 'runwayVisionStateWord';
    stateWord.textContent = 'ממתין';
    const hold = el(doc, 'span', 'runway-vision-hold');
    hold.id = 'runwayVisionHold';
    hold.hidden = true;
    const takeover = el(doc, 'span', 'runway-vision-hold');
    takeover.id = 'runwayVisionTakeover';
    takeover.hidden = true;
    const arm = el(doc, 'button', 'runway-awareness-arm');
    arm.type = 'button';
    arm.id = 'runwayVisionArm';
    arm.textContent = 'נחיתה אופטית';
    arm.hidden = true;
    arm.disabled = true;
    arm.setAttribute('aria-disabled', 'true');
    arm.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (arm.disabled) return;
      const { data } = await postLevelArm(true);
      paint(doc, data);
    });
    state.append(stateKey, stateWord, hold, takeover);
    bar.append(state, arm);
    const hud = doc.getElementById('flightHud');
    if (hud?.parentElement) hud.insertAdjacentElement('afterend', bar);
    const measures = el(doc, 'div', 'runway-awareness-measures');
    for (const [id, label, valueId] of [
      ['offset', 'סטייה', 'runwayOffsetValue'],
      ['heading', 'כיוון', 'runwayHeadingValue'],
      ['hazard', 'סכנה', 'runwayHazardValue'],
    ]) {
      const tile = el(doc, 'div', 'runway-awareness-tile');
      tile.dataset.awarenessTile = id;
      const key = el(doc, 'span', 'runway-awareness-k');
      key.textContent = label;
      const value = el(doc, 'strong', 'runway-awareness-v');
      value.id = valueId;
      tile.append(key, value);
      measures.append(tile);
    }
    tiles.append(measures);
    stack.append(alert, tiles);
    stage.append(canvas, stack);
  }
  ensureMenu(doc);
  ensureDialog(doc);
}

export function mountRunwayAwareness(doc = document) {
  if (!doc?.getElementById || doc.documentElement?.dataset?.runwayAwareness === '1') return;
  if (doc.documentElement) doc.documentElement.dataset.runwayAwareness = '1';
  const arm = () => {
    ensureChrome(doc);
    const view = doc.defaultView;
    if (!view) return;
    if (timer) view.clearTimeout(timer);
    timer = view.setTimeout(async () => {
      try {
        const status = await readStatus(horizonCamera(doc));
        if (status) paint(doc, status);
      } catch { /* the next poll retries */ }
      arm();
    }, 1000);
  };
  arm();
  const stage = doc.getElementById('pfdHorizonStage');
  if (stage && typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(() => {
      syncStage(doc);
      paintOverlay(doc, latest);
    });
    watch.observe(stage);
  }
  doc.addEventListener('click', () => {
    if (doc.getElementById('horizonCameraMenu') && !doc.querySelector('#horizonCameraMenu [data-awareness-level]')) ensureMenu(doc);
  });
  doc.addEventListener('contextmenu', () => clampHorizonMenu(doc));
}

function clampHorizonMenu(doc) {
  const menu = doc.getElementById('horizonCameraMenu');
  const view = doc.defaultView;
  if (!menu || menu.hidden || !view) return;
  const margin = 8;
  const maxH = Math.max(120, view.innerHeight - margin * 2);
  const maxW = Math.max(160, view.innerWidth - margin * 2);
  menu.style.maxHeight = `${maxH}px`;
  menu.style.maxWidth = `${Math.min(300, maxW)}px`;
  menu.style.overflow = 'auto';
  const rect = menu.getBoundingClientRect();
  const height = Math.min(rect.height, maxH);
  const width = Math.min(rect.width, maxW);
  let top = rect.top;
  let left = rect.left;
  if (top + height > view.innerHeight - margin) top = view.innerHeight - margin - height;
  if (left + width > view.innerWidth - margin) left = view.innerWidth - margin - width;
  if (top < margin) top = margin;
  if (left < margin) left = margin;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
  revealRunwayGroup(menu);
}

function revealRunwayGroup(menu) {
  const group = menu.querySelector('#runwayLevelGroup');
  if (!group) return;
  if (typeof group.scrollIntoView === 'function') {
    group.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const menuBox = menu.getBoundingClientRect();
  const buttons = group.querySelectorAll('[data-awareness-level]');
  let top = Infinity;
  let bottom = -Infinity;
  buttons.forEach((btn) => {
    const box = btn.getBoundingClientRect();
    if (box.height < 1) return;
    if (box.top < top) top = box.top;
    if (box.bottom > bottom) bottom = box.bottom;
  });
  if (!Number.isFinite(top)) return;
  const overflowBottom = bottom - menuBox.bottom;
  const overflowTop = menuBox.top - top;
  if (overflowBottom <= 1 && overflowTop <= 1) return;
  const span = bottom - top;
  if (span <= menuBox.height + 1) {
    menu.scrollTop += overflowBottom > 1 ? overflowBottom : -overflowTop;
    return;
  }
  menu.scrollTop += top - menuBox.top;
}

if (typeof document !== 'undefined') mountRunwayAwareness(document);
