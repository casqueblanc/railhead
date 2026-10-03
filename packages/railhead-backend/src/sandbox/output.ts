// Command output, bounded where it arrives from the container.
//
// The SDK's buffered `exec` reads both pipes to the end before it returns, so a command that writes
// without limit would fill the container object's memory and then exceed the RPC limit on its way
// to the repository. Commands therefore run through the SDK's streaming exec, and this reader keeps
// at most `limit` bytes of each stream. Output past that is read and dropped until the command
// completes, so its exit code is still reported. The SDK does not enforce a streaming command's
// timeout, so the caller passes a signal that it aborts at the command's deadline; the reader then
// stops and rejects. A cut never splits a character, and the result says whether anything was cut.

import { parseSSEStream } from "@cloudflare/sandbox";

/**
 * The most bytes one event frame of the command stream may hold. The SDK usually sends one frame
 * per read from a pipe, but its first output frame can carry everything the command wrote before
 * the stream began, so frame size is not bounded upstream. A larger frame is refused rather than
 * parsed, and the command fails.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** A finished command's exit code and output, each stream cut to the reader's limit. */
export interface BoundedOutput {
  /** The process exit code. */
  exitCode: number;
  /** Standard output, at most the limit in UTF-8 bytes. */
  stdout: string;
  /** Standard error, at most the limit in UTF-8 bytes. */
  stderr: string;
  /** Whether either stream was cut. */
  truncated: boolean;
}

/**
 * Reads the SDK's event stream for one command until it completes, keeping at most `limit` bytes
 * of each output stream. Rejects when the stream reports an error, ends before the command
 * completes, sends something that is not one of the SDK's events, or `signal` aborts; in each case
 * the stream is cancelled.
 */
export async function readBoundedExec(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<BoundedOutput> {
  const stdout = new Retained(limit);
  const stderr = new Retained(limit);
  for await (const event of parseSSEStream<unknown>(stream.pipeThrough(boundFrames()), signal)) {
    if (typeof event !== "object" || event === null || !("type" in event)) {
      throw new Error("the command stream sent an invalid event");
    }
    switch (event.type) {
      case "start":
        break;
      case "stdout":
      case "stderr": {
        const data = "data" in event ? event.data : undefined;
        if (typeof data !== "string") throw new Error("the command stream sent invalid output");
        (event.type === "stdout" ? stdout : stderr).add(data);
        break;
      }
      case "complete": {
        const exitCode = "exitCode" in event ? event.exitCode : undefined;
        if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) {
          throw new Error("the command stream sent an invalid exit code");
        }
        return {
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
        };
      }
      // The error text comes from the container and is not passed on.
      case "error":
        throw new Error("the command failed in the sandbox");
      default:
        throw new Error("the command stream sent an unknown event");
    }
  }
  throw new Error("the command stream ended before the command completed");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One output stream: the first `limit` bytes are kept and the rest dropped. */
class Retained {
  readonly #limit: number;
  readonly #parts: string[] = [];
  #bytes = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: string): void {
    if (this.truncated || chunk === "") return;
    const bytes = encoder.encode(chunk);
    const room = this.#limit - this.#bytes;
    if (bytes.length <= room) {
      this.#parts.push(chunk);
      this.#bytes += bytes.length;
      return;
    }
    // Back off to the start of the character the limit falls inside, so none is split.
    let end = room;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    this.#parts.push(decoder.decode(bytes.subarray(0, end)));
    this.#bytes += end;
    this.truncated = true;
  }

  text(): string {
    return this.#parts.join("");
  }
}

/**
 * Passes the stream through unchanged, erroring it once a frame, the bytes up to a blank line,
 * grows past `MAX_FRAME_BYTES`, so the event parser never receives more than that. Each byte is
 * counted as it is read, so a chunk that holds a whole oversized frame, or that ends one, is refused
 * before it is passed on.
 */
function boundFrames(): TransformStream<Uint8Array, Uint8Array> {
  let frame = 0;
  let line = 0;
  return new TransformStream({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          if (line === 0) frame = 0;
          line = 0;
        } else if (byte !== 0x0d) {
          line += 1;
          frame += 1;
          if (frame > MAX_FRAME_BYTES)
            throw new Error("the command stream sent an oversized frame");
        }
      }
      controller.enqueue(chunk);
    },
  });
}
