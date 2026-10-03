import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionChallenge,
  BoardResult,
  OwnerAction,
  OwnerActionResult,
} from "@railhead/shared/board-api";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  SYNTH_GATEWAY,
  SYNTH_OWNER,
  SYNTH_REPO,
  syntheticLog,
} from "../../../../../fixtures/board/syntheticLog";
import { enrol } from "../../../../../fixtures/board/uploadSteps";
import type { BoardPorts, OwnerPort } from "../board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { fakeAuthenticator } from "../enrollment/fakeAuthenticator";
import type { Authenticator } from "../enrollment/webauthn";
import { confirmTarget } from "./phoneLinks";
import { PhoneConfirmPage } from "./PhoneConfirmPage";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

const DUNE = "agt_synthdune";
const FINGERPRINT = `SHA256:${"D".repeat(43)}`;

/** Atlas confirmed; dune and elm joined and wait for the owner. */
const joined = () =>
  fold(
    syntheticLog("Synthetic phone confirm", [
      ...enrol("agt_synthatlas", "atlas", "inv_synthatlas"),
      ...(["dune", "elm"] as const).flatMap((name) => [
        {
          type: "agent.invited",
          actor: SYNTH_OWNER,
          data: { inviteId: `inv_synth${name}`, name },
        } as const,
        {
          type: "agent.joined",
          actor: SYNTH_GATEWAY,
          data: {
            agentId: `agt_synth${name}`,
            inviteId: `inv_synth${name}`,
            name,
            keyFingerprint: FINGERPRINT,
          },
        } as const,
      ]),
    ]).events,
  );

const ports = (board: BoardState, owner: OwnerPort, patch: Partial<BoardPorts> = {}) =>
  ({
    connection: "connected",
    onReconnect: () => {},
    board: {
      kind: "available",
      feed: { kind: "board", board, connection: "live", recovered: false },
    },
    decisions: { kind: "unavailable", reason: "module_unavailable" },
    owner,
    enrollment: { kind: "unavailable", reason: "module_unavailable" },
    checks: { kind: "unavailable", reason: "module_unavailable" },
    ...patch,
  }) satisfies BoardPorts;

const challenge = (challengeId: string): ActionChallenge => ({
  challengeId,
  challenge: "AAECAw",
  rpId: "railhead.dev",
  allowCredentials: ["AQID"],
  expiresAt: Date.now() + 60_000,
});

/**
 * An owner port that hands out a fresh challenge per prepare and records which challenge each
 * perform quoted. `performed` answers each perform.
 */
