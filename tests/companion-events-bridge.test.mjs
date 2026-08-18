import { describe, it, expect } from "vitest";
import { createCompanionEventsBridge } from "../lib/companion-events-bridge.mjs";
import { createCompanionMock } from "../lib/companion-mock.mjs";
import { COMPANION_STATES } from "../lib/companion-status.mjs";

describe("companion-events-bridge", () => {
  it("mode off yields DISABLED overlay", async () => {
    const bridge = createCompanionEventsBridge({
      mode: "off",
      getClient: () => createCompanionMock(),
    });
    const overlay = await bridge.refresh();
    expect(overlay.companion.state).toBe(COMPANION_STATES.DISABLED);
    expect(overlay.companion.connected).toBe(false);
  });

  it("mock healthy overlay sets companion connected", async () => {
    const mock = createCompanionMock({ scenario: "healthy" });
    const bridge = createCompanionEventsBridge({
      getMode: () => "mock",
      getClient: () => mock,
    });
    const overlay = await bridge.refresh();
    expect(overlay.companion.connected).toBe(true);
    expect(overlay.companion.state).toBe(COMPANION_STATES.OK);
    expect(overlay.vision.fps).toBe(30);
  });

  it("unreachable client maps to DISCONNECTED", async () => {
    const mock = createCompanionMock({ scenario: "disconnected" });
    const bridge = createCompanionEventsBridge({
      getMode: () => "mock",
      getClient: () => mock,
    });
    const overlay = await bridge.refresh();
    expect(overlay.companion.state).toBe(COMPANION_STATES.DISCONNECTED);
    expect(overlay.companion.connected).toBe(false);
    expect(bridge.getLastError()?.kind).toBe("connection");
  });

  it("start polls then stop clears timer", async () => {
    const mock = createCompanionMock();
    const bridge = createCompanionEventsBridge({
      getMode: () => "mock",
      getClient: () => mock,
      pollMs: 50,
    });
    await bridge.start();
    expect(bridge.getLastOverlay()?.companion?.connected).toBe(true);
    bridge.stop();
    const after = bridge.getLastOverlay();
    expect(after.companion.state).toBe(COMPANION_STATES.OK);
  });
});
