/**
 * Lightweight tab/module event helper — always pair init with destroy to avoid listener leaks
 * when swapping panels or re-running setup (see modularisation plan G1.4).
 */

/**
 * @returns {{
 *   on: (type: string, fn: (ev: CustomEvent) => void) => void,
 *   once: (type: string, fn: (ev: CustomEvent) => void) => void,
 *   emit: (type: string, detail?: unknown) => void,
 *   destroy: () => void,
 * }}
 */
export function createEventBus() {
  const target = new EventTarget();
  /** @type {Array<{ type: string, fn: EventListener, opts?: AddEventListenerOptions }>} */
  const registry = [];

  function on(type, fn, opts) {
    const wrapped = /** @type {EventListener} */ (fn);
    target.addEventListener(type, wrapped, opts);
    registry.push({ type, fn: wrapped, opts });
  }

  return {
    on(type, fn) {
      on(type, fn);
    },
    once(type, fn) {
      on(type, fn, { once: true });
    },
    emit(type, detail = undefined) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    },
    destroy() {
      for (const { type, fn } of registry) {
        target.removeEventListener(type, fn);
      }
      registry.length = 0;
    },
  };
}
