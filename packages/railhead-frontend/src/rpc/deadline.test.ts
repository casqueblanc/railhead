import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_DEADLINE_MS, DeadlineExceeded, withDeadline } from "./deadline";

/** A call the test answers by hand. */
const handCall = () => {
  const answers: ((value: string) => void)[] = [];
  const promise = new Promise<string>((done) => {
    answers.push(done);
  });
  return {
    promise,
    resolve: (value: string) => {
      for (const answer of answers) answer(value);
    },
  };
};

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles with a call that answers in time and leaves no timer behind", async () => {
    await expect(withDeadline(Promise.resolve("page"))).resolves.toBe("page");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes on a call's own failure", async () => {
    await expect(withDeadline(Promise.reject(new Error("broken")))).rejects.toThrow("broken");
  });

  it("answers a call that settles one millisecond before its deadline", async () => {
    const call = handCall();
    const pending = withDeadline(call.promise);
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
    call.resolve("page");

    await expect(pending).resolves.toBe("page");
  });

  it("rejects a call still pending at its deadline and hands its late value to onLate", async () => {
    const call = handCall();
    const late: string[] = [];
    const outcome = withDeadline(call.promise, (value) => late.push(value)).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS);
    expect(await outcome).toBeInstanceOf(DeadlineExceeded);

    call.resolve("stub");
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toEqual(["stub"]);
  });
});
