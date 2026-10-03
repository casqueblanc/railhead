import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionChallenge,
  BoardResult,
  OwnerAction,
  OwnerActionResult,
} from "@railhead/shared/board-api";
import { MAX_ISSUE_BODY_LENGTH, MAX_TITLE_LENGTH } from "@railhead/shared/events";
import {
  SYNTH_OWNER,
  SYNTH_REPO,
  syntheticLog,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import { enrol } from "../../../../../fixtures/board/uploadSteps";
import type { OwnerPort } from "../board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { fakeAuthenticator } from "../enrollment/fakeAuthenticator";
import type { Authenticator } from "../enrollment/webauthn";
import { IssuesPanel } from "./IssuesPanel";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ATLAS = enrol("agt_synthatlas", "atlas", "inv_synthatlas");

const filed = (issueId: string, title: string, body: string): SyntheticStep => ({
  type: "issue.filed",
  actor: SYNTH_OWNER,
  data: { issueId, title, body },
});

const board = (steps: SyntheticStep[] = []): BoardState =>
  foldEvents(
    emptyBoardState(SYNTH_REPO),
    syntheticLog("Synthetic issues", [...ATLAS, ...steps]).events,
  );

const live = (state: BoardState): BoardFeed => ({
  kind: "board",
  board: state,
  connection: "live",
  recovered: false,
});

const challenge = (): ActionChallenge => ({
  challengeId: "chl_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  allowCredentials: ["AQID"],
  expiresAt: Date.now() + 60_000,
});

const FILED: BoardResult<OwnerActionResult> = {
  ok: true,
  value: { kind: "issue.file", issueId: "iss_synthnew" },
};

/** A promise and the function that settles it, for holding a step open. */
const deferred = <T,>() => {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle?.(value) };
};

/** An owner port that records each prepared action and performed challenge. */
const recordingOwner = (
  perform: () => Promise<BoardResult<OwnerActionResult>> = async () => FILED,
  prepare: () => Promise<BoardResult<ActionChallenge>> = async () => ({
    ok: true,
    value: challenge(),
  }),
) => {
  const prepares: OwnerAction[] = [];
  const performs: string[] = [];
  const owner: OwnerPort = {
    kind: "available",
    onPrepareAction: (action) => {
      prepares.push(action);
      return prepare();
    },
    onPerformAction: (challengeId) => {
      performs.push(challengeId);
      return perform();
    },
  };
  return { owner, prepares, performs };
};

const UNCONFIRMED =
  "The backend did not confirm the issue. If it was filed, it shows in the list below; until then this board will not send the same issue again.";

const ALREADY_SENT =
  "This issue was already sent and may have been filed. It is not sent again until it shows in the list below.";

