// The outside world of the offline vertical slice: everything the assembled Worker reaches beyond
// workerd, replaced by fakes that model the measured behaviour. The `Repo` binding, its composed
// modules, the agent HTTP routes and the Git gateway are the real ones.
//
// - Artifacts: `FakeArtifacts` holds forks and their tokens; `FakeMainRepo` holds main's ref with
//   the compare-and-swap measured on #158. One namespace serves both, with every remote on the
//   Artifacts Git host so the merge module can locate it.
// - Git endpoint: a stubbed global `fetch` answers clone, fetch and push for any live token, and
//   hands main's receive-pack to `FakeMainRepo`.
// - Sandbox: a `SANDBOX` namespace whose objects answer the merge script's commands as Git would
//   for a clean merge, and record each command.
// - Checks: a `CHECKS` Workflow binding that records each run it is asked to create. The test
//   reports the run back through `Repo.reportCheck`, as the Workflow would.

import { vi } from "vitest";
import type { CommitSha } from "@railhead/shared/events";
import { FakeArtifacts } from "../src/artifacts/fake";
import { FakeMainRepo } from "../src/artifacts/mainRefFake";
import { CHECK_DEFINITION_PATH } from "../src/checks/definition";
import type { CheckRunParams } from "../src/checks/workflow";
import type { SandboxCommand } from "../src/sandbox/entry";
import type { BoundedOutput } from "../src/sandbox/output";

/** A fixed test account id; the Artifacts Git host is derived from it. */
export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/** The Artifacts Git host of `ACCOUNT_ID`. */
export const GIT_HOST = `${ACCOUNT_ID}.artifacts.cloudflare.net`;

/** The trusted check definition seeded on main. */
export const CHECK_DEFINITION = JSON.stringify({
  name: "test",
  command: "pnpm test",
  timeoutMs: 600_000,
});

const encoder = new TextEncoder();

/** A pkt-line, written by hand so the tests do not reuse the subject's encoder. */
export function pkt(payload: string): string {
  return (encoder.encode(payload).length + 4).toString(16).padStart(4, "0") + payload;
}

function noop(): void {}

/** A promise the test settles by hand. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The commit SHA made of one repeated hex digit or a short hex prefix padded with zeros. */
export function sha(prefix: string): CommitSha {
  return prefix.padEnd(40, prefix.length === 1 ? prefix : "0");
}

/** A tree entry as the binding's `readTree` returns it. */
interface TreeEntry {
  name: string;
  hash: string;
  type: "blob" | "tree";
  mode: string;
}

/** One `CHECKS.createBatch` instance the checks module asked for. */
export interface RequestedRun {
  readonly id: string;
  readonly params: CheckRunParams;
}

/** One command a sandbox ran. */
export interface RanCommand {
  readonly sandbox: string;
  readonly command: string;
}

/** One request the stubbed Git endpoint received. */
export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

/** A command that exited 0 with `stdout`. */
function done(stdout: string): BoundedOutput {
  return { exitCode: 0, stdout, stderr: "", truncated: false };
}

/** The fake world one slice run reaches. */
export class SliceWorld {
  /** Forks, their tokens and main's commits as forks see them. */
  readonly forks: FakeArtifacts;
  #main: FakeMainRepo | null = null;
  /** Every check run the checks module created. */
  readonly runs: RequestedRun[] = [];
  /** Every command any sandbox ran. */
  readonly commands: RanCommand[] = [];
  /** Every request the Git endpoint received. */
  readonly seen: SeenRequest[] = [];
  /** Sandboxes started and not retired. */
  readonly liveSandboxes = new Set<string>();
  /** Every candidate a clean compose printed, in order. */
  readonly candidates: CommitSha[] = [];
  /** When set, main's next update applies and its response is then lost on the way back. */
  loseNextMainResponse = false;
  readonly #definitionBlob = "d".repeat(40);
  readonly #railheadTree = "e".repeat(40);

