import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { describe, test } from "node:test";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { gatePasses, judgeReport } from "./evidence.ts";
import { type LiveInstance, confirmSlice, readLog, withBoard } from "./live.ts";
import { HISTORY, JUDGED_AT, event, liveSliceReport, sha, sliceLog } from "./reportFixtures.ts";

/** What the fake instance holds: the repository's real log and its check runs. */
interface InstanceState {
  events: ReturnType<typeof event>[];
  history: string;
  checkRuns: Map<string, unknown>;
  /** Most events one page returns, below `MAX_EVENT_PAGE` so the reader must page. */
  pageSize: number;
  /** Refuses to open the repository. */
  refuse?: boolean;
  /** Never answers `readEvents`. */
  hang?: boolean;
}

class FakeBoard extends RpcTarget {
  readonly state: InstanceState;

  constructor(state: InstanceState) {
    super();
    this.state = state;
  }

  readEvents(cursor: number, limit: number, history?: string): Promise<unknown> {
    const { state } = this;
    if (state.hang === true) return new Promise(() => {});
    if (history !== undefined && history !== state.history) {
      return Promise.resolve({ ok: false, code: "cursor_ahead", message: "reset" });
    }
    const events = state.events
      .filter((item) => item.seq > cursor)
      .slice(0, Math.min(limit, state.pageSize));
    return Promise.resolve({
      ok: true,
      value: {
        repo: "rep_board1",
        events,
        cursor: events.at(-1)?.seq ?? cursor,
        head: state.events.at(-1)?.seq ?? 0,
        history: state.history,
      },
    });
  }

  checkDetail(checkRunId: string): Promise<unknown> {
    const detail = this.state.checkRuns.get(checkRunId);
    return Promise.resolve(
      detail === undefined
        ? { ok: false, code: "not_found", message: "gone" }
        : { ok: true, value: detail },
    );
  }
}

class FakeInstance extends RpcTarget {
  readonly state: InstanceState;

  constructor(state: InstanceState) {
    super();
    this.state = state;
  }

  openBoard(org: string, name: string): Promise<unknown> {
    if (this.state.refuse === true || `${org}/${name}` !== "acme/upload-app") {
      return Promise.resolve({ ok: false, code: "not_found", message: "no such repository" });
    }
    return Promise.resolve({ ok: true, value: new FakeBoard(this.state) });
  }
}

/** The run that landed the two-claim batch in `sliceLog`, as the instance records it. */
const batchRun = {
  checkRunId: "chk_000002",
  candidate: sha("d"),
  expectedMain: sha("c"),
  definitionDigest: "0".repeat(64),
  command: "pnpm test",
  state: { kind: "reported", result: "pass", finishedAt: 0, logTail: "", logCut: false },
};

/** The deployed instance the genuine report was read from: the slice and five later events. */
function liveState(overrides: Partial<InstanceState> = {}): InstanceState {
  const filler = [16, 17, 18, 19, 20].map((seq) =>
    event(seq, "issue.filed", { issueId: `iss_00000${seq}` }),
  );
  return {
    events: [...sliceLog(), ...filler],
    history: HISTORY,
    checkRuns: new Map([[batchRun.checkRunId, batchRun]]),
    pageSize: 7,
    ...overrides,
  };
}

