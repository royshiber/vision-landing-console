/**
 * Flight book controller. List, flight page, and wiring.
 * Plots and map live in sibling modules so app.js stays small.
 */
import { mountMap } from './flightbook-map.mjs';
import { mountPlots } from './flightbook-plots.mjs';
import { pickFrame } from './cam0-replay.mjs';

const NOT_CONFIGURED = 'אחסון הטיסות בענן לא הוגדר. הוסיפו מפתח קריאה בקובץ \u2066.env\u2069 (ראו \u2066docs/FLIGHT_LOGS.md\u2069)';
const NO_FLIGHTS = 'עדיין אין טיסות. אחרי טיסה מחשב המשימה יעלה אותה אוטומטית.';

const state = {
  status: null,
  flights: [],
  selected: null,
  bundle: null,
  events: [],
  cursor: null,
  cam0Frames: [],
  cam0FlightId: null,
  listIndex: 0,
  filters: { from: '', to: '', warnings: false, mode: '', q: '', includeGround: false },
  src: '',
  sev: '',
};
let poll = null;
let plots = null;
let map = null;
let root = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function bdi(s) {
  return `<bdi dir="ltr" class="fb-bdi">${esc(s)}</bdi>`;
}
function fmtDur(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return '—';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtNum(n, unit) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const text = Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  return `${text}${unit ? ' ' + unit : ''}`;
}
function tPlus(rel) {
  const n = Number(rel);
  if (!Number.isFinite(n)) return 'T+00:00';
  const sign = n < 0 ? '-' : '+';
  const abs = Math.floor(Math.abs(n));
  return `T${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { messageHe: 'תשובה לא תקינה' }; }
  if (!res.ok) {
    const err = new Error(data.messageHe || 'שגיאה');
    err.messageHe = data.messageHe || 'שגיאה';
    throw err;
  }
  return data;
}

function shell() {
  root.innerHTML = `
    <div class="fb-shell">
      <aside class="fb-list" aria-label="רשימת טיסות">
        <div class="fb-filters">
          <input id="fbFrom" type="date" aria-label="מתאריך" />
          <input id="fbTo" type="date" aria-label="עד תאריך" />
          <label><input id="fbWarn" type="checkbox" /> רק עם אזהרות</label>
          <select id="fbMode" aria-label="מצב טיסה"><option value="">כל המצבים</option></select>
          <input id="fbQ" type="search" placeholder="חיפוש באירועים" aria-label="חיפוש באירועים" />
          <label><input id="fbGround" type="checkbox" /> הצג סשנים קרקעיים</label>
        </div>
        <div class="fb-sync">
          <button type="button" id="fbSync">רענון</button>
          <span id="fbSyncNote"></span>
        </div>
        <div id="fbListScroll" class="fb-list-scroll" tabindex="0"></div>
      </aside>
      <div id="fbMain" class="fb-main"></div>
    </div>`;
  root.querySelector('#fbSync').addEventListener('click', () => { void refresh(true); });
  for (const [id, key, ev] of [
    ['fbFrom', 'from', 'change'],
    ['fbTo', 'to', 'change'],
    ['fbQ', 'q', 'change'],
  ]) {
    root.querySelector(`#${id}`).addEventListener(ev, (e) => {
      state.filters[key] = e.target.value;
      void loadList();
    });
  }
  root.querySelector('#fbWarn').addEventListener('change', (e) => {
    state.filters.warnings = e.target.checked;
    void loadList();
  });
  root.querySelector('#fbGround').addEventListener('change', (e) => {
    state.filters.includeGround = e.target.checked;
    void loadList();
  });
  root.querySelector('#fbMode').addEventListener('change', (e) => {
    state.filters.mode = e.target.value;
    void loadList();
  });
  const scroller = root.querySelector('#fbListScroll');
  scroller.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!state.flights.length) return;
    if (e.key === 'ArrowDown') state.listIndex = Math.min(state.flights.length - 1, state.listIndex + 1);
    if (e.key === 'ArrowUp') state.listIndex = Math.max(0, state.listIndex - 1);
    if (e.key === 'Enter') void openFlight(state.flights[state.listIndex].flight_uid);
    paintList();
  });
}

