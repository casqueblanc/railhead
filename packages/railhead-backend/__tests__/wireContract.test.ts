/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  AGENT_ERRORS,
  AGENT_REQUEST_CONTENT_TYPE,
  AGENT_ROUTES,
  COMMON_ERRORS,
  CONFIRM_DOMAIN,
  MAX_AGENT_RESPONSE_BYTES,
  MAX_INBOX_PAGE,
  MAX_LONG_POLL_MS,
  SESSION_ERRORS,
  SIGNING_NAMESPACE,
  isSessionTokenForm,
  joinMessage,
  loginMessage,
  parseInboxLimit,
  parseItemNumber,
  parseWaitMs,
  validateAgentRequest,
  type AgentErrorCode,
  type AgentRouteName,
} from "@railhead/shared/agent-api";
import { validateEvent, type EventType } from "@railhead/shared/events";
import type { OwnerAction } from "@railhead/shared/board-api";
import type { AgentPrincipal, HumanGrant } from "../src/contracts/principals";
import type { PortResult } from "../src/contracts/result";
import {
  unavailableArtifacts,
  unavailableAuthorization,
  unavailableChecks,
  unavailableClaims,
  unavailableDecisions,
  unavailableIdentity,
  unavailableInbox,
  unavailableMainRef,
  unavailableMainWriter,
  unavailableMerge,
  unavailableSessions,
  unavailableTrain,
} from "../src/contracts/unavailable";
import { parseAgentRequest, parseAgentResponse, parseEvent } from "../src/contracts/wireShape";
import ack from "../../../fixtures/protocol/wire/agent/ack.json";
import ask from "../../../fixtures/protocol/wire/agent/ask.json";
import challenge from "../../../fixtures/protocol/wire/agent/challenge.json";
import claim from "../../../fixtures/protocol/wire/agent/claim.json";
import inbox from "../../../fixtures/protocol/wire/agent/inbox.json";
import join from "../../../fixtures/protocol/wire/agent/join.json";
import question from "../../../fixtures/protocol/wire/agent/question.json";
import ready from "../../../fixtures/protocol/wire/agent/ready.json";
import session from "../../../fixtures/protocol/wire/agent/session.json";
import status from "../../../fixtures/protocol/wire/agent/status.json";
import work from "../../../fixtures/protocol/wire/agent/work.json";
import auth from "../../../fixtures/protocol/wire/auth.json";
import events from "../../../fixtures/protocol/wire/events.json";
import readme from "../../../fixtures/protocol/wire/README.md?raw";

/** The layout of one `agent/<route>.json` file. TypeScript checks each imported file against it. */
interface AgentFixture {
  route: string;
  method: string;
  path: string;
  exchanges: {
    name: string;
    request: { headers: Record<string, string>; query: Record<string, string>; body: unknown };
    response: { status: number; body: unknown };
  }[];
  rejectedRequests: { name: string; body: unknown; stage: string }[];
}

const FIXTURES: AgentFixture[] = [
  join,
  challenge,
  session,
  status,
  work,
  claim,
  ready,
  inbox,
  ack,
  ask,
  question,
];

const ROUTE_NAMES = Object.keys(AGENT_ROUTES);

function asRouteName(value: string): AgentRouteName {
  const name = ROUTE_NAMES.find((candidate) => candidate === value);
  if (name === undefined) throw new Error(`unknown route: ${value}`);
  // `name` is one of the table's own keys, found by equality.
  return name as AgentRouteName;
}

function routeName(fixture: AgentFixture): AgentRouteName {
  return asRouteName(fixture.route);
}

const EXCHANGES = FIXTURES.flatMap((fixture) =>
  fixture.exchanges.map((exchange) => ({ route: routeName(fixture), fixture, ...exchange })),
);
const REJECTED = FIXTURES.flatMap((fixture) =>
  fixture.rejectedRequests.map((rejected) => ({ route: routeName(fixture), ...rejected })),
);

