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
const LONG_MATCH_MIN = 16;
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
const ZERO_RUN_STEP = 255;
const MATCH_LENGTH_BIAS = 2;
const BYTE_BITS = 8;
const MATCH_BLOCK_COPY_MIN = 16;

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupt LZO data: ${detail}`);
}

/** Decodes one LZO1X block into exactly `outputLength` bytes. */
export function decompressLzo1xBlock(input: Uint8Array, outputLength: number): Uint8Array {
  const out = new Uint8Array(outputLength);
  let inPos = 0;
  let outPos = 0;
  let state = 0;

  const nextByte = (): number => {
    if (inPos >= input.length) throw corrupt('input ends inside an instruction');
    return input[inPos++];
  };

  /** A length stored as a run of zero bytes (255 each) closed by a non-zero byte. */
  const readLengthExtension = (): number => {
    let extra = 0;
    while (nextByte() === 0) {
      extra += ZERO_RUN_STEP;
      if (extra > outputLength) throw corrupt('a length extension runs past the block');
    }
    return extra + input[inPos - 1];
  };

  const copyLiterals = (count: number): void => {
    if (inPos + count > input.length) throw corrupt('a literal run reaches past the input');
    if (outPos + count > outputLength) throw corrupt('output exceeds the stated block size');
    out.set(input.subarray(inPos, inPos + count), outPos);
    inPos += count;
    outPos += count;
  };

  const copyMatch = (distance: number, length: number): void => {
    if (distance > outPos) throw corrupt('a match reaches before the start of the block');
    if (outPos + length > outputLength) throw corrupt('output exceeds the stated block size');
    const from = outPos - distance;
    if (length >= MATCH_BLOCK_COPY_MIN && distance >= length) {
      out.copyWithin(outPos, from, from + length);
    } else {
      for (let i = 0; i < length; i++) out[outPos + i] = out[from + i];
    }
    outPos += length;
  };

  if (input.length > 0 && input[0] > FIRST_BYTE_LITERAL_RUN) {
    const run = nextByte() - FIRST_BYTE_LITERAL_RUN;
    copyLiterals(run);
    state = run < STATE_AFTER_LONG_RUN ? run : STATE_AFTER_LONG_RUN;
  }

  for (;;) {
    const t = nextByte();
    let trailing: number;
    if (t <= SHORT_MATCH_MAX) {
      if (state === 0) {
        const run = (t === 0 ? LITERAL_RUN_LONG_BASE + readLengthExtension() : t) + LITERAL_RUN_BASE;
        copyLiterals(run);
        state = STATE_AFTER_LONG_RUN;
        continue;
      }
      const distanceBase = state === STATE_AFTER_LONG_RUN ? SHORT_MATCH_LONG_STATE_DISTANCE : 1;
      const length = state === STATE_AFTER_LONG_RUN ? LITERAL_RUN_BASE : MATCH_LENGTH_BIAS;
      copyMatch(distanceBase + ((t >> 2) & TRAILING_LITERALS_MASK) + (nextByte() << 2), length);
      trailing = t & TRAILING_LITERALS_MASK;
    } else if (t >= NEAR_MATCH_MIN) {
      const distance = ((t >> 2) & NEAR_MATCH_DISTANCE_MASK) + (nextByte() << NEAR_MATCH_DISTANCE_SHIFT) + 1;
      copyMatch(distance, (t >> NEAR_MATCH_LENGTH_SHIFT) + 1);
      trailing = t & TRAILING_LITERALS_MASK;
    } else if (t >= MID_MATCH_MIN) {
      const length = (t & MID_MATCH_LENGTH_MASK) === 0 ? MID_MATCH_LENGTH_BASE + readLengthExtension() : (t & MID_MATCH_LENGTH_MASK) + MATCH_LENGTH_BIAS;
      const low = nextByte();
      const high = nextByte();
      copyMatch(((low | (high << BYTE_BITS)) >> 2) + 1, length);
      trailing = low & TRAILING_LITERALS_MASK;
    } else {
      // 16..31: the long-distance match, which also carries the end-of-stream marker.
      const length = (t & LONG_MATCH_LENGTH_MASK) === 0 ? LONG_MATCH_LENGTH_BASE + readLengthExtension() : (t & LONG_MATCH_LENGTH_MASK) + MATCH_LENGTH_BIAS;
      const low = nextByte();
      const high = nextByte();
      const distance = LONG_MATCH_DISTANCE_BASE + ((t & LONG_MATCH_HIGH_BIT) << LONG_MATCH_HIGH_SHIFT) + ((low | (high << BYTE_BITS)) >> 2);
      if (distance === LONG_MATCH_DISTANCE_BASE) break;
      copyMatch(distance, length);
      trailing = low & TRAILING_LITERALS_MASK;
    }
    if (trailing > 0) copyLiterals(trailing);
    state = trailing;
  }

  if (inPos !== input.length) throw corrupt('data follows the end-of-stream marker');
  if (outPos !== outputLength) throw corrupt(`the block ends after ${outPos} of ${outputLength} bytes`);
  return out;
}
