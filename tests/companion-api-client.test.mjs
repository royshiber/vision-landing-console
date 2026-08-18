import { describe, it, expect, vi } from "vitest";
import { createCompanionApiClient, CompanionApiError } from "../lib/companion-api-client.mjs";
import { getContractExample } from "../lib/companion-contract.mjs";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("CompanionApiClient", () => {
  it("throws config when JETSON_COMPANION_BASE_URL is missing", async () => {
    const client = createCompanionApiClient({ baseUrl: "", fetch: vi.fn() });
    await expect(client.getHealth()).rejects.toMatchObject({ kind: "config" });
  });

  it("calls Companion /api/v1 on JETSON_COMPANION_BASE_URL and never heartbeat :8081", async () => {
    const urls = [];
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example:9090",
      fetch: async (url) => {
        urls.push(String(url));
        return jsonRes({ ok: true });
      },
    });
    await client.getHealth();
    expect(urls[0]).toBe("http://companion.example:9090/api/v1/health");
    expect(urls[0]).not.toMatch(/:8081/);
    expect(urls[0]).not.toMatch(/100\.82\.59\.45/);
  });

  it("sends Authorization Bearer when COMPANION_SHARED_SECRET is set", async () => {
    let headers;
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      sharedSecret: "s3cret",
      fetch: async (_url, init) => {
        headers = init.headers;
        return jsonRes({ version: "1.0.0", api: "v1" });
      },
    });
    await client.getVersion();
    expect(headers.Authorization).toBe("Bearer s3cret");
  });

  it("maps abort to timeout", async () => {
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    });
    await expect(client.getStatus()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps fetch failure to connection", async () => {
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.getDiagnostics()).rejects.toMatchObject({ kind: "connection" });
  });

  it("maps non-OK HTTP to http with status", async () => {
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      fetch: async () => jsonRes({ error: "nope" }, 503),
    });
    await expect(client.getConfig()).rejects.toMatchObject({ kind: "http", status: 503 });
  });

  it("maps invalid JSON to parse", async () => {
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => "<html>nope</html>",
      }),
    });
    await expect(client.getPolicy()).rejects.toBeInstanceOf(CompanionApiError);
    await expect(client.getPolicy()).rejects.toMatchObject({ kind: "parse" });
  });

  it("PATCH /api/v1/config/runtime sends JSON body", async () => {
    let init;
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      fetch: async (url, opts) => {
        init = { url: String(url), ...opts };
        return jsonRes({ ok: true });
      },
    });
    await client.patchRuntimeConfig({ fps: 15 });
    expect(init.url).toBe("http://companion.example/api/v1/config/runtime");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ fps: 15 });
  });

  it("rejects responses that violate the OpenAPI schema", async () => {
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      fetch: async () => jsonRes({ ok: "yes" }),
    });
    await expect(client.getHealth()).rejects.toMatchObject({ kind: "schema" });
  });

  it("accepts the contract health example", async () => {
    const client = createCompanionApiClient({
      baseUrl: "http://companion.example",
      fetch: async () => jsonRes(getContractExample("/api/v1/health")),
    });
    await expect(client.getHealth()).resolves.toMatchObject({ ok: true, status: "ok" });
  });
});
