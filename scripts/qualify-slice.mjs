// The operator's qualification harness for A40 (#63): the live gate for the three-agent slice and the
// Artifacts behaviour main's ref and the token bound rely on. docs/slice-acceptance.md is the runbook.
//
//   node scripts/qualify-slice.mjs probe-config --namespace <qualification namespace> --dir <new dir>
//   node scripts/qualify-slice.mjs binding --probe <probe URL> --secrets <dir>/probe-secrets.json --namespace <qualification namespace> --out <file>
//   node scripts/qualify-slice.mjs slice --origin <instance> --repo <org>/<name> --clone <dir> --clone <dir> --clone <dir> --out <file>
//   node scripts/qualify-slice.mjs gate <report> <report>
//
// `probe-config` writes a Wrangler config and a secrets file for the throwaway probe Worker
// (packages/railhead-backend/qualify/probe.ts) and prints the commands that deploy and delete it.
// It deploys nothing. `binding` runs the #161 token-listing and #158 main-ref cases through that
// probe, on repositories the probe creates and deletes; it also reads the REST token listing, with
// the operator's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. `slice` reads a deployed instance's public
// event log and three agents' claim clones, and checks the run the agents made there. `gate` exits 0
// only when a binding report and a slice report are both present and every check in both passed.
//
// Nothing here talks to a simulator: `slice` refuses a loopback or reserved host and `binding`
// requires the probe's repositories to sit on a live Artifacts Git host, so a fake cannot pass.
// Reports hold commit ids, ids and counts; never a token, a session or event text. Exit codes: 0
// every check passed, 1 a check failed or a call failed, 2 the arguments are invalid.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { newWebSocketRpcSession } from "capnweb";
import { API_PATH } from "../packages/railhead-shared/src/api.ts";
import {
  ARTIFACTS_TOKEN,
  gatePasses,
  judgeListing,
  judgeMainRef,
  judgeRestActive,
  judgeSlice,
  landedBatches,
  originProblem,
  remoteProblem,
} from "./qualify/evidence.ts";

// Decoded, so a checkout path with a space or other escaped character resolves.
const ROOT = resolve(import.meta.dirname, "..");
const PROBE_SOURCE = join(ROOT, "packages/railhead-backend/qualify/probe.ts");
const BACKEND_CONFIG = join(ROOT, "packages/railhead-backend/wrangler.jsonc");

/** How long one probe case may take: the listing case waits out a 60 s token. */
const PROBE_TIMEOUT_MS = 180_000;
/** How long one Git command may take. */
const GIT_TIMEOUT_MS = 120_000;
/** How long one board call may take. */
const BOARD_TIMEOUT_MS = 30_000;
/** How long after an evicted update main is read: past the update token's 60 s lifetime. */
const EVICTION_WAIT_MS = 75_000;
/** The longest event log read. */
const MAX_EVENTS = 20_000;

const REPO_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** A refusal with a sentence for the operator. */
class HarnessFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "HarnessFailure";
    this.exitCode = exitCode;
  }
}

const usage = () =>
  new HarnessFailure(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("//   node "))
      .map((line) => line.slice(3))
      .join("\n"),
    2,
  );

const options = (argv, spec) => {
  try {
    return parseArgs({ args: argv, options: spec, strict: true, allowPositionals: true });
  } catch (error) {
    throw new HarnessFailure(error instanceof Error ? error.message : "bad arguments", 2);
  }
};

const required = (values, name) => {
  const value = values[name];
  if (typeof value !== "string" || value === "")
    throw new HarnessFailure(`--${name} is required`, 2);
  return value;
};

/** Writes `text` to a file that must not exist yet, readable by its owner only. */
const writeNew = (path, text) => {
  if (existsSync(path)) throw new HarnessFailure(`${path} already exists; choose a new file`, 2);
  writeFileSync(path, text, { mode: 0o600, flag: "wx" });
};

const writeReport = (path, report) => {
  writeNew(path, `${JSON.stringify(report, null, 2)}\n`);
  for (const item of report.checks) {
    process.stdout.write(
      `${item.outcome === "pass" ? "PASS" : "FAIL"} ${item.id}: ${item.detail}\n`,
    );
  }
  process.stdout.write(`${gatePasses(report.checks) ? "passed" : "failed"}; report in ${path}\n`);
  if (!gatePasses(report.checks)) process.exitCode = 1;
};