describe("IssuesPanel", () => {
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

  const render = async (
    feed: BoardFeed,
    owner: OwnerPort,
    authenticator: Authenticator | null = fakeAuthenticator().authenticator,
  ) => {
    await act(async () =>
      root.render(<IssuesPanel feed={feed} owner={owner} authenticator={authenticator} />),
    );
  };

  const field = (label: string): HTMLInputElement | HTMLTextAreaElement => {
    const found = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    const control = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
      throw new Error(`no control labelled ${label}`);
    }
    return control;
  };

  const type = async (label: string, value: string) => {
    const control = field(label);
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const fileButton = (): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>("button[type=submit]");
    if (found === null) throw new Error("no submit button");
    return found;
  };

  const submit = async () => {
    await act(async () => fileButton().click());
  };

  const draft = async (title: string, body: string) => {
    await type("Title", title);
    await type("Description", body);
  };

  const values = () => ({ title: field("Title").value, body: field("Description").value });
  const text = () => container.textContent ?? "";

  it("files the typed issue with one assertion and lists it once the log records it", async () => {
    const { owner, prepares, performs } = recordingOwner();
    await render(live(board()), owner);

    await draft("  Show upload limits  ", "List the size limit beside the picker.");
    await submit();

    expect(prepares).toEqual([
      {
        kind: "issue.file",
        title: "Show upload limits",
        body: "List the size limit beside the picker.",
      },
    ]);
    expect(performs).toEqual(["chl_1"]);
    expect(values()).toEqual({ title: "", body: "" });
    expect(text()).toContain("Filed. The issue shows in the list once the log records it.");
    // The backend answered, but the log has not recorded the issue, so it is not listed yet.
    expect(text()).toContain("No issues yet");

    const recorded = board([
      filed("iss_synthnew", "Show upload limits", "List the size limit beside the picker."),
    ]);
    await render(live(recorded), owner);

    expect(text()).toContain("Filed. The issue is in the list below, ready for an agent.");
    const item = container.querySelector("li");
    expect(item?.textContent).toContain("Show upload limits");
    expect(item?.textContent).toContain("Waiting for an agent");
  });

  it("files a title and description at their exact limits", async () => {
    const { owner, prepares } = recordingOwner();
    await render(live(board()), owner);
    const title = "t".repeat(MAX_TITLE_LENGTH);
    const body = "b".repeat(MAX_ISSUE_BODY_LENGTH);

    await draft(title, body);
    await submit();

    expect(prepares).toEqual([{ kind: "issue.file", title, body }]);
  });

  it.each([
    ["a blank title", "   ", "", "Enter a title."],
    [
      "a title one character too long",
      "t".repeat(MAX_TITLE_LENGTH + 1),
      "",
      `The title is ${MAX_TITLE_LENGTH + 1} characters. Shorten it to ${MAX_TITLE_LENGTH} or fewer.`,
    ],
    [
      "a description one character too long",
      "Show upload limits",
      "b".repeat(MAX_ISSUE_BODY_LENGTH + 1),
      `The description is ${MAX_ISSUE_BODY_LENGTH + 1} characters. Shorten it to ${MAX_ISSUE_BODY_LENGTH} or fewer.`,
    ],
  ])("refuses %s before asking for a passkey", async (_, title, body, message) => {
    const { owner, prepares } = recordingOwner();
    await render(live(board()), owner);

    await draft(title, body);
    await submit();

    expect(prepares).toEqual([]);
    expect(text()).toContain(message);
    expect(values()).toEqual({ title, body });
  });

  it("keeps what was typed when the backend fails after the passkey was sent", async () => {
    const { owner, performs } = recordingOwner(async () => ({
      ok: false,
      code: "internal",
      message: "storage failed",
    }));
    await render(live(board()), owner);

    await draft("Show upload limits", "Beside the picker.");
    await submit();

    expect(performs).toEqual(["chl_1"]);
    expect(text()).toContain(UNCONFIRMED);
    expect(text()).not.toContain("storage failed");
    expect(values()).toEqual({ title: "Show upload limits", body: "Beside the picker." });
  });

  it("does not send an unconfirmed filing again before its event arrives", async () => {
    // The backend committed the issue, but its answer was lost and the event is still on its way.
    const { owner, prepares, performs } = recordingOwner(() =>
      Promise.reject(new Error("session lost")),
    );
    await render(live(board()), owner);
    await draft("Show upload limits", "Beside the picker.");
    await submit();
    expect(text()).toContain(UNCONFIRMED);

    await submit();

    expect(prepares).toHaveLength(1);
    expect(performs).toEqual(["chl_1"]);
    expect(text()).toContain(ALREADY_SENT);
    expect(values()).toEqual({ title: "Show upload limits", body: "Beside the picker." });

    await render(
      live(board([filed("iss_synthnew", "Show upload limits", "Beside the picker.")])),
      owner,
    );
    expect(text()).toContain(
      "Filed after all. The issue is in the list below, ready for an agent.",
    );

    await submit();

    expect(prepares).toHaveLength(1);
    expect(text()).toContain(
      "An issue with this exact title and description is already on the board.",
    );
  });

  it("files a changed draft while an earlier one is unconfirmed", async () => {
    let lost = true;
    const { owner, prepares } = recordingOwner(() =>
      lost ? Promise.reject(new Error("session lost")) : Promise.resolve(FILED),
    );
    await render(live(board()), owner);
    await draft("Show upload limits", "Beside the picker.");
    await submit();
    lost = false;

    await type("Description", "Beside the picker, in MB.");
    await submit();

    expect(prepares.map((action) => action.kind === "issue.file" && action.body)).toEqual([
      "Beside the picker.",
      "Beside the picker, in MB.",
    ]);
    expect(values()).toEqual({ title: "", body: "" });

    // The first draft is still unconfirmed, so typing it again does not send it.
    await draft("Show upload limits", "Beside the picker.");
    await submit();

    expect(prepares).toHaveLength(2);
    expect(text()).toContain(ALREADY_SENT);
  });

  it("lets the owner file again once the backend refuses the sent filing", async () => {
    let answer: BoardResult<OwnerActionResult> = {
      ok: false,
      code: "quota_exceeded",
      message: "too many issues",
    };
    const { owner, performs } = recordingOwner(async () => answer);
    await render(live(board()), owner);
    await draft("Show upload limits", "");
    await submit();
    expect(text()).toContain("The issue limit was reached. Nothing was filed.");
    answer = FILED;

    await submit();

    expect(performs).toEqual(["chl_1", "chl_1"]);
    expect(values()).toEqual({ title: "", body: "" });
  });

  it("lets the owner retry when the challenge could not be prepared", async () => {
    let fail = true;
    const { owner, prepares, performs } = recordingOwner(undefined, () =>
      fail
        ? Promise.reject(new Error("session lost"))
        : Promise.resolve({ ok: true, value: challenge() }),
    );
    await render(live(board()), owner);
    await draft("Show upload limits", "");
    await submit();
    expect(performs).toEqual([]);
    expect(text()).toContain("The issue could not be sent. Nothing was filed. Try again.");
    fail = false;

    await submit();

    expect(prepares).toHaveLength(2);
    expect(performs).toEqual(["chl_1"]);
  });

  it("keeps what was typed when the backend cannot file issues", async () => {
    const { owner, performs } = recordingOwner(undefined, async () => ({
      ok: false,
      code: "unavailable",
      message: "claims module missing",
    }));
    await render(live(board()), owner);

    await draft("Show upload limits", "");
    await submit();

    expect(performs).toEqual([]);
    expect(text()).toContain("This Railhead cannot file issues: its module is not installed.");
    expect(values()).toEqual({ title: "Show upload limits", body: "" });
  });

  it("files nothing when the owner dismisses the passkey prompt", async () => {
    const { owner, performs } = recordingOwner();
    await render(live(board()), owner, fakeAuthenticator(() => "dismiss").authenticator);

    await draft("Show upload limits", "");
    await submit();

    expect(performs).toEqual([]);
    expect(text()).toContain("Cancelled. No issue was filed.");
    expect(values()).toEqual({ title: "Show upload limits", body: "" });
  });

  it("sends one filing when the form is submitted twice before the backend answers", async () => {
    const held = deferred<BoardResult<ActionChallenge>>();
    const { owner, prepares, performs } = recordingOwner(undefined, () => held.promise);
    await render(live(board()), owner);
    await draft("Show upload limits", "");

    await act(async () => {
      fileButton().click();
      fileButton().click();
    });
    expect(fileButton().textContent).toContain("Waiting for passkey…");
    await act(async () => held.resolve({ ok: true, value: challenge() }));

    expect(prepares).toHaveLength(1);
    expect(performs).toEqual(["chl_1"]);
  });

  it("refuses to file an issue the board already lists with the same title and description", async () => {
    const { owner, prepares } = recordingOwner();
    await render(
      live(board([filed("iss_synthold", "Show upload limits", "Beside the picker.")])),
      owner,
    );

    await draft("Show upload limits ", "Beside the picker.");
    await submit();

    expect(prepares).toEqual([]);
    expect(text()).toContain(
      "An issue with this exact title and description is already on the board.",
    );

    await type("Description", "Beside the picker, in MB.");
    await submit();

    expect(prepares).toEqual([
      { kind: "issue.file", title: "Show upload limits", body: "Beside the picker, in MB." },
    ]);
  });

  it("stops a filing the board withdraws before it is sent and keeps the draft", async () => {
    const held = deferred<BoardResult<ActionChallenge>>();
    const { owner, performs } = recordingOwner(undefined, () => held.promise);
    const feed = live(board());
    await render(feed, owner);
    await draft("Show upload limits", "");

    await act(async () => fileButton().click());
    await render(feed, { kind: "unavailable", reason: "offline" });
    await act(async () => held.resolve({ ok: true, value: challenge() }));

    expect(performs).toEqual([]);
    expect(text()).toContain(
      "Stopped: the board lost its current view before the issue was sent. Nothing was filed.",
    );
    expect(text()).toContain("Blocked while the board is offline. Reconnect to act.");
    expect(fileButton().disabled).toBe(true);
    expect(values()).toEqual({ title: "Show upload limits", body: "" });
  });

  it("does not send a filing withdrawn after sending again when access returns", async () => {
    const held = deferred<BoardResult<OwnerActionResult>>();
    const { owner, prepares, performs } = recordingOwner(() => held.promise);
    const feed = live(board());
    await render(feed, owner);
    await draft("Show upload limits", "");

    await act(async () => fileButton().click());
    expect(performs).toEqual(["chl_1"]);
    await render(feed, { kind: "unavailable", reason: "offline" });
    await act(async () => held.resolve(FILED));
    expect(text()).toContain(
      "The board lost its current view after the issue was sent. If it was filed, it shows in the list below; until then this board will not send the same issue again.",
    );

    const { owner: back, prepares: again } = recordingOwner();
    await render(feed, back);
    await submit();

    expect(prepares).toHaveLength(1);
    expect(again).toEqual([]);
    expect(text()).toContain(ALREADY_SENT);

    await render(live(board([filed("iss_synthnew", "Show upload limits", "")])), back);
    expect(text()).toContain(
      "Filed after all. The issue is in the list below, ready for an agent.",
    );
  });

  it("offers no way to file without a passkey on this page", async () => {
    const { owner, prepares } = recordingOwner();
    await render(live(board()), owner, null);

    expect(text()).toContain("Blocked: this browser cannot use a passkey on this page.");
    expect(fileButton().disabled).toBe(true);
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(prepares).toEqual([]);
  });

  it("says the issues did not load when the board failed", async () => {
    await render({ kind: "failed" }, recordingOwner().owner);

    expect(text()).toContain("Issues did not load");
    expect(container.querySelector("form")).toBeNull();
  });
});
