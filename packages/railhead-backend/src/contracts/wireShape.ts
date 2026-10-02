// Shape checks for JSON that arrives over HTTP or from a file: agent requests and responses, and
// events. capnweb-validate generates each check from the TypeScript types, the same way it guards
// the RPC session, so no shape is written twice. A shape check runs first; the invariant checks in
// `@railhead/shared` (`validateAgentRequest`, `validateEvent`) run on its result. Parsed JSON is
// never cast to a wire type.
//
// How: `@validateRpc()` validates the arguments of every call on an instance, local calls included.
// `WireShapes` declares one identity method per wire type, so calling it with a parsed value either
// throws a `TypeError` naming the failing path or returns the value with its type established.
// Unknown object fields pass through unvalidated; callers copy the fields they use and never store
// or forward the parsed object.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  AckRequest,
  AckResult,
  AgentRequestPair,
  AgentResponse,
  AgentRouteName,
  AskRequest,
  ChallengeRequest,
  ChallengeResult,
  ClaimRequest,
  ClaimResult,
  InboxResult,
  JoinRequest,
  JoinResult,
  QuestionResult,
  ReadyRequest,
  ReadyResult,
  SessionRequest,
  SessionResult,
  StatusResult,
} from "@railhead/shared/agent-api";
import type { RailheadEvent } from "@railhead/shared/events";

/** One identity method per wire type. Each argument is validated before the method runs. */
interface WireShapes {
  event(value: RailheadEvent): RailheadEvent;
  joinRequest(value: JoinRequest): JoinRequest;
  challengeRequest(value: ChallengeRequest): ChallengeRequest;
  sessionRequest(value: SessionRequest): SessionRequest;
  claimRequest(value: ClaimRequest): ClaimRequest;
  readyRequest(value: ReadyRequest): ReadyRequest;
  ackRequest(value: AckRequest): AckRequest;
  askRequest(value: AskRequest): AskRequest;
  emptyBody(value: null): null;
  joinResponse(value: AgentResponse<JoinResult>): AgentResponse<JoinResult>;
  challengeResponse(value: AgentResponse<ChallengeResult>): AgentResponse<ChallengeResult>;
  sessionResponse(value: AgentResponse<SessionResult>): AgentResponse<SessionResult>;
  statusResponse(value: AgentResponse<StatusResult>): AgentResponse<StatusResult>;
  claimResponse(value: AgentResponse<ClaimResult>): AgentResponse<ClaimResult>;
  readyResponse(value: AgentResponse<ReadyResult>): AgentResponse<ReadyResult>;
  inboxResponse(value: AgentResponse<InboxResult>): AgentResponse<InboxResult>;
  ackResponse(value: AgentResponse<AckResult>): AgentResponse<AckResult>;
  questionResponse(value: AgentResponse<QuestionResult>): AgentResponse<QuestionResult>;
}

@validateRpc<WireShapes>()
class WireShapeCheck extends RpcTarget implements WireShapes {
  event(value: RailheadEvent): RailheadEvent {
    return value;
  }
  joinRequest(value: JoinRequest): JoinRequest {
    return value;
  }
  challengeRequest(value: ChallengeRequest): ChallengeRequest {
    return value;
  }
  sessionRequest(value: SessionRequest): SessionRequest {
    return value;
  }
  claimRequest(value: ClaimRequest): ClaimRequest {
    return value;
  }
  readyRequest(value: ReadyRequest): ReadyRequest {
    return value;
  }
  ackRequest(value: AckRequest): AckRequest {
    return value;
  }
  askRequest(value: AskRequest): AskRequest {
    return value;
  }
  emptyBody(value: null): null {
    return value;
  }
  joinResponse(value: AgentResponse<JoinResult>): AgentResponse<JoinResult> {
    return value;
  }
  challengeResponse(value: AgentResponse<ChallengeResult>): AgentResponse<ChallengeResult> {
    return value;
  }
  sessionResponse(value: AgentResponse<SessionResult>): AgentResponse<SessionResult> {
    return value;
  }
  statusResponse(value: AgentResponse<StatusResult>): AgentResponse<StatusResult> {
    return value;
  }
  claimResponse(value: AgentResponse<ClaimResult>): AgentResponse<ClaimResult> {
    return value;
  }
  readyResponse(value: AgentResponse<ReadyResult>): AgentResponse<ReadyResult> {
    return value;
  }
  inboxResponse(value: AgentResponse<InboxResult>): AgentResponse<InboxResult> {
    return value;
  }
  ackResponse(value: AgentResponse<AckResult>): AgentResponse<AckResult> {
    return value;
  }
  questionResponse(value: AgentResponse<QuestionResult>): AgentResponse<QuestionResult> {
    return value;
  }
}

