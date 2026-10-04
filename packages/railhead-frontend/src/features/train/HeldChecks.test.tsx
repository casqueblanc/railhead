import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionChallenge,
  BoardResult,
  OwnerAction,
  OwnerActionResult,
} from "@railhead/shared/board-api";
import {
  SYNTH_OWNER,
  SYNTH_REPO,
  SYNTH_TRAIN,
  syntheticLog,
  synthCommit,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import {
  UPLOAD,
  checkResult,
  ready,
  uploadPrelude,
} from "../../../../../fixtures/board/uploadSteps";
import type { OwnerPort } from "../board/boardPorts";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import type { BoardFeed } from "../claims/boardFeed";
import { fakeAuthenticator, type FakeAnswer } from "../enrollment/fakeAuthenticator";
import type { Authenticator } from "../enrollment/webauthn";
import { HeldChecks } from "./HeldChecks";
import { MAX_SHOWN_HELD_CHECKS } from "./heldCheckRows";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = "chk_synthheld01";
const DIGEST = "d".repeat(64);
const CANDIDATE = synthCommit(9);
const NO_PASSKEY = "Blocked: this browser cannot use a passkey on this page.";

const held = (
  digest: string | null = DIGEST,
  checkRunId = RUN,
  claims: string[] = [UPLOAD.atlasClaim],
): SyntheticStep => ({
  type: "train.held",
  actor: { kind: "system", id: "sys_checks" },
  data: {
    checkRunId,
    expectedMain: synthCommit(0),
    candidate: CANDIDATE,
    claims,
    paths: [".railhead/check.json", "acceptance"],
    digest,
  },
});

const approved: SyntheticStep = {
  type: "check.approved",
  actor: SYNTH_OWNER,
  data: { checkRunId: RUN, candidate: CANDIDATE, digest: DIGEST },
};

const board = (steps: SyntheticStep[] = []): BoardState =>
  foldEvents(
    emptyBoardState(SYNTH_REPO),
    syntheticLog("Synthetic held checks", [
      ...uploadPrelude(),
      ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), []),
      ...steps,
    ]).events,
  );

const live = (state: BoardState): BoardFeed => ({
  kind: "board",
  board: state,
  connection: "live",
  recovered: false,
});

const lost = (state: BoardState): BoardFeed => ({
  kind: "board",
  board: state,
  connection: "lost",
  recovered: false,
});

const caughtUp = (state: BoardState): BoardFeed => ({
  kind: "board",
  board: state,
  connection: "live",
  recovered: true,
});

const OFFLINE: OwnerPort = { kind: "unavailable", reason: "offline" };

const challenge = (): ActionChallenge => ({
  challengeId: "chl_1",
  challenge: "AAECAw",
  rpId: "railhead.dev",
  allowCredentials: ["AQID"],
  expiresAt: Date.now() + 60_000,
});

const APPROVED: BoardResult<OwnerActionResult> = {
  ok: true,
  value: { kind: "check.approve", checkRunId: RUN },
};

/** An owner port that records each prepared action and performed challenge. */
const recordingOwner = (
  perform: () => Promise<BoardResult<OwnerActionResult>> = async () => APPROVED,
) => {
  const prepares: OwnerAction[] = [];
  const performs: string[] = [];
  const owner: OwnerPort = {
    kind: "available",
    onPrepareAction: async (action) => {
      prepares.push(action);
      return { ok: true, value: challenge() };
    },
    onPerformAction: (challengeId) => {
      performs.push(challengeId);
      return perform();
    },
  };
  return { owner, prepares, performs };
};