function queryString() {
  const p = new URLSearchParams();
  if (state.filters.from) p.set('from', state.filters.from);
  if (state.filters.to) p.set('to', state.filters.to);
  if (state.filters.warnings) p.set('warnings', '1');
  if (state.filters.mode) p.set('mode', state.filters.mode);
  if (state.filters.q) p.set('q', state.filters.q);
  if (state.filters.includeGround) p.set('includeGround', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

function paintNote() {
  const note = root.querySelector('#fbSyncNote');
  if (!note || !state.status) return;
  if (state.status.lastError) {
    note.className = 'fb-sync-err';
    note.textContent = state.status.messageHe || 'סנכרון נכשל';
  } else {
    note.className = '';
    note.textContent = state.status.lastSyncAt ? `סונכרן ${state.status.lastSyncAt}` : '';
  }
}

function paintList() {
  const host = root.querySelector('#fbListScroll');
  if (!state.status?.configured) {
    host.innerHTML = `<p class="fb-empty">${esc(state.status?.messageHe || NOT_CONFIGURED)}</p>`;
    return;
  }
  if (!state.flights.length) {
    host.innerHTML = `<p class="fb-empty">${esc(state.status.messageHe || NO_FLIGHTS)}</p>`;
    return;
  }
  const modes = new Set();
  for (const f of state.flights) for (const m of f.modes || []) modes.add(m);
  const sel = root.querySelector('#fbMode');
  const current = state.filters.mode;
  const opts = ['<option value="">כל המצבים</option>', ...[...modes].map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)];
  if (sel && sel.dataset.modes !== opts.join('|')) {
    sel.innerHTML = opts.join('');
    sel.value = current;
    sel.dataset.modes = opts.join('|');
  }
  host.innerHTML = state.flights.map((f, i) => `
    <button type="button" class="fb-card${f.flight_uid === state.selected ? ' is-on' : ''}" data-uid="${esc(f.flight_uid)}" data-index="${i}">
      <div class="fb-card-top">
        <h3>טיסה ${bdi(f.flightNumber)}</h3>
        <span class="fb-when">${bdi(f.armLocal || '')}</span>
      </div>
      <div class="fb-stats">
        <span>זמן באוויר ${bdi(fmtDur(f.air_time_s))}</span>
        <span>גובה מרבי ${bdi(fmtNum(f.max_rel_alt_m, 'm'))}</span>
        <span>אוויר / קרקע ${bdi(fmtNum(f.max_airspeed_mps, 'm/s'))} / ${bdi(fmtNum(f.max_groundspeed_mps, 'm/s'))}</span>
        <span>מרחק ${bdi(fmtNum(f.distance_m, 'm'))}</span>
      </div>
      <div class="fb-modes">${(f.modes || []).map((m) => `<span class="fb-chip">${bdi(m)}</span>`).join('')}</div>
      <div class="fb-card-badges">
        <span class="fb-badge" data-sev="${esc(f.worstSev)}">${f.warnings || f.errors || f.critical ? bdi(f.warnings + f.errors + f.critical) : 'בלי אזהרות'}</span>
        <span class="fb-badge" data-sev="${f.uploadLabelHe === '✓ הושלם' ? 'ok' : f.uploadLabelHe === 'פגום' ? 'critical' : 'warning'}">${esc(f.uploadLabelHe)}</span>
        <span class="fb-badge">${esc(f.debriefBadgeHe)}</span>
      </div>
    </button>`).join('');
  host.querySelectorAll('.fb-card').forEach((btn) => {
    btn.addEventListener('click', () => { void openFlight(btn.dataset.uid); });
  });
}

function phaseOf(ev) {
  const take = state.bundle?.summary?.takeoff?.t_rel_s;
  const land = state.bundle?.summary?.landing?.t_rel_s;
  if (take == null) return 'ground';
  const t = Number(ev.t_rel_s);
  if (t < take - 3) return 'before';
  if (t < take + 12) return 'takeoff';
  if (land != null && t >= land + 20) return 'after';
  if (land != null && t >= land - 3) return 'land';
  return 'air';
}

const PHASE_LABEL = {
  before: 'לפני המראה',
  takeoff: 'המראה',
  air: 'באוויר',
  land: 'נחיתה',
  after: 'אחרי',
  ground: 'סשן קרקעי',
};

function filteredEvents() {
  return state.events.filter((ev) => {
    if (state.src && ev.src !== state.src) return false;
    if (state.sev && ev.sev !== state.sev) return false;
    return true;
  });
}

const VERDICT_HE = { ok: 'תקין', attention: 'דורש תשומת לב', problem: 'בעיה' };
const NO_GEMINI_KEY_HE = 'אין מפתח Gemini. מוצגות תובנות אוטומטיות בלבד.';
let debriefSeq = 0;

function insightBlock(insights) {
  if (!insights?.length) return '<p>אין תובנות אוטומטיות לטיסה הזו.</p>';
  return insights.map((ins) => `
    <p>${esc(ins.text_he)}
      <button type="button" class="fb-cite" data-t="${esc(ins.from_rel_s)}">${bdi(tPlus(ins.from_rel_s))}</button>
    </p>`).join('');
}

function bindCites(host) {
  host.querySelectorAll('.fb-cite').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.t == null || btn.dataset.t === '') return;
      setCursor(btn.dataset.t);
    });
  });
}

