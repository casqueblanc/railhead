// The agent routes' dispatch inside a `Repo`: one validated command in, one wire response out.
//
// `agentHttp.ts` in the Worker has already matched the route, bounded and parsed the body, and
// checked its shape and invariants. Here the caller is authenticated by the sessions module from the
// bearer token alone, the session is checked against this repository, and the command goes to the
// module that owns it. A port's refusal becomes the wire error with that code's fixed status; a
// code the agent wire does not define becomes `internal`, never a success.

import {
  AGENT_ERRORS,
  type AckRequest,
  type AgentErrorCode,
  type AgentResponse,
  type AgentResults,
  type AgentRouteName,
  type AskRequest,
  type ChallengeRequest,
  type ClaimRequest,
  type ClaimView,
  type InboxDigest,
  type JoinRequest,
  type ReadyRequest,
  type RepoSegment,
  type SessionRequest,
  claimRemotePath,
  upstreamRemotePath,
} from "@railhead/shared/agent-api";
import type { ClaimId, QuestionId, RepoId } from "@railhead/shared/events";
import type { AgentPrincipal } from "../contracts/principals";
import { fail, ok, type PortFailure, type PortResult } from "../contracts/result";
import type { RepoPorts } from "../repo/composeRepo";

/** One agent request, validated by the Worker, with its path and query parameters parsed. */
export type AgentCommand =
  | { route: "join"; body: JoinRequest }
  | { route: "challenge"; body: ChallengeRequest }
  | { route: "session"; body: SessionRequest }
  | { route: "status" }
  | { route: "work" }
  | { route: "claim"; body: ClaimRequest }
  | { route: "ready"; claimId: ClaimId; body: ReadyRequest }
  | { route: "pin" }
  | { route: "inbox"; limit: number }
  | { route: "ack"; item: number; body: AckRequest }
  | { route: "ask"; claimId: ClaimId; body: AskRequest }
  | { route: "question"; questionId: QuestionId; waitMs: number };

/** A command and the bearer token it arrived with, `null` when there was none. */
export interface AgentCall {
  /** The command. */
  command: AgentCommand;
  /** The `Authorization: Bearer` value, unverified. */
  token: string | null;
  /** The origin the request arrived on. Claim remotes are given on it, never on another host. */
  origin: string;
}

/** The response body of an agent route. */
export type AgentReply = AgentResponse<AgentResults[AgentRouteName]>;

/** The installed repository a call is dispatched to. */
export interface AgentTarget {
  /** The repository. */
  repoId: RepoId;
  /** Its organisation segment. */
  org: RepoSegment;
  /** Its repository segment. */
  name: RepoSegment;
  /** Its modules. */
  ports: RepoPorts;
}

type SessionCommand = Exclude<AgentCommand, { route: "join" | "challenge" | "session" }>;

/**
 * Answers one agent call. `target` is `null` when the repository does not exist, which every route
 * answers with `not_found` before authenticating.
 */
export async function dispatchAgent(
  target: AgentTarget | null,
  call: AgentCall,
): Promise<AgentReply> {
  if (target === null) return refusal(fail("not_found", "No such repository."));
  const { ports } = target;
  const { command } = call;
  switch (command.route) {
    case "join":
      return beforeSession(await ports.identity.join(command.body));
    case "challenge":
      return beforeSession(await ports.sessions.issueChallenge(command.body));
    case "session":
      return beforeSession(await ports.sessions.redeem(command.body));
    case "status":
    case "work":
    case "claim":
    case "ready":
    case "pin":
    case "inbox":
    case "ack":
    case "ask":
    case "question":
      return withSession(target, call, command);
    default:
      return unreachable(command);
  }
}