const recordingOwner = (
  performed: (action: OwnerAction) => BoardResult<OwnerActionResult> = (action) =>
    action.kind === "agent.confirm"
      ? { ok: true, value: { kind: "agent.confirm", agentId: action.agentId } }
      : { ok: false, code: "invalid_request", message: "unexpected" },
) => {
  const prepares: OwnerAction[] = [];
  const performs: string[] = [];
  const owner: OwnerPort = {
    kind: "available",
    onPrepareAction: async (action) => {
      prepares.push(action);
      return { ok: true, value: challenge(`chl_${prepares.length}`) };
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

describe("PhoneConfirmPage", () => {
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
    board: BoardPorts,
    agent: unknown,
    authenticator: Authenticator | null = fakeAuthenticator().authenticator,
  ) => {
    await act(async () =>
      root.render(
        <PhoneConfirmPage
          ports={board}
          target={confirmTarget(agent)}
          authenticator={authenticator}
        />,
      ),
    );
  };

  const text = () => container.textContent ?? "";

  const button = (name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };

  const confirm = async (code: string) => {
    const field = container.querySelector<HTMLInputElement>('input[name="confirmation-code"]');
    if (field === null) throw new Error("no code field");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(field, code);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Confirm agent").click());
  };

  it("confirms only the linked agent with the typed code and a fresh passkey assertion", async () => {
    const { owner, prepares, performs } = recordingOwner();
    await render(ports(joined(), owner), DUNE);

    expect(text()).toContain("dune");
    expect(text()).not.toContain("elm");
    await confirm("482913");

    expect(prepares).toEqual([{ kind: "agent.confirm", agentId: DUNE, code: "482913" }]);
    expect(performs).toEqual(["chl_1"]);
    expect(text()).toContain("Confirmed. dune shows as confirmed once the log records it.");
  });

  it("asks for a new challenge on every attempt rather than reusing a proof", async () => {
    const results: BoardResult<OwnerActionResult>[] = [
      { ok: false, code: "proof_expired", message: "expired" },
      { ok: true, value: { kind: "agent.confirm", agentId: DUNE } },
    ];
    const { owner, prepares, performs } = recordingOwner(() => {
      const next = results.shift();
      if (next === undefined) throw new Error("unexpected perform");
      return next;
    });
    await render(ports(joined(), owner), DUNE);

    await confirm("482913");
    expect(text()).toContain("The passkey request expired or was already used.");
    await confirm("482913");

    expect(prepares).toHaveLength(2);
    expect(performs).toEqual(["chl_1", "chl_2"]);
    expect(text()).toContain("Confirmed. dune");
  });

  it("reports a result for another agent as a failure, not a confirmation", async () => {
    const { owner } = recordingOwner(() => ({
      ok: true,
      value: { kind: "agent.confirm", agentId: "agt_synthelm" },
    }));
    await render(ports(joined(), owner), DUNE);
    await confirm("482913");

    expect(text()).toContain("The backend answered for a different action.");
    expect(text()).not.toContain("Confirmed. dune");
  });

  it("refuses a malformed code before asking for a passkey", async () => {
    const { owner, prepares } = recordingOwner();
    await render(ports(joined(), owner), DUNE);
    await confirm("48291");

    expect(prepares).toEqual([]);
    expect(text()).toContain("six digits");
  });

  it("never shows the agent's key or a code the owner did not type", async () => {
    const { owner } = recordingOwner();
    await render(ports(joined(), owner), DUNE);

    expect(text()).not.toContain("SHA256:");
    expect(
      container.querySelector<HTMLInputElement>('input[name="confirmation-code"]')?.value,
    ).toBe("");
  });

  it("shows nothing from the board for a malformed or missing link", async () => {
    const { owner, prepares } = recordingOwner();
    for (const agent of [undefined, "", "dec_synthsize", "agt_x", ["agt_synthdune"]]) {
      await render(ports(joined(), owner), agent);

      expect(text()).toContain("This link is not valid");
      expect(text()).not.toContain("dune");
      expect(container.querySelectorAll("form")).toHaveLength(0);
    }
    expect(prepares).toEqual([]);
  });

  it("says a well-formed link names no agent here, without listing the others", async () => {
    const { owner } = recordingOwner();
    await render(ports(joined(), owner), "agt_synthmissing");

    expect(text()).toContain("This agent is not on the board");
    expect(text()).not.toContain("dune");
    expect(text()).not.toContain("atlas");
  });

  it("offers nothing to confirm for an agent already confirmed", async () => {
    const { owner } = recordingOwner();
    await render(ports(joined(), owner), "agt_synthatlas");

    expect(text()).toContain("Nothing to confirm: the agent can already work.");
    expect(container.querySelectorAll("form")).toHaveLength(0);
  });

  it("blocks confirming without a passkey or while offline", async () => {
    const { owner, prepares } = recordingOwner();
    await render(ports(joined(), owner), DUNE, null);
    expect(text()).toContain("Blocked: this browser cannot use a passkey on this page.");
    expect(button("Confirm agent").disabled).toBe(true);

    await render(ports(joined(), owner, { connection: "lost" }), DUNE);
    expect(text()).toContain("Blocked while the board is offline.");
    expect(button("Confirm agent").disabled).toBe(true);
    expect(prepares).toEqual([]);
  });
});
