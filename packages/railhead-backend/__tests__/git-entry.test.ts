// The Git gateway as the Worker assembles it: requests enter through `SELF`, reach the repository's
// `Repo` and its composed modules, with the real sessions, claims and Artifacts adapter. Only the
// `ARTIFACTS` binding, which the pool cannot reach, is replaced by a fake before the Repo installs
// its modules, and the outbound Git endpoint is a stubbed `fetch`.

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PATH_PREFIX,
  joinMessage,
  type AgentResponse,
  type ChallengeResult,
  type ClaimResult,
  type SessionResult,
} from "@railhead/shared/agent-api";
import type { OwnerAction } from "@railhead/shared/board-api";
import { mainRepoName, type ArtifactsRepoHandle } from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { GrantFor } from "../src/contracts/principals";
import { ok, type PortResult } from "../src/contracts/result";
import { composeRepo } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";
import { AgentKey } from "./agentKey";
import { pkt } from "./sliceWorld";

const ORIGIN = "https://railhead.mashin.workers.dev";
const ORG = "acme";
const USER = "usr_owner01";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const ZERO = "0".repeat(40);
const PUSHED = "3".repeat(40);
const FEATURE = "refs/heads/feature";
const decoder = new TextDecoder();

afterEach(() => {
  vi.restoreAllMocks();
});

/** One request the stubbed Git endpoint received. */
interface Seen {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

/** A repository whose Worker reaches the fake Artifacts namespace, with one logged-in agent. */
interface Setup {
  readonly name: string;
  readonly repoId: string;
  readonly stub: DurableObjectStub<Repo>;
  readonly fake: FakeArtifacts;
  readonly mainName: string;
  readonly agentId: string;
  readonly token: string;
  /** What the stubbed Git endpoint received, in order. */
  readonly seen: Seen[];
  /** How the endpoint answers a receive-pack POST that carries a live token. */
  pushAnswer: () => Response;
}

function advertisement(service: string, refs: string): Response {
  return new Response(`${pkt(`# service=${service}\n`)}0000${refs}0000`, {
    headers: { "content-type": `application/x-${service}-advertisement` },
  });
}

function gitResult(service: string, body: string): Response {
  return new Response(body, { headers: { "content-type": `application/x-${service}-result` } });
}

/** The fake binding with `info`, which the gateway reads each repository's remote from. */
function withInfo(fake: FakeArtifacts) {
  return {
    async get(
      name: string,
    ): Promise<ArtifactsRepoHandle & { info(): Promise<{ remote: string }> }> {
      const handle = await fake.get(name);
      return Object.assign(handle, {
        info: async () => ({ remote: `https://artifacts.invalid/${name}.git` }),
      });
    },
  };
}

/** The Worker's bindings with `ARTIFACTS` replaced by the fake. */
function withFakeArtifacts(fake: FakeArtifacts): Env {
  const replaced = { ...env };
  Reflect.set(replaced, "ARTIFACTS", withInfo(fake));
  return replaced;
}

function value<T>(result: PortResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.value;
}

function grant<K extends OwnerAction["kind"]>(
  repoId: string,
  action: Extract<OwnerAction, { kind: K }>,
): GrantFor<K> {
  return { kind: "human", userId: USER, repoId, grantId: crypto.randomUUID(), action };
}

/**
 * Initializes a fresh repository whose Repo installed its modules over the fake namespace, enrolls
 * and logs in one agent over HTTP, files one issue and stubs the outbound Git endpoint.
 */
