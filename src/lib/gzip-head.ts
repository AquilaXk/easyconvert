/**
 * The first bytes of what a gzip member (RFC 1952) holds, decoded without Node's zlib so that the signature table of the
 * format registry, which client components import too, stays free of Node built-ins. The decoder is the canonical
 * Huffman scheme of RFC 1951 and stops at the byte budget: a stream that expands past it is never inflated further, and the
 * input is only ever the header window the caller already holds.
 *
 * A stream that is not valid deflate gives `undefined`; input that ends before the budget is reached gives the bytes
 * decoded so far, because the window the registry reads is a prefix of the file.
 */

const GZIP_HEADER_BYTES = 10;
const GZIP_FLAGS_OFFSET = 3;
const GZIP_FLAG_HEADER_CRC = 0x02;
const GZIP_FLAG_EXTRA = 0x04;
const GZIP_FLAG_NAME = 0x08;
const GZIP_FLAG_COMMENT = 0x10;
const GZIP_EXTRA_LENGTH_BYTES = 2;
const GZIP_HEADER_CRC_BYTES = 2;

const MAX_CODE_BITS = 15;
const END_OF_BLOCK = 256;
const MAX_LITERAL_CODES = 286;
const MAX_DISTANCE_CODES = 30;
const FIXED_LITERAL_CODES = 288;
const CODE_LENGTH_CODES = 19;
const STORED_BLOCK = 0;
const FIXED_BLOCK = 1;
const DYNAMIC_BLOCK = 2;

/** RFC 1951 3.2.5: base value and extra bits of the length codes 257 to 285 and of the distance codes 0 to 29. */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** RFC 1951 3.2.7: the order in which the code lengths of the code-length alphabet are stored. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const REPEAT_PREVIOUS = 16;
const REPEAT_ZERO_SHORT = 17;

class InvalidDeflate extends Error {}
class InputEnded extends Error {}

/** A canonical Huffman code: how many codes there are of each length, and the symbols in code order. */
interface HuffmanCode {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildCode(lengths: ArrayLike<number>): HuffmanCode {
  const counts = new Uint16Array(MAX_CODE_BITS + 1);
  for (let symbol = 0; symbol < lengths.length; symbol++) counts[lengths[symbol]]++;
  let left = 1;
  for (let length = 1; length <= MAX_CODE_BITS; length++) {
    left = (left << 1) - counts[length];
    if (left < 0) throw new InvalidDeflate('over-subscribed code');
  }
  const offsets = new Uint16Array(MAX_CODE_BITS + 2);
  for (let length = 1; length <= MAX_CODE_BITS; length++) offsets[length + 1] = offsets[length] + counts[length];
  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    if (lengths[symbol] !== 0) symbols[offsets[lengths[symbol]]++] = symbol;
  }
  return { counts, symbols };
}

function fixedLiteralLengths(): Uint8Array {
  const lengths = new Uint8Array(FIXED_LITERAL_CODES);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, FIXED_LITERAL_CODES);
  return lengths;
}

let fixedCodes: { literals: HuffmanCode; distances: HuffmanCode } | undefined;

function fixedBlockCodes(): { literals: HuffmanCode; distances: HuffmanCode } {
  fixedCodes ??= { literals: buildCode(fixedLiteralLengths()), distances: buildCode(new Uint8Array(MAX_DISTANCE_CODES).fill(5)) };
  return fixedCodes;
}

class Inflater {
  private position: number;
  private bitBuffer = 0;
  private bitCount = 0;
  private readonly output: Uint8Array;
  private written = 0;

  constructor(private readonly input: Uint8Array, start: number, budget: number) {
    this.position = start;
    this.output = new Uint8Array(budget);
  }

  /** Decodes blocks until the last one or until the budget is full, and returns the bytes written. */
  run(): Uint8Array {
    try {
      let last = false;
      while (!last && !this.isFull()) {
        last = this.readBits(1) === 1;
        this.readBlock(this.readBits(2));
      }
    } catch (error) {
      if (!(error instanceof InputEnded)) throw error;
    }
    return this.output.subarray(0, this.written);
  }

  private isFull(): boolean {
    return this.written >= this.output.length;
  }

