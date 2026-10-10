/**
 * One JPEG request. A newer kick aborts the one in flight.
 * The aborted response is not painted and does not stay open.
 * The next request starts when this one finishes, without a second fetch of the same bytes.
 */

export function frameArrivalIsCurrent(arrivedGen, currentGen) {
  const arrived = Number(arrivedGen);
  const current = Number(currentGen);
  return Number.isFinite(arrived) && arrived > 0 && arrived === current;
}

export function framePullIsLate(ageMs, lastGoodMs) {
  const age = Number(ageMs);
  const good = Number(lastGoodMs);
  if (!(good > 0) || !(age > 0)) return false;
  return age > Math.max(400, good * 2);
}

function missError() {
  const err = new Error('miss');
  err.name = 'MissError';
  return err;
}

function browserLoad(src, signal) {
  return fetch(src, {
    signal,
    cache: 'no-store',
    headers: { Accept: 'image/jpeg' },
  }).then(async (res) => {
    const type = String(res.headers.get('content-type') || '');
    if (!res.ok || type.includes('json')) throw missError();
    const seq = Number(res.headers.get('x-airvix-frame-seq') || 0);
    const capturedAt = Number(res.headers.get('x-airvix-capture-at') || 0);
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw missError();
    const tracks = decodeFrameTracks(res.headers.get('x-airvix-tracks'));
    return {
      src,
      objectUrl: URL.createObjectURL(blob),
      seq: Number.isFinite(seq) ? seq : 0,
      capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
      ...(tracks ? { tracks } : {}),
    };
  });
}

function decodeFrameTracks(value) {
  const raw = String(value || '').trim();
  if (!raw || typeof atob !== 'function' || typeof TextDecoder !== 'function') return null;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tracksBelongToFrame(payload, seq, capturedAt) {
  const tagged = Number(payload?.frame_seq);
  const shown = Number(seq);
  if (tagged > 0 && shown > 0 && tagged === shown) return true;
  const stamp = Number(payload?.captured_at);
  const at = Number(capturedAt);
  if (!(stamp > 0) || !(at > 0)) return false;
  return Math.abs(stamp - at) <= 80;
}

function decodeObjectUrl(objectUrl) {
  return new Promise((resolve) => {
    if (typeof Image !== 'function') {
      resolve(true);
      return;
    }
    const probe = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok === true);
    };
    probe.onload = () => finish(true);
    probe.onerror = () => finish(false);
    probe.src = objectUrl;
    if (typeof probe.decode === 'function') {
      probe.decode().then(() => finish(true)).catch(() => finish(false));
    }
  });
}

