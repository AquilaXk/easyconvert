import { CorruptStreamError, DecompressionLimitError } from '../types';

/**
 * LZMA and LZMA2 decoder (LZMA specification by Igor Pavlov; the .xz file format 1.1 for the LZMA2 chunk layer).
 *
 * The whole output lives in one buffer, which doubles as the dictionary, so a match copies from earlier output. LZMA2
 * keeps the probability model, state and repeat distances across chunks unless a chunk's control byte resets them, and
 * keeps the dictionary unless a chunk resets it; this decoder honours every control value, so it reads the streams of
 * real encoders (xz, 7-Zip), not only single-chunk ones.
 *
 * Fail closed: every read of the input, every distance and every length is checked, and the output never grows past the
 * limit the caller gives.
 */

export const LZMA_MIN_DICT_SIZE = 4096;
const LZMA_LC_MAX = 8;
const LZMA_LP_MAX = 4;
const LZMA_PB_MAX = 4;
const LZMA2_LC_LP_MAX = 4;
const PROBS_INIT = 1024;
const BIT_MODEL_TOTAL_BITS = 11;
const MOVE_BITS = 5;
const TOP_VALUE = 0x01000000;
const RC_INIT_BYTES = 5;

const STATES = 12;
const POS_STATES_MAX = 16;
const LEN_LOW_SYMBOLS = 8;
const LEN_MID_SYMBOLS = 8;
const LEN_HIGH_SYMBOLS = 256;
const MATCH_LEN_MIN = 2;
const MATCH_LEN_MAX = 273;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const POS_SLOT_BITS = 6;
const LEN_TO_POS_STATES = 4;
const ALIGN_BITS = 4;
const LITERAL_CODER_SIZE = 0x300;

// Offsets of the model's parts inside the single probability array.
const IS_MATCH = 0;
const IS_REP = IS_MATCH + STATES * POS_STATES_MAX;
const IS_REP_G0 = IS_REP + STATES;
const IS_REP_G1 = IS_REP_G0 + STATES;
const IS_REP_G2 = IS_REP_G1 + STATES;
const IS_REP0_LONG = IS_REP_G2 + STATES;
const POS_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX;
const POS_SPECIAL = POS_SLOT + LEN_TO_POS_STATES * (1 << POS_SLOT_BITS);
const ALIGN = POS_SPECIAL + FULL_DISTANCES - END_POS_MODEL_INDEX + 1;
const LEN_CODER = ALIGN + (1 << ALIGN_BITS);
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + POS_STATES_MAX * LEN_LOW_SYMBOLS;
const LEN_HIGH = LEN_MID + POS_STATES_MAX * LEN_MID_SYMBOLS;
const LEN_CODER_SIZE = LEN_HIGH + LEN_HIGH_SYMBOLS;
const REP_LEN_CODER = LEN_CODER + LEN_CODER_SIZE;
const LITERAL = REP_LEN_CODER + LEN_CODER_SIZE;