/** The route's path as a pattern over concrete fixture paths. */
function pathPattern(route: AgentRouteName): RegExp {
  const template = AGENT_ROUTES[route].path.replaceAll(/\{[a-zA-Z]+\}/g, "[^/]+");
  return new RegExp(`^/agent/v1/[a-z0-9-]+/[a-z0-9-]+${template}$`);
}

describe("agent route table", () => {
  it("has exactly one fixture per route", () => {
    expect(FIXTURES.map((fixture) => fixture.route).toSorted()).toEqual(ROUTE_NAMES.toSorted());
  });

  it.each(FIXTURES)("matches the $route fixture's method and path", (fixture) => {
    const route = AGENT_ROUTES[routeName(fixture)];
    expect(fixture.method).toBe(route.method);
    expect(fixture.path).toMatch(pathPattern(routeName(fixture)));
  });

  it.each(FIXTURES)("covers $route with a success and an error", (fixture) => {
    const outcomes = fixture.exchanges.map((exchange) => exchange.response.status === 200);
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  it.each(ROUTE_NAMES)("lists %s in the README coverage table", (name) => {
    const route = AGENT_ROUTES[asRouteName(name)];
    const row = readme.split("\n").find((line) => line.startsWith(`| \`${name}\` `));
    expect(row).toContain(`\`${route.method} ${route.path}`);
  });
});

describe("agent exchanges", () => {
  it.each(EXCHANGES)("$route: $name", ({ route, fixture, request, response }) => {
    const spec = AGENT_ROUTES[route];

    // Headers: a body is JSON, and only session routes send the bearer token.
    expect(request.headers["content-type"]).toBe(
      request.body === null ? undefined : AGENT_REQUEST_CONTENT_TYPE,
    );
    const authorization = request.headers["authorization"];
    if (spec.auth === "session") {
      expect(authorization?.startsWith("Bearer ")).toBe(true);
      expect(isSessionTokenForm(authorization?.slice("Bearer ".length) ?? "")).toBe(true);
    } else {
      expect(authorization).toBeUndefined();
    }

    // Path and query parameters parse under their bounds.
    if (route === "ack") expect(parseItemNumber(fixture.path.split("/").at(-2) ?? "")).toBe(17);
    if (route === "inbox")
      expect(parseInboxLimit(request.query["limit"] ?? null)).toBeGreaterThan(0);
    if (route === "question") {
      expect(parseWaitMs(request.query["waitMs"] ?? null)).toBeLessThanOrEqual(MAX_LONG_POLL_MS);
    }

    // The body passes both stages.
    const pair = parseAgentRequest(route, request.body);
    expect(() => validateAgentRequest(pair)).not.toThrow();

    // The response has the route's shape, and an error carries its fixed status and advice.
    const parsed = parseAgentResponse(route, response.body);
    const body = parsed.response;
    if (body.ok) {
      expect(response.status).toBe(200);
      expect(body.inbox === null).toBe(spec.auth === "none");
    } else {
      const allowed: readonly AgentErrorCode[] = [
        ...COMMON_ERRORS,
        ...(spec.auth === "session" ? SESSION_ERRORS : []),
        ...spec.errors,
      ];
      expect(allowed).toContain(body.error.code);
      const fixed = AGENT_ERRORS[body.error.code];
      expect([response.status, body.error.retryable, body.error.next]).toEqual([
        fixed.status,
        fixed.retryable,
        fixed.next,
      ]);
    }

    // Bounded, and only the session route hands out a token.
    const text = JSON.stringify(response.body);
    expect(text.length).toBeLessThan(MAX_AGENT_RESPONSE_BYTES);
    expect(text.includes('"token"')).toBe(route === "session" && body.ok);
  });
});

describe("rejected agent requests", () => {
  it.each(REJECTED.filter((r) => r.stage === "shape"))(
    "$route refuses by shape: $name",
    ({ route, body }) => {
      expect(() => parseAgentRequest(route, body)).toThrow(TypeError);
    },
  );

  it.each(REJECTED.filter((r) => r.stage === "invariant"))(
    "$route refuses by invariant: $name",
    ({ route, body }) => {
      const pair = parseAgentRequest(route, body);
      expect(() => validateAgentRequest(pair)).toThrow(Error);
      expect(() => validateAgentRequest(pair)).not.toThrow(TypeError);
    },
  );

  it("names a stage for every rejected request", () => {
    expect(REJECTED.filter((r) => r.stage !== "shape" && r.stage !== "invariant")).toEqual([]);
  });
});

describe("query and path parameters", () => {
  it("defaults the inbox page and accepts its bounds", () => {
    expect(parseInboxLimit(null)).toBe(16);
    expect(parseInboxLimit("1")).toBe(1);
    expect(parseInboxLimit(String(MAX_INBOX_PAGE))).toBe(MAX_INBOX_PAGE);
  });

  it.each(["0", "65", "", " 1", "1e1", "0x10", "1.0", "01", "-1"])(
    "refuses inbox limit %j",
    (value) => {
      expect(() => parseInboxLimit(value)).toThrow(/limit/);
    },
  );

  it("accepts a wait up to the long-poll limit and no further", () => {
    expect(parseWaitMs(null)).toBe(0);
    expect(parseWaitMs(String(MAX_LONG_POLL_MS))).toBe(MAX_LONG_POLL_MS);
    expect(() => parseWaitMs(String(MAX_LONG_POLL_MS + 1))).toThrow(/waitMs/);
  });

  it("accepts the largest safe item number and refuses the next", () => {
    expect(parseItemNumber("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseItemNumber("9007199254740992")).toThrow(/item/);
    expect(() => parseItemNumber("0")).toThrow(/item/);
  });
});

describe("events on the wire", () => {
  /** Every event type, checked for exhaustiveness by the compiler. */
  const ALL_TYPES: Record<EventType, true> = {
    "agent.invited": true,
    "agent.joined": true,
    "agent.confirmed": true,
    "agent.revoked": true,
    "issue.filed": true,
    "claim.opened": true,
    "claim.pushed": true,
    "claim.ready": true,
    "claim.refused": true,
    "claim.reopened": true,
    "claim.expired": true,
    "claim.reassigned": true,
    "question.asked": true,
    "decision.recorded": true,
    "inbox.queued": true,
    "inbox.delivered": true,
    "inbox.acked": true,
    "train.check": true,
    "train.conflict": true,
    "train.intent": true,
    "train.main": true,
  };

  it("has one valid fixture for every event type", () => {
    const types = events.valid.map((event) => parseEvent(event).type);
    expect(types.toSorted()).toEqual(Object.keys(ALL_TYPES).toSorted());
  });

  it.each(events.valid.map((event) => [event.type, event] as const))(
    "accepts and round-trips %s",
    (_type, value) => {
      const event = parseEvent(value);
      expect(() => validateEvent(event)).not.toThrow();
      expect(JSON.parse(JSON.stringify(event))).toEqual(value);
    },
  );

  it("accepts the largest safe sequence number", () => {
    expect(() => validateEvent(parseEvent(events.largestSafeSeq))).not.toThrow();
  });

  it.each(events.rejectedShape)("refuses by shape: $name", ({ value }) => {
    expect(() => parseEvent(value)).toThrow(TypeError);
  });

  it.each(events.rejectedInvariant)("refuses by invariant: $name", ({ value, error }) => {
    const event = parseEvent(value);
    expect(() => validateEvent(event)).toThrow(error);
  });
});

describe("login and join signing", () => {
  it("builds the login message byte for byte", () => {
    expect(loginMessage(auth.login.fields)).toBe(auth.login.message);
    expect(challenge.exchanges[0]?.response.body).toMatchObject({
      data: { message: auth.login.message },
    });
  });

  it("builds the join message byte for byte", () => {
    expect(joinMessage(auth.join.fields)).toBe(auth.join.message);
  });

  it("signs both messages in the reserved namespace", () => {
    expect(auth.signingNamespace).toBe(SIGNING_NAMESPACE);
    expect(sshsigNamespace(auth.login.signature)).toBe(SIGNING_NAMESPACE);
    expect(sshsigNamespace(auth.join.signature)).toBe(SIGNING_NAMESPACE);
    expect(sshsigNamespace(auth.rejectedSignatures[0]?.signature ?? "")).toBe("git");
  });

  it("carries the real signatures in the join and session requests", () => {
    expect(join.exchanges[0]?.request.body).toMatchObject({ signature: auth.join.signature });
    expect(session.exchanges[0]?.request.body).toMatchObject({ signature: auth.login.signature });
  });

  it.each(auth.confirmationCodes)(
    "derives confirmation code $code for $key and $inviteId",
    async ({ key, inviteId, code }) => {
      const publicKey =
        key === "rfc8032-test1" ? auth.keys["rfc8032-test1"] : auth.keys["rfc8032-test2"];
      expect(await confirmationCode(publicKey.publicKey, inviteId)).toBe(code);
    },
  );

  it("shows the code derived from the joining key and invite", () => {
    const vector = auth.confirmationCodes[0];
    expect(join.exchanges[0]?.response.body).toMatchObject({ data: { code: vector?.code } });
  });
});

/**
 * An independent reading of the `CONFIRM_DOMAIN` derivation documented in `agent-api`, checked
 * against vectors computed in Python.
 */
async function confirmationCode(publicKeyLine: string, inviteId: string): Promise<string> {
  const blob = fromBase64(publicKeyLine.split(" ")[1] ?? "");
  const encoder = new TextEncoder();
  const input = [encoder.encode(CONFIRM_DOMAIN), blob, encoder.encode(inviteId)].flatMap((part) => {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, part.length);
    return [...length, ...part];
  });
  const digest = new DataView(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
  return (digest.getBigUint64(0) % 1_000_000n).toString().padStart(6, "0");
}

/** The namespace field of an armored SSHSIG: after the magic, version and public key. */
function sshsigNamespace(armored: string): string {
  const base64 = armored
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("-----"))
    .join("");
  const bytes = fromBase64(base64);
  const view = new DataView(bytes.buffer);
  const keyLength = view.getUint32(10);
  const namespaceAt = 14 + keyLength;
  const namespaceLength = view.getUint32(namespaceAt);
  return new TextDecoder().decode(
    bytes.subarray(namespaceAt + 4, namespaceAt + 4 + namespaceLength),
  );
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** A human grant for `action`, as the owner module would build it. */
function grant<A extends OwnerAction>(action: A): HumanGrant<A> {
  return { kind: "human", userId: "usr_lemarier", repoId: "rep_demo0001", grantId: "g1", action };
}

describe("unavailable ports", () => {
  const agent: AgentPrincipal = {
    kind: "agent",
    agentId: "agt_atlas01",
    ownerId: "usr_lemarier",
    repoId: "rep_demo0001",
  };
  const sha = "a".repeat(40);
  const pin = { claimId: "clm_42abcd", generation: 1, commit: sha };

  const calls: [string, () => Promise<PortResult<unknown>>][] = [
    [
      "identity.join",
      () =>
        unavailableIdentity.join({
          inviteId: "inv_abc123",
          inviteSecret: "s".repeat(43),
          publicKey: auth.join.fields.publicKey,
          signature: auth.join.signature,
        }),
    ],
    [
      "identity.createInvite",
      () => unavailableIdentity.createInvite(grant({ kind: "invite.create", name: "atlas" })),
    ],
    [
      "identity.confirm",
      () =>
        unavailableIdentity.confirm(
          grant({ kind: "agent.confirm", agentId: "agt_atlas01", code: "915893" }),
        ),
    ],
    [
      "identity.revoke",
      () => unavailableIdentity.revoke(grant({ kind: "agent.revoke", agentId: "agt_atlas01" })),
    ],
    ["identity.pendingJoins", () => unavailableIdentity.pendingJoins()],
    [
      "sessions.issueChallenge",
      () => unavailableSessions.issueChallenge({ agentId: "agt_atlas01" }),
    ],
    [
      "sessions.redeem",
      () =>
        unavailableSessions.redeem({
          agentId: "agt_atlas01",
          challengeId: "chl_3q27HkVb0nZ8pXa1",
          signature: auth.login.signature,
        }),
    ],
    ["sessions.authenticate", () => unavailableSessions.authenticate("a.b.c")],
    ["claims.activeClaim", () => unavailableClaims.activeClaim(agent)],
    ["claims.work", () => unavailableClaims.work(agent)],
    ["claims.claim", () => unavailableClaims.claim(agent, "iss_upload1")],
    [
      "claims.ready",
      () => unavailableClaims.ready(agent, "clm_42abcd", { generation: 1, commit: sha }),
    ],
    ["claims.pin", () => unavailableClaims.pin("clm_42abcd")],
    [
      "claims.authorizeGit",
      () =>
        unavailableClaims.authorizeGit({
          principal: agent,
          target: { kind: "fork", claimId: "clm_42abcd" },
          operation: "push",
        }),
    ],
    [
      "claims.fileIssue",
      () => unavailableClaims.fileIssue(grant({ kind: "issue.file", title: "t", body: "" })),
    ],
    ["inbox.pending", () => unavailableInbox.pending(agent, 16)],
    ["inbox.digest", () => unavailableInbox.digest(agent)],
    ["inbox.ack", () => unavailableInbox.ack(agent, 17, "plan")],
    ["inbox.readyGate", () => unavailableInbox.readyGate("clm_42abcd", 1)],
    [
      "decisions.ask",
      () =>
        unavailableDecisions.ask(agent, "clm_42abcd", {
          generation: 1,
          requestId: "req_upload0000000001",
          text: "q",
          options: [],
          scope: [],
        }),
    ],
    ["decisions.question", () => unavailableDecisions.question(agent, "qst_upload1", 0)],
    [
      "decisions.record",
      () =>
        unavailableDecisions.record(
          grant({
            kind: "decision.record",
            decisionId: "dec_upload1",
            option: "chunk",
            expectedVersion: 1,
          }),
        ),
    ],
    ["decisions.requirements", () => unavailableDecisions.requirements("clm_42abcd")],
    ["artifacts.forkForClaim", () => unavailableArtifacts.forkForClaim("clm_42abcd", sha)],
    ["artifacts.commitExists", () => unavailableArtifacts.commitExists("repo", sha)],
    ["artifacts.token", () => unavailableArtifacts.token("repo", "write", 60_000)],
    ["artifacts.revokeTokens", () => unavailableArtifacts.revokeTokens("repo")],
    ["merge.compose", () => unavailableMerge.compose(sha, [pin], "mrg_attempt1")],
    ["merge.discard", () => unavailableMerge.discard("mrg_attempt1")],
    [
      "checks.start",
      () =>
        unavailableChecks.start({
          attemptId: "chk_run0001",
          expectedMain: sha,
          candidate: sha,
          pins: [pin],
          definition: { name: "test", source: sha, digest: "0".repeat(64), acceptance: null },
          decisions: [],
          createdAt: 1,
        }),
    ],
    ["train.enqueue", () => unavailableTrain.enqueue(pin)],
    [
      "train.recordCheck",
      () =>
        unavailableTrain.recordCheck({
          attemptId: "chk_run0001",
          candidate: sha,
          result: "pass",
          logDigest: null,
          finishedAt: 1,
        }),
    ],
    ["authorization.authorize", () => unavailableAuthorization.authorize("chk_run0001")],
    ["authorization.intent", () => unavailableAuthorization.intent("int_merge01")],
    ["mainRef.read", () => unavailableMainRef.read()],
    ["mainRef.update", () => unavailableMainRef.update(sha, "b".repeat(40))],
    ["mainWriter.publish", () => unavailableMainWriter.publish("int_merge01")],
  ];

  it.each(calls)("%s refuses with unavailable", async (_name, call) => {
    const result = await call();
    expect(result).toEqual({ ok: false, code: "unavailable", message: expect.any(String) });
  });

  it("never clears the ready gate or grants Git access by default", async () => {
    const gate = await unavailableInbox.readyGate("clm_42abcd", 1);
    const git = await unavailableClaims.authorizeGit({
      principal: null,
      target: { kind: "main" },
      operation: "fetch",
    });
    expect([gate.ok, git.ok]).toEqual([false, false]);
  });
});
