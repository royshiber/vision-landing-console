/**
 * Large gimbal picture with an annotation layer.
 * Boxes come only from a detection list the console already has.
 * An empty or missing list leaves the layer empty. No invented boxes.
 */
import { frameMissShowsNoSignal } from './camera-frame-hold.mjs';
import { createLatestJpegPump } from './camera-latest-frame.mjs';

const FRAME = '/api/jetson/v1/cameras/cam3/frame';

export function boxesFromDetectionList(list) {
  if (!Array.isArray(list)) return [];
  const boxes = [];
  for (const det of list) {
    const box = detectionBox(det);
    if (box) boxes.push(box);
  }
  return boxes;
}

function detectionBox(det) {
  if (!det || typeof det !== 'object') return null;
  const label = detectionLabel(det);
  const corners = Array.isArray(det.corners_px) ? det.corners_px : (Array.isArray(det.corners) ? det.corners : null);
  if (corners && corners.length >= 4) {
    const xs = corners.map((p) => Number(p?.[0]));
    const ys = corners.map((p) => Number(p?.[1]));
    if (xs.every(Number.isFinite) && ys.every(Number.isFinite)) {
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      if (w > 0 && h > 0) return { x, y, w, h, label };
    }
  }
  const raw = Array.isArray(det.bbox_px) ? det.bbox_px : (Array.isArray(det.bbox) ? det.bbox : null);
  if (!raw || raw.length < 4) return null;
  const [a, b, c, d] = raw.map(Number);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  if (c > a && d > b) return { x: a, y: b, w: c - a, h: d - b, label };
  if (c > 0 && d > 0) return { x: a, y: b, w: c, h: d, label };
  return null;
}

function detectionLabel(det) {
  const text = det.label_he || det.labelHe || det.label || det.id || det.detection_id;
  if (text == null) return '';
  return String(text);
}

function containedRect(img, width, height) {
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  if (!(nw > 0) || !(nh > 0) || !(width > 0) || !(height > 0)) {
    return { x: 0, y: 0, w: width, h: height, scale: 1 };
  }
  const scale = Math.min(width / nw, height / nh);
  const w = nw * scale;
  const h = nh * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h, scale };
}

export function drawLockBoxes(canvas, img, list) {
  if (!canvas) return;
  const width = Math.max(1, Math.round(canvas.clientWidth || img?.clientWidth || 1));
  const height = Math.max(1, Math.round(canvas.clientHeight || img?.clientHeight || 1));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const boxes = boxesFromDetectionList(list);
  if (!boxes.length || !img || img.hidden || !(img.naturalWidth > 0)) return;
  const fit = containedRect(img, width, height);
  ctx.strokeStyle = '#fbbf24';
  ctx.fillStyle = '#f8fafc';
  ctx.lineWidth = 2;
  ctx.font = '700 13px Heebo, sans-serif';
  for (const box of boxes) {
    const x = fit.x + box.x * fit.scale;
    const y = fit.y + box.y * fit.scale;
    const w = box.w * fit.scale;
    const h = box.h * fit.scale;
    ctx.strokeRect(x, y, w, h);
    if (box.label) ctx.fillText(box.label, x + 4, Math.max(14, y - 4));
  }
}

function init() {
  if (typeof document === 'undefined') return;
  const screen = document.getElementById('gimbalScreen');
  const img = document.getElementById('gimbalScreenImg');
  const note = document.getElementById('gimbalScreenNote');
  const canvas = document.getElementById('gimbalScreenNotes');
  if (!screen || !img) return;
  let list = null;
  let open = false;

  function paintNote(show) {
    if (!note) return;
    note.hidden = show !== true;
    if (show) note.textContent = 'אין אות';
  }

  function redraw() {
    drawLockBoxes(canvas, img, list);
  }

  const pump = createLatestJpegPump({
    urlFor(gen) {
      return `${FRAME}?t=${gen}`;
    },
    onFrame(src) {
      if (!open) return;
      img.dataset.frameToken = src;
      img.onload = () => {
        if (!open || img.dataset.frameToken !== src) return;
        redraw();
        requestAnimationFrame(() => pump.kick());
      };
      img.src = src;
      img.hidden = false;
      img.dataset.seen = String(Date.now());
      img.dataset.misses = '0';
      paintNote(false);
    },
    onMiss() {
      if (!open) return;
      const misses = Number(img.dataset.misses || 0) + 1;
      img.dataset.misses = String(misses);
      const showNone = frameMissShowsNoSignal({
        seenAt: Number(img.dataset.seen || 0),
        now: Date.now(),
        streaming: true,
        consecutiveMisses: misses,
      });
      if (!showNone && Number(img.dataset.seen || 0) > 0 && img.getAttribute('src')) {
        img.hidden = false;
        paintNote(false);
        redraw();
        return;
      }
      if (showNone) {
        img.hidden = true;
        img.removeAttribute('src');
        img.dataset.seen = '';
        paintNote(true);
      }
      redraw();
    },
  });

  function setOpen(next) {
    open = next === true;
    screen.hidden = !open;
    if (!open) {
      pump.stop();
      return;
    }
    pump.start();
    redraw();
  }

  document.querySelectorAll('[data-gimbal-screen="open"]').forEach((btn) => {
    btn.addEventListener('click', () => setOpen(true));
  });
  document.getElementById('gimbalScreenClose')?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) setOpen(false);
  });
  img.addEventListener('load', () => redraw());
  document.addEventListener('vlc-lock-detections', (event) => {
    list = Array.isArray(event.detail) ? event.detail : null;
    redraw();
  });
  document.addEventListener('vlc-companion-cameras', (event) => {
    const detail = event.detail;
    const fromVision = detail?.vision?.detections;
    const fromLanding = detail?.landing?.detections;
    if (Array.isArray(fromVision)) list = fromVision;
    else if (Array.isArray(fromLanding)) list = fromLanding;
    redraw();
    if (open) pump.start();
  });
}

init();
