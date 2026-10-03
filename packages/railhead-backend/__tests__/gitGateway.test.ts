import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
} from "../src/artifacts/adapter";
import { FakeArtifacts, type FakeToken } from "../src/artifacts/fake";
import type { ArtifactsPort } from "../src/contracts/artifacts";
import type { ClaimsPort, GitAccess, GitGrant } from "../src/contracts/claims";
import type { SessionsPort } from "../src/contracts/identity";
import type { AgentPrincipal } from "../src/contracts/principals";
import { fail, ok, type PortResult } from "../src/contracts/result";
import { unavailableClaims, unavailableSessions } from "../src/contracts/unavailable";
import {
  GIT_GATEWAY_LIMITS,
  createGitGateway,
  type GitGatewayLimits,
  type RemoteResolver,
  type Upstream,
} from "../src/git/gateway";
import { AdvertisedRefsReader, type AdvertisedRefs } from "../src/git/refAdvertisement";
import { artifactsRemotes } from "../src/git/remotes";
import { PushReportReader } from "../src/git/reportStatus";
import type { GitPort, GitTarget } from "../src/modules/git/entry";
import { EventLog, EventLogError } from "../src/repo/eventLog";

// Request and response bodies recorded from stock Git 2.50.1 against `git http-backend`: a
// protocol v2 `git clone --depth 1`, then a push of one new commit from that shallow clone to a new
// branch, whose head starts with a `shallow` line and whose report is report-status-v2 over
// side-band-64k.
const STOCK = {
  shallowFetchRequest: `
MDAxMWNvbW1hbmQ9ZmV0Y2gwMDFiYWdlbnQ9Z2l0LzIuNTAuMS1EYXJ3aW4wMDE2b2JqZWN0LWZvcm1hdD1zaGExMDAwMTAw
MGR0aGluLXBhY2swMDBmbm8tcHJvZ3Jlc3MwMDBmaW5jbHVkZS10YWcwMDBkb2ZzLWRlbHRhMDAwY2RlZXBlbiAxMDAzMndh
bnQgNzc2NjU4NTE2MTgyZjg1OGZiYTkyZjA4NDY2NDI4N2FkNDhiZDBiNAowMDMyd2FudCA3NzY2NTg1MTYxODJmODU4ZmJh
OTJmMDg0NjY0Mjg3YWQ0OGJkMGI0CjAwMDlkb25lCjAwMDA=`,
  shallowFetchResult: `
MDAxMXNoYWxsb3ctaW5mbwowMDM0c2hhbGxvdyA3NzY2NTg1MTYxODJmODU4ZmJhOTJmMDg0NjY0Mjg3YWQ0OGJkMGI0MDAw
MTAwMGRwYWNrZmlsZQowMzdjAVBBQ0sAAAACAAAAA5lBeJyNk0mvo1YQhff8CvZWwmUGqV8rzPgxz+AdXLgYg5mMbexf306i
7HqRszylOqqSzretTYPTJN1UJVWTnABrxDV1wyIRlqXAQxGRFYt4SNc0YLC5XJtxwwFdsRxAnFhxTMVwLAQVgnTF8wBBHjUI
NFRJshWDlfftPK24hP8o/2r28joPzZ/d+CiHrv6JkzzHU9QniMQP4CMMTtdrt23N/15o5/bWtfgff0vWjKOL+4aPR0fDleIk
1P7xMRzDu+D4liVJViSp1jtNO2/tXA8rHRmM7koO8gl+7mXHfPU3XbquUi4CSWn74D8fwz+TErUEAbPV1rKWdTLnoj+bdKz9
aaudvsuO/vaaMzA4ht8e4lguell/KlAcZMFkPAzfnbyZuG16B9mdoUPFDQwGvE/Pwd8mlmf2MLrnyQMyQo48VqADVIaRXEfZ
6OT7OXYvGH7xWkS1wkUjDD4quOv76cLjOHb7o9vsqvHEvWeAOLwNx9WrKir0x2vzBcplJ9NsGe+O4TZKffo19mND3Rtu9Mzy
4OWwGx7FXDkBzAESOOQp5NW7BqNH7ogMjlaJ2F4K7V4NPl+khjU5yKtvzuxPyi4p2T3lAkY8F7VlAHeH14N54trTFNJKEomq
uai08urqaUwVWtg/N+hCJtEDgP0NHF4P8hTXLNqs+aQyXkFkbKmFYzAQLfPu0gPNQ6sT/Ia9kTFbrnF8Hr8x3JPXKlXO4M2U
EtXd8ltnZeGTvEpnvhWVowyozRqKRj/lizXeA/VM2Me95Q9EPx2DwbcwnHgs35G6qBf7lUSghROt1qwt0dA+qHFIxvcchBOn
pUsiBPt3oSfNg5z0Du08dZosJ/704T10MKka2RZQ7X56WQy+v8WNQ24w3trCoBl9Fa0kM7R1vy/p4L9dwpMH9cLK3Pz9SaBj
KtoPuTIPpkQug+OZIOFppvhAxUg+XE5kuaKySKtlh8McLhfNhONCeuYrHs0RJRiedebYevPASFlKWTkKxsTS7SUHhMY/U/+i
cXRCmGfpWkcplRm9XUtfGP71cO4a9i8zmqv+jhhse07YL4wNR+2hAnicMzQwMDMxUUjUK6koYfgu+f6KwVXt8yfCspw3vU4N
67jcUQgAz5cOiDR4nCspz+cCAAQhAWWsC+OubwoJiLWMB9sY8c4ylPgbMDAwNgFYMDAwMA==`,
  pushRequest: `
MDAzNXNoYWxsb3cgNzc2NjU4NTE2MTgyZjg1OGZiYTkyZjA4NDY2NDI4N2FkNDhiZDBiNAowMGI5MDAwMDAwMDAwMDAwMDAw
MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCA2Mzg3ZWE3NzY1NGJjZmZmMDUyMTEzMGYyMmYzNjkxYzQwZGViOGFiIHJlZnMv
aGVhZHMvZmVhdHVyZQAgcmVwb3J0LXN0YXR1cy12MiBzaWRlLWJhbmQtNjRrIHF1aWV0IG9iamVjdC1mb3JtYXQ9c2hhMSBh
Z2VudD1naXQvMi41MC4xLURhcndpbjAwMDBQQUNLAAAAAgAAAAObQXicjZTHzqtWAIT3PMXZowQ4YA5IuVehG1NMccH/jt6L
6fjp8ydRdneRWY40mxl9M49pCkg6ZckTolASntgUIjZLEjqh4QmFGUPTER8nLMNCFhvCMe1mgBDLnrgTxVIczLgTl0UhDzOS
Y1iWgRwKE4aLEjJisHCZi34EAvgj/DPdw3Zo0t/Lbg2bMvkJKMQiCE8sCQFOfguL+7Yt5zn934F8yKcyB7/9LVHRdBs4mgN8
XbOF291T/vExgIHS1T+iIIiSICRqqSjFnA9JM9K+xqi2YGUOgYZatM5HPalCOwoBbglSXrv/+Rg46iXTNwJ3hLR9nSEdBHTw
XPalcfrAduPlqY/k4byv+3rR9cpAfUlLZM9oPKNkRRaTGCia4uGaxBn6eI5ThiMhVEWtuzh0oCIpT5P48/qSp3HUiH0upLjJ
V8178ZNUJ9VF8k4YSHSJMWJ2FOGUFzbd2tdop5X8kVZ+Sy3wfk7l6OBU+aKvc0HOh7dOzHXdcbcrmTBUYwzQde8Y2eK16WvP
ac+72KUDl1p9F1LXvd9wH7q3eLjNp+1vFBLS0ibsHrHPCI0aO5EbBkg3ioOPl+NEeDSZHHeKz+3Vl+AxH9UXOB/1kBeVtTLg
fH/ysfK2Ukcy8ddD1tpMXwYMwKykccOMMlzTg6lBN0aGseOQ1Co0154I3vHRVNM53/XnFmqWY5rsxTglN5rbO1bvKQxsVZRc
0XuqxIRXQzeAgyZor9Ci8teQrq5Y2O1LIRe8WqXG5zZ9CCDV6DhvfhZt2w8fA+ocJeXmdx53KXeqZgnrs1DmiW3uh4XLN8ha
Y5udC9rhnSdnmLerJhr9NtVrTKUbYyvfW2zt20XnmpT3B39OpbU8V4antG1SlaXF3OJ9JlMhvgXE5xmle6B0ofDA01keA/vl
hd9NNi1sb7g4HN2qTk7fvsQbIz3wwnxq8iS9A9+EX7442tt4FGPF42V2EPfoaj/kggn8uMWApH1mgkno5h5Y+teCqC5ftHtX
lo5X76uNZ5rXGOFDvOilYSTobDnCDwz8aAwbYv8yo9jyr4jB5uL7FbC/AGkvSTqhAnicMzQwMDMxUUjUK6koYdC+n756Y/KS
/5uuf/7QwTP/KVvP8yYA1yIPkTZ4nCvJKEpN5QIACJECIwYQdo7yybVE9ehjEN/gKUrqxXTf`,
  pushResult: `
MDAzMQEwMDBldW5wYWNrIG9rCjAwMWFvayByZWZzL2hlYWRzL2ZlYXR1cmUKMDAwMDAwMDA=`,
};

function decode(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64.replace(/\s/g, "")), (character) => character.charCodeAt(0));
}

const SHALLOW_FETCH_REQUEST = decode(STOCK.shallowFetchRequest);
const SHALLOW_FETCH_RESULT = decode(STOCK.shallowFetchResult);
const PUSH_REQUEST = decode(STOCK.pushRequest);
const PUSH_RESULT = decode(STOCK.pushResult);
const PUSHED = "6387ea77654bcfff0521130f22f3691c40deb8ab";

const REPO = "rep_gitgateway01";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const ZERO = "0".repeat(40);
const CLAIM = "clm_gitclaim0001";
const AGENT: AgentPrincipal = {
  kind: "agent",
  agentId: "agt_gitagent0001",
  ownerId: "usr_owner0001",
  repoId: REPO,
};
const OTHER: AgentPrincipal = { ...AGENT, agentId: "agt_gitagent0002" };
const SESSION = "session-token-of-agent-one";
const OTHER_SESSION = "session-token-of-agent-two";
const FORK: GitTarget = { kind: "fork", claimId: CLAIM };
const MAIN: GitTarget = { kind: "main" };
const FAST: GitGatewayLimits = {
  ...GIT_GATEWAY_LIMITS,
  headTimeoutMs: 100,
  headersTimeoutMs: 100,
  maxDurationMs: 300,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ClaimState = "working" | "ready" | "expired";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
}

interface World {
  gateway: GitPort;
  fake: FakeArtifacts;
  /** The Artifacts port the gateway calls. */
  artifacts: ArtifactsPort;
  claim: { agentId: string; generation: number; state: ClaimState };
  authorizations: GitAccess[];
  /** Whether the claims module answers every decision as unavailable. */
  claimsDown: boolean;
  /** When set, answers `authorizeGit` in place of the A21 contract. */
  authorize: ((access: GitAccess) => PortResult<GitGrant>) | null;
  /** When set, the next `times` reads of `workingGeneration` throw `error`. */
  generationFault: { times: number; error: Error } | null;
  /** The requests the default upstream received, with their bodies, apart from `observations`. */
  seen: Seen[];
  /** The fork reads the gateway made while serving a push, before releasing it. */
  observations: Seen[];
  /**
   * The fork's branches, each `[id, ref]`, as the default upstream advertises them to
   * `observations`, or `null` to fail those reads.
   */
  fork: (readonly [string, string])[] | null;
  /** How many pushes the gateway is serving, up to the response it returns. */
  pushing: number;
  /** What the default upstream answers once it has read a request carrying a live token. */
  respond: (request: Request, body: Uint8Array) => Promise<Response> | Response;
  /** The outbound call; replace it to observe a request as it streams. */
  upstream: Upstream;
  remote: RemoteResolver;
  events: () => RailheadEvent[];
  forkName: string;
  mainName: string;
  /** How many tokens Artifacts minted after the world was set up, revoked or not. */
  minted: () => number;
  /** Every token Artifacts minted for this world, revoked or not. */
  tokens: () => string[];
  /** The tokens still live, across main and the fork. */
  live: () => FakeToken[];
  /** How far the gateway's clock is ahead of the real one, in milliseconds. */
  skew: number;
  /** Every alarm time the gateway asked the Repo for, whether its write succeeded or not. */
  wakes: number[];
  /** Whether the Repo's alarm write for a wake succeeds; called as the gateway asks for it. */
  wakeAnswer: (at: number) => boolean;
  /** Builds a new gateway over the same storage, as a restarted Repo would. */
  restart: () => void;
  /** The pushes waiting for their record, as stored. */
  pending: () => { claim_id: string; generation: number; attempts: number; due_at: number }[];
  /** Runs one statement on the gateway's storage. */
  exec: (query: string, ...bindings: SqlStorageValue[]) => void;
}

