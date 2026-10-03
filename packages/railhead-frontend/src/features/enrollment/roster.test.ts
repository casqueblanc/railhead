import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import {
  SYNTH_GATEWAY,
  SYNTH_OWNER,
  SYNTH_REPO,
  SYNTH_START_MS,
  syntheticLog,
} from "../../../../../fixtures/board/syntheticLog";
import { enrol } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { codeProblem, inviteNameProblem, nextExpiry, roster } from "./roster";

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

const FIFTEEN_MINUTES = 15 * 60_000;

/** A log where cedar is invited and nobody joins, and when the log recorded the invite. */
const cedarInvited = () => {
  const { events } = syntheticLog("Synthetic invite", [
    {
      type: "agent.invited",
      actor: SYNTH_OWNER,
      data: { inviteId: "inv_synthcedar", name: "cedar" },
    },
  ]);
  const invited = events.find((event) => event.type === "agent.invited");
  if (invited === undefined) throw new Error("no invite in the log");
  return { board: fold(events), invitedAt: invited.at };
};

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

    // Long after every invite expired: dune's invite was used, so only cedar's shows as expired.
    const rows = roster(board, SYNTH_START_MS + 4 * FIFTEEN_MINUTES);

    expect(rows.invites).toEqual([]);
    expect(rows.expired.map((invite) => invite.name)).toEqual(["cedar"]);
    expect(rows.awaiting.map((agent) => agent.name)).toEqual(["dune"]);
    expect(rows.confirmed.map((agent) => agent.name)).toEqual(["atlas"]);
    expect(rows.revoked.map((agent) => agent.name)).toEqual(["birch"]);
  });

  it("lists an unused invite as open until the moment it expires, then as expired", () => {
    const { board, invitedAt } = cedarInvited();
    const cedar = {
      inviteId: "inv_synthcedar",
      name: "cedar",
      expiresAt: invitedAt + FIFTEEN_MINUTES,
    };

    const before = roster(board, invitedAt + FIFTEEN_MINUTES - 1);
    expect(before.invites).toEqual([cedar]);
    expect(before.expired).toEqual([]);

    const at = roster(board, invitedAt + FIFTEEN_MINUTES);
    expect(at.invites).toEqual([]);
    expect(at.expired).toEqual([cedar]);
  });

  it("keeps an invite open when the clock reads earlier than the log", () => {
    const { board, invitedAt } = cedarInvited();

    expect(roster(board, invitedAt - FIFTEEN_MINUTES).invites.map((i) => i.name)).toEqual([
      "cedar",
    ]);
  });

  it("is empty for a log with no agents", () => {
    expect(roster(fold([]), SYNTH_START_MS)).toEqual({
      invites: [],
      expired: [],
      awaiting: [],
      confirmed: [],
      revoked: [],
    });
  });
});

const invite = (name: string, expiresAt: number) => ({
  inviteId: `inv_synth${name}` as const,
  name,
  expiresAt,
});

describe("nextExpiry", () => {
  it("is the earliest expiry among the invites", () => {
    expect(nextExpiry([invite("cedar", 300), invite("atlas", 100), invite("dune", 200)])).toBe(100);
  });

  it("is null when no invite is left to expire", () => {
    expect(nextExpiry([])).toBeNull();
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
