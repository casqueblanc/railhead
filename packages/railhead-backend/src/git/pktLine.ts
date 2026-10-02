// The part of Git's pkt-line framing the gateways have to understand: the head of a receive-pack
// request (shallow lines, ref commands, capabilities and push options), and the refusals Git
// prints. The pack after the head is forwarded as opaque bytes and never inspected.
//
// Both the agent gateway and the sandbox gateway use this one parser, so a push either gateway
// accepts is read the same way by the other.

/** The largest head a gateway buffers: about 100 bytes per ref command, flush packets included. */
export const MAX_RECEIVE_HEAD_BYTES = 64 * 1024;

/** The longest ref name accepted, in bytes. Git sets no limit; this keeps refusal lines bounded. */
export const MAX_REF_BYTES = 4096;

/** Git's largest pkt-line, length prefix included. */
const LARGE_PACKET_MAX = 65520;

/** The longest refusal reason or error message written into one pkt-line, in code points. */
const MAX_REASON_CODE_POINTS = 256;

/** What a ref command does to its ref. */
export type RefUpdateKind = "create" | "update" | "delete";

/** One ref update requested by a push. */
export type RefUpdate = {
  readonly kind: RefUpdateKind;
  readonly oldId: string;
  readonly newId: string;
  readonly ref: string;
};

/** The head of a receive-pack request: everything before the pack. */
export type ReceivePackHead = {
  /** Empty for Git's `0000` probe, which carries no commands. */
  readonly updates: readonly RefUpdate[];
  readonly capabilities: readonly string[];
  /** Sent only when the client listed the `push-options` capability. Policy is the caller's. */
  readonly pushOptions: readonly string[];
  /** Bytes from the start of the body up to and including the head's last flush packet. */
  readonly headBytes: number;
};

/** Why a receive-pack head was refused. */
export type HeadFailure =
  | "bad-length"
  | "too-large"
  | "truncated"
  | "bad-shallow"
  | "bad-command"
  | "signed-push"
  | "bad-push-option";

export type HeadParse =
  | { readonly kind: "complete"; readonly head: ReceivePackHead }
  | { readonly kind: "incomplete" }
  | { readonly kind: "refused"; readonly reason: HeadFailure };

type HeadResult = Exclude<HeadParse, { readonly kind: "incomplete" }>;

const INCOMPLETE: HeadParse = { kind: "incomplete" };
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_ID = /^0+$/;
const HEX_LENGTH = /^[0-9a-fA-F]{4}$/;
const textEncoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ascii = new TextDecoder("latin1");

