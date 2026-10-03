import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNTH_REPO } from "../../../../../fixtures/board/syntheticLog";
import { emptyBoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { AppPanel } from "./AppPanel";
import type { AppLocation } from "./appRevision";
import { REVISION_POLL_MS } from "./useAppRevision";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAIN = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";
const APP: AppLocation = { kind: "configured", origin: "https://upload.example.dev" };

const feedAt = (main: string | null, connection: "live" | "lost" = "live"): BoardFeed => ({
  kind: "board",
  board: { ...emptyBoardState(SYNTH_REPO), main },
  connection,
  recovered: false,
});

/** A stand-in app whose answer the test changes between reads. */
const fakeApp = (answer: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>(async () => answer());

describe("AppPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (
    feed: BoardFeed,
    fetchRevision: typeof fetch,
    location: AppLocation = APP,
  ) => {
    await act(async () =>
      root.render(<AppPanel feed={feed} location={location} fetchRevision={fetchRevision} />),
    );
  };
  const text = () => container.textContent ?? "";
  const iframe = () => container.querySelector("iframe");
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows the app as running main when the deployed commit is main", async () => {
    await render(
      feedAt(MAIN),
      fakeApp(() => Response.json({ revision: MAIN })),
    );

    expect(text()).toContain("Running main");
    expect(text()).not.toContain("Stale deployment");
    expect(container.querySelectorAll(`[title="${MAIN}"]`)).toHaveLength(2);
    expect(iframe()?.getAttribute("src")).toBe("https://upload.example.dev");
  });

  it("embeds the app in an opaque-origin sandbox that cannot reach the board", async () => {
    await render(
      feedAt(MAIN),
      fakeApp(() => Response.json({ revision: MAIN })),
    );

    const frame = iframe();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const tokens = frame?.getAttribute("sandbox")?.split(/\s+/) ?? [];
    const forbidden = [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-top-navigation-to-custom-protocols",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-modals",
      "allow-downloads",
    ];
    expect(tokens.filter((token) => forbidden.includes(token))).toEqual([]);
    expect(frame?.hasAttribute("allow")).toBe(false);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("marks an older deployment stale and names both commits", async () => {
    await render(
      feedAt(MAIN),
      fakeApp(() => Response.json({ revision: OLD })),
    );

    expect(text()).toContain("Stale deployment");
    expect(text()).toContain("The app runs fedcba9, but main is 0123456.");
    expect(text()).not.toContain("Running main");
    expect(container.querySelector(`[title="${OLD}"]`)).not.toBeNull();
    expect(container.querySelector(`[title="${MAIN}"]`)).not.toBeNull();
  });

  it("turns stale when main moves past the deployment, and current after a redeploy", async () => {
    let deployed = OLD;
    const fetchRevision = fakeApp(() => Response.json({ revision: deployed }));
    await render(feedAt(OLD), fetchRevision);
    expect(text()).toContain("Running main");

    await render(feedAt(MAIN), fetchRevision);
    expect(text()).toContain("Stale deployment");

    deployed = MAIN;
    await act(async () => button("Check again")?.click());
    expect(text()).toContain("Running main");
    expect(fetchRevision).toHaveBeenCalledTimes(3);
  });

  it("reads the revision again on its own, so a redeploy shows without a reload", async () => {
    vi.useFakeTimers();
    let deployed = OLD;
    const fetchRevision = fakeApp(() => Response.json({ revision: deployed }));
    await render(feedAt(MAIN), fetchRevision);
    expect(text()).toContain("Stale deployment");

    deployed = MAIN;
    await act(async () => vi.advanceTimersByTimeAsync(REVISION_POLL_MS));
    expect(text()).toContain("Running main");
  });

  it("never calls an app without a reported commit current", async () => {
    await render(
      feedAt(MAIN),
      fakeApp(() => Response.json({ revision: "unknown" })),
    );
    expect(text()).toContain("Revision not reported");
    expect(text()).not.toContain("Running main");
  });

  it("waits for main before comparing", async () => {
    await render(
      feedAt(null),
      fakeApp(() => Response.json({ revision: OLD })),
    );
    expect(text()).toContain("Main not read yet");
    expect(text()).not.toContain("Stale deployment");
    expect(text()).not.toContain("Running main");
  });

  it("says when main may be out of date because the board is not live", async () => {
    await render(
      feedAt(MAIN, "lost"),
      fakeApp(() => Response.json({ revision: MAIN })),
    );
    expect(text()).toContain("The board is not live, so main may have moved");
  });

  it("reports an unreachable app, hides the embed and recovers on Check again", async () => {
    let up = false;
    const fetchRevision = fakeApp(() =>
      up ? Response.json({ revision: MAIN }) : Promise.reject(new TypeError("Failed to fetch")),
    );
    await render(feedAt(MAIN), fetchRevision);
    expect(text()).toContain("App unreachable");
    expect(iframe()).toBeNull();

    up = true;
    await act(async () => button("Check again")?.click());
    expect(text()).toContain("Running main");
    expect(iframe()).not.toBeNull();
  });

  it("explains a board built without an app URL and contacts nothing", async () => {
    const fetchRevision = fakeApp(() => Response.json({ revision: MAIN }));
    await render(feedAt(MAIN), fetchRevision, { kind: "unconfigured" });
    expect(text()).toContain("No app configured");
    await render(feedAt(MAIN), fetchRevision, { kind: "invalid" });
    expect(text()).toContain("The app URL is not valid");
    expect(fetchRevision).not.toHaveBeenCalled();
    expect(iframe()).toBeNull();
  });
});
