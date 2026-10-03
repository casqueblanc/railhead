import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import {
  SYNTH_OWNER,
  SYNTH_REPO,
  SYNTH_START_MS,
  seqWhere,
  synthCommit,
  syntheticLog,
} from "../../../../../fixtures/board/syntheticLog";
import {
  UPLOAD,
  UPLOAD_BASE,
  checkResult,
  enrol,
  intend,
  moveMain,
  push,
  ready,
} from "../../../../../fixtures/board/uploadSteps";
import type { CheckDetailPort } from "../board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { OUTCOME_BADGE } from "./OutcomeBadge";
import { TrainOutcomes } from "./TrainOutcomes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_CHECKS: CheckDetailPort = { kind: "unavailable", reason: "module_unavailable" };

const complete = foldEvents(emptyBoardState(SYNTH_REPO), checkBeforeLand.events);
const live = (board: BoardState): BoardFeed => ({
  kind: "board",
  board,
  connection: "live",
  recovered: false,
});

/** Every outcome at once: the log's three, a pending intent and a read-back that missed. */
const everyOutcome = (): BoardState => {
  const cut = seqWhere(
    checkBeforeLand,
    (e) => e.type === "train.main" && e.data.intentId === "int_synth12",
  );
  let state = foldEvents(emptyBoardState(SYNTH_REPO), checkBeforeLand.events.slice(0, cut - 1));
  const steps = [
    moveMain("int_synth12", "reconciled", synthCommit(7)),
    checkResult("chk_synth14", synthCommit(9), "test", "pass"),
    intend("int_synth14", synthCommit(7), synthCommit(9), [UPLOAD.atlasClaim], [], "chk_synth14"),
  ];
  for (const step of steps) {
    state = foldEvents(state, [
      { v: 1, seq: state.cursor + 1, at: SYNTH_START_MS, repo: SYNTH_REPO, ...step },
    ]);
  }
  return state;
};

describe("TrainOutcomes", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRetry = vi.fn<() => void>();

  const render = async (feed: BoardFeed) => {
    await act(async () =>
      root.render(<TrainOutcomes feed={feed} checks={NO_CHECKS} onRetry={onRetry} />),
    );
  };
  const items = () => [...container.querySelectorAll("li[aria-labelledby^='run-']")];
  const text = () => container.textContent ?? "";

  beforeEach(() => {
    onRetry.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the log's outcomes newest first with the main each one saw", async () => {
    await render(live(complete));

    const [readBack, moved, landed] = items();
    expect(readBack?.textContent).toContain("Landed after read-back");
    expect(readBack?.textContent).toContain("The push result was uncertain.");
    expect(moved?.textContent).toContain("Not landed: main moved");
    expect(moved?.textContent).toContain("so nothing changed.");
    expect(moved?.querySelector(`[title="${synthCommit(7)}"]`)).not.toBeNull();
    expect(moved?.querySelector(`[title="${UPLOAD_BASE}"]`)).not.toBeNull();
    expect(moved?.textContent).toContain("Checks 2 passed on");
    expect(moved?.textContent).toContain("Authorised against dec_synthsize version 1.");
    expect(landed?.textContent).toContain("Landed");
    expect(landed?.textContent).toContain("Show upload limits");
    expect(text()).toContain("3 merges");
  });

  it("gives every outcome a distinct text badge, not colour alone", async () => {
    await render(live(everyOutcome()));

    const badges = items().map((item) => item.querySelector("h3")?.nextElementSibling?.textContent);
    expect(badges).toEqual([
      "Merging",
      "Not landed after read-back",
      "Not landed: main moved",
      "Landed",
    ]);
    const labels = Object.values(OUTCOME_BADGE).map((badge) => badge.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const svg of container.querySelectorAll("li svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("shows a loading state and then an empty board", async () => {
    await render({ kind: "loading" });
    expect(text()).toContain("Loading train outcomes…");
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");

    await render(live(emptyBoardState(SYNTH_REPO)));
    expect(text()).toContain("Nothing merged yet");
    expect(items()).toHaveLength(0);
  });

  it("offers a retry when the board failed to load", async () => {
    await render({ kind: "failed" });
    expect(text()).toContain("Train outcomes did not load");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    retry?.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders issue titles in a merge as inert text", async () => {
    const markup = `<script>globalThis.pwned=1</script><b onmouseover="x">bold</b>`;
    const board = foldEvents(
      emptyBoardState(SYNTH_REPO),
      syntheticLog("Synthetic markup in a merged issue title", [
        ...enrol(UPLOAD.atlas, "atlas", "inv_synthatlas"),
        {
          type: "issue.filed",
          actor: SYNTH_OWNER,
          data: { issueId: UPLOAD.uploadIssue, title: markup, body: "" },
        },
        {
          type: "claim.opened",
          actor: { kind: "agent", id: UPLOAD.atlas },
          data: {
            claimId: UPLOAD.atlasClaim,
            issueId: UPLOAD.uploadIssue,
            agentId: UPLOAD.atlas,
            generation: 1,
            base: UPLOAD_BASE,
          },
        },
        push(UPLOAD.atlas, UPLOAD.atlasClaim, null, synthCommit(1)),
        ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), []),
        checkResult("chk_synthmark", synthCommit(2), "test", "pass"),
        intend(
          "int_synthmark",
          UPLOAD_BASE,
          synthCommit(2),
          [UPLOAD.atlasClaim],
          [],
          "chk_synthmark",
        ),
      ]).events,
    );
    expect(board.stream).toEqual({ kind: "consistent" });
    await render(live(board));

    expect(container.querySelector("h3")?.textContent).toBe(markup);
    expect(container.querySelector("script, b")).toBeNull();
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("keeps the outcomes it has when the fold halted and offers a reload", async () => {
    const halted: BoardState = {
      ...complete,
      stream: { kind: "halted", fault: { kind: "unsupported_version", seq: 46, version: 2 } },
    };
    await render(live(halted));

    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Board stopped at event 46");
    expect(alert?.textContent).toContain("schema version 2");
    expect(items()).toHaveLength(3);
    const reload = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload board",
    );
    await act(async () => reload?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
