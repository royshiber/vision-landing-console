import { describe, it, expect } from "vitest";
import {
  loadCompanionOpenApi,
  listContractGetPaths,
  listContractWriteMethods,
  getContractExample,
  validateCompanionResponse,
  readContractField,
} from "../lib/companion-contract.mjs";
import { COMPANION_GET_PATHS, COMPANION_WRITE_METHODS } from "../lib/companion-v1-paths.mjs";
import { mapCompanionStatus, COMPANION_STATES } from "../lib/companion-status.mjs";
import { CompanionApiError } from "../lib/companion-api-error.mjs";

describe("companion OpenAPI contract snapshot", () => {
  it("loads OpenAPI 3.1 from the vendored Jetson snapshot", () => {
    const spec = loadCompanionOpenApi();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info["x-canonical-source"]).toContain("architecture/openapi/companion-api-v1.yaml");
  });

  it("keeps console path lists identical to the OpenAPI paths", () => {
    expect(listContractGetPaths().sort()).toEqual([...COMPANION_GET_PATHS].sort());
    expect(listContractWriteMethods()).toEqual(COMPANION_WRITE_METHODS);
  });

  it("accepts every GET 200 example against the schema", () => {
    for (const p of listContractGetPaths()) {
      if (p === "/api/v1/ws") continue;
      const example = getContractExample(p, p === "/api/v1/status" ? "healthy" : undefined);
      expect(example, p).toBeTruthy();
      expect(() => validateCompanionResponse("GET", p, example)).not.toThrow();
    }
  });

  it("maps the healthy status example with contract field names", () => {
    const raw = getContractExample("/api/v1/status", "healthy");
    validateCompanionResponse("GET", "/api/v1/status", raw);
    const mapped = mapCompanionStatus(raw);
    expect(mapped.state).toBe(COMPANION_STATES.OK);
    expect(mapped.system.cpu_temp_c).toBe(48.5);
    expect(mapped.vision.latency_ms).toBe(42);
    expect(mapped.vision.pad_visible).toBe(true);
    expect(mapped.fc.voltage_v).toBe(16.4);
  });

  it("keeps missing values null in the missing_numerics example", () => {
    const raw = getContractExample("/api/v1/status", "missing_numerics");
    validateCompanionResponse("GET", "/api/v1/status", raw);
    const mapped = mapCompanionStatus(raw);
    expect(mapped.vision.fps).toBeNull();
    expect(mapped.vision.latency_ms).toBeNull();
    expect(mapped.system.cpu_temp_c).toBeNull();
    expect(mapped.fc.voltage_v).toBeNull();
    expect(mapped.navigation.quality).toBeNull();
  });

  it("keeps STALE explicit from the stale example", () => {
    const raw = getContractExample("/api/v1/status", "stale");
    validateCompanionResponse("GET", "/api/v1/status", raw);
    const mapped = mapCompanionStatus(raw);
    expect(mapped.state).toBe(COMPANION_STATES.STALE);
    expect(mapped.connected).toBe(true);
    expect(mapped.vision.fps).toBeNull();
  });

  it("rejects invalid response types cleanly", () => {
    expect(() => validateCompanionResponse("GET", "/api/v1/health", { ok: "yes" })).toThrow(CompanionApiError);
    expect(() => validateCompanionResponse("GET", "/api/v1/health", [])).toThrow(CompanionApiError);
    try {
      validateCompanionResponse("GET", "/api/v1/health", null);
    } catch (e) {
      expect(e.kind).toBe("schema");
    }
  });

  it("rejects invalid wire state enums", () => {
    expect(() =>
      validateCompanionResponse("GET", "/api/v1/status", { state: "TOTALLY_FAKE" }),
    ).toThrow(CompanionApiError);
  });

  it("prefers contract names over transitional aliases", () => {
    const mixed = { cpu_temp_c: 10, cpuTempC: 99 };
    expect(readContractField(mixed, "cpu_temp_c").value).toBe(10);
    expect(readContractField(mixed, "cpu_temp_c").alias).toBeNull();
    expect(readContractField({ cpuTempC: 99 }, "cpu_temp_c").alias).toBe("cpuTempC");
  });
});
