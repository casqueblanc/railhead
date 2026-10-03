// Pushes a pack that creates `refs/heads/main` to an Artifacts repository over Git smart HTTP.
//
// Artifacts has no bundle import, so the seed speaks the v1 receive-pack protocol Artifacts accepts
// for pushes: one command creating main from the zero id at the bundle's head, with `report-status`,
// then the pack. The command creates main only if it does not exist, so a push can never move a main
// that someone else set. The response is the status report: `unpack ok` and `ok refs/heads/main`.
//
// The token goes only into the `Authorization` header of this one request. Neither the token, the
// remote nor the response body is logged or returned.

import type { CommitSha } from "@railhead/shared/events";
import { BUNDLE_REF } from "./bundle";

/** How long one push may take before it counts as lost. */
export const PUSH_TIMEOUT_MS = 60_000;

/** The largest status report the push reads. A real one is under a hundred bytes. */
const MAX_REPORT_BYTES = 8192;

const ZERO_ID = "0".repeat(40);
const encoder = new TextEncoder();

/** How a push ended. `uncertain` means main may or may not have been created. */
export type PushOutcome = "pushed" | "refused" | "uncertain";

/** What a push needs. */
export interface PushRequest {
  /** The repository's HTTPS Git remote, as Artifacts returned it. */
  readonly remote: string;
  /** A write token for that repository. A secret. */
  readonly token: string;
  /** The commit main is created at. */
  readonly head: CommitSha;
  /** The pack holding every object `head` reaches. */
  readonly pack: Uint8Array;
}

/** Sends one receive-pack request creating main, and reads its status report. */
export async function pushMain(
  request: PushRequest,
  fetcher: typeof fetch,
  timeoutMs: number = PUSH_TIMEOUT_MS,
): Promise<PushOutcome> {
  let url: URL;
  try {
    url = new URL(`${request.remote.replace(/\/+$/, "")}/git-receive-pack`);
  } catch (error) {
    if (error instanceof TypeError) return "refused";
    throw error;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return "refused";

  const command = `${ZERO_ID} ${request.head} ${BUNDLE_REF}\0report-status\n`;
  const body = concat([pktLine(command), encoder.encode("0000"), request.pack]);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.token}`,
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: "application/x-git-receive-pack-result",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A network failure or timeout: the request may have reached Artifacts and applied.
    return "uncertain";
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return "refused";
  }
  if (!response.ok) {
    await response.body?.cancel();
    return "uncertain";
  }
  const report = await readReport(response);
  if (report === undefined) return "uncertain";
  return report.includes("unpack ok") && report.includes(`ok ${BUNDLE_REF}`) ? "pushed" : "refused";
}

/** The status report's pkt-line payloads, or `undefined` when it is not one. */
async function readReport(response: Response): Promise<string[] | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readAtMost(response, MAX_REPORT_BYTES);
  } catch {
    return undefined;
  }
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (!Number.isInteger(length) || !/^[0-9a-f]{4}$/.test(text.slice(at, at + 4))) {
      return undefined;
    }
    if (length === 0) return lines;
    if (length < 4 || at + length > text.length) return undefined;
    lines.push(text.slice(at + 4, at + length).replace(/\n$/, ""));
    at += length;
  }
  return undefined;
}

/** Reads the body, refusing one longer than `limit` bytes. */
async function readAtMost(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks);
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new RangeError("status report too long");
    }
    chunks.push(value);
  }
}

function pktLine(payload: string): Uint8Array {
  const bytes = encoder.encode(payload);
  return concat([encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
