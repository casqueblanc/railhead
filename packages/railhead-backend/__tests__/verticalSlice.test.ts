// The three-agent slice on the assembled Worker: requests enter through `SELF` and reach the
// repository's real `Repo` binding, which composes every production module from its own entry. Three
// agents join over the agent routes, log in, take three issues into three forks and push through the
// Git gateway; two of them ready their work, and the train composes both into one candidate, starts
// one check on it, records the runner's report, authorizes the merge and moves main with a
// compare-and-swap. Only what lies outside workerd is faked (`sliceWorld.ts`): Artifacts, the Git
// endpoint, the sandbox container and the check Workflow. The owner's passkey is stood in for by
// grants made inside the Repo, as the owner module would mint them after a verified assertion; the
// passkey itself is covered by `ownerActions.test.ts`.
//
// This proves the modules are wired together. It is not Artifacts qualification: the live gate is
// `scripts/qualify-slice.mjs`, run by an operator against a deployed instance
// (docs/slice-acceptance.md).

import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PATH_PREFIX,
  joinMessage,
  type AgentResponse,
  type ChallengeResult,
  type ClaimResult,
  type ClaimView,
  type JoinResult,
  type ReadyResult,
  type SessionResult,
} from "@railhead/shared/agent-api";
import type { OwnerAction } from "@railhead/shared/board-api";
import type { CheckResult, CommitSha } from "@railhead/shared/events";
import { forkRepoName, mainRepoName } from "../src/artifacts/adapter";
import type { GrantFor } from "../src/contracts/principals";
import type { PortResult } from "../src/contracts/result";
import { composeRepo } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";
import { AgentKey } from "./agentKey";
import { pkt, sha, SliceWorld, type RequestedRun } from "./sliceWorld";

const ORIGIN = "https://railhead.mashin.workers.dev";
const ORG = "acme";
const OWNER = "usr_owner01";
const ROOT = sha("1");
const MAIN = sha("2");
const ZERO = "0".repeat(40);
const AGENTS = ["atlas", "birch", "cedar"] as const;
const decoder = new TextDecoder();

afterEach(() => {
  vi.restoreAllMocks();
});

/** One agent as its CLI holds it: its key, session and claim. */
interface Agent {
  readonly name: string;
  readonly key: AgentKey;
  readonly agentId: string;
  readonly token: string;
  /** Every response body the agent received, to check that no Artifacts token reached it. */
  readonly received: string[];
  claim: ClaimView | null;
}

/** One assembled repository with its fake world and three logged-in agents. */
interface Slice {
  readonly name: string;
  readonly repoId: string;
  readonly stub: DurableObjectStub<Repo>;
  readonly world: SliceWorld;
  readonly agents: Agent[];
}

function value<T>(result: PortResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.value;
}

function grant<K extends OwnerAction["kind"]>(
  repoId: string,
  action: Extract<OwnerAction, { kind: K }>,
): GrantFor<K> {
  return { kind: "human", userId: OWNER, repoId, grantId: crypto.randomUUID(), action };
}

/** Runs `body` against the Repo's own composition of its modules. */
function asOwner<T>(
  slice: Pick<Slice, "stub" | "repoId" | "world">,
  body: (ports: ReturnType<typeof composeRepo>) => Promise<T>,
): Promise<T> {
  return runInDurableObject(slice.stub, async (_instance, state) =>
    body(
      composeRepo({
        repoId: slice.repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, slice.repoId),
        clock: Date.now,
        env: slice.world.env(env),
        wake: async () => true,
      }),
    ),
  );
}

