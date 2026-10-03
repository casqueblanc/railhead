// A bounded CBOR (RFC 8949) reader for the parts of a WebAuthn registration the owner module reads:
// the attestation object and the credential's COSE key. It accepts definite-length integers, byte
// and text strings, arrays and maps with integer or text keys, nested at most `MAX_DEPTH` deep.
// Indefinite lengths, tags, floats and simple values are refused, as are duplicate map keys.

/** A decoded CBOR item. */
export type CborValue =
  | number
  | string
  | Uint8Array
  | CborValue[]
  | Map<number | string, CborValue>;

/** One decoded item and the offset just past it. */
export interface CborItem {
  /** The item. */
  readonly value: CborValue;
  /** The offset of the first byte after the item. */
  readonly end: number;
}

const MAX_DEPTH = 4;
const MAX_ITEMS = 64;

/**
 * Decodes the one item starting at `offset`, or returns `undefined` when the bytes there are not an
 * item this reader accepts. Bytes after the item are left for the caller.
 */
export function readCbor(bytes: Uint8Array, offset = 0): CborItem | undefined {
  const reader = new Reader(bytes, offset);
  const value = reader.item(0);
  return value === undefined ? undefined : { value, end: reader.offset };
}

class Reader {
  offset: number;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array, offset: number) {
    this.#bytes = bytes;
    this.offset = offset;
  }

  item(depth: number): CborValue | undefined {
    const head = this.#head();
    if (head === undefined) return undefined;
    switch (head.major) {
      case 0:
        return head.argument;
      case 1:
        return -1 - head.argument;
      case 2:
        return this.#take(head.argument);
      case 3: {
        const raw = this.#take(head.argument);
        if (raw === undefined) return undefined;
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
        } catch (error) {
          if (error instanceof TypeError) return undefined;
          throw error;
        }
      }
      case 4: {
        if (depth >= MAX_DEPTH || head.argument > MAX_ITEMS) return undefined;
        const items: CborValue[] = [];
        for (let i = 0; i < head.argument; i += 1) {
          const value = this.item(depth + 1);
          if (value === undefined) return undefined;
          items.push(value);
        }
        return items;
      }
      case 5: {
        if (depth >= MAX_DEPTH || head.argument > MAX_ITEMS) return undefined;
        const map = new Map<number | string, CborValue>();
        for (let i = 0; i < head.argument; i += 1) {
          const key = this.item(depth + 1);
          if ((typeof key !== "number" && typeof key !== "string") || map.has(key)) {
            return undefined;
          }
          const value = this.item(depth + 1);
          if (value === undefined) return undefined;
          map.set(key, value);
        }
        return map;
      }
      default:
        // Tags, floats and simple values.
        return undefined;
    }
  }

  #head(): { major: number; argument: number } | undefined {
    const first = this.#bytes[this.offset];
    if (first === undefined) return undefined;
    this.offset += 1;
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, argument: info };
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    // 8-byte arguments and indefinite lengths are never needed here.
    if (width === 0) return undefined;
    const raw = this.#take(width);
    if (raw === undefined) return undefined;
    let argument = 0;
    for (const byte of raw) argument = argument * 256 + byte;
    return { major, argument };
  }

  #take(length: number): Uint8Array | undefined {
    const end = this.offset + length;
    if (end > this.#bytes.length) return undefined;
    const out = this.#bytes.slice(this.offset, end);
    this.offset = end;
    return out;
  }
}
