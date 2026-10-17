import { CorruptStreamError } from '../types';

/**
 * LZO1X block decompressor, written from the published description of the LZO1X bitstream (its instruction set and the
 * state a literal run leaves behind). Every stream the LZO1X compressors write, at any level, is decoded by this one
 * routine; the lzop file format (lzop.ts) wraps one block per chunk.
 *
 * Instruction byte `t`, with `state` = how the previous instruction ended (0: a match with no trailing literals or the
 * start of the stream, 1..3: a match followed by that many literals, 4: a literal run of four or more bytes):
 *
 *   0 .. 15   state 0: a literal run of `t + 3` bytes (`t == 0`: 15 + a zero-run length extension + 3)
 *             state 1..3: a 2-byte match, distance `(next << 2) + ((t >> 2) & 3) + 1`
 *             state 4: a 3-byte match, distance `(next << 2) + ((t >> 2) & 3) + 2049`
 *             (`t & 3` literals follow a match)
 *   16 .. 31  a long-distance match: length `(t & 7) + 2` (0: 9 + extension), distance
 *             `16384 + ((t & 8) << 11) + (u16 >> 2)`; distance 16384 is the end-of-stream marker
 *   32 .. 63  a match: length `(t & 31) + 2` (0: 33 + extension), distance `(u16 >> 2) + 1`
 *   64 .. 255 a match: length `(t >> 5) + 1`, distance `((t >> 2) & 7) + (next << 3) + 1`
 *   (for 16..255 the literal count that follows is the low two bits of the instruction or of `u16`)
 *
 * A stream may open with a byte above 17, which stands for a literal run of `byte - 17` bytes.
 *
 * Fail closed: every read of the input, every distance and every length is checked against the buffers, and the output
 * must be exactly the stated length with the whole input consumed.
 */

