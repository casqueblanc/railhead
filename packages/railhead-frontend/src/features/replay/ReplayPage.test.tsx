import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import {
  CAPTURE_FORMAT,
  CAPTURE_VERSION,
  MAX_CAPTURE_BYTES,
  serializeCapture,
  type Capture,
} from "./captureFile";
import { PLAYBACK_STEP_MS } from "./ReplayBoard";
import { ReplayPage } from "./ReplayPage";
import { SYNTHETIC_REPLAYS, syntheticCapture } from "./syntheticReplays";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const synthetic = syntheticCapture(decisionReversal);
const captured: Capture = {
  ...synthetic,
  source: {
    kind: "captured",
    origin: "https://railhead.example",
    org: "demo",
    name: "upload-app",
    capturedAt: Date.UTC(2026, 9, 5, 12, 30),
  },
};
const fileOf = (capture: Capture): File => {
  const serialized = serializeCapture(capture);
  if (!serialized.ok) throw new Error("serialize failed");
  return new File([serialized.text], "run.json", { type: "application/json" });
};

describe("ReplayPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  const network = vi.fn<(what: string) => void>();

  const text = () => container.textContent ?? "";
  const button = (name: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };
  const position = (): string => {
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]');
    if (slider === null) throw new Error("no playback slider");
    return slider.value;
  };
  const choose = async (file: File) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // `File.text()` settles on a later task.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const click = async (name: string) => {
    await act(async () => button(name).click());
  };

  beforeEach(() => {
    network.mockReset();
    // The replay must work with the network off: any attempt to reach it is recorded and fails.
    vi.stubGlobal("fetch", async () => {
      network("fetch");
      throw new TypeError("network disabled");
    });
    vi.stubGlobal("WebSocket", function WebSocket() {
      network("websocket");
      throw new TypeError("network disabled");
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const claimTitle = "Replay of a file that claims to be a captured log. This board is not live.";

  it("replays a captured file offline to its final board, labelled as a replay", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    await choose(fileOf(captured));

    expect(text()).toContain(claimTitle);
    expect(text()).toContain(
      `The file says it was captured from https://railhead.example, repository demo/upload-app, at 2026-10-05 12:30:00 UTC, with head at event ${captured.head}.`,
    );
    expect(text()).toContain(
      "The board cannot verify where a file came from, so confirm how you got it before treating it as a real run.",
    );
    expect(text()).not.toMatch(/\bverified\b/i);
    expect(position()).toBe(String(captured.head));
    // The final board's sections, from the fold of every event.
    expect(text()).toContain("Decided");
    expect(text()).not.toContain("Synthetic replay");
    expect(network).not.toHaveBeenCalled();
  });

  it("steps through the log and plays to the end", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      if (input === null) throw new Error("no file input");
      Object.defineProperty(input, "files", { value: [fileOf(captured)] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.runAllTimersAsync();
    });

    await click("Start");
    expect(position()).toBe("0");
    expect(text()).toContain("No questions yet");
    await click("Forward one event");
    expect(position()).toBe("1");

    await click("Play");
    await act(async () => vi.advanceTimersByTime(PLAYBACK_STEP_MS * 3));
    expect(position()).toBe("4");
    await act(async () => vi.advanceTimersByTime(PLAYBACK_STEP_MS * captured.head));
    expect(position()).toBe(String(captured.head));
    expect(button("Play from start").disabled).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });

  it("labels a synthetic log as synthetic, never as a captured run", async () => {
    await act(async () =>
      root.render(<ReplayPage loadSynthetic={async () => SYNTHETIC_REPLAYS} />),
    );
    await click("Show synthetic logs");
    await click(decisionReversal.description);

    expect(text()).toContain("Synthetic replay. Not a captured run.");
    expect(text()).toContain(
      `${decisionReversal.description}. Built from hand-written development fixtures: no agent did this work.`,
    );
    expect(text()).not.toContain("captured log");
    expect(network).not.toHaveBeenCalled();
  });

  it("shows a synthetic file edited to say captured as a claim, never as a verified run", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    const serialized = serializeCapture(synthetic);
    if (!serialized.ok) throw new Error("serialize failed");
    // What a person can do with a text editor: swap the source and keep the fixture's events.
    const edited: unknown = JSON.parse(serialized.text);
    if (typeof edited !== "object" || edited === null) throw new Error("capture is not an object");
    const forged = JSON.stringify({
      ...edited,
      source: {
        kind: "captured",
        origin: "https://railhead.example",
        org: "demo",
        name: "upload-app",
        capturedAt: Date.UTC(2026, 9, 5, 12, 30),
      },
    });
    await choose(new File([forged], "run.json", { type: "application/json" }));

    expect(text()).toContain(claimTitle);
    expect(text()).toContain("The board cannot verify where a file came from");
    expect(text()).not.toMatch(/\bverified\b/i);
    expect(text()).not.toContain("Synthetic replay");
    expect(position()).toBe(String(synthetic.head));
    expect(network).not.toHaveBeenCalled();
  });

  it("offers no synthetic logs in a production build", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    expect(text()).not.toContain("Synthetic logs");
  });

  it("refuses a file with a gap and shows no board", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    const gapped = { ...captured, events: captured.events.filter((event) => event.seq !== 7) };
    await choose(fileOf(gapped));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The capture is missing event 7, so it cannot be replayed.",
    );
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it("refuses a malformed file", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    await choose(new File(['{"format":"railhead.replay","version":1,"events":[{}]}'], "bad.json"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The capture is malformed at events[0].v.",
    );
  });

  it("refuses an oversized file without reading it", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    const file = fileOf(captured);
    const read = vi.spyOn(file, "text");
    Object.defineProperty(file, "size", { value: MAX_CAPTURE_BYTES + 1 });
    await choose(file);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The capture is larger than this board replays",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("opens the newest file when an earlier read finishes last", async () => {
    await act(async () => root.render(<ReplayPage loadSynthetic={null} />));
    const slowRead: { resolve?: (text: string) => void } = {};
    const slow = new File(["{}"], "slow.json");
    vi.spyOn(slow, "text").mockReturnValue(
      new Promise((resolve) => {
        slowRead.resolve = resolve;
      }),
    );
    const other: Capture = {
      format: CAPTURE_FORMAT,
      version: CAPTURE_VERSION,
      source: captured.source,
      repo: captured.repo,
      head: 3,
      events: captured.events.slice(0, 3),
    };
    await choose(slow);
    await choose(fileOf(other));
    const serialized = serializeCapture(captured);
    await act(async () => slowRead.resolve?.(serialized.ok ? serialized.text : ""));

    expect(position()).toBe("3");
  });
});
