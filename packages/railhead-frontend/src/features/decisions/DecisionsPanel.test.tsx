import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import { CONFLICT, parkedConflict } from "../../../../../fixtures/board/parkedConflict";
import {
  SYNTH_REPO,
  seqWhere,
  syntheticLog,
  withLostEvents,
} from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, decide, uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { DecisionsPanel } from "./DecisionsPanel";
import type { AttemptControl } from "../enrollment/ownerActions";
import type {
  DecisionActions,
  RecordDecisionOutcome,
  RecordDecisionRequest,
} from "./decisionActions";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

const asked = () => fold(syntheticLog("Synthetic open question", uploadPrelude()).events);
const answered = () =>
  fold(syntheticLog("Synthetic answer", [...uploadPrelude(), decide(1, "reject")]).events);

const isReversal = (event: RailheadEvent): boolean =>
  event.type === "decision.recorded" && event.data.version === 2;

const refused = async (): Promise<RecordDecisionOutcome> => ({
  ok: false,
  message: "The answer changed since this board loaded.",
});

const broken = (): Promise<RecordDecisionOutcome> => Promise.reject(new Error("socket closed"));

/** Records every request and answers each one by calling `outcome`. */
const recorder = (outcome: () => Promise<RecordDecisionOutcome>) => {
  const requests: RecordDecisionRequest[] = [];
  const actions: DecisionActions = {
    kind: "available",
    onRecordDecision: (request) => {
      requests.push(request);
      return outcome();
    },
  };
  return { requests, actions };
};

/** A recorder whose one request waits until the test settles it, keeping the control it got. */
const held = () => {
  const calls: { control: AttemptControl; settle: (outcome: RecordDecisionOutcome) => void }[] = [];
  const actions: DecisionActions = {
    kind: "available",
    onRecordDecision: (_request, control) =>
      new Promise((resolve) => {
        calls.push({ control, settle: resolve });
      }),
  };
  const call = () => {
    const found = calls[0];
    if (found === undefined) throw new Error("nothing was requested");
    return found;
  };
  return { actions, calls, call };
};