function refused(reason: HeadFailure): HeadResult {
  return { kind: "refused", reason };
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reads the head of a receive-pack request incrementally: feed each chunk of the body to `push`
 * as it arrives. Every byte is copied at most once and at most `maxHeadBytes` are held, however
 * the body is split. Once the head completes or is refused the result no longer changes.
 */
export class ReceivePackHeadParser {
  readonly #maxHeadBytes: number;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #consumed = 0;
  #result: HeadParse = INCOMPLETE;
  #section: "commands" | "push-options" = "commands";
  #idLength: number | undefined;
  #sawCommand = false;
  #capabilities: readonly string[] = [];
  readonly #updates: RefUpdate[] = [];
  readonly #pushOptions: string[] = [];

  constructor(maxHeadBytes: number = MAX_RECEIVE_HEAD_BYTES) {
    this.#maxHeadBytes = maxHeadBytes;
  }

  /** Adds the next chunk of the body and returns the head once it is complete. */
  push(chunk: Uint8Array): HeadParse {
    if (this.#result.kind !== "incomplete") return this.#result;
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    this.#result = this.#drain();
    if (this.#result.kind !== "incomplete") {
      this.#chunks = [];
      this.#buffered = 0;
    }
    return this.#result;
  }

  /** Marks the end of the body. A head still incomplete is refused as truncated. */
  end(): HeadResult {
    if (this.#result.kind === "incomplete") {
      this.#result = refused("truncated");
      this.#chunks = [];
      this.#buffered = 0;
    }
    return this.#result;
  }

  #drain(): HeadParse {
    for (;;) {
      // Any further packet, even a flush, takes four more bytes.
      if (this.#consumed + 4 > this.#maxHeadBytes) return refused("too-large");
      if (this.#buffered < 4) return INCOMPLETE;
      const lengthText = ascii.decode(this.#peek(4));
      if (!HEX_LENGTH.test(lengthText)) return refused("bad-length");
      const length = Number.parseInt(lengthText, 16);
      if (length === 0) {
        this.#take(4);
        const result = this.#flush();
        if (result !== undefined) return result;
        continue;
      }
      // 0001 to 0003 are protocol v2 special packets, 0004 is an empty line; none belongs here.
      if (length <= 4 || length > LARGE_PACKET_MAX) return refused("bad-length");
      if (this.#consumed + length > this.#maxHeadBytes) return refused("too-large");
      if (this.#buffered < length) return INCOMPLETE;
      const result = this.#line(this.#take(length).subarray(4));
      if (result !== undefined) return result;
    }
  }

  #flush(): HeadResult | undefined {
    if (
      this.#section === "commands" &&
      this.#sawCommand &&
      this.#capabilities.includes("push-options")
    ) {
      this.#section = "push-options";
      return undefined;
    }
    return {
      kind: "complete",
      head: {
        updates: this.#updates,
        capabilities: this.#capabilities,
        pushOptions: this.#pushOptions,
        headBytes: this.#consumed,
      },
    };
  }

  #line(payload: Uint8Array): HeadResult | undefined {
    const failure = this.#section === "commands" ? "bad-command" : "bad-push-option";
    let line: string;
    try {
      line = utf8.decode(payload);
    } catch {
      return refused(failure);
    }
    if (line.endsWith("\n")) line = line.slice(0, -1);

    if (this.#section === "push-options") {
      if (hasControlCharacter(line)) return refused("bad-push-option");
      this.#pushOptions.push(line);
      return undefined;
    }

    // A shallow client lists its shallow commits before the commands.
    if (line.startsWith("shallow ")) {
      if (this.#sawCommand || !this.#acceptId(line.slice("shallow ".length))) {
        return refused("bad-shallow");
      }
      return undefined;
    }
    if (line.startsWith("push-cert")) return refused("signed-push");

    if (!this.#sawCommand) {
      this.#sawCommand = true;
      const nul = line.indexOf("\0");
      if (nul !== -1) {
        this.#capabilities = line
          .slice(nul + 1)
          .split(" ")
          .filter((capability) => capability !== "");
        line = line.slice(0, nul);
      }
    }

    const [oldId, newId, ref, ...rest] = line.split(" ");
    if (
      oldId === undefined ||
      newId === undefined ||
      ref === undefined ||
      rest.length > 0 ||
      !this.#acceptId(oldId) ||
      !this.#acceptId(newId) ||
      !ref.startsWith("refs/") ||
      textEncoder.encode(ref).length > MAX_REF_BYTES ||
      hasControlCharacter(ref)
    ) {
      return refused("bad-command");
    }
    const creates = ZERO_ID.test(oldId);
    const deletes = ZERO_ID.test(newId);
    if (creates && deletes) return refused("bad-command");
    const kind = creates ? "create" : deletes ? "delete" : "update";
    this.#updates.push({ kind, oldId, newId, ref });
    return undefined;
  }

  /** Accepts an object ID whose length matches every earlier ID in this head. */
  #acceptId(id: string): boolean {
    if (!OBJECT_ID.test(id)) return false;
    this.#idLength ??= id.length;
    return id.length === this.#idLength;
  }

  #peek(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const part = chunk.subarray(0, count - filled);
      out.set(part, filled);
      filled += part.length;
      if (filled === count) break;
    }
    return out;
  }

  #take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    let used = 0;
    while (filled < count) {
      const chunk = this.#chunks[used];
      if (chunk === undefined) throw new RangeError("pkt-line parser took more than it buffered");
      const part = chunk.subarray(0, count - filled);
      out.set(part, filled);
      filled += part.length;
      if (part.length === chunk.length) used += 1;
      else this.#chunks[used] = chunk.subarray(part.length);
    }
    // One splice per packet rather than one shift per chunk, so one-byte chunks stay linear.
    this.#chunks.splice(0, used);
    this.#buffered -= count;
    this.#consumed += count;
    return out;
  }
}

/** A receive-pack body after its head was read. */
export type PushHead =
  | {
      readonly kind: "complete";
      readonly head: ReceivePackHead;
      /** The whole body, head included, for forwarding untouched. */
      readonly body: ReadableStream<Uint8Array>;
    }
  | { readonly kind: "refused"; readonly reason: HeadFailure };

/**
 * Reads the head of a receive-pack body without consuming it. The body is teed: one branch is
 * read until the head completes and is then cancelled, the other is returned for forwarding, so
 * only the head is held in memory. A refused body is cancelled entirely.
 */
