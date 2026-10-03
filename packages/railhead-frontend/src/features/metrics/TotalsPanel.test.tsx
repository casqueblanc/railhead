import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { SYNTH_REPO } from "../../../../../fixtures/board/syntheticLog";
import { emptyBoardState, foldEvents } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { TotalsPanel } from "./TotalsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const complete = foldEvents(emptyBoardState(SYNTH_REPO), checkBeforeLand.events);

describe("TotalsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (feed: BoardFeed) => {
    await act(async () => root.render(<TotalsPanel feed={feed} />));
  };
  /** Each count as its label and value, in page order. */
  const counts = () =>
    [...container.querySelectorAll("dl > div")].map((entry) => [
      entry.querySelector("dt")?.textContent,
      entry.querySelector("dd")?.textContent,
    ]);
  const text = () => container.textContent ?? "";

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows each raw total, labelled, and the events it was counted from", async () => {
    await render({ kind: "board", board: complete, connection: "live", recovered: false });

    expect(counts()).toEqual([
      ["Questions asked", "1"],
      ["Human actions", "7"],
      ["Checks run", "5"],
      ["Checks failed", "0"],
      ["Checks that could not run", "0"],
      ["Changes landed", "2"],
      ["Active claims", "0"],
      ["Claims opened", "2"],
      ["Checks run", "5"],
      ["Changes landed", "2"],
    ]);
    expect(text()).toContain("In the last minute of the log");
    expect(text()).toContain(`Counted from events 1–${complete.cursor}.`);
    expect(text()).not.toMatch(/%|per minute|rate/i);
  });

  it("says the counts stop where the board does when it is not live", async () => {
    await render({ kind: "board", board: complete, connection: "lost", recovered: false });

    expect(text()).toContain(
      `Counted from events 1–${complete.cursor}, while the board is not live.`,
    );
  });

  it("shows an empty state, not zeros, before the first event", async () => {
    await render({
      kind: "board",
      board: emptyBoardState(SYNTH_REPO),
      connection: "live",
      recovered: false,
    });

    expect(text()).toContain("Nothing counted yet");
    expect(counts()).toEqual([]);
  });

  it("shows loading and a failed load without any count", async () => {
    await render({ kind: "loading" });
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(text()).toContain("Loading totals…");

    await render({ kind: "failed" });
    expect(text()).toContain("Totals did not load");
    expect(counts()).toEqual([]);
  });
});
