/** Leaflet track. If Leaflet is missing, say so — never a fake track. */

const MODE_COLOR = {
  FBWA: '#38bdf8',
  AUTO: '#4ade80',
  RTL: '#f59e0b',
  MANUAL: '#94a3b8',
  LOITER: '#c084fc',
};

export function mountMap(el, track) {
  el.innerHTML = '';
  el.id = 'fbMap';
  if (!window.L || !track || !Array.isArray(track.features)) {
    el.innerHTML = `<p class="fb-map-missing">${!window.L ? 'המפה לא זמינה' : 'אין נתוני מסלול'}</p>`;
    el.dataset.fbMapSel = '';
    return { setCursor() {}, destroy() {} };
  }
  const map = window.L.map(el, { zoomControl: true });
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  const bounds = [];
  const samples = [];
  for (const feature of track.features) {
    const geom = feature.geometry || {};
    if (geom.type === 'LineString') {
      const latlngs = geom.coordinates.map(([lon, lat]) => [lat, lon]);
      window.L.polyline(latlngs, {
        color: MODE_COLOR[feature.properties?.mode] || '#e2e8f0',
        weight: 4,
      }).addTo(map);
      const from = Number(feature.properties?.from_rel_s || 0);
      const to = Number(feature.properties?.to_rel_s || from);
      geom.coordinates.forEach((coord, i) => {
        const t = geom.coordinates.length < 2 ? from : from + ((to - from) * i) / (geom.coordinates.length - 1);
        samples.push({ t, lat: coord[1], lon: coord[0] });
        bounds.push([coord[1], coord[0]]);
      });
    } else if (geom.type === 'Point') {
      const [lon, lat] = geom.coordinates;
      const kind = feature.properties?.kind;
      const color = kind === 'warning' ? '#f43f5e' : kind === 'takeoff' ? '#22c55e' : kind === 'landing' ? '#38bdf8' : '#e2e8f0';
      window.L.circleMarker([lat, lon], { radius: 6, color, fillColor: color, fillOpacity: 0.95 }).addTo(map);
      bounds.push([lat, lon]);
    }
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [18, 18] });
  const marker = window.L.circleMarker(bounds[0] || [0, 0], {
    radius: 8,
    color: '#fff',
    weight: 2,
    fillColor: '#f43f5e',
    fillOpacity: 1,
  }).addTo(map);
  function nearest(t) {
    let best = samples[0];
    let dist = Infinity;
    for (const sample of samples) {
      const d = Math.abs(sample.t - t);
      if (d < dist) { dist = d; best = sample; }
    }
    return best;
  }
  setTimeout(() => map.invalidateSize(), 60);
  return {
    setCursor(t) {
      el.dataset.fbMapSel = t == null || t === '' ? '' : String(t);
      if (!samples.length || t == null || t === '') return;
      const point = nearest(Number(t));
      marker.setLatLng([point.lat, point.lon]);
    },
    destroy() {
      try { map.remove(); } catch { /* ignore */ }
    },
  };
}
