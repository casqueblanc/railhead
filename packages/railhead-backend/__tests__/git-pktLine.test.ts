import { describe, expect, it } from "vitest";
import {
  MAX_RECEIVE_HEAD_BYTES,
  MAX_REF_BYTES,
  ReceivePackHeadParser,
  describeHeadFailure,
  readReceivePackHead,
  receivePackRefusal,
  uploadPackError,
  type HeadParse,
  type ReceivePackHead,
} from "../src/git/pktLine";
import { pkt } from "./sliceWorld";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const SHALLOW = "3".repeat(40);
const ZERO = "0".repeat(40);
const CAPS = "report-status side-band-64k agent=git/2.47.0";
const FLUSH = "0000";
const PACK = "PACK\u0000\u0000\u0000\u0002not inspected";

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function commandLine(ref: string): string {
  return pkt(`${OLD} ${NEW} ${ref}\n`);
}

function parseAll(body: Uint8Array | string, maxHeadBytes?: number): HeadParse {
  const parser = new ReceivePackHeadParser(maxHeadBytes);
  const result = parser.push(typeof body === "string" ? bytes(body) : body);
  return result.kind === "incomplete" ? parser.end() : result;
}

function completeHead(result: HeadParse): ReceivePackHead {
  if (result.kind !== "complete")
    throw new TypeError(`expected a complete head, got ${result.kind}`);
  return result.head;
}

/** A stream that hands out `chunks` one per pull and records whether it was cancelled. */
function sourceOf(chunks: readonly Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
} {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulls: () => index, cancelled: () => cancelled };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return decoder.decode(await new Response(stream).arrayBuffer());
}

/** Splits pkt-lines, returning each payload, or `null` for a flush. */
function packets(data: Uint8Array): (Uint8Array | null)[] {
  const out: (Uint8Array | null)[] = [];
  let at = 0;
  while (at < data.length) {
    const length = Number.parseInt(decoder.decode(data.subarray(at, at + 4)), 16);
    out.push(length === 0 ? null : data.subarray(at + 4, at + length));
    at += length === 0 ? 4 : length;
  }
  expect(at).toBe(data.length);
  return out;
}

/** Splits a side-band response into its band 1 and band 2 data, checking each packet's size. */
function demux(data: Uint8Array, packetMax: number): { report: Uint8Array; progress: string } {
  const report: number[] = [];
  let progress = "";
  const all = packets(data);
  expect(all.at(-1)).toBeNull();
  for (const payload of all.slice(0, -1)) {
    if (payload === null) throw new TypeError("unexpected flush inside the side band");
    expect(payload.length + 4).toBeLessThanOrEqual(packetMax);
    if (payload[0] === 1) report.push(...payload.subarray(1));
    else if (payload[0] === 2) progress += decoder.decode(payload.subarray(1));
    else throw new TypeError(`unexpected band ${payload[0]}`);
  }
  return { report: Uint8Array.from(report), progress };
}

function reportLines(report: Uint8Array): (string | null)[] {
  return packets(report).map((payload) => (payload === null ? null : decoder.decode(payload)));
}

