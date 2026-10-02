import { describe, expect, it } from "vitest";
import checks from "../acceptance/checks.json";
import { parseCheckDefinitions, selectSuite, suiteTitle } from "../acceptance/select";

const valid = {
  decision: "upload-size-limit",
  current: { option: "A", version: 1 },
  suites: [
    { option: "A", version: 1, file: "acceptance/option-a.test.ts" },
    { option: "B", version: 2, file: "acceptance/option-b.test.ts" },
  ],
};

describe("checks.json on this commit", () => {
  it("selects option A, version 1, by default", () => {
    const definitions = parseCheckDefinitions(checks);
    const suite = selectSuite(definitions, undefined);
    expect(suite).toEqual({ option: "A", version: 1, file: "acceptance/option-a.test.ts" });
    expect(suiteTitle(definitions, suite)).toBe("upload-size-limit option A v1");
  });
});

describe("selectSuite", () => {
  const definitions = parseCheckDefinitions(valid);

  it("selects the current option when nothing is named", () => {
    expect(selectSuite(definitions, undefined).option).toBe("A");
    expect(selectSuite(definitions, "").option).toBe("A");
  });

  it("selects a named option and version", () => {
    expect(selectSuite(definitions, "B@2")).toEqual({
      option: "B",
      version: 2,
      file: "acceptance/option-b.test.ts",
    });
  });

  it("refuses a version no suite is tagged with", () => {
    expect(() => selectSuite(definitions, "B@1")).toThrow(
      "No acceptance suite is tagged B@1 in checks.json.",
    );
  });

  it("refuses a malformed selection", () => {
    for (const selection of ["B", "C@1", "A@0", "a@1", " A@1", "A@1.5"]) {
      expect(() => selectSuite(definitions, selection)).toThrow(
        /^UPLOAD_ACCEPTANCE must look like/,
      );
    }
  });
});

describe("parseCheckDefinitions", () => {
  it("refuses a current option with no suite", () => {
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "B", version: 3 } })).toThrow(
      "No acceptance suite is tagged B@3 in checks.json.",
    );
  });

  it("refuses duplicate tags", () => {
    const suites = [...valid.suites, { option: "A", version: 1, file: "acceptance/other.test.ts" }];
    expect(() => parseCheckDefinitions({ ...valid, suites })).toThrow(
      "checks.json: suite tags must be unique.",
    );
  });

  it("refuses suite files outside acceptance/", () => {
    const suites = [{ option: "A", version: 1, file: "../escape.test.ts" }];
    expect(() => parseCheckDefinitions({ ...valid, suites })).toThrow(
      "checks.json suites[0]: file must be acceptance/<name>.test.ts.",
    );
  });

  it("refuses malformed values", () => {
    expect(() => parseCheckDefinitions(null)).toThrow(TypeError);
    expect(() => parseCheckDefinitions({ ...valid, decision: "" })).toThrow(TypeError);
    expect(() => parseCheckDefinitions({ ...valid, suites: [] })).toThrow(TypeError);
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "A", version: 0 } })).toThrow(
      "checks.json current: version must be a positive integer.",
    );
    expect(() => parseCheckDefinitions({ ...valid, current: { option: "C", version: 1 } })).toThrow(
      'checks.json current: option must be "A" or "B".',
    );
  });
});
