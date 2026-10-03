import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  MAX_ISSUE_BODY_LENGTH,
  MAX_LIST_LENGTH,
  MAX_OPTIONS,
  MAX_TITLE_LENGTH,
  isCommitSha,
  isId,
  validateEvent,
  type Actor,
  type EventPayload,
  type EventType,
  type RailheadEvent,
} from "@railhead/shared/events";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HUMAN: Actor = { kind: "human", id: "usr_lemarier" };
const AGENT: Actor = { kind: "agent", id: "agt_atlas01" };
const SYSTEM: Actor = { kind: "system", id: "sys_train" };

/** The payload data of each event type. */
type DataOf = { [P in EventPayload as P["type"]]: P["data"] };

/** One valid payload per event type, with the actor allowed to record it. */
const VALID: { [T in EventType]: { actor: Actor; data: DataOf[T] } } = {
  "agent.invited": {
    actor: HUMAN,
    data: { inviteId: "inv_abc123", name: "atlas" },
  },
  "agent.joined": {
    actor: SYSTEM,
    data: {
      agentId: "agt_atlas01",
      inviteId: "inv_abc123",
      name: "atlas",
      keyFingerprint: `SHA256:${"A".repeat(43)}`,
    },
  },
  "agent.confirmed": {
    actor: HUMAN,
    data: { agentId: "agt_atlas01" },
  },
  "agent.revoked": {
    actor: HUMAN,
    data: { agentId: "agt_atlas01" },
  },
  "issue.filed": {
    actor: HUMAN,
    data: { issueId: "iss_upload1", title: "Handle large uploads", body: "" },
  },
  "claim.opened": {
    actor: AGENT,
    data: {
      claimId: "clm_42abcd",
      issueId: "iss_upload1",
      agentId: "agt_atlas01",
      generation: 1,
      base: SHA_A,
    },
  },
  "claim.pushed": {
    actor: AGENT,
    data: { claimId: "clm_42abcd", generation: 1, ref: "refs/heads/main", from: null, to: SHA_B },
  },
  "claim.ready": {
    actor: AGENT,
    data: {
      claimId: "clm_42abcd",
      generation: 1,
      commit: SHA_B,
      decisions: [{ decisionId: "dec_upload1", version: 1 }],
    },
  },
  "claim.refused": {
    actor: SYSTEM,
    data: { claimId: "clm_42abcd", generation: 1, reason: "after_ready" },
  },
  "claim.reopened": {
    actor: SYSTEM,
    data: {
      claimId: "clm_42abcd",
      generation: 1,
      reason: "decision_superseded",
      decisions: [{ decisionId: "dec_upload1", version: 2 }],
    },
  },
  "claim.expired": {
    actor: SYSTEM,
    data: { claimId: "clm_42abcd", generation: 1 },
  },
  "claim.reassigned": {
    actor: SYSTEM,
    data: { claimId: "clm_42abcd", from: "agt_atlas01", to: "agt_ember01", generation: 2 },
  },
  "claim.adapted": {
    actor: SYSTEM,
    data: {
      claimId: "clm_42abcd",
      intentId: "int_merge01",
      decision: { decisionId: "dec_upload1", version: 1 },
    },
  },
  "question.asked": {
    actor: AGENT,
    data: {
      questionId: "qst_upload1",
      claimId: "clm_42abcd",
      decisionId: "dec_upload1",
      text: "Should uploads above 10 MB be rejected or chunked?",
      options: [
        { key: "reject", label: "Reject them" },
        { key: "chunk", label: "Upload them in chunks" },
      ],
    },
  },
  "decision.recorded": {
    actor: HUMAN,
    data: {
      decisionId: "dec_upload1",
      version: 2,
      questionId: "qst_upload1",
      option: "chunk",
      supersedes: 1,
      scope: ["src/upload.ts"],
    },
  },
  "inbox.queued": {
    actor: SYSTEM,
    data: {
      agentId: "agt_atlas01",
      claimId: "clm_42abcd",
      item: 1,
      entry: { kind: "rework", decision: { decisionId: "dec_upload1", version: 2 } },
    },
  },
  "inbox.delivered": {
    actor: SYSTEM,
    data: { agentId: "agt_atlas01", claimId: "clm_42abcd", item: 1 },
  },
  "inbox.acked": {
    actor: AGENT,
    data: {
      agentId: "agt_atlas01",
      claimId: "clm_42abcd",
      item: 1,
      plan: "Switch the handler to chunks",
    },
  },
  "train.check": {
    actor: SYSTEM,
    data: {
      checkRunId: "chk_run0001",
      candidate: SHA_B,
      check: "acceptance:chunk",
      result: "pass",
      acceptance: { decision: { decisionId: "dec_upload1", version: 2 }, option: "chunk" },
    },
  },
  "train.conflict": {
    actor: SYSTEM,
    data: {
      claims: ["clm_42abcd", "clm_43abcd"],
      path: "src/upload.ts",
      class: "contradictory",
      probability: 0.97,
      route: "question",
    },
  },
  "train.intent": {
    actor: SYSTEM,
    data: {
      intentId: "int_merge01",
      expectedMain: SHA_A,
      candidate: SHA_B,
      claims: ["clm_42abcd"],
      decisions: [{ decisionId: "dec_upload1", version: 2 }],
      checkRunId: "chk_run0001",
    },
  },
  "train.main": {
    actor: SYSTEM,
    data: { intentId: "int_merge01", outcome: "updated", main: SHA_B },
  },
};