/** A `ClaimsPort` whose `authorizeGit` follows the A21 contract over one mutable claim. */
function claimsFor(world: World): ClaimsPort {
  return {
    ...unavailableClaims,
    async authorizeGit(access) {
      world.authorizations.push(access);
      if (world.claimsDown) return fail("unavailable", "The claims module is unavailable.");
      if (world.authorize !== null) return world.authorize(access);
      const { principal, target, operation } = access;
      if (principal === null || principal.repoId !== REPO) {
        return fail("unauthenticated", "A Git request needs a session for this repository.");
      }
      if (target.kind === "main") {
        if (operation === "push")
          return fail("invalid_request", "Main is written only by the train.");
        return ok({ repo: world.mainName, scope: "read", fence: null });
      }
      if (target.claimId !== CLAIM) return fail("not_found", "The claim has no fork.");
      if (operation === "fetch") return ok({ repo: world.forkName, scope: "read", fence: null });
      if (world.claim.agentId !== principal.agentId) {
        return fail("stale_generation", "This agent does not hold the claim.");
      }
      switch (world.claim.state) {
        case "working":
          return ok({
            repo: world.forkName,
            scope: "write",
            fence: { claimId: CLAIM, generation: world.claim.generation },
          });
        case "ready":
          return fail("after_ready", "The claim is ready, so its fork takes no more pushes.");
        case "expired":
          return fail("claim_closed", "The claim is closed.");
        default:
          return world.claim.state satisfies never;
      }
    },
    workingGeneration(claimId) {
      const fault = world.generationFault;
      if (fault !== null && fault.times > 0) {
        fault.times -= 1;
        throw fault.error;
      }
      return claimId === CLAIM && world.claim.state === "working" ? world.claim.generation : null;
    },
  };
}

const sessions: SessionsPort = {
  ...unavailableSessions,
  async authenticate(token) {
    if (token === SESSION) return ok(AGENT);
    if (token === OTHER_SESSION) return ok(OTHER);
    return fail("unauthenticated", "The session is not valid.");
  },
};

/** Runs `body` against a gateway over real storage, the real Artifacts adapter and a fake upstream. */
function withGateway(
  body: (world: World) => Promise<void>,
  limits: GitGatewayLimits = FAST,
  wrapArtifacts: (base: ArtifactsPort) => ArtifactsPort = (base) => base,
): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const fake = new FakeArtifacts();
    const mainName = await mainRepoName(REPO);
    fake.seed(mainName, [ROOT, HEAD]);
    const adapter = createArtifactsAdapter(
      { repoId: REPO, storage: state.storage, clock: fake.clock, namespace: fake },
      { ...ARTIFACTS_LIMITS, callTimeoutMs: 100 },
    );
    const forked = await adapter.forkForClaim(CLAIM, HEAD);
    if (!forked.ok) throw new Error(`fork failed: ${forked.code}`);
    const artifacts = wrapArtifacts(adapter);
    const log = EventLog.open(state.storage, REPO, fake.clock);
    const forkName = await forkRepoName(REPO, CLAIM);
    const allTokens = (): string[] =>
      [...fake.repos.values()].flatMap((repo) => repo.tokens.map((token) => token.plaintext));
    // Forking mints one token that the adapter revokes at once; it is not the gateway's.
    const setupTokens = allTokens().length;
    const world: World = {
      gateway: {
        serve: () => Promise.reject(new Error("not built")),
        resume: () => Promise.reject(new Error("not built")),
      },
      fake,
      artifacts,
      mainName,
      forkName,
      claim: { agentId: AGENT.agentId, generation: 3, state: "working" },
      authorizations: [],
      claimsDown: false,
      authorize: null,
      generationFault: null,
      seen: [],
      observations: [],
      fork: [[HEAD, "refs/heads/main"]],
      pushing: 0,
      respond: () => new Response(null, { status: 500 }),
      upstream: async (request) => {
        const bytes = new Uint8Array(await request.arrayBuffer());
        // A read while a push is served, before its response, is the gateway's read of the fork.
        const observation = world.pushing > 0 && request.method === "GET";
        (observation ? world.observations : world.seen).push({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: bytes,
        });
        // The fake Git endpoint refuses any token Artifacts would refuse.
        const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (!fake.accepts(bearer)) return new Response("bad token", { status: 401 });
        if (!observation) return world.respond(request, bytes);
        return world.fork === null
          ? new Response(null, { status: 500 })
          : advertisement(world.fork);
      },
      remote: async (repo) => ok(`https://fake.artifacts.invalid/${repo}.git`),
      events: () => log.replay(0, 100).events,
      minted: () => allTokens().length - setupTokens,
      tokens: allTokens,
      live: () => [...fake.liveTokens(mainName), ...fake.liveTokens(forkName)],
      skew: 0,
      wakes: [],
      wakeAnswer: () => true,
      restart: () => {
        world.gateway = build();
      },
      pending: () =>
        state.storage.sql
          .exec<{ claim_id: string; generation: number; attempts: number; due_at: number }>(
            "SELECT claim_id, generation, attempts, due_at FROM git_pending_push ORDER BY id",
          )
          .toArray(),
      exec: (query, ...bindings) => {
        state.storage.sql.exec(query, ...bindings);
      },
    };
    const claims = claimsFor(world);
    const build = (): GitPort => {
      const gateway = createGitGateway(
        {
          log,
          storage: state.storage,
          clock: () => Date.now() + world.skew,
          wake: (at) => {
            world.wakes.push(at);
            // Resolved later, as the Repo's alarm write is.
            const answer = world.wakeAnswer(at);
            return new Promise((resolve) => setTimeout(() => resolve(answer), 0));
          },
          ports: () => ({ sessions, claims, artifacts }),
          remote: (repo) => world.remote(repo),
          upstream: (request) => world.upstream(request),
        },
        limits,
      );
      return {
        async serve(request, target, path) {
          const push = request.method === "POST" && path === "/git-receive-pack";
          if (push) world.pushing += 1;
          try {
            return await gateway.serve(request, target, path);
          } finally {
            if (push) world.pushing -= 1;
          }
        },
        resume: () => gateway.resume(),
      };
    };
    world.gateway = build();
    await body(world);
  });
}

function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function advertise(service: string, auth: string | null = basic(AGENT.agentId, SESSION)): Request {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return new Request(`https://railhead.test/git/acme/demo.git/info/refs?service=${service}`, {
    headers,
  });
}

function rpc(
  service: "git-upload-pack" | "git-receive-pack",
  body: BodyInit,
  extra: Record<string, string> = {},
): Request {
  return new Request(`https://railhead.test/git/acme/demo.git/${service}`, {
    method: "POST",
    headers: {
      authorization: basic(AGENT.agentId, SESSION),
      "content-type": `application/x-${service}-request`,
      ...extra,
    },
    body,
  });
}

function gitResponse(service: string, kind: "advertisement" | "result", body: BodyInit): Response {
  return new Response(body, { headers: { "content-type": `application/x-${service}-${kind}` } });
}

/** A pkt-line, written by hand so the tests do not reuse the subject's encoder. */
function pkt(payload: string): string {
  return (encoder.encode(payload).length + 4).toString(16).padStart(4, "0") + payload;
}

function pushBody(lines: string[], caps = "report-status side-band-64k"): Uint8Array {
  const [first = "", ...rest] = lines;
  return encoder.encode(
    `${pkt(`${first}\0${caps}\n`)}${rest.map((line) => pkt(`${line}\n`)).join("")}0000PACK`,
  );
}

function sideBand(report: string): string {
  return `${pkt(`\u0001${report}`)}0000`;
}

/** `report` in band 1, split into packets of at most 60,000 bytes, then the outer flush. */
function sideBands(report: string): string {
  const packets: string[] = [];
  for (let at = 0; at < report.length; at += 60_000) {
    packets.push(pkt(`\u0001${report.slice(at, at + 60_000)}`));
  }
  return `${packets.join("")}0000`;
}

/** A refused ref and an option line that together pass the 64 KiB report bound. */
const OVERSIZED_REFUSAL = `${pkt(`ng refs/heads/a ${"x".repeat(60_000)}\n`)}${pkt(`option refname ${"y".repeat(10_000)}\n`)}`;

/** About 4 MiB of side-band progress, four times the response buffer a push holds for its client. */
const PROGRESS_FLOOD = Array.from({ length: 64 }, () =>
  encoder.encode(pkt(`\u0002${"r".repeat(65_000)}`)),
);

function bytesOf(response: Response): Promise<Uint8Array> {
  return response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function pushedEvents(world: World): RailheadEvent[] {
  return world.events().filter((event) => event.type === "claim.pushed");
}

let logged: string[] = [];

/** The warning for a push that moved the claim's fork without a `claim.pushed` event. */
function unrecorded(
  reason:
    | "claim_changed"
    | "record_failed"
    | "outcome_unknown"
    | "reconcile_failed"
    | "unreadable_record",
  unproven?: "unobserved" | "later_push",
): string {
  return JSON.stringify({
    event: "git_push_unrecorded",
    claimId: CLAIM,
    generation: 3,
    reason,
    ...(unproven === undefined ? {} : { unproven }),
  });
}

/** The `outcome_unknown` warnings logged so far, after checking no line names a ref or commit. */
function unknownOutcomes(): number {
  for (const line of logged) {
    for (const leaked of ["refs/heads/", PUSHED, ROOT, HEAD]) expect(line).not.toContain(leaked);
  }
  return logged.filter((line) => line === unrecorded("outcome_unknown")).length;
}

beforeEach(() => {
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Asserts that no minted token appears in the client's view or in any log line. */
function expectNoTokenLeak(world: World, clientView: string): void {
  const tokens = world.tokens();
  expect(tokens.length).toBeGreaterThan(0);
  for (const token of tokens) {
    expect(clientView).not.toContain(token);
    for (const line of logged) expect(line).not.toContain(token);
  }
  for (const line of logged) expect(line).not.toContain(SESSION);
}

describe("stock Git through the gateway", () => {
  it("serves a shallow protocol v2 clone of a fork byte for byte", async () => {
    await withGateway(async (world) => {
      world.respond = (request) =>
        request.method === "GET"
          ? gitResponse("git-upload-pack", "advertisement", "000eversion 2\n0000")
          : gitResponse("git-upload-pack", "result", SHALLOW_FETCH_RESULT);

      const advertised = await world.gateway.serve(
        advertise("git-upload-pack"),
        FORK,
        "/info/refs",
      );
      expect(advertised.status).toBe(200);
      expect(advertised.headers.get("content-type")).toBe(
        "application/x-git-upload-pack-advertisement",
      );
      expect(await advertised.text()).toBe("000eversion 2\n0000");

      const fetched = await world.gateway.serve(
        rpc("git-upload-pack", SHALLOW_FETCH_REQUEST, { "git-protocol": "version=2" }),
        FORK,
        "/git-upload-pack",
      );
      expect(fetched.status).toBe(200);
      expect(await bytesOf(fetched)).toEqual(SHALLOW_FETCH_RESULT);

      const [get, post] = world.seen;
      expect(get?.url).toBe(
        `https://fake.artifacts.invalid/${world.forkName}.git/info/refs?service=git-upload-pack`,
      );
      expect(post?.url).toBe(
        `https://fake.artifacts.invalid/${world.forkName}.git/git-upload-pack`,
      );
      expect(post?.body).toEqual(SHALLOW_FETCH_REQUEST);
      expect(post?.headers.get("git-protocol")).toBe("version=2");
      // The client's session never reaches Artifacts; a read token minted here does.
      const [read] = world.live();
      expect(read?.scope).toBe("read");
      expect(post?.headers.get("authorization")).toBe(`Bearer ${read?.plaintext}`);
      expect(world.authorizations.map((access) => access.operation)).toEqual(["fetch", "fetch"]);
      expect(pushedEvents(world)).toEqual([]);
    });
  });

  it("forwards a shallow clone's push untouched and records the branch it reported updated", async () => {
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);

      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);

      expect(world.seen[0]?.body).toEqual(PUSH_REQUEST);
      // The fork was read once before the push was released, under a read token of its own.
      expect(world.observations.map((seen) => seen.url)).toEqual([
        `https://fake.artifacts.invalid/${world.forkName}.git/info/refs?service=git-upload-pack`,
      ]);
      expect(
        world.fake
          .liveTokens(world.forkName)
          .map((token) => token.scope)
          .toSorted(),
      ).toEqual(["read", "write"]);
      expect(pushedEvents(world)).toMatchObject([
        {
          actor: { kind: "agent", id: AGENT.agentId },
          data: {
            claimId: CLAIM,
            generation: 3,
            ref: "refs/heads/feature",
            from: null,
            to: PUSHED,
          },
        },
      ]);
    });
  });

  it("streams a push to the upstream before the client has finished sending it", async () => {
    await withGateway(async (world) => {
      let release: (() => void) | undefined;
      const upstreamStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = (): void => {
        release?.();
      };
      const received: Uint8Array[] = [];
      world.upstream = async (request) => {
        const reader = request.body?.getReader();
        if (reader === undefined) throw new Error("no body");
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(value);
          started();
        }
        return gitResponse("git-receive-pack", "result", PUSH_RESULT);
      };
      const half = PUSH_REQUEST.length >> 1;
      // The second half is sent only once the upstream has read some of the first: a gateway that
      // buffered the whole body would wait forever.
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(PUSH_REQUEST.slice(0, half));
          await upstreamStarted;
          controller.enqueue(PUSH_REQUEST.slice(half));
          controller.close();
        },
      });
      const response = await world.gateway.serve(
        rpc("git-receive-pack", body),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);
      expect(concatAll(received)).toEqual(PUSH_REQUEST);
      expect(pushedEvents(world)).toHaveLength(1);
    });
  });
});

// Stock Git 2.50.1 POSTs this 4-byte body, with `content-length: 4`, before streaming a push
// larger than `http.postBuffer` (1 MiB by default), and fails the push unless it gets a 200.
const PROBE = "0000";

