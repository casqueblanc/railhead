// Reads the report a receive-pack response carries, while the response streams to the client, so
// the gateway records a pushed ref only when the upstream itself reported it updated. Each
// side-band packet is held only until it is complete, and the report itself is capped; anything
// that does not parse as a report, or does not settle each ref the push sent, leaves the outcome
// unknown, which records nothing and leaves the push to reconciliation.

/** The longest report the reader keeps, in bytes: about 100 bytes per ref, as for the head. */
const MAX_REPORT_BYTES = 64 * 1024;

/** Git's largest pkt-line, length prefix included. */
const LARGE_PACKET_MAX = 65520;

const HEX_LENGTH = /^[0-9a-f]{4}$/;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** What the upstream reported about a push. */
export type PushReport =
  /** The pack was unpacked, every ref sent has one status, and these refs were updated. */
  | { readonly kind: "reported"; readonly updated: ReadonlySet<string> }
  /** The report was complete and said the pack was not unpacked: nothing was updated. */
  | { readonly kind: "refused" }
  /** The report was missing or could not be read: what the push updated is not known. */
  | { readonly kind: "unknown" };

const UNKNOWN: PushReport = { kind: "unknown" };
const REFUSED: PushReport = { kind: "refused" };

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
 * once the response has ended. A report counts only if it is complete, its pack unpacked, it gives
 * exactly one `ok` or `ng` for each ref the push sent and for no other, and nothing in the side
 * band signalled a fatal error.
 */
export class PushReportReader {
  readonly #framing: ReportFraming;
  readonly #refs: ReadonlySet<string>;
  readonly #outer = new PacketSplitter();
  readonly #inner = new PacketSplitter();
  #reportBytes = 0;
  #failed = false;
  #lines: string[] = [];
  #reportDone = false;

  /** `refs` are the refs the push sent, each once. */
  constructor(framing: ReportFraming, refs: readonly string[]) {
    this.#framing = framing;
    this.#refs = new Set(refs);
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
    if (unpack === undefined || !unpack.startsWith("unpack ")) return UNKNOWN;
    if (unpack !== "unpack ok") return REFUSED;
    const updated = new Set<string>();
    // Each ref has exactly one status line; a second one, even `ng` after `ok`, is a protocol error.
    const reported = new Set<string>();
    for (const line of rest) {
      let ref: string;
      if (line.startsWith("ok ")) {
        ref = line.slice("ok ".length);
        updated.add(ref);
      } else if (line.startsWith("ng ")) {
        ref = line.slice("ng ".length).split(" ", 1)[0] ?? "";
      } else {
        // report-status-v2 follows an `ok` line with `option` lines when the server changed what
        // the client asked for: the ref or commit it ended at is not the one requested.
        return UNKNOWN;
      }
      if (!this.#refs.has(ref) || reported.has(ref)) return UNKNOWN;
      reported.add(ref);
    }
    // A ref the report leaves out may have been updated or not.
    if (reported.size !== this.#refs.size) return UNKNOWN;
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
