import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  SYNTH_GATEWAY,
  SYNTH_OWNER,
  SYNTH_REPO,
  syntheticLog,
} from "../../../../../fixtures/board/syntheticLog";
import { enrol } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { codeProblem, inviteNameProblem, roster } from "./roster";

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

describe("roster", () => {
  it("splits invites and agents by where each stands, ordered by name", () => {
    const board = fold(
      syntheticLog("Synthetic roster", [
        ...enrol("agt_synthbirch", "birch", "inv_synthbirch"),
        ...enrol("agt_synthatlas", "atlas", "inv_synthatlas"),
        { type: "agent.revoked", actor: SYNTH_OWNER, data: { agentId: "agt_synthbirch" } },
        {
          type: "agent.invited",
          actor: SYNTH_OWNER,
          data: { inviteId: "inv_synthcedar", name: "cedar" },
        },
        {
          type: "agent.invited",
          actor: SYNTH_OWNER,
          data: { inviteId: "inv_synthdune", name: "dune" },
        },
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
      ]).events,
    );
    expect(board.stream.kind).toBe("consistent");

    const rows = roster(board);

    expect(rows.invites.map((invite) => invite.name)).toEqual(["cedar"]);
    expect(rows.awaiting.map((agent) => agent.name)).toEqual(["dune"]);
    expect(rows.confirmed.map((agent) => agent.name)).toEqual(["atlas"]);
    expect(rows.revoked.map((agent) => agent.name)).toEqual(["birch"]);
  });

  it("is empty for a log with no agents", () => {
    expect(roster(fold([]))).toEqual({ invites: [], awaiting: [], confirmed: [], revoked: [] });
  });
});

describe("inviteNameProblem", () => {
  it("accepts a valid name up to the length limit", () => {
    expect(inviteNameProblem("atlas-2")).toBeNull();
    expect(inviteNameProblem(`a${"b".repeat(31)}`)).toBeNull();
  });

  it("refuses an empty, too long or malformed name", () => {
    expect(inviteNameProblem("")).not.toBeNull();
    expect(inviteNameProblem(`a${"b".repeat(32)}`)).not.toBeNull();
    for (const name of ["Atlas", "2atlas", "at las", "atlas_2", "-atlas"]) {
      expect(inviteNameProblem(name)).not.toBeNull();
    }
  });
});

describe("codeProblem", () => {
  it("accepts exactly six digits", () => {
    expect(codeProblem("012345")).toBeNull();
  });

  it("refuses five or seven digits and anything but digits", () => {
    for (const code of ["", "12345", "1234567", "12345a", "١٢٣٤٥٦", " 12345"]) {
      expect(codeProblem(code)).not.toBeNull();
    }
  });
});
