/** Stop the live link poll and the telemetry stream from painting over an injected HUD. */
export async function pauseLiveHud(page) {
  await page.evaluate(() => {
    if (window.__vlcQaPollPause) return;
    window.__vlcQaPollPause = {
      hydrate: window.hydrateMissionHudFromLiveLink,
      sse: window.applySseTelemetryPayload,
    };
    window.hydrateMissionHudFromLiveLink = function qaPausedHydrate() {};
    window.applySseTelemetryPayload = function qaPausedSse() {};
  });
}

export async function resumeLiveHud(page) {
  await page.evaluate(() => {
    const prev = window.__vlcQaPollPause;
    if (!prev) return;
    if (typeof prev.hydrate === 'function') window.hydrateMissionHudFromLiveLink = prev.hydrate;
    if (typeof prev.sse === 'function') window.applySseTelemetryPayload = prev.sse;
    delete window.__vlcQaPollPause;
  });
}