/** A request with `bytes` sent in `size`-byte chunks and no declared length, as Git streams it. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

describe("a push larger than Git's post buffer", () => {
  it("answers Git's probe with an empty result, minting nothing and reaching no upstream", async () => {
    await withGateway(async (world) => {
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PROBE),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
      expect(await bytesOf(response)).toEqual(new Uint8Array(0));
      expect(world.authorizations.map((access) => access.operation)).toEqual(["push"]);
      expect(world.seen).toEqual([]);
      expect(world.minted()).toBe(0);
      expect(world.events()).toEqual([]);
      expect(logged).toEqual([]);
    });
  });

  it("still asks a probe without valid credentials to authenticate", async () => {
    await withGateway(async (world) => {
      for (const auth of [null, basic(AGENT.agentId, "not-a-session")]) {
        const headers = new Headers({ "content-type": "application/x-git-receive-pack-request" });
        if (auth !== null) headers.set("authorization", auth);
        const response = await world.gateway.serve(
          new Request("https://railhead.test/git/acme/demo.git/git-receive-pack", {
            method: "POST",
            headers,
            body: PROBE,
          }),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Basic");
      }
      expect(world.seen).toEqual([]);
      expect(world.minted()).toBe(0);
    });
  });

  it("refuses the probe as an HTTP error when the agent does not hold the claim", async () => {
    await withGateway(async (world) => {
      world.claim.agentId = OTHER.agentId;
      const probed = await world.gateway.serve(
        rpc("git-receive-pack", PROBE),
        FORK,
        "/git-receive-pack",
      );
      // An empty result would tell Git the probe passed; the refusal ends the push here instead.
      expect(probed.status).toBe(403);
      expect(probed.headers.get("content-type")).not.toBe("application/x-git-receive-pack-result");
      expect(await probed.text()).toBe("railhead: This agent does not hold the claim.\n");
      expect(world.seen).toEqual([]);
      expect(world.minted()).toBe(0);
      expect(world.events()).toEqual([]);
    });
  });

  it("forwards and records the chunked push of more than 1 MiB that follows the probe", async () => {
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
      const pack = new Uint8Array(1536 * 1024);
      for (let index = 0; index < pack.length; index += 1) pack[index] = index % 251;
      const large = concatAll([PUSH_REQUEST, pack]);

      const probed = await world.gateway.serve(
        rpc("git-receive-pack", PROBE),
        FORK,
        "/git-receive-pack",
      );
      expect(probed.status).toBe(200);
      await bytesOf(probed);
      const pushed = await world.gateway.serve(
        rpc("git-receive-pack", chunked(large, 64 * 1024)),
        FORK,
        "/git-receive-pack",
      );
      expect(pushed.status).toBe(200);
      expect(await bytesOf(pushed)).toEqual(PUSH_RESULT);

      expect(world.seen).toHaveLength(1);
      // A digest, since comparing 1.5 MiB element by element outlasts the test timeout on CI.
      const forwarded = world.seen[0]?.body ?? new Uint8Array(0);
      expect(forwarded.length).toBe(large.length);
      expect(await sha256(forwarded)).toBe(await sha256(large));
      expect(pushedEvents(world)).toMatchObject([
        { data: { ref: "refs/heads/feature", from: null, to: PUSHED } },
      ]);
      expect(unknownOutcomes()).toBe(0);
    });
  });
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatAll(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("authority", () => {
  it("never lets a push reach main, without asking anyone", async () => {
    await withGateway(async (world) => {
      const advertised = await world.gateway.serve(
        advertise("git-receive-pack"),
        MAIN,
        "/info/refs",
      );
      expect(advertised.status).toBe(403);
      expect(await advertised.text()).toContain("main is read-only");
      const pushed = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        MAIN,
        "/git-receive-pack",
      );
      expect(pushed.status).toBe(403);
      expect(world.authorizations).toEqual([]);
      expect(world.seen).toEqual([]);
      expect(world.live()).toEqual([]);
      expect(pushedEvents(world)).toEqual([]);
    });
  });

  it("lets an agent fetch main with a read token", async () => {
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-upload-pack", "advertisement", "0000");
      const response = await world.gateway.serve(advertise("git-upload-pack"), MAIN, "/info/refs");
      expect(response.status).toBe(200);
      expect(world.seen[0]?.url).toContain(`/${world.mainName}.git/info/refs`);
      expect(world.fake.liveTokens(world.mainName).map((token) => token.scope)).toEqual(["read"]);
    });
  });

  it("asks for credentials when none, bad ones or another agent's are sent", async () => {
    await withGateway(async (world) => {
      for (const auth of [
        null,
        "Bearer something",
        basic(AGENT.agentId, "not-a-session"),
        basic(AGENT.agentId, OTHER_SESSION),
        "Basic !!!",
      ]) {
        const response = await world.gateway.serve(
          advertise("git-upload-pack", auth),
          FORK,
          "/info/refs",
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Basic");
      }
      expect(world.seen).toEqual([]);
      expect(world.live()).toEqual([]);
    });
  });

  it("refuses a push by an agent that no longer holds the claim, at both steps", async () => {
    await withGateway(async (world) => {
      world.claim.agentId = OTHER.agentId;
      const advertised = await world.gateway.serve(
        advertise("git-receive-pack"),
        FORK,
        "/info/refs",
      );
      expect(advertised.status).toBe(403);
      expect(await advertised.text()).toContain("does not hold the claim");

      const pushed = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      // Git prints the reason beside the ref.
      expect(pushed.status).toBe(200);
      expect(decoder.decode(await bytesOf(pushed))).toContain(
        "ng refs/heads/feature This agent does not hold the claim.",
      );
      expect(world.seen).toEqual([]);
      expect(world.live()).toEqual([]);
      expect(pushedEvents(world)).toEqual([]);
    });
  });

  it("refuses a push without a report as an HTTP error when the agent does not hold the claim", async () => {
    for (const caps of ["side-band-64k", "", "ofs-delta"]) {
      await withGateway(async (world) => {
        world.claim.agentId = OTHER.agentId;
        const pushed = await world.gateway.serve(
          rpc("git-receive-pack", pushBody([`${ZERO} ${HEAD} refs/heads/topic`], caps)),
          FORK,
          "/git-receive-pack",
        );
        // Git takes an empty result for a push that asked for no report as applied.
        expect(pushed.status, caps).toBe(403);
        expect(await pushed.text(), caps).toBe("railhead: This agent does not hold the claim.\n");
        expect(world.seen, caps).toEqual([]);
        expect(world.minted(), caps).toBe(0);
        expect(world.events(), caps).toEqual([]);
      });
    }
  });

  it("refuses with 500 a grant that does not fit the request, before minting a token", async () => {
    const otherClaim = "clm_gitclaim0002";
    const cases: [string, () => Request, string, GitGrant][] = [
      [
        "write grant for a fetch",
        () => advertise("git-upload-pack"),
        "/info/refs",
        { repo: "", scope: "write", fence: null },
      ],
      [
        "fenced read grant for a fetch",
        () => rpc("git-upload-pack", SHALLOW_FETCH_REQUEST),
        "/git-upload-pack",
        { repo: "", scope: "read", fence: { claimId: CLAIM, generation: 3 } },
      ],
      [
        "read grant for a push",
        () => advertise("git-receive-pack"),
        "/info/refs",
        { repo: "", scope: "read", fence: { claimId: CLAIM, generation: 3 } },
      ],
      [
        "unfenced write grant for a push",
        () => rpc("git-receive-pack", PUSH_REQUEST),
        "/git-receive-pack",
        { repo: "", scope: "write", fence: null },
      ],
      [
        "push fenced to another claim",
        () => rpc("git-receive-pack", PUSH_REQUEST),
        "/git-receive-pack",
        { repo: "", scope: "write", fence: { claimId: otherClaim, generation: 3 } },
      ],
    ];
    for (const [label, request, path, grant] of cases) {
      await withGateway(async (world) => {
        world.authorize = () => ok({ ...grant, repo: world.forkName });
        world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
        const response = await world.gateway.serve(request(), FORK, path);
        expect(response.status, label).toBe(500);
        expect(await response.text(), label).toContain("does not match the request");
        expect(world.minted(), label).toBe(0);
        expect(world.seen, label).toEqual([]);
        expect(world.events(), label).toEqual([]);
      });
    }
  });

  it("refuses a push held for a person with 403 and its message, before minting a token", async () => {
    await withGateway(async (world) => {
      world.authorize = () =>
        fail("check_held", "The candidate edits protected check paths; a person must approve it.");
      const advertised = await world.gateway.serve(
        advertise("git-receive-pack"),
        FORK,
        "/info/refs",
      );

      expect(advertised.status).toBe(403);
      expect(await advertised.text()).toBe(
        "railhead: The candidate edits protected check paths; a person must approve it.\n",
      );
      expect(world.minted()).toBe(0);
      expect(world.seen).toEqual([]);
      expect(world.events()).toEqual([]);
    });
  });

  it("answers a fetch refused at its POST with an ERR packet, or an HTTP error past 403", async () => {
    await withGateway(async (world) => {
      world.authorize = () => fail("claim_closed", "The claim is closed.");
      const refused = await world.gateway.serve(
        rpc("git-upload-pack", SHALLOW_FETCH_REQUEST),
        FORK,
        "/git-upload-pack",
      );
      expect(refused.status).toBe(200);
      expect(refused.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
      expect(await refused.text()).toBe(pkt("ERR railhead: The claim is closed.\n"));

      world.authorize = () => fail("not_found", "The claim has no fork.");
      const missing = await world.gateway.serve(
        rpc("git-upload-pack", SHALLOW_FETCH_REQUEST),
        FORK,
        "/git-upload-pack",
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("railhead: The claim has no fork.\n");
      expect(world.minted()).toBe(0);
      expect(world.seen).toEqual([]);
    });
  });

  it("asks the claims module again on every request, even with a token cached", async () => {
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "advertisement", "0000");
      const first = await world.gateway.serve(advertise("git-receive-pack"), FORK, "/info/refs");
      expect(first.status).toBe(200);
      await first.body?.cancel();

      world.claim.state = "ready";
      const second = await world.gateway.serve(advertise("git-receive-pack"), FORK, "/info/refs");
      expect(second.status).toBe(403);
      expect(await second.text()).toContain("ready");
      expect(world.authorizations).toHaveLength(2);
      expect(world.seen).toHaveLength(1);
      // One write token was minted for the first request; the second minted none.
      expect(world.fake.liveTokens(world.forkName)).toHaveLength(1);
    });
  });

  it("hands out only a token that outlives the request, minting a fresh one when it would not", async () => {
    // Real timers bound the request; the fake clock only ages the token, so these stay fast.
    const limits: GitGatewayLimits = { ...FAST, maxDurationMs: 40_000, tokenTtlMs: 60_000 };
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "advertisement", "0000");
      const remaining: number[] = [];
      // At 25 s a 60 s token would have 35 s left, under the 40 s a request may take.
      for (const elapsed of [0, 25_000, 20_000]) {
        world.fake.advance(elapsed);
        const response = await world.gateway.serve(
          advertise("git-receive-pack"),
          FORK,
          "/info/refs",
        );
        expect(response.status).toBe(200);
        await response.body?.cancel();
        const bearer = world.seen
          .at(-1)
          ?.headers.get("authorization")
          ?.replace(/^Bearer /, "");
        const token = world.fake.repos
          .get(world.forkName)
          ?.tokens.find((candidate) => candidate.plaintext === bearer);
        remaining.push((token?.expiresAtMs ?? 0) - world.fake.clock());
      }
      expect(remaining).toEqual([80_000, 55_000, 80_000]);
      expect(world.minted()).toBe(2);
    }, limits);
  });

  it("refuses a whole push when one of its refs is not a branch", async () => {
    await withGateway(async (world) => {
      const body = pushBody([`${ZERO} ${HEAD} refs/heads/topic`, `${ZERO} ${HEAD} refs/tags/v1`]);
      const response = await world.gateway.serve(
        rpc("git-receive-pack", body),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      const report = decoder.decode(await bytesOf(response));
      expect(report).toContain("ng refs/tags/v1 only branches under refs/heads/ can be pushed");
      expect(report).toContain("ng refs/heads/topic refused with the rest of this push");
      expect(world.seen).toEqual([]);
      expect(world.live()).toEqual([]);
      expect(pushedEvents(world)).toEqual([]);
    });
  });

  it("refuses a whole push that names the same branch twice, before minting a token", async () => {
    const C = "3".repeat(40);
    const cases: [string, string[]][] = [
      ["two targets", [`${ROOT} ${HEAD} refs/heads/x`, `${ROOT} ${C} refs/heads/x`]],
      [
        "repeated apart",
        [
          `${ROOT} ${HEAD} refs/heads/x`,
          `${ZERO} ${HEAD} refs/heads/y`,
          `${HEAD} ${C} refs/heads/x`,
        ],
      ],
      ["identical", [`${ROOT} ${HEAD} refs/heads/x`, `${ROOT} ${HEAD} refs/heads/x`]],
    ];
    for (const [label, commands] of cases) {
      await withGateway(async (world) => {
        world.respond = () =>
          gitResponse(
            "git-receive-pack",
            "result",
            sideBand(`${pkt("unpack ok\n")}${pkt("ok refs/heads/x\n")}0000`),
          );
        const response = await world.gateway.serve(
          rpc("git-receive-pack", pushBody(commands)),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status, label).toBe(200);
        const report = decoder.decode(await bytesOf(response));
        expect(report, label).toContain(
          "ng refs/heads/x the branch is named more than once in this push",
        );
        expect(report, label).not.toContain("ok refs/heads/");
        expect(world.seen, label).toEqual([]);
        expect(world.minted(), label).toBe(0);
        expect(world.events(), label).toEqual([]);
      });
    }
  });

  it("refuses a bare refs/heads/, a branch name past the event limit and non-SHA-1 ids", async () => {
    // refs/heads/ is 11 bytes, so this name is one byte past the 1024 an event can carry.
    const tooLong = `refs/heads/${"b".repeat(1014)}`;
    const cases: [string, string, string][] = [
      [
        "bare prefix",
        `${ZERO} ${HEAD} refs/heads/`,
        "only branches under refs/heads/ can be pushed",
      ],
      ["long branch", `${ZERO} ${HEAD} ${tooLong}`, "the branch name is too long"],
      [
        "SHA-256 create",
        `${"0".repeat(64)} ${"2".repeat(64)} refs/heads/topic`,
        "only SHA-1 repositories are supported",
      ],
      [
        "SHA-256 update",
        `${"1".repeat(64)} ${"2".repeat(64)} refs/heads/topic`,
        "only SHA-1 repositories are supported",
      ],
      [
        "SHA-256 delete",
        `${"1".repeat(64)} ${"0".repeat(64)} refs/heads/topic`,
        "only SHA-1 repositories are supported",
      ],
    ];
    for (const [label, command, reason] of cases) {
      await withGateway(async (world) => {
        const response = await world.gateway.serve(
          rpc("git-receive-pack", pushBody([command])),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status, label).toBe(200);
        const ref = command.split(" ")[2] ?? "";
        expect(decoder.decode(await bytesOf(response)), label).toContain(`ng ${ref} ${reason}`);
        expect(world.seen, label).toEqual([]);
        expect(world.minted(), label).toBe(0);
        expect(world.events(), label).toEqual([]);
      });
    }
  });

  it("refuses a branch deletion, alone or beside an update, before minting a token", async () => {
    const cases: [string, string[]][] = [
      ["delete alone", [`${HEAD} ${ZERO} refs/heads/topic`]],
      [
        "delete beside an update",
        [`${ZERO} ${HEAD} refs/heads/x`, `${HEAD} ${ZERO} refs/heads/topic`],
      ],
    ];
    for (const [label, commands] of cases) {
      await withGateway(async (world) => {
        // An upstream that would apply anything, so only the gateway can keep the delete out.
        world.respond = () =>
          gitResponse(
            "git-receive-pack",
            "result",
            sideBand(`${pkt("unpack ok\n")}${pkt("ok refs/heads/topic\n")}0000`),
          );
        const response = await world.gateway.serve(
          rpc("git-receive-pack", pushBody(commands)),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status, label).toBe(200);
        const report = decoder.decode(await bytesOf(response));
        expect(report, label).toContain(
          "ng refs/heads/topic branches cannot be deleted through Railhead",
        );
        expect(report, label).not.toContain("ok refs/heads/");
        expect(world.seen, label).toEqual([]);
        expect(world.minted(), label).toBe(0);
        expect(world.events(), label).toEqual([]);
      });
    }
  });

  it("refuses a deletion that asks for no report as an HTTP error", async () => {
    await withGateway(async (world) => {
      const response = await world.gateway.serve(
        rpc("git-receive-pack", pushBody([`${HEAD} ${ZERO} refs/heads/topic`], "side-band-64k")),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("railhead: pushes must request report-status\n");
      expect(world.seen).toEqual([]);
      expect(world.minted()).toBe(0);
      expect(world.events()).toEqual([]);
    });
  });

  it("forwards and records a branch name exactly at the event limit", async () => {
    const longest = `refs/heads/${"b".repeat(1013)}`;
    expect(encoder.encode(longest).length).toBe(1024);
    await withGateway(async (world) => {
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          sideBand(`${pkt("unpack ok\n")}${pkt(`ok ${longest}\n`)}0000`),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", pushBody([`${ZERO} ${HEAD} ${longest}`])),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      await bytesOf(response);
      expect(world.seen).toHaveLength(1);
      expect(pushedEvents(world)).toMatchObject([{ data: { ref: longest, from: null, to: HEAD } }]);
    });
  });

  it("refuses a push that does not ask for a report, before minting a token", async () => {
    for (const caps of ["side-band-64k", "", "ofs-delta"]) {
      await withGateway(async (world) => {
        world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
        const response = await world.gateway.serve(
          rpc("git-receive-pack", pushBody([`${ZERO} ${HEAD} refs/heads/topic`], caps)),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status, caps).toBe(403);
        expect(await response.text(), caps).toBe("railhead: pushes must request report-status\n");
        expect(world.seen, caps).toEqual([]);
        expect(world.minted(), caps).toBe(0);
        expect(world.events(), caps).toEqual([]);
      });
    }
  });

  it("refuses a push with a refused ref and no report as an HTTP error, never an empty result", async () => {
    await withGateway(async (world) => {
      const response = await world.gateway.serve(
        rpc("git-receive-pack", pushBody([`${ZERO} ${HEAD} refs/tags/v1`], "side-band-64k")),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("railhead: pushes must request report-status\n");
      expect(world.seen).toEqual([]);
      expect(world.minted()).toBe(0);
    });
  });

  it("forwards a push that asks only for report-status-v2", async () => {
    await withGateway(async (world) => {
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          `${pkt("unpack ok\n")}${pkt("ok refs/heads/topic\n")}0000`,
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", pushBody([`${ZERO} ${HEAD} refs/heads/topic`], "report-status-v2")),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      await bytesOf(response);
      expect(world.seen).toHaveLength(1);
      expect(pushedEvents(world)).toMatchObject([{ data: { ref: "refs/heads/topic", to: HEAD } }]);
    });
  });
});

/** A push body that sends `PUSH_REQUEST` up to `cut` bytes, then the rest once `resume` is called. */
function pausedPush(cut: number): { body: ReadableStream<Uint8Array>; resume: () => void } {
  let release: (() => void) | undefined;
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = (): void => {
    release?.();
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(PUSH_REQUEST.slice(0, cut));
      await resumed;
      controller.enqueue(PUSH_REQUEST.slice(cut));
      controller.close();
    },
  });
  return { body, resume };
}