async function withSession(
  target: AgentTarget,
  { token, origin }: AgentCall,
  command: SessionCommand,
): Promise<AgentReply> {
  if (token === null) {
    return refusal(fail("unauthenticated", "This route needs a session token."));
  }
  const { ports } = target;
  const authenticated = await ports.sessions.authenticate(token);
  if (!authenticated.ok) return refusal(authenticated);
  const agent = authenticated.value;
  // The sessions module checks the binding too; a principal for another repository must never act
  // here even if it does not.
  if (agent.kind !== "agent" || agent.repoId !== target.repoId) {
    return refusal(fail("unauthenticated", "The session is not for this repository."));
  }
  const result = await runSessionCommand(ports, agent, command, { ...target, origin });
  if (!result.ok) return refusal(result);
  const digest: PortResult<InboxDigest> = await ports.inbox.digest(agent);
  // Every state-changing session route is idempotent, so a failed digest is reported and the
  // retry returns the recorded result together with the inbox.
  if (!digest.ok) return refusal(digest);
  return { ok: true, data: result.value, inbox: digest.value, next: null };
}

async function runSessionCommand(
  ports: RepoPorts,
  agent: AgentPrincipal,
  command: SessionCommand,
  remotes: Remotes,
): Promise<PortResult<AgentResults[AgentRouteName]>> {
  switch (command.route) {
    case "status": {
      const view = await ports.identity.view(agent);
      if (!view.ok) return view;
      const claim = await ports.claims.activeClaim(agent);
      if (!claim.ok) return claim;
      // Read after the active claim, whose read may have just expired it.
      const closed = await ports.claims.lastClosed(agent);
      if (!closed.ok) return closed;
      if (claim.value === null) return ok({ agent: view.value, claim: null, closed: closed.value });
      return located(remotes, ok({ agent: view.value, claim: claim.value, closed: closed.value }));
    }
    case "work":
      return located(remotes, await ports.claims.work(agent));
    case "claim":
      return located(remotes, await ports.claims.claim(agent, command.body.issueId));
    case "ready":
      return located(remotes, await ports.claims.ready(agent, command.claimId, command.body));
    case "pin": {
      // Only the caller's own ready claim, at its current generation: an older generation's pin
      // may have been another agent's.
      const claim = await ports.claims.activeClaim(agent);
      if (!claim.ok) return claim;
      if (claim.value === null || claim.value.state !== "ready") return ok({ pin: null });
      const pin = await ports.train.pinView(claim.value.claimId, claim.value.generation);
      return pin.ok ? ok({ pin: pin.value }) : pin;
    }
    case "inbox":
      return ports.inbox.pending(agent, command.limit);
    case "ack":
      return ports.inbox.ack(agent, command.item, command.body.plan);
    case "ask":
      return ports.decisions.ask(agent, command.claimId, command.body);
    case "question":
      return ports.decisions.question(agent, command.questionId, command.waitMs);
    default:
      return unreachable(command);
  }
}

/** Where an agent reaches this repository's Git remotes. */
interface Remotes {
  origin: string;
  org: RepoSegment;
  name: RepoSegment;
}

/**
 * Gives a claim its remote URLs on the origin the agent called. The claims port knows neither the
 * origin nor the repository's name, so every claim leaving here gets them, replacing whatever the
 * port set.
 */
function located<T extends { claim: ClaimView }>(
  remotes: Remotes,
  result: PortResult<T>,
): PortResult<T> {
  if (!result.ok) return result;
  const { claim } = result.value;
  const { origin, org, name } = remotes;
  return ok({
    ...result.value,
    claim: {
      ...claim,
      originUrl: `${origin}${claimRemotePath(org, name, claim.claimId)}`,
      upstreamUrl: `${origin}${upstreamRemotePath(org, name)}`,
    },
  });
}

function beforeSession(result: PortResult<AgentResults[AgentRouteName]>): AgentReply {
  if (!result.ok) return refusal(result);
  return { ok: true, data: result.value, inbox: null, next: null };
}

/** The wire error for a port's refusal. */
export function refusal(failure: PortFailure): AgentReply {
  const code: AgentErrorCode = isAgentErrorCode(failure.code) ? failure.code : "internal";
  const spec = AGENT_ERRORS[code];
  return {
    ok: false,
    error: {
      code,
      message: code === failure.code ? failure.message : "The backend failed.",
      retryable: spec.retryable,
      retryAfterMs: null,
      next: spec.next,
    },
  };
}

function isAgentErrorCode(code: string): code is AgentErrorCode {
  return Object.hasOwn(AGENT_ERRORS, code);
}

function unreachable(value: never): never {
  throw new Error(`unhandled agent command: ${JSON.stringify(value)}`);
}
