import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimView, PinResult } from "@railhead/shared/agent-api";
import type { ClaimPin } from "../src/contracts/claims";
import type { AgentPrincipal } from "../src/contracts/principals";
import { fail, ok } from "../src/contracts/result";
import { unavailableTrain } from "../src/contracts/unavailable";
import { parseAgentResponse } from "../src/contracts/wireShape";
import { dispatchAgent, type AgentReply } from "../src/gateway/agentDispatch";
import {
  insertBatch,
  insertEntry,
  markCheckHeld,
  recordCandidate,
  recordCheckResult,
  settleEntry,
} from "../src/modules/train/store";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo, type RepoSummary } from "../src/repo/RepoObject";

const ORIGIN = "https://railhead.invalid";
const NOW = 1_790_000_000_000;
const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const LATER = "c".repeat(40);
const CANDIDATE = "d".repeat(40);
const ATLAS = "agt_atlas01";
const BORA = "agt_bora001";

/** The claim each agent holds, as the claims module would report it. */
type Claims = Map<string, ClaimView | null>;

interface Harness {
  sql: SqlStorage;
  claims: Claims;
  /** Calls `pin` as `agentId`, authenticated by its token, and checks the reply's wire shape. */
  pin(agentId: string): Promise<AgentReply>;
}

function clock(): number {
  return NOW;
}

async function freshRepo(): Promise<{ stub: DurableObjectStub<Repo>; summary: RepoSummary }> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  const summary = await stub.initialize("acme", name);
  if (!summary.ok) throw new Error(summary.code);
  return { stub, summary: summary.value };
}

function claim(claimId: string, state: ClaimView["state"], generation = 1): ClaimView {
  return {
    claimId,
    issueId: "iss_upload1",
    generation,
    base: MAIN,
    state,
    readyCommit: state === "ready" ? HEAD : null,
    originUrl: "",
    upstreamUrl: "",
    task: { title: "Handle large uploads", body: "Untrusted." },
  };
}

function pinOf(claimId: string, generation = 1, commit = HEAD): ClaimPin {
  return { claimId, generation, commit };
}

/**
 * Runs `body` in a fresh Repo whose train is the real one over its own tables. Sessions map a token
 * to the agent it names, and the claims module reports the claim `claims` holds for each agent.
 */
async function withPins<R>(
  body: (harness: Harness) => Promise<R>,
  install: (ports: RepoPorts) => Partial<RepoPorts> = () => ({}),
): Promise<R> {
  const { stub, summary } = await freshRepo();
  const { repoId } = summary;
  return runInDurableObject(stub, async (_instance, state) => {
    const log = EventLog.open(state.storage, repoId, clock);
    const context = { repoId, storage: state.storage, log, clock, env, wake: async () => true };
    const real = composeRepo(context);
    const claims: Claims = new Map();
    const principal = (agentId: string): AgentPrincipal => ({
      kind: "agent",
      agentId,
      ownerId: "usr_lemarier",
      repoId,
    });
    const ports: RepoPorts = {
      ...real,
      sessions: {
        ...real.sessions,
        authenticate: async (token) => ok(principal(token.split(".")[0] ?? "")),
      },
      claims: {
        ...real.claims,
        activeClaim: async (agent) => ok(claims.get(agent.agentId) ?? null),
      },
      ...install(real),
    };
    return body({
      sql: state.storage.sql,
      claims,
      async pin(agentId) {
        const reply = await dispatchAgent(
          { ...summary, ports },
          { command: { route: "pin" }, token: `${agentId}.b.c`, origin: ORIGIN },
        );
        // Every reply has the route's wire shape.
        parseAgentResponse("pin", JSON.parse(JSON.stringify(reply)));
        return reply;
      },
    });
  });
}

function pinData(reply: AgentReply): PinResult {
  if (!reply.ok) throw new Error(`expected success, got ${reply.error.code}`);
  const parsed = parseAgentResponse("pin", reply);
  if (parsed.route !== "pin" || !parsed.response.ok) throw new Error("not a pin result");
  return parsed.response.data;
}