/** One agent route call, as the CLI sends it; the body text is kept for the token audit. */
async function call<T>(
  slice: Pick<Slice, "name">,
  path: string,
  body: unknown,
  agent?: Agent,
): Promise<AgentResponse<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (agent !== undefined) headers.authorization = `Bearer ${agent.token}`;
  const reply = await SELF.fetch(`${ORIGIN}${AGENT_PATH_PREFIX}/${ORG}/${slice.name}${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await reply.text();
  agent?.received.push(text);
  const parsed: AgentResponse<T> = JSON.parse(text);
  return parsed;
}

function data<T>(response: AgentResponse<T>): T {
  if (!response.ok) throw new Error(`expected success, got ${response.error.code}`);
  return response.data;
}

/** Enrolls one agent through an invite over `/join`, confirms it and logs it in. */
async function enroll(slice: Omit<Slice, "agents">, name: string): Promise<Agent> {
  const key = await AgentKey.create();
  const inviteUrl = await asOwner(slice, async ({ identity }) => {
    const created = await identity.createInvite(
      grant(slice.repoId, { kind: "invite.create", name }),
    );
    return value(created).inviteUrl;
  });
  const [inviteId = "", inviteSecret = ""] =
    /\/(inv_[0-9a-f]+)#(.+)$/.exec(inviteUrl)?.slice(1) ?? [];
  const message = joinMessage({
    origin: ORIGIN,
    org: ORG,
    repo: slice.name,
    inviteId,
    publicKey: key.publicKey,
  });
  const received: string[] = [];
  const joinReply = await SELF.fetch(`${ORIGIN}${AGENT_PATH_PREFIX}/${ORG}/${slice.name}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      inviteId,
      inviteSecret,
      publicKey: key.publicKey,
      signature: await key.sign(message),
    }),
  });
  const joinText = await joinReply.text();
  received.push(joinText);
  const joinParsed: AgentResponse<JoinResult> = JSON.parse(joinText);
  const joined = data(joinParsed);
  const agentId = joined.agent.agentId;
  await asOwner(slice, async ({ identity }) => {
    value(
      await identity.confirm(
        grant(slice.repoId, { kind: "agent.confirm", agentId, code: joined.code }),
      ),
    );
  });
  const challenge = data(await call<ChallengeResult>(slice, "/session/challenge", { agentId }));
  const session = data(
    await call<SessionResult>(slice, "/session", {
      agentId,
      challengeId: challenge.challengeId,
      signature: await key.sign(challenge.message),
    }),
  );
  return { name, key, agentId, token: session.token, received, claim: null };
}

/**
 * A fresh repository on the assembled Worker, with main at `MAIN`, three issues filed and three
 * agents enrolled and logged in.
 */
async function assemble(): Promise<Slice> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName(ORG, name));
  const world = new SliceWorld();
  // The Repo installs its modules over these bindings when it first starts.
  await runInDurableObject(stub, (instance) => {
    Reflect.set(instance, "env", world.env(env));
  });
  const { repoId } = value(await stub.initialize(ORG, name));
  world.seedMain(await mainRepoName(repoId), [ROOT, MAIN]);
  world.stubGitEndpoint();
  const base = { name, repoId, stub, world };
  await asOwner(base, async ({ claims }) => {
    for (const title of ["Add uploads", "Add thumbnails", "Add quotas"]) {
      value(await claims.fileIssue(grant(repoId, { kind: "issue.file", title, body: "Do it." })));
    }
  });
  const enrolled: Agent[] = [];
  for (const agentName of AGENTS) enrolled.push(await enroll(base, agentName));
  return { ...base, agents: enrolled };
}

/** `rh work`: takes the next issue into a fresh fork. */
async function work(slice: Slice, agent: Agent): Promise<ClaimView> {
  const { claim } = data(await call<ClaimResult>(slice, "/work", undefined, agent));
  agent.claim = claim;
  return claim;
}

function basic(agent: Agent): string {
  return `Basic ${btoa(`${agent.agentId}:${agent.token}`)}`;
}

