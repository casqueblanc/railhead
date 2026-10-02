// The acceptance checks judged against apps whose behaviour is known: the real Worker (option A)
// and in-memory doubles of option B, faithful or faulty.
import { describe, expect, it } from "vitest";
import {
  AcceptanceFailure,
  checkElevenMegabytesInParts,
  checkElevenMegabytesRejected,
  checkNineMegabytesInOneRequest,
} from "../acceptance/checks";
import { workerTarget } from "../acceptance/target";
import { fakeChunkedApp, fixedResponseApp } from "./fakes";

describe("option B checks", () => {
  it("fail on the current app, which has no chunked uploads", async () => {
    await expect(checkElevenMegabytesInParts(workerTarget)).rejects.toThrow(
      new AcceptanceFailure(
        "Chunked uploads are not supported: POST /api/uploads/chunked returned 405, not 201.",
      ),
    );
  });

  it("pass on an app that reassembles the parts faithfully", async () => {
    const app = fakeChunkedApp();
    await expect(checkElevenMegabytesInParts(app)).resolves.toBeUndefined();
    await expect(checkNineMegabytesInOneRequest(app)).resolves.toBeUndefined();
  });

  it("catch a reassembled file with one changed byte", async () => {
    await expect(checkElevenMegabytesInParts(fakeChunkedApp("corrupt-byte"))).rejects.toThrow(
      new AcceptanceFailure(
        "The stored file differs from the original at byte 5500000 (stored 11000000 bytes, sent 11000000).",
      ),
    );
  });

  it("catch a reassembled file missing its last part", async () => {
    // 11 MB in 4 MB parts: the last part holds 3 MB, so 8 MB survive.
    await expect(checkElevenMegabytesInParts(fakeChunkedApp("drop-last-part"))).rejects.toThrow(
      new AcceptanceFailure(
        "The stored file differs from the original at byte 8000000 (stored 8000000 bytes, sent 11000000).",
      ),
    );
  });

  it("catch a file that does not survive a restart", async () => {
    await expect(checkElevenMegabytesInParts(fakeChunkedApp("forget-on-restart"))).rejects.toThrow(
      /^Reading upload fake-\d+ back returned 404\.$/,
    );
  });

  it("catch a server that does not split an 11 MB file", async () => {
    await expect(checkElevenMegabytesInParts(fakeChunkedApp("none", 10_000_000))).resolves.toBe(
      undefined,
    );
    await expect(checkElevenMegabytesInParts(fakeChunkedApp("none", 11_000_000))).rejects.toThrow(
      new AcceptanceFailure(
        "Starting a chunked upload returned no partSize between 1 byte and 10 MB.",
      ),
    );
  });
});

describe("option A checks", () => {
  it("pass on the current app", async () => {
    await expect(checkElevenMegabytesRejected(workerTarget)).resolves.toBeUndefined();
    await expect(checkNineMegabytesInOneRequest(workerTarget)).resolves.toBeUndefined();
  });

  it("fail on an app that accepts an 11 MB file", async () => {
    await expect(checkElevenMegabytesRejected(fakeChunkedApp())).rejects.toThrow(
      new AcceptanceFailure("An 11 MB upload returned 201, not 413."),
    );
  });

  it("fail on a 413 with a different message", async () => {
    const app = fixedResponseApp(413, { error: "Too large" });
    await expect(checkElevenMegabytesRejected(app)).rejects.toThrow(
      new AcceptanceFailure(
        'The 413 response says "Too large", not "Files above 10 MB are not accepted".',
      ),
    );
  });

  it("fail when a 9 MB upload is refused", async () => {
    const app = fixedResponseApp(413, { error: "Files above 10 MB are not accepted" });
    await expect(checkNineMegabytesInOneRequest(app)).rejects.toThrow(
      new AcceptanceFailure("A 9000000-byte upload in one request returned 413, not 201."),
    );
  });
});
