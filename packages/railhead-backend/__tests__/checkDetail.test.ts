import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import type { BoardResult } from "@railhead/shared/board-api";
import { AttemptTable } from "../src/checks/attempts";
import { repoObjectName } from "../src/repo/RepoObject";

const ORIGIN = "https://railhead.invalid";
const MAIN = "1".repeat(40);
const CANDIDATE = "2".repeat(40);
const DIGEST = "d".repeat(64);
const SANDBOX = `sbx-${"f".repeat(32)}`;

function value<T>(
  result: BoardResult<T> | { ok: true; value: T } | { ok: false; code: string },
): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
}

async function openSession(): Promise<WebSocket> {
  const response = await SELF.fetch(`${ORIGIN}${API_PATH}`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return socket;
}

/** A fresh repository whose checks module recorded one reported failure and one held attempt. */
async function repositoryWithAttempts(): Promise<{ name: string; failed: string; held: string }> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  value(await stub.initialize("acme", name));
  const failed = `chk_${"a".repeat(32)}`;
  const held = `chk_${"b".repeat(32)}`;
  await runInDurableObject(stub, (_instance, state) => {
    const attempts = new AttemptTable(state.storage, () => false);
    const identity = { candidate: CANDIDATE, expectedMain: MAIN, digest: DIGEST };
    attempts.start({ ...identity, attemptId: failed }, "pnpm test", SANDBOX, 2_000, 1_000);
    attempts.report(failed, "fail", "<b>1 failed</b>", "e".repeat(64), 1_500, 1_500);
    attempts.hold({ ...identity, attemptId: held }, "pnpm test", ["acceptance"], null, 1_000);
  });
  return { name, failed, held };
}

describe("the board's check detail", () => {
  it("returns the checked candidate, command and failing result, with the output as plain text", async () => {
    const { name, failed } = await repositoryWithAttempts();
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));

    expect(await board.checkDetail(failed)).toEqual({
      ok: true,
      value: {
        checkRunId: failed,
        candidate: CANDIDATE,
        expectedMain: MAIN,
        definitionDigest: DIGEST,
        command: "pnpm test",
        state: {
          kind: "reported",
          result: "fail",
          finishedAt: 1_500,
          logTail: "<b>1 failed</b>",
          logCut: false,
        },
      },
    });
  });

  it("returns a held attempt with the protected paths it edited", async () => {
    const { name, held } = await repositoryWithAttempts();
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));

    const detail = value(await board.checkDetail(held));

    expect(detail.state).toEqual({ kind: "held", paths: ["acceptance"] });
  });

  it("refuses a malformed id and a run the repository never recorded", async () => {
    const { name } = await repositoryWithAttempts();
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));

    expect(await board.checkDetail("chk_x")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await board.checkDetail(`chk_${"c".repeat(32)}`)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("does not show one repository's run through another repository's board", async () => {
    const { failed } = await repositoryWithAttempts();
    const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    value(await env.REPO.getByName(repoObjectName("acme", name)).initialize("acme", name));
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));

    expect(await board.checkDetail(failed)).toMatchObject({ ok: false, code: "not_found" });
  });
});