function sentenceRow(row) {
  const chips = (row.chips || []).map((chip) => {
    const t = chip.t_rel_s == null ? '' : chip.t_rel_s;
    return `<button type="button" class="fb-cite" data-t="${esc(t)}">${bdi(chip.label || chip.id)}</button>`;
  }).join(' ');
  const mark = row.unverified ? '<span class="fb-unverified">⚠ לא אומת</span>' : '';
  return `<p class="fb-sentence${row.unverified ? ' is-unverified' : ''}">${esc(row.text_he)} ${chips} ${mark}</p>`;
}

function sectionBlock(title, rows) {
  const body = rows?.length ? rows.map(sentenceRow).join('') : '<p>אין נתונים</p>';
  return `<h4>${esc(title)}</h4>${body}`;
}

function paintDebrief(host, payload) {
  if (!payload?.available) {
    host.dataset.state = 'nokey';
    delete host.dataset.status;
    const insights = payload?.insights?.length ? payload.insights : (state.bundle?.summary?.insights || []);
    host.innerHTML = `
      <h3>תחקיר</h3>
      <p class="fb-debrief-status">${esc(payload?.messageHe || NO_GEMINI_KEY_HE)}</p>
      <h4>תובנות אוטומטיות</h4>
      ${insightBlock(insights)}`;
    bindCites(host);
    return;
  }
  const d = payload.debrief || {};
  host.dataset.state = 'ready';
  host.dataset.status = payload.status || '';
  const unknowns = (d.unknowns_he || []).length
    ? d.unknowns_he.map((line) => `<p>${esc(line)}</p>`).join('')
    : '<p>אין</p>';
  host.innerHTML = `
    <div class="fb-debrief-head">
      <h3>תחקיר</h3>
      <span class="fb-verdict is-${esc(d.verdict)}">${esc(VERDICT_HE[d.verdict] || d.verdict || '')}</span>
      <button type="button" class="fb-regen" id="fbRegen">צור מחדש</button>
    </div>
    ${payload.bannerHe ? `<p class="fb-banner">${esc(payload.bannerHe)}</p>` : ''}
    <p class="fb-summary">${esc(d.summary_he || '')}</p>
    ${sectionBlock('מה קרה', d.what_happened)}
    ${sectionBlock('למה', d.why)}
    ${sectionBlock('מה לעשות', d.what_to_do)}
    <h4>לא ידוע</h4>
    ${unknowns}
    <p class="fb-debrief-foot">${esc(payload.model || '')} · ${bdi(payload.created_at || '')}</p>`;
  host.querySelector('#fbRegen')?.addEventListener('click', () => { void loadDebrief(true); });
  bindCites(host);
}

