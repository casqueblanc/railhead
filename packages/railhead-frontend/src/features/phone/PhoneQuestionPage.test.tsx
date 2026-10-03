import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  SYNTH_REPO,
  seqWhere,
  synthAgent,
  syntheticLog,
  withLostEvents,
} from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, decide, uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import type { BoardPorts } from "../board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type {
  DecisionActions,
  RecordDecisionOutcome,
  RecordDecisionRequest,
} from "../decisions/decisionActions";
import type { AttemptControl } from "../enrollment/ownerActions";
import { questionTarget } from "./phoneLinks";
import { PhoneQuestionPage } from "./PhoneQuestionPage";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

const QUESTION = "Should uploads above 10 MB be rejected or chunked?";
const OTHER_DECISION = "dec_synthother";
const OTHER_QUESTION = "Should thumbnails be generated on upload?";

/** Atlas's upload question is open, and birch asks a second, unrelated one. */
const asked = () =>
  fold(
    syntheticLog("Synthetic phone question", [
      ...uploadPrelude(),
      {
        type: "question.asked",
        actor: synthAgent(UPLOAD.birch),
        data: {
          questionId: "qst_synthother",
          claimId: UPLOAD.birchClaim,
          decisionId: OTHER_DECISION,
          text: OTHER_QUESTION,
          options: [
            { key: "yes", label: "Generate thumbnails" },
            { key: "no", label: "Skip thumbnails" },
          ],
        },
      },
    ]).events,
  );

const answered = () =>
  fold(syntheticLog("Synthetic answered", [...uploadPrelude(), decide(1, "reject")]).events);

const ports = (board: BoardState, decisions: DecisionActions, patch: Partial<BoardPorts> = {}) =>
  ({
    connection: "connected",
    onReconnect: () => {},
    board: {
      kind: "available",
      feed: { kind: "board", board, connection: "live", recovered: false },
    },
    decisions,
    owner: { kind: "unavailable", reason: "module_unavailable" },
    enrollment: { kind: "unavailable", reason: "module_unavailable" },
    ...patch,
  }) satisfies BoardPorts;

/** Records every request and answers it with `outcome`, or holds it until the test settles it. */
const recorder = (outcome: RecordDecisionOutcome | "hold" = { ok: true, version: 1 }) => {
  const calls: { request: RecordDecisionRequest; control: AttemptControl }[] = [];
  const actions: DecisionActions = {
    kind: "available",
    onRecordDecision: (request, control) => {
      calls.push({ request, control });
      return outcome === "hold" ? new Promise(() => {}) : Promise.resolve(outcome);
    },
  };
  return { actions, calls };
};

