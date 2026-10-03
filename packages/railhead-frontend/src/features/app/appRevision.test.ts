import { describe, expect, it, vi } from "vitest";
import { appLocation, deploymentStatus, parseRevision, readAppRevision } from "./appRevision";

const MAIN = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";

const BOARD = "https://railhead.dev";

describe("appLocation", () => {
  it("keeps only the origin of an http or https URL", () => {
    expect(appLocation(" https://upload.example.dev/some/path?q=1 ", BOARD)).toEqual({
      kind: "configured",
      origin: "https://upload.example.dev",
    });
    expect(appLocation("http://localhost:8788", BOARD)).toEqual({
      kind: "configured",
      origin: "http://localhost:8788",
    });
  });

  it("treats a missing or blank value as unconfigured", () => {
    expect(appLocation(undefined, BOARD)).toEqual({ kind: "unconfigured" });
    expect(appLocation("   ", BOARD)).toEqual({ kind: "unconfigured" });
  });

  it("refuses the board's own origin, which the embed would let the app script", () => {
    expect(appLocation("https://railhead.dev/app", BOARD)).toEqual({ kind: "invalid" });
  });

  it("rejects other schemes and values that are not URLs", () => {
    for (const raw of [
      "javascript:alert(1)",
      "ftp://upload.example.dev",
      "upload.example.dev",
      42,
    ]) {
      expect(appLocation(raw, BOARD)).toEqual({ kind: "invalid" });
    }
  });
});

describe("parseRevision", () => {
  it("accepts a full lowercase commit id", () => {
    expect(parseRevision({ revision: MAIN })).toEqual({ kind: "reported", revision: MAIN });
  });

  it("calls a revision that is not a commit id unreported", () => {
    for (const revision of ["unknown", MAIN.slice(0, 7), MAIN.toUpperCase(), `${MAIN}0`]) {
      expect(parseRevision({ revision })).toEqual({ kind: "unreported" });
    }
  });

  it("calls a body without a string revision unreachable", () => {
    for (const body of [null, "text", [], {}, { revision: 1 }]) {
      expect(parseRevision(body)).toEqual({ kind: "unreachable" });
    }
  });
});

describe("readAppRevision", () => {
  const signal = new AbortController().signal;

  it("asks the app's revision route without credentials or cache", async () => {
    const fetchRevision = vi.fn<typeof fetch>(async () => Response.json({ revision: MAIN }));
    await expect(
      readAppRevision("https://upload.example.dev", fetchRevision, signal),
    ).resolves.toEqual({ kind: "reported", revision: MAIN });
    const [url, init] = fetchRevision.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://upload.example.dev/api/revision");
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit", redirect: "error" });
  });

  it("calls an error status, a non-JSON body or a network failure unreachable", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => Response.json({ revision: MAIN }, { status: 500 }),
      async () => new Response("<html>", { status: 200 }),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const answer of answers) {
      await expect(
        readAppRevision("https://upload.example.dev", vi.fn<typeof fetch>(answer), signal),
      ).resolves.toEqual({ kind: "unreachable" });
    }
  });

  it("gives up on an app that does not answer within the timeout", async () => {
    let aborted = false;
    const hang = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("timed out", "TimeoutError"));
          });
        }),
    );
    await expect(readAppRevision("https://upload.example.dev", hang, signal, 20)).resolves.toEqual({
      kind: "unreachable",
    });
    expect(aborted).toBe(true);
  });
});

describe("deploymentStatus", () => {
  it("is current only when the deployed commit is main", () => {
    expect(deploymentStatus(MAIN, { kind: "reported", revision: MAIN })).toEqual({
      kind: "current",
      deployed: MAIN,
    });
  });

  it("is stale when main has moved past the deployed commit", () => {
    expect(deploymentStatus(MAIN, { kind: "reported", revision: OLD })).toEqual({
      kind: "stale",
      deployed: OLD,
      main: MAIN,
    });
  });

  it("compares nothing before the train reads main", () => {
    expect(deploymentStatus(null, { kind: "reported", revision: OLD })).toEqual({
      kind: "main_unknown",
      deployed: OLD,
    });
  });

  it("never calls an unreported or unreachable app current", () => {
    expect(deploymentStatus(MAIN, { kind: "unreported" })).toEqual({ kind: "unreported" });
    expect(deploymentStatus(MAIN, { kind: "unreachable" })).toEqual({ kind: "unreachable" });
    expect(deploymentStatus(MAIN, { kind: "checking" })).toEqual({ kind: "checking" });
  });
});