  constructor() {
    this.forks = new FakeArtifacts(Date.now());
  }

  /** Main's ref: its tokens, its commit graph and its compare-and-swap. */
  get main(): FakeMainRepo {
    if (this.#main === null) throw new Error("main was not seeded");
    return this.#main;
  }

  /** Main's Artifacts repository name. */
  get mainName(): string {
    return this.main.name;
  }

  /** Creates main's repository holding `history`, oldest first. */
  seedMain(name: string, history: readonly CommitSha[]): void {
    this.forks.seed(name, [...history]);
    this.#main = new FakeMainRepo(name, history, Date.now());
  }

  /** The Artifacts remote of `repo`, as `info()` reports it. */
  remote(repo: string): string {
    return `https://${GIT_HOST}/git/railhead/${repo}.git`;
  }

  /** Adds `commit` to `fork`, as a push through the gateway would have stored it. */
  addToFork(fork: string, commit: CommitSha): void {
    const repo = this.forks.repos.get(fork);
    if (repo === undefined) throw new Error("no such fork");
    repo.commits.push(commit);
  }

  /** The plaintext of every token either fake minted, live or not. */
  allTokens(): string[] {
    const forkTokens = [...this.forks.repos.values()].flatMap((repo) =>
      repo.tokens.map((token) => token.plaintext),
    );
    return [...forkTokens, ...this.main.tokens.map((token) => token.plaintext)];
  }

  /** The Worker's bindings with Artifacts, the sandbox and the check Workflow replaced. */
  env(base: Env): Env {
    const replaced = { ...base };
    Reflect.set(replaced, "ARTIFACTS", { get: (name: string) => this.#open(name) });
    Reflect.set(replaced, "SANDBOX", this.#sandboxNamespace());
    Reflect.set(replaced, "CHECKS", {
      createBatch: async (batch: { id: string; params: CheckRunParams }[]) => {
        for (const { id, params } of batch) {
          if (!this.runs.some((run) => run.id === id)) this.runs.push({ id, params });
        }
        return [];
      },
    });
    Reflect.set(replaced, "CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID);
    return replaced;
  }

  /** Stubs the global `fetch` as the Artifacts Git endpoint. Restore with `vi.restoreAllMocks`. */
  stubGitEndpoint(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      this.seen.push({ method: request.method, url: request.url, authorization });
      if (url.host !== GIT_HOST) return new Response("unexpected host", { status: 500 });
      const repo = /^\/git\/railhead\/([^/]+)\.git\//.exec(url.pathname)?.[1];
      if (repo === undefined) return new Response("not found", { status: 404 });
      const service = url.searchParams.get("service");
      if (repo === this.mainName && request.method === "POST" && service === null) {
        if (url.pathname.endsWith("/git-receive-pack")) {
          // Main's ref: the CAS fake checks its own token when the body completes.
          const answer = await this.main.upstream(
            new Request(`${this.main.remote}/git-receive-pack`, {
              method: "POST",
              headers: request.headers,
              body: await request.arrayBuffer(),
              signal: request.signal,
            }),
          );
          if (!this.loseNextMainResponse) return answer;
          this.loseNextMainResponse = false;
          await answer.arrayBuffer();
          throw new TypeError("Network connection lost.");
        }
      }
      await request.arrayBuffer();
      if (!this.#accepts(authorization)) return new Response("bad token", { status: 401 });
      const head = this.#head(repo);
      if (request.method === "GET" && service !== null) {
        const capability = service === "git-receive-pack" ? "report-status" : "side-band-64k";
        return new Response(
          `${pkt(`# service=${service}\n`)}0000${pkt(`${head} refs/heads/main\0${capability}\n`)}0000`,
          { headers: { "content-type": `application/x-${service}-advertisement` } },
        );
      }
      if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
        return new Response(`${pkt("NAK\n")}PACK-bytes`, {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        // A fork push: the test names the branch and reads the status line back.
        return new Response(`${pkt("unpack ok\n")}${pkt("ok refs/heads/work\n")}0000`, {
          headers: { "content-type": "application/x-git-receive-pack-result" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
  }

  #accepts(authorization: string | null): boolean {
    const bearer = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
    if (this.forks.accepts(bearer)) return true;
    const now = Date.now();
    return this.main.tokens.some(
      (token) => token.plaintext === bearer && !token.revoked && token.expiresAtMs > now,
    );
  }

  #head(repo: string): string {
    if (repo === this.mainName) return this.main.main;
    return this.forks.repos.get(repo)?.commits.at(-1) ?? "0".repeat(40);
  }

  async #open(name: string): Promise<unknown> {
    const remote = this.remote(name);
    const fork = await this.forks.get(name);
    if (name !== this.mainName) {
      return Object.assign(fork, { info: async () => ({ remote }) });
    }
    const main = await this.main.get(name);
    // Main: tokens, history and `info` from main's ref; forking from the fork fake. Trees are
    // modelled just enough for the checks module to read the trusted definition and see that a
    // candidate leaves it unchanged.
    const handle: Disposable & Record<string, unknown> = {
      [Symbol.dispose]: () => {
        main[Symbol.dispose]();
        fork[Symbol.dispose]();
      },
      fork: fork.fork.bind(fork),
      createToken: main.createToken.bind(main),
      listTokens: main.listTokens.bind(main),
      revokeToken: main.revokeToken.bind(main),
      log: main.log.bind(main),
      info: async () => ({ ...(await main.info()), remote }),
      readCommit: async (hash: string) => {
        if (!this.main.commits.has(hash)) return null;
        const [log] = await main.log({ ref: hash, limit: 1 });
        return log === undefined ? null : { ...log, treeHash: `f${hash.slice(1)}` };
      },
      readTree: async (hash: string): Promise<TreeEntry[] | null> => {
        if (hash === this.#railheadTree) {
          return [{ name: "check.json", hash: this.#definitionBlob, type: "blob", mode: "100644" }];
        }
        if (!hash.startsWith("f")) return null;
        return [
          { name: ".railhead", hash: this.#railheadTree, type: "tree", mode: "040000" },
          { name: "app", hash: `a${hash.slice(1)}`, type: "tree", mode: "040000" },
        ];
      },
      readFile: async ({ path }: { ref: string; path: string }) =>
        path === CHECK_DEFINITION_PATH ? new Blob([CHECK_DEFINITION]) : null,
    };
    return handle;
  }

  #sandboxNamespace() {
    const sandbox = (name: string) => ({
      configure: async () => undefined,
      railheadStart: async () => {
        this.liveSandboxes.add(name);
      },
      railheadExec: async (command: SandboxCommand): Promise<BoundedOutput> => {
        this.commands.push({ sandbox: name, command: command.command });
        return this.#answer(command.command);
      },
      railheadRetire: async () => {
        this.liveSandboxes.delete(name);
      },
    });
    return {
      idFromName: (name: string) => name,
      get: (id: string) => sandbox(id),
    };
  }

  /** Git's answer to one merge script, for a clean merge of every pin. */
  #answer(command: string): BoundedOutput {
    if (command.includes("git merge -q --no-ff --no-edit")) {
      const [, base = ""] = /git checkout -q --detach '?([0-9a-f]{40})/.exec(command) ?? [];
      const pins = [...command.matchAll(/--no-edit -m '[^']*' '?([0-9a-f]{40})/g)].map(
        ([, pin = ""]) => pin,
      );
      // The candidate is a first-parent child of main, as `git merge --no-ff` makes it.
      const candidate = sha(`cafe${this.candidates.length + 1}`);
      this.candidates.push(candidate);
      this.main.commit(candidate, [base, ...pins]);
      return done(`${candidate}\n`);
    }
    if (command.includes("git push --porcelain --prune")) return done("discarded 1\n");
    return done("");
  }
}