describe("ReceivePackHeadParser", () => {
  it("reads one update with its capabilities and stops at the flush", () => {
    const head = pkt(`${OLD} ${NEW} refs/heads/main\0${CAPS}\n`) + FLUSH;
    const result = parseAll(head + PACK);
    expect(result).toEqual({
      kind: "complete",
      head: {
        updates: [{ kind: "update", oldId: OLD, newId: NEW, ref: "refs/heads/main" }],
        capabilities: ["report-status", "side-band-64k", "agent=git/2.47.0"],
        pushOptions: [],
        headBytes: bytes(head).length,
      },
    });
  });

  it("skips the shallow prelude a depth-1 clone sends before its commands", () => {
    const head =
      pkt(`shallow ${SHALLOW}\n`) +
      pkt(`shallow ${"4".repeat(40)}\n`) +
      pkt(`${OLD} ${NEW} refs/heads/agent/a\0${CAPS}\n`) +
      pkt(`${OLD} ${NEW} refs/heads/agent/b\n`) +
      FLUSH;
    const parsed = completeHead(parseAll(head + PACK));
    expect(parsed.updates.map((update) => update.ref)).toEqual([
      "refs/heads/agent/a",
      "refs/heads/agent/b",
    ]);
    expect(parsed.capabilities).toContain("report-status");
    expect(parsed.headBytes).toBe(bytes(head).length);
  });

  it("reads the head Git 2.50 sent when pushing from a depth-1 clone", () => {
    // Captured from `git push -o ci.skip -o 'note=hi there'` with an update, a creation and a
    // deletion. Git writes commands and options without a trailing newline.
    const base = "68674c62b3d05a25fba9b283c23517af271b80e5";
    const tip = "98175b78afb412d9c926ca8ebbc3cd6fda159490";
    const old = "86d31f33b13ce3cf37cc1ae27b4aeee60367360b";
    const head =
      `0035shallow ${base}\n` +
      `00c3${base} ${tip} refs/heads/main\0 report-status-v2 side-band-64k quiet push-options object-format=sha1 agent=git/2.50.1-Darwin` +
      `0064${old} ${ZERO} refs/heads/old` +
      `0064${ZERO} ${tip} refs/heads/new` +
      "0000000bci.skip0011note=hi there0000";
    expect(parseAll(head + PACK)).toEqual({
      kind: "complete",
      head: {
        updates: [
          { kind: "update", oldId: base, newId: tip, ref: "refs/heads/main" },
          { kind: "delete", oldId: old, newId: ZERO, ref: "refs/heads/old" },
          { kind: "create", oldId: ZERO, newId: tip, ref: "refs/heads/new" },
        ],
        capabilities: [
          "report-status-v2",
          "side-band-64k",
          "quiet",
          "push-options",
          "object-format=sha1",
          "agent=git/2.50.1-Darwin",
        ],
        pushOptions: ["ci.skip", "note=hi there"],
        headBytes: 484,
      },
    });
  });

  it("accepts shallow lines with no commands, as Git sends for a shallow push with nothing new", () => {
    const parsed = completeHead(parseAll(pkt(`shallow ${SHALLOW}\n`) + FLUSH));
    expect(parsed.updates).toEqual([]);
  });

  it("refuses a shallow line after a command or with a bad object ID", () => {
    expect(
      parseAll(pkt(`${OLD} ${NEW} refs/heads/main\n`) + pkt(`shallow ${SHALLOW}\n`) + FLUSH),
    ).toEqual({ kind: "refused", reason: "bad-shallow" });
    expect(parseAll(pkt(`shallow ${"g".repeat(40)}\n`) + FLUSH)).toEqual({
      kind: "refused",
      reason: "bad-shallow",
    });
    expect(
      parseAll(pkt(`shallow ${"3".repeat(64)}\n`) + pkt(`${OLD} ${NEW} refs/heads/main\n`) + FLUSH),
    ).toEqual({
      kind: "refused",
      reason: "bad-command",
    });
  });

  it("classifies creations and deletions", () => {
    const parsed = completeHead(
      parseAll(
        pkt(`${ZERO} ${NEW} refs/heads/new\0report-status delete-refs\n`) +
          pkt(`${OLD} ${ZERO} refs/heads/gone\n`) +
          FLUSH,
      ),
    );
    expect(parsed.updates).toEqual([
      { kind: "create", oldId: ZERO, newId: NEW, ref: "refs/heads/new" },
      { kind: "delete", oldId: OLD, newId: ZERO, ref: "refs/heads/gone" },
    ]);
    expect(parsed.capabilities).toEqual(["report-status", "delete-refs"]);
  });

  it("refuses a command whose old and new IDs are both zero", () => {
    expect(parseAll(pkt(`${ZERO} ${ZERO} refs/heads/main\n`) + FLUSH)).toEqual({
      kind: "refused",
      reason: "bad-command",
    });
  });

  it("reads Git's 0000 probe as a head with no updates", () => {
    expect(parseAll(FLUSH)).toEqual({
      kind: "complete",
      head: { updates: [], capabilities: [], pushOptions: [], headBytes: 4 },
    });
  });

  it("reads SHA-256 object IDs", () => {
    const old256 = "a".repeat(64);
    const parsed = completeHead(
      parseAll(pkt(`${old256} ${"b".repeat(64)} refs/heads/main\0object-format=sha256\n`) + FLUSH),
    );
    expect(parsed.updates[0]).toEqual({
      kind: "update",
      oldId: old256,
      newId: "b".repeat(64),
      ref: "refs/heads/main",
    });
  });

  it("reads push options when the client negotiated them", () => {
    const head =
      pkt(`${OLD} ${NEW} refs/heads/main\0report-status push-options\n`) +
      FLUSH +
      pkt("ci.skip") +
      pkt("railhead.note=hello world\n") +
      FLUSH;
    const parsed = completeHead(parseAll(head + PACK));
    expect(parsed.pushOptions).toEqual(["ci.skip", "railhead.note=hello world"]);
    expect(parsed.headBytes).toBe(bytes(head).length);
  });

  it("treats bytes after the flush as the pack when push options were not negotiated", () => {
    const head = pkt(`${OLD} ${NEW} refs/heads/main\0report-status\n`) + FLUSH;
    const parsed = completeHead(parseAll(head + pkt("ci.skip") + FLUSH));
    expect(parsed.pushOptions).toEqual([]);
    expect(parsed.headBytes).toBe(bytes(head).length);
  });

  it("refuses a push option holding a control character", () => {
    expect(
      parseAll(pkt(`${OLD} ${NEW} refs/heads/main\0push-options\n`) + FLUSH + pkt("a\0b") + FLUSH),
    ).toEqual({ kind: "refused", reason: "bad-push-option" });
  });

  it("leaves push option policy to the gateway", () => {
    const SUPPORTED = new Set(["ci.skip"]);
    const head = completeHead(
      parseAll(
        pkt(`${OLD} ${NEW} refs/heads/main\0report-status side-band-64k push-options\n`) +
          FLUSH +
          pkt("ci.skip") +
          pkt("merge_request.create") +
          FLUSH,
      ),
    );
    const unsupported = head.pushOptions.filter((option) => !SUPPORTED.has(option));
    expect(unsupported).toEqual(["merge_request.create"]);
    const { report, progress } = demux(
      receivePackRefusal(
        head,
        `railhead: unsupported push option ${unsupported.join(", ")}`,
        () => "unsupported push option",
      ),
      65520,
    );
    expect(progress).toBe("railhead: unsupported push option merge_request.create\n");
    expect(reportLines(report)).toEqual([
      "unpack ok\n",
      "ng refs/heads/main unsupported push option\n",
      null,
    ]);
  });

  it("gives the same result however the body is split", () => {
    const body = bytes(
      pkt(`shallow ${SHALLOW}\n`) +
        pkt(`${OLD} ${NEW} refs/heads/main\0report-status push-options\n`) +
        FLUSH +
        pkt("ci.skip") +
        FLUSH +
        PACK,
    );
    const whole = parseAll(body);
    expect(whole.kind).toBe("complete");
    for (let split = 0; split <= body.length; split += 1) {
      const parser = new ReceivePackHeadParser();
      const first = parser.push(body.subarray(0, split));
      const second = parser.push(body.subarray(split));
      expect(first.kind === "complete" ? first : second).toEqual(whole);
    }
    const parser = new ReceivePackHeadParser();
    let result: HeadParse = { kind: "incomplete" };
    for (const byte of body) result = parser.push(Uint8Array.of(byte));
    expect(result).toEqual(whole);
  });

  it("keeps its result once the head is complete or refused", () => {
    const complete = new ReceivePackHeadParser();
    const first = complete.push(bytes(FLUSH));
    expect(complete.push(bytes("zzzz"))).toEqual(first);
    expect(complete.end()).toEqual(first);
    const refusedParser = new ReceivePackHeadParser();
    expect(refusedParser.push(bytes("zzzz"))).toEqual({ kind: "refused", reason: "bad-length" });
    expect(refusedParser.push(bytes(FLUSH))).toEqual({ kind: "refused", reason: "bad-length" });
  });

  it.each([
    ["non-hex length", "zzzz"],
    ["delimiter packet", "0001"],
    ["response-end packet", "0002"],
    ["three-byte length", "0003"],
    ["empty packet", "0004"],
    ["length beyond Git's largest packet", "fff1"],
  ])("refuses a %s", (_name, prefix) => {
    expect(parseAll(prefix + "x".repeat(8))).toEqual({ kind: "refused", reason: "bad-length" });
  });

  it.each([
    ["one field too many", `${OLD} ${NEW} refs/heads/main extra\n`],
    ["missing ref", `${OLD} ${NEW}\n`],
    ["ref outside refs/", `${OLD} ${NEW} HEAD\n`],
    ["uppercase object ID", `${OLD.toUpperCase().replace(/1/g, "A")} ${NEW} refs/heads/main\n`],
    ["mixed object ID lengths", `${OLD} ${"2".repeat(64)} refs/heads/main\n`],
    ["control character in a ref", `${OLD} ${NEW} refs/heads/a\tb\n`],
    ["NUL after the first command", `${OLD} ${NEW} refs/heads/a\n${OLD} ${NEW} refs/heads/b\0x\n`],
    ["ref longer than the bound", `${OLD} ${NEW} refs/${"a".repeat(MAX_REF_BYTES)}\n`],
  ])("refuses a command with %s", (_name, line) => {
    expect(parseAll(pkt(line) + FLUSH)).toEqual({ kind: "refused", reason: "bad-command" });
  });

  it("refuses a command that is not UTF-8", () => {
    const line = Uint8Array.from([...bytes(`${OLD} ${NEW} refs/heads/`), 0xff, 0x0a]);
    const body = Uint8Array.from([
      ...bytes((line.length + 4).toString(16).padStart(4, "0")),
      ...line,
      ...bytes(FLUSH),
    ]);
    expect(parseAll(body)).toEqual({ kind: "refused", reason: "bad-command" });
  });

  it("refuses a signed push", () => {
    expect(parseAll(pkt(`push-cert\0${CAPS}\n`) + pkt("certificate version 0.1\n"))).toEqual({
      kind: "refused",
      reason: "signed-push",
    });
  });

  it("refuses a body that ends inside the head", () => {
    const parser = new ReceivePackHeadParser();
    expect(parser.push(bytes(pkt(`${OLD} ${NEW} refs/heads/main\n`)))).toEqual({
      kind: "incomplete",
    });
    expect(parser.end()).toEqual({ kind: "refused", reason: "truncated" });
  });

  it("accepts a head of exactly the bound and refuses one byte more", () => {
    const fixed = bytes(commandLine("refs/heads/") + FLUSH).length;
    const max = 200;
    const fits = commandLine(`refs/heads/${"a".repeat(max - fixed)}`) + FLUSH;
    expect(bytes(fits).length).toBe(max);
    expect(completeHead(parseAll(fits, max)).headBytes).toBe(max);
    const over = commandLine(`refs/heads/${"a".repeat(max - fixed + 1)}`) + FLUSH;
    expect(parseAll(over, max)).toEqual({ kind: "refused", reason: "too-large" });
  });

  it("refuses a packet that would cross the bound before its bytes arrive", () => {
    const parser = new ReceivePackHeadParser(100);
    expect(parser.push(bytes("0200"))).toEqual({ kind: "refused", reason: "too-large" });
  });

  it("refuses a head of many short packets once they reach the bound", () => {
    const line = pkt(`shallow ${SHALLOW}\n`);
    const result = parseAll(line.repeat(Math.ceil(MAX_RECEIVE_HEAD_BYTES / line.length) + 1));
    expect(result).toEqual({ kind: "refused", reason: "too-large" });
  });
});