/** Resolves once `condition` holds, polling briefly; fails the test rather than hanging. */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the condition never held");
}

describe("a push decided again after it was admitted", () => {
  it("mints nothing and sends nothing when the claim closes while the head is held back", async () => {
    const changes: [string, (world: World) => void, string][] = [
      [
        "closed",
        (world) => {
          world.claim.state = "expired";
        },
        "ng refs/heads/feature The claim is closed.",
      ],
      [
        "taken over",
        (world) => {
          world.claim.agentId = OTHER.agentId;
          world.claim.generation += 1;
        },
        "ng refs/heads/feature This agent does not hold the claim.",
      ],
      [
        "reclaimed at a new generation",
        (world) => {
          world.claim.generation += 1;
        },
        "ng refs/heads/feature the claim changed while this push was being sent",
      ],
    ];
    for (const [label, change, report] of changes) {
      await withGateway(async (world) => {
        world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
        // Ten bytes is inside the first pkt-line: the head cannot be complete.
        const { body, resume } = pausedPush(10);
        const pending = world.gateway.serve(
          rpc("git-receive-pack", body),
          FORK,
          "/git-receive-pack",
        );
        await until(() => world.authorizations.length === 1);
        change(world);
        const revoked = await world.artifacts.revokeTokens(world.forkName);
        expect(revoked.ok, label).toBe(true);
        resume();
        const response = await pending;
        expect(response.status, label).toBe(200);
        expect(decoder.decode(await bytesOf(response)), label).toContain(report);
        expect(world.authorizations, label).toHaveLength(2);
        expect(world.minted(), label).toBe(0);
        expect(world.seen, label).toEqual([]);
        expect(pushedEvents(world), label).toEqual([]);
      });
    }
  });

  it("sends nothing when the claim closes while the token or remote is being prepared", async () => {
    let duringMint: (() => Promise<void>) | null = null;
    const pausingMint = (base: ArtifactsPort): ArtifactsPort => ({
      forkForClaim: (claimId, commit) => base.forkForClaim(claimId, commit),
      commitExists: (repo, commit) => base.commitExists(repo, commit),
      revokeTokens: (repo) => base.revokeTokens(repo),
      async token(repo, scope, ttlMs) {
        const minted = await base.token(repo, scope, ttlMs);
        // The read token is the fork read's before release; the push's own is the write token.
        if (scope === "write") await duringMint?.();
        return minted;
      },
    });
    for (const step of ["token", "remote"] as const) {
      await withGateway(
        async (world) => {
          world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
          const close = async (): Promise<void> => {
            world.claim.state = "expired";
            const revoked = await world.artifacts.revokeTokens(world.forkName);
            expect(revoked.ok, step).toBe(true);
          };
          duringMint = step === "token" ? close : null;
          if (step === "remote") {
            const remote = world.remote;
            let lookups = 0;
            world.remote = async (repo) => {
              // The first lookup is the fork read's before release; the second is the push's own.
              lookups += 1;
              if (lookups === 2) await close();
              return remote(repo);
            };
          }
          const response = await world.gateway.serve(
            rpc("git-receive-pack", PUSH_REQUEST),
            FORK,
            "/git-receive-pack",
          );
          expect(response.status, step).toBe(200);
          expect(decoder.decode(await bytesOf(response)), step).toContain(
            "ng refs/heads/feature The claim is closed.",
          );
          // The fork read's token and the push's were minted before the claim closed, and the
          // closure revoked both.
          expect(world.minted(), step).toBe(2);
          expect(world.fake.liveTokens(world.forkName), step).toEqual([]);
          expect(world.authorizations, step).toHaveLength(3);
          expect(world.seen, step).toEqual([]);
          expect(pushedEvents(world), step).toEqual([]);
        },
        FAST,
        pausingMint,
      );
    }
  });

  it("forwards a push whose claim is unchanged after deciding it three times", async () => {
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);
      expect(world.authorizations).toHaveLength(3);
      expect(world.seen).toHaveLength(1);
      expect(pushedEvents(world)).toHaveLength(1);
    });
  });

  it("records nothing when the claim expires, changes hands or goes ready while the upstream answers", async () => {
    const changes: [string, (world: World) => void][] = [
      [
        "expired",
        (world) => {
          world.claim.state = "expired";
        },
      ],
      [
        "reassigned",
        (world) => {
          world.claim.agentId = OTHER.agentId;
          world.claim.generation += 1;
        },
      ],
      [
        "ready",
        (world) => {
          world.claim.state = "ready";
        },
      ],
    ];
    for (const [label, change] of changes) {
      await withGateway(async (world) => {
        // The upstream has the whole push and has accepted it; the claim changes before it answers.
        world.respond = () => {
          change(world);
          return gitResponse("git-receive-pack", "result", PUSH_RESULT);
        };
        const response = await world.gateway.serve(
          rpc("git-receive-pack", PUSH_REQUEST),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status, label).toBe(200);
        expect(await bytesOf(response), label).toEqual(PUSH_RESULT);
        expect(world.seen, label).toHaveLength(1);
        expect(world.authorizations, label).toHaveLength(3);
        expect(pushedEvents(world), label).toEqual([]);
        expect(world.events(), label).toEqual([]);
        expect(logged, label).toContain(unrecorded("claim_changed"));
      });
    }
  });

  it("withholds the end of the pack when the claim changes during the upload", async () => {
    const held = 20;
    // The client stops five bytes short of the end, inside the pack's trailing checksum.
    const cut = PUSH_REQUEST.length - 5;
    const changes: [string, (world: World) => void][] = [
      [
        "expired",
        (world) => {
          world.claim.state = "expired";
        },
      ],
      [
        "reassigned",
        (world) => {
          world.claim.agentId = OTHER.agentId;
          world.claim.generation += 1;
        },
      ],
      [
        "ready",
        (world) => {
          world.claim.state = "ready";
        },
      ],
      [
        "reclaimed at a new generation",
        (world) => {
          world.claim.generation += 1;
        },
      ],
      ["unchanged", () => undefined],
    ];
    for (const [label, change] of changes) {
      await withGateway(async (world) => {
        const received: Uint8Array[] = [];
        let upstreamFailed = false;
        world.upstream = async (request) => {
          const reader = request.body?.getReader();
          if (reader === undefined) throw new Error("no body");
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              received.push(value);
            }
          } catch (error) {
            upstreamFailed = true;
            throw error;
          }
          return gitResponse("git-receive-pack", "result", PUSH_RESULT);
        };
        const { body, resume } = pausedPush(cut);
        const pending = world.gateway.serve(
          rpc("git-receive-pack", body),
          FORK,
          "/git-receive-pack",
        );
        // The upstream has everything the gateway can pass on before the client finishes.
        await until(() => concatAll(received).length === cut - held);
        change(world);
        resume();
        const response = await pending;
        expect(response.status, label).toBe(200);
        const answer = decoder.decode(await bytesOf(response));
        if (label === "unchanged") {
          expect(concatAll(received), label).toEqual(PUSH_REQUEST);
          expect(pushedEvents(world), label).toHaveLength(1);
          return;
        }
        expect(answer, label).toContain(
          "ng refs/heads/feature the claim changed while this push was being sent",
        );
        expect(upstreamFailed, label).toBe(true);
        expect(concatAll(received), label).toEqual(
          PUSH_REQUEST.slice(0, PUSH_REQUEST.length - held),
        );
        expect(world.authorizations, label).toHaveLength(3);
        expect(world.events(), label).toEqual([]);
      });
    }
  });

  it("records nothing when the claim changes while the response is still streaming", async () => {
    await withGateway(async (world) => {
      let finish: (() => void) | undefined;
      const [first, rest] = [PUSH_RESULT.slice(0, 8), PUSH_RESULT.slice(8)];
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(first);
              finish = () => {
                controller.enqueue(rest);
                controller.close();
              };
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      const reading = bytesOf(response);
      await until(() => finish !== undefined);
      world.claim.generation += 1;
      finish?.();
      expect(await reading).toEqual(PUSH_RESULT);
      expect(pushedEvents(world)).toEqual([]);
    });
  });

  it("answers 503 and sends nothing when the claims module is down at the second decision", async () => {
    await withGateway(async (world) => {
      const { body, resume } = pausedPush(10);
      const pending = world.gateway.serve(rpc("git-receive-pack", body), FORK, "/git-receive-pack");
      await until(() => world.authorizations.length === 1);
      world.claimsDown = true;
      resume();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(world.minted()).toBe(0);
      expect(world.seen).toEqual([]);
      expect(pushedEvents(world)).toEqual([]);
    });
  });
});

