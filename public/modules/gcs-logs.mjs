import { renderGcsCompletedList } from './gcs-log-rows.mjs';

const card = document.getElementById('gcsLogCard');
const statusEl = document.getElementById('gcsLogStatus');
const listEl = document.getElementById('gcsLogList');
const uploadBtn = document.getElementById('gcsLogUploadBtn');
const resumeBtn = document.getElementById('gcsLogResumeBtn');
const refreshBtn = document.getElementById('gcsLogRefreshBtn');

let pollTimer = null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || '';
}

async function readJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return data;
}

function paint(data) {
  if (!data) return;
  if (card) card.hidden = data.enabled !== true;
  const active = (data.items || []).find((item) => item.state === 'uploading' || item.state === 'interrupted');
  setStatus(data.messageHe || '');
  if (statusEl && active && Number.isFinite(active.percent)) {
    const pct = document.createElement('bdi');
    pct.dir = 'ltr';
    pct.textContent = ` ${active.percent}%`;
    statusEl.append(pct);
  }
  const on = data.enabled === true && data.configured === true;
  const pending = Number(data.pendingCount) || 0;
  if (uploadBtn) uploadBtn.disabled = !on || pending === 0;
  if (resumeBtn) resumeBtn.disabled = !on || !active || active.state !== 'interrupted';
  if (!listEl) return;
  renderGcsCompletedList(document, listEl, data.items || []);
}

async function refresh() {
  try {
    const data = await readJson('/api/gcs-logs');
    paint(data);
    if (data.enabled !== true && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch {
    setStatus('אין תשובה מהשרת.');
  }
}

uploadBtn?.addEventListener('click', async () => {
  const data = await readJson('/api/gcs-logs');
  const ids = data.pendingSessionIds || [];
  if (!ids.length) {
    setStatus('אין לוגים להעלאה.');
    return;
  }
  try {
    paint(await readJson('/api/gcs-logs/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: ids }),
    }));
  } catch {
    setStatus('ההעלאה נכשלה.');
  }
});

resumeBtn?.addEventListener('click', async () => {
  const data = await readJson('/api/gcs-logs');
  const job = (data.items || []).find((item) => item.state === 'interrupted');
  if (!job?.id) {
    setStatus('אין העלאה להמשך.');
    return;
  }
  try {
    paint(await readJson('/api/gcs-logs/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id }),
    }));
  } catch {
    setStatus('ההעלאה נכשלה.');
  }
});

refreshBtn?.addEventListener('click', refresh);

if (card) {
  card.hidden = true;
  refresh();
  pollTimer = setInterval(refresh, 4000);
}
