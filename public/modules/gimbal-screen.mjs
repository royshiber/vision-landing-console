/**
 * Large gimbal picture with an annotation layer.
 * Boxes come only from a detection list the console already has.
 * An empty or missing list leaves the layer empty. No invented boxes.
 */
import { frameMissShowsNoSignal } from './camera-frame-hold.mjs';
import { createLatestJpegPump } from './camera-latest-frame.mjs';
import { bindGimbalPadRoot } from './gimbal-pad.mjs';
import { matchVoiceFlightPhrase } from './voice-flight-phrases.mjs';

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

const DEFAULT_CORNER = 'bl';
const DEFAULT_W = 280;
const DEFAULT_H = 324;
const MIN_W = 240;
const MIN_H = 280;
const MAX_FRACTION = 0.62;
const CORNERS = new Set(['tl', 'tr', 'bl', 'br']);

export function clampGimbalWindowSize(width, height, mapWidth, mapHeight) {
  const maxW = Math.max(MIN_W, Number(mapWidth) * MAX_FRACTION);
  const maxH = Math.max(MIN_H, Number(mapHeight) * MAX_FRACTION);
  return {
    width: Math.round(Math.min(maxW, Math.max(MIN_W, Number(width) || DEFAULT_W))),
    height: Math.round(Math.min(maxH, Math.max(MIN_H, Number(height) || DEFAULT_H))),
  };
}

export function gimbalCornerFromPoint(clientX, clientY, map) {
  const left = clientX < map.left + map.width / 2;
  const top = clientY < map.top + map.height / 2;
  if (top && left) return 'tl';
  if (top) return 'tr';
  if (left) return 'bl';
  return 'br';
}

function ensureFlightMap() {
  const terrain = document.getElementById('terrain');
  if (terrain?.classList.contains('visible')) return;
  document.querySelector('.tab[data-tab="terrain"]')?.click();
}

function bindVoice(doc) {
  const form = doc.getElementById('gimbalScreenVoiceForm');
  const input = doc.getElementById('gimbalScreenVoiceInput');
  const reply = doc.getElementById('gimbalScreenVoiceReply');
  const mic = doc.getElementById('gimbalScreenMic');
  if (!form || form.dataset.bound === '1') return;
  form.dataset.bound = '1';

  function showReply(said) {
    const line = String(said || '').trim() || 'לא נשלח דבר';
    if (reply) reply.textContent = line;
    void doc.defaultView?.__vlcSpeakAnswer?.(line);
  }

  function flightRefusal(text) {
    const match = matchVoiceFlightPhrase(text);
    if (!match) return '';
    if (match.blocked || match.kind === 'ARM' || match.kind === 'DISARM') {
      return 'נדחה. חימוש ונטרול חסומים. לא נשלח דבר.';
    }
    if (match.sendable || match.kind === 'RTL' || match.kind === 'MODE_CHANGE') {
      return 'נדחה. שיחת הקול סגורה. לא נשלח דבר.';
    }
    return '';
  }

  async function submit(text) {
    const line = String(text || '').trim().replace(/\s+/g, ' ');
    if (!line) return;
    if (input) input.value = '';
    const refused = flightRefusal(line);
    if (refused) {
      showReply(refused);
      return;
    }
    try {
      const res = await fetch('/api/assist/voice-flight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line }),
      });
      const data = await res.json().catch(() => ({}));
      showReply(data?.talkback?.text);
    } catch {
      showReply('השליחה נכשלה');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(input?.value || '');
  });

  const SR = doc.defaultView?.SpeechRecognition || doc.defaultView?.webkitSpeechRecognition;
  if (!mic) return;
  if (!SR) {
    mic.disabled = true;
    mic.title = 'דיבור אינו זמין בדפדפן זה';
    return;
  }
  const rec = new SR();
  rec.lang = 'he-IL';
  rec.interimResults = false;
  rec.onresult = (event) => {
    const said = String(event.results?.[0]?.[0]?.transcript || '').trim();
    mic.classList.remove('is-live');
    mic.setAttribute('aria-pressed', 'false');
    if (said) void submit(said);
  };
  rec.onend = () => {
    mic.classList.remove('is-live');
    mic.setAttribute('aria-pressed', 'false');
  };
  rec.onerror = () => {
    mic.classList.remove('is-live');
    mic.setAttribute('aria-pressed', 'false');
    if (reply) reply.textContent = 'הדיבור נכשל';
  };
  mic.addEventListener('click', () => {
    try {
      rec.start();
      mic.classList.add('is-live');
      mic.setAttribute('aria-pressed', 'true');
    } catch {
      if (reply) reply.textContent = 'הדיבור נכשל';
    }
  });
}

function bindChrome(screen) {
  const bar = document.getElementById('gimbalScreenDrag');
  const handle = document.getElementById('gimbalScreenResize');
  if (!screen || screen.dataset.chrome === '1') return;
  screen.dataset.chrome = '1';
  if (!CORNERS.has(screen.dataset.corner)) screen.dataset.corner = DEFAULT_CORNER;
  screen.style.width = `${DEFAULT_W}px`;
  screen.style.height = `${DEFAULT_H}px`;

  function mapRect() {
    return screen.parentElement?.getBoundingClientRect() || { left: 0, top: 0, width: 800, height: 600 };
  }

  function applySize(width, height) {
    const map = mapRect();
    const next = clampGimbalWindowSize(width, height, map.width, map.height);
    screen.style.width = `${next.width}px`;
    screen.style.height = `${next.height}px`;
  }

  bar?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button, input, textarea, a')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 12) moved = true;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const corner = gimbalCornerFromPoint(ev.clientX, ev.clientY, mapRect());
      screen.dataset.corner = corner;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  handle?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = screen.offsetWidth;
    const startH = screen.offsetHeight;
    const corner = CORNERS.has(screen.dataset.corner) ? screen.dataset.corner : DEFAULT_CORNER;
    const growX = corner === 'bl' || corner === 'tl' ? 1 : -1;
    const growY = corner === 'tl' || corner === 'tr' ? 1 : -1;
    const move = (ev) => {
      applySize(startW + (ev.clientX - startX) * growX, startH + (ev.clientY - startY) * growY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function init() {
  if (typeof document === 'undefined') return;
  const screen = document.getElementById('gimbalScreen');
  const img = document.getElementById('gimbalScreenImg');
  const note = document.getElementById('gimbalScreenNote');
  const canvas = document.getElementById('gimbalScreenNotes');
  if (!screen || !img) return;
  bindGimbalPadRoot(screen);
  bindVoice(document);
  bindChrome(screen);
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
    if (open) ensureFlightMap();
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
