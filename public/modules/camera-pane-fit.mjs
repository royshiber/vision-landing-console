/**
 * Size each optics pane to its picture.
 * The full frame fills the pane: no crop and no empty band inside the card.
 */

export function frameAspect(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (w > 0 && h > 0) return w / h;
  return 16 / 9;
}

export function fitCameraPanes({ frames, areaWidth, areaHeight, gap = 4 } = {}) {
  const list = Array.isArray(frames) ? frames.filter((frame) => frame && frame.hidden !== true) : [];
  const count = list.length;
  const width = Number(areaWidth);
  if (!count || !(width > 0)) return [];
  const aspects = list.map((frame) => frameAspect(frame.width, frame.height));
  const sum = aspects.reduce((total, aspect) => total + aspect, 0);
  const gaps = gap * Math.max(0, count - 1);
  let height = (width - gaps) / sum;
  const cap = Number(areaHeight);
  if (cap > 0 && height > cap) height = cap;
  if (!(height > 0)) return [];
  return aspects.map((aspect) => ({
    width: height * aspect,
    height,
    aspect,
  }));
}

/**
 * object-fit cover inside a box. A 1280×720 frame in a 471×534 horizon
 * draws about 949×534 and cuts about 323 source pixels on each side.
 */
export function coverCrop(naturalW, naturalH, elementW, elementH) {
  const nw = Number(naturalW);
  const nh = Number(naturalH);
  const ew = Number(elementW);
  const eh = Number(elementH);
  if (!(nw > 0) || !(nh > 0) || !(ew > 0) || !(eh > 0)) {
    return { drawnW: 0, drawnH: 0, cropX: 0, cropY: 0, sourceCropX: 0, sourceCropY: 0 };
  }
  const scale = Math.max(ew / nw, eh / nh);
  const drawnW = nw * scale;
  const drawnH = nh * scale;
  const cropX = Math.max(0, (drawnW - ew) / 2);
  const cropY = Math.max(0, (drawnH - eh) / 2);
  return {
    drawnW,
    drawnH,
    cropX,
    cropY,
    sourceCropX: cropX / scale,
    sourceCropY: cropY / scale,
  };
}

/** True when object-fit contain draws the whole frame and the pane matches it. */
export function frameFillsPane(naturalW, naturalH, paneW, paneH) {
  const nw = Number(naturalW);
  const nh = Number(naturalH);
  const pw = Number(paneW);
  const ph = Number(paneH);
  if (!(nw > 0) || !(nh > 0) || !(pw > 0) || !(ph > 0)) return false;
  const scale = Math.min(pw / nw, ph / nh);
  const drawnW = nw * scale;
  const drawnH = nh * scale;
  const cropped = drawnW > pw + 1 || drawnH > ph + 1;
  const padX = pw - drawnW;
  const padY = ph - drawnH;
  return cropped !== true && padX < 4 && padY < 4;
}