const FIRST_BYTE_LITERAL_RUN = 17;
const LITERAL_RUN_BASE = 3;
const LITERAL_RUN_LONG_BASE = 15;
const SHORT_MATCH_MAX = 15;
const MID_MATCH_MIN = 32;
const NEAR_MATCH_MIN = 64;
const LONG_MATCH_LENGTH_MASK = 7;
const LONG_MATCH_LENGTH_BASE = 9;
const LONG_MATCH_DISTANCE_BASE = 16384;
const LONG_MATCH_HIGH_BIT = 8;
const LONG_MATCH_HIGH_SHIFT = 11;
const MID_MATCH_LENGTH_MASK = 31;
const MID_MATCH_LENGTH_BASE = 33;
const NEAR_MATCH_LENGTH_SHIFT = 5;
const NEAR_MATCH_DISTANCE_MASK = 7;
const NEAR_MATCH_DISTANCE_SHIFT = 3;
const STATE_AFTER_LONG_RUN = 4;
const SHORT_MATCH_LONG_STATE_DISTANCE = 2049;
const TRAILING_LITERALS_MASK = 3;
/** The two low bits of an instruction or of a 16-bit distance field count the literals that follow; the rest is the distance. */
const TRAILING_LITERALS_BITS = 2;
const ZERO_RUN_STEP = 255;
const MATCH_LENGTH_BIAS = 2;
const BYTE_BITS = 8;
const MATCH_BLOCK_COPY_MIN = 16;

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupt LZO data: ${detail}`);
}

/** Decodes one LZO1X block; every read and copy is checked against the input and the stated output length. */
class BlockDecoder {
  private inPos = 0;
  private outPos = 0;
  /** How the previous instruction ended: see the table above. */
  private state = 0;
  private readonly out: Uint8Array;

  constructor(
    private readonly input: Uint8Array,
    private readonly outputLength: number
  ) {
    this.out = new Uint8Array(outputLength);
  }

  decode(): Uint8Array {
    if (this.input.length > 0 && this.input[0] > FIRST_BYTE_LITERAL_RUN) {
      const run = this.nextByte() - FIRST_BYTE_LITERAL_RUN;
      this.copyLiterals(run);
      this.state = Math.min(run, STATE_AFTER_LONG_RUN);
    }
    for (let more = true; more; ) more = this.step();
    if (this.inPos !== this.input.length) throw corrupt('data follows the end-of-stream marker');
    if (this.outPos !== this.outputLength) throw corrupt(`the block ends after ${this.outPos} of ${this.outputLength} bytes`);
    return this.out;
  }

  /** Runs one instruction; false at the end-of-stream marker. */
  private step(): boolean {
    const t = this.nextByte();
    let trailing: number;
    if (t <= SHORT_MATCH_MAX) {
      if (this.state === 0) {
        this.literalRun(t);
        return true;
      }
      trailing = this.shortMatch(t);
    } else if (t >= NEAR_MATCH_MIN) {
      trailing = this.nearMatch(t);
    } else if (t >= MID_MATCH_MIN) {
      trailing = this.midMatch(t);
    } else {
      const longTrailing = this.longMatch(t);
      if (longTrailing === null) return false;
      trailing = longTrailing;
    }
    if (trailing > 0) this.copyLiterals(trailing);
    this.state = trailing;
    return true;
  }

  private literalRun(t: number): void {
    const run = (t === 0 ? LITERAL_RUN_LONG_BASE + this.readLengthExtension() : t) + LITERAL_RUN_BASE;
    this.copyLiterals(run);
    this.state = STATE_AFTER_LONG_RUN;
  }

  /** 0..15 after a match: two bytes at a short distance, or (after a long literal run) three bytes at a longer one. */
  private shortMatch(t: number): number {
    const afterLongRun = this.state === STATE_AFTER_LONG_RUN;
    const distance = (afterLongRun ? SHORT_MATCH_LONG_STATE_DISTANCE : 1) + ((t >> 2) & TRAILING_LITERALS_MASK) + (this.nextByte() << 2);
    this.copyMatch(distance, afterLongRun ? LITERAL_RUN_BASE : MATCH_LENGTH_BIAS);
    return t & TRAILING_LITERALS_MASK;
  }

  private nearMatch(t: number): number {
    const distance = ((t >> 2) & NEAR_MATCH_DISTANCE_MASK) + (this.nextByte() << NEAR_MATCH_DISTANCE_SHIFT) + 1;
    this.copyMatch(distance, (t >> NEAR_MATCH_LENGTH_SHIFT) + 1);
    return t & TRAILING_LITERALS_MASK;
  }

  private midMatch(t: number): number {
    const length = this.matchLength(t & MID_MATCH_LENGTH_MASK, MID_MATCH_LENGTH_BASE);
    const field = this.distanceField();
    this.copyMatch((field >> TRAILING_LITERALS_BITS) + 1, length);
    return field & TRAILING_LITERALS_MASK;
  }

  /** 16..31: the long-distance match, which also carries the end-of-stream marker (null). */
  private longMatch(t: number): number | null {
    const length = this.matchLength(t & LONG_MATCH_LENGTH_MASK, LONG_MATCH_LENGTH_BASE);
    const field = this.distanceField();
    const distance = LONG_MATCH_DISTANCE_BASE + ((t & LONG_MATCH_HIGH_BIT) << LONG_MATCH_HIGH_SHIFT) + (field >> TRAILING_LITERALS_BITS);
    if (distance === LONG_MATCH_DISTANCE_BASE) return null;
    this.copyMatch(distance, length);
    return field & TRAILING_LITERALS_MASK;
  }

  /** A match length from the instruction's own bits, or (when they are zero) from `base` plus the length extension. */
  private matchLength(inline: number, base: number): number {
    return inline === 0 ? base + this.readLengthExtension() : inline + MATCH_LENGTH_BIAS;
  }

  /** The 16-bit little-endian field that follows a mid or long match instruction. */
  private distanceField(): number {
    const low = this.nextByte();
    return low | (this.nextByte() << BYTE_BITS);
  }

  private nextByte(): number {
    if (this.inPos >= this.input.length) throw corrupt('input ends inside an instruction');
    return this.input[this.inPos++];
  }

  /** A length stored as a run of zero bytes (255 each) closed by a non-zero byte. */
  private readLengthExtension(): number {
    let extra = 0;
    while (this.nextByte() === 0) {
      extra += ZERO_RUN_STEP;
      if (extra > this.outputLength) throw corrupt('a length extension runs past the block');
    }
    return extra + this.input[this.inPos - 1];
  }

  private copyLiterals(count: number): void {
    if (this.inPos + count > this.input.length) throw corrupt('a literal run reaches past the input');
    if (this.outPos + count > this.outputLength) throw corrupt('output exceeds the stated block size');
    this.out.set(this.input.subarray(this.inPos, this.inPos + count), this.outPos);
    this.inPos += count;
    this.outPos += count;
  }

  private copyMatch(distance: number, length: number): void {
    if (distance > this.outPos) throw corrupt('a match reaches before the start of the block');
    if (this.outPos + length > this.outputLength) throw corrupt('output exceeds the stated block size');
    const from = this.outPos - distance;
    if (length >= MATCH_BLOCK_COPY_MIN && distance >= length) {
      this.out.copyWithin(this.outPos, from, from + length);
    } else {
      for (let i = 0; i < length; i++) this.out[this.outPos + i] = this.out[from + i];
    }
    this.outPos += length;
  }
}

/** Decodes one LZO1X block into exactly `outputLength` bytes. */
export function decompressLzo1xBlock(input: Uint8Array, outputLength: number): Uint8Array {
  return new BlockDecoder(input, outputLength).decode();
}
