import { describe, expect, it } from "vitest";
import checks from "../acceptance/checks.json";
import { parseCheckDefinitions, selectSuite, suiteTitle } from "../acceptance/select";

const valid = {
  decision: "upload-size-limit",
  current: { option: "a", version: 1 },
  suites: [
    { option: "a", version: 1, file: "acceptance/option-a.test.ts" },
    { option: "b", version: 2, file: "acceptance/option-b.test.ts" },
  ],
};

describe("checks.json on this commit", () => {
  it("selects option a, version 1, by default", () => {
    const definitions = parseCheckDefinitions(checks);
    const suite = selectSuite(definitions, undefined);
    expect(suite).toEqual({ option: "a", version: 1, file: "acceptance/option-a.test.ts" });
    expect(suiteTitle(definitions, suite)).toBe("upload-size-limit option a v1");
  });
});

describe("selectSuite", () => {
  const definitions = parseCheckDefinitions(valid);

  it("selects the current option when nothing is named", () => {
    expect(selectSuite(definitions, undefined).option).toBe("a");
    expect(selectSuite(definitions, "").option).toBe("a");
  });

  it("selects a named option and version", () => {
    expect(selectSuite(definitions, "b@2")).toEqual({
      option: "b",
      version: 2,
      file: "acceptance/option-b.test.ts",
    });
  });

  it("refuses a version no suite is tagged with", () => {
    expect(() => selectSuite(definitions, "b@1")).toThrow(
      "No acceptance suite is tagged b@1 in checks.json.",
    );
  });

  it("refuses a malformed selection", () => {
    for (const selection of ["b", "c@1", "a@0", "A@1", " a@1", "a@1.5"]) {
      expect(() => selectSuite(definitions, selection)).toThrow(
        /^UPLOAD_ACCEPTANCE must look like/,
      );
    }
  });
});

describe("parseCheckDefinitions", () => {
  it("refuses a current option with no suite", () => {
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "b", version: 3 } })).toThrow(
      "No acceptance suite is tagged b@3 in checks.json.",
    );
  });

  it("refuses duplicate tags", () => {
    const suites = [...valid.suites, { option: "a", version: 1, file: "acceptance/other.test.ts" }];
    expect(() => parseCheckDefinitions({ ...valid, suites })).toThrow(
      "checks.json: suite tags must be unique.",
    );
  });

  it("refuses suite files outside acceptance/", () => {
    const suites = [{ option: "a", version: 1, file: "../escape.test.ts" }];
    expect(() => parseCheckDefinitions({ ...valid, suites })).toThrow(
      "checks.json suites[0]: file must be acceptance/<name>.test.ts.",
    );
  });

  it("refuses malformed values", () => {
    expect(() => parseCheckDefinitions(null)).toThrow(TypeError);
    expect(() => parseCheckDefinitions({ ...valid, decision: "" })).toThrow(TypeError);
    expect(() => parseCheckDefinitions({ ...valid, suites: [] })).toThrow(TypeError);
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "a", version: 0 } })).toThrow(
      "checks.json current: version must be a positive integer.",
    );
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "c", version: 1 } })).toThrow(
      'checks.json current: option must be "a" or "b".',
    );
    // Option keys are lowercase on the agent wire, so the tags are too.
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "A", version: 1 } })).toThrow(
      'checks.json current: option must be "a" or "b".',
    );
  });
});
