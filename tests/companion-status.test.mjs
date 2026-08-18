import { describe, it, expect } from "vitest";
import {
  COMPANION_STATES,
  mapCompanionHealth,
  mapCompanionStatus,
  toSseTelemetryOverlay,
  mergeTelemetryWithCompanion,
} from "../lib/companion-status.mjs";

describe("companion-status", () => {
  it("keeps missing numerics as null never 0", () => {
    const mapped = mapCompanionStatus({
      ok: true,
      connected: true,
      vision: { padVisible: true },
      fc: { connected: true, mode: "STABILIZE" },
    });
    expect(mapped.vision.fps).toBeNull();
    expect(mapped.vision.latencyMs).toBeNull();
    expect(mapped.fc.voltageV).toBeNull();
    expect(mapped.system.cpuTempC).toBeNull();
    expect(mapped.navigation.quality).toBeNull();
  });

  it("maps healthy payload to OK", () => {
    expect(mapCompanionHealth({ ok: true }).state).toBe(COMPANION_STATES.OK);
  });

  it("maps health ok:false to DEGRADED", () => {
    expect(mapCompanionHealth({ ok: false }).state).toBe(COMPANION_STATES.DEGRADED);
  });

  it("maps empty status to DISCONNECTED", () => {
    expect(mapCompanionStatus(null).state).toBe(COMPANION_STATES.DISCONNECTED);
    expect(mapCompanionStatus({}).connected).toBe(false);
  });

  it("SSE overlay marks jetson/vision/slam as compatibility fields", () => {
    const overlay = toSseTelemetryOverlay(
      mapCompanionStatus({
        ok: true,
        connected: true,
        version: "1.2.3",
        vision: { fps: 30, latencyMs: 40 },
        navigation: { quality: 0.5, tracking: true },
      }),
    );
    expect(overlay.companion.connected).toBe(true);
    expect(overlay.jetson.reachable).toBe(true);
    expect(overlay.vision.fps).toBe(30);
    expect(overlay.slam.quality).toBe(0.5);
  });

  it("mergeTelemetryWithCompanion preserves mavlink and merges jetson", () => {
    const base = {
      appVersion: "1.0",
      mavlink: { connected: true, armed: false },
      jetson: { online: true, tempC: 41 },
    };
    const overlay = toSseTelemetryOverlay(mapCompanionStatus({ ok: true, connected: true, version: "c1" }));
    const merged = mergeTelemetryWithCompanion(base, overlay);
    expect(merged.mavlink).toEqual(base.mavlink);
    expect(merged.jetson.online).toBe(true);
    expect(merged.jetson.tempC).toBe(41);
    expect(merged.jetson.reachable).toBe(true);
    expect(merged.companion.version).toBe("c1");
  });

  it("maps DISABLED WAITING_FOR_HARDWARE and STALE", () => {
    expect(mapCompanionStatus({ disabled: true }).state).toBe(COMPANION_STATES.DISABLED);
    expect(mapCompanionStatus({ waitingForHardware: true }).state).toBe(COMPANION_STATES.WAITING_FOR_HARDWARE);
    expect(mapCompanionStatus({ stale: true }).state).toBe(COMPANION_STATES.STALE);
  });
});
