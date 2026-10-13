import { describe, expect, it } from 'vitest';
import { parseNavControllerOutput, parseWind } from '../lib/mavlink-connection.mjs';
import { buildSseMavlinkSnapshot } from '../lib/sse-mavlink-snapshot.mjs';

describe('wind and waypoint distance', () => {
  it('reads WIND.speed and NAV_CONTROLLER_OUTPUT.wp_dist into the HUD snapshot', () => {
    const wind = Buffer.alloc(8);
    wind.writeFloatLE(90, 0);
    wind.writeFloatLE(4.5, 4);
    expect(parseWind(wind)?.speed).toBe(4.5);

    const short = Buffer.alloc(4);
    short.writeFloatLE(180, 0);
    expect(parseWind(short)?.speed).toBe(0);

    const nav = Buffer.alloc(26);
    nav.writeUInt16LE(120, 24);
    expect(parseNavControllerOutput(nav)?.wpDist).toBe(120);

    const snap = buildSseMavlinkSnapshot({
      connected: true,
      lastWind: { speed: 4.5 },
      lastNavController: { wpDist: 120 },
    });
    expect(snap.windSpeed).toBe(4.5);
    expect(snap.wpDistM).toBe(120);
  });
});