describe("readReceivePackHead", () => {
  it("returns the head and the whole body for forwarding", async () => {
    const text =
      pkt(`shallow ${SHALLOW}\n`) + pkt(`${OLD} ${NEW} refs/heads/main\0${CAPS}\n`) + FLUSH + PACK;
    const body = bytes(text);
    const chunks = [body.subarray(0, 3), body.subarray(3, 50), body.subarray(50)];
    const source = sourceOf(chunks);
    const result = await readReceivePackHead(source.stream);
    if (result.kind !== "complete") throw new TypeError(`expected complete, got ${result.kind}`);
    expect(result.head.updates).toEqual([
      { kind: "update", oldId: OLD, newId: NEW, ref: "refs/heads/main" },
    ]);
    expect(await readAll(result.body)).toBe(text);
    expect(source.cancelled()).toBe(false);
  });

  it("stops reading at the bound and cancels the body", async () => {
    const line = bytes(pkt(`shallow ${SHALLOW}\n`));
    const source = sourceOf(Array.from({ length: 10_000 }, () => line));
    const result = await readReceivePackHead(source.stream, 1000);
    expect(result).toEqual({ kind: "refused", reason: "too-large" });
    expect(source.cancelled()).toBe(true);
    expect(source.pulls()).toBeLessThanOrEqual(Math.ceil(1000 / line.length) + 2);
  });

  it("refuses a body that ends early and cancels it", async () => {
    const source = sourceOf([bytes(pkt(`${OLD} ${NEW} refs/heads/main\n`))]);
    expect(await readReceivePackHead(source.stream)).toEqual({
      kind: "refused",
      reason: "truncated",
    });
  });

  it("refuses malformed input and cancels the body", async () => {
    const source = sourceOf([bytes("zzzz"), bytes(PACK)]);
    expect(await readReceivePackHead(source.stream)).toEqual({
      kind: "refused",
      reason: "bad-length",
    });
    expect(source.cancelled()).toBe(true);
  });

  it("propagates a failure of the body stream", async () => {
    const failure = new Error("connection reset");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("00"));
        controller.error(failure);
      },
    });
    await expect(readReceivePackHead(stream)).rejects.toBe(failure);
  });
});

