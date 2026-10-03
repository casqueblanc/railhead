import { describe, expect, it, vi } from "vitest";
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

/** An attempt control no one aborts, which records when the action was sent. */
const control = (signal: AbortSignal = new AbortController().signal) => {
  const sent: string[] = [];
  return { signal, onSent: () => sent.push("sent"), sent };
};

/** A promise and the function that settles it, for holding a step open. */
const deferred = <T>() => {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle?.(value) };
};

const confirm = { kind: "agent.confirm", agentId: "agt_atlas", code: "123456" } as const;

describe("performOwnerAction", () => {
  it("prepares the exact action, signs its challenge and performs it once", async () => {
    const { owner, prepares, performs } = ownerPort(async () => ({
      ok: true,
      value: { kind: "agent.confirm", agentId: "agt_atlas" },
    }));
    const { authenticator } = fakeAuthenticator();

    const outcome = await performOwnerAction(owner, authenticator, confirm, control());

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

    expect(await performOwnerAction(owner, authenticator, confirm, control())).toEqual({
      kind: "cancelled",
    });
    expect(performs).toHaveLength(0);
  });

  it("refuses an assertion the backend rejects for this action", async () => {
    const { owner } = ownerPort(async () => ({
      ok: false,
      code: "proof_invalid",
      message: "assertion is for another challenge",
    }));
    const { authenticator } = fakeAuthenticator();

    expect(await performOwnerAction(owner, authenticator, confirm, control())).toEqual({
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
      const outcome = await performOwnerAction(owner, authenticator, confirm, control());
      expect(outcome.kind).toBe("failed");
    }
  });

  it("stops before signing when the backend refuses to prepare", async () => {
    const { owner, performs } = ownerPort(
      () => Promise.reject(new Error("must not perform")),
      async () => ({ ok: false, code: "unavailable", message: "no identity module" }),
    );
    const { authenticator, requests } = fakeAuthenticator();

    const outcome = await performOwnerAction(owner, authenticator, confirm, control());

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
    const outcome = await performOwnerAction(owner, authenticator, confirm, control());
    expect(outcome).toEqual({
      kind: "failed",
      message:
        "The action no longer applies: the code differs or the agent changed. Nothing changed.",
    });
  });

  it("asks the owner to retry shortly when the backend is busy", async () => {
    const { owner } = ownerPort(async () => ({
      ok: false,
      code: "busy",
      message: "<b>not settled</b>",
    }));
    const { authenticator } = fakeAuthenticator();
    const outcome = await performOwnerAction(owner, authenticator, confirm, control());
    expect(outcome).toEqual({
      kind: "failed",
      message: "The backend is busy. Nothing changed; try again shortly.",
    });
  });

  it("turns a lost session into a failure instead of throwing", async () => {
    const { owner } = ownerPort(() => Promise.reject(new Error("socket closed")));
    const { authenticator } = fakeAuthenticator();
    const outcome = await performOwnerAction(owner, authenticator, confirm, control());
    expect(outcome.kind).toBe("failed");
  });

  describe("when the board withdraws the action", () => {
    it("neither prompts nor performs once aborted during prepare", async () => {
      const preparing = deferred<BoardResult<ActionChallenge>>();
      const { owner, performs } = ownerPort(
        () => Promise.reject(new Error("must not perform")),
        () => preparing.promise,
      );
      const { authenticator, requests } = fakeAuthenticator();
      const controller = new AbortController();
      const attempt = control(controller.signal);

      const outcome = performOwnerAction(owner, authenticator, confirm, attempt);
      controller.abort();
      preparing.resolve({ ok: true, value: challenge() });

      expect(await outcome).toEqual({ kind: "withdrawn", sent: false });
      expect(requests).toHaveLength(0);
      expect(performs).toHaveLength(0);
      expect(attempt.sent).toEqual([]);
    });

    it("does not perform an assertion signed after the abort", async () => {
      const signing = deferred<Credential | null>();
      const { owner, performs } = ownerPort(() => Promise.reject(new Error("must not perform")));
      const signer = fakeAuthenticator();
      const prompts: CredentialRequestOptions[] = [];
      const authenticator = {
        ...signer.authenticator,
        get: (options: CredentialRequestOptions) => {
          prompts.push(options);
          return signing.promise;
        },
      };
      const controller = new AbortController();

      const outcome = performOwnerAction(owner, authenticator, confirm, control(controller.signal));
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      controller.abort();
      expect(prompts[0]?.signal?.aborted).toBe(true);
      signing.resolve(await signer.authenticator.get({}));

      expect(await outcome).toEqual({ kind: "withdrawn", sent: false });
      expect(performs).toHaveLength(0);
    });

    it("says the action may have happened when aborted after it was sent", async () => {
      const performing = deferred<BoardResult<OwnerActionResult>>();
      const { owner, performs } = ownerPort(() => performing.promise);
      const { authenticator } = fakeAuthenticator();
      const controller = new AbortController();
      const attempt = control(controller.signal);

      const outcome = performOwnerAction(owner, authenticator, confirm, attempt);
      await vi.waitFor(() => expect(performs).toHaveLength(1));
      controller.abort();
      performing.resolve({ ok: true, value: { kind: "agent.confirm", agentId: "agt_atlas" } });

      expect(await outcome).toEqual({ kind: "withdrawn", sent: true });
      expect(attempt.sent).toEqual(["sent"]);
    });
  });
});