  private readBits(count: number): number {
    while (this.bitCount < count) {
      if (this.position >= this.input.length) throw new InputEnded();
      this.bitBuffer |= this.input[this.position++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  private readBlock(type: number): void {
    if (type === STORED_BLOCK) this.readStored();
    else if (type === FIXED_BLOCK) this.readCompressed(fixedBlockCodes());
    else if (type === DYNAMIC_BLOCK) this.readCompressed(this.readDynamicCodes());
    else throw new InvalidDeflate('reserved block type');
  }

  private readStored(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
    if (this.position + 4 > this.input.length) throw new InputEnded();
    const length = this.input[this.position] | (this.input[this.position + 1] << 8);
    const complement = this.input[this.position + 2] | (this.input[this.position + 3] << 8);
    if (length !== (~complement & 0xffff)) throw new InvalidDeflate('stored block length check');
    this.position += 4;
    const available = Math.min(length, this.input.length - this.position, this.output.length - this.written);
    this.output.set(this.input.subarray(this.position, this.position + available), this.written);
    this.written += available;
    this.position += available;
    if (available < length) throw new InputEnded();
  }

  private decodeSymbol(code: HuffmanCode): number {
    let value = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= MAX_CODE_BITS; length++) {
      value |= this.readBits(1);
      const count = code.counts[length];
      if (value - count < first) return code.symbols[index + (value - first)];
      index += count;
      first = (first + count) << 1;
      value <<= 1;
    }
    throw new InvalidDeflate('no such code');
  }

  private readDynamicCodes(): { literals: HuffmanCode; distances: HuffmanCode } {
    const literalCount = this.readBits(5) + 257;
    const distanceCount = this.readBits(5) + 1;
    const codeLengthCount = this.readBits(4) + 4;
    if (literalCount > MAX_LITERAL_CODES || distanceCount > MAX_DISTANCE_CODES) throw new InvalidDeflate('too many codes');
    const codeLengthLengths = new Uint8Array(CODE_LENGTH_CODES);
    for (let index = 0; index < codeLengthCount; index++) codeLengthLengths[CODE_LENGTH_ORDER[index]] = this.readBits(3);
    const lengthCode = buildCode(codeLengthLengths);
    const lengths = new Uint8Array(literalCount + distanceCount);
    let filled = 0;
    while (filled < lengths.length) {
      const symbol = this.decodeSymbol(lengthCode);
      if (symbol < REPEAT_PREVIOUS) {
        lengths[filled++] = symbol;
        continue;
      }
      const { value, repeat } = this.readRepeat(symbol, lengths[filled - 1], filled);
      if (filled + repeat > lengths.length) throw new InvalidDeflate('repeat past the code lengths');
      lengths.fill(value, filled, filled + repeat);
      filled += repeat;
    }
    return { literals: buildCode(lengths.subarray(0, literalCount)), distances: buildCode(lengths.subarray(literalCount)) };
  }

  /** The value and run length of a code-length symbol 16 (repeat the previous length), 17 or 18 (repeat zero). */
  private readRepeat(symbol: number, previous: number, filled: number): { value: number; repeat: number } {
    if (symbol === REPEAT_PREVIOUS) {
      if (filled === 0) throw new InvalidDeflate('repeat with no previous length');
      return { value: previous, repeat: 3 + this.readBits(2) };
    }
    return symbol === REPEAT_ZERO_SHORT ? { value: 0, repeat: 3 + this.readBits(3) } : { value: 0, repeat: 11 + this.readBits(7) };
  }

  private readCompressed(codes: { literals: HuffmanCode; distances: HuffmanCode }): void {
    while (!this.isFull()) {
      const symbol = this.decodeSymbol(codes.literals);
      if (symbol < END_OF_BLOCK) {
        this.output[this.written++] = symbol;
      } else if (symbol === END_OF_BLOCK) {
        return;
      } else {
        this.copyMatch(symbol - END_OF_BLOCK - 1, codes.distances);
      }
    }
  }

  private copyMatch(lengthIndex: number, distances: HuffmanCode): void {
    if (lengthIndex >= LENGTH_BASE.length) throw new InvalidDeflate('length code out of range');
    const length = LENGTH_BASE[lengthIndex] + this.readBits(LENGTH_EXTRA[lengthIndex]);
    const distanceIndex = this.decodeSymbol(distances);
    if (distanceIndex >= MAX_DISTANCE_CODES) throw new InvalidDeflate('distance code out of range');
    const distance = DISTANCE_BASE[distanceIndex] + this.readBits(DISTANCE_EXTRA[distanceIndex]);
    if (distance > this.written) throw new InvalidDeflate('distance reaches before the start');
    const end = Math.min(this.written + length, this.output.length);
    while (this.written < end) {
      this.output[this.written] = this.output[this.written - distance];
      this.written++;
    }
  }
}

/** Offset of the deflate stream after the header of a gzip member, or undefined when the header is not complete. */
function deflateStreamOffset(member: Uint8Array): number | undefined {
  if (member.length < GZIP_HEADER_BYTES) return undefined;
  const flags = member[GZIP_FLAGS_OFFSET];
  let offset = GZIP_HEADER_BYTES;
  if (flags & GZIP_FLAG_EXTRA) {
    if (offset + GZIP_EXTRA_LENGTH_BYTES > member.length) return undefined;
    offset += GZIP_EXTRA_LENGTH_BYTES + (member[offset] | (member[offset + 1] << 8));
  }
  for (const flag of [GZIP_FLAG_NAME, GZIP_FLAG_COMMENT]) {
    if (!(flags & flag)) continue;
    const terminator = member.indexOf(0, offset);
    if (terminator === -1) return undefined;
    offset = terminator + 1;
  }
  if (flags & GZIP_FLAG_HEADER_CRC) offset += GZIP_HEADER_CRC_BYTES;
  return offset <= member.length ? offset : undefined;
}

/**
 * The first `budget` bytes (fewer when the member is shorter or the window ends first) that the gzip member at the start of
 * `member` holds, or undefined when its header is incomplete or its deflate stream is not valid.
 */
export function gunzipHead(member: Uint8Array, budget: number): Uint8Array | undefined {
  const start = deflateStreamOffset(member);
  if (start === undefined) return undefined;
  try {
    return new Inflater(member, start, budget).run();
  } catch (error) {
    if (error instanceof InvalidDeflate) return undefined;
    throw error;
  }
}