describe("describeHeadFailure", () => {
  it("names each failure for a gateway's error body", () => {
    expect(describeHeadFailure("signed-push")).toBe("signed pushes are not supported");
    expect(describeHeadFailure("too-large")).toBe("receive-pack command list is too large");
    expect(describeHeadFailure("truncated")).toBe(
      "request ended before the receive-pack command list did",
    );
  });
});

function headWith(capabilities: string[], refs: string[] = ["refs/heads/main"]): ReceivePackHead {
  return {
    updates: refs.map((ref) => ({ kind: "update", oldId: OLD, newId: NEW, ref })),
    capabilities,
    pushOptions: [],
    headBytes: 0,
  };
}

describe("receivePackRefusal", () => {
  it("writes the exact side-band 64k response Git prints", () => {
    const out = receivePackRefusal(
      headWith(["report-status", "side-band-64k"]),
      "railhead: claim lost",
      () => "railhead: stale claim",
    );
    expect(decoder.decode(out)).toBe(
      [
        "001a\u0002railhead: claim lost\n",
        "0044\u0001",
        "000eunpack ok\n",
        "002dng refs/heads/main railhead: stale claim\n",
        "0000",
        "0000",
      ].join(""),
    );
  });

  it("writes only the report when no side band was negotiated", () => {
    const out = receivePackRefusal(headWith(["report-status"]), "ignored", () => "locked");
    expect(reportLines(out)).toEqual(["unpack ok\n", "ng refs/heads/main locked\n", null]);
  });

  it("accepts report-status-v2 and writes an empty response when no report was asked", () => {
    const v2 = receivePackRefusal(headWith(["report-status-v2"]), "m", () => "no");
    expect(reportLines(v2)).toEqual(["unpack ok\n", "ng refs/heads/main no\n", null]);
    expect(receivePackRefusal(headWith([]), "m", () => "no")).toEqual(new Uint8Array(0));
  });

  it("splits the report across 1000-byte packets on the old side band", () => {
    const refs = Array.from({ length: 40 }, (_, index) => `refs/heads/agent/branch-${index}`);
    const out = receivePackRefusal(
      headWith(["report-status", "side-band"], refs),
      "m",
      () => "locked",
    );
    const { report, progress } = demux(out, 1000);
    expect(progress).toBe("m\n");
    const lines = reportLines(report);
    expect(lines).toHaveLength(42);
    expect(lines[40]).toBe("ng refs/heads/agent/branch-39 locked\n");
    expect(packets(out).length).toBeGreaterThan(3);
  });

  it("keeps a reason or message from forging another report line", () => {
    const out = receivePackRefusal(
      headWith(["report-status", "side-band-64k"], ["refs/heads/a", "refs/heads/b"]),
      "first\nsecond\rthird",
      (update) => (update.ref === "refs/heads/a" ? "bad\nok refs/heads/a" : ""),
    );
    const { report, progress } = demux(out, 65520);
    expect(progress).toBe("first\nsecond third\n");
    expect(reportLines(report)).toEqual([
      "unpack ok\n",
      "ng refs/heads/a bad ok refs/heads/a\n",
      "ng refs/heads/b refused\n",
      null,
    ]);
  });

  it("caps a reason at 256 characters", () => {
    const out = receivePackRefusal(headWith(["report-status"]), "m", () => "r".repeat(10_000));
    expect(reportLines(out)[1]).toBe(`ng refs/heads/main ${"r".repeat(256)}\n`);
  });
});

describe("uploadPackError", () => {
  it("writes an ERR packet", () => {
    expect(decoder.decode(uploadPackError("railhead: fetch refused"))).toBe(
      "0020ERR railhead: fetch refused\n",
    );
  });

  it("keeps the message on one capped line", () => {
    const out = decoder.decode(uploadPackError(`a\nb${"c".repeat(1000)}`));
    expect(out).toBe(
      `${(4 + 4 + 256 + 1).toString(16).padStart(4, "0")}ERR a b${"c".repeat(253)}\n`,
    );
  });
});
