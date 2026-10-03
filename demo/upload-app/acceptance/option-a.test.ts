// Acceptance for option A, reject: tagged in checks.json. Run on the landed commit by the train.
import { describe, it } from "vitest";
import { checkElevenMegabytesRejected, checkNineMegabytesInOneRequest } from "./checks";
import { titleFor } from "./suite";
import { workerTarget } from "./target";

describe(titleFor("a"), () => {
  it("returns 413 with the exact message for an 11 MB upload", async () => {
    await checkElevenMegabytesRejected(workerTarget);
  });

  it("accepts a 9 MB upload and stores it intact", async () => {
    await checkNineMegabytesInOneRequest(workerTarget);
  });
});