describe("invalid requests", () => {
  it("refuses dumb HTTP, wrong methods, wrong types and unknown paths before any authority", async () => {
    await withGateway(async (world) => {
      const cases: [Request, string, number][] = [
        [new Request("https://railhead.test/x/info/refs"), "/info/refs", 403],
        [
          new Request("https://railhead.test/x/info/refs?service=git-upload-pack", {
            method: "POST",
            body: "x",
          }),
          "/info/refs",
          405,
        ],
        [new Request("https://railhead.test/x/git-upload-pack"), "/git-upload-pack", 405],
        [new Request("https://railhead.test/x/HEAD"), "/HEAD", 404],
        [rpc("git-upload-pack", "0000", { "content-type": "text/plain" }), "/git-upload-pack", 415],
      ];
      for (const [request, path, status] of cases) {
        expect((await world.gateway.serve(request, FORK, path)).status).toBe(status);
      }
      expect(world.authorizations).toEqual([]);
      expect(world.seen).toEqual([]);
    });
  });

  it("refuses a malformed or compressed push without reaching the upstream", async () => {
    await withGateway(async (world) => {
      const malformed = await world.gateway.serve(
        rpc("git-receive-pack", "zzzz"),
        FORK,
        "/git-receive-pack",
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).toContain("malformed pkt-line length");
      const compressed = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST, { "content-encoding": "gzip" }),
        FORK,
        "/git-receive-pack",
      );
      expect(compressed.status).toBe(415);
      expect(world.seen).toEqual([]);
      expect(pushedEvents(world)).toEqual([]);
    });
  });
});

describe("bounds", () => {
  it("cuts off a client that stalls inside the push head, whether or not the claim admits it", async () => {
    const cases: [ClaimState, number, string][] = [
      ["working", 408, "did not arrive in time"],
      ["ready", 403, "The claim is ready"],
    ];
    for (const [state, status, message] of cases) {
      await withGateway(async (world) => {
        world.claim.state = state;
        let cancelled = false;
        // A length and half a command, then nothing: the head never completes and the body never ends.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`00b9${ZERO} ${HEAD} refs/he`));
          },
          cancel() {
            cancelled = true;
          },
        });
        const started = Date.now();
        const response = await world.gateway.serve(
          rpc("git-receive-pack", body),
          FORK,
          "/git-receive-pack",
        );
        expect(Date.now() - started, state).toBeLessThan(FAST.maxDurationMs);
        expect(response.status, state).toBe(status);
        expect(await response.text(), state).toContain(message);
        expect(cancelled, state).toBe(true);
        expect(world.minted(), state).toBe(0);
        expect(world.seen, state).toEqual([]);
        expect(pushedEvents(world), state).toEqual([]);
      });
    }
  });

  it("answers a client whose body fails inside the push head, and leaves no time limit armed", async () => {
    const slow: GitGatewayLimits = { ...FAST, maxDurationMs: 60_000 };
    const cases: [ClaimState, number][] = [
      ["working", 400],
      ["expired", 403],
    ];
    for (const [state, status] of cases) {
      const armed = new Set<unknown>();
      const cleared = new Set<unknown>();
      const setTimer = globalThis.setTimeout;
      const clearTimer = globalThis.clearTimeout;
      const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: () => void,
        ms?: number,
      ) => {
        const id = setTimer(handler, ms);
        if (ms === slow.maxDurationMs) armed.add(id);
        return id;
      }) as typeof setTimeout);
      const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
        id?: Parameters<typeof clearTimeout>[0],
      ) => {
        cleared.add(id);
        clearTimer(id);
      }) as typeof clearTimeout);
      try {
        await withGateway(async (world) => {
          world.claim.state = state;
          // Half a command, then the client goes away.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`00b9${ZERO} ${HEAD} refs/he`));
              controller.error(new Error("the client disconnected"));
            },
          });
          const response = await world.gateway.serve(
            rpc("git-receive-pack", body),
            FORK,
            "/git-receive-pack",
          );
          expect(response.status, state).toBe(status);
          expect(world.minted(), state).toBe(0);
          expect(world.seen, state).toEqual([]);
          expect(pushedEvents(world), state).toEqual([]);
        }, slow);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
      expect(armed.size, state).toBe(1);
      expect(
        [...armed].every((id) => cleared.has(id)),
        state,
      ).toBe(true);
    }
  });

  it("refuses a body declared or found larger than the limit", async () => {
    await withGateway(
      async (world) => {
        world.respond = () => gitResponse("git-upload-pack", "result", "0000");
        const declared = await world.gateway.serve(
          rpc("git-receive-pack", PUSH_REQUEST, { "content-length": String(PUSH_REQUEST.length) }),
          FORK,
          "/git-receive-pack",
        );
        expect(declared.status).toBe(413);

        const atLimit = await world.gateway.serve(
          rpc("git-upload-pack", new Uint8Array(64)),
          FORK,
          "/git-upload-pack",
        );
        expect(atLimit.status).toBe(200);
        await atLimit.body?.cancel();

        const streamed = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(40));
            controller.enqueue(new Uint8Array(40));
            controller.close();
          },
        });
        const found = await world.gateway.serve(
          rpc("git-upload-pack", streamed),
          FORK,
          "/git-upload-pack",
        );
        expect(found.status).toBe(413);
        expect(world.seen).toHaveLength(1);
      },
      { ...FAST, maxFetchRequestBytes: 64, maxPushBytes: 64 },
    );
  });

  it("cuts off a response larger than the limit", async () => {
    await withGateway(
      async (world) => {
        world.respond = () => gitResponse("git-upload-pack", "result", new Uint8Array(65));
        const response = await world.gateway.serve(
          rpc("git-upload-pack", "0000"),
          FORK,
          "/git-upload-pack",
        );
        expect(response.status).toBe(200);
        await expect(response.arrayBuffer()).rejects.toThrow();
      },
      { ...FAST, maxResponseBytes: 64 },
    );
  });

  it("answers 504 when the upstream does not answer in time, and logs no token", async () => {
    await withGateway(async (world) => {
      world.respond = () => new Promise<Response>(() => undefined);
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(504);
      const text = await response.text();
      expect(pushedEvents(world)).toEqual([]);
      expect(logged.some((line) => line.includes("timeout"))).toBe(true);
      // The upstream had read the whole push, so it may have applied it.
      expect(unknownOutcomes()).toBe(1);
      expectNoTokenLeak(world, text);
    });
  });

  it("errors a response that outlives the time limit, and leaves the push to reconciliation", async () => {
    await withGateway(async (world) => {
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(pkt("\u0002progress\n")));
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      await expect(response.arrayBuffer()).rejects.toThrow();
      expect(pushedEvents(world)).toEqual([]);
      expect(unknownOutcomes()).toBe(1);
    });
  });

  it("leaves a push whose response passes the size bound to reconciliation", async () => {
    await withGateway(
      async (world) => {
        world.respond = () => gitResponse("git-receive-pack", "result", new Uint8Array(65));
        const response = await world.gateway.serve(
          rpc("git-receive-pack", PUSH_REQUEST),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status).toBe(200);
        await expect(response.arrayBuffer()).rejects.toThrow();
        expect(pushedEvents(world)).toEqual([]);
        expect(unknownOutcomes()).toBe(1);
      },
      { ...FAST, maxResponseBytes: 64 },
    );
  });
});

describe("upstream responses", () => {
  it("never passes on a redirect, a refusal or an error page", async () => {
    await withGateway(async (world) => {
      for (const make of [
        (token: string) =>
          new Response(null, {
            status: 302,
            headers: { location: `https://elsewhere.invalid/?t=${token}` },
          }),
        (token: string) => new Response(`denied ${token}`, { status: 403 }),
        (token: string) =>
          new Response(`<html>${token}</html>`, { headers: { "content-type": "text/html" } }),
      ]) {
        world.respond = (request) =>
          make(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
        const response = await world.gateway.serve(
          advertise("git-upload-pack"),
          FORK,
          "/info/refs",
        );
        expect(response.status).toBe(502);
        expect(response.headers.get("location")).toBeNull();
        expectNoTokenLeak(world, `${[...response.headers].join()} ${await response.text()}`);
      }
    });
  });

  it("masks the token if the upstream echoes it in a Git result", async () => {
    await withGateway(async (world) => {
      world.respond = (request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const line = pkt(`ERR token ${token} rejected\n`);
        // Split mid-token, so the mask has to hold bytes across chunks.
        const cut = line.length - 12;
        return gitResponse(
          "git-upload-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(line.slice(0, cut)));
              controller.enqueue(encoder.encode(line.slice(cut)));
              controller.close();
            },
          }),
        );
      };
      const response = await world.gateway.serve(
        rpc("git-upload-pack", "0000"),
        FORK,
        "/git-upload-pack",
      );
      const body = await response.text();
      const [token] = world.tokens();
      expect(body).toBe(pkt(`ERR token ${"*".repeat(token?.length ?? 0)} rejected\n`));
      expectNoTokenLeak(world, body);
    });
  });

  it("records only the refs the upstream reported updated", async () => {
    await withGateway(async (world) => {
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          sideBand(
            `${pkt("unpack ok\n")}${pkt("ok refs/heads/a\n")}${pkt("ng refs/heads/b non-fast-forward\n")}0000`,
          ),
        );
      const response = await world.gateway.serve(
        rpc(
          "git-receive-pack",
          pushBody([`${ROOT} ${HEAD} refs/heads/a`, `${ROOT} ${HEAD} refs/heads/b`]),
        ),
        FORK,
        "/git-receive-pack",
      );
      await response.arrayBuffer();
      expect(pushedEvents(world).map((event) => event.data)).toEqual([
        { claimId: CLAIM, generation: 3, ref: "refs/heads/a", from: ROOT, to: HEAD },
      ]);
    });
  });

  it("records nothing and logs one unknown outcome for a report that does not settle exactly the refs sent", async () => {
    await withGateway(async (world) => {
      const both = pushBody([`${ROOT} ${HEAD} refs/heads/a`, `${ROOT} ${HEAD} refs/heads/b`]);
      const serve = async (statuses: string): Promise<void> => {
        logged = [];
        world.respond = () =>
          gitResponse(
            "git-receive-pack",
            "result",
            sideBand(`${pkt("unpack ok\n")}${statuses}0000`),
          );
        const response = await world.gateway.serve(
          rpc("git-receive-pack", both),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      };
      const unsettled: [string, string][] = [
        [
          "every ref rewritten",
          `${pkt("ok refs/heads/a\n")}${pkt(`option new-oid ${ROOT}\n`)}${pkt("ok refs/heads/b\n")}${pkt("option refname refs/heads/c\n")}`,
        ],
        [
          "a confirmed ref beside a rewritten one",
          `${pkt("ok refs/heads/a\n")}${pkt("ok refs/heads/b\n")}${pkt(`option new-oid ${ROOT}\n`)}`,
        ],
        ["a missing status", pkt("ok refs/heads/a\n")],
        ["no status at all", ""],
        [
          "a ref not sent",
          `${pkt("ok refs/heads/a\n")}${pkt("ok refs/heads/b\n")}${pkt("ok refs/heads/c\n")}`,
        ],
        [
          "a ref swapped for one not sent",
          `${pkt("ok refs/heads/a\n")}${pkt("ok refs/heads/c\n")}`,
        ],
      ];
      for (const [label, statuses] of unsettled) {
        await serve(statuses);
        expect(pushedEvents(world), label).toEqual([]);
        expect(unknownOutcomes(), label).toBe(1);
      }
      // A complete refusal of every ref moved nothing and is not left to reconciliation.
      await serve(
        `${pkt("ng refs/heads/b stale info\n")}${pkt("ng refs/heads/a non-fast-forward\n")}`,
      );
      expect(pushedEvents(world)).toEqual([]);
      expect(logged).toEqual([]);
      // One status each, in any order, settles the push.
      await serve(`${pkt("ok refs/heads/b\n")}${pkt("ok refs/heads/a\n")}`);
      expect(logged).toEqual([]);
      expect(pushedEvents(world).map((event) => event.data)).toEqual([
        { claimId: CLAIM, generation: 3, ref: "refs/heads/a", from: ROOT, to: HEAD },
        { claimId: CLAIM, generation: 3, ref: "refs/heads/b", from: ROOT, to: HEAD },
      ]);
    });
  });

  it("records nothing for a failed unpack, a fatal side band, a cut-off report or a refusal, and logs each unknown outcome", async () => {
    await withGateway(async (world) => {
      const update = pushBody([`${ROOT} ${HEAD} refs/heads/a`]);
      // Only the failed unpack and the refused ref are known to have moved nothing.
      for (const [answer, unknown] of [
        [
          sideBand(
            `${pkt("unpack index-pack failed\n")}${pkt("ng refs/heads/a unpacker error\n")}0000`,
          ),
          0,
        ],
        [sideBand(`${pkt("unpack ok\n")}${pkt("ng refs/heads/a non-fast-forward\n")}0000`), 0],
        [`${pkt("\u0003fatal: out of space\n")}0000`, 1],
        [`${pkt(`\u0001${pkt("unpack ok\n")}${pkt("ok refs/heads/a\n")}`)}0000`, 1],
        [pkt("\u0001garbage"), 1],
        // A report that would read as a clean refusal, but is past the report bound.
        [sideBands(`${pkt("unpack ok\n")}${OVERSIZED_REFUSAL}0000`), 1],
      ] as const) {
        logged = [];
        world.respond = () => gitResponse("git-receive-pack", "result", answer);
        const response = await world.gateway.serve(
          rpc("git-receive-pack", update),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        expect(unknownOutcomes()).toBe(unknown);
      }
      logged = [];
      world.respond = () => new Response("nope", { status: 500 });
      const failed = await world.gateway.serve(
        rpc("git-receive-pack", update),
        FORK,
        "/git-receive-pack",
      );
      expect(failed.status).toBe(502);
      expect(unknownOutcomes()).toBe(1);
      logged = [];
      world.respond = () =>
        new Response(PUSH_RESULT, { headers: { "content-type": "application/octet-stream" } });
      const mistyped = await world.gateway.serve(
        rpc("git-receive-pack", update),
        FORK,
        "/git-receive-pack",
      );
      expect(mistyped.status).toBe(502);
      expect(unknownOutcomes()).toBe(1);
      expect(world.seen).toHaveLength(8);
      expect(pushedEvents(world)).toEqual([]);
    });
  });

  it("answers 503 and reaches no upstream while Artifacts is busy", async () => {
    await withGateway(
      async (world) => {
        const response = await world.gateway.serve(
          advertise("git-upload-pack"),
          FORK,
          "/info/refs",
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(world.seen).toEqual([]);
      },
      FAST,
      (base) => ({
        ...base,
        token: async () => fail("busy", "The repository's tokens are being revoked; try again."),
      }),
    );
  });
});

describe("an upstream that fails before reading the upload", () => {
  const failures: [string, () => Promise<Response>][] = [
    ["rejects", () => Promise.reject(new Error("connection reset"))],
    [
      "redirects",
      async () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
    ],
    ["answers the wrong type", async () => new Response("<html></html>", { status: 200 })],
  ];

  it("cancels the client's still-open upload and aborts the upstream call", async () => {
    for (const service of ["git-upload-pack", "git-receive-pack"] as const) {
      for (const [label, failure] of failures) {
        const name = `${service} ${label}`;
        await withGateway(async (world) => {
          let cancelled = false;
          const sent: { signal: AbortSignal | null } = { signal: null };
          world.upstream = (request) => {
            sent.signal = request.signal;
            return failure();
          };
          // The whole push head, or a fetch's first bytes, then nothing: the upload never ends.
          const first =
            service === "git-receive-pack"
              ? pushBody([`${ROOT} ${HEAD} refs/heads/a`])
              : encoder.encode("0000");
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(first);
            },
            cancel() {
              cancelled = true;
            },
          });
          const response = await world.gateway.serve(rpc(service, body), FORK, `/${service}`);
          expect(response.status, name).toBe(502);
          await until(() => cancelled);
          expect(sent.signal?.aborted, name).toBe(true);
          // A push also minted a read token for the fork read before its release.
          expect(world.minted(), name).toBe(service === "git-receive-pack" ? 2 : 1);
          expect(pushedEvents(world), name).toEqual([]);
        });
      }
    }
  });
  it("cuts off a push whose pack stalls after its head while the upstream reads it", async () => {
    await withGateway(async (world) => {
      let cancelled = false;
      world.upstream = async (request) => {
        await request.arrayBuffer();
        return gitResponse("git-receive-pack", "result", PUSH_RESULT);
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(pushBody([`${ROOT} ${HEAD} refs/heads/a`]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const started = Date.now();
      const response = await world.gateway.serve(
        rpc("git-receive-pack", body),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(504);
      // The stalled upload is bounded by the whole exchange's limit, not by the headers wait.
      expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.maxDurationMs);
      await until(() => cancelled);
      expect(pushedEvents(world)).toEqual([]);
    });
  });
});

describe("a slow upload", () => {
  it("carries a steady push that takes longer than the headers wait, and records it", async () => {
    const steady: GitGatewayLimits = { ...FAST, maxDurationMs: 5_000 };
    const pieces = 8;
    const gapMs = 40;
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
      const size = Math.ceil(PUSH_REQUEST.length / pieces);
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let offset = 0; offset < PUSH_REQUEST.length; offset += size) {
            controller.enqueue(PUSH_REQUEST.slice(offset, offset + size));
            await new Promise((resolve) => setTimeout(resolve, gapMs));
          }
          controller.close();
        },
      });
      const started = Date.now();
      const response = await world.gateway.serve(
        rpc("git-receive-pack", body),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);
      expect(Date.now() - started).toBeGreaterThan(steady.headersTimeoutMs * 2);
      expect(world.seen[0]?.body).toEqual(PUSH_REQUEST);
      expect(pushedEvents(world)).toHaveLength(1);
    }, steady);
  });

  it("still waits only the headers time once the whole upload has been sent", async () => {
    const steady: GitGatewayLimits = { ...FAST, maxDurationMs: 5_000 };
    await withGateway(async (world) => {
      world.respond = () => new Promise<Response>(() => undefined);
      const started = Date.now();
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeLessThan(steady.maxDurationMs);
      expect(pushedEvents(world)).toEqual([]);
    }, steady);
  });
});

