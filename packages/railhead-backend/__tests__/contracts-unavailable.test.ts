import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { unavailable, type PortName } from "../src/contracts/result";
import {
  unavailableArtifacts,
  unavailableAuthorization,
  unavailableChecks,
  unavailableClaims,
  unavailableDecisions,
  unavailableIdentity,
  unavailableInbox,
  unavailableMainRef,
  unavailableMainWriter,
  unavailableMerge,
  unavailableSessions,
  unavailableTrain,
} from "../src/contracts/unavailable";
import { composeRepo } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName } from "../src/repo/RepoObject";

const PORTS: [PortName, object][] = [
  ["identity", unavailableIdentity],
  ["sessions", unavailableSessions],
  ["claims", unavailableClaims],
  ["inbox", unavailableInbox],
  ["decisions", unavailableDecisions],
  ["artifacts", unavailableArtifacts],
  ["merge", unavailableMerge],
  ["checks", unavailableChecks],
  ["train", unavailableTrain],
  ["authorization", unavailableAuthorization],
  ["mainWriter", unavailableMainRef],
  ["mainWriter", unavailableMainWriter],
];

/** The synchronous fence readers, and what each reports while its module is missing. */
const READERS = new Map<string, unknown>([
  ["claims.currentGeneration", null],
  ["decisions.currentVersions", null],
  ["train.attemptOutcome", null],
]);

/** The methods the Repo's alarm calls, which resolve with nothing while their module is missing. */
const RESUMERS = new Set(["train.resume"]);

describe("unavailable ports", () => {
  it("refuse every async method with their own port's unavailable and report nothing from readers", async () => {
    const readers = new Map<string, unknown>();
    for (const [port, implementation] of PORTS) {
      for (const [method, fn] of Object.entries(implementation)) {
        if (typeof fn !== "function") throw new TypeError(`${port}.${method} is not a method`);
        const result: unknown = Reflect.apply(fn, implementation, ["clm_claim001", 0]);
        if (RESUMERS.has(`${port}.${method}`)) {
          // The alarm's resume owes nothing while the module is missing, so it refuses nothing.
          expect(await result, `${port}.${method}`).toBeUndefined();
        } else if (result instanceof Promise) {
          expect(await result, `${port}.${method}`).toEqual(unavailable(port));
        } else {
          readers.set(`${port}.${method}`, result);
        }
      }
    }

    // Exactly the three fence readers are synchronous, and each reports unknown rather than an
    // attempt, a generation or a decision list, which would let a caller treat it as current.
    expect(readers).toEqual(READERS);
  });

  it("give authorization nothing to pass inside a Repo transaction, and write nothing", async () => {
    const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stub = env.REPO.getByName(repoObjectName("acme", name));
    const summary = await stub.initialize("acme", name);
    if (!summary.ok) throw new Error(summary.code);
    const repoId = summary.value.repoId;

    const { read, appended, head, authorized } = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const log = EventLog.open(state.storage, repoId);
        const ports = composeRepo({
          repoId,
          storage: state.storage,
          log,
          clock: () => 0,
          env,
          wake: () => {},
        });
        // A30's fence reads these in the transaction that would write the intent. Each must say
        // unknown (`null`), never a generation or an empty decision list a record could match,
        // including for an empty claim id.
        const committed = log.transaction(() => ({
          attempt: ports.train.attemptOutcome("chk_attempt1"),
          generations: [
            ports.claims.currentGeneration("clm_claim001"),
            ports.claims.currentGeneration(""),
          ],
          decisions: ports.decisions.currentVersions("clm_claim001"),
        }));
        return {
          read: committed.value,
          appended: committed.events.length,
          head: log.head(),
          authorized: await ports.authorization.authorize("chk_attempt1"),
        };
      },
    );

    expect(read).toEqual({ attempt: null, generations: [null, null], decisions: null });
    expect(appended).toBe(0);
    expect(head).toBe(0);
    expect(authorized).toEqual(unavailable("authorization"));
  });
});
