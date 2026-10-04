import { describe, expect, it } from "vitest";
import { SYNTH_OWNER, SYNTH_REPO, syntheticLog } from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { MAX_LISTED_ISSUES, issueList } from "./issueList";

const upload = (extra: Parameters<typeof syntheticLog>[1] = []): BoardState =>
  foldEvents(
    emptyBoardState(SYNTH_REPO),
    syntheticLog("Synthetic issues", [...uploadPrelude(), ...extra]).events,
  );

describe("issueList", () => {
  it("lists the newest issue first with the agent holding each claim", () => {
    const { rows, hidden } = issueList(upload());

    expect(rows.map(({ title, status }) => ({ title, status }))).toEqual([
      { title: "Show upload limits", status: { kind: "claimed", agent: "birch" } },
      { title: "Accept large uploads", status: { kind: "claimed", agent: "atlas" } },
    ]);
    expect(hidden).toBe(0);
  });

  it("reopens an issue whose claim expired and follows a reassigned claim to its new agent", () => {
    const { rows } = issueList(
      upload([
        {
          type: "claim.expired",
          actor: { kind: "system", id: "sys_lease" },
          data: { claimId: UPLOAD.birchClaim, generation: 1 },
        },
        {
          type: "claim.reassigned",
          actor: { kind: "system", id: "sys_lease" },
          data: { claimId: UPLOAD.atlasClaim, from: UPLOAD.atlas, to: UPLOAD.birch, generation: 2 },
        },
      ]),
    );

    expect(rows.map((row) => row.status)).toEqual([
      { kind: "open" },
      { kind: "claimed", agent: "birch" },
    ]);
  });

  it("shows a landed claim as landed", () => {
    const board = upload();
    const claim = board.claims[UPLOAD.atlasClaim];
    if (claim === undefined) throw new Error("fixture lost atlas's claim");
    const landed: BoardState = {
      ...board,
      claims: { ...board.claims, [UPLOAD.atlasClaim]: { ...claim, phase: "merged" } },
    };

    expect(issueList(landed).rows.at(-1)?.status).toEqual({ kind: "landed" });
  });

  it("lists nothing for a board without issues", () => {
    expect(issueList(emptyBoardState(SYNTH_REPO))).toEqual({ rows: [], hidden: 0 });
  });

  it(`lists at most ${MAX_LISTED_ISSUES} issues and counts the older ones`, () => {
    const filed = Array.from({ length: MAX_LISTED_ISSUES + 3 }, (_, index) => ({
      type: "issue.filed" as const,
      actor: SYNTH_OWNER,
      data: {
        issueId: `iss_synth${String(index).padStart(3, "0")}`,
        title: `Issue ${index}`,
        body: "",
      },
    }));
    const board = foldEvents(
      emptyBoardState(SYNTH_REPO),
      syntheticLog("Synthetic many issues", filed).events,
    );

    const { rows, hidden } = issueList(board);

    expect(rows).toHaveLength(MAX_LISTED_ISSUES);
    expect(rows[0]?.title).toBe(`Issue ${MAX_LISTED_ISSUES + 2}`);
    expect(rows.at(-1)?.title).toBe("Issue 3");
    expect(hidden).toBe(3);
  });
});
