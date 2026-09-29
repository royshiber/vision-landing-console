const card = document.getElementById('followTargetCard');
const statusEl = document.getElementById('followTargetStatus');
const mapBtn = document.getElementById('followTargetMapBtn');
const detectBtn = document.getElementById('followTargetDetectBtn');
const stopBtn = document.getElementById('followTargetStopBtn');

let lastDetection = null;
let picking = false;

function setStatus(text, short) {
  if (!statusEl) return;
  statusEl.title = text || '';
  statusEl.textContent = short || text || '';
}

async function readJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

const SHORT_STATE = {
  off: 'כבוי',
  idle: 'מוכן',
  rejected: 'נדחה',
  tracking: 'עוקב',
  rtl: 'הביתה',
  cancelled: 'בוטל',
};

function paint(data) {
  if (!data) return;
  const full = data.messageHe || '';
  if (statusEl) {
    statusEl.textContent = SHORT_STATE[data.state] || 'כבוי';
    statusEl.title = full;
  }
  if (card) card.title = full;
  const on = data.enabled === true;
  if (mapBtn) mapBtn.disabled = !on;
  if (detectBtn) detectBtn.disabled = !on;
  if (stopBtn) stopBtn.disabled = !on || data.active !== true;
}

async function refresh() {
  try {
    const { data } = await readJson('/api/follow-target/status');
    if (data.trackedDetection) lastDetection = data.trackedDetection;
    paint(data);
  } catch {
    setStatus('אין תשובה מהשרת.', 'שגיאה');
  }
}

async function postTarget(body) {
  picking = false;
  if (card) card.dataset.picking = '0';
  try {
    const { data } = await readJson('/api/follow-target/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    paint(data);
  } catch {
    setStatus('אין תשובה מהשרת.', 'שגיאה');
  }
}

mapBtn?.addEventListener('click', () => {
  picking = !picking;
  if (card) card.dataset.picking = picking ? '1' : '0';
  setStatus(picking ? 'הקליקו על המפה לבחירת מטרה.' : 'הבחירה במפה בוטלה.', picking ? 'מפה' : 'כבוי');
});

detectBtn?.addEventListener('click', () => {
  if (!lastDetection) {
    setStatus('אין זיהוי במעקב.', 'אין זיהוי');
    return;
  }
  postTarget({
    lat: lastDetection.lat,
    lon: lastDetection.lon,
    altM: lastDetection.altM,
    source: 'detection',
  });
});

stopBtn?.addEventListener('click', async () => {
  picking = false;
  if (card) card.dataset.picking = '0';
  try {
    const { data } = await readJson('/api/follow-target/stop', { method: 'POST' });
    paint(data);
  } catch {
    setStatus('אין תשובה מהשרת.', 'שגיאה');
  }
});

window.addEventListener('airvix-tracked-detection', (event) => {
  const detail = event?.detail || {};
  if (!Number.isFinite(detail.lat) || !Number.isFinite(detail.lon)) return;
  lastDetection = { lat: detail.lat, lon: detail.lon, altM: detail.altM };
  fetch('/api/follow-target/detection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lastDetection),
  }).catch(() => {});
});

function bindMap() {
  const map = window.__airvixTerrainMap;
  if (!map || map.__airvixFollowBound) return;
  map.__airvixFollowBound = true;
  map.on('click', (event) => {
    if (!picking || !event?.latlng) return;
    postTarget({ lat: event.latlng.lat, lon: event.latlng.lng, altM: 60, source: 'map' });
  });
}

if (card) {
  bindMap();
  setInterval(bindMap, 1000);
  refresh();
  setInterval(refresh, 2000);
}
