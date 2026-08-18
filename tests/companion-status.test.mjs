import { describe, it, expect } from "vitest";
import {
  COMPANION_STATES,
  mapCompanionHealth,
  mapCompanionStatus,
  toSseTelemetryOverlay,
  mergeTelemetryWithCompanion,
} from "../lib/companion-status.mjs";
import { CompanionApiError } from "../lib/companion-api-error.mjs";
import { getContractExample } from "../lib/companion-contract.mjs";

describe("companion-status", () => {
  it("keeps missing numerics as null never 0", () => {
    const mapped = mapCompanionStatus({
      ok: true,
      connected: true,
      vision: { pad_visible: true },
      fc: { connected: true, mode: "STABILIZE" },
    });
    expect(mapped.vision.fps).toBeNull();
    expect(mapped.vision.latency_ms).toBeNull();
    expect(mapped.fc.voltage_v).toBeNull();
    expect(mapped.system.cpu_temp_c).toBeNull();
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
        vision: { fps: 30, latency_ms: 40 },
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

  it("maps contract state enum and transitional flags", () => {
    expect(mapCompanionStatus({ state: "WAITING_FOR_HARDWARE" }).state).toBe(
      COMPANION_STATES.WAITING_FOR_HARDWARE,
    );
    expect(mapCompanionStatus({ state: "STALE" }).state).toBe(COMPANION_STATES.STALE);
    expect(mapCompanionStatus({ disabled: true }).state).toBe(COMPANION_STATES.DISABLED);
  });

  it("reads transitional camelCase aliases", () => {
    const mapped = mapCompanionStatus({
      ok: true,
      connected: true,
      appVersion: "legacy",
      vision: { latencyMs: 9, padVisible: true },
      system: { cpuTempC: 33 },
    });
    expect(mapped.version).toBe("legacy");
    expect(mapped.vision.latency_ms).toBe(9);
    expect(mapped.vision.pad_visible).toBe(true);
    expect(mapped.system.cpu_temp_c).toBe(33);
  });

  it("rejects non-object status payloads", () => {
    expect(() => mapCompanionStatus([])).toThrow(CompanionApiError);
    expect(() => mapCompanionStatus("nope")).toThrow(CompanionApiError);
  });

  it("maps the contract missing_numerics example without inventing zeros", () => {
    const mapped = mapCompanionStatus(getContractExample("/api/v1/status", "missing_numerics"));
    expect(mapped.vision.fps).toBeNull();
    expect(mapped.fc.voltage_v).toBeNull();
    expect(mapped.system.gpu_temp_c).toBeNull();
    expect(mapped.connected).toBe(true);
  });
});