export function createLatestJpegPump({
  urlFor,
  onFrame,
  onMiss,
  image,
  follow,
  load,
} = {}) {
  let gen = 0;
  let lastSeq = 0;
  let stopped = true;
  let controller = null;
  let startedAt = 0;
  let lastGoodMs = 0;
  let followTimer = null;
  const state = { streaming: false };

  function clearFollow() {
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
  }

  function schedule(seq) {
    if (stopped) return;
    if (typeof follow === 'function' && follow() !== true) return;
    clearFollow();
    const advanced = Number(seq) > lastSeq;
    if (advanced) lastSeq = Number(seq);
    const delay = advanced ? 0 : 50;
    followTimer = setTimeout(() => {
      followTimer = null;
      if (!stopped) kick();
    }, delay);
  }

  async function tracksForFrame(loaded, src, signal) {
    const seq = Number(loaded?.seq) || 0;
    const capturedAt = Number(loaded?.capturedAt) || 0;
    if (tracksBelongToFrame(loaded?.tracks, seq, capturedAt)) return loaded.tracks;
    const root = typeof globalThis !== 'undefined' ? globalThis : null;
    const waitFn = root?.__vlcWaitFrameTracks || root?.window?.__vlcWaitFrameTracks;
    if (!(seq > 0) || typeof waitFn !== 'function' || signal?.aborted) return null;
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(waitFn({ seq, capturedAt, src })).catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 80);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function presentDecoded(loaded) {
    if (!loaded?.objectUrl) return true;
    const img = typeof image === 'function' ? image() : null;
    if (!img) {
      try { URL.revokeObjectURL(loaded.objectUrl); } catch { /* already revoked */ }
      return false;
    }
    const decoded = await decodeObjectUrl(loaded.objectUrl);
    if (!decoded || stopped) {
      try { URL.revokeObjectURL(loaded.objectUrl); } catch { /* already revoked */ }
      return false;
    }
    const current = typeof image === 'function' ? image() : null;
    if (!current) {
      try { URL.revokeObjectURL(loaded.objectUrl); } catch { /* already revoked */ }
      return false;
    }
    const prev = current.dataset.objectUrl || '';
    const wasShown = current.hidden !== true && Number(current.naturalWidth) > 0;
    current.dataset.liveFrame = loaded.src || '';
    current.dataset.objectUrl = loaded.objectUrl;
    const seq = Number(loaded.seq);
    if (seq > 0) current.dataset.frameSeq = String(seq);
    else delete current.dataset.frameSeq;
    const capturedAt = Number(loaded.capturedAt);
    if (capturedAt > 0) current.dataset.capturedAt = String(capturedAt);
    else delete current.dataset.capturedAt;
    if (wasShown) current.hidden = false;
    current.src = loaded.objectUrl;
    if (typeof current.decode === 'function') {
      try { await current.decode(); } catch { /* the probe already decoded these bytes */ }
    }
    if (Number(current.naturalWidth) > 0) current.hidden = false;
    current.dataset.decoded = seq > 0 ? String(seq) : '1';
    if (prev && prev !== loaded.objectUrl) {
      try { URL.revokeObjectURL(prev); } catch { /* already revoked */ }
    }
    return true;
  }

  function publishTracks(loaded) {
    const img = typeof image === 'function' ? image() : null;
    if (!img || typeof img.dispatchEvent !== 'function' || !loaded?.tracks) return;
    img.dispatchEvent(new CustomEvent('vlc-frame-tracks', {
      bubbles: true,
      detail: {
        seq: Number(loaded.seq) || 0,
        capturedAt: Number(loaded.capturedAt) || 0,
        src: loaded.src || '',
        tracks: loaded.tracks,
      },
    }));
  }

  async function kick(opts = {}) {
    if (stopped || typeof urlFor !== 'function') return;
    const age = startedAt ? Date.now() - startedAt : 0;
    const late = Boolean(controller) && framePullIsLate(age, lastGoodMs);
    const force = opts.force === true || late;
    if (controller && !force) return;
    clearFollow();
    controller?.abort();
    const mine = ++gen;
    const ac = new AbortController();
    controller = ac;
    startedAt = Date.now();
    const src = urlFor(mine, lastSeq, { replace: force });
    const loader = typeof load === 'function' ? load : browserLoad;
    try {
      const loaded = await loader(src, ac.signal);
      if (stopped || mine !== gen) {
        if (loaded?.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
        return;
      }
      if (controller === ac) controller = null;
      lastGoodMs = Math.max(0, Date.now() - startedAt);
      const seq = Number(loaded?.seq) || 0;
      if (seq > 0 && seq === lastSeq) {
        if (loaded?.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
        schedule(seq);
        return;
      }
      const tracks = await tracksForFrame(loaded, src, ac.signal);
      if (stopped || mine !== gen) {
        if (loaded?.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
        return;
      }
      if (tracks) loaded.tracks = tracks;
      const painted = await presentDecoded(loaded);
      if (stopped || mine !== gen) return;
      if (!painted) {
        schedule(seq);
        return;
      }
      const stillShown = !loaded?.objectUrl
        || (typeof image === 'function' && image()?.dataset.objectUrl === loaded.objectUrl);
      if (!stillShown) return;
      publishTracks(loaded);
      if (typeof onFrame === 'function') onFrame(loaded?.src || src, loaded || { seq });
      if (mine === gen) schedule(seq);
    } catch (err) {
      if (err?.name === 'AbortError' || stopped || mine !== gen) return;
      if (controller === ac) controller = null;
      if (typeof onMiss === 'function') onMiss();
    }
  }

  return {
    state,
    start() {
      stopped = false;
      kick();
    },
    kick,
    replace() {
      stopped = false;
      return kick({ force: true });
    },
    stop() {
      stopped = true;
      clearFollow();
      controller?.abort();
      controller = null;
      gen += 1;
    },
  };
}

if (typeof window !== 'undefined') window.__vlcCreateLatestJpegPump = createLatestJpegPump;
