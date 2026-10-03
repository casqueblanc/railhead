import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_AGENT_REQUEST_BYTES,
  type AgentRouteName,
  type AgentView,
  type ClaimResult,
  type ClaimView,
  type InboxDigest,
} from "@railhead/shared/agent-api";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import type { BoardListener, BoardResult } from "@railhead/shared/board-api";
import type { Actor, EventPayload, RailheadEvent } from "@railhead/shared/events";
import type { AgentPrincipal } from "../src/contracts/principals";
import { fail, ok, type PortResult } from "../src/contracts/result";
import { parseAgentResponse } from "../src/contracts/wireShape";
import { dispatchAgent, type AgentCommand } from "../src/gateway/agentDispatch";
import { composeRepo, resumables, resumeAll, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";

const ORIGIN = "https://railhead.invalid";
const HUMAN: Actor = { kind: "human", id: "usr_lemarier" };
const AGENT: AgentPrincipal = {
  kind: "agent",
  agentId: "agt_atlas01",
  ownerId: "usr_lemarier",
  repoId: "rep_other01",
};
const TOKEN = "aaaa.bbbb.cccc";
const VIEW: AgentView = {
  agentId: AGENT.agentId,
  name: "atlas",
  ownerId: AGENT.ownerId,
  state: "confirmed",
};
const CLAIM = "clm_claim001";

function issue(n: number): EventPayload {
  return {
    type: "issue.filed",
    data: { issueId: `iss_issue${String(n).padStart(4, "0")}`, title: `Issue ${n}`, body: "" },
  };
}

/** A repository segment no other test uses. */
function uniqueName(): string {
  return `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function repoStub(org: string, name: string): DurableObjectStub<Repo> {
  return env.REPO.getByName(repoObjectName(org, name));
}

/** Initializes a fresh repository `acme/<unique>` and returns its name and stub. */
async function freshRepo(): Promise<{
  name: string;
  stub: DurableObjectStub<Repo>;
  repoId: string;
}> {
  const name = uniqueName();
  const stub = repoStub("acme", name);
  const summary = await stub.initialize("acme", name);
  if (!summary.ok) throw new Error(summary.code);
  return { name, stub, repoId: summary.value.repoId };
}

/** Appends `count` issues inside the Repo, as a module would. */
async function appendIssues(stub: DurableObjectStub<Repo>, repoId: string, count: number) {
  await runInDurableObject(stub, (_instance, state) => {
    const log = EventLog.open(state.storage, repoId);
    log.transaction((tx) => {
      for (let n = 1; n <= count; n += 1) tx.append(HUMAN, issue(n));
    });
  });
}

function logHead(stub: DurableObjectStub<Repo>, repoId: string): Promise<number> {
  return runInDurableObject(stub, (_instance, state) =>
    EventLog.open(state.storage, repoId).head(),
  );
}

async function openSession(): Promise<WebSocket> {
  const response = await SELF.fetch(`${ORIGIN}${API_PATH}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return socket;
}

function value<T>(result: BoardResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
}

function agentRequest(
  name: string,
  path: string,
  init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/agent/v1/acme/${name}${path}`, {
    method: init.method ?? "POST",
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: init.headers ?? {},
  });
}

/** Reads an agent response, checking its shape against the wire contract for `route`. */
async function agentError(response: Response, route: AgentRouteName): Promise<string> {
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  const pair = parseAgentResponse(route, await response.json());
  if (pair.response.ok) throw new Error("expected an error response");
  return pair.response.error.code;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const VALID_JOIN = JSON.stringify({
  inviteId: "inv_invite01",
  inviteSecret: "A".repeat(43),
  publicKey: `ssh-ed25519 ${"A".repeat(68)}`,
  signature: "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n",
});

describe("Repo Durable Object", () => {
  it("keeps its repository and log across eviction and a new stub", async () => {
    const { name, stub, repoId } = await freshRepo();
    expect(repoId).toMatch(/^rep_[0-9a-f]{64}$/);
    await appendIssues(stub, repoId, 2);

    await evictDurableObject(stub);
    const again = repoStub("acme", name);

    expect(await again.describe()).toEqual({ repoId, org: "acme", name });
    const page = await again.readEvents(0, 10);
    if (!page.ok) throw new Error(page.code);
    expect(page.value.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(page.value).toMatchObject({ repo: repoId, cursor: 2, head: 2 });
    // A repeat of initialize returns the same repository and appends nothing.
    expect(await again.initialize("acme", name)).toEqual({
      ok: true,
      value: { repoId, org: "acme", name },
    });
    expect(await logHead(again, repoId)).toBe(2);
  });

  it("answers an uninitialized name with not_found and writes no storage", async () => {
    const stub = repoStub("acme", uniqueName());

    expect(await stub.describe()).toBeNull();
    expect(await stub.readEvents(0, 1)).toMatchObject({ ok: false, code: "not_found" });
    expect(await stub.pendingJoins()).toMatchObject({ ok: false, code: "not_found" });
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
        .filter((table) => !table.startsWith("_cf")),
    );
    expect(tables).toEqual([]);
  });

  it("refuses to initialize under another name or with invalid segments", async () => {
    const { name, stub } = await freshRepo();
    const other = uniqueName();

    const fresh = repoStub("acme", other);

    expect(await fresh.initialize("acme", uniqueName())).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(await repoStub("acme", "Bad_Name").initialize("acme", "Bad_Name")).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(await stub.initialize("acme", other)).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    // Neither refusal recorded anything.
    expect(await fresh.describe()).toBeNull();
    expect(await stub.describe()).toMatchObject({ name });
  });

  it("bounds a page and refuses a cursor past the head", async () => {
    const { stub, repoId } = await freshRepo();
    await appendIssues(stub, repoId, 1);

    expect(await stub.readEvents(0, 0)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await stub.readEvents(0, 257)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await stub.readEvents(-1, 1)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await stub.readEvents(2, 1)).toMatchObject({ ok: false, code: "cursor_ahead" });
    expect(await stub.readEvents(1, 256)).toMatchObject({
      ok: true,
      value: { events: [], cursor: 1, head: 1 },
    });
  });
});

describe("unavailable modules", () => {
  it("refuse every port with unavailable and never report success", async () => {
    const { stub, repoId } = await freshRepo();
    const results = await runInDurableObject(stub, async (_instance, state) => {
      const ports = composeRepo({
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: () => 0,
        env,
        wake: () => {},
      });
      return Promise.all([
        ports.checks.start({
          attemptId: "chk_attempt1",
          expectedMain: "a".repeat(40),
          candidate: "b".repeat(40),
          pins: [],
          definition: {
            name: "test",
            source: "a".repeat(40),
            digest: "c".repeat(64),
            acceptance: null,
          },
          decisions: [],
          createdAt: 0,
        }),
        ports.authorization.authorize("chk_attempt1"),
        ports.mainWriter.publish("int_intent01"),
        ports.claims.authorizeGit({
          principal: null,
          target: { kind: "main" },
          operation: "fetch",
        }),
        ports.sessions.authenticate(TOKEN),
        // Decisions is installed, but asking needs the claims module to confirm the claim.
        ports.decisions.ask(
          { kind: "agent", agentId: "agt_atlas01", ownerId: "usr_lemarier", repoId },
          CLAIM,
          {
            generation: 1,
            requestId: "req_upload0000000001",
            text: "Reject or chunk?",
            options: [
              { key: "reject", label: "Reject" },
              { key: "chunk", label: "Chunk" },
            ],
            scope: ["src/upload.ts"],
          },
        ),
        ports.stream.subscribe(0, { events: async () => {}, ended: async () => {} }),
      ]);
    });

    for (const result of results) expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(await logHead(stub, repoId)).toBe(0);
  });
});

/**
 * Runs `body` with the composed, unavailable ports of a fresh repository, overriding the three
 * the `work` route reaches. `calls` records which of them ran.
 */
async function withFakePorts<R>(
  overrides: {
    authenticate?: PortResult<AgentPrincipal>;
    view?: PortResult<AgentView>;
    activeClaim?: PortResult<ClaimView | null>;
    work?: PortResult<ClaimResult>;
    digest?: PortResult<InboxDigest>;
  },
  body: (ports: RepoPorts, calls: string[]) => Promise<R>,
): Promise<R> {
  const { stub, repoId } = await freshRepo();
  return runInDurableObject(stub, (_instance, state) => {
    const real = composeRepo({
      repoId,
      storage: state.storage,
      log: EventLog.open(state.storage, repoId),
      clock: () => 0,
      env,
      wake: () => {},
    });
    const calls: string[] = [];
    const ports: RepoPorts = {
      ...real,
      sessions: {
        ...real.sessions,
        authenticate: async () => {
          calls.push("authenticate");
          return overrides.authenticate ?? ok(AGENT);
        },
      },
      identity: {
        ...real.identity,
        view: async () => {
          calls.push("view");
          return overrides.view ?? ok(VIEW);
        },
      },
      claims: {
        ...real.claims,
        activeClaim: async () => {
          calls.push("activeClaim");
          return overrides.activeClaim ?? ok(null);
        },
        work: async () => {
          calls.push("work");
          return overrides.work ?? fail("no_work", "Nothing is ready.");
        },
      },
      inbox: {
        ...real.inbox,
        digest: async () => {
          calls.push("digest");
          return overrides.digest ?? ok({ items: [], pending: 0 });
        },
      },
    };
    return body(ports, calls);
  });
}

describe("Repo alarm", () => {
  it("resumes every module after one throws, logging the failure by name only", async () => {
    const order: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await resumeAll("rep_alarm0001", [
        {
          module: "train",
          resume: async () => {
            order.push("train");
            throw new TypeError("secret port text");
          },
        },
        {
          module: "sandbox",
          resume: async () => {
            order.push("sandbox");
          },
        },
      ]);
      expect(order).toEqual(["train", "sandbox"]);
      expect(logged.mock.calls).toEqual([
        [
          JSON.stringify({
            event: "repo.resume_failed",
            repo: "rep_alarm0001",
            module: "train",
            error: "TypeError",
          }),
        ],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("resumes nothing for an empty list and lists the train for a composed Repo", async () => {
    await expect(resumeAll("rep_alarm0001", [])).resolves.toBeUndefined();
    const { stub, repoId } = await freshRepo();
    const modules = await runInDurableObject(stub, (_instance, state) =>
      resumables(
        composeRepo({
          repoId,
          storage: state.storage,
          log: EventLog.open(state.storage, repoId),
          clock: () => 0,
          env,
          wake: () => {},
        }),
      ).map((entry) => entry.module),
    );
    expect(modules).toEqual(["train"]);
  });
});

describe("agent dispatch", () => {
  const work: AgentCommand = { route: "work" };

  const claim: ClaimResult = {
    claim: {
      claimId: CLAIM,
      issueId: "iss_issue0001",
      generation: 1,
      base: "a".repeat(40),
      state: "working",
      readyCommit: null,
      originUrl: `${ORIGIN}/git/acme/widgets/claims/${CLAIM}.git`,
      upstreamUrl: `${ORIGIN}/git/acme/widgets.git`,
      task: { title: "Issue 1", body: "" },
    },
    resumed: false,
  };

  it("runs the command for an agent of this repository and piggybacks its inbox", async () => {
    await withFakePorts(
      { work: ok(claim), digest: ok({ items: [], pending: 3 }) },
      async (ports, calls) => {
        const reply = await dispatchAgent(
          { repoId: AGENT.repoId, ports },
          { command: work, token: TOKEN },
        );

        expect(reply).toEqual({
          ok: true,
          data: claim,
          inbox: { items: [], pending: 3 },
          next: null,
        });
        expect(calls).toEqual(["authenticate", "work", "digest"]);
      },
    );
  });

  it("refuses a session bound to another repository before running anything", async () => {
    await withFakePorts({ work: ok(claim) }, async (ports, calls) => {
      const reply = await dispatchAgent(
        { repoId: "rep_mine0001", ports },
        { command: work, token: TOKEN },
      );

      expect(reply).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      expect(calls).toEqual(["authenticate"]);
    });
  });

  it("refuses a missing token without authenticating", async () => {
    await withFakePorts({}, async (ports, calls) => {
      const reply = await dispatchAgent(
        { repoId: AGENT.repoId, ports },
        { command: work, token: null },
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: "unauthenticated", retryable: false },
      });
      expect(calls).toEqual([]);
    });
  });

  it("answers status with the identity's view and the active claim", async () => {
    await withFakePorts({ activeClaim: ok(claim.claim) }, async (ports, calls) => {
      const reply = await dispatchAgent(
        { repoId: AGENT.repoId, ports },
        { command: { route: "status" }, token: TOKEN },
      );

      expect(reply).toEqual({
        ok: true,
        data: { agent: VIEW, claim: claim.claim },
        inbox: { items: [], pending: 0 },
        next: null,
      });
      expect(calls).toEqual(["authenticate", "view", "activeClaim", "digest"]);
    });
  });

  it("refuses status when the identity or the claims module refuses", async () => {
    await withFakePorts({ view: fail("identity_revoked", "Revoked.") }, async (ports, calls) => {
      expect(
        await dispatchAgent(
          { repoId: AGENT.repoId, ports },
          { command: { route: "status" }, token: TOKEN },
        ),
      ).toMatchObject({ ok: false, error: { code: "identity_revoked" } });
      expect(calls).toEqual(["authenticate", "view"]);
    });
    await withFakePorts({ activeClaim: fail("unavailable", "Claims are down.") }, async (ports) => {
      expect(
        await dispatchAgent(
          { repoId: AGENT.repoId, ports },
          { command: { route: "status" }, token: TOKEN },
        ),
      ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
  });

  it("reports a failed digest as an error, never success", async () => {
    await withFakePorts(
      { work: ok(claim), digest: fail("unavailable", "Inbox is down.") },
      async (ports) => {
        expect(
          await dispatchAgent({ repoId: AGENT.repoId, ports }, { command: work, token: TOKEN }),
        ).toMatchObject({ ok: false, error: { code: "unavailable" } });
      },
    );
  });

  it("reports a code outside the agent wire as internal, without its message", async () => {
    await withFakePorts({ work: fail("check_mismatch", "Internal detail.") }, async (ports) => {
      expect(
        await dispatchAgent({ repoId: AGENT.repoId, ports }, { command: work, token: TOKEN }),
      ).toEqual({
        ok: false,
        error: {
          code: "internal",
          message: "The backend failed.",
          retryable: true,
          retryAfterMs: null,
          next: null,
        },
      });
    });
  });
});

describe("agent HTTP routes", () => {
  it("dispatch a valid join to the identity module, which refuses an invite it never issued and changes nothing", async () => {
    const { name, stub, repoId } = await freshRepo();

    const response = await agentRequest(name, "/join", { body: VALID_JOIN, headers: JSON_HEADERS });

    expect(response.status).toBe(403);
    expect(await agentError(response, "join")).toBe("join_refused");
    expect(await logHead(stub, repoId)).toBe(0);
  });

  it("ignore actor fields in a body: identity comes only from the session", async () => {
    const { name, stub, repoId } = await freshRepo();
    const body = JSON.stringify({
      issueId: "iss_issue0001",
      actor: { kind: "system", id: "sys_train01" },
      principal: { kind: "human", userId: "usr_lemarier" },
    });

    const anonymous = await agentRequest(name, "/claims", { body, headers: JSON_HEADERS });
    expect(anonymous.status).toBe(401);
    expect(await agentError(anonymous, "claim")).toBe("unauthenticated");

    const withToken = await agentRequest(name, "/claims", {
      body,
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${TOKEN}` },
    });
    expect(withToken.status).toBe(503);
    expect(await agentError(withToken, "claim")).toBe("unavailable");
    expect(await logHead(stub, repoId)).toBe(0);
  });

  it("refuse malformed requests before they reach the Repo", async () => {
    const { name, stub, repoId } = await freshRepo();
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    const cases: [Promise<Response>, number, string][] = [
      [
        agentRequest(name, "/join", {
          body: VALID_JOIN,
          headers: { "Content-Type": "text/plain" },
        }),
        415,
        "unsupported_media_type",
      ],
      // A streamed body declares no length, so its type is checked once it has been read.
      [
        agentRequest(name, "/join", {
          body: new Blob([VALID_JOIN]).stream(),
          headers: { "Content-Type": "text/plain" },
        }),
        415,
        "unsupported_media_type",
      ],
      [agentRequest(name, "/join", { body: "{", headers: JSON_HEADERS }), 400, "invalid_request"],
      [
        agentRequest(name, "/join", {
          body: JSON.stringify({ inviteId: 1 }),
          headers: JSON_HEADERS,
        }),
        400,
        "invalid_request",
      ],
      [
        agentRequest(name, "/join", {
          body: JSON.stringify({ ...JSON.parse(VALID_JOIN), inviteSecret: "short" }),
          headers: JSON_HEADERS,
        }),
        400,
        "invalid_request",
      ],
      [
        agentRequest(name, "/join", {
          body: "x".repeat(MAX_AGENT_REQUEST_BYTES + 1),
          headers: JSON_HEADERS,
        }),
        413,
        "payload_too_large",
      ],
      [
        agentRequest(name, "/claims/not-a-claim/ready", {
          body: JSON.stringify({ generation: 1, commit: "a".repeat(40) }),
          headers: { ...JSON_HEADERS, ...bearer },
        }),
        400,
        "invalid_request",
      ],
      [
        agentRequest(name, "/inbox?limit=0", { method: "GET", headers: bearer }),
        400,
        "invalid_request",
      ],
      [
        agentRequest(name, "/questions/qst_question1?waitMs=25001", {
          method: "GET",
          headers: bearer,
        }),
        400,
        "invalid_request",
      ],
      [
        agentRequest(name, "/work", { headers: { Authorization: "Bearer not a token" } }),
        401,
        "unauthenticated",
      ],
      [agentRequest(name, "/status", { method: "POST" }), 404, "not_found"],
      [agentRequest(name, "/nowhere"), 404, "not_found"],
    ];

    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      expect(await agentError(response, "join")).toBe(code);
    }
    expect(await logHead(stub, repoId)).toBe(0);
  });

  it("accept exactly the largest body and a work call with no body", async () => {
    const { name } = await freshRepo();
    // Padding inside the JSON makes the body exactly the limit; it is valid, so it reaches the Repo.
    const base = JSON.parse(VALID_JOIN);
    const filler = MAX_AGENT_REQUEST_BYTES - JSON.stringify({ ...base, pad: "" }).length;
    const body = JSON.stringify({ ...base, pad: " ".repeat(filler) });
    expect(new TextEncoder().encode(body).length).toBe(MAX_AGENT_REQUEST_BYTES);

    const join = await agentRequest(name, "/join", { body, headers: JSON_HEADERS });
    expect(await agentError(join, "join")).toBe("join_refused");

    const work = await agentRequest(name, "/work", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(work.status).toBe(503);
    expect(await agentError(work, "work")).toBe("unavailable");
  });

  it("answer a repository nobody initialized with not_found", async () => {
    const response = await agentRequest(uniqueName(), "/join", {
      body: VALID_JOIN,
      headers: JSON_HEADERS,
    });

    expect(response.status).toBe(404);
    expect(await agentError(response, "join")).toBe("not_found");
  });
});