describe("HeldChecks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    retries = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  let retries = 0;
  const authenticator = fakeAuthenticator().authenticator;
  const render = async (
    feed: BoardFeed,
    owner: OwnerPort,
    pageAuthenticator: Authenticator | null = authenticator,
  ) => {
    await act(async () =>
      root.render(
        <HeldChecks
          feed={feed}
          owner={owner}
          authenticator={pageAuthenticator}
          onRetry={() => {
            retries += 1;
          }}
        />,
      ),
    );
  };

  const text = () => container.textContent ?? "";
  const approveButton = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Approve and run this definition"),
    ) ?? null;
  const buttonNamed = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (found === undefined) throw new Error(`no ${label} button`);
    return found;
  };
  const approve = async () => {
    const button = approveButton();
    if (button === null) throw new Error("no approve button");
    await act(async () => button.click());
  };

  it("shows the held paths and approves exactly the held attempt, candidate and digest", async () => {
    const { owner, prepares, performs } = recordingOwner();
    await render(live(board([held()])), owner);

    expect(text()).toContain("Accept large uploads");
    expect(text()).toContain("Waiting for approval");
    const paths = [...container.querySelectorAll('[aria-label="Protected paths it changes"] li')];
    expect(paths.map((item) => item.textContent)).toEqual([".railhead/check.json", "acceptance"]);

    await approve();
    expect(prepares).toEqual([
      { kind: "check.approve", checkRunId: RUN, candidate: CANDIDATE, digest: DIGEST },
    ]);
    expect(performs).toEqual(["chl_1"]);
    expect(text()).toContain("Approved. The train runs the check next.");
    // Not offered again until the log records it.
    expect(approveButton()?.disabled).toBe(true);

    await render(live(board([held(), approved])), owner);
    expect(text()).toContain("Approved by usr_synthowner");
    expect(text()).toContain("Waiting for the run's result.");
    expect(approveButton()).toBeNull();
  });

  it("shows the run's result once the approved check reports", async () => {
    const { owner } = recordingOwner();
    await render(
      live(board([held(), approved, checkResult(RUN, CANDIDATE, "test", "fail", null)])),
      owner,
    );
    expect(text()).toContain("Failed");
    expect(text()).toContain("The run failed.");
  });

  it("offers nothing to approve for a candidate with no valid definition", async () => {
    const { owner, prepares } = recordingOwner();
    await render(live(board([held(null)])), owner);

    expect(text()).toContain("Nothing to approve");
    expect(approveButton()).toBeNull();
    expect(prepares).toEqual([]);
  });

  it("says nothing was approved when the backend finds the hold stale", async () => {
    const { owner } = recordingOwner(async () => ({
      ok: false,
      code: "action_stale",
      message: "untrusted backend text",
    }));
    await render(live(board([held()])), owner);

    await approve();
    expect(text()).toContain(
      "This check is no longer held for that definition. Nothing was approved.",
    );
    expect(text()).not.toContain("untrusted backend text");
    // A stated refusal leaves the action available.
    expect(approveButton()?.disabled).toBe(false);
  });

  it.each<[FakeAnswer, string]>([
    ["dismiss", "The passkey prompt was dismissed. Nothing was approved."],
  ])("performs nothing when the passkey answers %s", async (answer, message) => {
    const { owner, performs } = recordingOwner();
    await render(live(board([held()])), owner, fakeAuthenticator(() => answer).authenticator);

    await approve();
    expect(performs).toEqual([]);
    expect(text()).toContain(message);
  });

  it("keeps an approval whose answer was lost unconfirmed, and does not send it again", async () => {
    const { owner, performs } = recordingOwner(async () => {
      throw new Error("socket closed");
    });
    await render(live(board([held()])), owner);

    await approve();
    expect(performs).toEqual(["chl_1"]);
    expect(text()).toContain("The approval was sent but not confirmed.");
    expect(approveButton()?.disabled).toBe(true);
  });

  it("blocks the action without a passkey and says why", async () => {
    const { owner, prepares } = recordingOwner();
    await render(live(board([held()])), owner, null);

    expect(approveButton()?.disabled).toBe(true);
    expect(text()).toContain(NO_PASSKEY);
    expect(prepares).toEqual([]);
  });

  it("lists checks waiting for approval before settled ones, newest first", async () => {
    const { owner } = recordingOwner();
    const older = "chk_synthheld00";
    await render(live(board([held(DIGEST, older, [UPLOAD.birchClaim]), held(), approved])), owner);

    const items = [...container.querySelectorAll("li[aria-labelledby]")];
    expect(items.map((item) => item.getAttribute("aria-labelledby"))).toEqual([
      `held-${older}`,
      `held-${RUN}`,
    ]);
    expect(text()).toContain("1 waiting for approval");
  });

  it("lists every claim a shared held candidate covers before its approval", async () => {
    const { owner } = recordingOwner();
    await render(
      live(
        board([
          ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(2), []),
          held(DIGEST, RUN, [UPLOAD.atlasClaim, UPLOAD.birchClaim]),
        ]),
      ),
      owner,
    );

    const claims = container.querySelector('ul[aria-label="Claims in this candidate"]');
    expect([...(claims?.querySelectorAll("li") ?? [])].map((item) => item.textContent)).toEqual([
      `Accept large uploads ${UPLOAD.atlasClaim}`,
      `Show upload limits ${UPLOAD.birchClaim}`,
    ]);
    const button = approveButton();
    if (claims === null || button === null) throw new Error("missing claims or approval");
    expect(claims.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names a single claim in the heading without a claims list", async () => {
    const { owner } = recordingOwner();
    await render(live(board([held()])), owner);

    expect(container.querySelector("h3")?.textContent).toBe("Accept large uploads");
    expect(container.querySelector('ul[aria-label="Claims in this candidate"]')).toBeNull();
  });

  it(`lists at most ${MAX_SHOWN_HELD_CHECKS} held checks, newest first, and counts the rest`, async () => {
    const { owner } = recordingOwner();
    const runs = Array.from(
      { length: MAX_SHOWN_HELD_CHECKS + 5 },
      (_, n) => `chk_synthrun${String(n).padStart(3, "0")}`,
    );
    await render(live(board(runs.map((run) => held(DIGEST, run)))), owner);

    const items = [...container.querySelectorAll("li[aria-labelledby]")];
    expect(items).toHaveLength(MAX_SHOWN_HELD_CHECKS);
    // Each hold supersedes the one before on the same claim: the newest waits and comes first.
    expect(items[0]?.getAttribute("aria-labelledby")).toBe(`held-${runs.at(-1)}`);
    expect(items.at(-1)?.getAttribute("aria-labelledby")).toBe(
      `held-${runs.at(-MAX_SHOWN_HELD_CHECKS)}`,
    );
    expect(text()).toContain("5 more held checks are not shown.");
  });

  it("counts no hidden checks at exactly the bound", async () => {
    const { owner } = recordingOwner();
    const runs = Array.from(
      { length: MAX_SHOWN_HELD_CHECKS },
      (_, n) => `chk_synthrun${String(n).padStart(3, "0")}`,
    );
    await render(live(board(runs.map((run) => held(DIGEST, run)))), owner);

    expect(container.querySelectorAll("li[aria-labelledby]")).toHaveLength(MAX_SHOWN_HELD_CHECKS);
    expect(text()).not.toContain("not shown");
  });

  it("offers no approval for a hold a later attempt on its claim superseded", async () => {
    const { owner, prepares } = recordingOwner();
    const newer = "chk_synthheld02";
    await render(live(board([held(), held(DIGEST, newer)])), owner);

    const items = [...container.querySelectorAll("li[aria-labelledby]")];
    expect(items.map((item) => item.getAttribute("aria-labelledby"))).toEqual([
      `held-${newer}`,
      `held-${RUN}`,
    ]);
    const stale = items[1];
    expect(stale?.textContent).toContain("Superseded");
    expect(stale?.textContent).toContain("A newer attempt or a new holder of its claim replaced");
    expect(stale?.querySelector("button")).toBeNull();
    // Only the current hold counts and offers the approval.
    expect(text()).toContain("1 waiting for approval");
    expect(items[0]?.textContent).toContain("Approve and run this definition");
    expect(prepares).toEqual([]);
  });

  it.each([
    [
      "reassigned",
      {
        type: "claim.reassigned",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.atlasClaim, from: UPLOAD.atlas, to: UPLOAD.birch, generation: 2 },
      },
      "Superseded",
    ],
    [
      "reopened",
      {
        type: "claim.reopened",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.atlasClaim, generation: 1, reason: "check_failed", decisions: [] },
      },
      "Dropped",
    ],
    [
      "expired",
      {
        type: "claim.expired",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.atlasClaim, generation: 1 },
      },
      "Dropped",
    ],
    [
      "expired by the train after waiting too long",
      {
        type: "train.held_expired",
        actor: SYNTH_TRAIN,
        data: { checkRunId: RUN, candidate: CANDIDATE, reason: "timed_out" },
      },
      "Expired",
    ],
    [
      "expired by the train for newer held checks",
      {
        type: "train.held_expired",
        actor: SYNTH_TRAIN,
        data: { checkRunId: RUN, candidate: CANDIDATE, reason: "over_limit" },
      },
      "Expired",
    ],
  ] satisfies [string, SyntheticStep, string][])(
    "offers no approval once the held claim is %s",
    async (_name, step, label) => {
      const { owner } = recordingOwner();
      await render(live(board([held(), step])), owner);
      expect(text()).toContain(label);
      expect(approveButton()).toBeNull();
      expect(text()).not.toContain("waiting for approval");
    },
  );

  it.each([
    ["timed_out", "Nobody approved it within the time the train keeps a held check"],
    ["over_limit", "Newer held checks in this repository filled the number the train keeps"],
  ] as const)("says why the train expired a held check as %s", async (reason, why) => {
    const { owner, prepares } = recordingOwner();
    await render(
      live(
        board([
          held(),
          {
            type: "train.held_expired",
            actor: SYNTH_TRAIN,
            data: { checkRunId: RUN, candidate: CANDIDATE, reason },
          },
        ]),
      ),
      owner,
    );
    expect(text()).toContain(why);
    expect(text()).not.toContain("Waiting for approval");
    expect(approveButton()).toBeNull();
    expect(prepares).toEqual([]);
  });

  it("keeps a run's result once the claim it landed moves on", async () => {
    const { owner } = recordingOwner();
    await render(
      live(
        board([
          held(),
          approved,
          checkResult(RUN, CANDIDATE, "acceptance", "pass"),
          {
            type: "claim.expired",
            actor: SYNTH_TRAIN,
            data: { claimId: UPLOAD.atlasClaim, generation: 1 },
          },
        ]),
      ),
      owner,
    );
    expect(text()).toContain("Passed");
    expect(text()).not.toContain("Dropped");
  });

  it("says when no checks are held", async () => {
    const { owner } = recordingOwner();
    await render(live(board()), owner);
    expect(text()).toContain("No checks are held");
    expect(approveButton()).toBeNull();
  });

  it("withholds an approval withdrawn after sending, across a reconnect, until the log records it", async () => {
    const first = recordingOwner(() => new Promise(() => {}));
    const state = board([held()]);
    await render(live(state), first.owner);

    await approve();
    expect(first.performs).toEqual(["chl_1"]);

    // The session drops while the approval is in flight, then a new one opens.
    await render(lost(state), OFFLINE);
    expect(text()).toContain("The board lost its session after sending the approval.");
    expect(approveButton()?.disabled).toBe(true);

    const second = recordingOwner();
    await render(caughtUp(state), second.owner);
    expect(text()).toContain("The board lost its session after sending the approval.");
    expect(approveButton()?.disabled).toBe(true);
    await approve();
    expect(second.prepares).toEqual([]);
    expect(second.performs).toEqual([]);

    // Still withheld when the list remounts, as while a reloaded board loads.
    await render({ kind: "loading" }, second.owner);
    await render(live(state), second.owner);
    expect(approveButton()?.disabled).toBe(true);
    expect(text()).toContain("The approval was sent but not confirmed.");

    await render(live(board([held(), approved])), second.owner);
    expect(text()).toContain("Approved by usr_synthowner");
    expect(approveButton()).toBeNull();
  });

  it("offers an approval again after a reconnect when it was withdrawn before sending", async () => {
    const prepares: OwnerAction[] = [];
    const stalled: OwnerPort = {
      kind: "available",
      onPrepareAction: (action) => {
        prepares.push(action);
        return new Promise(() => {});
      },
      onPerformAction: async () => APPROVED,
    };
    const state = board([held()]);
    await render(live(state), stalled);
    await approve();
    expect(prepares).toHaveLength(1);

    await render(lost(state), OFFLINE);
    expect(text()).toContain("The board lost its session. Nothing was approved.");

    const second = recordingOwner();
    await render(live(state), second.owner);
    expect(approveButton()?.disabled).toBe(false);
    await approve();
    expect(second.performs).toEqual(["chl_1"]);
  });

  it("marks rows as of the cursor and offers a reconnect while disconnected", async () => {
    const { owner } = recordingOwner();
    const state = board([held()]);
    await render(lost(state), OFFLINE);

    expect(text()).toContain("Disconnected");
    expect(text()).toContain(`Showing the board through event ${state.cursor}.`);
    expect(text()).toContain(`Waiting as of event ${state.cursor}`);
    expect(text()).not.toContain("Waiting for approval");
    expect(approveButton()?.disabled).toBe(true);

    await act(async () => buttonNamed("Reconnect").click());
    expect(retries).toBe(1);

    await render(caughtUp(state), owner);
    expect(text()).toContain("Back in sync");
    expect(text()).toContain(`Caught up through event ${state.cursor}.`);
    expect(text()).toContain("1 waiting for approval");
    expect(approveButton()?.disabled).toBe(false);
  });

  it("marks rows as of the cursor and withholds approval while events are missing", async () => {
    const { owner, prepares } = recordingOwner();
    const state = board([held()]);
    const gapped: BoardState = {
      ...state,
      stream: { kind: "gap", expected: state.cursor + 1, through: state.cursor + 3 },
    };
    await render(live(gapped), owner);

    expect(text()).toContain(`Waiting for events ${state.cursor + 1}–${state.cursor + 3}`);
    expect(text()).toContain(`Waiting as of event ${state.cursor}`);
    expect(text()).not.toContain("waiting for approval");
    await approve();
    expect(prepares).toEqual([]);
  });

  it("keeps the rows it has when the fold halted and offers a reload", async () => {
    const { owner, prepares } = recordingOwner();
    const state = board([held()]);
    const halted: BoardState = {
      ...state,
      stream: {
        kind: "halted",
        fault: { kind: "unsupported_version", seq: state.cursor + 1, version: 2 },
      },
    };
    await render(live(halted), owner);

    expect(text()).toContain(`Board stopped at event ${state.cursor + 1}`);
    expect(text()).toContain(`Waiting as of event ${state.cursor}`);
    await approve();
    expect(prepares).toEqual([]);

    await act(async () => buttonNamed("Reload board").click());
    expect(retries).toBe(1);
  });

  it("offers a retry when the board did not load", async () => {
    const { owner } = recordingOwner();
    await render({ kind: "failed" }, owner);

    expect(text()).toContain("Held checks did not load");
    await act(async () => buttonNamed("Try again").click());
    expect(retries).toBe(1);
  });
});
