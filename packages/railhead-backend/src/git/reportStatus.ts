// Reads the report a receive-pack response carries, while the response streams to the client, so
// the gateway records a pushed ref only when the upstream itself reported it updated. Each
// side-band packet is held only until it is complete, and the report itself is capped; anything
// that does not parse as a report leaves the outcome unknown, which records nothing.

/** The longest report the reader keeps, in bytes: about 100 bytes per ref, as for the head. */
const MAX_REPORT_BYTES = 64 * 1024;

/** Git's largest pkt-line, length prefix included. */
const LARGE_PACKET_MAX = 65520;

const HEX_LENGTH = /^[0-9a-f]{4}$/;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** What the upstream reported about a push. */
export type PushReport =
  /** The pack was unpacked and these refs were updated. */
  | { readonly kind: "reported"; readonly updated: ReadonlySet<string> }
  /** The report was missing, refused the pack or could not be read: nothing is known to be updated. */
  | { readonly kind: "unknown" };

const UNKNOWN: PushReport = { kind: "unknown" };

/** How the report is framed, from the capabilities the client sent. */
export type ReportFraming = "side-band" | "plain" | "none";

/** The framing of the report for a push that asked for `capabilities`. */
export function reportFraming(capabilities: readonly string[]): ReportFraming {
  if (!capabilities.includes("report-status") && !capabilities.includes("report-status-v2")) {
    return "none";
  }
  return capabilities.includes("side-band-64k") || capabilities.includes("side-band")
    ? "side-band"
    : "plain";
}

/** Splits a byte stream into pkt-lines, holding at most one packet at a time. */
class PacketSplitter {
  #pending: Uint8Array = new Uint8Array(0);

  /** Returns the complete packets in `chunk`, `null` for a flush, or `"bad"` on bad framing. */
  push(chunk: Uint8Array): (Uint8Array | null)[] | "bad" {
    let data = concat(this.#pending, chunk);
    const packets: (Uint8Array | null)[] = [];
    for (;;) {
      if (data.length < 4) break;
      const lengthText = latin1.decode(data.subarray(0, 4));
      if (!HEX_LENGTH.test(lengthText)) return "bad";
      const length = Number.parseInt(lengthText, 16);
      if (length === 0) {
        packets.push(null);
        data = data.subarray(4);
        continue;
      }
      if (length <= 4 || length > LARGE_PACKET_MAX) return "bad";
      if (data.length < length) break;
      packets.push(data.subarray(4, length));
      data = data.subarray(length);
    }
    this.#pending = data.slice();
    return packets;
  }

  /** Whether bytes of an unfinished packet remain. */
  get pending(): boolean {
    return this.#pending.length > 0;
  }
}

/**
 * Feeds the response of one receive-pack request, chunk by chunk, and answers what it reported
 * once the response has ended. A report counts only if it is complete, its pack unpacked, and
 * nothing in the side band signalled a fatal error.
 */
export class PushReportReader {
  readonly #framing: ReportFraming;
  readonly #outer = new PacketSplitter();
  readonly #inner = new PacketSplitter();
  #reportBytes = 0;
  #failed = false;
  #lines: string[] = [];
  #reportDone = false;

  constructor(framing: ReportFraming) {
    this.#framing = framing;
    if (framing === "none") this.#failed = true;
  }

  /** Reads the next chunk of the response. */
  push(chunk: Uint8Array): void {
    if (this.#failed) return;
    switch (this.#framing) {
      case "plain":
        this.#report(chunk);
        return;
      case "side-band":
        this.#sideBand(chunk);
        return;
      case "none":
        return;
      default:
        this.#framing satisfies never;
    }
  }

  /** The outcome, once the response has ended. */
  end(): PushReport {
    if (this.#failed || !this.#reportDone || this.#outer.pending || this.#inner.pending) {
      return UNKNOWN;
    }
    const [unpack, ...rest] = this.#lines;
    if (unpack !== "unpack ok") return UNKNOWN;
    const updated = new Set<string>();
    // report-status-v2 follows an `ok` line with `option` lines when the server changed what the
    // client asked for; such a ref's outcome is not the one requested, so it counts as unknown.
    const rewritten = new Set<string>();
    // Each ref has exactly one status line; a second one, even `ng` after `ok`, is a protocol error.
    const reported = new Set<string>();
    let last: string | null = null;
    for (const line of rest) {
      if (line.startsWith("ok ")) {
        last = line.slice("ok ".length);
        if (reported.has(last)) return UNKNOWN;
        reported.add(last);
        updated.add(last);
      } else if (line.startsWith("ng ")) {
        const ref = line.slice("ng ".length).split(" ", 1)[0] ?? "";
        if (reported.has(ref)) return UNKNOWN;
        reported.add(ref);
        last = null;
      } else if (line.startsWith("option ")) {
        if (last !== null) rewritten.add(last);
      } else {
        return UNKNOWN;
      }
    }
    for (const ref of rewritten) updated.delete(ref);
    return { kind: "reported", updated };
  }

  #sideBand(chunk: Uint8Array): void {
    const packets = this.#outer.push(chunk);
    if (packets === "bad") {
      this.#failed = true;
      return;
    }
    for (const packet of packets) {
      // The outer flush ends the response; the report must already be complete by then.
      if (packet === null) continue;
      const band = packet[0];
      if (band === 1) this.#report(packet.subarray(1));
      // Band 2 is progress, shown to the client; band 3 is a fatal error.
      else if (band === 3) this.#failed = true;
      else if (band !== 2) this.#failed = true;
      if (this.#failed) return;
    }
  }

  #report(data: Uint8Array): void {
    if (this.#reportDone) {
      // Nothing but the side band's own framing may follow a finished report.
      if (data.length > 0) this.#failed = true;
      return;
    }
    this.#reportBytes += data.length;
    if (this.#reportBytes > MAX_REPORT_BYTES) {
      this.#failed = true;
      return;
    }
    const packets = this.#inner.push(data);
    if (packets === "bad") {
      this.#failed = true;
      return;
    }
    for (const packet of packets) {
      if (this.#reportDone) {
        this.#failed = true;
        return;
      }
      if (packet === null) {
        this.#reportDone = true;
        continue;
      }
      let line: string;
      try {
        line = utf8.decode(packet);
      } catch {
        this.#failed = true;
        return;
      }
      this.#lines.push(line.endsWith("\n") ? line.slice(0, -1) : line);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