const MAX_UINT32 = 0xffffffff;
const END_MARKER_DISTANCE = MAX_UINT32;
const MATCH_STATE_AFTER_LITERAL = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 4, 5];

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupt LZMA data: ${detail}`);
}

/** The lc / lp / pb packed into one properties byte (LZMA specification, "Header"). */
export interface LzmaProperties {
  lc: number;
  lp: number;
  pb: number;
}

export function parseLzmaPropertiesByte(byte: number): LzmaProperties {
  if (byte >= 9 * 5 * 5) throw corrupt(`invalid properties byte 0x${byte.toString(16)}`);
  const lc = byte % 9;
  const rest = Math.floor(byte / 9);
  const lp = rest % 5;
  const pb = Math.floor(rest / 5);
  if (lc > LZMA_LC_MAX || lp > LZMA_LP_MAX || pb > LZMA_PB_MAX) throw corrupt(`invalid properties byte 0x${byte.toString(16)}`);
  return { lc, lp, pb };
}

/** Decoder state that outlives one LZMA2 chunk. */
export class LzmaDecoder {
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private probs = new Uint16Array(0);
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  /** Output position of the last dictionary reset: matches may not reach before it. */
  dictStart = 0;
  private out: Uint8Array;
  outPos = 0;
  private readonly outLimit: number;

  constructor(outCapacity: number, outLimit: number) {
    this.out = new Uint8Array(outCapacity);
    this.outLimit = outLimit;
  }

  /** The decoded bytes so far. */
  get output(): Uint8Array {
    return this.out.subarray(0, this.outPos);
  }

  setProperties(props: LzmaProperties): void {
    this.lc = props.lc;
    this.lp = props.lp;
    this.pb = props.pb;
    const size = LITERAL + (LITERAL_CODER_SIZE << (props.lc + props.lp));
    if (this.probs.length !== size) this.probs = new Uint16Array(size);
  }

  /** Resets the probability model, the state and the repeat distances (an LZMA2 state reset). */
  resetState(): void {
    this.probs.fill(PROBS_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  resetDictionary(): void {
    this.dictStart = this.outPos;
  }

  /** Appends bytes that bypass the model (an LZMA2 uncompressed chunk). */
  appendRaw(src: Uint8Array, start: number, length: number): void {
    this.ensure(length);
    this.out.set(src.subarray(start, start + length), this.outPos);
    this.outPos += length;
  }

  private ensure(extra: number): void {
    const needed = this.outPos + extra;
    if (needed > this.outLimit) throw new DecompressionLimitError(`Archive bomb detected: LZMA output exceeds the limit of ${this.outLimit} bytes`);
    if (needed <= this.out.length) return;
    const grown = new Uint8Array(Math.min(this.outLimit, Math.max(needed, this.out.length * 2)));
    grown.set(this.out.subarray(0, this.outPos));
    this.out = grown;
  }

  /**
   * Decodes one range-coded run from src[start..end) until `produce` more bytes are written (or, for `allowEndMarker`,
   * until an end marker). Returns the offset of the first input byte not consumed.
   */
  decode(src: Uint8Array, start: number, end: number, produce: number, allowEndMarker: boolean): number {
    if (end - start < RC_INIT_BYTES) throw corrupt('truncated range coder header');
    if (src[start] !== 0) throw corrupt('range coder header must start with a zero byte');
    this.ensure(produce);
    let inPos = start + 1;
    let code = ((src[inPos] << 24) | (src[inPos + 1] << 16) | (src[inPos + 2] << 8) | src[inPos + 3]) >>> 0;
    inPos += 4;
    let range = MAX_UINT32;

    const probs = this.probs;
    const out = this.out;
    const lc = this.lc;
    const lpMask = (1 << this.lp) - 1;
    const pbMask = (1 << this.pb) - 1;
    const dictStart = this.dictStart;
    let outPos = this.outPos;
    const target = outPos + produce;
    let state = this.state;
    let rep0 = this.rep0;
    let rep1 = this.rep1;
    let rep2 = this.rep2;
    let rep3 = this.rep3;

    // `bit` decodes one bit with the probability at probs[index]; written out in each place that needs it so that the
    // range coder registers stay in locals.
    while (outPos < target) {
      // Positions count from the last dictionary reset (LZMA2 restarts them there).
      const posState = (outPos - dictStart) & pbMask;
      let index = IS_MATCH + (state << 4) + posState;
      let prob = probs[index];
      let bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
      if (code < bound) {
        range = bound;
        probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
        if (range < TOP_VALUE) {
          if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
          range = (range << 8) >>> 0;
          code = ((code << 8) | src[inPos++]) >>> 0;
        }
        // Literal.
        const prevByte = outPos > dictStart ? out[outPos - 1] : 0;
        const litBase = LITERAL + LITERAL_CODER_SIZE * ((((outPos - dictStart) & lpMask) << lc) + (prevByte >>> (8 - lc)));
        let symbol = 1;
        if (state >= 7) {
          let matchByte = out[outPos - rep0 - 1];
          let offs = 0x100;
          while (symbol < 0x100) {
            matchByte <<= 1;
            const matchBit = matchByte & offs;
            index = litBase + offs + matchBit + symbol;
            prob = probs[index];
            bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
            if (code < bound) {
              range = bound;
              probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
              symbol <<= 1;
              offs &= ~matchBit;
            } else {
              range -= bound;
              code -= bound;
              probs[index] = prob - (prob >>> MOVE_BITS);
              symbol = (symbol << 1) | 1;
              offs &= matchBit;
            }
            if (range < TOP_VALUE) {
              if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
              range = (range << 8) >>> 0;
              code = ((code << 8) | src[inPos++]) >>> 0;
            }
          }
        } else {
          while (symbol < 0x100) {
            index = litBase + symbol;
            prob = probs[index];
            bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
            if (code < bound) {
              range = bound;
              probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
              symbol <<= 1;
            } else {
              range -= bound;
              code -= bound;
              probs[index] = prob - (prob >>> MOVE_BITS);
              symbol = (symbol << 1) | 1;
            }
            if (range < TOP_VALUE) {
              if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
              range = (range << 8) >>> 0;
              code = ((code << 8) | src[inPos++]) >>> 0;
            }
          }
        }
        out[outPos++] = symbol & 0xff;
        state = MATCH_STATE_AFTER_LITERAL[state];
        continue;
      }
      range -= bound;
      code -= bound;
      probs[index] = prob - (prob >>> MOVE_BITS);
      if (range < TOP_VALUE) {
        if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
        range = (range << 8) >>> 0;
        code = ((code << 8) | src[inPos++]) >>> 0;
      }

      let lenBase: number;
      // isRep
      index = IS_REP + state;
      prob = probs[index];
      bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
      if (code < bound) {
        range = bound;
        probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
        if (range < TOP_VALUE) {
          if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
          range = (range << 8) >>> 0;
          code = ((code << 8) | src[inPos++]) >>> 0;
        }
        // Simple match: the length comes first, then the distance.
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        state = state < 7 ? 7 : 10;
        lenBase = LEN_CODER;
      } else {
        range -= bound;
        code -= bound;
        probs[index] = prob - (prob >>> MOVE_BITS);
        if (range < TOP_VALUE) {
          if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
          range = (range << 8) >>> 0;
          code = ((code << 8) | src[inPos++]) >>> 0;
        }
        if (outPos === dictStart) throw corrupt('a repeated match before any data');
        // isRepG0
        index = IS_REP_G0 + state;
        prob = probs[index];
        bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
        if (code < bound) {
          range = bound;
          probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
          if (range < TOP_VALUE) {
            if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
            range = (range << 8) >>> 0;
            code = ((code << 8) | src[inPos++]) >>> 0;
          }
          // isRep0Long
          index = IS_REP0_LONG + (state << 4) + posState;
          prob = probs[index];
          bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
          if (code < bound) {
            range = bound;
            probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
            if (range < TOP_VALUE) {
              if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
              range = (range << 8) >>> 0;
              code = ((code << 8) | src[inPos++]) >>> 0;
            }
            // Short repeat: one byte from the last distance.
            if (rep0 >= outPos - dictStart) throw corrupt('a repeat distance reaches before the dictionary');
            out[outPos] = out[outPos - rep0 - 1];
            outPos++;
            state = state < 7 ? 9 : 11;
            continue;
          }
          range -= bound;
          code -= bound;
          probs[index] = prob - (prob >>> MOVE_BITS);
          if (range < TOP_VALUE) {
            if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
            range = (range << 8) >>> 0;
            code = ((code << 8) | src[inPos++]) >>> 0;
          }
        } else {
          range -= bound;
          code -= bound;
          probs[index] = prob - (prob >>> MOVE_BITS);
          if (range < TOP_VALUE) {
            if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
            range = (range << 8) >>> 0;
            code = ((code << 8) | src[inPos++]) >>> 0;
          }
          let distance: number;
          // isRepG1
          index = IS_REP_G1 + state;
          prob = probs[index];
          bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
          if (code < bound) {
            range = bound;
            probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
            distance = rep1;
          } else {
            range -= bound;
            code -= bound;
            probs[index] = prob - (prob >>> MOVE_BITS);
            if (range < TOP_VALUE) {
              if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
              range = (range << 8) >>> 0;
              code = ((code << 8) | src[inPos++]) >>> 0;
            }
            // isRepG2
            index = IS_REP_G2 + state;
            prob = probs[index];
            bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
            if (code < bound) {
              range = bound;
              probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
              distance = rep2;
            } else {
              range -= bound;
              code -= bound;
              probs[index] = prob - (prob >>> MOVE_BITS);
              distance = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          if (range < TOP_VALUE) {
            if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
            range = (range << 8) >>> 0;
            code = ((code << 8) | src[inPos++]) >>> 0;
          }
          rep1 = rep0;
          rep0 = distance;
        }
        state = state < 7 ? 8 : 11;
        lenBase = REP_LEN_CODER;
      }

      // Length: choice bits select the low, mid or high tree.
      let len: number;
      let treeBase: number;
      let treeBits: number;
      index = lenBase + LEN_CHOICE;
      prob = probs[index];
      bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
      if (code < bound) {
        range = bound;
        probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
        treeBase = lenBase + LEN_LOW + (posState << 3);
        treeBits = 3;
        len = 0;
      } else {
        range -= bound;
        code -= bound;
        probs[index] = prob - (prob >>> MOVE_BITS);
        if (range < TOP_VALUE) {
          if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
          range = (range << 8) >>> 0;
          code = ((code << 8) | src[inPos++]) >>> 0;
        }
        index = lenBase + LEN_CHOICE2;
        prob = probs[index];
        bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
        if (code < bound) {
          range = bound;
          probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
          treeBase = lenBase + LEN_MID + (posState << 3);
          treeBits = 3;
          len = LEN_LOW_SYMBOLS;
        } else {
          range -= bound;
          code -= bound;
          probs[index] = prob - (prob >>> MOVE_BITS);
          treeBase = lenBase + LEN_HIGH;
          treeBits = 8;
          len = LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS;
        }
      }
      if (range < TOP_VALUE) {
        if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
        range = (range << 8) >>> 0;
        code = ((code << 8) | src[inPos++]) >>> 0;
      }
      let m = 1;
      for (let i = 0; i < treeBits; i++) {
        index = treeBase + m;
        prob = probs[index];
        bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
        if (code < bound) {
          range = bound;
          probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
          m <<= 1;
        } else {
          range -= bound;
          code -= bound;
          probs[index] = prob - (prob >>> MOVE_BITS);
          m = (m << 1) | 1;
        }
        if (range < TOP_VALUE) {
          if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
          range = (range << 8) >>> 0;
          code = ((code << 8) | src[inPos++]) >>> 0;
        }
      }
      len += m - (1 << treeBits) + MATCH_LEN_MIN;

      if (lenBase === LEN_CODER) {
        // Distance: a 6-bit slot chosen by the length, then extra bits.
        const lenState = len - MATCH_LEN_MIN < LEN_TO_POS_STATES ? len - MATCH_LEN_MIN : LEN_TO_POS_STATES - 1;
        const slotBase = POS_SLOT + (lenState << POS_SLOT_BITS);
        let slot = 1;
        for (let i = 0; i < POS_SLOT_BITS; i++) {
          index = slotBase + slot;
          prob = probs[index];
          bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
          if (code < bound) {
            range = bound;
            probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
            slot <<= 1;
          } else {
            range -= bound;
            code -= bound;
            probs[index] = prob - (prob >>> MOVE_BITS);
            slot = (slot << 1) | 1;
          }
          if (range < TOP_VALUE) {
            if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
            range = (range << 8) >>> 0;
            code = ((code << 8) | src[inPos++]) >>> 0;
          }
        }
        slot -= 1 << POS_SLOT_BITS;
        if (slot < 4) {
          rep0 = slot;
        } else {
          const footerBits = (slot >>> 1) - 1;
          let distance = ((2 | (slot & 1)) << footerBits) >>> 0;
          if (slot < END_POS_MODEL_INDEX) {
            // Reverse bit tree of footerBits bits over the special-position probabilities.
            const specialBase = POS_SPECIAL + distance - slot - 1;
            let mm = 1;
            for (let i = 0; i < footerBits; i++) {
              index = specialBase + mm;
              prob = probs[index];
              bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
              if (code < bound) {
                range = bound;
                probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
                mm <<= 1;
              } else {
                range -= bound;
                code -= bound;
                probs[index] = prob - (prob >>> MOVE_BITS);
                mm = (mm << 1) | 1;
                distance += 1 << i;
              }
              if (range < TOP_VALUE) {
                if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
                range = (range << 8) >>> 0;
                code = ((code << 8) | src[inPos++]) >>> 0;
              }
            }
          } else {
            // Direct bits (no probabilities), then a 4-bit reverse tree for the low bits.
            for (let i = footerBits - ALIGN_BITS; i > 0; i--) {
              range >>>= 1;
              if (code >= range) {
                code -= range;
                distance += 2 ** (i - 1 + ALIGN_BITS);
              }
              if (range < TOP_VALUE) {
                if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
                range = (range << 8) >>> 0;
                code = ((code << 8) | src[inPos++]) >>> 0;
              }
            }
            let mm = 1;
            for (let i = 0; i < ALIGN_BITS; i++) {
              index = ALIGN + mm;
              prob = probs[index];
              bound = (range >>> BIT_MODEL_TOTAL_BITS) * prob;
              if (code < bound) {
                range = bound;
                probs[index] = prob + (((1 << BIT_MODEL_TOTAL_BITS) - prob) >>> MOVE_BITS);
                mm <<= 1;
              } else {
                range -= bound;
                code -= bound;
                probs[index] = prob - (prob >>> MOVE_BITS);
                mm = (mm << 1) | 1;
                distance += 1 << i;
              }
              if (range < TOP_VALUE) {
                if (inPos >= end) throw corrupt('input ends inside a range coder symbol');
                range = (range << 8) >>> 0;
                code = ((code << 8) | src[inPos++]) >>> 0;
              }
            }
            if (distance === END_MARKER_DISTANCE) {
              if (!allowEndMarker) throw corrupt('unexpected end marker');
              break;
            }
          }
          rep0 = distance;
        }
      }

      if (rep0 >= outPos - dictStart) throw corrupt('a distance reaches before the start of the dictionary');
      const remaining = target - outPos;
      if (len > remaining) throw corrupt('a match runs past the end of the chunk');
      const from = outPos - rep0 - 1;
      if (rep0 + 1 >= len) {
        out.copyWithin(outPos, from, from + len);
        outPos += len;
      } else {
        for (let k = 0; k < len; k++) out[outPos + k] = out[from + k];
        outPos += len;
      }
    }

    if (inPos > end) throw corrupt('input overrun');
    this.outPos = outPos;
    this.state = state;
    this.rep0 = rep0;
    this.rep1 = rep1;
    this.rep2 = rep2;
    this.rep3 = rep3;
    return inPos;
  }
}

/** Decoded size of an LZMA2 dictionary property byte (xz format, section 5.3.1), or an error for an invalid byte. */
export function lzma2DictionarySize(propByte: number): number {
  if (propByte > 40) throw corrupt(`invalid LZMA2 dictionary size byte ${propByte}`);
  if (propByte === 40) return MAX_UINT32;
  return (2 | (propByte & 1)) * 2 ** ((propByte >>> 1) + 11);
}

/** Smallest LZMA2 dictionary property byte whose size is at least `dictSize`. */
export function lzma2DictionaryByte(dictSize: number): number {
  for (let byte = 0; byte < 40; byte++) {
    if (lzma2DictionarySize(byte) >= dictSize) return byte;
  }
  return 40;
}

/**
 * Decodes a raw LZMA stream (the 7z / .lzma coder payload without a header) of known size.
 * `props` is the 5-byte coder property block: the lc/lp/pb byte, then the dictionary size.
 */
export function decodeLzma(input: Uint8Array, props: Uint8Array, unpackSize: number, maxOutput: number): Uint8Array {
  if (props.length < 5) throw corrupt('the properties header needs 5 bytes');
  if (unpackSize > maxOutput) throw new DecompressionLimitError(`Archive bomb detected: unpack size (${unpackSize}) exceeds limit of ${maxOutput} bytes`);
  const decoder = new LzmaDecoder(unpackSize, maxOutput);
  decoder.setProperties(parseLzmaPropertiesByte(props[0]));
  decoder.resetState();
  decoder.decode(input, 0, input.length, unpackSize, true);
  if (decoder.outPos !== unpackSize) throw corrupt(`the stream ends after ${decoder.outPos} of ${unpackSize} bytes`);
  return decoder.output;
}

const LZMA2_CONTROL_END = 0x00;
const LZMA2_CONTROL_UNCOMPRESSED_RESET = 0x01;
const LZMA2_CONTROL_UNCOMPRESSED = 0x02;
const LZMA2_CONTROL_LZMA = 0x80;
const LZMA2_MODE_SHIFT = 5;
const LZMA2_MODE_MASK = 3;
const LZMA2_UNPACK_HIGH_MASK = 0x1f;

/**
 * Decodes an LZMA2 stream. `expectedSize` (when the container states it) sizes the output buffer up front; the output
 * never exceeds `maxOutput`. A stream that ends without its end byte but whose chunks fill `expectedSize` is accepted
 * (7z writes sizes, not end markers, for LZMA2 in some producers); anything truncated is an error.
 */
export function decodeLzma2(input: Uint8Array, maxOutput: number, expectedSize?: number): Uint8Array {
  return decodeLzma2At(input, 0, maxOutput, expectedSize).output;
}

/**
 * `decodeLzma2` for a stream that starts at `start` inside a larger buffer (an xz block); also returns the offset after
 * the stream's end byte, which a container needs when the block does not state its compressed size.
 */
export function decodeLzma2At(
  input: Uint8Array,
  start: number,
  maxOutput: number,
  expectedSize?: number
): { output: Uint8Array; end: number } {
  const initial = expectedSize !== undefined ? Math.min(expectedSize, maxOutput) : Math.min((input.length - start) * 4, maxOutput);
  const decoder = new LzmaDecoder(Math.max(initial, 0), maxOutput);
  let pos = start;
  let needDictionaryReset = true;
  let needProperties = true;
  let sawEnd = false;
  while (pos < input.length) {
    const control = input[pos++];
    if (control === LZMA2_CONTROL_END) {
      sawEnd = true;
      break;
    }
    if (control === LZMA2_CONTROL_UNCOMPRESSED_RESET || control === LZMA2_CONTROL_UNCOMPRESSED) {
      if (pos + 2 > input.length) throw corrupt('truncated LZMA2 chunk header');
      const size = ((input[pos] << 8) | input[pos + 1]) + 1;
      pos += 2;
      if (control === LZMA2_CONTROL_UNCOMPRESSED_RESET) {
        decoder.resetDictionary();
        needDictionaryReset = false;
        needProperties = true;
      } else if (needDictionaryReset) {
        throw corrupt('the first LZMA2 chunk must reset the dictionary');
      }
      if (pos + size > input.length) throw corrupt('truncated LZMA2 uncompressed chunk');
      decoder.appendRaw(input, pos, size);
      pos += size;
      continue;
    }
    if (control < LZMA2_CONTROL_LZMA) throw corrupt(`invalid LZMA2 control byte 0x${control.toString(16)}`);
    if (pos + 4 > input.length) throw corrupt('truncated LZMA2 chunk header');
    const unpackSize = (((control & LZMA2_UNPACK_HIGH_MASK) << 16) | (input[pos] << 8) | input[pos + 1]) + 1;
    const packSize = ((input[pos + 2] << 8) | input[pos + 3]) + 1;
    pos += 4;
    const mode = (control >>> LZMA2_MODE_SHIFT) & LZMA2_MODE_MASK;
    if (mode === 3) {
      decoder.resetDictionary();
      needDictionaryReset = false;
    } else if (needDictionaryReset) {
      throw corrupt('the first LZMA2 chunk must reset the dictionary');
    }
    if (mode >= 2) {
      if (pos >= input.length) throw corrupt('truncated LZMA2 properties');
      const props = parseLzmaPropertiesByte(input[pos++]);
      if (props.lc + props.lp > LZMA2_LC_LP_MAX) throw corrupt('LZMA2 requires lc + lp <= 4');
      decoder.setProperties(props);
      needProperties = false;
    } else if (needProperties) {
      throw corrupt('an LZMA2 chunk without properties follows a dictionary reset');
    }
    if (mode >= 1) decoder.resetState();
    if (pos + packSize > input.length) throw corrupt('truncated LZMA2 chunk');
    const consumedTo = decoder.decode(input, pos, pos + packSize, unpackSize, false);
    if (consumedTo !== pos + packSize) throw corrupt('an LZMA2 chunk did not use its whole compressed size');
    pos += packSize;
  }
  if (!sawEnd && (expectedSize === undefined || decoder.outPos !== expectedSize)) throw corrupt('the LZMA2 stream ends without its end marker');
  if (expectedSize !== undefined && decoder.outPos !== expectedSize) throw corrupt(`the stream holds ${decoder.outPos} bytes, not the ${expectedSize} stated`);
  return { output: decoder.output, end: pos };
}