async function setUp(): Promise<Setup> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName(ORG, name));
  // Tokens are dated by the Repo's clock, so the fake starts at the real time.
  const fake = new FakeArtifacts(Date.now());
  await runInDurableObject(stub, (instance) => {
    Reflect.set(instance, "env", withFakeArtifacts(fake));
  });
  const { repoId } = value(await stub.initialize(ORG, name));
  const mainName = await mainRepoName(repoId);
  fake.seed(mainName, [ROOT, HEAD]);

  const key = await AgentKey.create();
  const agentId = await runInDurableObject(stub, async (_instance, state) => {
    const { identity, claims } = composeRepo({
      repoId,
      storage: state.storage,
      log: EventLog.open(state.storage, repoId),
      clock: Date.now,
      env,
      wake: async () => true,
    });
    const created = value(
      await identity.createInvite(grant(repoId, { kind: "invite.create", name: "atlas" })),
    );
    const [inviteId = "", inviteSecret = ""] =
      /\/(inv_[0-9a-f]+)#(.+)$/.exec(created.inviteUrl)?.slice(1) ?? [];
    const joined = value(
      await identity.join({
        inviteId,
        inviteSecret,
        publicKey: key.publicKey,
        signature: await key.sign(
          joinMessage({ origin: ORIGIN, org: ORG, repo: name, inviteId, publicKey: key.publicKey }),
        ),
      }),
    );
    const id = joined.agent.agentId;
    value(
      await identity.confirm(
        grant(repoId, { kind: "agent.confirm", agentId: id, code: joined.code }),
      ),
    );
    value(
      await claims.fileIssue(
        grant(repoId, { kind: "issue.file", title: "Add uploads", body: "Do it." }),
      ),
    );
    return id;
  });

  const challenge = await agentPost<ChallengeResult>(name, "/session/challenge", { agentId });
  if (!challenge.ok) throw new Error(challenge.error.code);
  const session = await agentPost<SessionResult>(name, "/session", {
    agentId,
    challengeId: challenge.data.challengeId,
    signature: await key.sign(challenge.data.message),
  });
  if (!session.ok) throw new Error(session.error.code);

  const setup: Setup = {
    name,
    repoId,
    stub,
    fake,
    mainName,
    agentId,
    token: session.data.token,
    seen: [],
    pushAnswer: () =>
      gitResult("git-receive-pack", `${pkt("unpack ok\n")}${pkt(`ok ${FEATURE}\n`)}0000`),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    await request.arrayBuffer();
    const authorization = request.headers.get("authorization");
    setup.seen.push({ url: request.url, method: request.method, authorization });
    // The endpoint refuses any token Artifacts would refuse.
    if (!fake.accepts(authorization?.replace(/^Bearer /, "") ?? "")) {
      return new Response("bad token", { status: 401 });
    }
    const url = new URL(request.url);
    const service = url.searchParams.get("service");
    if (request.method === "GET" && service === "git-upload-pack") {
      return advertisement(service, pkt(`${HEAD} refs/heads/main\0side-band-64k\n`));
    }
    if (request.method === "GET" && service === "git-receive-pack") {
      return advertisement(service, pkt(`${HEAD} refs/heads/main\0report-status\n`));
    }
    if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      return gitResult("git-upload-pack", `${pkt("NAK\n")}PACK-bytes`);
    }
    if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
      return setup.pushAnswer();
    }
    return new Response("unexpected", { status: 500 });
  });
  return setup;
}

async function agentPost<T>(
  name: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<AgentResponse<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const reply = await SELF.fetch(`${ORIGIN}${AGENT_PATH_PREFIX}/${ORG}/${name}${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return reply.json();
}

/** Takes the filed issue for the agent over HTTP; Artifacts forks main for it. */
async function work(setup: Setup): Promise<ClaimResult> {
  const claimed = await agentPost<ClaimResult>(setup.name, "/work", undefined, setup.token);
  if (!claimed.ok) throw new Error(claimed.error.code);
  return claimed.data;
}

function basic(setup: Setup): string {
  return `Basic ${btoa(`${setup.agentId}:${setup.token}`)}`;
}

function advertise(url: string, service: string, auth: string | null): Promise<Response> {
  return SELF.fetch(`${url}/info/refs?service=${service}`, {
    headers: auth === null ? {} : { authorization: auth },
  });
}

function rpc(url: string, service: string, auth: string, body: BodyInit): Promise<Response> {
  return SELF.fetch(`${url}/${service}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": `application/x-${service}-request` },
    body,
  });
}

/** A push of `PUSHED` to a new branch, with a pack longer than the bytes the gateway holds back. */
function pushBody(): string {
  return `${pkt(`${ZERO} ${PUSHED} ${FEATURE}\0report-status\n`)}0000PACK${"x".repeat(64)}`;
}

async function textOf(response: Response): Promise<string> {
  return decoder.decode(await response.arrayBuffer());
}

async function events(setup: Setup) {
  return value(await setup.stub.readEvents(0, 100, null)).events;
}

async function pushed(setup: Setup) {
  return (await events(setup)).filter((event) => event.type === "claim.pushed");
}