describe("a client that stops reading a push's response", () => {
  it("still has the push recorded when it never reads the response", async () => {
    await withGateway(async (world) => {
      // Progress ahead of the report, in more chunks than a pipe reads ahead on its own.
      const progress = Array.from({ length: 256 }, (_, index) =>
        encoder.encode(pkt(`\u0002Resolving deltas: ${index}\r`)),
      );
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of progress) controller.enqueue(chunk);
              controller.enqueue(PUSH_RESULT);
              controller.close();
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      await until(() => pushedEvents(world).length === 1);
      expect(pushedEvents(world)).toMatchObject([
        { data: { claimId: CLAIM, generation: 3, ref: "refs/heads/feature", to: PUSHED } },
      ]);
      expect(await bytesOf(response)).toEqual(concatAll([...progress, PUSH_RESULT]));
    });
  });

  it("records a push whose report follows more progress than the client buffer holds, and drops the client", async () => {
    await withGateway(async (world) => {
      const sent = [...PROGRESS_FLOOD, PUSH_RESULT];
      let pulled = 0;
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = sent[pulled];
              if (chunk === undefined) {
                controller.close();
                return;
              }
              pulled += 1;
              controller.enqueue(chunk);
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      // The client neither reads nor cancels while the gateway reads past its buffer to the report.
      await until(() => pushedEvents(world).length === 1);
      expect(pushedEvents(world)).toMatchObject([
        { data: { claimId: CLAIM, generation: 3, ref: "refs/heads/feature", to: PUSHED } },
      ]);
      expect(pulled).toBe(sent.length);
      expect(unknownOutcomes()).toBe(0);
      // The client fell more than the buffer behind, so its response was dropped.
      await expect(bytesOf(response)).rejects.toThrow();
    });
  });

  it("still has the push recorded when it goes away before the report arrives", async () => {
    await withGateway(async (world) => {
      let finish: (() => void) | undefined;
      let upstreamCancelled = false;
      const [first, rest] = [PUSH_RESULT.slice(0, 8), PUSH_RESULT.slice(8)];
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(first);
              finish = () => {
                controller.enqueue(rest);
                controller.close();
              };
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      await until(() => finish !== undefined);
      // The upstream has sent part of its answer when the client goes away.
      await response.body?.cancel();
      finish?.();
      await until(() => pushedEvents(world).length === 1);
      expect(upstreamCancelled).toBe(false);
    });
  });

  it("leaves the push to reconciliation when the upstream is cut off after the client went away", async () => {
    await withGateway(async (world) => {
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PUSH_RESULT.slice(0, 8));
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, FAST.maxDurationMs + 50));
      expect(pushedEvents(world)).toEqual([]);
      expect(unknownOutcomes()).toBe(1);
    });
  });

  it("ends the exchange at its deadline and logs the unknown outcome when the progress never ends", async () => {
    await withGateway(async (world) => {
      let upstreamCancelled = false;
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of PROGRESS_FLOOD) controller.enqueue(chunk);
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      // The client neither reads nor cancels.
      await new Promise((resolve) => setTimeout(resolve, FAST.maxDurationMs + 100));
      expect(unknownOutcomes()).toBe(1);
      expect(upstreamCancelled).toBe(true);
      expect(pushedEvents(world)).toEqual([]);
      await expect(bytesOf(response)).rejects.toThrow();
      expect(unknownOutcomes()).toBe(1);
    });
  });
});

/** Arms `fault` once the upstream has the whole push, after the last pre-send check. */
function failingRecord(world: World, fault: { times: number; error: Error }): void {
  world.respond = () => {
    world.generationFault = fault;
    return gitResponse("git-receive-pack", "result", PUSH_RESULT);
  };
}

describe("a push whose record fails", () => {
  it("retries a failed record within its bound, then logs it and still answers the client", async () => {
    await withGateway(async (world) => {
      const fault = { times: 10, error: new Error("storage failed") };
      failingRecord(world, fault);
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      // The upstream applied the push, so its report reaches the client whole.
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);
      expect(fault.times).toBe(7);
      expect(world.events()).toEqual([]);
      expect(logged).toEqual([unrecorded("record_failed")]);
      for (const line of logged) {
        expect(line).not.toContain("refs/heads/feature");
        expect(line).not.toContain(PUSHED);
      }
    });
  });

  it("records the push when a retry succeeds, and logs nothing", async () => {
    await withGateway(async (world) => {
      const fault = { times: 2, error: new Error("storage failed") };
      failingRecord(world, fault);
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);
      expect(fault.times).toBe(0);
      expect(pushedEvents(world)).toMatchObject([
        { data: { claimId: CLAIM, generation: 3, ref: "refs/heads/feature", to: PUSHED } },
      ]);
      expect(logged).toEqual([]);
    });
  });

  it("does not retry a record the event log refused", async () => {
    await withGateway(async (world) => {
      const fault = { times: 10, error: new EventLogError("corrupt_log", "unreadable row") };
      failingRecord(world, fault);
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(await bytesOf(response)).toEqual(PUSH_RESULT);
      expect(fault.times).toBe(9);
      expect(world.events()).toEqual([]);
      expect(logged).toEqual([unrecorded("record_failed")]);
    });
  });

  it("logs a failed record after the client went away", async () => {
    await withGateway(async (world) => {
      let finish: (() => void) | undefined;
      const [first, rest] = [PUSH_RESULT.slice(0, 8), PUSH_RESULT.slice(8)];
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(first);
              finish = () => {
                controller.enqueue(rest);
                controller.close();
              };
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      await until(() => finish !== undefined);
      await response.body?.cancel();
      world.generationFault = { times: 10, error: new Error("storage failed") };
      finish?.();
      await until(() => logged.length > 0);
      expect(logged).toEqual([unrecorded("record_failed")]);
      expect(world.events()).toEqual([]);
    });
  });
});

/** An upload-pack advertisement listing `refs`, each `[id, ref]`, written by hand. */
function advertisement(refs: readonly (readonly [string, string])[]): Response {
  const lines = refs.map(([id, ref], index) =>
    pkt(index === 0 ? `${id} ${ref}\0multi_ack side-band-64k\n` : `${id} ${ref}\n`),
  );
  return gitResponse(
    "git-upload-pack",
    "advertisement",
    `${pkt("# service=git-upload-pack\n")}0000${lines.join("")}0000`,
  );
}

/** The line logged when the alarm settles a pending push. */
function reconciled(recorded: number, skipped: number): string {
  return JSON.stringify({
    event: "git_push_reconciled",
    claimId: CLAIM,
    generation: 3,
    recorded,
    skipped,
  });
}

/** The fork reads the gateway sent since `from`. */
function forkReads(world: World, from = 0): Seen[] {
  return world.seen.slice(from).filter((seen) => seen.method === "GET");
}

/** Pushes the stock push with its record failing every attempt, leaving it pending. */
async function pushWithFailedRecord(world: World): Promise<void> {
  failingRecord(world, { times: 10, error: new Error("storage failed") });
  const response = await world.gateway.serve(
    rpc("git-receive-pack", PUSH_REQUEST),
    FORK,
    "/git-receive-pack",
  );
  expect(await bytesOf(response)).toEqual(PUSH_RESULT);
  world.generationFault = null;
  expect(world.events()).toEqual([]);
}

