/**
 * One companion JPEG pull per camera.
 * A newer pull aborts the older one. The older bytes cannot become the frame.
 * A browser request is given the newest finished frame without waiting on a late pull.
 */

export function framePullIsLate(ageMs, lastGoodMs) {
  const age = Number(ageMs);
  const good = Number(lastGoodMs);
  if (!(good > 0) || !(age > 0)) return false;
  return age > Math.max(400, good * 2);
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export function createLatestFrameShelf({ pull, now = () => Date.now(), waitMs = 1000 } = {}) {
  let seq = 0;
  let latest = null;
  let inflight = null;
  let failure = null;
  let failureSeq = 0;
  let lastFetchMs = 0;
  let hotUntil = 0;
  let hotQueued = false;
  let updates = [];
  const hotGapMs = 16;

  function notify() {
    const pending = updates;
    updates = [];
    for (const fn of pending) fn();
  }

  function changed() {
    return new Promise((resolve) => {
      updates.push(resolve);
    });
  }

  async function execute(mine, controller, startedAt) {
    let stored = false;
    try {
      const packet = await pull({ signal: controller.signal, seq: mine });
      if (mine !== seq) return;
      const bytes = packet?.bytes;
      if (!bytes || bytes.length === 0) return;
      const readyAt = now();
      const fetchMs = Math.max(0, readyAt - startedAt);
      lastFetchMs = fetchMs;
      const capturedAt = Number.isFinite(packet.capturedAt) ? packet.capturedAt : startedAt;
      const encodeMs = Number.isFinite(packet.encodeMs) ? packet.encodeMs : 0;
      const sourceSeq = Number(packet.frameSeq);
      latest = {
        seq: mine,
        sourceSeq: sourceSeq > 0 ? sourceSeq : 0,
        bytes,
        contentType: packet.contentType || 'image/jpeg',
        capturedAt,
        encodeMs,
        fetchStarted: startedAt,
        fetchMs,
        readyAt,
        tracks: packet.tracks && typeof packet.tracks === 'object' ? packet.tracks : null,
      };
      failure = null;
      stored = true;
    } catch (err) {
      if (err?.name === 'AbortError' || mine !== seq) return;
      failure = err;
      failureSeq = mine;
    } finally {
      if (inflight?.seq === mine) inflight = null;
      if (stored && now() < hotUntil) scheduleHot();
      notify();
    }
  }

  function scheduleHot() {
    if (hotQueued || inflight) return;
    if (now() >= hotUntil) return;
    hotQueued = true;
    const sinceReady = latest ? now() - latest.readyAt : hotGapMs;
    const gap = Math.max(0, hotGapMs - sinceReady);
    setTimeout(() => {
      hotQueued = false;
      if (now() < hotUntil && !inflight) begin();
    }, gap);
  }

  function begin() {
    const controller = new AbortController();
    const mine = ++seq;
    const prev = inflight;
    const startedAt = now();
    inflight = { seq: mine, controller, startedAt };
    prev?.controller.abort();
    const job = execute(mine, controller, startedAt);
    inflight.job = job;
    return inflight;
  }

  function ensure() {
    if (inflight) return inflight;
    return begin();
  }

  function unstick() {
    if (!inflight) return false;
    const age = now() - inflight.startedAt;
    if (!framePullIsLate(age, lastFetchMs)) return false;
    begin();
    return true;
  }

  async function take({ since = 0, signal, waitMs: limit = waitMs, fresh = false } = {}) {
    hotUntil = now() + 1000;
    if (signal?.aborted) throw abortError();
    const started = fresh ? begin() : (unstick() ? inflight : ensure());
    const wanted = fresh ? started.seq - 1 : (Number(since) || 0);
    const deadline = now() + limit;
    const onAbort = () => notify();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        if (signal?.aborted) throw abortError();
        if (!fresh) unstick();
        if (latest && latest.seq > wanted) return latest;
        if (!inflight) {
          if (!latest && failure && failureSeq === seq) throw failure;
          return latest;
        }
        if (latest && now() >= deadline) return latest;
        const left = Math.max(1, deadline - now());
        await Promise.race([
          changed(),
          new Promise((resolve) => setTimeout(resolve, left)),
        ]);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    begin,
    ensure,
    unstick,
    take,
    current() { return latest; },
    inflight() { return inflight; },
    lastFetchMs() { return lastFetchMs; },
  };
}
