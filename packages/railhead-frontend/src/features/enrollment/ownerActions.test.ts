import { describe, expect, it } from "vitest";
import type {
  ActionChallenge,
  BoardResult,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
} from "@railhead/shared/board-api";
import { fakeAuthenticator } from "./fakeAuthenticator";
import { performOwnerAction, type AvailableOwnerPort } from "./ownerActions";

const challenge = (): ActionChallenge => ({
  challengeId: "chl_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  allowCredentials: ["AQID"],
  expiresAt: Date.now() + 60_000,
});

/** An owner port that records every call and answers `perform` with `performed`. */
const ownerPort = (
  performed: (challengeId: string) => Promise<BoardResult<OwnerActionResult>>,
  prepared: () => Promise<BoardResult<ActionChallenge>> = async () => ({
    ok: true,
    value: challenge(),
  }),
) => {
  const prepares: OwnerAction[] = [];
  const performs: { challengeId: string; assertion: PasskeyAssertion }[] = [];
  const owner: AvailableOwnerPort = {
    kind: "available",
    onPrepareAction: (action) => {
      prepares.push(action);
      return prepared();
    },
    onPerformAction: (challengeId, assertion) => {
      performs.push({ challengeId, assertion });
      return performed(challengeId);
    },
  };
  return { owner, prepares, performs };
};

const confirm = { kind: "agent.confirm", agentId: "agt_atlas", code: "123456" } as const;

describe("performOwnerAction", () => {
  it("prepares the exact action, signs its challenge and performs it once", async () => {
    const { owner, prepares, performs } = ownerPort(async () => ({
      ok: true,
      value: { kind: "agent.confirm", agentId: "agt_atlas" },
    }));
    const { authenticator } = fakeAuthenticator();

    const outcome = await performOwnerAction(owner, authenticator, confirm);

    expect(outcome).toEqual({
      kind: "performed",
      result: { kind: "agent.confirm", agentId: "agt_atlas" },
    });
    expect(prepares).toEqual([confirm]);
    expect(performs.map((call) => call.challengeId)).toEqual(["chl_1"]);
    expect(performs[0]?.assertion.signature).toBe("CgsM");
  });

  it("performs nothing when the owner dismisses the passkey prompt", async () => {
    const { owner, performs } = ownerPort(() => Promise.reject(new Error("must not perform")));
    const { authenticator } = fakeAuthenticator(() => "dismiss");

    expect(await performOwnerAction(owner, authenticator, confirm)).toEqual({ kind: "cancelled" });
    expect(performs).toHaveLength(0);
  });

  it("refuses an assertion the backend rejects for this action", async () => {
    const { owner } = ownerPort(async () => ({
      ok: false,
      code: "proof_invalid",
      message: "assertion is for another challenge",
    }));
    const { authenticator } = fakeAuthenticator();

    expect(await performOwnerAction(owner, authenticator, confirm)).toEqual({
      kind: "failed",
      message: "The passkey did not verify for this action. Nothing changed.",
    });
  });

  it("does not report success when the backend answers for a different action", async () => {
    const answers: OwnerActionResult[] = [
      { kind: "agent.revoke", agentId: "agt_atlas" },
      { kind: "agent.confirm", agentId: "agt_birch" },
      { kind: "issue.file", issueId: "iss_x" },
    ];
    for (const answer of answers) {
      const { owner } = ownerPort(async () => ({ ok: true, value: answer }));
      const { authenticator } = fakeAuthenticator();
      const outcome = await performOwnerAction(owner, authenticator, confirm);
      expect(outcome.kind).toBe("failed");
    }
  });

  it("stops before signing when the backend refuses to prepare", async () => {
    const { owner, performs } = ownerPort(
      () => Promise.reject(new Error("must not perform")),
      async () => ({ ok: false, code: "unavailable", message: "no identity module" }),
    );
    const { authenticator, requests } = fakeAuthenticator();

    const outcome = await performOwnerAction(owner, authenticator, confirm);

    expect(outcome).toEqual({
      kind: "failed",
      message: "This Railhead cannot perform the action: its module is not installed.",
    });
    expect(requests).toHaveLength(0);
    expect(performs).toHaveLength(0);
  });

  it("reports a stale code without trusting the backend's text", async () => {
    const { owner } = ownerPort(async () => ({
      ok: false,
      code: "action_stale",
      message: "<b>code mismatch</b>",
    }));
    const { authenticator } = fakeAuthenticator();
    const outcome = await performOwnerAction(owner, authenticator, confirm);
    expect(outcome).toEqual({
      kind: "failed",
      message:
        "The action no longer applies: the code differs or the agent changed. Nothing changed.",
    });
  });

  it("turns a lost session into a failure instead of throwing", async () => {
    const { owner } = ownerPort(() => Promise.reject(new Error("socket closed")));
    const { authenticator } = fakeAuthenticator();
    const outcome = await performOwnerAction(owner, authenticator, confirm);
    expect(outcome.kind).toBe("failed");
  });
});
