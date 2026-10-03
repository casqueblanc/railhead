// Captures one repository's event log from a running Railhead into a replay file the board's
// /replay page opens offline.
//
//   node scripts/capture-replay.mjs --origin https://railhead.dev --repo <org>/<name> --out run.json
//
// It reads the public board log over the same Cap'n Web session the board uses (`openBoard`, then
// `readEvents` page by page) and needs no credential: it takes none, sends none and writes none.
// The origin is reduced to scheme, host and port, so a user name, password, path or query given
// with it never reaches the file. Each event is copied field by field and validated by the board's
// capture module before anything is written, and an existing file is never overwritten.
//
// The file is labelled `captured` with its origin, repository and time. Only a capture a person
// made this way from a real run may be called a captured run; development fixtures are labelled
// `synthetic` and never pass through this script.
//
// Output on stderr names counts and the file, never event content: agent and issue text in the log
// is untrusted.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { newWebSocketRpcSession } from "capnweb";
import { API_PATH } from "../packages/railhead-shared/src/api.ts";
import {
  captureErrorText,
  captureLog,
  serializeCapture,
} from "../packages/railhead-frontend/src/features/replay/captureFile.ts";

/** Longest a single backend call may take before the capture fails, in milliseconds. */
const CALL_TIMEOUT_MS = 30_000;

// `isRepoSegment` in `@railhead/shared/agent-api`, which `node` cannot load directly (its imports
// omit file extensions). The backend checks the names again in `openBoard`.
const REPO_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const USAGE =
  "usage: node scripts/capture-replay.mjs --origin <https://host> --repo <org>/<name> --out <file.json>";

/** A refusal with a sentence for the person running the script. */
class CaptureFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptureFailure";
  }
}

const parseOptions = (argv) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        origin: { type: "string" },
        repo: { type: "string" },
        out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new CaptureFailure(
      `${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}`,
    );
  }
  const { origin, repo, out } = values;
  if (origin === undefined || repo === undefined || out === undefined) {
    throw new CaptureFailure(USAGE);
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new CaptureFailure("--origin is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CaptureFailure("--origin must be an http or https URL");
  }
  const [org, name, ...rest] = repo.split("/");
  if (
    org === undefined ||
    name === undefined ||
    rest.length > 0 ||
    !REPO_SEGMENT.test(org) ||
    !REPO_SEGMENT.test(name)
  ) {
    throw new CaptureFailure("--repo must be <org>/<name>");
  }
  // Checked again when writing, with `wx`; this only saves a capture that could not be kept.
  if (existsSync(out)) throw new CaptureFailure(`${out} already exists; choose a new file`);
  return { origin: url.origin, org, name, out };
};

/** Settles with `promise`, or fails once `CALL_TIMEOUT_MS` passes. */
const withTimeout = (promise, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new CaptureFailure(`${what} did not answer within ${CALL_TIMEOUT_MS} ms`)),
      CALL_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
};

const capture = async ({ origin, org, name, out }) => {
  const socketUrl = new URL(API_PATH, origin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const api = newWebSocketRpcSession(socketUrl.href);
  let board = null;
  try {
    const opened = await withTimeout(api.openBoard(org, name), "openBoard");
    if (!opened.ok) {
      throw new CaptureFailure(`the backend refused to open ${org}/${name} (${opened.code})`);
    }
    board = opened.value;
    const reader = {
      readEvents: (cursor, limit) => withTimeout(board.readEvents(cursor, limit), "readEvents"),
    };
    const result = await captureLog(reader, {
      kind: "captured",
      origin,
      org,
      name,
      capturedAt: Date.now(),
    });
    if (!result.ok) throw new CaptureFailure(captureErrorText(result.error));
    const serialized = serializeCapture(result.capture);
    if (!serialized.ok) throw new CaptureFailure(captureErrorText(serialized.error));
    try {
      await writeFile(out, serialized.text, { flag: "wx" });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      throw new CaptureFailure(
        `could not write ${out} (${code}); an existing file is never replaced`,
      );
    }
    return result.capture;
  } finally {
    board?.[Symbol.dispose]();
    api[Symbol.dispose]();
  }
};

try {
  const options = parseOptions(process.argv.slice(2));
  const captured = await capture(options);
  process.stderr.write(
    `captured ${captured.head} events of ${options.org}/${options.name} from ${options.origin} into ${options.out}\n`,
  );
} catch (error) {
  // Only this script's own sentences are printed: a library error can quote what the backend sent.
  const message =
    error instanceof CaptureFailure
      ? error.message
      : `the session with the backend failed (${error instanceof Error ? error.name : "unknown"})`;
  process.stderr.write(`capture-replay: ${message}\n`);
  process.exitCode = 1;
}