describe("PhoneQuestionPage", () => {
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

  const render = async (board: BoardPorts, decision: unknown) => {
    await act(async () =>
      root.render(<PhoneQuestionPage ports={board} target={questionTarget(decision)} />),
    );
  };

  const text = () => container.textContent ?? "";

  const choose = async (label: string) => {
    const radio = [...container.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.trim() === label)
      ?.querySelector("button, input");
    if (!(radio instanceof HTMLElement)) throw new Error(`no option labelled ${label}`);
    await act(async () => radio.click());
  };

  const submit = async (name: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (button === undefined) throw new Error(`no button named ${name}`);
    await act(async () => button.click());
  };

  it("shows only the linked question and records the chosen answer for it", async () => {
    const { actions, calls } = recorder();
    await render(ports(asked(), actions), UPLOAD.decision);

    expect(text()).toContain(QUESTION);
    expect(text()).not.toContain(OTHER_QUESTION);
    expect(text()).toContain("Waiting for an answer");

    await choose("Reject them");
    await submit("Record answer");

    expect(calls.map((call) => call.request)).toEqual([
      { decisionId: UPLOAD.decision, option: "reject", expectedVersion: null },
    ]);
    expect(text()).toContain("Recorded as version 1.");
  });

  it("replaces an answered decision against the version the page shows", async () => {
    const { actions, calls } = recorder({ ok: true, version: 2 });
    await render(ports(answered(), actions), UPLOAD.decision);

    expect(text()).toContain("Current answer: Reject them");
    await choose("Upload them in chunks");
    await submit("Replace answer");

    expect(calls.map((call) => call.request)).toEqual([
      { decisionId: UPLOAD.decision, option: "chunk", expectedVersion: 1 },
    ]);
  });

  it("withdraws an answer in flight when the link changes to another question", async () => {
    const { actions, calls } = recorder("hold");
    await render(ports(asked(), actions), UPLOAD.decision);
    await choose("Reject them");
    await submit("Record answer");
    const [first] = calls;
    expect(first?.control.signal.aborted).toBe(false);

    await render(ports(asked(), actions), OTHER_DECISION);

    expect(first?.control.signal.aborted).toBe(true);
    expect(text()).toContain(OTHER_QUESTION);
    expect(text()).not.toContain("Recording…");
    // The other question starts from nothing: its answer is a new request bound to it alone.
    await choose("Generate thumbnails");
    await submit("Record answer");
    expect(calls.map((call) => call.request)).toEqual([
      { decisionId: UPLOAD.decision, option: "reject", expectedVersion: null },
      { decisionId: OTHER_DECISION, option: "yes", expectedVersion: null },
    ]);
  });

  it("shows nothing from the board for a malformed or missing link", async () => {
    const { actions, calls } = recorder();
    for (const decision of [undefined, "", "agt_synthatlas", "dec_x", 42]) {
      await render(ports(asked(), actions), decision);

      expect(text()).toContain("This link is not valid");
      expect(text()).not.toContain(QUESTION);
      expect(container.querySelectorAll("form")).toHaveLength(0);
    }
    expect(calls).toEqual([]);
  });

  it("says a well-formed link names no question here, without listing the others", async () => {
    const { actions } = recorder();
    await render(ports(asked(), actions), "dec_synthmissing");

    expect(text()).toContain("This question is not on the board");
    expect(text()).not.toContain(QUESTION);
    expect(text()).not.toContain(OTHER_QUESTION);
  });

  it("blocks answering while the connection is lost and offers to reconnect", async () => {
    const { actions, calls } = recorder();
    let reconnects = 0;
    await render(
      ports(asked(), actions, {
        connection: "lost",
        onReconnect: () => {
          reconnects += 1;
        },
      }),
      UPLOAD.decision,
    );

    expect(text()).toContain("Connection lost.");
    expect(text()).toContain("Answering is blocked while the board is offline.");
    await choose("Reject them");
    await submit("Record answer");
    expect(calls).toEqual([]);
    await submit("Reconnect");
    expect(reconnects).toBe(1);
  });

  it("blocks answering from a board that is missing events", async () => {
    const { actions, calls } = recorder();
    const lost = seqWhere(decisionReversal, (event) => event.type === "inbox.acked");
    const behind = fold(withLostEvents(decisionReversal, [lost]));
    expect(behind.stream.kind).toBe("gap");
    await render(ports(behind, actions), UPLOAD.decision);

    expect(text()).toContain("Answering is blocked while the board catches up");
    await choose("Upload them in chunks");
    await submit("Replace answer");
    expect(calls).toEqual([]);
  });

  it("shows a refused answer and keeps the question open", async () => {
    const { actions } = recorder({ ok: false, message: "The passkey did not verify." });
    await render(ports(asked(), actions), UPLOAD.decision);
    await choose("Reject them");
    await submit("Record answer");

    expect(text()).toContain("The passkey did not verify.");
    expect(text()).toContain("Waiting for an answer");
  });

  it("shows the board's loading and failed states before any question", async () => {
    const { actions } = recorder();
    await render(
      ports(asked(), actions, { board: { kind: "available", feed: { kind: "loading" } } }),
      UPLOAD.decision,
    );
    expect(text()).toContain("Loading the board…");

    await render(
      ports(asked(), actions, { board: { kind: "available", feed: { kind: "failed" } } }),
      UPLOAD.decision,
    );
    expect(text()).toContain("The board did not load");
    expect(text()).not.toContain(QUESTION);
  });
});
