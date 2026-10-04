import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import {
  SYNTH_OWNER,
  SYNTH_REPO,
  syntheticLog,
  withLostEvents,
} from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, enrol } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type { BoardFeed } from "./boardFeed";
import { ClaimLanes } from "./ClaimLanes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const complete = foldEvents(emptyBoardState(SYNTH_REPO), decisionReversal.events);
const live = (board: BoardState): BoardFeed => ({
  kind: "board",
  board,
  connection: "live",
  recovered: false,
});

describe("ClaimLanes", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRetry = vi.fn<() => void>();

  const render = async (feed: BoardFeed) => {
    await act(async () => root.render(<ClaimLanes feed={feed} onRetry={onRetry} />));
  };
  const button = (name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };
  const headings = () => [...container.querySelectorAll("h3")].map((h) => h.textContent);
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

  it("renders the fold's lanes, the refused one first with its reason and pending decision", async () => {
    await render(live(complete));

    expect(headings()).toEqual(["Show upload limits", "Accept large uploads"]);
    const [birch, atlas] = container.querySelectorAll("section > * li[aria-labelledby]");
    expect(birch?.textContent).toContain("Refused");
    expect(birch?.textContent).toContain(
      "Refused: a decision affecting the claim is not acknowledged yet.",
    );
    expect(birch?.textContent).toContain("Decision dec_synthsize version 2");
    expect(atlas?.textContent).toContain("Landed");
    expect(atlas?.textContent).not.toContain("Waiting for the agent to acknowledge");
    expect(text()).toContain("2 claims");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("shows a loading state without lanes or actions", async () => {
    await render({ kind: "loading" });

    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(text()).toContain("Loading claims…");
    expect(container.querySelector("li")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("offers a retry when the board failed to load", async () => {
    await render({ kind: "failed" });

    expect(text()).toContain("Claims did not load");
    const retry = button("Try again");
    retry.focus();
    expect(document.activeElement).toBe(retry);
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says when there are no claims", async () => {
    await render(live(emptyBoardState(SYNTH_REPO)));

    expect(text()).toContain("No claims yet");
    expect(container.querySelector("ul")).toBeNull();
  });

  it("renders agent text as inert text", async () => {
    const markup = `<img src=x onerror="globalThis.pwned=1"><a href="javascript:void 0">go</a>`;
    const board = foldEvents(
      emptyBoardState(SYNTH_REPO),
      syntheticLog("Synthetic markup in an issue title", [
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
            base: "5e".padEnd(40, "0"),
          },
        },
      ]).events,
    );
    expect(board.stream).toEqual({ kind: "consistent" });
    await render(live(board));

    expect(headings()).toEqual([markup]);
    expect(container.querySelector("img, a, script")).toBeNull();
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("opens a lane's push history from a keyboard-reachable button", async () => {
    await render(live(complete));

    const trigger = button("3 recent pushes");
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("refs/heads/work");
  });

  it("keeps showing lanes and offers a reload when the fold halted", async () => {
    const halted: BoardState = {
      ...complete,
      stream: {
        kind: "halted",
        fault: {
          kind: "inconsistent",
          seq: 46,
          message: "intent int_synth02 already has an outcome",
        },
      },
    };
    await render(live(halted));

    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Board stopped at event 46");
    expect(alert?.textContent).toContain("Showing the board through event 45");
    expect(headings()).toHaveLength(2);
    await act(async () => button("Reload board").click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("names the missing events while the board is behind the log", async () => {
    const gapped = foldEvents(emptyBoardState(SYNTH_REPO), withLostEvents(decisionReversal, [30]));
    await render(live(gapped));

    expect(text()).toContain("Waiting for events 30–45");
    expect(text()).toContain("Showing the board through event 29");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("offers to reconnect when the connection is lost, then reports recovery", async () => {
    await render({ kind: "board", board: complete, connection: "lost", recovered: false });
    expect(text()).toContain("Disconnected");
    await act(async () => button("Reconnect").click());
    expect(onRetry).toHaveBeenCalledOnce();

    await render({ kind: "board", board: complete, connection: "live", recovered: true });
    expect(text()).not.toContain("Disconnected");
    expect(text()).toContain("Back in sync");
    expect(text()).toContain("Caught up through event 45");
  });
});
