import { describe, expect, it } from "vitest";
import {
  confirmLink,
  confirmTarget,
  phoneOrigin,
  questionLink,
  questionTarget,
} from "./phoneLinks";

describe("phoneOrigin", () => {
  it("accepts each reviewed instance by its exact origin", () => {
    expect(phoneOrigin("https://railhead.dev")).toBe("https://railhead.dev");
    expect(phoneOrigin("https://railhead.mashin.workers.dev")).toBe(
      "https://railhead.mashin.workers.dev",
    );
  });

  it("refuses every other origin, including look-alikes and plain HTTP", () => {
    for (const origin of [
      "http://localhost:8787",
      "http://railhead.dev",
      "https://railhead.dev.example.com",
      "https://www.railhead.dev",
      "https://railhead.dev:8443",
      "https://railhead.dev/",
      "https://RAILHEAD.dev",
      "null",
      "",
    ]) {
      expect(phoneOrigin(origin)).toBeNull();
    }
  });
});

describe("phone links", () => {
  it("name only the identifier, on the reviewed origin", () => {
    expect(questionLink("https://railhead.dev", "dec_synthsize")).toBe(
      "https://railhead.dev/question?decision=dec_synthsize",
    );
    expect(confirmLink("https://railhead.mashin.workers.dev", "agt_synthdune")).toBe(
      "https://railhead.mashin.workers.dev/confirm?agent=agt_synthdune",
    );
  });

  it("round-trip through the target parsers of their own route only", () => {
    const question = new URL(questionLink("https://railhead.dev", "dec_synthsize"));
    const confirm = new URL(confirmLink("https://railhead.dev", "agt_synthdune"));

    expect([...question.searchParams.keys()]).toEqual(["decision"]);
    expect(questionTarget(question.searchParams.get("decision"))).toEqual({
      kind: "id",
      id: "dec_synthsize",
    });
    expect([...confirm.searchParams.keys()]).toEqual(["agent"]);
    expect(confirmTarget(confirm.searchParams.get("agent"))).toEqual({
      kind: "id",
      id: "agt_synthdune",
    });
    // An identifier of the other kind does not open the other page.
    expect(confirmTarget("dec_synthsize")).toEqual({ kind: "invalid" });
    expect(questionTarget("agt_synthdune")).toEqual({ kind: "invalid" });
  });
});

describe("link targets", () => {
  it("accept identifier bodies from 6 to 64 letters or digits", () => {
    expect(questionTarget(`dec_${"a".repeat(6)}`).kind).toBe("id");
    expect(questionTarget(`dec_${"a".repeat(64)}`).kind).toBe("id");
    expect(questionTarget(`dec_${"a".repeat(5)}`)).toEqual({ kind: "invalid" });
    expect(questionTarget(`dec_${"a".repeat(65)}`)).toEqual({ kind: "invalid" });
  });

  it("refuse missing, non-string and malformed values", () => {
    for (const value of [
      undefined,
      null,
      123456,
      ["dec_synthsize"],
      "",
      "dec_synth size",
      "dec_synthsize&agent=agt_synthdune",
      "<script>",
    ]) {
      expect(questionTarget(value)).toEqual({ kind: "invalid" });
      expect(confirmTarget(value)).toEqual({ kind: "invalid" });
    }
  });
});
