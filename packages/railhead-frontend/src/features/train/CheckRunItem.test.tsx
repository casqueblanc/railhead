import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CHECK_DETAIL_LOG_BYTES,
  type BoardResult,
  type CheckDetail,
} from "@railhead/shared/board-api";
import type { RailheadEvent } from "@railhead/shared/events";
import { SYNTH_REPO, synthCommit, syntheticLog } from "../../../../../fixtures/board/syntheticLog";
import { checkResult } from "../../../../../fixtures/board/uploadSteps";
import type { CheckDetailPort } from "../board/boardPorts";
import { emptyBoardState, foldEvents } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { MAX_LISTED_CHECK_RUNS } from "./checkRuns";
import { TrainOutcomes } from "./TrainOutcomes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = "chk_synthfail";
const CANDIDATE = synthCommit(2);

const failingLog = syntheticLog("Synthetic failing check run", [
  checkResult(RUN, CANDIDATE, "test", "fail"),
]).events;

const feedOf = (events: readonly RailheadEvent[]): BoardFeed => {
  const board = foldEvents(emptyBoardState(SYNTH_REPO), events);
  expect(board.stream).toEqual({ kind: "consistent" });
  return { kind: "board", board, connection: "live", recovered: false };
};

const detail = (patch: Partial<CheckDetail> = {}): CheckDetail => ({
  checkRunId: RUN,
  candidate: CANDIDATE,
  expectedMain: synthCommit(0),
  definitionDigest: "ab".repeat(32),
  command: "pnpm install --frozen-lockfile && pnpm test",
  state: {
    kind: "reported",
    result: "fail",
    finishedAt: Date.UTC(2026, 9, 1, 12),
    logTail: "FAIL upload.test.ts\n1 failed",
    logCut: false,
  },
  ...patch,
});

// The full candidate id is rendered text in the row itself, outside the detail panel.
const expectFullCandidate = (item: Element | undefined) => {
  const full = [...(item?.querySelectorAll("span") ?? [])].find(
    (span) => span.textContent === CANDIDATE,
  );
  expect(full).toBeDefined();
  expect(full?.hasAttribute("title")).toBe(false);
  expect(item?.textContent).toContain(`Candidate ${CANDIDATE}`);
};