export async function readReceivePackHead(
  body: ReadableStream<Uint8Array>,
  maxHeadBytes: number = MAX_RECEIVE_HEAD_BYTES,
): Promise<PushHead> {
  const [forParsing, forForwarding] = body.tee();
  const reader = forParsing.getReader();
  const parser = new ReceivePackHeadParser(maxHeadBytes);
  let parsed: HeadParse;
  try {
    do {
      const { done, value } = await reader.read();
      parsed = done ? parser.end() : parser.push(value);
    } while (parsed.kind === "incomplete");
  } catch (error) {
    // The source failed, so both branches carry its error; rethrow it once the forwarding branch
    // is released.
    await forForwarding.cancel(error).catch(() => undefined);
    throw error;
  }
  switch (parsed.kind) {
    case "complete":
      await reader.cancel();
      return { kind: "complete", head: parsed.head, body: forForwarding };
    case "refused":
      await Promise.all([reader.cancel(), forForwarding.cancel()]);
      return { kind: "refused", reason: parsed.reason };
    default:
      return parsed satisfies never;
  }
}

/** A one-line explanation of a refused head, for a gateway's HTTP error body. */
export function describeHeadFailure(reason: HeadFailure): string {
  switch (reason) {
    case "bad-length":
      return "malformed pkt-line length";
    case "too-large":
      return "receive-pack command list is too large";
    case "truncated":
      return "request ended before the receive-pack command list did";
    case "bad-shallow":
      return "malformed shallow line";
    case "bad-command":
      return "malformed receive-pack command";
    case "signed-push":
      return "signed pushes are not supported";
    case "bad-push-option":
      return "malformed push option";
    default:
      return reason satisfies never;
  }
}

/** Makes `text` safe for one pkt-line: control characters become spaces and length is capped. */
function oneLine(text: string, maxCodePoints: number): string {
  let out = "";
  let count = 0;
  for (const character of text) {
    if (count === maxCodePoints) break;
    out += hasControlCharacter(character) ? " " : character;
    count += 1;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const FLUSH = textEncoder.encode("0000");

function pktLine(payload: Uint8Array): Uint8Array {
  const header = textEncoder.encode((payload.length + 4).toString(16).padStart(4, "0"));
  return concat([header, payload]);
}

/** Splits `data` across side-band packets of the given band, each at most `packetMax` bytes. */
function sideband(band: 1 | 2, data: Uint8Array, packetMax: number): Uint8Array[] {
  const dataMax = packetMax - 5;
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += dataMax) {
    packets.push(pktLine(concat([Uint8Array.of(band), data.subarray(offset, offset + dataMax)])));
  }
  return packets;
}

/** An upload-pack response Git reports as `fatal: remote error: <message>`. */
export function uploadPackError(message: string): Uint8Array {
  return pktLine(textEncoder.encode(`ERR ${oneLine(message, MAX_REASON_CODE_POINTS)}\n`));
}

/**
 * A receive-pack response that rejects every requested update without reading the pack. Git
 * prints `message` as `remote:` lines when the client negotiated a side band, and each update's
 * reason beside its ref. Control characters in the message and reasons become spaces, so neither
 * can forge another line of the report.
 */
export function receivePackRefusal(
  head: ReceivePackHead,
  message: string,
  reasonFor: (update: RefUpdate) => string,
): Uint8Array {
  const capabilities = head.capabilities;
  const reports =
    capabilities.includes("report-status") || capabilities.includes("report-status-v2");
  const report = reports
    ? concat([
        pktLine(textEncoder.encode("unpack ok\n")),
        ...head.updates.map((update) => {
          const reason = oneLine(reasonFor(update), MAX_REASON_CODE_POINTS) || "refused";
          return pktLine(textEncoder.encode(`ng ${update.ref} ${reason}\n`));
        }),
        FLUSH,
      ])
    : new Uint8Array(0);
  const packetMax = capabilities.includes("side-band-64k")
    ? LARGE_PACKET_MAX
    : capabilities.includes("side-band")
      ? 1000
      : undefined;
  if (packetMax === undefined) return report;
  const lines = message
    .split("\n")
    .map((line) => `${oneLine(line, Number.POSITIVE_INFINITY)}\n`)
    .join("");
  return concat([
    ...sideband(2, textEncoder.encode(lines), packetMax),
    ...sideband(1, report, packetMax),
    FLUSH,
  ]);
}