/** `git push` of `commit` to a new branch of the agent's fork, through the gateway. */
async function push(slice: Slice, agent: Agent, commit: CommitSha): Promise<void> {
  const claim = agent.claim;
  if (claim === null) throw new Error("the agent holds no claim");
  const refs = await SELF.fetch(`${claim.originUrl}/info/refs?service=git-receive-pack`, {
    headers: { authorization: basic(agent) },
  });
  agent.received.push(decoder.decode(await refs.arrayBuffer()));
  expect(refs.status).toBe(200);
  // Artifacts stores the pushed objects; the fake records the commit on the fork.
  slice.world.addToFork(await forkRepoName(slice.repoId, claim.claimId), commit);
  const reply = await SELF.fetch(`${claim.originUrl}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: basic(agent),
      "content-type": "application/x-git-receive-pack-request",
    },
    body: `${pkt(`${ZERO} ${commit} refs/heads/work\0report-status\n`)}0000PACK${"x".repeat(64)}`,
  });
  agent.received.push(decoder.decode(await reply.arrayBuffer()));
  expect(reply.status).toBe(200);
}

/** `rh ready`: pins `commit` for the train. */
async function ready(
  slice: Slice,
  agent: Agent,
  commit: CommitSha,
): Promise<AgentResponse<ReadyResult>> {
  const claim = agent.claim;
  if (claim === null) throw new Error("the agent holds no claim");
  return call<ReadyResult>(
    slice,
    `/claims/${claim.claimId}/ready`,
    { generation: claim.generation, commit },
    agent,
  );
}

/** One event as the Repo's `readEvents` returns it over RPC. */
type Logged = Extract<
  Awaited<ReturnType<DurableObjectStub<Repo>["readEvents"]>>,
  { ok: true }
>["value"]["events"][number];

/** Every event the repository recorded. */
async function events(slice: Slice): Promise<Logged[]> {
  const all: Logged[] = [];
  let cursor = 0;
  for (;;) {
    const page = value(await slice.stub.readEvents(cursor, 100, null));
    all.push(...page.events);
    if (page.events.length < 100) return all;
    cursor = page.events.at(-1)?.seq ?? cursor;
  }
}

/**
 * Runs the Repo's alarm and yields until `probe` finds something, at most 100 times. Miniflare also
 * fires a due alarm by itself, so this waits for whichever runs first.
 */
async function until<T>(
  slice: Slice,
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await runDurableObjectAlarm(slice.stub);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** The `index`th check run the checks module asked for, once it has. */
function run(slice: Slice, index: number): Promise<RequestedRun> {
  return until(slice, `check run ${index}`, () => slice.world.runs[index]);
}

/** Reports check run `index` as the Workflow would, with `result`. */
async function report(slice: Slice, index: number, result: CheckResult) {
  const { params } = await run(slice, index);
  return slice.stub.reportCheck({
    attemptId: params.attemptId,
    candidate: params.candidate,
    digest: params.digest,
    result,
    log: "ok\n",
    finishedAt: Date.now(),
  });
}

/** The events of `type`, in order. */
async function ofType<K extends Logged["type"]>(
  slice: Slice,
  type: K,
): Promise<Extract<Logged, { type: K }>[]> {
  return (await events(slice)).filter(
    (event): event is Extract<Logged, { type: K }> => event.type === type,
  );
}

/** Waits until main's ref has recorded `count` outcomes. */
function mainOutcomes(slice: Slice, count: number) {
  return until(slice, `${count} train.main events`, async () => {
    const found = await ofType(slice, "train.main");
    return found.length >= count ? found : undefined;
  });
}

function agents(slice: Slice): [Agent, Agent, Agent] {
  const [atlas, birch, cedar] = slice.agents;
  if (atlas === undefined || birch === undefined || cedar === undefined) throw new Error("agents");
  return [atlas, birch, cedar];
}

/** Every agent holds its own claim, has pushed one commit and atlas alone has readied it. */
async function atlasReady(): Promise<Slice> {
  const slice = await assemble();
  const [atlas, birch, cedar] = agents(slice);
  for (const agent of slice.agents) await work(slice, agent);
  await push(slice, atlas, ATLAS);
  await push(slice, birch, BIRCH);
  await push(slice, cedar, CEDAR);
  data(await ready(slice, atlas, ATLAS));
  return slice;
}

const ATLAS = sha("a1");
const BIRCH = sha("b1");
const CEDAR = sha("d1");

describe("the three-agent slice on the assembled Worker", () => {
  it("lands three agents' work, two changes in one batch, each after one check on its exact candidate", async () => {
    const slice = await atlasReady();
    const [atlas, birch, cedar] = agents(slice);
    const { world } = slice;

    // Three agents, three claims, three forks: each claim's remote names its own fork.
    expect(new Set(slice.agents.map((agent) => agent.agentId)).size).toBe(3);
    const claimIds = slice.agents.map((agent) => agent.claim?.claimId);
    expect(new Set(claimIds).size).toBe(3);
    const forks = await Promise.all(
      claimIds.map((claimId) => forkRepoName(slice.repoId, claimId ?? "")),
    );
    expect(new Set(forks).size).toBe(3);
    expect([...world.forks.repos.keys()].toSorted()).toEqual([world.mainName, ...forks].toSorted());

    // Atlas's batch is checking; birch and cedar ready meanwhile and wait together.
    const first = await run(slice, 0);
    data(await ready(slice, birch, BIRCH));
    data(await ready(slice, cedar, CEDAR));
    expect(await report(slice, 0, "pass")).toMatchObject({ ok: true });
    await mainOutcomes(slice, 1);
    const second = await run(slice, 1);
    expect(await report(slice, 1, "pass")).toMatchObject({ ok: true });
    await mainOutcomes(slice, 2);

    const [candidate1, candidate2] = world.candidates;
    expect(world.candidates).toHaveLength(2);
    expect(first.params.candidate).toBe(candidate1);
    expect(second.params.candidate).toBe(candidate2);
    // The second candidate merges both pins on the first landing, in readiness order.
    expect(world.main.commits.get(candidate2 ?? "")).toEqual([candidate1, BIRCH, CEDAR]);

    const checks = await ofType(slice, "train.check");
    expect(checks.map(({ data: check }) => [check.candidate, check.result])).toEqual([
      [candidate1, "pass"],
      [candidate2, "pass"],
    ]);
    const intents = await ofType(slice, "train.intent");
    expect(intents.map(({ data: intent }) => intent)).toMatchObject([
      { expectedMain: MAIN, candidate: candidate1, claims: [atlas.claim?.claimId] },
      {
        expectedMain: candidate1,
        candidate: candidate2,
        claims: [birch.claim?.claimId, cedar.claim?.claimId],
      },
    ]);
    const outcomes = await ofType(slice, "train.main");
    expect(outcomes.map(({ data: outcome }) => [outcome.outcome, outcome.main])).toEqual([
      ["updated", candidate1],
      ["updated", candidate2],
    ]);
    const merged = await ofType(slice, "claim.merged");
    expect(merged.map(({ data: claim }) => [claim.claimId, claim.commit])).toEqual([
      [atlas.claim?.claimId, candidate1],
      [birch.claim?.claimId, candidate2],
      [cedar.claim?.claimId, candidate2],
    ]);
    // Main moved twice, each time by one compare-and-swap that applied.
    expect(world.main.main).toBe(candidate2);
    expect(world.main.steps.filter((step) => step === "applied")).toHaveLength(2);
    expect(world.main.liveWriteTokens()).toEqual([]);
    expect(world.liveSandboxes.size).toBe(0);

    // No Artifacts token ever reached an agent, and no agent session reached Artifacts.
    const minted = world.allTokens();
    expect(minted.length).toBeGreaterThan(0);
    for (const agent of slice.agents) {
      const received = agent.received.join("\n");
      for (const token of minted) expect(received).not.toContain(token);
      for (const seen of world.seen) expect(seen.authorization ?? "").not.toContain(agent.token);
    }
  });

  it("refuses a report for another candidate and a ready for a commit the fork lacks", async () => {
    const slice = await atlasReady();
    const [, birch] = agents(slice);
    const { params } = await run(slice, 0);

    const forged = await slice.stub.reportCheck({
      attemptId: params.attemptId,
      candidate: sha("bad"),
      digest: params.digest,
      result: "pass",
      log: "",
      finishedAt: Date.now(),
    });
    expect(forged).toMatchObject({ ok: false, code: "check_mismatch" });
    const missing = await ready(slice, birch, sha("e0"));
    expect(missing).toMatchObject({ ok: false, error: { code: "commit_not_found" } });
    expect(await ofType(slice, "train.check")).toEqual([]);
    expect(await ofType(slice, "train.intent")).toEqual([]);
    expect((await ofType(slice, "claim.ready")).map(({ data: claim }) => claim.claimId)).toEqual([
      agents(slice)[0].claim?.claimId,
    ]);
    expect(slice.world.main.main).toBe(MAIN);
  });

  it("leaves main to a foreign writer when the compare-and-swap finds it moved", async () => {
    const slice = await atlasReady();
    const { world } = slice;
    await run(slice, 0);
    const foreign = sha("f0");
    world.main.commit(foreign, [MAIN]);
    world.main.forcePush(foreign);

    expect(await report(slice, 0, "pass")).toMatchObject({ ok: true });
    const [outcome] = await mainOutcomes(slice, 1);
    expect(outcome?.data).toMatchObject({ outcome: "rejected", main: foreign });
    expect(world.main.main).toBe(foreign);
    expect(world.main.steps).not.toContain("applied");
    expect(await ofType(slice, "claim.merged")).toEqual([]);
    expect(world.main.liveWriteTokens()).toEqual([]);
  });

  it("settles a main update whose response was lost from main's state, without a second write", async () => {
    const slice = await atlasReady();
    const [atlas] = agents(slice);
    const { world } = slice;
    await run(slice, 0);
    world.loseNextMainResponse = true;

    expect(await report(slice, 0, "pass")).toMatchObject({ ok: true });
    const [outcome] = await mainOutcomes(slice, 1);
    const [candidate] = world.candidates;
    expect(outcome?.data).toMatchObject({ main: candidate });
    expect(world.main.main).toBe(candidate);
    expect(world.main.steps.filter((step) => step === "applied")).toHaveLength(1);
    expect((await ofType(slice, "claim.merged")).map(({ data: claim }) => claim.claimId)).toEqual([
      atlas.claim?.claimId,
    ]);
    expect(world.main.liveWriteTokens()).toEqual([]);
  });

  it("moves nothing when the check fails", async () => {
    const slice = await atlasReady();
    expect(await report(slice, 0, "fail")).toMatchObject({ ok: true });
    await until(slice, "the failed check", async () => {
      const found = await ofType(slice, "train.check");
      return found.length > 0 ? found : undefined;
    });

    expect((await ofType(slice, "train.check")).map(({ data: check }) => check.result)).toEqual([
      "fail",
    ]);
    expect(await ofType(slice, "train.intent")).toEqual([]);
    expect(await ofType(slice, "claim.merged")).toEqual([]);
    expect(slice.world.main.main).toBe(MAIN);
    expect(slice.world.main.tokens).toEqual([]);
  });
});
