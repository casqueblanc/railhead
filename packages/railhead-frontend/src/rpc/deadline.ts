// A call over an open WebSocket can stay pending without the session breaking, so every call the
// board waits on before it can show anything carries a deadline.

/** How long the board waits for one backend call before treating it as failed. */
export const CALL_DEADLINE_MS = 15_000;

/** A call that did not settle before its deadline. */
export class DeadlineExceeded extends Error {
  constructor() {
    super("The backend did not answer in time.");
    this.name = "DeadlineExceeded";
  }
}

/**
 * Settles like `call`, or rejects with `DeadlineExceeded` once `ms` pass first. A value that
 * arrives after the deadline is passed to `onLate` instead, so a capability it carries is released
 * rather than leaked.
 */
export const withDeadline = <T>(
  call: PromiseLike<T>,
  onLate: (value: T) => void = () => {},
  ms: number = CALL_DEADLINE_MS,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new DeadlineExceeded());
    }, ms);
    Promise.resolve(call).then(
      (value) => {
        if (expired) {
          onLate(value);
          return;
        }
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (expired) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
