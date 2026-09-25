/** SVG plots: shared cursor, drag-zoom, mode bands, event ticks. No invented series. */

const COLORS = ['#38bdf8', '#fbbf24', '#4ade80', '#f472b6'];
const PLOTS = [
  { id: 'alt', title: 'גובה', keys: ['alt_rel_m'], labels: ['גובה'] },
  { id: 'spd', title: 'מהירות', keys: ['airspeed_mps', 'groundspeed_mps'], labels: ['אוויר', 'קרקע'] },
  { id: 'thr', title: 'מצערת', keys: ['throttle_pct'], labels: ['מצערת'] },
  { id: 'att', title: 'זוויות', keys: ['roll_deg', 'pitch_deg'], labels: ['רול', 'פיץ׳'] },
  { id: 'bat', title: 'סוללה', keys: ['batt_v', 'batt_a'], labels: ['מתח', 'זרם'] },
  { id: 'gps', title: 'GPS', keys: ['gps_sats', 'gps_hdop'], labels: ['לוויינים', 'HDOP'] },
];

function decimateMinMax(t, v, maxPoints) {
  const n = Math.min(t?.length || 0, v?.length || 0);
  const cap = Math.max(2, maxPoints);
  if (n <= cap) return { t: (t || []).slice(0, n), v: (v || []).slice(0, n) };
  const buckets = Math.max(1, Math.floor(cap / 2));
  const outT = [];
  const outV = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);
    let minI = start;
    let maxI = start;
    for (let i = start; i < end; i++) {
      const val = Number(v[i]);
      if (!Number.isFinite(val)) continue;
      if (!Number.isFinite(Number(v[minI])) || val < Number(v[minI])) minI = i;
      if (!Number.isFinite(Number(v[maxI])) || val > Number(v[maxI])) maxI = i;
    }
    const order = minI <= maxI ? [minI, maxI] : [maxI, minI];
    for (const i of order) {
      if (outT.length && outT[outT.length - 1] === t[i]) continue;
      outT.push(t[i]);
      outV.push(v[i]);
    }
  }
  return { t: outT, v: outV };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountPlots(host, { series, modes, events, onCursor }) {
  const bag = series?.series || {};
  let view = null;
  let cursor = null;
  host.innerHTML = '';
  host.id = 'fbPlotStack';
  host.className = 'fb-plots';
  const nodes = [];

  for (const plot of PLOTS) {
    const section = document.createElement('section');
    section.className = 'fb-plot';
    section.dataset.fbPlot = plot.id;
    const present = plot.keys.filter((k) => bag[k] && Array.isArray(bag[k].t) && bag[k].t.length);
    section.innerHTML = `<h3>${esc(plot.title)}</h3>`;
    if (!present.length) {
      const empty = document.createElement('div');
      empty.className = 'fb-plot-empty';
      empty.textContent = 'אין נתונים';
      section.appendChild(empty);
      host.appendChild(section);
      nodes.push({ plot, section, present: [] });
      continue;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1000 160');
    svg.setAttribute('preserveAspectRatio', 'none');
    section.appendChild(svg);
    const hover = document.createElement('div');
    hover.className = 'fb-hover';
    hover.hidden = true;
    section.appendChild(hover);
    host.appendChild(section);
    nodes.push({ plot, section, svg, hover, present });
  }

  function domain() {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const node of nodes) {
      for (const key of node.present) {
        const ts = bag[key].t;
        if (ts.length) {
          t0 = Math.min(t0, ts[0]);
          t1 = Math.max(t1, ts[ts.length - 1]);
        }
      }
    }
    if (!Number.isFinite(t0)) return [0, 1];
    return view || [t0, t1];
  }

  function draw() {
    const [t0, t1] = domain();
    const span = Math.max(0.001, t1 - t0);
    host.dataset.fbCursor = cursor == null ? '' : String(cursor);
    for (const node of nodes) {
      if (!node.svg) continue;
      const svg = node.svg;
      svg.replaceChildren();
      const bands = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      for (const band of modes || []) {
        const x1 = ((band.from_rel_s - t0) / span) * 1000;
        const x2 = ((band.to_rel_s - t0) / span) * 1000;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(Math.max(0, x1)));
        rect.setAttribute('width', String(Math.max(0, Math.min(1000, x2) - Math.max(0, x1))));
        rect.setAttribute('y', '0');
        rect.setAttribute('height', '160');
        rect.setAttribute('fill', band.mode === 'RTL' ? '#f59e0b' : band.mode === 'AUTO' ? '#4ade80' : '#38bdf8');
        rect.setAttribute('opacity', '0.12');
        bands.appendChild(rect);
      }
      svg.appendChild(bands);
      node.present.forEach((key, idx) => {
        const dec = decimateMinMax(bag[key].t, bag[key].v, 900);
        const vals = dec.v.map(Number).filter(Number.isFinite);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const h = Math.max(0.001, max - min);
        const pts = [];
        for (let i = 0; i < dec.t.length; i++) {
          const x = ((dec.t[i] - t0) / span) * 1000;
          const y = 150 - ((Number(dec.v[i]) - min) / h) * 140;
          if (Number.isFinite(x) && Number.isFinite(y)) pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', COLORS[idx % COLORS.length]);
        poly.setAttribute('stroke-width', '2');
        poly.setAttribute('points', pts.join(' '));
        svg.appendChild(poly);
      });
      for (const ev of events || []) {
        if (!ev || !['warning', 'error', 'critical'].includes(ev.sev)) continue;
        const x = ((ev.t_rel_s - t0) / span) * 1000;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(x));
        line.setAttribute('x2', String(x));
        line.setAttribute('y1', '0');
        line.setAttribute('y2', '160');
        line.setAttribute('stroke', ev.sev === 'warning' ? '#f59e0b' : '#f43f5e');
        line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
      }
      if (cursor != null) {
        const x = ((cursor - t0) / span) * 1000;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(x));
        line.setAttribute('x2', String(x));
        line.setAttribute('y1', '0');
        line.setAttribute('y2', '160');
        line.setAttribute('stroke', '#fff');
        line.setAttribute('stroke-width', '1.5');
        line.dataset.cursor = '1';
        svg.appendChild(line);
      }
    }
  }

  function nearestValue(key, t) {
    const s = bag[key];
    if (!s) return null;
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < s.t.length; i++) {
      const d = Math.abs(s.t[i] - t);
      if (d < dist) { dist = d; best = i; }
    }
    return s.v[best];
  }

  function bind(node) {
    if (!node.svg) return;
    let drag = null;
    const svg = node.svg;
    const tAt = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = Math.min(Math.max(0, ev.clientX - rect.left), rect.width || 1);
      const [t0, t1] = domain();
      return t0 + (x / (rect.width || 1)) * (t1 - t0);
    };
    svg.addEventListener('pointerdown', (ev) => {
      drag = { x: ev.clientX, t: tAt(ev) };
    });
    svg.addEventListener('pointerup', (ev) => {
      if (!drag) return;
      const t2 = tAt(ev);
      if (Math.abs(ev.clientX - drag.x) > 12 && Math.abs(t2 - drag.t) > 1) {
        view = [Math.min(drag.t, t2), Math.max(drag.t, t2)];
        draw();
      }
      drag = null;
    });
    svg.addEventListener('dblclick', () => {
      view = null;
      draw();
    });
    svg.addEventListener('mousemove', (ev) => {
      const t = tAt(ev);
      const bits = node.present.map((key, i) => {
        const v = nearestValue(key, t);
        return `${node.plot.labels[i]} ${v}`;
      });
      node.hover.hidden = false;
      node.hover.textContent = bits.join(' · ');
    });
    svg.addEventListener('mouseleave', () => { node.hover.hidden = true; });
  }

  nodes.forEach(bind);
  draw();
  return {
    setCursor(t) {
      cursor = t == null || t === '' ? null : Number(t);
      draw();
    },
    destroy() { host.innerHTML = ''; },
  };
}
