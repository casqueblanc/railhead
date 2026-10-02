// Acceptance for option B, chunk: tagged in checks.json. Run on the landed commit by the train.
import { describe, it } from "vitest";
import { checkElevenMegabytesInParts, checkNineMegabytesInOneRequest } from "./checks";
import { titleFor } from "./suite";
import { workerTarget } from "./target";

describe(titleFor("B"), () => {
  it("accepts an 11 MB upload in parts and stores the original bytes", async () => {
    await checkElevenMegabytesInParts(workerTarget);
  });

  it("still accepts a 9 MB upload in one request", async () => {
    await checkNineMegabytesInOneRequest(workerTarget);
  });
});
