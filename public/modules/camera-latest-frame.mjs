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
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw missError();
    return { src, objectUrl: URL.createObjectURL(blob), seq: Number.isFinite(seq) ? seq : 0 };
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

  function assignImage(loaded) {
    if (typeof image !== 'function' || !loaded?.objectUrl) return;
    const img = image();
    if (!img) return;
    const prev = img.dataset.objectUrl;
    img.dataset.liveFrame = loaded.src || '';
    img.dataset.objectUrl = loaded.objectUrl;
    const seq = Number(loaded.seq);
    if (seq > 0) img.dataset.frameSeq = String(seq);
    else delete img.dataset.frameSeq;
    if (prev && prev !== loaded.objectUrl) {
      try { URL.revokeObjectURL(prev); } catch { /* already revoked */ }
    }
    img.src = loaded.objectUrl;
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
      assignImage(loaded);
      const shown = typeof image === 'function' ? image() : null;
      const ownsShown = Boolean(shown && loaded?.objectUrl && shown.dataset.objectUrl === loaded.objectUrl);
      if (ownsShown && typeof shown.decode === 'function') {
        try { await shown.decode(); } catch { /* the element still shows the bytes it has */ }
      }
      if (stopped) return;
      const stillShown = !loaded?.objectUrl
        || (typeof image === 'function' && image()?.dataset.objectUrl === loaded.objectUrl);
      if (!stillShown) return;
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
