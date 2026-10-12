/**
 * Digital zoom on a camera picture. Wheel, trackpad pinch, and a two-finger
 * touch pinch zoom around the pointer. One finger pans only while zoomed.
 * Double-click and double-tap reset. Cap is 8x.
 * Nothing here talks to a gimbal or a flight controller.
 */

export const CAM_ZOOM_MIN = 1;
export const CAM_ZOOM_MAX = 8;

export function clampZoom(scale) {
  const n = Number(scale);
  if (!Number.isFinite(n)) return CAM_ZOOM_MIN;
  return Math.min(CAM_ZOOM_MAX, Math.max(CAM_ZOOM_MIN, n));
}

export function clampZoomPan(tx, ty, scale, width, height) {
  const s = clampZoom(scale);
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  if (s <= 1 || !(w > 0) || !(h > 0)) return { tx: 0, ty: 0, scale: CAM_ZOOM_MIN };
  const minX = w * (1 - s);
  const minY = h * (1 - s);
  const x = Math.min(0, Math.max(minX, Number(tx) || 0));
  const y = Math.min(0, Math.max(minY, Number(ty) || 0));
  return { tx: x, ty: y, scale: s };
}

/** Keep the point under the cursor fixed while the scale changes. */
export function zoomAroundPoint({ scale = 1, tx = 0, ty = 0, px = 0, py = 0, nextScale = 1, width = 0, height = 0 } = {}) {
  const s1 = clampZoom(scale);
  const s2 = clampZoom(nextScale);
  if (s2 <= 1) return { scale: CAM_ZOOM_MIN, tx: 0, ty: 0 };
  const cx = (Number(px) - Number(tx)) / s1;
  const cy = (Number(py) - Number(ty)) / s1;
  return clampZoomPan(Number(px) - cx * s2, Number(py) - cy * s2, s2, width, height);
}

export function zoomFactorFromWheel(deltaY) {
  const delta = Number(deltaY);
  if (!Number.isFinite(delta) || delta === 0) return 1;
  return Math.exp(-delta * 0.0025);
}

/** Scale after a two-finger pinch. startDist is the span at pointer-down. */
export function zoomFromPinch(scale, startDist, dist) {
  const base = Number(startDist);
  const next = Number(dist);
  if (!(base > 0) || !(next > 0)) return clampZoom(scale);
  return clampZoom((Number(scale) || CAM_ZOOM_MIN) * (next / base));
}

const MEDIA = 'img, video, canvas.vision-box-layer, .vision-hit-layer';

function stageOf(node) {
  return node?.closest?.('[data-camera-stage]') || null;
}

function ensureLayer(stage) {
  let layer = stage.querySelector(':scope > .cam-zoom-layer');
  if (!layer) {
    layer = stage.ownerDocument.createElement('div');
    layer.className = 'cam-zoom-layer';
    stage.insertBefore(layer, stage.firstChild);
  }
  return layer;
}

function adoptMedia(stage) {
  const layer = ensureLayer(stage);
  const nodes = [...stage.querySelectorAll(MEDIA)];
  for (const node of nodes) {
    if (stageOf(node) !== stage) continue;
    if (node.closest('.cam-zoom-layer') === layer) continue;
    if (node.id === 'horizonCanvas') continue;
    layer.appendChild(node);
  }
  return layer;
}

function readState(stage) {
  return {
    scale: clampZoom(stage.dataset.camScale || 1),
    tx: Number(stage.dataset.camTx) || 0,
    ty: Number(stage.dataset.camTy) || 0,
  };
}

function writeState(stage, next) {
  const box = stage.getBoundingClientRect();
  const clamped = clampZoomPan(next.tx, next.ty, next.scale, box.width, box.height);
  stage.dataset.camScale = String(clamped.scale);
  stage.dataset.camTx = String(Math.round(clamped.tx));
  stage.dataset.camTy = String(Math.round(clamped.ty));
  const layer = adoptMedia(stage);
  layer.style.transformOrigin = '0 0';
  layer.style.transform = clamped.scale === 1
    ? ''
    : `translate(${clamped.tx}px, ${clamped.ty}px) scale(${clamped.scale})`;
  stage.classList.toggle('is-zoomed', clamped.scale > 1);
}