/** Confirms `report` against a fake instance served over a real Cap'n Web session. */
async function confirm(report: unknown, state: InstanceState, timeoutMs?: number) {
  const channel = new MessageChannel();
  newMessagePortRpcSession(channel.port2, new FakeInstance(state));
  const api = newMessagePortRpcSession<LiveInstance>(channel.port1);
  try {
    const checks = await confirmSlice(report, api, timeoutMs);
    return Object.fromEntries(checks.map((item) => [item.id, item]));
  } finally {
    api[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  }
}

/** The genuine report with its checks recorded, as `qualify-slice.mjs slice` writes it. */
function written(report: ReturnType<typeof liveSliceReport>) {
  return { ...report, checks: judgeReport(report, JUDGED_AT).slice(0, -2) };
}

/**
 * A report consistent with itself and with every offline check, for a batch that never landed: its
 * candidate and main are replaced throughout.
 */
function forged() {
  const report = liveSliceReport();
  const text = JSON.stringify(report).replaceAll(sha("d"), sha("e"));
  return written(JSON.parse(text));
}

describe("confirmSlice", () => {
  test("confirms a genuine report against the instance it was read from", async () => {
    const checks = await confirm(written(liveSliceReport()), liveState());
    assert.equal(checks["slice.live-log"]?.outcome, "pass", checks["slice.live-log"]?.detail);
    assert.equal(checks["slice.live-check"]?.outcome, "pass");
    assert.match(checks["slice.live-check"]?.detail ?? "", /^1 of 1 landed batches/);
  });

  test("confirms a genuine report after the log has grown", async () => {
    const state = liveState();
    state.events.push(event(21, "train.main", { intentId: "int_000003", main: sha("9") }));
    const checks = await confirm(written(liveSliceReport()), state);
    assert.equal(checks["slice.live-log"]?.outcome, "pass");
    assert.equal(checks["slice.live-check"]?.outcome, "pass");
  });

  test("fails a forged report that passes every offline check", async () => {
    const report = forged();
    assert.equal(gatePasses(judgeReport(report, JUDGED_AT)), true);
    const checks = await confirm(report, liveState());
    assert.equal(checks["slice.live-log"]?.outcome, "fail");
    assert.match(checks["slice.live-log"]?.detail ?? "", /first 20 events differ/);
    assert.equal(checks["slice.live-check"]?.outcome, "fail");
    assert.match(checks["slice.live-check"]?.detail ?? "", /^0 of 1/);
  });

  test("fails a report whose events sit at other positions or hide a token", async () => {
    const shifted = liveSliceReport();
    shifted.observations.events = sliceLog().map((item) => ({ ...item, seq: item.seq + 1 }));
    shifted.observations.eventCount = 21;
    const state = liveState();
    state.events.push(event(21, "issue.filed", { issueId: "iss_000021" }));
    assert.equal(gatePasses(judgeReport(written(shifted), JUDGED_AT)), true);
    assert.equal((await confirm(written(shifted), state))["slice.live-log"]?.outcome, "fail");

    const leaked = liveState();
    leaked.events[16] = event(17, "issue.filed", { body: `art_v1_${"x".repeat(20)}` });
    assert.equal(
      (await confirm(written(liveSliceReport()), leaked))["slice.live-log"]?.outcome,
      "fail",
    );
  });

  test("fails when the log is shorter than the report or under another history", async () => {
    const short = liveState();
    short.events = short.events.slice(0, 18);
    assert.equal(
      (await confirm(written(liveSliceReport()), short))["slice.live-log"]?.outcome,
      "fail",
    );

    const reset = await confirm(written(liveSliceReport()), liveState({ history: "hist_reset" }));
    assert.equal(reset["slice.live-log"]?.outcome, "fail");
    assert.match(reset["slice.live-log"]?.detail ?? "", /refused a page of the event log/);
    assert.equal(reset["slice.live-check"]?.outcome, "fail");
  });

  test("fails when the instance no longer records the batch's check run as recorded", async () => {
    for (const checkRuns of [
      new Map(),
      new Map([[batchRun.checkRunId, { ...batchRun, candidate: sha("e") }]]),
      new Map([[batchRun.checkRunId, { ...batchRun, state: { kind: "started", deadline: 0 } }]]),
      new Map([
        [batchRun.checkRunId, { ...batchRun, state: { ...batchRun.state, result: "fail" } }],
      ]),
    ]) {
      const checks = await confirm(written(liveSliceReport()), liveState({ checkRuns }));
      assert.equal(checks["slice.live-log"]?.outcome, "pass");
      assert.equal(checks["slice.live-check"]?.outcome, "fail");
    }
  });

  test("fails when the instance refuses the repository or does not answer", async () => {
    const refused = await confirm(written(liveSliceReport()), liveState({ refuse: true }));
    assert.match(refused["slice.live-log"]?.detail ?? "", /refused to open acme\/upload-app/);
    assert.equal(refused["slice.live-check"]?.outcome, "fail");

    const silent = await confirm(written(liveSliceReport()), liveState({ hang: true }), 50);
    assert.match(silent["slice.live-log"]?.detail ?? "", /readEvents did not answer within 50 ms/);

    const malformed = await confirm({ kind: "slice", observations: {} }, liveState());
    assert.equal(malformed["slice.live-log"]?.outcome, "fail");
  });
});

describe("readLog", () => {
  test("pages the whole log and stops at a bound", async () => {
    const state = liveState();
    const channel = new MessageChannel();
    newMessagePortRpcSession(channel.port2, new FakeInstance(state));
    const api = newMessagePortRpcSession<LiveInstance>(channel.port1);
    try {
      const whole = await withBoard(api, "acme", "upload-app", (board) => readLog(board));
      assert.deepEqual(
        whole.events.map((item) => (item as { seq: number }).seq),
        state.events.map((item) => item.seq),
      );
      assert.equal(whole.head, 20);
      assert.equal(whole.history, HISTORY);
      const bounded = await withBoard(api, "acme", "upload-app", (board) =>
        readLog(board, { upTo: 9, history: HISTORY }),
      );
      assert.equal(bounded.events.length, 9);
    } finally {
      api[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
