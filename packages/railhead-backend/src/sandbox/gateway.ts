// The Git gateway: every HTTP and HTTPS request a sandbox sends arrives here, outside the sandbox.
// It forwards Git smart-HTTP to the Artifacts host for the repositories the sandbox's policy names,
// adding a freshly minted repository token the sandbox never sees, and refuses everything else.
//
// A push is checked before any of it is forwarded: its ref commands are read with the same
// receive-pack parser the agent gateway uses, and each must create or update a ref under the
// policy's candidate prefix. The pack after the commands is forwarded unread.

import { ReceivePackHeadParser, type RefUpdate } from "../git/pktLine";
import type { SandboxPolicy } from "./policy";

/** Mints a short-lived token for one repository. The token never reaches the sandbox. */
export type TokenMinter = (repo: string, scope: "read" | "write") => Promise<string>;

/** What the gateway needs from outside: tokens and the upstream fetch. */
export interface GatewayDeps {
  /** Mints the repository token added to each forwarded request. */
  mint: TokenMinter;
  /** Sends the forwarded request. */
  fetch: (request: Request) => Promise<Response>;
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

/** Answers one request from a sandbox under `policy`; a `null` policy refuses everything. */
export async function serveGitGateway(
  request: Request,
  policy: SandboxPolicy | null,
  deps: GatewayDeps,
): Promise<Response> {
  if (policy === null) return refuse("policy");
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
    const checked = await checkPush(request.body, prefix);
    if (checked.kind === "refused") return refuse(checked.reason);
    body = checked.body;
  } else if (op === "git-upload-pack") {
    body = request.body;
  }

  // The sandbox's own Authorization header, if any, is dropped: only the minted token goes out.
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${await deps.mint(repo, write ? "write" : "read")}`);
  return deps.fetch(new Request(url, { method: request.method, headers, body }));
}

type PushCheck =
  | { kind: "allowed"; body: ReadableStream<Uint8Array> }
  | { kind: "refused"; reason: "push" | "ref" };

/**
 * Reads a receive-pack body until its ref commands are complete and checks each against `prefix`.
 * Holds at most the head and the chunk that completed it; on success returns a stream that replays
 * those bytes and then the rest of the body.
 */
async function checkPush(source: ReadableStream<Uint8Array>, prefix: string): Promise<PushCheck> {
  const reader = source.getReader();
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
