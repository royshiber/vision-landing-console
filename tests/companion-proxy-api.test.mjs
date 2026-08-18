import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { registerCompanionProxyApi } from "../lib/routes/companion-proxy-api.mjs";
import { createCompanionService } from "../lib/companion-service.mjs";

const servers = [];

async function listenApp(svc) {
  const app = express();
  app.use(express.json());
  registerCompanionProxyApi(app, { companionService: svc });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    await new Promise((r) => s.close(r));
  }
});

describe("companion-proxy-api", () => {
  it("returns 404 companion_forbidden for ARM", async () => {
    const svc = createCompanionService({ env: { COMPANION_MODE: "mock" } });
    const base = await listenApp(svc);
    const r = await fetch(`${base}/api/jetson/v1/arm`);
    const body = await r.json();
    expect(r.status).toBe(404);
    expect(body.error).toBe("companion_forbidden");
  });

  it("returns 404 companion_forbidden for LAND but allows status/landing", async () => {
    const svc = createCompanionService({ env: { COMPANION_MODE: "mock" } });
    const base = await listenApp(svc);
    const land = await fetch(`${base}/api/jetson/v1/land`);
    expect(land.status).toBe(404);
    expect((await land.json()).error).toBe("companion_forbidden");
    const landing = await fetch(`${base}/api/jetson/v1/status/landing`);
    expect(landing.status).toBe(200);
    const payload = await landing.json();
    expect(payload.phase).toBe("idle");
  });

  it("returns 503 companion_disabled when mode is off", async () => {
    const svc = createCompanionService({ env: { COMPANION_MODE: "off" } });
    const base = await listenApp(svc);
    const r = await fetch(`${base}/api/jetson/v1/health`);
    const body = await r.json();
    expect(r.status).toBe(503);
    expect(body.error).toBe("companion_disabled");
  });

  it("GET health via mock mode", async () => {
    const svc = createCompanionService({ env: { COMPANION_MODE: "mock" } });
    const base = await listenApp(svc);
    const r = await fetch(`${base}/api/jetson/v1/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  it("unknown GET path returns 404 companion_unknown_path", async () => {
    const svc = createCompanionService({ env: { COMPANION_MODE: "mock" } });
    const base = await listenApp(svc);
    const r = await fetch(`${base}/api/jetson/v1/not-a-real-endpoint`);
    const body = await r.json();
    expect(r.status).toBe(404);
    expect(body.error).toBe("companion_unknown_path");
  });

  it("PATCH runtime config in mock mode", async () => {
    const svc = createCompanionService({ env: { COMPANION_MODE: "mock" } });
    const base = await listenApp(svc);
    const r = await fetch(`${base}/api/jetson/v1/config/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gain: 2 }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.runtime.gain).toBe(2);
  });
});
