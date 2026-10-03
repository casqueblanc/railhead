import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES } from "../src/sandbox/entry";
import { MAX_FRAME_BYTES, readBoundedExec } from "../src/sandbox/output";

const encoder = new TextEncoder();

/** One event as the SDK's container sends it on a streaming exec. */
function frame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
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

    expect(await readBoundedExec(stream, MAX_OUTPUT_BYTES)).toEqual({
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

    const result = await readBoundedExec(events(command(sustained(), 1)), MAX_OUTPUT_BYTES);

    expect(result.exitCode).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("x".repeat(MAX_OUTPUT_BYTES));
    expect(result.stderr).toBe("x".repeat(MAX_OUTPUT_BYTES));
  });

  it("cuts at a character boundary and keeps output exactly at the limit whole", async () => {
    // "é" is two bytes and "😀" four: a limit of 4 falls inside the second "é".
    const accented = await readBoundedExec(
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

    const emoji = await readBoundedExec(events(command([["stderr", "ab😀"]], 0)), 5);
    expect(emoji).toEqual({ exitCode: 0, stdout: "", stderr: "ab", truncated: true });

    const exact = await readBoundedExec(events(command([["stdout", "aé😀"]], 0)), 7);
    expect(exact).toEqual({ exitCode: 0, stdout: "aé😀", stderr: "", truncated: false });
  });

  it("refuses a stream that fails, ends early or is not the SDK's", async () => {
    const failed = events([frame({ type: "start" }), frame({ type: "error", error: "boom" })]);
    await expect(readBoundedExec(failed, MAX_OUTPUT_BYTES)).rejects.toThrow(
      "the command failed in the sandbox",
    );

    const cutOff = events([frame({ type: "start" }), frame({ type: "stdout", data: "half" })]);
    await expect(readBoundedExec(cutOff, MAX_OUTPUT_BYTES)).rejects.toThrow(
      "ended before the command completed",
    );

    const noExitCode = events([frame({ type: "complete" })]);
    await expect(readBoundedExec(noExitCode, MAX_OUTPUT_BYTES)).rejects.toThrow(
      "invalid exit code",
    );

    const unknown = events([frame({ type: "progress" })]);
    await expect(readBoundedExec(unknown, MAX_OUTPUT_BYTES)).rejects.toThrow("unknown event");
  });

  it("refuses a frame that never ends instead of buffering it", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(encoder.encode(`data: ${"x".repeat(1024 * 1024)}`));
      },
    });

    await expect(readBoundedExec(endless, MAX_OUTPUT_BYTES)).rejects.toThrow("oversized frame");
    expect(sent).toBeLessThanOrEqual(MAX_FRAME_BYTES / (1024 * 1024) + 2);
  });
});
