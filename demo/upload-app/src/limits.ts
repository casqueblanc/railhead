/** One megabyte as the page and the decision count it: 10^6 bytes. */
export const MB = 1_000_000;

/** The largest upload accepted in one request. Option A rejects anything above it. */
export const MAX_UPLOAD_BYTES = 10 * MB;

/** The exact message option A returns, with status 413, for a file above the limit. */
export const TOO_LARGE_MESSAGE = "Files above 10 MB are not accepted";

/**
 * Bytes per stored row. SQLite-backed Durable Objects cap a value at 2 MB, so a file is stored as
 * rows of at most this size.
 */
export const PART_BYTES = 1024 * 1024;