describe("DecisionsPanel", () => {
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

  const render = async (state: BoardState, actions: DecisionActions) => {
    await act(async () => root.render(<DecisionsPanel state={state} actions={actions} />));
  };

  const button = (name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };

  const choose = async (label: string) => {
    const option = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === label,
    );
    if (option === undefined) throw new Error(`no option labelled ${label}`);
    await act(async () => option.click());
  };

  const submit = async (name: string) => {
    await act(async () => button(name).click());
  };

  const text = () => container.textContent ?? "";

  it("records the first answer with the chosen option and no expected version", async () => {
    const { requests, actions } = recorder(async () => ({ ok: true, version: 1 }));
    await render(asked(), actions);

    expect(text()).toContain("Waiting for an answer");
    expect(text()).toContain("Should uploads above 10 MB be rejected or chunked?");
    expect(text()).toContain("Affects 1 claim");
    await choose("Upload them in chunks");
    await submit("Record answer");

    expect(requests).toEqual([
      { decisionId: UPLOAD.decision, option: "chunk", expectedVersion: null },
    ]);
    expect(text()).toContain("Recorded as version 1.");
  });

  it("sends one request when the form is submitted twice before it re-renders", async () => {
    const settled: { resolve: (outcome: RecordDecisionOutcome) => void } = { resolve: () => {} };
    const { requests, actions } = recorder(
      () =>
        new Promise((resolve) => {
          settled.resolve = resolve;
        }),
    );
    await render(asked(), actions);
    await choose("Reject them");
    const form = container.querySelector("form");
    if (form === null) throw new Error("no answer form");
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(requests).toHaveLength(1);

    await act(async () => settled.resolve({ ok: true, version: 1 }));
    expect(text()).toContain("Recorded as version 1.");
  });

  it("refuses to submit without an option, and a replacement that repeats the answer", async () => {
    const { requests, actions } = recorder(async () => ({ ok: true, version: 2 }));
    await render(asked(), actions);
    await submit("Record answer");
    expect(text()).toContain("Choose an option.");
    expect(requests).toEqual([]);

    await render(answered(), actions);
    await choose("Reject them");
    await submit("Replace answer");
    expect(text()).toContain("This is already the current answer.");
    expect(requests).toEqual([]);

    await choose("Upload them in chunks");
    await submit("Replace answer");
    expect(requests).toEqual([
      { decisionId: UPLOAD.decision, option: "chunk", expectedVersion: 1 },
    ]);
  });

  it("shows a refused or failed request and keeps the chosen option for a retry", async () => {
    let fail = refused;
    const { requests, actions } = recorder(() => fail());
    await render(answered(), actions);
    await choose("Upload them in chunks");
    await submit("Replace answer");

    expect(text()).toContain("The answer changed since this board loaded.");
    expect(button("Replace answer").disabled).toBe(false);
    const chosen = container.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    expect(chosen?.value).toBe("chunk");

    fail = broken;
    await submit("Replace answer");
    expect(text()).toContain("The answer was not confirmed as recorded.");
    expect(text()).not.toContain("socket closed");
    expect(requests).toHaveLength(2);
  });

  it("blocks the action visibly when the page has no way to record it", async () => {
    await render(asked(), { kind: "unavailable", reason: "no_passkey" });

    expect(button("Record answer").disabled).toBe(true);
    expect(text()).toContain("Answering needs the owner's passkey");
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(2);
    for (const radio of radios) expect(radio.disabled).toBe(true);
  });

  it("blocks the action on a board with missing events, even with a callback", async () => {
    const { requests, actions } = recorder(async () => ({ ok: true, version: 2 }));
    const lost = seqWhere(decisionReversal, (event) => event.type === "inbox.acked");
    const behind = fold(withLostEvents(decisionReversal, [lost]));
    expect(behind.stream.kind).toBe("gap");
    await render(behind, actions);

    expect(button("Replace answer").disabled).toBe(true);
    expect(text()).toContain("Answering is blocked while the board catches up");
    await submit("Replace answer");
    expect(requests).toEqual([]);
  });

  describe("when the action is withdrawn mid-request", () => {
    it("aborts an answer not yet sent and drops its late outcome", async () => {
      const { actions, call } = held();
      await render(answered(), actions);
      await choose("Upload them in chunks");
      await submit("Replace answer");
      expect(text()).toContain("Recording…");

      await render(answered(), { kind: "unavailable", reason: "offline" });

      expect(call().control.signal.aborted).toBe(true);
      expect(text()).toContain("before the answer was sent. Nothing was recorded.");
      await act(async () => call().settle({ ok: true, version: 9 }));
      expect(text()).not.toContain("Recorded as version 9");
      expect(text()).toContain("Nothing was recorded.");
    });

    it("says an answer already sent may have been recorded, and drops its late outcome", async () => {
      const { actions, call } = held();
      await render(answered(), actions);
      await choose("Upload them in chunks");
      await submit("Replace answer");
      call().control.onSent();

      const lost = seqWhere(decisionReversal, (event) => event.type === "inbox.acked");
      await render(fold(withLostEvents(decisionReversal, [lost])), actions);

      expect(call().control.signal.aborted).toBe(true);
      expect(text()).toContain("after the answer was sent. Check the decision's history");
      await act(async () => call().settle({ ok: false, message: "late refusal" }));
      expect(text()).not.toContain("late refusal");
    });

    it("drops a replaced session's outcome and answers through the new one", async () => {
      const first = held();
      await render(answered(), first.actions);
      await choose("Upload them in chunks");
      await submit("Replace answer");
      first.call().control.onSent();

      const second = recorder(async () => ({ ok: true, version: 3 }));
      await render(answered(), second.actions);
      await act(async () => first.call().settle({ ok: true, version: 2 }));

      expect(first.call().control.signal.aborted).toBe(true);
      expect(text()).not.toContain("Recorded as version 2");
      await submit("Replace answer");
      expect(second.requests).toHaveLength(1);
      expect(text()).toContain("Recorded as version 3.");
    });
  });

  it("counts both claims of a parked train conflict before the answer", async () => {
    await render(fold(parkedConflict.events), { kind: "unavailable", reason: "offline" });
    const waiting = container.querySelector('section[aria-label="Waiting for an answer"]');
    // The conflict holds up both claims, so it leads the queue ahead of atlas's own question.
    expect(waiting?.textContent).toMatch(
      new RegExp(`${CONFLICT.decision}Affects 2 claims.*${UPLOAD.decision}Affects 1 claim`),
    );
  });

  it("renders question and option text inertly", async () => {
    const hostile = '<img src="x" onerror="globalThis.pwned = true"><b>bold</b>';
    const log = syntheticLog("Synthetic hostile question", [
      ...uploadPrelude().slice(0, -1),
      {
        type: "question.asked",
        actor: { kind: "agent", id: UPLOAD.atlas },
        data: {
          questionId: UPLOAD.question,
          claimId: UPLOAD.atlasClaim,
          decisionId: UPLOAD.decision,
          text: hostile,
          options: [
            { key: "reject", label: hostile },
            { key: "chunk", label: "Upload them in chunks" },
          ],
        },
      },
    ]);
    await render(fold(log.events), { kind: "unavailable", reason: "offline" });

    expect(text()).toContain(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("shows each agent's delivery and drops adapted when the decision is superseded", async () => {
    const beforeReversal = fold(
      decisionReversal.events.slice(0, seqWhere(decisionReversal, isReversal) - 1),
    );
    await render(beforeReversal, { kind: "unavailable", reason: "offline" });
    expect(text()).toContain("Who has version 1");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(text()).toContain("Adapted");

    const birchQueued = seqWhere(
      decisionReversal,
      (event) => event.type === "claim.refused" && event.data.claimId === UPLOAD.birchClaim,
    );
    await render(fold(decisionReversal.events.slice(0, birchQueued)), {
      kind: "unavailable",
      reason: "offline",
    });
    expect(text()).toContain("Who has version 2");
    const rows = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(rows).toEqual(["atlasQueuedNot yet", "birchQueuedNot yet"]);
    expect(text()).toContain("Reject them");
    expect(text()).toContain("replaced");

    await render(fold(decisionReversal.events), { kind: "unavailable", reason: "offline" });
    const final = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(final).toEqual(["atlasAcknowledgedAdapted", "birchQueuedNot yet"]);
  });

  it("invites questions when there are none", async () => {
    await render(emptyBoardState(SYNTH_REPO), { kind: "unavailable", reason: "offline" });
    expect(text()).toContain("No questions yet");
    expect(container.querySelector("button")).toBeNull();
  });
});
