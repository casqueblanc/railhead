// The Git gateway: every HTTP and HTTPS request a sandbox sends arrives here, outside the sandbox.
// It forwards Git smart-HTTP to the Artifacts host for the repositories the sandbox's policy names,
// adding a freshly minted repository token the sandbox never sees, and refuses everything else.
//
// A push is checked before any of it is forwarded: its ref commands are read with the same
// receive-pack parser the agent gateway uses, and each must create or update a ref under the
// policy's candidate prefix. The pack after the commands is forwarded unread.
//
// The grant lapses at the sandbox's deadline, and the gateway holds it to that through every await:
// it checks the grant on arrival, after reading a push's commands and after minting a token, so
// nothing is forwarded once the grant has lapsed, and at the deadline it stops reading the
// sandbox's body and aborts the upstream request.

import { ReceivePackHeadParser, type RefUpdate } from "../git/pktLine";
import type { SandboxGrant } from "./policy";

/** Mints a short-lived token for one repository. The token never reaches the sandbox. */
export type TokenMinter = (repo: string, scope: "read" | "write") => Promise<string>;

/** What the gateway needs from outside: tokens, the upstream fetch and the time. */
export interface GatewayDeps {
  /** Mints the repository token added to each forwarded request. */
  mint: TokenMinter;
  /** Sends the forwarded request. */
  fetch: (request: Request) => Promise<Response>;
  /** The current time, in milliseconds since the Unix epoch, compared with the grant's deadline. */
  now: () => number;
}

/** Why the gateway refused a request. Sent back to the sandbox as the body of a 403. */
export type GatewayRefusal =
  | "policy"
  | "scheme"
  | "host"
  | "path"
  | "namespace"
  | "service"
  | "method"
  | "repository"
  | "read-only"
  | "push"
  | "ref";

const GIT_PATH = /^\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Answers one request from a sandbox under `grant`; a `null` or lapsed grant refuses everything. */
export async function serveGitGateway(
  request: Request,
  grant: SandboxGrant | null,
  deps: GatewayDeps,
): Promise<Response> {
  const lapsed = () => grant === null || deps.now() >= grant.expiresAt;
  if (grant === null || lapsed()) return refuse("policy");
  const { policy } = grant;
  const deadline = AbortSignal.timeout(grant.expiresAt - deps.now());
  const url = new URL(request.url);
  if (url.protocol !== "https:") return refuse("scheme");
  if (url.hostname !== policy.host || url.port !== "") return refuse("host");
  const match = GIT_PATH.exec(url.pathname);
  if (match === null) return refuse("path");
  const [, namespace = "", repo = "", op = ""] = match;
  if (namespace !== policy.namespace) return refuse("namespace");

  const service = op === "info/refs" ? url.searchParams.get("service") : op;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return refuse("service");
  if (request.method !== (op === "info/refs" ? "GET" : "POST")) return refuse("method");

  const write = service === "git-receive-pack";
  const writable = policy.write !== null && policy.write.repo === repo;
  if (!writable && !policy.read.includes(repo)) return refuse("repository");
  if (write && !writable) return refuse("read-only");

  let body: ReadableStream<Uint8Array> | null = null;
  if (op === "git-receive-pack") {
    const prefix = policy.write?.refPrefix;
    if (prefix === undefined || request.body === null) return refuse("push");
    const checked = await checkPush(request.body, prefix, deadline);
    if (lapsed()) return refuse("policy");
    if (checked.kind === "refused") return refuse(checked.reason);
    body = checked.body;
  } else if (op === "git-upload-pack") {
    body = request.body;
  }

  // The sandbox's own Authorization header, if any, is dropped: only the minted token goes out.
  const headers = new Headers(request.headers);
  const token = await deps.mint(repo, write ? "write" : "read");
  if (lapsed()) return refuse("policy");
  headers.set("Authorization", `Bearer ${token}`);
  return deps.fetch(new Request(url, { method: request.method, headers, body, signal: deadline }));
}

type PushCheck =
  | { kind: "allowed"; body: ReadableStream<Uint8Array> }
  | { kind: "refused"; reason: "push" | "ref" };

/**
 * Reads a receive-pack body until its ref commands are complete and checks each against `prefix`.
 * Holds at most the head and the chunk that completed it; on success returns a stream that replays
 * those bytes and then the rest of the body. When `deadline` aborts, the body is cancelled, so a
 * read waiting on it ends and nothing more of it is forwarded.
 */
async function checkPush(
  source: ReadableStream<Uint8Array>,
  prefix: string,
  deadline: AbortSignal,
): Promise<PushCheck> {
  const reader = source.getReader();
  // A cancel that fails leaves the stream errored, and the pending or next read rejects with that
  // error, so its own rejection carries nothing more.
  const stop = () => void reader.cancel().catch(() => undefined);
  if (deadline.aborted) stop();
  else deadline.addEventListener("abort", stop, { once: true });
  const parser = new ReceivePackHeadParser();
  const held: Uint8Array[] = [];
  let updates: readonly RefUpdate[] | null = null;
  let pushOptions = 0;
  while (updates === null) {
    const { done, value } = await reader.read();
    const parse = done ? parser.end() : parser.push(value);
    if (!done) held.push(value);
    if (parse.kind === "refused") {
      await reader.cancel();
      return { kind: "refused", reason: "push" };
    }
    if (parse.kind === "complete") {
      updates = parse.head.updates;
      pushOptions = parse.head.pushOptions.length;
    } else if (done) {
      return { kind: "refused", reason: "push" };
    }
  }
  // An empty command list or push options carry nothing a candidate push needs.
  if (updates.length === 0 || pushOptions > 0) {
    await reader.cancel();
    return { kind: "refused", reason: "push" };
  }
  if (!updates.every((update) => update.kind !== "delete" && isUnder(update.ref, prefix))) {
    await reader.cancel();
    return { kind: "refused", reason: "ref" };
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk);
      held.length = 0;
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return { kind: "allowed", body };
}

// A ref under the prefix with at least one more segment, and no `..` or empty segment that could
// make Git store it elsewhere.
function isUnder(ref: string, prefix: string): boolean {
  if (!ref.startsWith(prefix) || ref.length === prefix.length) return false;
  return ref
    .slice(prefix.length)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function refuse(reason: GatewayRefusal): Response {
  return new Response(`railhead sandbox gateway refused this request: ${reason}\n`, {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
