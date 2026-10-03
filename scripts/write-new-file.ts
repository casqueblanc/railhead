// Creates a file that must not exist yet, so that whatever reads it finds either the whole text or
// no file: never a partial one, and never a file this write replaced.
//
// The text goes to a temporary file beside the target, is flushed and read back, and only then
// becomes the target through a hard link, which fails rather than replace a file that appeared in
// the meantime. The temporary file is removed on success and on every ordinary failure. A process
// killed partway can leave a `.<name>.<uuid>.partial` file beside the target, never a partial
// target; such a file is safe to delete. A file system without hard links fails the write.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The file operations `writeNewFile` uses. Tests pass a failing one. */
export type NewFileIo = Pick<typeof fs, "open" | "readFile" | "link" | "rm">;

/** What `writeNewFile` did. `leftover` names a temporary file it could not remove, if any. */
export type WriteNewFileResult =
  /** The target now holds the whole text. */
  | { kind: "written"; leftover: string | null }
  /** The target already existed and was left as it was. */
  | { kind: "exists"; leftover: string | null }
  /** The target was not created. `code` is the system error code, or `short_write`. */
  | { kind: "failed"; code: string; leftover: string | null };

/** Writes `text` to `path`, which must not exist, all at once. Never throws. */
export const writeNewFile = async (
  path: string,
  text: string,
  io: NewFileIo = fs,
): Promise<WriteNewFileResult> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.partial`);
  let linking = false;
  let outcome: { kind: "written" } | { kind: "exists" } | { kind: "failed"; code: string };
  try {
    const handle = await io.open(temporary, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await io.readFile(temporary, "utf8")) === text) {
      linking = true;
      await io.link(temporary, path);
      outcome = { kind: "written" };
    } else {
      outcome = { kind: "failed", code: "short_write" };
    }
  } catch (error) {
    const code = errorCode(error);
    outcome = linking && code === "EEXIST" ? { kind: "exists" } : { kind: "failed", code };
  }
  let leftover: string | null = null;
  try {
    await io.rm(temporary, { force: true });
  } catch {
    leftover = temporary;
  }
  return { ...outcome, leftover };
};

const errorCode = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";
