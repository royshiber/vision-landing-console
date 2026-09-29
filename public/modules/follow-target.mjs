const card = document.getElementById('followTargetCard');
const statusEl = document.getElementById('followTargetStatus');
const mapBtn = document.getElementById('followTargetMapBtn');
const detectBtn = document.getElementById('followTargetDetectBtn');
const stopBtn = document.getElementById('followTargetStopBtn');

let lastDetection = null;
let lastStatus = null;
let picking = false;
let holdTarget = null;
let pollTimer = null;

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
  rtl: 'RTL',
  cancelled: 'בוטל',
};

function paint(data) {
  if (!data) return;
  lastStatus = data;
  const on = data.enabled === true;
  if (card) card.hidden = !on;
  if (!on) return;
  const linked = data.linked === true;
  const full = data.messageHe || '';
  let short = SHORT_STATE[data.state] || '';
  if (data.state === 'idle' && full.includes('נעצר')) short = 'נעצר';
  if (data.state === 'idle' && !linked) short = 'אין קישור';
  if (full.includes('כבוי') && short === 'מוכן') short = 'כבוי';
  if (statusEl) {
    statusEl.textContent = short;
    statusEl.title = full || short;
  }
  if (card) card.title = full || short;
  if (mapBtn) {
    mapBtn.disabled = !linked;
    mapBtn.title = linked ? 'בחרו במפה' : (full || 'אין קישור לסימולטור.');
  }
  if (detectBtn) {
    const hasDetection = Boolean(lastDetection);
    detectBtn.disabled = !linked || !hasDetection;
    if (!linked) detectBtn.title = full || 'אין קישור לסימולטור.';
    else if (!hasDetection) detectBtn.title = 'אין זיהוי במעקב.';
    else detectBtn.title = 'עקבו אחרי זיהוי';
  }
  if (stopBtn) stopBtn.disabled = data.active !== true;
  if (data.active !== true) holdTarget = data.state === 'tracking' ? holdTarget : null;
}

async function refresh() {
  try {
    const { data } = await readJson('/api/follow-target/status');
    if (data.trackedDetection) lastDetection = data.trackedDetection;
    paint(data);
    if (data.enabled !== true && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch {
    setStatus('אין תשובה מהשרת.', 'שגיאה');
  }
}

async function postTarget(body, { remember = false } = {}) {
  picking = false;
  if (card) card.dataset.picking = '0';
  try {
    const { data } = await readJson('/api/follow-target/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (remember && data.state === 'tracking' && body.source === 'map') holdTarget = body;
    if (data.state !== 'tracking') holdTarget = null;
    paint(data);
  } catch {
    setStatus('אין תשובה מהשרת.', 'שגיאה');
  }
}

mapBtn?.addEventListener('click', () => {
  if (mapBtn.disabled) return;
  picking = !picking;
  if (card) card.dataset.picking = picking ? '1' : '0';
  setStatus(picking ? 'הקליקו על המפה לבחירת מטרה.' : 'הבחירה במפה בוטלה.', picking ? 'בחרו' : 'מוכן');
});

detectBtn?.addEventListener('click', () => {
  if (detectBtn.disabled) return;
  if (!lastDetection) return;
  holdTarget = null;
  postTarget({
    lat: lastDetection.lat,
    lon: lastDetection.lon,
    altM: lastDetection.altM,
    source: 'detection',
  });
});

stopBtn?.addEventListener('click', async () => {
  picking = false;
  holdTarget = null;
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
  if (lastStatus) paint(lastStatus);
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
    postTarget({ lat: event.latlng.lat, lon: event.latlng.lng, altM: 60, source: 'map' }, { remember: true });
  });
}

if (card) {
  card.hidden = true;
  bindMap();
  setInterval(bindMap, 1000);
  refresh();
  pollTimer = setInterval(refresh, 2000);
  setInterval(() => {
    if (!holdTarget || lastStatus?.active !== true) return;
    postTarget(holdTarget, { remember: true });
  }, 4000);
}
