import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import { SYNTH_REPO, syntheticLog } from "../../../../../fixtures/board/syntheticLog";
import { uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import type { BoardPorts, FeatureEntry, OwnerSlotProps } from "../../features/board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../../features/board/boardState";
import type { BoardFeed } from "../../features/claims/boardFeed";
import { HomePage } from "./HomePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The enrollment slot's entry is swapped per test to exercise an installed feature.
const slot = vi.hoisted(() => ({
  enrollment: { kind: "unavailable" } as FeatureEntry<OwnerSlotProps>,
}));
vi.mock("../../features/enrollment/entry", () => ({
  get enrollmentEntry() {
    return slot.enrollment;
  },
}));

const reversal = foldEvents(emptyBoardState(SYNTH_REPO), decisionReversal.events);
const openQuestion = foldEvents(
  emptyBoardState(SYNTH_REPO),
  syntheticLog("Synthetic open question", uploadPrelude()).events,
);
const feedOf = (board: BoardState, connection: "live" | "lost" = "live"): BoardFeed => ({
  kind: "board",
  board,
  connection,
  recovered: false,
});

const recorded: unknown[] = [];
const onReconnect = vi.fn<() => void>();

const ports = (overrides: Partial<BoardPorts> = {}): BoardPorts => ({
  connection: "connected",
  onReconnect,
  board: { kind: "available", feed: feedOf(reversal) },
  decisions: {
    kind: "available",
    onRecordDecision: (request) => {
      recorded.push(request);
      return Promise.resolve({ ok: true, version: 1 });
    },
  },
  owner: {
    kind: "available",
    onPrepareAction: () => Promise.reject(new Error("no owner action in this test")),
    onPerformAction: () => Promise.reject(new Error("no owner action in this test")),
  },
  enrollment: {
    kind: "available",
    onPrepareEnrollment: () => Promise.reject(new Error("no enrollment in this test")),
    onCompleteEnrollment: () => Promise.reject(new Error("no enrollment in this test")),
  },
  ...overrides,
});

describe("HomePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (value: BoardPorts) => {
    await act(async () => root.render(<HomePage ports={value} />));
  };
  const text = () => container.textContent ?? "";
  /** The headings that name a section, as opposed to the states inside one. */
  const sectionHeadings = () =>
    [...container.querySelectorAll("h2 span[id]")].map((h) => h.textContent?.trim());
  const button = (name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };

  beforeEach(() => {
    recorded.length = 0;
    onReconnect.mockReset();
    slot.enrollment = { kind: "unavailable" };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("composes the fixture board with every section and a link to each", async () => {
    await render(ports());

    expect(text()).toContain("Decided");
    expect(sectionHeadings()).toEqual([
      "Claims",
      "Train",
      "Agents",
      "Issues",
      "Demo app",
      "Totals",
      "Phone",
    ]);
    expect(text()).toContain("Show upload limits");
    const links = [...container.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
    for (const href of links) expect(container.querySelector(href ?? "")).not.toBeNull();
    expect(links).toHaveLength(8);
  });

  it("shows an unavailable state in every slot whose feature is not installed", async () => {
    await render(ports());

    expect(text().match(/Not available\./g)).toHaveLength(5);
    expect(text()).toContain("This board cannot invite, confirm or revoke agents yet.");
  });

  it("renders an installed feature in its slot with only the ports it names", async () => {
    const received: OwnerSlotProps[] = [];
    slot.enrollment = {
      kind: "available",
      Component: (props) => {
        received.push(props);
        return <p>Enrollment installed</p>;
      },
    };
    await render(ports({ connection: "lost" }));

    expect(text()).toContain("Enrollment installed");
    expect(text().match(/Not available\./g)).toHaveLength(4);
    const last = received.at(-1);
    expect(last && Object.keys(last).toSorted()).toEqual(["enrollment", "feed", "owner"]);
    expect(last?.owner).toEqual({ kind: "unavailable", reason: "offline" });
    expect(last?.enrollment).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("hands the enrollment slot the binding's enrollment callbacks while connected", async () => {
    const received: OwnerSlotProps[] = [];
    slot.enrollment = {
      kind: "available",
      Component: (props) => {
        received.push(props);
        return <p>Enrollment installed</p>;
      },
    };
    const value = ports();
    await render(value);

    expect(received.at(-1)?.enrollment).toBe(value.enrollment);
  });

  it("passes an unavailable enrollment through with its reason", async () => {
    const received: OwnerSlotProps[] = [];
    slot.enrollment = {
      kind: "available",
      Component: (props) => {
        received.push(props);
        return <p>Enrollment installed</p>;
      },
    };
    await render(ports({ enrollment: { kind: "unavailable", reason: "module_unavailable" } }));

    expect(received.at(-1)?.enrollment).toEqual({
      kind: "unavailable",
      reason: "module_unavailable",
    });
  });

  it("says enrollment is unavailable when neither the feature nor the backend serves it", async () => {
    await render(ports({ enrollment: { kind: "unavailable", reason: "module_unavailable" } }));

    expect(text()).toContain(
      "Not available. This board cannot invite, confirm or revoke agents yet.",
    );
  });

  it("blocks answering while the board's feed is lost and records nothing", async () => {
    await render(ports({ board: { kind: "available", feed: feedOf(openQuestion, "lost") } }));

    expect(text()).toContain("Answering is blocked while the board is offline.");
    expect(button("Record answer").disabled).toBe(true);
    expect(recorded).toEqual([]);
  });

  it("shows a retained board as disconnected when only the session is lost, then recovers", async () => {
    const live = ports({ board: { kind: "available", feed: feedOf(openQuestion) } });
    await render(live);
    expect(text()).not.toContain("Disconnected");
    expect(button("Record answer").disabled).toBe(false);

    await render({ ...live, connection: "lost" });

    expect(text().match(/Disconnected/g)).toHaveLength(2);
    expect(text()).toContain("Answering is blocked while the board is offline.");
    expect(button("Record answer").disabled).toBe(true);
    await act(async () => button("Reconnect").click());
    expect(onReconnect).toHaveBeenCalledTimes(1);

    await render(live);

    expect(text()).not.toContain("Disconnected");
    expect(button("Record answer").disabled).toBe(false);
    expect(recorded).toEqual([]);
  });

  it("offers a retry instead of loading forever when the session is lost", async () => {
    await render(
      ports({ connection: "lost", board: { kind: "available", feed: { kind: "loading" } } }),
    );

    expect(text()).toContain("Questions did not load");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => button("Try again").click());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("offers a retry in each section when the board fails to load", async () => {
    await render(ports({ board: { kind: "available", feed: { kind: "failed" } } }));

    expect(text()).toContain("Questions did not load");
    expect(text()).toContain("Claims did not load");
    await act(async () => button("Try again").click());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["connecting", "Connecting to the backend…"],
    ["connected", "No board on this Railhead yet"],
    ["lost", "Connection to the backend lost"],
  ] as const)("says why there is no board while %s", async (connection, title) => {
    await render(ports({ connection, board: { kind: "unavailable" } }));

    expect(text()).toContain(title);
    expect(container.querySelector("nav")).toBeNull();
    expect(text()).not.toContain("Not available.");
  });

  it("reconnects from the lost state", async () => {
    await render(ports({ connection: "lost", board: { kind: "unavailable" } }));

    await act(async () => button("Reconnect").click());

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