/**
 * Runs Git with `args`, never through a shell. `env` adds variables; a token passed this way stays
 * out of the process list. Resolves with exit code and output, which the caller never prints.
 */
const git = (args, { cwd, env = {}, input } = {}) =>
  new Promise((resolveRun) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolveRun({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const gitOk = async (args, opts) => {
  const ran = await git(args, opts);
  if (ran.code !== 0) throw new HarnessFailure(`git ${args[0]} failed (exit ${ran.code})`);
  return ran.stdout.trim();
};

/** Git configuration that sends `token` as a bearer header, through the environment only. */
const bearer = (token) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
});

// --- probe-config ------------------------------------------------------------------------------

const probeConfig = (argv) => {
  const { values } = options(argv, { namespace: { type: "string" }, dir: { type: "string" } });
  const namespace = required(values, "namespace");
  const dir = resolve(required(values, "dir"));
  if (!NAMESPACE.test(namespace) || namespace === "railhead") {
    throw new HarnessFailure("--namespace must be a qualification namespace, not railhead", 2);
  }
  if (existsSync(dir)) throw new HarnessFailure(`${dir} already exists; choose a new directory`, 2);
  const backend = readFileSync(BACKEND_CONFIG, "utf8");
  const date = /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/.exec(backend)?.[1];
  if (date === undefined) throw new HarnessFailure("no compatibility date in the backend config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = {
    name: "railhead-qual-probe",
    main: PROBE_SOURCE,
    compatibility_date: date,
    workers_dev: true,
    artifacts: [{ binding: "ARTIFACTS", namespace }],
    durable_objects: { bindings: [{ name: "EVICTION", class_name: "EvictionProbe" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["EvictionProbe"] }],
  };
  const configPath = join(dir, "wrangler.json");
  const secretsPath = join(dir, "probe-secrets.json");
  writeNew(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeNew(
    secretsPath,
    `${JSON.stringify({ PROBE_SECRET: randomBytes(36).toString("base64url") })}\n`,
  );
  process.stdout.write(
    [
      `wrote ${configPath} and ${secretsPath} (mode 600)`,
      "deploy the probe, from the repository root:",
      `  pnpm exec wrangler deploy --config ${configPath} --secrets-file ${secretsPath}`,
      "then run the binding cases against the URL it prints:",
      `  node scripts/qualify-slice.mjs binding --probe <URL> --secrets ${secretsPath} --namespace ${namespace} --out binding.json`,
      "and delete it afterwards:",
      `  pnpm exec wrangler delete --config ${configPath}`,
      "",
    ].join("\n"),
  );
};

// --- binding -----------------------------------------------------------------------------------

const probeClient = (url, secret) => async (name, body) => {
  const response = await fetch(new URL(name, url), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed === null) {
    const code = typeof parsed?.error === "string" ? parsed.error : `HTTP ${response.status}`;
    throw new HarnessFailure(`probe case ${name} failed (${code})`);
  }
  return parsed;
};

/**
 * The REST route's count of active tokens on `name`, or `null` when it could not be read. The API
 * token is sent to api.cloudflare.com only and never recorded.
 */
const restActiveCount = async (namespace, name) => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account || !/^[0-9a-f]{32}$/.test(account)) return null;
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(name)}/tokens`,
  );
  url.searchParams.set("state", "active");
  url.searchParams.set("per_page", "100");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
  }).catch(() => null);
  const body = await response?.json().catch(() => null);
  const total = body?.result_info?.total_count;
  return response?.ok === true && Number.isSafeInteger(total) ? total : null;
};

/** Makes the commit graph the main-ref cases move main along, in a scratch repository. */
const buildHistory = async (dir) => {
  const env = {
    GIT_AUTHOR_NAME: "qualify",
    GIT_AUTHOR_EMAIL: "qualify@railhead.invalid",
    GIT_COMMITTER_NAME: "qualify",
    GIT_COMMITTER_EMAIL: "qualify@railhead.invalid",
  };
  const run = (args) => gitOk(args, { cwd: dir, env });
  await run(["init", "-q", "-b", "main"]);
  const commit = async (message) => {
    await run(["commit", "-q", "--allow-empty", "-m", message]);
    return run(["rev-parse", "HEAD"]);
  };
  const line = [];
  for (let n = 1; n <= 5; n += 1) line.push(await commit(`c${n}`));
  const n1 = await commit("n1");
  const n2 = await commit("n2");
  const race = [];
  const after = [];
  for (let n = 1; n <= 4; n += 1) {
    await run(["checkout", "-q", "--detach", n2]);
    race.push(await commit(`race ${n}`));
    after.push(await commit(`after race ${n}`));
  }
  await run(["checkout", "-q", "--orphan", "unrelated"]);
  const unrelated = await commit("unrelated");
  const u2 = await commit("u2");
  const [c4, c5] = line.slice(3);
  // One branch per tip, so a single push carries every object.
  const refs = [
    `${c5}:refs/heads/main`,
    `${n2}:refs/heads/qualify/n2`,
    ...after.map((tip, index) => `${tip}:refs/heads/qualify/after-${index + 1}`),
    `${u2}:refs/heads/qualify/u2`,
  ];
  return { commits: { c4, c5, n1, n2, unrelated, race, after, u2 }, refs };
};

const binding = async (argv) => {
  const { values } = options(argv, {
    probe: { type: "string" },
    secrets: { type: "string" },
    namespace: { type: "string" },
    out: { type: "string" },
  });
  const probeUrl = required(values, "probe");
  const namespace = required(values, "namespace");
  if (!NAMESPACE.test(namespace))
    throw new HarnessFailure("--namespace is not a namespace name", 2);
  const out = required(values, "out");
  if (existsSync(out)) throw new HarnessFailure(`${out} already exists; choose a new file`, 2);
  const secret = JSON.parse(readFileSync(required(values, "secrets"), "utf8")).PROBE_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new HarnessFailure("--secrets has no PROBE_SECRET of at least 32 characters", 2);
  }
  if (originProblem(probeUrl) !== null)
    throw new HarnessFailure("--probe must be a deployed HTTPS URL", 2);
  const probe = probeClient(probeUrl, secret);
  const startedAt = new Date().toISOString();
  const created = [];
  const scratch = mkdtempSync(join(tmpdir(), "railhead-qualify-"));
  try {
    process.stderr.write("binding: token listing (about 75 s)\n");
    const listingRepo = await probe("create", {});
    created.push(listingRepo.repoId);
    const listing = await probe("listing", { repoId: listingRepo.repoId });
    const restActive = await restActiveCount(namespace, listingRepo.name);

    process.stderr.write("binding: main's ref\n");
    const main = await probe("create", {});
    created.push(main.repoId);
    const { commits, refs } = await buildHistory(scratch);
    await gitOk(["push", "-q", main.remote, ...refs], { cwd: scratch, env: bearer(main.token) });
    // Only the adapter's own tokens may be live from here on.
    await probe("revoke", { repoId: main.repoId, token: main.token });
    const update = (expected, next) => probe("update", { repoId: main.repoId, expected, next });
    const obs = { remote: main.remote };
    obs.rewind = await update(commits.c5, commits.c4);
    obs.unrelatedUpdate = await update(commits.c5, commits.unrelated);
    obs.forward = await update(commits.c5, commits.n1);
    obs.stale = await update(commits.c5, commits.n1);
    obs.lostResponse = await probe("lost-response", {
      repoId: main.repoId,
      expected: commits.n1,
      next: commits.n2,
    });
    obs.race = await probe("race", {
      repoId: main.repoId,
      expected: commits.n2,
      nexts: commits.race,
    });
    const winner = commits.race.indexOf(obs.race.main);
    const afterWinner = commits.after[winner] ?? commits.after[0];
    const foreign = await probe("mint", { repoId: main.repoId });
    obs.foreignToken = await update(obs.race.main, afterWinner);
    // Another writer moves main with its own token, then gives the token up.
    await gitOk(["push", "-q", "--force", main.remote, `${commits.unrelated}:refs/heads/main`], {
      cwd: scratch,
      env: bearer(foreign.plaintext),
    });
    await probe("revoke", { repoId: main.repoId, token: foreign.id });
    obs.foreignPush = await update(obs.race.main, afterWinner);
    obs.fence = await probe("fence", {
      repoId: main.repoId,
      expected: commits.unrelated,
      next: commits.u2,
    });
    process.stderr.write(`binding: eviction (about ${EVICTION_WAIT_MS / 1000} s)\n`);
    const evicted = await probe("evict", {
      repoId: main.repoId,
      expected: commits.unrelated,
      next: commits.u2,
    });
    const evictedAt = Date.now();
    await new Promise((done) => setTimeout(done, EVICTION_WAIT_MS));
    const after = await probe("main", { repoId: main.repoId });
    obs.eviction = { ...evicted, ...after, waitedMs: Date.now() - evictedAt };

    const remoteCheck = remoteProblem(listingRepo.remote);
    const checks = [
      {
        id: "listing.live",
        outcome: remoteCheck === null ? "pass" : "fail",
        detail: remoteCheck ?? "live Artifacts remote",
      },
      ...judgeListing(listing),
      judgeRestActive(listing.afterExpiry?.total, restActive),
      ...judgeMainRef(commits, obs),
    ];
    // Observations go in the report as recorded: ids, commit ids, statuses and counts only.
    writeReport(out, {
      kind: "binding",
      probe: new URL(probeUrl).host,
      startedAt,
      finishedAt: new Date().toISOString(),
      checks,
      commits,
      observations: { listing, ...obs, remote: undefined },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    for (const repoId of created) {
      await probe("delete", { repoId }).catch(() =>
        process.stderr.write(`binding: could not delete probe repository ${repoId}\n`),
      );
    }
  }
};

// --- slice -------------------------------------------------------------------------------------

const withTimeout = (promise, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new HarnessFailure(`${what} did not answer within ${BOARD_TIMEOUT_MS} ms`)),
      BOARD_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
};

/** Reads the repository's whole public event log over the board's session. */
const readLog = async (origin, org, name) => {
  const socketUrl = new URL(API_PATH, origin);
  socketUrl.protocol = "wss:";
  const api = newWebSocketRpcSession(socketUrl.href);
  let board = null;
  try {
    const opened = await withTimeout(api.openBoard(org, name), "openBoard");
    if (!opened.ok) throw new HarnessFailure(`the instance refused to open ${org}/${name}`);
    board = opened.value;
    const events = [];
    let cursor = 0;
    let history;
    while (events.length < MAX_EVENTS) {
      const page = await withTimeout(
        history === undefined
          ? board.readEvents(cursor, 256)
          : board.readEvents(cursor, 256, history),
        "readEvents",
      );
      if (!page.ok) throw new HarnessFailure("the instance refused a page of the event log");
      history = page.value.history;
      events.push(...page.value.events);
      if (page.value.events.length === 0 || page.value.cursor >= page.value.head) return events;
      cursor = page.value.cursor;
    }
    throw new HarnessFailure(`the event log is longer than ${MAX_EVENTS} events`);
  } finally {
    board?.[Symbol.dispose]();
    api[Symbol.dispose]();
  }
};

/** The credential the clone's own helper gives Git for `url`, kept in memory only. */
const credentialFor = async (clone, url) => {
  const { protocol, host, pathname } = new URL(url);
  const filled = await git(["credential", "fill"], {
    cwd: clone,
    input: `protocol=${protocol.replace(":", "")}\nhost=${host}\npath=${pathname.replace(/^\//, "")}\n\n`,
  });
  const field = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(filled.stdout)?.[1] ?? null;
  return { username: field("username"), password: field("password"), raw: filled.stdout };
};