describe("the assembled Git gateway", () => {
  it("clones main and records a push to the agent's fork", async () => {
    const setup = await setUp();
    const { claim } = await work(setup);
    expect(claim.upstreamUrl).toBe(`${ORIGIN}/git/${ORG}/${setup.name}.git`);
    const forkName = [...setup.fake.repos.keys()].find((repo) => repo !== setup.mainName) ?? "";

    const refs = await advertise(claim.upstreamUrl, "git-upload-pack", basic(setup));
    expect(refs.status).toBe(200);
    expect(refs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const fetched = await rpc(
      claim.upstreamUrl,
      "git-upload-pack",
      basic(setup),
      `${pkt(`want ${HEAD}\n`)}0000${pkt("done\n")}`,
    );
    expect(fetched.status).toBe(200);
    expect(await textOf(fetched)).toBe(`${pkt("NAK\n")}PACK-bytes`);
    // The clone read main with read tokens minted in the Worker, never the agent's session.
    expect(setup.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET https://artifacts.invalid/${setup.mainName}.git/info/refs?service=git-upload-pack`,
      `POST https://artifacts.invalid/${setup.mainName}.git/git-upload-pack`,
    ]);
    const mainRead = setup.fake.liveTokens(setup.mainName).map((token) => token.scope);
    expect(mainRead).toEqual(["read"]);
    for (const seen of setup.seen) expect(seen.authorization).not.toContain(setup.token);

    setup.seen.length = 0;
    const pushRefs = await advertise(claim.originUrl, "git-receive-pack", basic(setup));
    expect(pushRefs.status).toBe(200);
    const push = await rpc(claim.originUrl, "git-receive-pack", basic(setup), pushBody());
    expect(push.status).toBe(200);
    expect(await textOf(push)).toBe(`${pkt("unpack ok\n")}${pkt(`ok ${FEATURE}\n`)}0000`);
    expect(setup.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET https://artifacts.invalid/${forkName}.git/info/refs?service=git-receive-pack`,
      // The gateway reads the fork's branches before it releases the push.
      `GET https://artifacts.invalid/${forkName}.git/info/refs?service=git-upload-pack`,
      `POST https://artifacts.invalid/${forkName}.git/git-receive-pack`,
    ]);
    expect(
      setup.fake
        .liveTokens(forkName)
        .map((token) => token.scope)
        .toSorted(),
    ).toEqual(["read", "write"]);
    expect(await pushed(setup)).toMatchObject([
      {
        actor: { kind: "agent", id: setup.agentId },
        data: { claimId: claim.claimId, ref: FEATURE, from: null, to: PUSHED },
      },
    ]);
  });

  it("refuses a push to main and an unauthenticated request before reaching Artifacts", async () => {
    const setup = await setUp();
    const { claim } = await work(setup);
    const before = await events(setup);

    const toMain = await rpc(claim.upstreamUrl, "git-receive-pack", basic(setup), pushBody());
    expect(toMain.status).toBe(403);
    expect(await textOf(toMain)).toContain("main is read-only");

    const anonymous = await advertise(claim.originUrl, "git-upload-pack", null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain('Basic realm="Railhead"');

    // A session whose username names another agent is refused like a bad credential.
    const mismatched = `Basic ${btoa(`agt_someoneelse:${setup.token}`)}`;
    expect((await advertise(claim.originUrl, "git-upload-pack", mismatched)).status).toBe(401);

    expect(setup.seen).toEqual([]);
    expect(await events(setup)).toEqual(before);
  });

  it("answers 404 for a claim this repository never opened", async () => {
    const setup = await setUp();
    await work(setup);

    const unknown = `${ORIGIN}/git/${ORG}/${setup.name}/claims/clm_neveropened.git`;
    const response = await advertise(unknown, "git-upload-pack", basic(setup));
    expect(response.status).toBe(404);
    expect(setup.seen).toEqual([]);
  });

  it("records nothing when Artifacts fails the push", async () => {
    const setup = await setUp();
    const { claim } = await work(setup);
    setup.pushAnswer = () => new Response("upstream failure", { status: 500 });

    const push = await rpc(claim.originUrl, "git-receive-pack", basic(setup), pushBody());
    expect(push.status).toBe(502);
    expect(setup.seen.at(-1)?.method).toBe("POST");
    expect(await pushed(setup)).toEqual([]);
  });
});

describe("main's ref in the Worker composition", () => {
  it("reads main through the Artifacts binding", async () => {
    const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
    const fake = new FakeArtifacts(Date.now());
    const head = await runInDurableObject(stub, async (_instance, state) => {
      const repoId = "rep_mainref0001";
      fake.seed(await mainRepoName(repoId), [ROOT, HEAD]);
      const ports = composeRepo({
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: Date.now,
        env: withFakeArtifacts(fake),
        wake: async () => true,
      });
      return ports.mainWriter.head();
    });
    expect(head).toEqual(ok(HEAD));
    expect(fake.openHandles).toBe(0);
  });

  it("fails the read when main is not in the store", async () => {
    const stub: DurableObjectStub<Repo> = env.REPO.getByName(crypto.randomUUID());
    const fake = new FakeArtifacts(Date.now());
    const head = await runInDurableObject(stub, async (_instance, state) => {
      const repoId = "rep_mainref0002";
      const ports = composeRepo({
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: Date.now,
        env: withFakeArtifacts(fake),
        wake: async () => true,
      });
      return ports.mainWriter.head();
    });
    expect(head).toMatchObject({ ok: false });
    expect(fake.openHandles).toBe(0);
  });
});