/** The same methods taking `unknown`, which is what the generated validators accept. */
type UncheckedShapes = { [K in keyof WireShapes]: (value: unknown) => ReturnType<WireShapes[K]> };

const checked: WireShapes = new WireShapeCheck();
// The one widening of a parameter type in this module: sound because the class's generated
// validator checks every argument at run time before the method body sees it.
const shapes = checked as UncheckedShapes;

/** Establishes that `value` has the shape of an event. Throws a `TypeError` naming the path. */
export function parseEvent(value: unknown): RailheadEvent {
  return shapes.event(value);
}

/**
 * Establishes that `body` has the shape of `route`'s request body, `null` for a route without a
 * body. Throws a `TypeError` naming the path. Run `validateAgentRequest` on the result.
 */
export function parseAgentRequest(route: AgentRouteName, body: unknown): AgentRequestPair {
  switch (route) {
    case "join":
      return { route, body: shapes.joinRequest(body) };
    case "challenge":
      return { route, body: shapes.challengeRequest(body) };
    case "session":
      return { route, body: shapes.sessionRequest(body) };
    case "claim":
      return { route, body: shapes.claimRequest(body) };
    case "ready":
      return { route, body: shapes.readyRequest(body) };
    case "ack":
      return { route, body: shapes.ackRequest(body) };
    case "ask":
      return { route, body: shapes.askRequest(body) };
    case "status":
    case "work":
    case "inbox":
    case "question":
      return { route, body: shapes.emptyBody(body) };
    default:
      return unreachable(route);
  }
}

/** A route paired with a response body of that route's type. */
export type AgentResponsePair =
  | { route: "join"; response: AgentResponse<JoinResult> }
  | { route: "challenge"; response: AgentResponse<ChallengeResult> }
  | { route: "session"; response: AgentResponse<SessionResult> }
  | { route: "status"; response: AgentResponse<StatusResult> }
  | { route: "work" | "claim"; response: AgentResponse<ClaimResult> }
  | { route: "ready"; response: AgentResponse<ReadyResult> }
  | { route: "inbox"; response: AgentResponse<InboxResult> }
  | { route: "ack"; response: AgentResponse<AckResult> }
  | { route: "ask" | "question"; response: AgentResponse<QuestionResult> };

/** Establishes that `body` has the shape of a response from `route`. Throws a `TypeError`. */
export function parseAgentResponse(route: AgentRouteName, body: unknown): AgentResponsePair {
  switch (route) {
    case "join":
      return { route, response: shapes.joinResponse(body) };
    case "challenge":
      return { route, response: shapes.challengeResponse(body) };
    case "session":
      return { route, response: shapes.sessionResponse(body) };
    case "status":
      return { route, response: shapes.statusResponse(body) };
    case "work":
    case "claim":
      return { route, response: shapes.claimResponse(body) };
    case "ready":
      return { route, response: shapes.readyResponse(body) };
    case "inbox":
      return { route, response: shapes.inboxResponse(body) };
    case "ack":
      return { route, response: shapes.ackResponse(body) };
    case "ask":
    case "question":
      return { route, response: shapes.questionResponse(body) };
    default:
      return unreachable(route);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled agent route: ${String(value)}`);
}
