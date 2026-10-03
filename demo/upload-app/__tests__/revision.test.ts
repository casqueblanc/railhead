import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const ORIGIN = "https://upload.invalid";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * The Worker with `APP_REVISION` typed as any string, as `wrangler deploy --var` sets it; the
 * generated `Env` types it as the config's literal default. Method syntax keeps the parameter
 * bivariant, so this needs no cast.
 */
const deployable: {
  fetch(
    request: Request,
    env: Omit<Env, "APP_REVISION"> & { APP_REVISION: string },
  ): Promise<Response>;
} = worker;

describe("GET /api/revision", () => {
  it("reports the revision set at deploy, readable from any origin and never cached", async () => {
    const response = await deployable.fetch(new Request(`${ORIGIN}/api/revision`), {
      ...env,
      APP_REVISION: SHA,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: SHA });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports unknown when the deploy set no revision", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/revision`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: "unknown" });
  });

  it("refuses other methods", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/revision`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("opens no other route to other origins", async () => {
    for (const path of ["/", "/api/uploads/missing"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      await response.body?.cancel();
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("uploads from the board's sandboxed frame", () => {
  it("answers the preflight for a POST from an opaque origin", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("lets an opaque origin read both a stored upload and a refusal", async () => {
    const stored = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: "POST",
      headers: { origin: "null", "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(stored.status).toBe(201);
    expect(stored.headers.get("access-control-allow-origin")).toBe("*");
    expect(await stored.json()).toMatchObject({ size: 3 });

    const empty = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: "POST",
      headers: { origin: "null", "content-type": "application/octet-stream" },
      body: new Uint8Array(),
    });
    expect(empty.status).toBe(400);
    expect(empty.headers.get("access-control-allow-origin")).toBe("*");
    expect(await empty.json()).toEqual({ error: "The file is empty." });
  });

  it("keeps every other route and method closed to other origins", async () => {
    const cases: [string, string][] = [
      ["OPTIONS", "/"],
      ["OPTIONS", "/api/uploads/missing"],
      ["GET", "/api/uploads"],
    ];
    for (const [method, path] of cases) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        method,
        headers: { origin: "null" },
      });
      await response.body?.cancel();
      expect({
        method,
        path,
        status: response.status,
        allowOrigin: response.headers.get("access-control-allow-origin"),
      }).toEqual({ method, path, status: 405, allowOrigin: null });
    }
  });
});
