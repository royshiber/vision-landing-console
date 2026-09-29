/** One compact row per completed cloud log. Extras stay in the DOM behind עוד. */
export const GCS_LOG_LIST_CAP = 1;

export function formatLogBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))} KB`;
  const mb = v / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export function formatLogTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi}`;
}

function ltr(doc, className, text) {
  const el = doc.createElement('bdi');
  el.dir = 'ltr';
  el.className = className;
  el.textContent = text;
  return el;
}

function completedItems(items) {
  return (items || [])
    .filter((item) => item && item.state === 'complete' && item.key)
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      || String(a.name || a.key).localeCompare(String(b.name || b.key)));
}

export function renderGcsCompletedList(doc, host, items, { cap = GCS_LOG_LIST_CAP } = {}) {
  host.replaceChildren();
  host.classList.remove('is-open');
  const complete = completedItems(items);
  const rows = [];
  for (let i = 0; i < complete.length; i += 1) {
    const item = complete[i];
    const name = item.name || item.key;
    const row = doc.createElement('div');
    row.className = 'gcs-log-row';
    row.dataset.key = item.key;
    if (i >= cap) row.hidden = true;
    const nameEl = doc.createElement('span');
    nameEl.className = 'gcs-log-name';
    nameEl.textContent = name;
    const stateEl = doc.createElement('span');
    stateEl.className = 'gcs-log-state';
    stateEl.textContent = item.messageHe || '';
    const link = doc.createElement('a');
    link.href = `/api/gcs-logs/download?key=${encodeURIComponent(item.key)}`;
    link.textContent = 'הורידו';
    link.setAttribute('aria-label', `הורידו ${name}`);
    const bytes = item.size ?? item.bytesTotal;
    row.append(
      nameEl,
      ltr(doc, 'gcs-log-size', formatLogBytes(bytes)),
      ltr(doc, 'gcs-log-time', formatLogTime(item.updatedAt)),
      stateEl,
      link,
    );
    host.append(row);
    rows.push(row);
  }
  if (complete.length > cap) {
    const more = doc.createElement('button');
    more.type = 'button';
    more.className = 'gcs-log-more';
    const extra = complete.length - cap;
    const paintMore = (open) => {
      more.replaceChildren();
      more.append(doc.createTextNode(open ? 'סגרו' : 'עוד '));
      if (!open) {
        const n = doc.createElement('bdi');
        n.dir = 'ltr';
        n.textContent = String(extra);
        more.append(n);
      }
    };
    paintMore(false);
    more.addEventListener('click', () => {
      const open = !host.classList.contains('is-open');
      host.classList.toggle('is-open', open);
      for (let i = cap; i < rows.length; i += 1) rows[i].hidden = !open;
      paintMore(open);
    });
    host.append(more);
  }
  return complete.length;
}