async function loadDebrief(force) {
  const uid = state.bundle?.flight?.flight_uid;
  const host = root.querySelector('[data-fb="debrief"]');
  if (!uid || !host) return;
  const seq = ++debriefSeq;
  host.dataset.state = 'loading';
  const status = host.querySelector('.fb-debrief-status');
  if (status) status.textContent = 'טוען תחקיר…';
  try {
    const payload = await api(`/api/flight-logs/flights/${encodeURIComponent(uid)}/debrief`, force ? {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    } : undefined);
    if (seq !== debriefSeq || state.bundle?.flight?.flight_uid !== uid) return;
    paintDebrief(host, payload);
    if (payload.available) {
      const row = state.flights.find((f) => f.flight_uid === uid);
      if (row && row.debriefBadgeHe !== 'יש תחקיר') {
        row.debriefBadgeHe = 'יש תחקיר';
        paintList();
      }
    }
  } catch (err) {
    if (seq !== debriefSeq) return;
    host.dataset.state = 'error';
    host.innerHTML = `<h3>תחקיר</h3><p class="fb-debrief-status">${esc(err.messageHe || 'שגיאה בטעינת התחקיר')}</p>`;
  }
}

function paintFlight() {
  const main = root.querySelector('#fbMain');
  if (!state.bundle) {
    main.innerHTML = `<p class="fb-empty">${state.flights.length ? 'בחרו טיסה מהרשימה.' : ''}</p>`;
    return;
  }
  const f = state.bundle.flight;
  const insights = state.bundle.summary?.insights || [];
  const downloads = (state.bundle.artifacts || []).map((art) => {
    if (art.state === 'uploaded') {
      return `<a href="/api/flight-logs/flights/${encodeURIComponent(f.flight_uid)}/artifacts/${art.name}">${esc(art.name)}</a>`;
    }
    return `<span>${esc(art.name)} — ${esc(art.reasonHe || 'לא זמין')}</span>`;
  }).join('');
  main.innerHTML = `
    <header class="fb-kpi" data-fb="kpi">
      <div>
        <h2>טיסה ${bdi(f.flightNumber)} <span class="fb-when">${bdi(f.armLocal || '')}</span></h2>
        <div class="fb-kpi-stats">
          <span>משך ${bdi(fmtDur(f.duration_s))}</span>
          <span>באוויר ${bdi(fmtDur(f.air_time_s))}</span>
          <span>גובה ${bdi(fmtNum(f.max_rel_alt_m, 'm'))}</span>
          <span>מהירות ${bdi(fmtNum(f.max_airspeed_mps, 'm/s'))}</span>
          <span>מרחק ${bdi(fmtNum(f.distance_m, 'm'))}</span>
          <span>סיום ${esc(f.endReasonHe || '')}</span>
          <span class="fb-chip">${esc(f.timeSourceLabelHe || '')}</span>
        </div>
      </div>
      <div class="fb-dl">${downloads}</div>
      <label>שם מקומי <input id="fbLabel" value="${esc(f.user_label || '')}" maxlength="80" /></label>
    </header>
    <section class="fb-debrief" data-fb="debrief" data-state="loading">
      <h3>תחקיר</h3>
      <p class="fb-debrief-status">טוען תחקיר…</p>
      <h4>תובנות אוטומטיות</h4>
      ${insightBlock(insights)}
    </section>
    <div class="fb-split">
      <section class="fb-timeline" data-fb="timeline">
        <div class="fb-phase-filters" id="fbFilters"></div>
        <div class="fb-timeline-scroll" id="fbTimeline"></div>
      </section>
      <div class="fb-map" data-fb="map" id="fbMapHost"></div>
    </div>
    <section class="fb-cam0" data-fb="cam0">
      <h3>מצלמה אפס</h3>
      <p id="fbCam0Status" class="fb-cam0-status">אין אות</p>
      <div class="fb-cam0-stage">
        <img id="fbCam0Frame" alt="" hidden />
        <canvas id="fbCam0Overlay" hidden></canvas>
      </div>
    </section>
    <div id="fbPlots"></div>
    <section class="fb-artifacts" data-fb="artifacts">
      <h3>קבצים</h3>
      <ul>${(state.bundle.artifacts || []).map((art) => `<li>${esc(art.name)} — ${esc(art.state)}${art.reasonHe ? ' · ' + esc(art.reasonHe) : ''}</li>`).join('')}</ul>
    </section>`;
  main.querySelector('#fbLabel').addEventListener('change', async (e) => {
    await api(`/api/flight-logs/flights/${encodeURIComponent(f.flight_uid)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_label: e.target.value }),
    });
    await loadList();
  });
  paintTimeline();
  plots?.destroy();
  map?.destroy();
  plots = mountPlots(main.querySelector('#fbPlots'), {
    series: state.bundle.series,
    modes: state.bundle.summary?.modes || [],
    events: state.events,
    onCursor: (t) => setCursor(t),
  });
  map = mountMap(main.querySelector('#fbMapHost'), state.bundle.track);
  if (state.cursor != null) setCursor(state.cursor, { scroll: false });
  void loadCam0(f);
  const debriefHost = main.querySelector('[data-fb="debrief"]');
  if (debriefHost) bindCites(debriefHost);
  void loadDebrief(false);
}

function paintTimeline() {
  const bar = root.querySelector('#fbFilters');
  const host = root.querySelector('#fbTimeline');
  if (!bar || !host) return;
  const srcs = [...new Set(state.events.map((e) => e.src).filter(Boolean))];
  const sevs = ['', 'warning', 'error', 'critical'];
  const srcLabel = { fc: 'בקר', flight: 'טיסה', companion: 'מחשב משימה', link: 'קישור', vision: 'ראייה', console: 'קונסולה', system: 'מערכת' };
  bar.innerHTML = [
    `<button type="button" data-src="" class="${state.src ? '' : 'is-on'}">הכל</button>`,
    ...srcs.map((s) => `<button type="button" data-src="${esc(s)}" class="${state.src === s ? 'is-on' : ''}">${esc(srcLabel[s] || s)}</button>`),
    ...sevs.filter(Boolean).map((s) => `<button type="button" data-sev="${esc(s)}" class="${state.sev === s ? 'is-on' : ''}">${esc(s)}</button>`),
  ].join('');
  bar.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.sev) state.sev = state.sev === btn.dataset.sev ? '' : btn.dataset.sev;
      else state.src = btn.dataset.src || '';
      paintTimeline();
    });
  });
  const groups = new Map();
  for (const ev of filteredEvents()) {
    const key = phaseOf(ev);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const byId = new Map(state.events.map((e) => [e.id, e]));
  const order = ['before', 'takeoff', 'air', 'land', 'after', 'ground'];
  host.innerHTML = order.filter((k) => groups.has(k)).map((k) => `
    <h4 class="fb-phase">${PHASE_LABEL[k]}</h4>
    ${groups.get(k).map((ev) => {
      const cause = ev.cause_id ? byId.get(ev.cause_id) : null;
      return `<button type="button" class="fb-event${String(state.cursor) === String(ev.t_rel_s) ? ' is-on' : ''}" data-t="${esc(ev.t_rel_s)}" data-sev="${esc(ev.sev)}">
        ${bdi(ev.tLocal || '')} ${bdi(ev.tPlus || tPlus(ev.t_rel_s))} ${esc(ev.msg_he || ev.msg || '')}
        ${cause ? `<span>סיבה: ${esc(cause.msg_he || cause.msg || ev.cause_id)}</span>` : ''}
      </button>`;
    }).join('')}
  `).join('');
  host.querySelectorAll('.fb-event').forEach((btn) => {
    btn.addEventListener('click', () => setCursor(btn.dataset.t));
  });
}

function paintCam0At(t) {
  const status = root.querySelector('#fbCam0Status');
  const img = root.querySelector('#fbCam0Frame');
  const canvas = root.querySelector('#fbCam0Overlay');
  const row = pickFrame(state.cam0Frames, t) || (t == null ? state.cam0Frames[0] : null);
  if (!status || !img) return;
  if (!state.cam0FlightId || !row) {
    status.textContent = 'אין אות';
    img.hidden = true;
    img.removeAttribute('src');
    if (canvas) canvas.hidden = true;
    return;
  }
  status.textContent = '';
  img.hidden = false;
  img.src = `/api/jetson/v1/cam0/recordings/${encodeURIComponent(state.cam0FlightId)}/frame.jpg?i=${encodeURIComponent(row.i)}`;
  if (!canvas) return;
  img.onload = () => {
    const dets = row.detections || [];
    canvas.hidden = dets.length === 0;
    if (!dets.length) return;
    const rect = img.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext('2d');
    if (!ctx || !img.naturalWidth) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#fbbf24';
    ctx.fillStyle = '#fbbf24';
    const dx = canvas.width / img.naturalWidth;
    const dy = canvas.height / img.naturalHeight;
    for (const det of dets) {
      const pts = (det.corners || []).map((p) => [p[0] * dx, p[1] * dy]);
      if (pts.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      ctx.stroke();
    }
  };
}

async function loadCam0(flight) {
  state.cam0Frames = [];
  state.cam0FlightId = null;
  paintCam0At(state.cursor);
  try {
    const res = await fetch('/api/jetson/v1/cam0/recordings');
    if (!res.ok) return;
    const body = await res.json();
    const data = body?.data && body.lane === 'NEW' ? body.data : body;
    const rows = data?.recordings || [];
    if (!rows.length) return;
    const arm = Date.parse(flight?.arm_utc || flight?.times?.arm_utc || '') || null;
    let chosen = rows[rows.length - 1];
    if (arm) {
      const hit = rows.find((row) => String(row.flight_id || '').includes(String(flight.flight_id || '')));
      if (hit) chosen = hit;
    }
    const metaRes = await fetch(`/api/jetson/v1/cam0/recordings/${encodeURIComponent(chosen.flight_id)}`);
    if (!metaRes.ok) return;
    const metaBody = await metaRes.json();
    const meta = metaBody?.data && metaBody.lane === 'NEW' ? metaBody.data : metaBody;
    state.cam0Frames = meta.frames || [];
    state.cam0FlightId = chosen.flight_id;
    paintCam0At(state.cursor);
  } catch {
    state.cam0Frames = [];
    state.cam0FlightId = null;
    paintCam0At(state.cursor);
  }
}

function setCursor(t, { scroll = true } = {}) {
  state.cursor = t;
  plots?.setCursor(t);
  map?.setCursor(t);
  paintCam0At(t);
  root.querySelectorAll('.fb-event').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.t === String(t));
  });
  if (scroll) {
    const on = root.querySelector('.fb-event.is-on');
    on?.scrollIntoView({ block: 'nearest' });
  }
}

async function loadList() {
  const data = await api(`/api/flight-logs/flights${queryString()}`);
  state.flights = data.flights || [];
  if (state.status) state.status.messageHe = data.messageHe || state.status.messageHe;
  if (!state.flights.some((f) => f.flight_uid === state.selected)) {
    state.selected = null;
    state.bundle = null;
  }
  paintList();
  paintFlight();
}

async function openFlight(uid) {
  state.selected = uid;
  state.listIndex = Math.max(0, state.flights.findIndex((f) => f.flight_uid === uid));
  const [bundle, events, series, track] = await Promise.all([
    api(`/api/flight-logs/flights/${encodeURIComponent(uid)}`),
    api(`/api/flight-logs/flights/${encodeURIComponent(uid)}/events`),
    api(`/api/flight-logs/flights/${encodeURIComponent(uid)}/series`),
    api(`/api/flight-logs/flights/${encodeURIComponent(uid)}/track`),
  ]);
  state.bundle = bundle;
  state.bundle.series = series.missing ? null : series;
  state.bundle.track = track.missing ? null : track.track;
  state.events = events.events || [];
  state.cursor = null;
  paintList();
  paintFlight();
}

async function refresh(manual) {
  state.status = await api('/api/flight-logs/status');
  if (!state.status.configured) {
    state.flights = [];
    state.bundle = null;
    paintNote();
    paintList();
    paintFlight();
    return;
  }
  if (manual || !state.status.lastSyncAt) {
    state.status = await api('/api/flight-logs/sync', { method: 'POST' });
  }
  paintNote();
  await loadList();
}

function onSubtab(tab) {
  if (tab !== 'flightbook') {
    if (poll) { clearInterval(poll); poll = null; }
    return;
  }
  if (!root) return;
  void refresh(true);
  if (!poll) poll = setInterval(() => { void refresh(true); }, 60000);
}

function boot() {
  root = document.getElementById('debriefFlightbookPanel');
  if (!root) return;
  shell();
  document.addEventListener('airvix:debrief-subtab', (ev) => onSubtab(ev.detail?.tab));
  const active = document.querySelector('[data-debrief-tab].active')?.dataset.debriefTab;
  if (active === 'flightbook') onSubtab('flightbook');
}

boot();