const basic = ({ username, password }) =>
  `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`;

const countTokens = (text) => (text.match(new RegExp(ARTIFACTS_TOKEN.source, "g")) ?? []).length;

const observeClone = async (dir) => {
  const originUrl = await gitOk(["config", "--get", "remote.origin.url"], { cwd: dir });
  const identity = await gitOk(["config", "--get", "railhead.identity"], { cwd: dir });
  const listed = await git(["ls-remote", "origin"], { cwd: dir });
  const credential = await credentialFor(dir, originUrl);
  const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], { cwd: dir });
  const files = ["config", "FETCH_HEAD", "packed-refs"]
    .map((file) => join(gitDir, file))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"));
  const tokensFound = [credential.raw, listed.stdout, listed.stderr, ...files]
    .map(countTokens)
    .reduce((sum, count) => sum + count, 0);
  return {
    observation: { originUrl, identity, reachable: listed.code === 0, tokensFound },
    credential,
  };
};

/** A receive-pack request creating a branch, refused by the instance before it reaches Artifacts. */
const pushRequest = (url, credential) => {
  const zero = "0".repeat(40);
  const line = `${zero} ${"1".repeat(40)} refs/heads/qualify-denied\0report-status\n`;
  const pkt = `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}0000`;
  return fetch(`${url}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: basic(credential),
      "content-type": "application/x-git-receive-pack-request",
    },
    body: pkt,
    signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
  });
};

const slice = async (argv) => {
  const { values } = options(argv, {
    origin: { type: "string" },
    repo: { type: "string" },
    clone: { type: "string", multiple: true },
    out: { type: "string" },
  });
  const origin = required(values, "origin");
  const out = required(values, "out");
  if (existsSync(out)) throw new HarnessFailure(`${out} already exists; choose a new file`, 2);
  const [org, name, ...rest] = required(values, "repo").split("/");
  if (
    org === undefined ||
    name === undefined ||
    rest.length > 0 ||
    !REPO_SEGMENT.test(org) ||
    !REPO_SEGMENT.test(name)
  ) {
    throw new HarnessFailure("--repo must be <org>/<name>", 2);
  }
  const clones = values.clone ?? [];
  if (clones.length < 3)
    throw new HarnessFailure("give each of the three agents' clones with --clone", 2);
  const problem = originProblem(origin);
  if (problem !== null)
    throw new HarnessFailure(`--origin is not a deployed instance: ${problem}`, 2);
  const base = new URL(origin).origin;
  const upstreamUrl = `${base}/git/${org}/${name}.git`;

  const events = await readLog(base, org, name);
  const observed = [];
  for (const dir of clones) observed.push(await observeClone(resolve(dir)));
  const [first, second] = observed;
  const pushToMain = await pushRequest(upstreamUrl, first.credential);
  const otherClaim = await fetch(
    `${second.observation.originUrl}/info/refs?service=git-upload-pack`,
    {
      headers: { authorization: basic(first.credential) },
      signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
    },
  );
  const anonymous = await fetch(
    `${first.observation.originUrl}/info/refs?service=git-upload-pack`,
    { signal: AbortSignal.timeout(BOARD_TIMEOUT_MS) },
  );
  const mainLine = await git(["ls-remote", "upstream", "refs/heads/main"], {
    cwd: resolve(clones[0]),
  });
  const remoteMain = /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(mainLine.stdout)?.[1] ?? null;
  const checks = judgeSlice({
    origin: base,
    events,
    clones: observed.map((clone) => clone.observation),
    remoteMain,
    denials: {
      pushToMain: pushToMain.status === 403 ? "refused" : "accepted",
      otherClaim: otherClaim.status === 403 || otherClaim.status === 404 ? "refused" : "accepted",
      anonymousStatus: anonymous.status,
    },
  });
  writeReport(out, {
    kind: "slice",
    origin: base,
    repo: `${org}/${name}`,
    readAt: new Date().toISOString(),
    events: events.length,
    batches: landedBatches(events),
    remoteMain,
    checks,
  });
};

// --- gate --------------------------------------------------------------------------------------

const gate = (paths) => {
  if (paths.length === 0) throw usage();
  const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const kinds = new Set(reports.map((report) => report.kind));
  let passed = kinds.has("binding") && kinds.has("slice");
  if (!passed) process.stdout.write("FAIL gate: needs one binding report and one slice report\n");
  for (const [index, report] of reports.entries()) {
    const ok = Array.isArray(report.checks) && gatePasses(report.checks);
    passed &&= ok;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${report.kind} ${paths[index]}\n`);
  }
  process.stdout.write(passed ? "the live gate passed\n" : "the live gate did not pass\n");
  if (!passed) process.exitCode = 1;
};

try {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "probe-config":
      probeConfig(argv);
      break;
    case "binding":
      await binding(argv);
      break;
    case "slice":
      await slice(argv);
      break;
    case "gate":
      gate(argv);
      break;
    default:
      throw usage();
  }
} catch (error) {
  // Only this script's own sentences are printed: a library error can quote what a server sent.
  const failure =
    error instanceof HarnessFailure
      ? error
      : new HarnessFailure(
          `unexpected failure (${error instanceof Error ? error.name : "unknown"})`,
        );
  process.stderr.write(`qualify-slice: ${failure.message}\n`);
  process.exitCode = failure.exitCode;
}
