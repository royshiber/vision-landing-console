const statusEl = document.getElementById('gcsLogStatus');
const listEl = document.getElementById('gcsLogList');
const uploadBtn = document.getElementById('gcsLogUploadBtn');
const resumeBtn = document.getElementById('gcsLogResumeBtn');
const refreshBtn = document.getElementById('gcsLogRefreshBtn');

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
  const active = (data.items || []).find((item) => item.state === 'uploading' || item.state === 'interrupted');
  setStatus(data.messageHe || '');
  if (statusEl && active && Number.isFinite(active.percent)) {
    const pct = document.createElement('bdi');
    pct.dir = 'ltr';
    pct.textContent = ` ${active.percent}%`;
    statusEl.append(pct);
  }
  const on = data.enabled === true && data.configured === true;
  if (uploadBtn) uploadBtn.disabled = !on;
  if (resumeBtn) resumeBtn.disabled = !on || !active || active.state !== 'interrupted';
  if (!listEl) return;
  listEl.replaceChildren();
  for (const item of data.items || []) {
    const row = document.createElement('div');
    row.className = 'gcs-log-item';
    const name = document.createElement('span');
    name.textContent = item.name || 'לוג';
    const state = document.createElement('span');
    state.textContent = item.messageHe || '';
    row.append(name, state);
    if (item.key && data.enabled && data.configured) {
      const link = document.createElement('a');
      link.href = `/api/gcs-logs/download?key=${encodeURIComponent(item.key)}`;
      link.textContent = 'הורדה';
      row.append(link);
    }
    listEl.append(row);
  }
}

async function refresh() {
  try {
    paint(await readJson('/api/gcs-logs'));
  } catch {
    setStatus('אין תשובה מהשרת.');
  }
}

async function sessionId() {
  const data = await readJson('/api/telemetry-archive/sessions');
  const sessions = data.sessions || [];
  const ready = sessions.find((s) => s.downloadable && !s.open && !s.empty);
  return ready?.id || null;
}

uploadBtn?.addEventListener('click', async () => {
  const id = await sessionId();
  if (!id) {
    setStatus('אין לוגים להעלאה.');
    return;
  }
  try {
    paint(await readJson('/api/gcs-logs/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
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

if (statusEl) {
  refresh();
  setInterval(refresh, 4000);
}