describe("a push left pending", () => {
  it("is saved before release, and recorded by the alarm of a restarted gateway after its record failed", async () => {
    await withGateway(async (world) => {
      const before = Date.now();
      await pushWithFailedRecord(world);
      const [row, ...others] = world.pending();
      expect(others).toEqual([]);
      expect(row).toMatchObject({ claim_id: CLAIM, generation: 3, attempts: 0 });
      // The alarm is asked for once the push's exchange must have ended.
      expect(row?.due_at).toBeGreaterThanOrEqual(before + FAST.maxDurationMs);
      expect(world.wakes).toEqual([row?.due_at]);

      world.restart();
      // A restarted gateway asks again for the wake its pending push needs.
      expect(world.wakes).toEqual([row?.due_at, row?.due_at]);
      world.respond = (request) =>
        request.method === "GET"
          ? advertisement([
              [HEAD, "refs/heads/main"],
              [PUSHED, "refs/heads/feature"],
            ])
          : new Response(null, { status: 500 });
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();

      expect(world.events()).toMatchObject([
        {
          type: "claim.pushed",
          actor: { kind: "agent", id: AGENT.agentId },
          data: {
            claimId: CLAIM,
            generation: 3,
            ref: "refs/heads/feature",
            from: null,
            to: PUSHED,
          },
        },
      ]);
      expect(world.pending()).toEqual([]);
      const [read, ...more] = forkReads(world);
      expect(more).toEqual([]);
      expect(read?.url).toBe(
        `https://fake.artifacts.invalid/${world.forkName}.git/info/refs?service=git-upload-pack`,
      );
      expect(logged).toEqual([unrecorded("record_failed"), reconciled(1, 0)]);

      // Settled once: a later alarm reads nothing and records nothing more.
      await world.gateway.resume();
      expect(forkReads(world)).toHaveLength(1);
      expect(pushedEvents(world)).toHaveLength(1);
      expectNoTokenLeak(world, "");
    });
  });

  it("is dropped and logged by the alarm when its claim moved on, without reading the fork", async () => {
    await withGateway(async (world) => {
      await pushWithFailedRecord(world);
      world.claim = { ...world.claim, generation: 4 };
      world.respond = () => advertisement([[PUSHED, "refs/heads/feature"]]);
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(world.events()).toEqual([]);
      expect(world.pending()).toEqual([]);
      expect(forkReads(world)).toEqual([]);
      expect(logged).toEqual([unrecorded("record_failed"), unrecorded("claim_changed")]);
    });
  });

  it("waits for its due time, then records only the refs the fork shows the push applied", async () => {
    await withGateway(async (world) => {
      const created = "a".repeat(40);
      const moved = "b".repeat(40);
      // Before the push, `a` is absent and `b` is at the push's old id.
      world.fork = [[HEAD, "refs/heads/b"]];
      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("0008"));
            },
          }),
        );
      const response = await world.gateway.serve(
        rpc(
          "git-receive-pack",
          pushBody([`${ZERO} ${created} refs/heads/a`, `${HEAD} ${moved} refs/heads/b`]),
        ),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      // Due only once the exchange must have ended: an earlier alarm leaves it alone.
      await world.gateway.resume();
      expect(forkReads(world)).toEqual([]);
      expect(world.pending()).toHaveLength(1);

      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, FAST.maxDurationMs + 50));
      expect(unknownOutcomes()).toBe(1);
      expect(world.pending()).toHaveLength(1);

      // `a` reached the commit the push sent; `b` did not move.
      world.respond = () =>
        advertisement([
          [created, "refs/heads/a"],
          [HEAD, "refs/heads/b"],
        ]);
      await world.gateway.resume();
      expect(pushedEvents(world)).toMatchObject([
        { data: { claimId: CLAIM, generation: 3, ref: "refs/heads/a", from: null, to: created } },
      ]);
      expect(world.pending()).toEqual([]);
      expect(logged.at(-1)).toBe(reconciled(1, 1));
    });
  });

  it("is read again later when the fork cannot be read, and dropped and logged after its last attempt", async () => {
    await withGateway(async (world) => {
      await pushWithFailedRecord(world);
      world.respond = () => new Response("down", { status: 500 });
      for (let attempt = 1; attempt < 5; attempt += 1) {
        world.skew += 24 * 60 * 60_000;
        const now = Date.now() + world.skew;
        await world.gateway.resume();
        const [row] = world.pending();
        expect(row?.attempts).toBe(attempt);
        // Each failed read waits twice as long as the one before.
        expect(row?.due_at).toBeGreaterThanOrEqual(now + 60_000 * 2 ** (attempt - 1));
        expect(world.wakes.at(-1)).toBe(row?.due_at);
      }
      // A truncated advertisement is no better than none.
      world.respond = () =>
        gitResponse(
          "git-upload-pack",
          "advertisement",
          `${pkt("# service=git-upload-pack\n")}0000${pkt(`${PUSHED} refs/heads/feature\n`)}`,
        );
      world.skew += 24 * 60 * 60_000;
      await world.gateway.resume();
      expect(forkReads(world)).toHaveLength(5);
      expect(world.pending()).toEqual([]);
      expect(world.events()).toEqual([]);
      expect(logged.at(-1)).toBe(unrecorded("reconcile_failed"));
    });
  });

  it("is settled by its report: recorded or refused, nothing stays for the alarm", async () => {
    await withGateway(async (world) => {
      world.respond = () => gitResponse("git-receive-pack", "result", PUSH_RESULT);
      await bytesOf(
        await world.gateway.serve(rpc("git-receive-pack", PUSH_REQUEST), FORK, "/git-receive-pack"),
      );
      expect(pushedEvents(world)).toHaveLength(1);
      expect(world.pending()).toEqual([]);

      world.respond = () =>
        gitResponse(
          "git-receive-pack",
          "result",
          sideBand(
            `${pkt("unpack index-pack failed\n")}${pkt("ng refs/heads/feature unpacker error\n")}0000`,
          ),
        );
      await bytesOf(
        await world.gateway.serve(rpc("git-receive-pack", PUSH_REQUEST), FORK, "/git-receive-pack"),
      );
      expect(pushedEvents(world)).toHaveLength(1);
      expect(world.pending()).toEqual([]);

      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(forkReads(world)).toEqual([]);
      expect(logged).toEqual([]);
    });
  });

  it("records nothing for a stale push Git refused whose response was lost, though the fork is at its new id", async () => {
    await withGateway(async (world) => {
      const moved = "b".repeat(40);
      // An earlier push already moved `feature` to `moved`; this one still names `HEAD` as its old id,
      // so Git refuses it, and its response is lost.
      world.fork = [[moved, "refs/heads/feature"]];
      world.respond = () => Promise.reject(new Error("connection reset"));
      const response = await world.gateway.serve(
        rpc("git-receive-pack", pushBody([`${HEAD} ${moved} refs/heads/feature`])),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(502);
      expect(world.pending()).toHaveLength(1);

      world.respond = () => advertisement([[moved, "refs/heads/feature"]]);
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(world.events()).toEqual([]);
      expect(world.pending()).toEqual([]);
      expect(forkReads(world)).toHaveLength(1);
      expect(logged.at(-1)).toBe(reconciled(0, 1));
    });
  });

  it("records an update the fork shows moved from its old id to its new id after a lost response", async () => {
    await withGateway(async (world) => {
      const moved = "b".repeat(40);
      world.fork = [[HEAD, "refs/heads/feature"]];
      world.respond = () => Promise.reject(new Error("connection reset"));
      await world.gateway.serve(
        rpc("git-receive-pack", pushBody([`${HEAD} ${moved} refs/heads/feature`])),
        FORK,
        "/git-receive-pack",
      );
      expect(world.observations).toHaveLength(1);

      world.respond = () => advertisement([[moved, "refs/heads/feature"]]);
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(pushedEvents(world)).toMatchObject([
        {
          actor: { kind: "agent", id: AGENT.agentId },
          data: { claimId: CLAIM, generation: 3, ref: "refs/heads/feature", from: HEAD, to: moved },
        },
      ]);
      expect(world.pending()).toEqual([]);
      expect(unknownOutcomes()).toBe(1);
      expect(logged.at(-1)).toBe(reconciled(1, 0));
    });
  });

  it("records neither of two pushes whose responses were lost while the other was in flight", async () => {
    await withGateway(async (world) => {
      const first = "a".repeat(40);
      const second = "b".repeat(40);
      world.fork = [[HEAD, "refs/heads/feature"]];
      world.respond = () => Promise.reject(new Error("connection reset"));
      for (const [from, to] of [
        [HEAD, first],
        [first, second],
      ] as const) {
        const response = await world.gateway.serve(
          rpc("git-receive-pack", pushBody([`${from} ${to} refs/heads/feature`])),
          FORK,
          "/git-receive-pack",
        );
        expect(response.status).toBe(502);
      }
      // The second push was not read before release: the first was still in flight.
      expect(world.observations).toHaveLength(1);
      expect(world.pending()).toHaveLength(2);

      world.respond = () => advertisement([[second, "refs/heads/feature"]]);
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(world.events()).toEqual([]);
      expect(world.pending()).toEqual([]);
      // Neither can be proven, so the fork is not read for either.
      expect(forkReads(world)).toEqual([]);
      expect(logged.slice(-2)).toEqual([
        unrecorded("outcome_unknown", "later_push"),
        unrecorded("outcome_unknown", "unobserved"),
      ]);
    });
  });

  it("records nothing for a push whose fork read overlaps a later push that made the same move", async () => {
    await withGateway(async (world) => {
      const moved = "b".repeat(40);
      const feature = `${HEAD} ${moved} refs/heads/feature`;
      // Git refused this push, but its response was lost.
      world.fork = [[HEAD, "refs/heads/feature"]];
      world.respond = () => Promise.reject(new Error("connection reset"));
      await world.gateway.serve(
        rpc("git-receive-pack", pushBody([feature])),
        FORK,
        "/git-receive-pack",
      );
      expect(world.pending()).toHaveLength(1);

      // While the alarm reads the fork back, a later push makes the same move and is recorded.
      let later: Response | null = null;
      world.respond = async () => {
        world.respond = () =>
          gitResponse(
            "git-receive-pack",
            "result",
            sideBand(`${pkt("unpack ok\n")}${pkt("ok refs/heads/feature\n")}0000`),
          );
        later = await world.gateway.serve(
          rpc("git-receive-pack", pushBody([feature])),
          FORK,
          "/git-receive-pack",
        );
        return advertisement([[moved, "refs/heads/feature"]]);
      };
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(later).not.toBeNull();
      // Only the later push's own record stands.
      expect(pushedEvents(world)).toHaveLength(1);
      expect(world.pending()).toEqual([]);
      expect(logged.at(-1)).toBe(unrecorded("outcome_unknown", "later_push"));
    });
  });

  it("records nothing when the fork could not be read before release", async () => {
    await withGateway(async (world) => {
      world.fork = null;
      world.respond = () => Promise.reject(new Error("connection reset"));
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      // The push still goes ahead without the read.
      expect(response.status).toBe(502);
      expect(world.seen.map((seen) => seen.body)).toEqual([PUSH_REQUEST]);

      world.respond = () => advertisement([[PUSHED, "refs/heads/feature"]]);
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(world.events()).toEqual([]);
      expect(world.pending()).toEqual([]);
      expect(forkReads(world)).toEqual([]);
      expect(logged.at(-1)).toBe(unrecorded("outcome_unknown", "unobserved"));
    });
  });

  it("drops and logs a pending push whose saved fork read is unreadable", async () => {
    await withGateway(async (world) => {
      world.respond = () => Promise.reject(new Error("connection reset"));
      await world.gateway.serve(rpc("git-receive-pack", PUSH_REQUEST), FORK, "/git-receive-pack");
      world.exec("UPDATE git_pending_push SET prior = ?", '{"refs/heads/feature":"not a commit"}');
      world.respond = () => advertisement([[PUSHED, "refs/heads/feature"]]);
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(world.events()).toEqual([]);
      expect(world.pending()).toEqual([]);
      expect(forkReads(world)).toEqual([]);
      expect(logged.at(-1)).toBe(unrecorded("unreadable_record"));
    });
  });

  it("withholds the push's last bytes when it cannot be saved", async () => {
    await withGateway(async (world) => {
      const received: number[] = [];
      world.upstream = async (request) => {
        if (request.method === "GET") return advertisement(world.fork ?? []);
        try {
          received.push((await request.arrayBuffer()).byteLength);
        } catch {
          received.push(-1);
        }
        return gitResponse("git-receive-pack", "result", PUSH_RESULT);
      };
      // The release's claim check is the first read of the claim's generation.
      world.generationFault = { times: 1, error: new Error("storage failed") };
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe(
        "railhead: the push could not be saved for its record; nothing was updated\n",
      );
      expect(received).toEqual([-1]);
      expect(world.pending()).toEqual([]);
      expect(world.events()).toEqual([]);
      expect(world.wakes).toEqual([]);
      expect(logged).toEqual([
        JSON.stringify({
          event: "git_push_unsaved",
          claimId: CLAIM,
          generation: 3,
          error: "Error",
        }),
      ]);
    });
  });
});

/** Answers each push upload with `answer`, recording its length, or -1 if it was cut off. */
function uploads(world: World, answer: () => Response): number[] {
  const received: number[] = [];
  world.upstream = async (request) => {
    if (request.method === "GET") return advertisement(world.fork ?? []);
    try {
      received.push((await request.arrayBuffer()).byteLength);
    } catch {
      received.push(-1);
      return new Response(null, { status: 500 });
    }
    return answer();
  };
  return received;
}

describe("a push whose alarm write fails", () => {
  it("is released once the wake asked for again is set, and recorded by the alarm without a restart when its outcome is unknown", async () => {
    await withGateway(async (world) => {
      let failures = 1;
      world.wakeAnswer = () => {
        failures -= 1;
        return failures < 0;
      };
      // The upstream applies the push, but its response is lost.
      const received = uploads(world, () => new Response(null, { status: 500 }));
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(502);
      expect(received).toEqual([PUSH_REQUEST.byteLength]);
      const [row, ...others] = world.pending();
      expect(others).toEqual([]);
      // The failed write was asked for again before the last bytes were sent.
      expect(world.wakes).toEqual([row?.due_at, row?.due_at]);
      expect(world.events()).toEqual([]);

      // The same gateway, not a restarted one, is woken by the alarm that was set.
      world.upstream = (request) =>
        Promise.resolve(
          request.method === "GET"
            ? advertisement([
                [HEAD, "refs/heads/main"],
                [PUSHED, "refs/heads/feature"],
              ])
            : new Response(null, { status: 500 }),
        );
      world.skew = FAST.maxDurationMs;
      await world.gateway.resume();
      expect(pushedEvents(world)).toMatchObject([
        { data: { claimId: CLAIM, generation: 3, ref: "refs/heads/feature", to: PUSHED } },
      ]);
      expect(world.pending()).toEqual([]);
    });
  });

  it("withholds the push's last bytes and drops it when its alarm cannot be set", async () => {
    await withGateway(async (world) => {
      world.wakeAnswer = () => false;
      const received = uploads(world, () => gitResponse("git-receive-pack", "result", PUSH_RESULT));
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.text()).toBe(
        "railhead: the push could not be saved for its record; nothing was updated\n",
      );
      expect(received).toEqual([-1]);
      expect(world.wakes).toHaveLength(2);
      expect(world.pending()).toEqual([]);
      expect(world.events()).toEqual([]);
      expect(logged).toContain(
        JSON.stringify({ event: "git_push_unarmed", claimId: CLAIM, generation: 3 }),
      );
    });
  });

  it("withholds the push's last bytes when its claim moves on while its alarm is written", async () => {
    await withGateway(async (world) => {
      world.wakeAnswer = () => {
        world.claim = { ...world.claim, generation: 4 };
        return true;
      };
      const received = uploads(world, () => gitResponse("git-receive-pack", "result", PUSH_RESULT));
      const response = await world.gateway.serve(
        rpc("git-receive-pack", PUSH_REQUEST),
        FORK,
        "/git-receive-pack",
      );
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(await bytesOf(response))).toContain(
        "the claim changed while this push was being sent",
      );
      expect(received).toEqual([-1]);
      expect(world.wakes).toHaveLength(1);
      expect(world.pending()).toEqual([]);
      expect(world.events()).toEqual([]);
    });
  });
});