describe("check runs in the train section", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reads: string[];
  let answers: BoardResult<CheckDetail>[];

  const port = (): CheckDetailPort => ({
    kind: "available",
    onReadCheck: (checkRunId) => {
      reads.push(checkRunId);
      return Promise.resolve(answers.shift() ?? { ok: true, value: detail() });
    },
  });
  // One port for the whole test, as one session hands the page one.
  let checks: CheckDetailPort;

  const render = async (feed: BoardFeed, ports: CheckDetailPort = checks) => {
    await act(async () =>
      root.render(<TrainOutcomes feed={feed} checks={ports} onRetry={() => {}} />),
    );
  };
  const checkItems = () => [...container.querySelectorAll("li[aria-labelledby^='check-']")];
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((found) => found.textContent === label);
  const openDetail = async () => {
    await act(async () => button("Command and output")?.click());
  };
  const text = () => container.textContent ?? "";

  beforeEach(() => {
    reads = [];
    answers = [];
    checks = port();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists a failed run that never reached a merge, and reads nothing until opened", async () => {
    await render(feedOf(failingLog));

    const [item] = checkItems();
    expect(checkItems()).toHaveLength(1);
    expect(container.querySelector("h3")?.textContent).toBe("Reported check runs");
    expect(item?.textContent).toContain("Failed");
    expect(item?.textContent).toContain("test: Failed");
    expect(item?.querySelector(`[title="${CANDIDATE}"]`)?.textContent).toBe(CANDIDATE.slice(0, 7));
    expectFullCandidate(item);
    expect(text()).toContain("Nothing merged yet");
    expect(reads).toEqual([]);
  });

  it("shows the checked candidate, command and failing result once opened", async () => {
    await render(feedOf(failingLog));
    await openDetail();

    expect(reads).toEqual([RUN]);
    const command = container.querySelector("pre[aria-label=Command]");
    expect(command?.textContent).toBe("pnpm install --frozen-lockfile && pnpm test");
    expect(container.querySelector("pre[aria-label=Output]")?.textContent).toBe(
      "FAIL upload.test.ts\n1 failed",
    );
    expect(text()).toContain("Failed at");
    expect(text()).toContain("Composed on main");
    // The full candidate id is visible text in the detail, not only a tooltip.
    const candidate = [...container.querySelectorAll("dt")].find(
      (term) => term.textContent === "Candidate",
    )?.nextElementSibling;
    expect(candidate?.textContent).toBe(CANDIDATE);
    expect(candidate?.hasAttribute("title")).toBe(false);
  });

  it("renders a command and output holding markup as inert text", async () => {
    const markup = `<script>globalThis.pwned=1</script><b onmouseover="x">bold</b>`;
    answers = [
      {
        ok: true,
        value: detail({
          command: markup,
          state: {
            kind: "reported",
            result: "fail",
            finishedAt: 0,
            logTail: markup,
            logCut: false,
          },
        }),
      },
    ];
    await render(feedOf(failingLog));
    await openDetail();

    expect(container.querySelector("pre[aria-label=Command]")?.textContent).toBe(markup);
    expect(container.querySelector("pre[aria-label=Output]")?.textContent).toBe(markup);
    expect(container.querySelector("script, b")).toBeNull();
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("says when the output was cut and a run with no recorded command", async () => {
    answers = [
      {
        ok: true,
        value: detail({
          command: null,
          state: { kind: "reported", result: "error", finishedAt: 0, logTail: "x", logCut: true },
        }),
      },
    ];
    await render(feedOf(failingLog));
    await openDetail();
    expect(text()).toContain(`Output, last ${MAX_CHECK_DETAIL_LOG_BYTES / 1024} KiB`);
    expect(text()).toContain("Not recorded: this run predates commands being kept.");
    expect(container.querySelector("pre[aria-label=Command]")).toBeNull();
  });

  // A listed run has reported, so an answer that it is still held or running does not match it.
  it("shows nothing from an answer that the listed run never reported", async () => {
    answers = [
      { ok: true, value: detail({ state: { kind: "held", paths: [".railhead/check.json"] } }) },
    ];
    await render(feedOf(failingLog));
    await openDetail();
    expect(text()).toContain("does not match this run's reported result");
    expect(text()).not.toContain(".railhead/check.json");
    expect(container.querySelector("pre")).toBeNull();

    answers = [{ ok: true, value: detail({ state: { kind: "started", deadline: 0 } }) }];
    // Another result for the open run reads it again.
    await render(
      feedOf(
        syntheticLog("Synthetic second result", [
          checkResult(RUN, CANDIDATE, "test", "fail"),
          checkResult(RUN, CANDIDATE, "lint", "error"),
        ]).events,
      ),
    );
    expect(reads).toEqual([RUN, RUN]);
    expect(text()).toContain("does not match this run's reported result");
    expect(text()).not.toContain("Running");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("shows nothing from an answer for another commit than the run's", async () => {
    answers = [{ ok: true, value: detail({ candidate: synthCommit(9) }) }];
    await render(feedOf(failingLog));
    await openDetail();

    expect(text()).toContain("does not match this run's reported result");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("says a run the backend no longer keeps is gone, without offering a retry", async () => {
    answers = [{ ok: false, code: "not_found", message: "gone" }];
    await render(feedOf(failingLog));
    await openDetail();

    expect(text()).toContain("The backend no longer keeps this run.");
    expect(button("Try again")).toBeUndefined();
    expect(text()).not.toContain("gone");
  });

  it("retries a failed read on request", async () => {
    answers = [{ ok: false, code: "internal", message: "boom" }];
    await render(feedOf(failingLog));
    await openDetail();
    expect(text()).toContain("The run could not be read.");
    expect(container.querySelector("pre")).toBeNull();

    await act(async () => button("Try again")?.click());

    expect(reads).toEqual([RUN, RUN]);
    expect(container.querySelector("pre[aria-label=Command]")).not.toBeNull();
  });

  it("shows a read that rejects as a failed read", async () => {
    await render(feedOf(failingLog), {
      kind: "available",
      onReadCheck: () => Promise.reject(new Error("session broken")),
    });
    await openDetail();

    expect(text()).toContain("The run could not be read.");
  });

  it("reads an open run again when the log records another result for it", async () => {
    await render(feedOf(failingLog));
    await openDetail();
    expect(reads).toEqual([RUN]);

    const second = syntheticLog("Synthetic second result", [
      checkResult(RUN, CANDIDATE, "test", "fail"),
      checkResult(RUN, CANDIDATE, "lint", "pass"),
    ]).events;
    await render(feedOf(second));

    expect(reads).toEqual([RUN, RUN]);
  });

  it("explains why nothing can be read offline or in a replay, without asking", async () => {
    await render(feedOf(failingLog), { kind: "unavailable", reason: "offline" });
    await openDetail();
    expect(text()).toContain("The board is offline. Reconnect to read this run.");

    await render(feedOf(failingLog), { kind: "unavailable", reason: "replay" });
    expect(text()).toContain("A replay has no backend");
    expect(reads).toEqual([]);
  });

  it("shows the full candidate in a replay, where no detail can be read", async () => {
    await render(feedOf(failingLog), { kind: "unavailable", reason: "replay" });
    await openDetail();

    expect(text()).toContain("A replay has no backend");
    // No detail rendered, so the full id comes from the folded check event.
    expect(container.querySelector("dl")).toBeNull();
    expectFullCandidate(checkItems()[0]);
  });

  it("shows the full candidate when the detail is unavailable or its read fails", async () => {
    await render(feedOf(failingLog), { kind: "unavailable", reason: "module_unavailable" });
    await openDetail();
    expect(container.querySelector("dl")).toBeNull();
    expectFullCandidate(checkItems()[0]);

    answers = [{ ok: false, code: "internal", message: "boom" }];
    await render(feedOf(failingLog));
    expect(text()).toContain("The run could not be read.");
    expect(container.querySelector("dl")).toBeNull();
    expectFullCandidate(checkItems()[0]);
  });

  it(`lists the newest ${MAX_LISTED_CHECK_RUNS} runs and says how many are left out`, async () => {
    const many = syntheticLog(
      "Synthetic many check runs",
      Array.from({ length: MAX_LISTED_CHECK_RUNS + 2 }, (_, n) =>
        checkResult(`chk_synthmany${n}`, synthCommit(n + 1), "test", "pass"),
      ),
    ).events;
    await render(feedOf(many));

    expect(checkItems()).toHaveLength(MAX_LISTED_CHECK_RUNS);
    expect(text()).toContain("2 older reported check runs are not listed; the totals count them.");
  });
});