const EVENT_TYPES = Object.keys(VALID) as EventType[];

function event<T extends EventType>(
  type: T,
  actor: Actor = VALID[type].actor,
  data: DataOf[T] = VALID[type].data,
): RailheadEvent {
  // TypeScript cannot pair `type` with `data` across the union, so the payload is asserted once
  // here. Each `VALID` entry is still checked against its own event type.
  const payload = { type, data } as EventPayload;
  return {
    v: EVENT_SCHEMA_VERSION,
    seq: 1,
    at: 1_790_000_000_000,
    repo: "rep_railhead",
    actor,
    ...payload,
  };
}

/** The valid event of `type` with its `data` replaced by `change(data)`. */
function withData<T extends EventType>(
  type: T,
  change: (data: DataOf[T]) => DataOf[T],
): RailheadEvent {
  return event(type, VALID[type].actor, change(structuredClone(VALID[type].data)));
}

/** `n` distinct, valid question options. */
function options(n: number): { key: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => ({ key: `option_${i}`, label: `Option ${i}` }));
}

describe("validateEvent", () => {
  it.each(EVENT_TYPES)("accepts a valid %s event", (type) => {
    expect(() => validateEvent(event(type))).not.toThrow();
  });

  describe("envelope", () => {
    it("rejects an unsupported schema version", () => {
      expect(() => validateEvent({ ...event("issue.filed"), v: 2 })).toThrow(/schema version/);
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects seq %s", (seq) => {
      expect(() => validateEvent({ ...event("issue.filed"), seq })).toThrow(/seq/);
    });

    it("rejects a repository identifier of another kind", () => {
      expect(() => validateEvent({ ...event("issue.filed"), repo: "clm_42abcd" })).toThrow(/repo/);
    });

    it("rejects an actor identifier that does not match its kind", () => {
      const actor: Actor = { kind: "human", id: "agt_atlas01" };
      expect(() => validateEvent(event("issue.filed", actor))).toThrow(/actor\.id/);
    });
  });

  describe("authority", () => {
    it.each(["agent.invited", "agent.confirmed", "agent.revoked", "decision.recorded"] as const)(
      "refuses %s recorded by an agent",
      (type) => {
        expect(() => validateEvent(event(type, AGENT))).toThrow(/must be recorded by a person/);
      },
    );

    it("refuses a decision recorded by the system", () => {
      expect(() => validateEvent(event("decision.recorded", SYSTEM))).toThrow(/by a person/);
    });

    it.each([
      "train.check",
      "train.main",
      "claim.reassigned",
      "claim.reopened",
      "claim.adapted",
      "inbox.queued",
    ] as const)("refuses %s asserted by an agent", (type) => {
      expect(() => validateEvent(event(type, AGENT))).toThrow(/must be recorded by the system/);
    });

    it("refuses a reopened claim asserted by a person", () => {
      expect(() => validateEvent(event("claim.reopened", HUMAN))).toThrow(
        /must be recorded by the system/,
      );
    });

    it("refuses an adaptation asserted by a person", () => {
      expect(() => validateEvent(event("claim.adapted", HUMAN))).toThrow(
        /must be recorded by the system/,
      );
    });
  });

  describe("agent self-reference", () => {
    it("refuses an agent acknowledging another agent's inbox item", () => {
      const other: Actor = { kind: "agent", id: "agt_ember01" };
      expect(() => validateEvent(event("inbox.acked", other))).toThrow(/its own inbox items/);
    });

    it("refuses an agent opening a claim for another agent", () => {
      const other: Actor = { kind: "agent", id: "agt_ember01" };
      expect(() => validateEvent(event("claim.opened", other))).toThrow(/only for itself/);
    });

    it.each([HUMAN, SYSTEM])("refuses an acknowledgement recorded by %o", (actor) => {
      expect(() => validateEvent(event("inbox.acked", actor))).toThrow(/by the agent itself/);
    });

    it("lets a person open a claim on an agent's behalf", () => {
      expect(() => validateEvent(event("claim.opened", HUMAN))).not.toThrow();
    });
  });

  describe("payload invariants", () => {
    it("rejects a commit id that is not 40 lowercase hex characters", () => {
      expect(() =>
        validateEvent(withData("claim.ready", (d) => ({ ...d, commit: SHA_A.toUpperCase() }))),
      ).toThrow(/commit/);
      expect(() =>
        validateEvent(withData("claim.ready", (d) => ({ ...d, commit: "a".repeat(39) }))),
      ).toThrow(/commit/);
    });

    it("rejects a claim identifier used where a decision is expected", () => {
      const bad = withData("claim.ready", (d) => ({
        ...d,
        decisions: [{ decisionId: "clm_42abcd", version: 1 }],
      }));
      expect(() => validateEvent(bad)).toThrow(/decisionId/);
    });

    it("rejects a first decision version that claims to supersede one", () => {
      const bad = withData("decision.recorded", (d) => ({ ...d, version: 1, supersedes: 1 }));
      expect(() => validateEvent(bad)).toThrow(/supersedes nothing/);
    });

    it("rejects a decision version that skips the one before it", () => {
      const bad = withData("decision.recorded", (d) => ({ ...d, version: 3, supersedes: 1 }));
      expect(() => validateEvent(bad)).toThrow(/must supersede version 2/);
    });

    it.each(["/etc/passwd", "src/../secret", "", "src//upload.ts"])(
      "rejects scope path %j",
      (path) => {
        const bad = withData("decision.recorded", (d) => ({ ...d, scope: [path] }));
        expect(() => validateEvent(bad)).toThrow(/scope\[0\]/);
      },
    );

    it("rejects a decision with an empty scope", () => {
      expect(() =>
        validateEvent(withData("decision.recorded", (d) => ({ ...d, scope: [] }))),
      ).toThrow(/scope/);
    });

    it("rejects a question with duplicate option keys", () => {
      const bad = withData("question.asked", (d) => ({
        ...d,
        options: [
          { key: "reject", label: "Reject" },
          { key: "reject", label: "Reject again" },
        ],
      }));
      expect(() => validateEvent(bad)).toThrow(/duplicate/);
    });

    it("rejects a question with a single option", () => {
      const bad = withData("question.asked", (d) => ({
        ...d,
        options: [{ key: "reject", label: "Reject" }],
      }));
      expect(() => validateEvent(bad)).toThrow(/options/);
    });

    it("rejects a conflict between a claim and itself", () => {
      const bad = withData("train.conflict", (d) => ({
        ...d,
        claims: ["clm_42abcd", "clm_42abcd"],
      }));
      expect(() => validateEvent(bad)).toThrow(/two different claims/);
    });

    it.each([-0.01, 1.01, Number.NaN])("rejects conflict probability %s", (probability) => {
      const bad = withData("train.conflict", (d) => ({ ...d, probability }));
      expect(() => validateEvent(bad)).toThrow(/probability/);
    });

    it("rejects a reassignment to the agent that already holds the claim", () => {
      const bad = withData("claim.reassigned", (d) => ({ ...d, to: d.from }));
      expect(() => validateEvent(bad)).toThrow(/reassigned to the agent that holds it/);
    });

    it("rejects an adaptation that names a claim as its intent or a version of zero", () => {
      const intent = withData("claim.adapted", (d) => ({ ...d, intentId: d.claimId }));
      expect(() => validateEvent(intent)).toThrow(/intentId/);
      const version = withData("claim.adapted", (d) => ({
        ...d,
        decision: { ...d.decision, version: 0 },
      }));
      expect(() => validateEvent(version)).toThrow(/version/);
    });

    it("rejects a merge intent with no claims", () => {
      expect(() => validateEvent(withData("train.intent", (d) => ({ ...d, claims: [] })))).toThrow(
        /claims/,
      );
    });

    it("rejects a refusal without a valid generation", () => {
      const bad = withData("claim.refused", (d) => ({ ...d, generation: 0 }));
      expect(() => validateEvent(bad)).toThrow(/generation/);
    });

    it("rejects a push to something that is not a Git ref", () => {
      expect(() => validateEvent(withData("claim.pushed", (d) => ({ ...d, ref: "main" })))).toThrow(
        /ref/,
      );
    });

    it("rejects an empty acknowledgement plan", () => {
      expect(() => validateEvent(withData("inbox.acked", (d) => ({ ...d, plan: "   " })))).toThrow(
        /plan is empty/,
      );
    });

    it("rejects an inbox conflict entry naming a non-claim", () => {
      const bad = withData("inbox.queued", (d) => ({
        ...d,
        entry: { kind: "conflict", otherClaimId: "dec_upload1", path: "src/upload.ts" },
      }));
      expect(() => validateEvent(bad)).toThrow(/otherClaimId/);
    });
  });

  describe("limits", () => {
    it("accepts a title exactly at the limit and rejects one over it", () => {
      const at = withData("issue.filed", (d) => ({ ...d, title: "t".repeat(MAX_TITLE_LENGTH) }));
      const over = withData("issue.filed", (d) => ({
        ...d,
        title: "t".repeat(MAX_TITLE_LENGTH + 1),
      }));
      expect(() => validateEvent(at)).not.toThrow();
      expect(() => validateEvent(over)).toThrow(/title is longer/);
    });

    it("rejects an issue body over the limit", () => {
      const over = withData("issue.filed", (d) => ({
        ...d,
        body: "b".repeat(MAX_ISSUE_BODY_LENGTH + 1),
      }));
      expect(() => validateEvent(over)).toThrow(/body is longer/);
    });

    it("accepts the maximum number of options and rejects one more", () => {
      const at = withData("question.asked", (d) => ({ ...d, options: options(MAX_OPTIONS) }));
      const over = withData("question.asked", (d) => ({ ...d, options: options(MAX_OPTIONS + 1) }));
      expect(() => validateEvent(at)).not.toThrow();
      expect(() => validateEvent(over)).toThrow(/options/);
    });

    it("rejects a list longer than the limit", () => {
      const claims = Array.from(
        { length: MAX_LIST_LENGTH + 1 },
        (_, i) => `clm_claim${String(i).padStart(4, "0")}`,
      );
      expect(() => validateEvent(withData("train.intent", (d) => ({ ...d, claims })))).toThrow(
        /more than/,
      );
    });

    it.each([0, 1])("accepts conflict probability %s", (probability) => {
      expect(() =>
        validateEvent(withData("train.conflict", (d) => ({ ...d, probability }))),
      ).not.toThrow();
    });
  });
});

describe("identifier helpers", () => {
  it("accepts identifiers of the named kind only", () => {
    expect(isId("claim", "clm_42abcd")).toBe(true);
    expect(isId("decision", "clm_42abcd")).toBe(false);
    expect(isId("claim", "clm_short")).toBe(false);
    expect(isId("claim", "clm_has-dash")).toBe(false);
    expect(isId("system", "sys_train")).toBe(true);
  });

  it("accepts only full lowercase SHA-1 commit ids", () => {
    expect(isCommitSha(SHA_A)).toBe(true);
    expect(isCommitSha(SHA_A.slice(1))).toBe(false);
    expect(isCommitSha(`${"g".repeat(40)}`)).toBe(false);
  });
});
