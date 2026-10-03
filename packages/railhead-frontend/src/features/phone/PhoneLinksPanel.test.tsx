import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  SYNTH_GATEWAY,
  SYNTH_OWNER,
  SYNTH_REPO,
  syntheticLog,
} from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, decide, uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { PhoneLinksPanel } from "./PhoneLinksPanel";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

const duneJoins = [
  { type: "agent.invited", actor: SYNTH_OWNER, data: { inviteId: "inv_synthdune", name: "dune" } },
  {
    type: "agent.joined",
    actor: SYNTH_GATEWAY,
    data: {
      agentId: "agt_synthdune",
      inviteId: "inv_synthdune",
      name: "dune",
      keyFingerprint: `SHA256:${"D".repeat(43)}`,
    },
  },
] as const;

/** Atlas's question is open and dune waits for confirmation; atlas and birch are confirmed. */
const pending = () =>
  fold(syntheticLog("Synthetic phone links", [...uploadPrelude(), ...duneJoins]).events);

/** The question is answered and nobody waits for confirmation. */
const settled = () =>
  fold(syntheticLog("Synthetic settled", [...uploadPrelude(), decide(1, "reject")]).events);

const live = (board: BoardState): BoardFeed => ({
  kind: "board",
  board,
  connection: "live",
  recovered: false,
});

const REVIEWED = "https://railhead.dev";
const QUESTION_HREF = `https://railhead.dev/question?decision=${UPLOAD.decision}`;
const CONFIRM_HREF = "https://railhead.dev/confirm?agent=agt_synthdune";

describe("PhoneLinksPanel", () => {
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

  const render = async (feed: BoardFeed, origin = REVIEWED) => {
    await act(async () => root.render(<PhoneLinksPanel feed={feed} origin={origin} />));
  };

  const text = () => container.textContent ?? "";
  const buttons = () => [...container.querySelectorAll("button")];
  const hrefs = () => [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  const codes = () => [...container.querySelectorAll("svg[role='img']")];

  it("offers a code for each open question and each agent waiting for confirmation", async () => {
    await render(live(pending()));

    expect(text()).toContain("Answer this question");
    expect(text()).toContain("Confirm this agent");
    expect(text()).toContain("dune");
    expect(buttons().map((button) => button.textContent)).toEqual(["Show code", "Show code"]);
    expect(codes()).toHaveLength(0);

    const [questionButton, agentButton] = buttons();
    await act(async () => questionButton?.click());
    expect(questionButton?.getAttribute("aria-expanded")).toBe("true");
    expect(codes().map((svg) => svg.getAttribute("aria-label"))).toEqual([
      "QR code: answer this question",
    ]);
    expect(hrefs()).toEqual([QUESTION_HREF]);

    // One code at a time: showing the agent's hides the question's.
    await act(async () => agentButton?.click());
    expect(hrefs()).toEqual([CONFIRM_HREF]);
    expect(codes()).toHaveLength(1);
  });

  it("draws the code dark on a light quiet zone, starting with the top-left finder", async () => {
    await render(live(pending()));
    await act(async () => buttons()[0]?.click());

    const svg = codes()[0];
    const size = Number(svg?.getAttribute("viewBox")?.split(" ")[2]);
    // Version 1 is 21 modules wide; versions grow by 4; the quiet zone adds 4 on each side.
    expect((size - 8 - 21) % 4).toBe(0);
    const path = svg?.querySelector("path")?.getAttribute("d") ?? "";
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
    expect(path).not.toContain("M0 0h");
    expect(path).not.toContain("M3 4h");
  });

  it("offers nothing once the question is answered and every agent is confirmed", async () => {
    await render(live(settled()));

    expect(text()).toContain("Nothing to open on a phone");
    expect(buttons()).toHaveLength(0);
  });

  it("offers no link when the board is served from an origin that was not reviewed", async () => {
    for (const origin of ["http://localhost:8787", "https://railhead.dev.example.com"]) {
      await render(live(pending()), origin);

      expect(text()).toContain("Phone links open only on https://railhead.dev or");
      expect(buttons()).toHaveLength(0);
      expect(hrefs()).toEqual([]);
      expect(text()).not.toContain("dune");
    }
  });

  it("shows the board's loading and failed states without links", async () => {
    await render({ kind: "loading" });
    expect(text()).toContain("Loading phone links…");
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");

    await render({ kind: "failed" });
    expect(text()).toContain("Phone links did not load");
    expect(hrefs()).toEqual([]);
  });
});
