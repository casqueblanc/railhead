// Reads the refs an upload-pack advertisement (Git protocol v0) lists, so the gateway can read a
// fork's branches back when it reconciles a push whose record it does not have. Only the refs
// asked for are kept, so memory is bounded by the question rather than by the fork; the bytes
// read are bounded by the caller.

import { PacketSplitter } from "./reportStatus";

const latin1 = new TextDecoder("latin1");
const ADVERTISED_REF = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/;

/** What an advertisement said about the refs asked for, once it has ended. */
export type AdvertisedRefs =
  /** The advertisement was whole: each ref asked for maps to its id, or is absent from the fork. */
  | { readonly kind: "read"; readonly refs: ReadonlyMap<string, string> }
  /** The advertisement was cut off or malformed: nothing is known. */
  | { readonly kind: "unreadable" };

const UNREADABLE: AdvertisedRefs = { kind: "unreadable" };

/** Feeds an upload-pack advertisement chunk by chunk and answers the ids of `wanted` refs. */
export class AdvertisedRefsReader {
  readonly #wanted: ReadonlySet<string>;
  readonly #packets = new PacketSplitter();
  readonly #refs = new Map<string, string>();
  #flushes = 0;
  #first = true;
  #failed = false;

  constructor(wanted: Iterable<string>) {
    this.#wanted = new Set(wanted);
  }

  /** Reads the next chunk. */
  push(chunk: Uint8Array): void {
    if (this.#failed) return;
    const packets = this.#packets.push(chunk);
    if (packets === "bad") {
      this.#failed = true;
      return;
    }
    for (const packet of packets) {
      if (!this.#line(packet)) {
        this.#failed = true;
        return;
      }
    }
  }

  /** The refs read, once the advertisement has ended. */
  end(): AdvertisedRefs {
    if (this.#failed || this.#flushes !== 2 || this.#packets.pending) return UNREADABLE;
    return { kind: "read", refs: this.#refs };
  }

  // The smart-HTTP advertisement is `# service=git-upload-pack`, a flush, the ref lines (the first
  // carrying capabilities after a NUL), and a final flush. Returns false on anything else.
  #line(packet: Uint8Array | null): boolean {
    if (packet === null) {
      this.#flushes += 1;
      return this.#flushes <= 2;
    }
    const text = latin1.decode(packet).replace(/\n$/, "");
    if (this.#flushes === 0) {
      if (!this.#first) return false;
      this.#first = false;
      return text === "# service=git-upload-pack";
    }
    if (this.#flushes !== 1) return false;
    const nul = text.indexOf("\0");
    const match = ADVERTISED_REF.exec(nul === -1 ? text : text.slice(0, nul));
    if (match === null) return false;
    const [, id, ref] = match;
    if (id !== undefined && ref !== undefined && this.#wanted.has(ref)) this.#refs.set(ref, id);
    return true;
  }
}
