import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionChallenge,
  BoardResult,
  EnrollmentChallenge,
  OwnerAction,
  OwnerActionResult,
} from "@railhead/shared/board-api";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  SYNTH_GATEWAY,
  SYNTH_OWNER,
  SYNTH_REPO,
  syntheticLog,
  withLostEvents,
} from "../../../../../fixtures/board/syntheticLog";
import { enrol } from "../../../../../fixtures/board/uploadSteps";
import type { EnrollmentPort, OwnerPort } from "../board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { EnrollmentPanel } from "./EnrollmentPanel";
import { fakeAuthenticator } from "./fakeAuthenticator";
import type { Authenticator } from "./webauthn";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

/** Atlas confirmed; dune joined and waits for the owner. */
const joinedSteps = () => [
  ...enrol("agt_synthatlas", "atlas", "inv_synthatlas"),
  {
    type: "agent.invited",
    actor: SYNTH_OWNER,
    data: { inviteId: "inv_synthdune", name: "dune" },
  } as const,
  {
    type: "agent.joined",
    actor: SYNTH_GATEWAY,
    data: {
      agentId: "agt_synthdune",
      inviteId: "inv_synthdune",
      name: "dune",
      keyFingerprint: `SHA256:${"D".repeat(43)}`,
    },
  } as const,
];

const joined = () => fold(syntheticLog("Synthetic join", joinedSteps()).events);

/** The joined board after the log records that dune was revoked. */
const duneRevoked = () =>
  fold(
    syntheticLog("Synthetic rejection", [
      ...joinedSteps(),
      { type: "agent.revoked", actor: SYNTH_OWNER, data: { agentId: "agt_synthdune" } } as const,
    ]).events,
  );

/** The joined board with its last event lost, so it is missing events. */
const behind = () => {
  const log = syntheticLog("Synthetic gap", [
    ...joinedSteps(),
    { type: "agent.revoked", actor: SYNTH_OWNER, data: { agentId: "agt_synthatlas" } } as const,
    { type: "agent.revoked", actor: SYNTH_OWNER, data: { agentId: "agt_synthdune" } } as const,
  ]);
  return fold(withLostEvents(log, [log.events.length - 1]));
};

/** A promise and the function that settles it, for holding a step open. */
const deferred = <T,>() => {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle?.(value) };
};

const live = (board: BoardState): BoardFeed => ({
  kind: "board",
  board,
  connection: "live",
  recovered: false,
});

const challenge = (): ActionChallenge => ({
  challengeId: "chl_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  allowCredentials: ["AQID"],
  expiresAt: Date.now() + 60_000,
});

/** An owner port that records each prepared action and performed challenge. */
const recordingOwner = (performed: (action: OwnerAction) => BoardResult<OwnerActionResult>) => {
  const prepares: OwnerAction[] = [];
  const performs: string[] = [];
  const owner: OwnerPort = {
    kind: "available",
    onPrepareAction: async (action) => {
      prepares.push(action);
      return { ok: true, value: challenge() };
    },
    onPerformAction: async (challengeId) => {
      performs.push(challengeId);
      const action = prepares.at(-1);
      if (action === undefined) throw new Error("perform before prepare");
      return performed(action);
    },
  };
  return { owner, prepares, performs };
};

/** Answers every action with its own result. */
const echo = (action: OwnerAction): BoardResult<OwnerActionResult> => {
  switch (action.kind) {
    case "invite.create":
      return {
        ok: true,
        value: {
          kind: "invite.create",
          inviteId: "inv_synthnew",
          inviteUrl: "https://railhead.dev/join/synth-secret",
          expiresAt: Date.UTC(2026, 9, 2, 12, 15),
        },
      };
    case "agent.confirm":
    case "agent.revoke":
      return { ok: true, value: { kind: action.kind, agentId: action.agentId } };
    case "issue.file":
    case "decision.record":
      throw new Error(`unexpected ${action.kind}`);
  }
};