/** Feeds `body` to an advertisement reader one byte at a time. */
async function readAdvertised(body: Response, wanted: string[]): Promise<AdvertisedRefs> {
  const reader = new AdvertisedRefsReader(wanted);
  for (const byte of await bytesOf(body)) reader.push(Uint8Array.of(byte));
  return reader.end();
}

describe("ref advertisements", () => {
  it("keeps only the refs asked for, read one byte at a time", async () => {
    const refs = await readAdvertised(
      advertisement([
        [HEAD, "refs/heads/main"],
        [PUSHED, "refs/heads/feature"],
        [ROOT, "refs/tags/v1"],
      ]),
      ["refs/heads/feature", "refs/heads/gone"],
    );
    expect(refs).toEqual({ kind: "read", refs: new Map([["refs/heads/feature", PUSHED]]) });
  });

  it("reads an empty repository's advertisement as having no refs", async () => {
    const refs = await readAdvertised(advertisement([[ZERO, "capabilities^{}"]]), [
      "refs/heads/feature",
    ]);
    expect(refs).toEqual({ kind: "read", refs: new Map() });
  });

  it("knows nothing from a cut-off, malformed or foreign advertisement", async () => {
    const service = `${pkt("# service=git-upload-pack\n")}0000`;
    const bodies = [
      `${service}${pkt(`${PUSHED} refs/heads/feature\n`)}`,
      `${service}${pkt(`${PUSHED} refs/heads/feature\n`)}00`,
      `${service}${pkt(`zz refs/heads/feature\n`)}0000`,
      `${pkt("# service=git-receive-pack\n")}0000${pkt(`${PUSHED} refs/heads/feature\n`)}0000`,
      `${service}0000${pkt(`${PUSHED} refs/heads/feature\n`)}`,
      "000eversion 2\n0000",
    ];
    for (const body of bodies) {
      const refs = await readAdvertised(gitResponse("git-upload-pack", "advertisement", body), [
        "refs/heads/feature",
      ]);
      expect(refs).toEqual({ kind: "unreadable" });
    }
  });
});

describe("push reports", () => {
  it("reads a plain report, and knows nothing once the server rewrote a ref", () => {
    const refs = ["refs/heads/a", "refs/heads/b"];
    const reader = new PushReportReader("plain", refs);
    reader.push(
      encoder.encode(
        `${pkt("unpack ok\n")}${pkt("ok refs/heads/a\n")}${pkt("ng refs/heads/b stale info\n")}0000`,
      ),
    );
    expect(reader.end()).toEqual({ kind: "reported", updated: new Set(["refs/heads/a"]) });
    const rewritten = new PushReportReader("plain", refs);
    rewritten.push(
      encoder.encode(
        `${pkt("unpack ok\n")}${pkt("ok refs/heads/a\n")}${pkt("ok refs/heads/b\n")}${pkt("option new-oid 3333\n")}0000`,
      ),
    );
    expect(rewritten.end()).toEqual({ kind: "unknown" });
  });

  it("knows nothing unless the report covers exactly the refs sent", () => {
    const refs = ["refs/heads/a", "refs/heads/b"];
    for (const [label, statuses] of [
      ["missing", pkt("ok refs/heads/a\n")],
      ["empty", ""],
      [
        "extra",
        `${pkt("ok refs/heads/a\n")}${pkt("ng refs/heads/b x\n")}${pkt("ok refs/heads/c\n")}`,
      ],
      ["swapped", `${pkt("ok refs/heads/a\n")}${pkt("ok refs/heads/c\n")}`],
    ] as const) {
      const reader = new PushReportReader("plain", refs);
      reader.push(encoder.encode(`${pkt("unpack ok\n")}${statuses}0000`));
      expect(reader.end(), label).toEqual({ kind: "unknown" });
    }
  });

  it("reads a report split one byte at a time", () => {
    const reader = new PushReportReader("side-band", ["refs/heads/feature"]);
    for (const byte of PUSH_RESULT) reader.push(Uint8Array.of(byte));
    expect(reader.end()).toEqual({ kind: "reported", updated: new Set(["refs/heads/feature"]) });
  });

  it("knows nothing when a ref has more than one status line", () => {
    const lines: [string, string][] = [
      ["ng after ok", `${pkt("ok refs/heads/x\n")}${pkt("ng refs/heads/x failed to lock\n")}`],
      ["ok after ng", `${pkt("ng refs/heads/x failed to lock\n")}${pkt("ok refs/heads/x\n")}`],
      ["ok twice", `${pkt("ok refs/heads/x\n")}${pkt("ok refs/heads/x\n")}`],
      ["ng twice", `${pkt("ng refs/heads/x a\n")}${pkt("ng refs/heads/x b\n")}`],
    ];
    for (const [label, statuses] of lines) {
      const reader = new PushReportReader("plain", ["refs/heads/a", "refs/heads/x"]);
      reader.push(
        encoder.encode(`${pkt("unpack ok\n")}${pkt("ok refs/heads/a\n")}${statuses}0000`),
      );
      expect(reader.end(), label).toEqual({ kind: "unknown" });
    }
    // One line each for refs that share a prefix is not a repeat.
    const distinct = new PushReportReader("plain", [
      "refs/heads/x",
      "refs/heads/x/y",
      "refs/heads/xy",
    ]);
    distinct.push(
      encoder.encode(
        `${pkt("unpack ok\n")}${pkt("ok refs/heads/x\n")}${pkt("ng refs/heads/x/y failed\n")}${pkt("ok refs/heads/xy\n")}0000`,
      ),
    );
    expect(distinct.end()).toEqual({
      kind: "reported",
      updated: new Set(["refs/heads/x", "refs/heads/xy"]),
    });
  });

  it("tells a complete report of a failed unpack from one it cannot read", () => {
    const refused = new PushReportReader("plain", ["refs/heads/a"]);
    refused.push(
      encoder.encode(`${pkt("unpack index-pack failed\n")}${pkt("ng refs/heads/a x\n")}0000`),
    );
    expect(refused.end()).toEqual({ kind: "refused" });
    const unopened = new PushReportReader("plain", ["refs/heads/a"]);
    unopened.push(encoder.encode(`${pkt("ok refs/heads/a\n")}0000`));
    expect(unopened.end()).toEqual({ kind: "unknown" });
    const cutOff = new PushReportReader("plain", ["refs/heads/a"]);
    cutOff.push(encoder.encode(pkt("unpack index-pack failed\n")));
    expect(cutOff.end()).toEqual({ kind: "unknown" });
  });

  it("knows nothing without a report, or with bytes after it", () => {
    const none = new PushReportReader("none", []);
    none.push(encoder.encode(`${pkt("unpack ok\n")}0000`));
    expect(none.end()).toEqual({ kind: "unknown" });
    const trailing = new PushReportReader("plain", ["refs/heads/a"]);
    trailing.push(encoder.encode(`${pkt("unpack ok\n")}0000${pkt("ok refs/heads/a\n")}`));
    expect(trailing.end()).toEqual({ kind: "unknown" });
  });
});

/** A fake Artifacts binding whose `info` answers with `answer`, counting `get` calls and disposals. */
function namespace(answer: () => Promise<{ remote: string }>): {
  calls: () => number;
  disposed: () => number;
  get: (name: string) => Promise<Disposable & { info(): Promise<{ remote: string }> }>;
} {
  let calls = 0;
  let disposed = 0;
  return {
    calls: () => calls,
    disposed: () => disposed,
    get: async () => {
      calls += 1;
      return {
        info: answer,
        [Symbol.dispose]: () => {
          disposed += 1;
        },
      };
    },
  };
}

/** A promise settled from outside, for a binding call that answers only when the test says so. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (reason) => reject?.(reason),
  };
}

describe("artifactsRemotes", () => {
  it("reads a remote once and keeps it", async () => {
    const binding = namespace(async () => ({ remote: "https://x.artifacts.cloudflare.net/r.git" }));
    const resolve = artifactsRemotes(binding);
    expect(await resolve("r")).toEqual(ok("https://x.artifacts.cloudflare.net/r.git"));
    expect(await resolve("r")).toEqual(ok("https://x.artifacts.cloudflare.net/r.git"));
    expect(binding.calls()).toBe(1);
  });

  it("maps a missing repository, a failure and a timeout, and keeps none of them", async () => {
    const missing = namespace(() =>
      Promise.reject(Object.assign(new Error("r"), { code: "NOT_FOUND" })),
    );
    expect(await artifactsRemotes(missing)("r")).toMatchObject({ ok: false, code: "not_found" });
    const broken = namespace(() => Promise.reject(new Error("secret detail")));
    const result = await artifactsRemotes(broken)("r");
    expect(result).toMatchObject({ ok: false, code: "internal" });
    expect(JSON.stringify(result)).not.toContain("secret detail");
    const slow = namespace(() => new Promise(() => undefined));
    const resolveSlow = artifactsRemotes(slow, { timeoutMs: 20, maxCached: 1, maxPending: 4 });
    expect(await resolveSlow("r")).toMatchObject({ ok: false, code: "busy" });
    expect(slow.calls()).toBe(1);
  });

  it("shares one lookup between concurrent misses of the same repository", async () => {
    const answer = deferred<{ remote: string }>();
    const binding = namespace(() => answer.promise);
    const resolve = artifactsRemotes(binding, { timeoutMs: 1_000, maxCached: 4, maxPending: 4 });
    const first = resolve("r");
    const second = resolve("r");
    answer.resolve({ remote: "https://x.artifacts.cloudflare.net/r.git" });
    expect(await first).toEqual(ok("https://x.artifacts.cloudflare.net/r.git"));
    expect(await second).toEqual(ok("https://x.artifacts.cloudflare.net/r.git"));
    expect(binding.calls()).toBe(1);
    expect(binding.disposed()).toBe(1);
  });

  it("starts no more binding calls while a timed-out lookup is still outstanding", async () => {
    const binding = namespace(() => new Promise(() => undefined));
    const resolve = artifactsRemotes(binding, { timeoutMs: 20, maxCached: 4, maxPending: 4 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await resolve("r"), `attempt ${attempt}`).toMatchObject({ ok: false, code: "busy" });
    }
    expect(binding.calls()).toBe(1);
    // The stalled lookup's handle is released when it times out, not when the call settles.
    expect(binding.disposed()).toBe(1);
  });

  it("answers busy without calling the binding once the outstanding lookups reach the bound", async () => {
    const answer = deferred<{ remote: string }>();
    const binding = namespace(() => answer.promise);
    const resolve = artifactsRemotes(binding, { timeoutMs: 20, maxCached: 4, maxPending: 2 });
    expect(await resolve("a")).toMatchObject({ ok: false, code: "busy" });
    expect(await resolve("b")).toMatchObject({ ok: false, code: "busy" });
    expect(await resolve("c")).toMatchObject({ ok: false, code: "busy" });
    expect(binding.calls()).toBe(2);
    // Once the stalled calls settle, their slots are free again: the next miss reaches the binding.
    answer.reject(new Error("late"));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(await resolve("c")).toMatchObject({ ok: false, code: "internal" });
    expect(binding.calls()).toBe(3);
    expect(binding.disposed()).toBe(3);
  });

  it("keeps a remote that arrives after its lookup timed out, and calls nothing more for it", async () => {
    const answer = deferred<{ remote: string }>();
    const binding = namespace(() => answer.promise);
    const resolve = artifactsRemotes(binding, { timeoutMs: 20, maxCached: 4, maxPending: 1 });
    expect(await resolve("r")).toMatchObject({ ok: false, code: "busy" });
    answer.resolve({ remote: "https://x.artifacts.cloudflare.net/r.git" });
    await new Promise((settle) => setTimeout(settle, 0));
    expect(await resolve("r")).toEqual(ok("https://x.artifacts.cloudflare.net/r.git"));
    expect(binding.calls()).toBe(1);
    expect(binding.disposed()).toBe(1);
    // The settled lookup freed its slot: another repository can be looked up.
    expect(await resolve("s")).toEqual(ok("https://x.artifacts.cloudflare.net/r.git"));
    expect(binding.calls()).toBe(2);
  });

  it("is refused by the gateway when it is not plain HTTPS", async () => {
    await withGateway(async (world) => {
      for (const remote of [
        "http://fake.artifacts.invalid/r.git",
        "https://user:pw@fake.artifacts.invalid/r.git",
        "https://fake.artifacts.invalid/r.git?x=1",
        "not a url",
      ]) {
        world.remote = async () => ok(remote);
        const response = await world.gateway.serve(
          advertise("git-upload-pack"),
          FORK,
          "/info/refs",
        );
        expect(response.status).toBe(502);
      }
      expect(world.seen).toEqual([]);
    });
  });
});