describe("Git routes", () => {
  it("reach the missing Git module for main and for a claim's fork", async () => {
    const { name } = await freshRepo();

    for (const path of [
      `/git/acme/${name}.git/info/refs`,
      `/git/acme/${name}/claims/${CLAIM}.git/git-receive-pack`,
    ]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("The git module is not available.\n");
    }
  });

  it("answer 404 for an invalid remote or an unknown repository", async () => {
    const { name } = await freshRepo();

    expect((await SELF.fetch(`${ORIGIN}/git/acme/${name}/claims/nope.git/info/refs`)).status).toBe(
      404,
    );
    expect((await SELF.fetch(`${ORIGIN}/git/Acme/${name}.git/info/refs`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/git/acme/${uniqueName()}.git/info/refs`)).status).toBe(404);
  });
});

describe("board RPC lifecycle", () => {
  it("pages the log, then resumes from its cursor in a new session after eviction", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIssues(stub, repoId, 3);

    let cursor: number;
    {
      using api = newWebSocketRpcSession<RailheadApi>(await openSession());
      using board = value(await api.openBoard("acme", name));
      const first = value(await board.readEvents(0, 2));
      expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(first).toMatchObject({ repo: repoId, cursor: 2, head: 3 });
      const second = value(await board.readEvents(first.cursor, 2));
      expect(second.events.map((event) => event.seq)).toEqual([3]);
      cursor = second.cursor;
    }

    await evictDurableObject(stub);
    await appendIssues(stub, repoId, 1);

    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));
    const resumed = value(await board.readEvents(cursor, 256));
    expect(resumed.events.map((event: RailheadEvent) => event.seq)).toEqual([4]);
    expect(await board.readEvents(5, 1)).toMatchObject({ ok: false, code: "cursor_ahead" });
  });

  it("answers the module-backed calls with unavailable", async () => {
    const { name } = await freshRepo();
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));

    class Listener extends RpcTarget implements BoardListener {
      async events(): Promise<void> {}
      async ended(): Promise<void> {}
    }
    expect(await board.subscribe(0, new Listener())).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    using owner = await board.owner();
    expect(await owner.prepare({ kind: "agent.revoke", agentId: "agt_atlas01" })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    using enrollment = await api.ownerEnrollment();
    expect(await enrollment.prepare("bootstrap")).toMatchObject({
      ok: false,
      code: "bootstrap_closed",
    });
  });

  /** A client that tries methods and argument types the public interface does not declare. */
  interface HostileBoard extends RpcTarget {
    readEvents(cursor: unknown, limit: unknown): Promise<BoardResult<unknown>>;
    append(actor: unknown, payload: unknown): Promise<void>;
  }
  interface HostileApi extends RpcTarget {
    openBoard(org: string, repo: string): Promise<BoardResult<HostileBoard>>;
    append(event: unknown): Promise<void>;
    execute(command: unknown, actor: unknown): Promise<void>;
  }

  it("refuses invalid and unknown repositories and offers no way to append or act as someone", async () => {
    const { name, stub, repoId } = await freshRepo();
    using api = newWebSocketRpcSession<HostileApi>(await openSession());

    expect(await api.openBoard("Acme", name)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await api.openBoard("acme", "../x")).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(await api.openBoard("acme", uniqueName())).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await expect(api.append({ type: "issue.filed" })).rejects.toThrow(TypeError);
    await expect(api.execute({}, { kind: "system", id: "sys_train01" })).rejects.toThrow(TypeError);

    using board = value(await api.openBoard("acme", name));
    await expect(board.append(HUMAN, issue(1))).rejects.toThrow(TypeError);
    // The generated validator refuses a wrong type before the Repo is reached.
    await expect(board.readEvents("0", 1)).rejects.toThrow(TypeError);
    expect(await board.readEvents(0.5, 1)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await logHead(stub, repoId)).toBe(0);
  });
});
