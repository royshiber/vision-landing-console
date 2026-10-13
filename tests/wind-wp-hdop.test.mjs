import { describe, expect, it } from 'vitest';
import { parseNavControllerOutput, parseWind } from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

describe('wind and waypoint distance', () => {
  it('reads WIND.speed and NAV_CONTROLLER_OUTPUT.wp_dist into the HUD snapshot', () => {
    const wind = Buffer.alloc(20);
    wind.writeFloatLE(90, 8);
    wind.writeFloatLE(4.5, 12);
    wind.writeFloatLE(0.2, 16);
    expect(parseWind(wind)?.speed).toBe(4.5);

    const nav = Buffer.alloc(32);
    nav.writeFloatLE(120.25, 28);
    expect(parseNavControllerOutput(nav)?.wpDist).toBe(120.3);

    const snap = buildSseMavlinkSnapshot({
      connected: true,
      lastWind: { speed: 4.5 },
      lastNavController: { wpDist: 120.3 },
    });
    expect(snap.windSpeed).toBe(4.5);
    expect(snap.wpDistM).toBe(120.3);
  });
});
