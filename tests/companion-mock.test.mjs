import { describe, it, expect } from "vitest";
import { createCompanionMock } from "../lib/companion-mock.mjs";
import { createCompanionApiClient } from "../lib/companion-api-client.mjs";
import { COMPANION_GET_PATHS } from "../lib/companion-v1-paths.mjs";

describe("companion-mock", () => {
  it("healthy getStatus returns connected payload", async () => {
    const mock = createCompanionMock({ scenario: "healthy" });
    const st = await mock.getStatus();
    expect(st.connected).toBe(true);
    expect(st.vision.fps).toBe(30);
  });

  it("disconnected throws connection", async () => {
    const mock = createCompanionMock({ scenario: "disconnected" });
    await expect(mock.getHealth()).rejects.toMatchObject({ kind: "connection" });
  });

  it("degraded health returns ok false", async () => {
    const mock = createCompanionMock({ scenario: "degraded" });
    const h = await mock.getHealth();
    expect(h.ok).toBe(false);
  });

  it("exposes the same method names as CompanionApiClient", () => {
    const mock = createCompanionMock();
    const client = createCompanionApiClient({ baseUrl: "http://x", fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
    const names = [
      "getHealth",
      "getVersion",
      "getStatus",
      "getVisionResult",
      "getNavigationEstimate",
      "getDiagnostics",
      "getConfig",
      "getPolicy",
      "patchRuntimeConfig",
      "putPolicy",
    ];
    for (const n of names) {
      expect(typeof mock[n]).toBe("function");
      expect(typeof client[n]).toBe("function");
    }
    expect(mock.listGetPaths()).toEqual([...COMPANION_GET_PATHS]);
  });

  it("patchRuntimeConfig persists into getConfig", async () => {
    const mock = createCompanionMock();
    await mock.patchRuntimeConfig({ fps: 12 });
    const cfg = await mock.getConfig();
    expect(cfg.runtime.fps).toBe(12);
  });
});
