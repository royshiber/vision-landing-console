/**
 * Shared SITL Lab → topbar #connectWidget handoff.
 * Presets never open a second MAVLink client; they drive the global connect path.
 */

export const SITL_CONNECT_PRESETS = Object.freeze({
  udp14550: Object.freeze({ type: 'udp', hostPort: '127.0.0.1:14550' }),
  udpBind: Object.freeze({ type: 'udp', hostPort: '0.0.0.0:14550' }),
  tcp5760: Object.freeze({ type: 'tcp', hostPort: '127.0.0.1:5760' }),
});

export function getConnectWidgetApi(globalObj = globalThis) {
  const api = globalObj?.__vlcConnectWidget;
  if (!api || typeof api.applySitlPreset !== 'function') return null;
  return api;
}

export function handoffSitlConnect(api, { type, hostPort, connect = true } = {}) {
  const t = String(type || '').toLowerCase();
  const hp = String(hostPort || '').trim();
  if ((t !== 'udp' && t !== 'tcp') || !hp) {
    return { ok: false, reason: 'invalid-preset' };
  }
  if (!api || typeof api.applySitlPreset !== 'function') {
    return { ok: false, reason: 'missing-connect-widget' };
  }
  api.applySitlPreset({ type: t, hostPort: hp });
  if (connect && typeof api.connectNow === 'function') api.connectNow();
  return { ok: true, type: t, hostPort: hp };
}

/** Same global fields + #connectBtn. Not a second TCP/UDP client. */
export function fallbackFillGlobalConnectFields({
  typeSel,
  portInput,
  connectBtn,
  type,
  hostPort,
  connect = true,
} = {}) {
  const t = String(type || '').toLowerCase();
  const hp = String(hostPort || '').trim();
  if (typeSel) {
    typeSel.value = t;
    typeSel.dispatchEvent(new Event('change'));
  }
  if (portInput) portInput.value = hp;
  if (connect && connectBtn && connectBtn.dataset?.connected !== '1') {
    connectBtn.click();
  }
  return { ok: true, via: 'connectBtn', type: t, hostPort: hp };
}