describe("pin", () => {
  it("shows each agent only its own pin, with its place in the queue", async () => {
    await withPins(async ({ sql, claims, pin }) => {
      claims.set(ATLAS, claim("clm_atlas01", "ready"));
      claims.set(BORA, claim("clm_bora001", "ready"));
      insertEntry(sql, pinOf("clm_bora001"), 1, NOW);
      insertEntry(sql, pinOf("clm_atlas01", 1, LATER), 1, NOW + 1);

      const atlas = pinData(await pin(ATLAS));
      expect(atlas.pin).toEqual({
        claimId: "clm_atlas01",
        generation: 1,
        commit: LATER,
        nextCommit: null,
        state: { kind: "queued", position: 2 },
      });
      const bora = pinData(await pin(BORA));
      expect(bora.pin?.claimId).toBe("clm_bora001");
      expect(bora.pin?.state).toEqual({ kind: "queued", position: 1 });
      // Neither reply names the other agent's claim or commit anywhere.
      expect(JSON.stringify(await pin(BORA))).not.toContain("clm_atlas01");
      expect(JSON.stringify(await pin(ATLAS))).not.toContain("clm_bora001");
    });
  });

  it("never shows another generation's pin of the same claim", async () => {
    await withPins(async ({ sql, claims, pin }) => {
      // Generation 1 was the claim's previous owner; the calling agent holds generation 2.
      claims.set(ATLAS, claim("clm_shared01", "ready", 2));
      insertEntry(sql, pinOf("clm_shared01", 1, LATER), 1, NOW);
      expect(pinData(await pin(ATLAS))).toEqual({ pin: null });

      insertEntry(sql, pinOf("clm_shared01", 2), 2, NOW + 1);
      const shown = pinData(await pin(ATLAS));
      expect(shown.pin).toMatchObject({ generation: 2, commit: HEAD });
      // The older generation still waits ahead of it, so it counts in the position, unnamed.
      expect(shown.pin?.state).toEqual({ kind: "queued", position: 2 });
    });
  });

  it("follows the batch from forming through checking and held to landing", async () => {
    await withPins(async ({ sql, claims, pin }) => {
      claims.set(ATLAS, claim("clm_atlas01", "ready"));
      claims.set(BORA, claim("clm_bora001", "ready"));
      insertEntry(sql, pinOf("clm_atlas01"), 1, NOW);
      insertEntry(sql, pinOf("clm_bora001", 1, LATER), 1, NOW + 1);
      const batchId = insertBatch(
        sql,
        {
          expectedMain: MAIN,
          pins: [{ ...pinOf("clm_atlas01"), episode: 1 }],
          decisions: [],
          definition: { name: "test", source: MAIN, digest: "e".repeat(64), acceptance: null },
        },
        NOW,
      );
      const batched = async () => pinData(await pin(ATLAS)).pin?.state;
      expect(await batched()).toEqual({
        kind: "batched",
        batchId,
        batch: "forming",
        checkRunId: null,
      });

      recordCandidate(sql, batchId, CANDIDATE, "chk_run0001", NOW);
      expect(await batched()).toEqual({
        kind: "batched",
        batchId,
        batch: "checking",
        checkRunId: "chk_run0001",
      });
      // The other agent, outside the batch, sees itself first in the queue and no batch.
      expect(pinData(await pin(BORA)).pin?.state).toEqual({ kind: "queued", position: 1 });

      markCheckHeld(sql, batchId, NOW);
      expect(await batched()).toMatchObject({ batch: "held", checkRunId: "chk_run0001" });

      recordCheckResult(sql, batchId, "pass", null, NOW, NOW);
      expect(await batched()).toMatchObject({ batch: "landing", checkRunId: "chk_run0001" });
    });
  });

  it("reports a settled pin with the reason it left the queue", async () => {
    await withPins(async ({ sql, claims, pin }) => {
      claims.set(ATLAS, claim("clm_atlas01", "ready"));
      insertEntry(sql, pinOf("clm_atlas01"), 1, NOW);
      const state = async () => pinData(await pin(ATLAS)).pin?.state;

      settleEntry(sql, pinOf("clm_atlas01"), "parked", "conflict", NOW);
      expect(await state()).toEqual({ kind: "parked", reason: "conflict" });
      settleEntry(sql, pinOf("clm_atlas01"), "dropped", "check_failed", NOW);
      expect(await state()).toEqual({ kind: "dropped", reason: "check_failed" });
      settleEntry(sql, pinOf("clm_atlas01"), "landed", null, NOW);
      expect(await state()).toEqual({ kind: "landed" });
    });
  });

  it("answers no pin without a ready claim, even when the queue holds one", async () => {
    await withPins(async ({ sql, claims, pin }) => {
      expect(pinData(await pin(ATLAS))).toEqual({ pin: null });
      claims.set(ATLAS, claim("clm_atlas01", "working"));
      insertEntry(sql, pinOf("clm_atlas01"), 1, NOW);
      expect(pinData(await pin(ATLAS))).toEqual({ pin: null });
      claims.set(ATLAS, claim("clm_atlas01", "ready"));
      expect(pinData(await pin(ATLAS)).pin?.state).toEqual({ kind: "queued", position: 1 });
    });
  });

  it("answers internal, without a pin, when the queue and the batch disagree", async () => {
    await withPins(async ({ sql, claims, pin }) => {
      claims.set(ATLAS, claim("clm_atlas01", "ready"));
      insertEntry(sql, pinOf("clm_atlas01"), 1, NOW);
      sql.exec("UPDATE train_queue SET state = 'batched' WHERE claim_id = 'clm_atlas01'");
      const reply = await pin(ATLAS);
      expect(reply).toMatchObject({ ok: false, error: { code: "internal", retryable: true } });
      expect(JSON.stringify(reply)).not.toContain(HEAD);
    });
  });

  it("refuses with unavailable while the train is missing, and with the claims port's refusal", async () => {
    await withPins(
      async ({ claims, pin }) => {
        claims.set(ATLAS, claim("clm_atlas01", "ready"));
        expect(await pin(ATLAS)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      },
      () => ({ train: unavailableTrain }),
    );
    await withPins(
      async ({ pin }) => {
        expect(await pin(ATLAS)).toMatchObject({ ok: false, error: { code: "busy" } });
      },
      (real) => ({
        claims: { ...real.claims, activeClaim: async () => fail("busy", "The fork is opening.") },
      }),
    );
  });
});

describe("pin over HTTP", () => {
  it("needs a session and takes no body", async () => {
    const { summary } = await freshRepo();
    const url = `${ORIGIN}/agent/v1/acme/${summary.name}/pin`;
    const anonymous = await SELF.fetch(url);
    expect(anonymous.status).toBe(401);
    const parsed = parseAgentResponse("pin", await anonymous.json());
    expect(parsed.response).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    // `pin` is a read: a POST matches no route.
    const posted = await SELF.fetch(url, { method: "POST" });
    expect(posted.status).toBe(404);
  });
});