function resetZoom(stage) {
  writeState(stage, { scale: 1, tx: 0, ty: 0 });
}

function ignoreTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, .horizon-quick, .gimbal-pad, .gimbal-video-pad, [data-vision-release], [data-vision-lock-chip]'));
}

export function bindCameraZoom(stage) {
  if (!stage || stage.dataset.camZoom === '1') return;
  stage.dataset.camZoom = '1';
  adoptMedia(stage);
  if (typeof MutationObserver === 'function') {
    const watch = new MutationObserver(() => adoptMedia(stage));
    watch.observe(stage, { childList: true, subtree: true });
  }
  stage.addEventListener('wheel', (event) => {
    if (ignoreTarget(event.target)) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const state = readState(stage);
    const next = zoomAroundPoint({
      ...state,
      px: event.clientX - rect.left,
      py: event.clientY - rect.top,
      nextScale: state.scale * zoomFactorFromWheel(event.deltaY),
      width: rect.width,
      height: rect.height,
    });
    writeState(stage, next);
  }, { passive: false });

  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let lastTap = 0;

  stage.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    if (ignoreTarget(event.target)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { stage.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const state = readState(stage);
      pinch = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        scale: state.scale,
        tx: state.tx,
        ty: state.ty,
      };
      drag = null;
      return;
    }
    const state = readState(stage);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      tx: state.tx,
      ty: state.ty,
      scale: state.scale,
      moved: false,
    };
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && pinch) {
      const pts = [...pointers.values()];
      const a = pts[0];
      const b = pts[1];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const rect = stage.getBoundingClientRect();
      const next = zoomAroundPoint({
        scale: pinch.scale,
        tx: pinch.tx,
        ty: pinch.ty,
        px: ((a.x + b.x) / 2) - rect.left,
        py: ((a.y + b.y) / 2) - rect.top,
        nextScale: zoomFromPinch(pinch.scale, pinch.dist, dist),
        width: rect.width,
        height: rect.height,
      });
      writeState(stage, next);
      return;
    }
    if (!drag || event.pointerId !== drag.id || drag.scale <= 1) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const state = readState(stage);
    writeState(stage, { scale: state.scale, tx: drag.tx + dx, ty: drag.ty + dy });
  });
  const endPointer = (event) => {
    if (!event || !pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    const endedDrag = drag && event.pointerId === drag.id ? drag : null;
    if (endedDrag) drag = null;
    if (pointers.size === 1) {
      const [id, point] = [...pointers.entries()][0];
      const state = readState(stage);
      drag = {
        id,
        x: point.x,
        y: point.y,
        tx: state.tx,
        ty: state.ty,
        scale: state.scale,
        moved: true,
      };
      return;
    }
    if (!endedDrag || endedDrag.moved || event.pointerType !== 'touch') return;
    const now = Date.now();
    if (lastTap && now - lastTap < 350) {
      lastTap = 0;
      resetZoom(stage);
      return;
    }
    lastTap = now;
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('dblclick', (event) => {
    if (ignoreTarget(event.target)) return;
    event.preventDefault();
    resetZoom(stage);
  });
}

export function mountCameraZoom(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc?.querySelectorAll) return;
  doc.querySelectorAll('[data-camera-stage]').forEach((stage) => bindCameraZoom(stage));
  if (typeof MutationObserver !== 'function') return;
  const watch = new MutationObserver(() => {
    doc.querySelectorAll('[data-camera-stage]').forEach((stage) => bindCameraZoom(stage));
  });
  watch.observe(doc.body || doc.documentElement || doc, { childList: true, subtree: true });
}

if (typeof document !== 'undefined') mountCameraZoom(document);
