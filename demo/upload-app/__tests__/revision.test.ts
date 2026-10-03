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