const type = async (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const click = async (target: HTMLButtonElement) => {
  await act(async () => target.click());
};

const enrollmentChallenge = (): EnrollmentChallenge => ({
  challengeId: "enr_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  userHandle: "BAUG",
  expiresAt: Date.now() + 60_000,
});

const enrolled: BoardResult<{ ownerId: string }> = {
  ok: true,
  value: { ownerId: "usr_synthowner" },
};

/** An enrollment port that records each token and completed challenge. */
const enrollmentPort = (
  completed: () => Promise<BoardResult<{ ownerId: string }>> = async () => enrolled,
  prepared: () => Promise<BoardResult<EnrollmentChallenge>> = async () => ({
    ok: true,
    value: enrollmentChallenge(),
  }),
) => {
  const tokens: string[] = [];
  const completions: string[] = [];
  const port: EnrollmentPort = {
    kind: "available",
    onPrepareEnrollment: (token) => {
      tokens.push(token);
      return prepared();
    },
    onCompleteEnrollment: (challengeId) => {
      completions.push(challengeId);
      return completed();
    },
  };
  return { port, tokens, completions };
};

describe("EnrollmentPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (
    feed: BoardFeed,
    owner: OwnerPort,
    authenticator: Authenticator | null,
    enrollment: EnrollmentPort = { kind: "unavailable", reason: "module_unavailable" },
  ) => {
    await act(async () =>
      root.render(
        <EnrollmentPanel
          feed={feed}
          owner={owner}
          enrollment={enrollment}
          authenticator={authenticator}
        />,
      ),
    );
  };

  const button = (name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };

  const input = (label: string): HTMLInputElement => {
    const found = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    const control = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
    if (!(control instanceof HTMLInputElement)) throw new Error(`no input labelled ${label}`);
    return control;
  };

  const confirmDune = async (code: string) => {
    await type(input("Code shown by dune"), code);
    await click(button("Confirm agent"));
  };

  const text = () => container.textContent ?? "";

  it("confirms a joined agent with the code its terminal shows and one passkey assertion", async () => {
    const { owner, prepares, performs } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await confirmDune("482913");

    expect(prepares).toEqual([{ kind: "agent.confirm", agentId: "agt_synthdune", code: "482913" }]);
    expect(performs).toEqual(["chl_1"]);
    expect(text()).toContain("Confirmed. dune shows as confirmed once the log records it.");
    // The log has not recorded the confirmation, so dune still waits.
    expect(text()).toContain("Awaiting confirmation");
  });

  it("leaves the agent unconfirmed when the owner cancels the passkey prompt", async () => {
    const { owner, performs } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator(() => "dismiss").authenticator);

    await confirmDune("482913");

    expect(performs).toEqual([]);
    expect(text()).toContain("Cancelled. dune stays unconfirmed and cannot work.");
    expect(text()).toContain("Awaiting confirmation");
  });

  it("refuses a malformed code before asking for a challenge", async () => {
    const { owner, prepares } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await confirmDune("48291");

    expect(prepares).toEqual([]);
    expect(text()).toContain("Enter the six digits the agent's terminal shows.");
  });

  it("shows the backend's refusal of a wrong-action assertion and keeps the agent waiting", async () => {
    const { owner } = recordingOwner(() => ({
      ok: false,
      code: "proof_invalid",
      message: "assertion bound to another action",
    }));
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await confirmDune("482913");

    expect(text()).toContain("The passkey did not verify for this action. Nothing changed.");
    expect(text()).toContain("Awaiting confirmation");
  });

  it("offers no way to confirm without a passkey on this page", async () => {
    const { owner, prepares } = recordingOwner(echo);
    await render(live(joined()), owner, null);

    expect(button("Confirm agent").disabled).toBe(true);
    expect(button("Create invite").disabled).toBe(true);
    expect(text()).toContain("Blocked: this browser cannot use a passkey on this page.");
    await act(async () => {
      container
        .querySelector("form:has(input[name=confirmation-code])")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(prepares).toEqual([]);
  });

  it.each([
    [{ kind: "unavailable", reason: "offline" } as const, "Blocked while the board is offline."],
    [
      { kind: "unavailable", reason: "module_unavailable" } as const,
      "Unavailable: this Railhead has no owner actions installed.",
    ],
  ])("blocks every action while the owner port is %o", async (owner, message) => {
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    expect(text()).toContain(message);
    expect(button("Confirm agent").disabled).toBe(true);
    expect(button("Create invite").disabled).toBe(true);
    expect(container.textContent).not.toContain("Revoke…");
  });

  it("blocks actions while the board is missing events", async () => {
    const board = behind();
    expect(board.stream.kind).toBe("gap");
    const { owner } = recordingOwner(echo);
    await render(live(board), owner, fakeAuthenticator().authenticator);

    expect(text()).toContain("Blocked while the board catches up with missing events.");
    expect(button("Create invite").disabled).toBe(true);
  });

  it("creates an invite and shows its URL until hidden", async () => {
    const { owner, prepares } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await type(input("Agent name"), "cedar");
    await click(button("Create invite"));

    expect(prepares).toEqual([{ kind: "invite.create", name: "cedar" }]);
    expect(text()).toContain("https://railhead.dev/join/synth-secret");
    expect(input("Agent name").value).toBe("");

    await click(button("Hide invite"));
    expect(text()).not.toContain("synth-secret");
  });

  it("refuses an invalid agent name before asking for a challenge", async () => {
    const { owner, prepares } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await type(input("Agent name"), "Cedar");
    await click(button("Create invite"));

    expect(prepares).toEqual([]);
    expect(text()).toContain("Start with a lowercase letter");
  });

  it("revokes a confirmed agent only after a second step", async () => {
    const { owner, prepares } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await click(button("Revoke…"));
    expect(prepares).toEqual([]);
    await click(button("Revoke atlas"));

    expect(prepares).toEqual([{ kind: "agent.revoke", agentId: "agt_synthatlas" }]);
    expect(text()).toContain("Revoked. atlas shows as revoked once the log records it.");
  });

  it("keeps the agent when the owner backs out of revoking", async () => {
    const { owner, prepares } = recordingOwner(echo);
    await render(live(joined()), owner, fakeAuthenticator().authenticator);

    await click(button("Revoke…"));
    await click(button("Keep"));

    expect(prepares).toEqual([]);
    expect(button("Revoke…")).toBeDefined();
  });

  it("says when the board is loading or failed to load", async () => {
    const { owner } = recordingOwner(echo);
    await render({ kind: "loading" }, owner, null);
    expect(text()).toContain("Loading agents…");

    await render({ kind: "failed" }, owner, null);
    expect(text()).toContain("Agents did not load");
  });

  it("explains an empty roster", async () => {
    const { owner } = recordingOwner(echo);
    await render(live(fold([])), owner, fakeAuthenticator().authenticator);
    expect(text()).toContain("No agents yet");
  });

  describe("rejecting an agent that waits for confirmation", () => {
    it("revokes it with one passkey assertion, and moves it only once the log records it", async () => {
      const { owner, prepares, performs } = recordingOwner(echo);
      const authenticator = fakeAuthenticator().authenticator;
      await render(live(joined()), owner, authenticator);

      await click(button("Reject…"));
      expect(prepares).toEqual([]);
      await click(button("Reject dune"));

      expect(prepares).toEqual([{ kind: "agent.revoke", agentId: "agt_synthdune" }]);
      expect(performs).toEqual(["chl_1"]);
      expect(text()).toContain("Rejected. dune shows as revoked once the log records it.");
      expect(text()).toContain("Awaiting confirmation");

      await render(live(duneRevoked()), owner, authenticator);
      expect(text()).not.toContain("Awaiting confirmation");
      expect(container.querySelector("input[name=confirmation-code]")).toBeNull();
      expect(text()).toContain("Revoked");
    });

    it("rejects nothing when the owner backs out or cancels the passkey prompt", async () => {
      const { owner, prepares, performs } = recordingOwner(echo);
      await render(live(joined()), owner, fakeAuthenticator(() => "dismiss").authenticator);

      await click(button("Reject…"));
      await click(button("Keep"));
      expect(prepares).toEqual([]);

      await click(button("Reject…"));
      await click(button("Reject dune"));
      expect(performs).toEqual([]);
      expect(text()).toContain("Cancelled. dune still waits for confirmation.");
      expect(text()).toContain("Awaiting confirmation");
    });

    it("shows the backend's refusal and keeps the agent waiting", async () => {
      const { owner } = recordingOwner(() => ({
        ok: false,
        code: "action_stale",
        message: "agent changed",
      }));
      await render(live(joined()), owner, fakeAuthenticator().authenticator);

      await click(button("Reject…"));
      await click(button("Reject dune"));

      expect(text()).toContain("The action no longer applies");
      expect(text()).toContain("Awaiting confirmation");
      expect(button("Reject dune").disabled).toBe(false);
    });

    it("offers no rejection while actions are blocked", async () => {
      const { owner } = recordingOwner(echo);
      await render(live(behind()), owner, fakeAuthenticator().authenticator);
      expect(text()).not.toContain("Reject…");
    });
  });

  describe("when actions are withdrawn mid-request", () => {
    it("does not prompt or perform once the board falls behind during prepare", async () => {
      const preparing = deferred<BoardResult<ActionChallenge>>();
      const performs: string[] = [];
      const owner: OwnerPort = {
        kind: "available",
        onPrepareAction: () => preparing.promise,
        onPerformAction: async (challengeId) => {
          performs.push(challengeId);
          return echo({ kind: "invite.create", name: "cedar" });
        },
      };
      const { authenticator, requests } = fakeAuthenticator();
      await render(live(joined()), owner, authenticator);

      await type(input("Agent name"), "cedar");
      await click(button("Create invite"));
      await render(live(behind()), owner, authenticator);
      await act(async () => preparing.resolve({ ok: true, value: challenge() }));

      expect(requests).toHaveLength(0);
      expect(performs).toEqual([]);
      expect(text()).toContain(
        "Stopped: the board lost its current view before the action was sent.",
      );
    });

    it("cancels the passkey prompt and performs nothing once the board halts during signing", async () => {
      const signing = deferred<Credential | null>();
      const prompts: CredentialRequestOptions[] = [];
      const signer = fakeAuthenticator();
      const authenticator: Authenticator = {
        ...signer.authenticator,
        get: (options) => {
          prompts.push(options);
          return signing.promise;
        },
      };
      const { owner, performs } = recordingOwner(echo);
      await render(live(joined()), owner, authenticator);

      await confirmDune("482913");
      expect(prompts).toHaveLength(1);
      const halted: BoardState = {
        ...joined(),
        stream: { kind: "halted", fault: { kind: "foreign_repo", seq: 99 } },
      };
      await render(live(halted), owner, authenticator);
      expect(prompts[0]?.signal?.aborted).toBe(true);
      const signed = await signer.authenticator.get({});
      await act(async () => signing.resolve(signed));

      expect(performs).toEqual([]);
      expect(text()).toContain("Blocked because the board stopped reading the log.");
    });

    it("drops a late answer from a replaced session and leaves the new one usable", async () => {
      const performing = deferred<BoardResult<OwnerActionResult>>();
      const first: OwnerPort = {
        kind: "available",
        onPrepareAction: async () => ({ ok: true, value: challenge() }),
        onPerformAction: () => performing.promise,
      };
      const second = recordingOwner(echo);
      const { authenticator } = fakeAuthenticator();
      await render(live(joined()), first, authenticator);

      await type(input("Agent name"), "cedar");
      await click(button("Create invite"));
      await render(live(joined()), second.owner, authenticator);
      await act(async () => performing.resolve(echo({ kind: "invite.create", name: "cedar" })));

      expect(text()).not.toContain("synth-secret");
      expect(text()).toContain(
        "The board lost its current view after the action was sent. Check the agents list before retrying.",
      );

      await click(button("Create invite"));
      expect(second.prepares).toEqual([{ kind: "invite.create", name: "cedar" }]);
      expect(text()).toContain("https://railhead.dev/join/synth-secret");
    });
  });

  describe("owner passkey", () => {
    it("enrolls with the bootstrap token and closes the form", async () => {
      const { owner } = recordingOwner(echo);
      const { port, tokens, completions } = enrollmentPort();
      await render(live(fold([])), owner, fakeAuthenticator().authenticator, port);

      await type(input("Bootstrap token"), " deploy-token ");
      await click(button("Enroll owner passkey"));

      expect(tokens).toEqual(["deploy-token"]);
      expect(completions).toEqual(["enr_1"]);
      expect(text()).toContain("Owner passkey enrolled. Enrollment is now closed.");
      expect(container.querySelector("input[name=bootstrap-token]")).toBeNull();
    });

    it("enrolls nothing when the owner cancels the passkey prompt", async () => {
      const { owner } = recordingOwner(echo);
      const { port, completions } = enrollmentPort();
      await render(live(fold([])), owner, fakeAuthenticator(() => "dismiss").authenticator, port);

      await type(input("Bootstrap token"), "deploy-token");
      await click(button("Enroll owner passkey"));

      expect(completions).toEqual([]);
      expect(text()).toContain("Cancelled. No passkey was enrolled.");
    });

    it("asks for a token before contacting the backend", async () => {
      const { owner } = recordingOwner(echo);
      const { port, tokens } = enrollmentPort();
      await render(live(fold([])), owner, fakeAuthenticator().authenticator, port);

      await type(input("Bootstrap token"), "   ");
      await click(button("Enroll owner passkey"));

      expect(tokens).toEqual([]);
      expect(text()).toContain("Enter the bootstrap token from the deploy.");
    });

    it("reports a closed enrollment or wrong token", async () => {
      const { owner } = recordingOwner(echo);
      const { port } = enrollmentPort(async () => ({
        ok: false,
        code: "bootstrap_closed",
        message: "closed",
      }));
      await render(live(fold([])), owner, fakeAuthenticator().authenticator, port);

      await type(input("Bootstrap token"), "wrong");
      await click(button("Enroll owner passkey"));

      expect(text()).toContain(
        "The owner passkey is already enrolled, or the bootstrap token is wrong.",
      );
    });

    it("says why enrollment is unavailable, even while the board is loading", async () => {
      const { owner } = recordingOwner(echo);
      await render({ kind: "loading" }, owner, fakeAuthenticator().authenticator, {
        kind: "unavailable",
        reason: "offline",
      });

      expect(button("Enroll owner passkey").disabled).toBe(true);
      expect(text()).toContain("Blocked while the board is offline.");
    });

    describe("when enrollment is withdrawn mid-request", () => {
      const offline: EnrollmentPort = { kind: "unavailable", reason: "offline" };

      it("does not prompt or complete once the session is lost during prepare", async () => {
        const preparing = deferred<BoardResult<EnrollmentChallenge>>();
        const { owner } = recordingOwner(echo);
        const { port, completions } = enrollmentPort(undefined, () => preparing.promise);
        const { authenticator, creations } = fakeAuthenticator();
        await render(live(fold([])), owner, authenticator, port);

        await type(input("Bootstrap token"), "deploy-token");
        await click(button("Enroll owner passkey"));
        await render(live(fold([])), owner, authenticator, offline);
        await act(async () => preparing.resolve({ ok: true, value: enrollmentChallenge() }));

        expect(creations).toHaveLength(0);
        expect(completions).toEqual([]);
        expect(text()).toContain(
          "Stopped: the board lost its connection before the passkey was sent. Nothing was enrolled.",
        );
        expect(text()).toContain("Blocked while the board is offline.");
      });

      it("cancels the passkey prompt and completes nothing once the session is lost during registration", async () => {
        const creating = deferred<Credential | null>();
        const prompts: CredentialCreationOptions[] = [];
        const creator = fakeAuthenticator();
        const authenticator: Authenticator = {
          ...creator.authenticator,
          create: (options) => {
            prompts.push(options);
            return creating.promise;
          },
        };
        const { owner } = recordingOwner(echo);
        const { port, completions } = enrollmentPort();
        await render(live(fold([])), owner, authenticator, port);

        await type(input("Bootstrap token"), "deploy-token");
        await click(button("Enroll owner passkey"));
        expect(prompts).toHaveLength(1);
        await render(live(fold([])), owner, authenticator, offline);
        expect(prompts[0]?.signal?.aborted).toBe(true);
        const created = await creator.authenticator.create({});
        await act(async () => creating.resolve(created));

        expect(completions).toEqual([]);
        expect(text()).toContain("Nothing was enrolled.");
      });

      it("drops a late completion from a replaced session and leaves the new one usable", async () => {
        const completing = deferred<BoardResult<{ ownerId: string }>>();
        const { owner } = recordingOwner(echo);
        const first = enrollmentPort(() => completing.promise);
        const second = enrollmentPort();
        const { authenticator } = fakeAuthenticator();
        await render(live(fold([])), owner, authenticator, first.port);

        await type(input("Bootstrap token"), "deploy-token");
        await click(button("Enroll owner passkey"));
        expect(first.completions).toEqual(["enr_1"]);
        await render(live(fold([])), owner, authenticator, second.port);
        await act(async () => completing.resolve(enrolled));

        expect(text()).not.toContain("Owner passkey enrolled.");
        expect(text()).toContain(
          "The board lost its connection after the passkey was sent. Try again; if enrollment is closed, the passkey was enrolled.",
        );

        await click(button("Enroll owner passkey"));
        expect(second.tokens).toEqual(["deploy-token"]);
        expect(second.completions).toEqual(["enr_1"]);
        expect(text()).toContain("Owner passkey enrolled. Enrollment is now closed.");
      });

      it("prompts and completes nothing after the panel unmounts", async () => {
        const preparing = deferred<BoardResult<EnrollmentChallenge>>();
        const { owner } = recordingOwner(echo);
        const { port, completions } = enrollmentPort(undefined, () => preparing.promise);
        const { authenticator, creations } = fakeAuthenticator();
        await render(live(fold([])), owner, authenticator, port);

        await type(input("Bootstrap token"), "deploy-token");
        await click(button("Enroll owner passkey"));
        await act(async () => root.render(null));
        await act(async () => preparing.resolve({ ok: true, value: enrollmentChallenge() }));

        expect(creations).toHaveLength(0);
        expect(completions).toEqual([]);
      });
    });
  });
});
