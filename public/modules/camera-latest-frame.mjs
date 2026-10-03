/**
 * Console-side JPEG pump. One request is in flight.
 * A slower answer from an older request is dropped.
 * The next request starts when the current one arrives.
 * A miss does not invent a frame and does not start another request by itself.
 */

export function frameArrivalIsCurrent(arrivedGen, currentGen) {
  const arrived = Number(arrivedGen);
  const current = Number(currentGen);
  return Number.isFinite(arrived) && arrived > 0 && arrived === current;
}

export function createLatestJpegPump({ urlFor, onFrame, onMiss } = {}) {
  let gen = 0;
  let busy = false;
  let stopped = true;
  let startedAt = 0;
  const state = { streaming: false };

  function kick() {
    if (stopped || typeof urlFor !== 'function') return;
    if (busy) {
      if (Date.now() - startedAt < 180) return;
      gen += 1;
      busy = false;
    }
    const mine = gen + 1;
    gen = mine;
    busy = true;
    startedAt = Date.now();
    const probe = new Image();
    const src = urlFor(mine);
    probe.onload = () => {
      const current = mine === gen;
      if (current) busy = false;
      if (stopped || !frameArrivalIsCurrent(mine, gen)) return;
      if (typeof onFrame === 'function') onFrame(src);
    };
    probe.onerror = () => {
      const current = mine === gen;
      if (current) busy = false;
      if (stopped || !frameArrivalIsCurrent(mine, gen)) return;
      if (typeof onMiss === 'function') onMiss();
    };
    probe.src = src;
  }

  return {
    state,
    start() {
      stopped = false;
      kick();
    },
    kick,
    stop() {
      stopped = true;
      gen += 1;
      busy = false;
    },
  };
}
