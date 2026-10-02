import { describe, expect, it } from "vitest";
import { firstDifference, generateBody, sha256Hex } from "../acceptance/bodies";

describe("generateBody", () => {
  it("produces the same bytes for the same seed", async () => {
    const body = generateBody(9_000_000, 9);
    expect(body.byteLength).toBe(9_000_000);
    expect(await sha256Hex(body)).toBe(await sha256Hex(generateBody(9_000_000, 9)));
    // First xorshift32 outputs from seed 1: 270369, 67634689, 2647435461, low bytes only.
    expect([...generateBody(3, 1)]).toEqual([0x21, 0x01, 0xc5]);
  });

  it("produces different bytes for different seeds", () => {
    expect(firstDifference(generateBody(1024, 9), generateBody(1024, 11))).not.toBe(-1);
  });

  it("produces an empty body for size 0", () => {
    expect(generateBody(0).byteLength).toBe(0);
  });

  it("rejects a negative or fractional size and an out-of-range seed", () => {
    expect(() => generateBody(-1)).toThrow(RangeError);
    expect(() => generateBody(1.5)).toThrow(RangeError);
    expect(() => generateBody(1, 0)).toThrow(RangeError);
    expect(() => generateBody(1, 2 ** 32)).toThrow(RangeError);
  });
});

describe("firstDifference", () => {
  it("finds the first changed byte, or the shorter length", () => {
    expect(firstDifference(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(-1);
    expect(firstDifference(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(1);
    expect(firstDifference(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(2);
    expect(firstDifference(new Uint8Array(), new Uint8Array())).toBe(-1);
  });
});
