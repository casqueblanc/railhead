// The only way `scripts/qualify-slice.mjs` sends an agent's session over HTTP. A request goes to the
// instance under qualification or nowhere: its URL is checked against that instance's origin before
// anything is sent, and a redirect is refused rather than followed, so a credential never leaves
// for another host.

import { originProblem } from "./evidence.ts";

/** A request the harness refused to send, or a response it refused to follow. */
export class RefusedDestination extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedDestination";
  }
}

/**
 * Why `url` is not a destination on `origin`, or `null` when it is: both must be HTTPS without
 * credentials in the URL, and `url` must have exactly `origin`'s scheme, host and port.
 */
export function destinationProblem(origin: string, url: string): string | null {
  const problem = originProblem(origin);
  if (problem !== null) return `the instance origin is ${problem}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== "https:") return "not HTTPS";
  if (parsed.username !== "" || parsed.password !== "") return "carries credentials";
  return parsed.origin === new URL(origin).origin ? null : "on another host";
}

/**
 * Sends `init` to `url` once `url` is on `origin`, with redirects refused. A redirect answer is a
 * refusal, never a response, so a caller cannot read one as the instance's verdict.
 */
export async function sendToInstance(
  origin: string,
  url: string,
  init: RequestInit,
  send: typeof fetch = fetch,
): Promise<Response> {
  const problem = destinationProblem(origin, url);
  if (problem !== null) throw new RefusedDestination(`refused to send to a URL ${problem}`);
  const response = await send(url, { ...init, redirect: "manual" });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new RefusedDestination(`the instance answered with a redirect (HTTP ${response.status})`);
  }
  return response;
}
