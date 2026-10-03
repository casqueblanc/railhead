import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES } from "../src/sandbox/entry";
import { MAX_FRAME_BYTES, readBoundedExec } from "../src/sandbox/output";

const encoder = new TextEncoder();

/** Reads with a signal that never aborts. */
function read(stream: ReadableStream<Uint8Array>, limit: number) {
  return readBoundedExec(stream, limit, new AbortController().signal);
}

/** One event as the SDK's container sends it on a streaming exec. */
function frame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** `parts` as one chunk. */
function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A stream of `frames`, produced one at a time as the reader pulls, so none is held in advance. */
function events(frames: Iterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = frames[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
  });
}

function* command(
  output: Iterable<["stdout" | "stderr", string]>,
  exitCode: number,
): Generator<Uint8Array> {
  yield frame({ type: "start", pid: 7 });
  for (const [type, data] of output) yield frame({ type, data });
  yield frame({ type: "complete", exitCode });
}

describe("readBoundedExec", () => {
  it("returns a command's exit code and both streams", async () => {
    const stream = events(
      command(
        [
          ["stdout", "built "],
          ["stderr", "warning\n"],
          ["stdout", "ok\n"],
        ],
        3,
      ),
    );

    expect(await read(stream, MAX_OUTPUT_BYTES)).toEqual({
      exitCode: 3,
      stdout: "built ok\n",
      stderr: "warning\n",
      truncated: false,
    });
  });

  it("keeps the limit of each stream from output past the RPC limit and still reports the exit code", async () => {
    // 33 MiB on each stream, more than one Workers RPC call may carry, written in pipe-sized reads.
    const chunk = "x".repeat(64 * 1024);
    const reads = (33 * 1024 * 1024) / chunk.length;
    function* sustained(): Generator<["stdout" | "stderr", string]> {
      for (let i = 0; i < reads; i += 1) {
        yield ["stdout", chunk];
        yield ["stderr", chunk];
      }
    }

    const result = await read(events(command(sustained(), 1)), MAX_OUTPUT_BYTES);

    expect(result.exitCode).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("x".repeat(MAX_OUTPUT_BYTES));
    expect(result.stderr).toBe("x".repeat(MAX_OUTPUT_BYTES));
  });

  it("cuts at a character boundary and keeps output exactly at the limit whole", async () => {
    // "é" is two bytes and "😀" four: a limit of 4 falls inside the second "é".
    const accented = await read(
      events(
        command(
          [
            ["stdout", "aé"],
            ["stdout", "é😀"],
          ],
          0,
        ),
      ),
      4,
    );
    expect(accented).toEqual({ exitCode: 0, stdout: "aé", stderr: "", truncated: true });

    const emoji = await read(events(command([["stderr", "ab😀"]], 0)), 5);
    expect(emoji).toEqual({ exitCode: 0, stdout: "", stderr: "ab", truncated: true });

    const exact = await read(events(command([["stdout", "aé😀"]], 0)), 7);
    expect(exact).toEqual({ exitCode: 0, stdout: "aé😀", stderr: "", truncated: false });
  });

  it("refuses a stream that fails, ends early or is not the SDK's", async () => {
    const failed = events([frame({ type: "start" }), frame({ type: "error", error: "boom" })]);
    await expect(read(failed, MAX_OUTPUT_BYTES)).rejects.toThrow(
      "the command failed in the sandbox",
    );

    const cutOff = events([frame({ type: "start" }), frame({ type: "stdout", data: "half" })]);
    await expect(read(cutOff, MAX_OUTPUT_BYTES)).rejects.toThrow(
      "ended before the command completed",
    );

    const noExitCode = events([frame({ type: "complete" })]);
    await expect(read(noExitCode, MAX_OUTPUT_BYTES)).rejects.toThrow("invalid exit code");

    const unknown = events([frame({ type: "progress" })]);
    await expect(read(unknown, MAX_OUTPUT_BYTES)).rejects.toThrow("unknown event");
  });

  it("refuses a frame that never ends instead of buffering it", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(encoder.encode(`data: ${"x".repeat(1024 * 1024)}`));
      },
    });

    await expect(read(endless, MAX_OUTPUT_BYTES)).rejects.toThrow("oversized frame");
    expect(sent).toBeLessThanOrEqual(MAX_FRAME_BYTES / (1024 * 1024) + 2);
  });

  it("refuses a complete frame past the limit before parsing it, wherever the frame ends", async () => {
    const big = "x".repeat(MAX_FRAME_BYTES);
    const start = frame({ type: "start" });
    const complete = frame({ type: "complete", exitCode: 0 });

    // The whole oversized event, delimiter included, in one chunk.
    const whole = events([start, join(frame({ type: "stdout", data: big }), complete)]);
    await expect(read(whole, MAX_OUTPUT_BYTES)).rejects.toThrow("oversized frame");

    // Under the limit in one chunk, crossing it in the chunk that ends the frame.
    const event = frame({ type: "stdout", data: big });
    const split = events([start, event.subarray(0, 1024), join(event.subarray(1024), complete)]);
    await expect(read(split, MAX_OUTPUT_BYTES)).rejects.toThrow("oversized frame");

    // A small event after the large one in the same chunk resets the count only after the check.
    const trailing = events([start, join(event, frame({ type: "stdout", data: "ok" }), complete)]);
    await expect(read(trailing, MAX_OUTPUT_BYTES)).rejects.toThrow("oversized frame");
  });

  it("passes a frame exactly at the limit", async () => {
    // `data: ` and the JSON around the output count toward the frame.
    const overhead = encoder.encode(`data: ${JSON.stringify({ type: "stdout", data: "" })}`).length;
    const atLimit = frame({ type: "stdout", data: "x".repeat(MAX_FRAME_BYTES - overhead) });
    const result = await read(
      events([atLimit, frame({ type: "complete", exitCode: 0 })]),
      MAX_OUTPUT_BYTES,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "x".repeat(MAX_OUTPUT_BYTES),
      stderr: "",
      truncated: true,
    });
  });

  it("stops reading and cancels the stream when its signal aborts", async () => {
    let cancelled = false;
    // A command that keeps writing and never completes.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(frame({ type: "stdout", data: "tick\n" }));
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);

    await expect(readBoundedExec(endless, MAX_OUTPUT_BYTES, abort.signal)).rejects.toThrow(
      "aborted",
    );
    expect(cancelled).toBe(true);
  });
});
