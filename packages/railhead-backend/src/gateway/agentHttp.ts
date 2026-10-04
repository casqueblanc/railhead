// The agent wire's HTTP adapter in the Worker: matches a request to a row of `AGENT_ROUTES`, bounds
// and parses its body, checks the body's shape and invariants, then hands one typed command to the
// repository's `Repo`. Nothing here authenticates or decides; the request's identity is only the
// bearer token, which the Repo's sessions module verifies.
//
// A request is refused before it reaches the Repo when its path matches no route (404), its body
// is not JSON (415) or is larger than `MAX_AGENT_REQUEST_BYTES` (413), or its body, path or query
// breaks the route's contract (400). Refusal messages are fixed text and never echo the request.

import {
  AGENT_ERRORS,
  AGENT_PATH_PREFIX,
  AGENT_REQUEST_CONTENT_TYPE,
  AGENT_RESPONSE_CONTENT_TYPE,
  AGENT_ROUTES,
  MAX_AGENT_REQUEST_BYTES,
  isRepoSegment,
  isSessionTokenForm,
  parseInboxLimit,
  parseItemNumber,
  parseWaitMs,
  validateAgentRequest,
  type AgentRequestPair,
  type AgentRouteName,
} from "@railhead/shared/agent-api";
import { isId } from "@railhead/shared/events";
import { parseAgentRequest } from "../contracts/wireShape";
import { fail, type PortErrorCode } from "../contracts/result";
import { repoObjectName } from "../repo/RepoObject";
import { refusal, type AgentCommand, type AgentReply } from "./agentDispatch";

/** Answers one request under `AGENT_PATH_PREFIX`. */
export async function serveAgent(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = matchRoute(request.method, url.pathname);
  if (match === null) return refuse("not_found", "No agent route matches this request.");

  const body = await readBody(request, match.route);
  if (!body.ok) return refuse(body.code, body.message);

  let command: AgentCommand;
  try {
    const pair = parseAgentRequest(match.route, body.value);
    validateAgentRequest(pair);
    command = toCommand(pair, match.params, url.searchParams);
  } catch (error) {
    // The shape checker's and validators' messages can quote the request, so none is returned.
    if (error instanceof Error) {
      return refuse("invalid_request", "The request does not match this route's contract.");
    }
    throw error;
  }

  let token: string | null = null;
  if (AGENT_ROUTES[match.route].auth === "session") {
    const header = request.headers.get("Authorization");
    if (header !== null) {
      const value = /^Bearer (\S+)$/.exec(header)?.[1];
      if (value === undefined || !isSessionTokenForm(value)) {
        return refuse("unauthenticated", "The Authorization header is not a session token.");
      }
      token = value;
    }
  }

  const repo = env.REPO.getByName(repoObjectName(match.org, match.repo));
  const reply: AgentReply = await repo.agent({ command, token, origin: url.origin });
  return respond(reply);
}

const ROUTE_NAMES: readonly AgentRouteName[] = Object.keys(AGENT_ROUTES).filter(isRouteName);

function isRouteName(name: string): name is AgentRouteName {
  return Object.hasOwn(AGENT_ROUTES, name);
}

interface RouteMatch {
  route: AgentRouteName;
  org: string;
  repo: string;
  params: ReadonlyMap<string, string>;
}

function matchRoute(method: string, pathname: string): RouteMatch | null {
  if (!pathname.startsWith(`${AGENT_PATH_PREFIX}/`)) return null;
  const [org, repo, ...rest] = pathname.slice(AGENT_PATH_PREFIX.length + 1).split("/");
  if (org === undefined || repo === undefined || !isRepoSegment(org) || !isRepoSegment(repo)) {
    return null;
  }
  for (const route of ROUTE_NAMES) {
    const spec = AGENT_ROUTES[route];
    if (spec.method !== method) continue;
    const template = spec.path.split("/").slice(1);
    if (template.length !== rest.length) continue;
    const params = new Map<string, string>();
    const matched = template.every((part, index) => {
      const actual = rest[index];
      if (actual === undefined) return false;
      if (part.startsWith("{") && part.endsWith("}")) {
        params.set(part.slice(1, -1), actual);
        return actual !== "";
      }
      return part === actual;
    });
    if (matched) return { route, org, repo, params };
  }
  return null;
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: PortErrorCode; message: string };

async function readBody(request: Request, route: AgentRouteName): Promise<BodyResult> {
  if (AGENT_ROUTES[route].method === "GET") return { ok: true, value: null };
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_AGENT_REQUEST_BYTES) {
    return tooLarge();
  }
  const mediaType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const json = mediaType === AGENT_REQUEST_CONTENT_TYPE;
  // A declared non-empty body of another type is refused unread.
  if (declared !== null && Number(declared) > 0 && !json) return wrongMediaType();
  const bytes = await readBounded(request.body);
  if (bytes === null) return tooLarge();
  // A route without a body (`work`) accepts an empty one.
  if (bytes.length === 0) return { ok: true, value: null };
  if (!json) return wrongMediaType();
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, code: "invalid_request", message: "The body is not valid JSON." };
  }
}

function wrongMediaType(): BodyResult {
  return {
    ok: false,
    code: "unsupported_media_type",
    message: `The body must be ${AGENT_REQUEST_CONTENT_TYPE}.`,
  };
}

function tooLarge(): BodyResult {
  return {
    ok: false,
    code: "payload_too_large",
    message: `The body is larger than ${MAX_AGENT_REQUEST_BYTES} bytes.`,
  };
}

/** Reads a body to at most `MAX_AGENT_REQUEST_BYTES`; `null` when it is longer. */
async function readBounded(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AGENT_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Joins a parsed body with the route's path and query parameters. Throws on an invalid one. */
function toCommand(
  pair: AgentRequestPair,
  params: ReadonlyMap<string, string>,
  query: URLSearchParams,
): AgentCommand {
  switch (pair.route) {
    case "join":
    case "challenge":
    case "session":
    case "claim":
      return pair;
    case "status":
    case "work":
    case "pin":
      return { route: pair.route };
    case "ready":
      return { route: "ready", claimId: idParam(params, "claimId", "claim"), body: pair.body };
    case "release":
      return { route: "release", claimId: idParam(params, "claimId", "claim"), body: pair.body };
    case "ask":
      return { route: "ask", claimId: idParam(params, "claimId", "claim"), body: pair.body };
    case "inbox":
      return { route: "inbox", limit: parseInboxLimit(query.get("limit")) };
    case "ack":
      return { route: "ack", item: parseItemNumber(params.get("item") ?? ""), body: pair.body };
    case "question":
      return {
        route: "question",
        questionId: idParam(params, "questionId", "question"),
        waitMs: parseWaitMs(query.get("waitMs")),
      };
    default:
      return unreachable(pair);
  }
}

function idParam(
  params: ReadonlyMap<string, string>,
  name: string,
  kind: "claim" | "question",
): string {
  const value = params.get(name);
  if (value === undefined || !isId(kind, value)) throw new Error(`${name} is not a ${kind} id`);
  return value;
}

function refuse(code: PortErrorCode, message: string): Response {
  return respond(refusal(fail(code, message)));
}

function respond(reply: AgentReply): Response {
  const status = reply.ok ? 200 : AGENT_ERRORS[reply.error.code].status;
  return new Response(JSON.stringify(reply), {
    status,
    headers: { "Content-Type": AGENT_RESPONSE_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

function unreachable(value: never): never {
  throw new Error(`unhandled agent route: ${JSON.stringify(value)}`);
}
