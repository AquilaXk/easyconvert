import { LzmaMatchFinder } from './lzma-matchfinder';
import * as model from './lzma-model';

// Hoisted into module constants: under a CommonJS loader an imported binding is a getter call on every use.
const ALIGN = model.ALIGN;
const ALIGN_BITS = model.ALIGN_BITS;
const BIT_MODEL_TOTAL = model.BIT_MODEL_TOTAL;
const END_POS_MODEL_INDEX = model.END_POS_MODEL_INDEX;
const FULL_DISTANCES = model.FULL_DISTANCES;
const IS_MATCH = model.IS_MATCH;
const IS_REP = model.IS_REP;
const IS_REP0_LONG = model.IS_REP0_LONG;
const IS_REP_G0 = model.IS_REP_G0;
const IS_REP_G1 = model.IS_REP_G1;
const IS_REP_G2 = model.IS_REP_G2;
const LEN_CHOICE = model.LEN_CHOICE;
const LEN_CHOICE2 = model.LEN_CHOICE2;
const LEN_CODER = model.LEN_CODER;
const LEN_HIGH = model.LEN_HIGH;
const LEN_HIGH_SYMBOLS = model.LEN_HIGH_SYMBOLS;
const LEN_LOW = model.LEN_LOW;
const LEN_LOW_SYMBOLS = model.LEN_LOW_SYMBOLS;
const LEN_MID = model.LEN_MID;
const LEN_MID_SYMBOLS = model.LEN_MID_SYMBOLS;
const LEN_TO_POS_STATES = model.LEN_TO_POS_STATES;
const LITERAL = model.LITERAL;
const LITERAL_CODER_SIZE = model.LITERAL_CODER_SIZE;
const MATCH_LEN_MAX = model.MATCH_LEN_MAX;
const MATCH_LEN_MIN = model.MATCH_LEN_MIN;
const POS_SLOT = model.POS_SLOT;
const POS_SLOT_BITS = model.POS_SLOT_BITS;
const POS_SPECIAL = model.POS_SPECIAL;
const PROB_INIT = model.PROB_INIT;
const REP_LEN_CODER = model.REP_LEN_CODER;
const STATE_AFTER_LITERAL = model.STATE_AFTER_LITERAL;
const probabilityCount = model.probabilityCount;

/**
 * LZMA encoder core: the probability model, the move encoders, and two parsers over the bt4 match finder. The fast parser
 * takes the best of the repeated distances and the longest match at each position; the normal parser prices every
 * literal, short repeat, repeated match and match by the current probabilities and finds the cheapest path through a
 * window of positions (a forward dynamic program, as the format's reference encoder describes it in its documentation).
 * Moves are held as (length, distance) pairs and classified as repeats only when they are written, so a parse stays valid
 * if the model is reset between parsing and writing (an LZMA2 chunk that had to be stored raw).
 */

export const LZMA_LC = 3;
export const LZMA_LP = 0;
export const LZMA_PB = 2;
export const LZMA_PROPERTIES_BYTE = (LZMA_PB * 5 + LZMA_LP) * 9 + LZMA_LC;
const POS_STATE_MASK = (1 << LZMA_PB) - 1;
const LP_MASK = (1 << LZMA_LP) - 1;

const PRICE_SHIFT = 4;
const PRICE_TABLE_SIZE = BIT_MODEL_TOTAL >>> PRICE_SHIFT;
const PRICE_UNIT = 1 << PRICE_SHIFT;
const PRICE_INFINITY = 0x0fffffff;
const PRICE_REFRESH_MATCHES = 256;
const LEN_PRICE_REFRESH_MOVES = 128;
const LEN_PRICES = MATCH_LEN_MAX - MATCH_LEN_MIN + 1;
const FAR_DISTANCE_SLOT = END_POS_MODEL_INDEX;

/** Price in 1/16 bit of coding a 0 bit with probability index i * 16 (the cost of the bit being 1 is the mirror entry). */
const BIT_PRICES = new Uint32Array(PRICE_TABLE_SIZE);
for (let i = 0; i < PRICE_TABLE_SIZE; i++) {
  const p = (i * (1 << PRICE_SHIFT) + (1 << (PRICE_SHIFT - 1))) / BIT_MODEL_TOTAL;
  BIT_PRICES[i] = Math.round(-Math.log2(p) * PRICE_UNIT);
}

export interface LzmaParserOptions {
  dictSize: number;
  niceLength: number;
  depth: number;
  /** 0 selects the fast parser; otherwise the number of positions the optimal parser looks ahead. */
  optimumWindow: number;
}

/** Index of the position slot of a zero-based distance (LZMA specification, "Decoding of distance"). */
export function posSlotOf(dist: number): number {
  if (dist < 4) return dist;
  const n = 31 - Math.clz32(dist);
  return dist < (1 << n) + (1 << (n - 1)) ? 2 * n : 2 * n + 1;
}

const OPT_NODE_PAD = MATCH_LEN_MAX + 2;

export class LzmaEncoderCore {
  readonly probs = new Uint16Array(probabilityCount(LZMA_LC, LZMA_LP));
  state = 0;
  rep0 = 0;
  rep1 = 0;
  rep2 = 0;
  rep3 = 0;
  /** Position of the next move to be written. */
  position = 0;

  private readonly data: Uint8Array;
  private readonly size: number;
  private readonly finder: LzmaMatchFinder;
  private readonly niceLength: number;
  private readonly optimumWindow: number;

  // Moves parsed but not yet written. A literal has distance -1; a one-byte repeat has length 1 and a distance.
  private readonly moveLengths: Int32Array;
  private readonly moveDistances: Int32Array;
  private moveHead = 0;
  private moveTail = 0;

  // Price caches (1/16 bit), refreshed from the probabilities every few hundred moves.
  private readonly lenPrices = new Int32Array(2 * (1 << LZMA_PB) * LEN_PRICES);
  private readonly posSlotPrices = new Int32Array(LEN_TO_POS_STATES << POS_SLOT_BITS);
  private readonly fullDistPrices = new Int32Array(LEN_TO_POS_STATES * FULL_DISTANCES);
  private readonly alignPrices = new Int32Array(1 << ALIGN_BITS);
  private matchesSincePriceRefresh = PRICE_REFRESH_MATCHES;
  private movesSinceLenRefresh = LEN_PRICE_REFRESH_MOVES;

  // Optimal parser nodes.
  private readonly optPrice: Int32Array;
  private readonly optLength: Int32Array;
  private readonly optDistance: Int32Array;
  private readonly optPrevious: Int32Array;
  private readonly optState: Uint8Array;
  private readonly optRep0: Int32Array;
  private readonly optRep1: Int32Array;
  private readonly optRep2: Int32Array;
  private readonly optRep3: Int32Array;
  private optEnd = 0;

  constructor(data: Uint8Array, parser: LzmaParserOptions) {
    this.data = data;
    this.size = data.length;
    this.niceLength = Math.min(parser.niceLength, MATCH_LEN_MAX);
    this.optimumWindow = parser.optimumWindow;
    this.finder = new LzmaMatchFinder(data, parser.dictSize, this.niceLength, parser.depth);
    const queue = Math.max(this.optimumWindow, 1) + OPT_NODE_PAD;
    this.moveLengths = new Int32Array(queue);
    this.moveDistances = new Int32Array(queue);
    const nodes = this.optimumWindow + OPT_NODE_PAD + 1;
    this.optPrice = new Int32Array(nodes);
    this.optLength = new Int32Array(nodes);
    this.optDistance = new Int32Array(nodes);
    this.optPrevious = new Int32Array(nodes);
    this.optState = new Uint8Array(nodes);
    this.optRep0 = new Int32Array(nodes);
    this.optRep1 = new Int32Array(nodes);
    this.optRep2 = new Int32Array(nodes);
    this.optRep3 = new Int32Array(nodes);
    this.resetModel();
  }

  /** Resets the probabilities, the state and the repeated distances (a fresh LZMA2 state, or the start of a stream). */
  resetModel(): void {
    this.probs.fill(PROB_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.matchesSincePriceRefresh = PRICE_REFRESH_MATCHES;
    this.movesSinceLenRefresh = LEN_PRICE_REFRESH_MOVES;
  }

  get hasPendingMoves(): boolean {
    return this.moveHead < this.moveTail;
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  private bitPrice(index: number, bit: number): number {
    return BIT_PRICES[(this.probs[index] ^ (-bit & (BIT_MODEL_TOTAL - 1))) >>> PRICE_SHIFT];
  }

  private treePrice(base: number, bits: number, symbol: number): number {
    let price = 0;
    let m = 1;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (symbol >>> i) & 1;
      price += this.bitPrice(base + m, bit);
      m = (m << 1) | bit;
    }
    return price;
  }

  private reverseTreePrice(base: number, bits: number, symbol: number): number {
    let price = 0;
    let m = 1;
    for (let i = 0; i < bits; i++) {
      const bit = (symbol >>> i) & 1;
      price += this.bitPrice(base + m, bit);
      m = (m << 1) | bit;
    }
    return price;
  }

  private literalPrice(pos: number, state: number, rep0: number, byte: number): number {
    const prev = pos > 0 ? this.data[pos - 1] : 0;
    const base = LITERAL + LITERAL_CODER_SIZE * (((pos & LP_MASK) << LZMA_LC) + (prev >>> (8 - LZMA_LC)));
    let price = 0;
    if (state < 7) return this.treePrice(base, 8, byte);
    let matchByte = this.data[pos - rep0 - 1];
    let offs = 0x100;
    let symbol = 1;
    for (let i = 7; i >= 0; i--) {
      matchByte <<= 1;
      const matchBit = matchByte & offs;
      const bit = (byte >>> i) & 1;
      price += this.bitPrice(base + offs + matchBit + symbol, bit);
      symbol = (symbol << 1) | bit;
      offs &= bit ? matchBit : ~matchBit;
    }
    return price;
  }

  /** Prices of every length at every position state for the length coder at `coder` (LEN_CODER or REP_LEN_CODER). */
  private refreshLenPrices(coder: number, into: number): void {
    const choice0 = this.bitPrice(coder + LEN_CHOICE, 0);
    const choice1 = this.bitPrice(coder + LEN_CHOICE, 1);
    const choice2Zero = this.bitPrice(coder + LEN_CHOICE2, 0);
    const choice2One = this.bitPrice(coder + LEN_CHOICE2, 1);
    for (let posState = 0; posState < 1 << LZMA_PB; posState++) {
      const row = into + posState * LEN_PRICES;
      for (let symbol = 0; symbol < LEN_PRICES; symbol++) {
        let price: number;
        if (symbol < LEN_LOW_SYMBOLS) {
          price = choice0 + this.treePrice(coder + LEN_LOW + (posState << 3), 3, symbol);
        } else if (symbol < LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS) {
          price = choice1 + choice2Zero + this.treePrice(coder + LEN_MID + (posState << 3), 3, symbol - LEN_LOW_SYMBOLS);
        } else {
          price = choice1 + choice2One + this.treePrice(coder + LEN_HIGH, 8, symbol - LEN_LOW_SYMBOLS - LEN_MID_SYMBOLS);
        }
        this.lenPrices[row + symbol] = price;
      }
    }
  }

  private refreshDistancePrices(): void {
    for (let lenState = 0; lenState < LEN_TO_POS_STATES; lenState++) {
      const slotBase = POS_SLOT + (lenState << POS_SLOT_BITS);
      for (let slot = 0; slot < 1 << POS_SLOT_BITS; slot++) {
        this.posSlotPrices[(lenState << POS_SLOT_BITS) + slot] = this.treePrice(slotBase, POS_SLOT_BITS, slot);
      }
      for (let dist = 0; dist < FULL_DISTANCES; dist++) {
        const slot = posSlotOf(dist);
        let price = this.posSlotPrices[(lenState << POS_SLOT_BITS) + slot];
        if (slot >= 4) {
          const footerBits = (slot >>> 1) - 1;
          const base = (2 | (slot & 1)) << footerBits;
          price += this.reverseTreePrice(POS_SPECIAL + base - slot - 1, footerBits, dist - base);
        }
        this.fullDistPrices[lenState * FULL_DISTANCES + dist] = price;
      }
    }
    for (let i = 0; i < 1 << ALIGN_BITS; i++) this.alignPrices[i] = this.reverseTreePrice(ALIGN, ALIGN_BITS, i);
    this.matchesSincePriceRefresh = 0;
  }

  private refreshAllLenPrices(): void {
    this.refreshLenPrices(LEN_CODER, 0);
    this.refreshLenPrices(REP_LEN_CODER, (1 << LZMA_PB) * LEN_PRICES);
    this.movesSinceLenRefresh = 0;
  }

  private matchLenPrice(len: number, posState: number): number {
    return this.lenPrices[posState * LEN_PRICES + len - MATCH_LEN_MIN];
  }

  private repLenPrice(len: number, posState: number): number {
    return this.lenPrices[((1 << LZMA_PB) + posState) * LEN_PRICES + len - MATCH_LEN_MIN];
  }

  private distancePrice(dist: number, len: number): number {
    const lenState = len - MATCH_LEN_MIN < LEN_TO_POS_STATES ? len - MATCH_LEN_MIN : LEN_TO_POS_STATES - 1;
    if (dist < FULL_DISTANCES) return this.fullDistPrices[lenState * FULL_DISTANCES + dist];
    const slot = posSlotOf(dist);
    const footerBits = (slot >>> 1) - 1;
    return this.posSlotPrices[(lenState << POS_SLOT_BITS) + slot] + (footerBits - ALIGN_BITS) * PRICE_UNIT + this.alignPrices[dist & ((1 << ALIGN_BITS) - 1)];
  }

  // -------------------------------------------------------------------------
  // Writing moves
  // -------------------------------------------------------------------------

  private encodeTree(rc: RangeSink, base: number, bits: number, symbol: number): void {
    let m = 1;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (symbol >>> i) & 1;
      rc.encodeBit(this.probs, base + m, bit);
      m = (m << 1) | bit;
    }
  }

  private encodeLength(rc: RangeSink, coder: number, len: number, posState: number): void {
    const symbol = len - MATCH_LEN_MIN;
    if (symbol < LEN_LOW_SYMBOLS) {
      rc.encodeBit(this.probs, coder + LEN_CHOICE, 0);
      this.encodeTree(rc, coder + LEN_LOW + (posState << 3), 3, symbol);
    } else if (symbol < LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS) {
      rc.encodeBit(this.probs, coder + LEN_CHOICE, 1);
      rc.encodeBit(this.probs, coder + LEN_CHOICE2, 0);
      this.encodeTree(rc, coder + LEN_MID + (posState << 3), 3, symbol - LEN_LOW_SYMBOLS);
    } else {
      rc.encodeBit(this.probs, coder + LEN_CHOICE, 1);
      rc.encodeBit(this.probs, coder + LEN_CHOICE2, 1);
      this.encodeTree(rc, coder + LEN_HIGH, 8, symbol - LEN_LOW_SYMBOLS - LEN_MID_SYMBOLS);
    }
  }

  private writeLiteral(rc: RangeSink): void {
    const pos = this.position;
    const data = this.data;
    const posState = pos & POS_STATE_MASK;
    rc.encodeBit(this.probs, IS_MATCH + (this.state << 4) + posState, 0);
    const prev = pos > 0 ? data[pos - 1] : 0;
    const base = LITERAL + LITERAL_CODER_SIZE * (((pos & LP_MASK) << LZMA_LC) + (prev >>> (8 - LZMA_LC)));
    const byte = data[pos];
    if (this.state < 7) {
      this.encodeTree(rc, base, 8, byte);
    } else {
      let matchByte = data[pos - this.rep0 - 1];
      let offs = 0x100;
      let symbol = 1;
      for (let i = 7; i >= 0; i--) {
        matchByte <<= 1;
        const matchBit = matchByte & offs;
        const bit = (byte >>> i) & 1;
        rc.encodeBit(this.probs, base + offs + matchBit + symbol, bit);
        symbol = (symbol << 1) | bit;
        offs &= bit ? matchBit : ~matchBit;
      }
    }
    this.state = STATE_AFTER_LITERAL[this.state];
    this.position = pos + 1;
  }

  private writeShortRep(rc: RangeSink): void {
    const posState = this.position & POS_STATE_MASK;
    rc.encodeBit(this.probs, IS_MATCH + (this.state << 4) + posState, 1);
    rc.encodeBit(this.probs, IS_REP + this.state, 1);
    rc.encodeBit(this.probs, IS_REP_G0 + this.state, 0);
    rc.encodeBit(this.probs, IS_REP0_LONG + (this.state << 4) + posState, 0);
    this.state = this.state < 7 ? 9 : 11;
    this.position += 1;
  }

  private writeRepeat(rc: RangeSink, index: number, len: number): void {
    const posState = this.position & POS_STATE_MASK;
    const state = this.state;
    rc.encodeBit(this.probs, IS_MATCH + (state << 4) + posState, 1);
    rc.encodeBit(this.probs, IS_REP + state, 1);
    if (index === 0) {
      rc.encodeBit(this.probs, IS_REP_G0 + state, 0);
      rc.encodeBit(this.probs, IS_REP0_LONG + (state << 4) + posState, 1);
    } else {
      rc.encodeBit(this.probs, IS_REP_G0 + state, 1);
      let distance: number;
      if (index === 1) {
        rc.encodeBit(this.probs, IS_REP_G1 + state, 0);
        distance = this.rep1;
      } else {
        rc.encodeBit(this.probs, IS_REP_G1 + state, 1);
        rc.encodeBit(this.probs, IS_REP_G2 + state, index - 2);
        if (index === 2) {
          distance = this.rep2;
        } else {
          distance = this.rep3;
          this.rep3 = this.rep2;
        }
        this.rep2 = this.rep1;
      }
      this.rep1 = this.rep0;
      this.rep0 = distance;
    }
    this.encodeLength(rc, REP_LEN_CODER, len, posState);
    this.state = state < 7 ? 8 : 11;
    this.position += len;
    this.movesSinceLenRefresh++;
  }

  private writeMatch(rc: RangeSink, len: number, dist: number): void {
    const posState = this.position & POS_STATE_MASK;
    const state = this.state;
    rc.encodeBit(this.probs, IS_MATCH + (state << 4) + posState, 1);
    rc.encodeBit(this.probs, IS_REP + state, 0);
    this.encodeLength(rc, LEN_CODER, len, posState);
    const lenState = len - MATCH_LEN_MIN < LEN_TO_POS_STATES ? len - MATCH_LEN_MIN : LEN_TO_POS_STATES - 1;
    const slot = posSlotOf(dist);
    this.encodeTree(rc, POS_SLOT + (lenState << POS_SLOT_BITS), POS_SLOT_BITS, slot);
    if (slot >= 4) {
      const footerBits = (slot >>> 1) - 1;
      const base = (2 | (slot & 1)) << footerBits;
      const reduced = dist - base;
      if (slot < FAR_DISTANCE_SLOT) {
        let m = 1;
        for (let i = 0; i < footerBits; i++) {
          const bit = (reduced >>> i) & 1;
          rc.encodeBit(this.probs, POS_SPECIAL + base - slot - 1 + m, bit);
          m = (m << 1) | bit;
        }
      } else {
        rc.encodeDirectBits(reduced >>> ALIGN_BITS, footerBits - ALIGN_BITS);
        let m = 1;
        for (let i = 0; i < ALIGN_BITS; i++) {
          const bit = (reduced >>> i) & 1;
          rc.encodeBit(this.probs, ALIGN + m, bit);
          m = (m << 1) | bit;
        }
        this.matchesSincePriceRefresh++;
      }
    }
    this.matchesSincePriceRefresh++;
    this.rep3 = this.rep2;
    this.rep2 = this.rep1;
    this.rep1 = this.rep0;
    this.rep0 = dist;
    this.state = state < 7 ? 7 : 10;
    this.position += len;
    this.movesSinceLenRefresh++;
  }

  /** Writes the next parsed move, classifying a match as a repeat when its distance is one of the four last. */
  private writeMove(rc: RangeSink): void {
    const len = this.moveLengths[this.moveHead];
    const dist = this.moveDistances[this.moveHead];
    this.moveHead++;
    if (len === 1) {
      if (dist >= 0 && dist === this.rep0 && this.position > this.rep0) this.writeShortRep(rc);
      else this.writeLiteral(rc);
      return;
    }
    if (dist === this.rep0) this.writeRepeat(rc, 0, len);
    else if (dist === this.rep1) this.writeRepeat(rc, 1, len);
    else if (dist === this.rep2) this.writeRepeat(rc, 2, len);
    else if (dist === this.rep3) this.writeRepeat(rc, 3, len);
    else this.writeMatch(rc, len, dist);
  }

  /**
   * Parses and writes moves until `limit` is reached, or until `stopWhen` (called before each move) returns true.
   * Moves already parsed by an earlier call are written first.
   */
  encode(rc: RangeSink, limit: number, stopWhen: () => boolean): void {
    while (this.position < limit) {
      if (stopWhen()) return;
      if (this.moveHead >= this.moveTail) {
        this.moveHead = 0;
        this.moveTail = 0;
        if (this.matchesSincePriceRefresh >= PRICE_REFRESH_MATCHES) this.refreshDistancePrices();
        if (this.movesSinceLenRefresh >= LEN_PRICE_REFRESH_MOVES) this.refreshAllLenPrices();
        if (this.optimumWindow > 0) this.parseOptimal(limit);
        else this.parseFast(limit);
      }
      this.writeMove(rc);
    }
  }

  // -------------------------------------------------------------------------
  // Parsers
  // -------------------------------------------------------------------------

  private pushMove(len: number, dist: number): void {
    this.moveLengths[this.moveTail] = len;
    this.moveDistances[this.moveTail] = dist;
    this.moveTail++;
  }

  private matchLengthAt(a: number, b: number, limit: number): number {
    return this.finder.commonLength(a, b, limit);
  }

  /** Greedy parse of one move: the best repeat, else the longest match, else a literal. */
  private parseFast(limit: number): void {
    const pos = this.position;
    const avail = Math.min(MATCH_LEN_MAX, limit - pos);
    const count = this.finder.findMatches();
    let mainLen = count > 0 ? this.finder.lengths[count - 1] : 0;
    let mainDist = count > 0 ? this.finder.distances[count - 1] : 0;
    if (mainLen > avail) mainLen = avail;

    let repLen = 0;
    let repDist = 0;
    for (let r = 0; r < 4; r++) {
      const dist = r === 0 ? this.rep0 : r === 1 ? this.rep1 : r === 2 ? this.rep2 : this.rep3;
      if (dist >= pos) continue;
      const len = this.matchLengthAt(pos, pos - dist - 1, avail);
      if (len > repLen) {
        repLen = len;
        repDist = dist;
      }
    }
    if (repLen >= 2 && (repLen >= this.niceLength || repLen + 1 >= mainLen || (repLen + 2 >= mainLen && mainDist >= 1 << 9))) {
      this.pushMove(repLen, repDist);
      this.finder.skip(repLen - 1);
      return;
    }
    if (mainLen >= 3 || (mainLen === 2 && mainDist < 1 << 7)) {
      this.pushMove(mainLen, mainDist);
      this.finder.skip(mainLen - 1);
      return;
    }
    if (repLen >= 2) {
      this.pushMove(repLen, repDist);
      this.finder.skip(repLen - 1);
      return;
    }
    this.pushMove(1, -1);
  }

  private relax(node: number, price: number, len: number, dist: number, previous: number, state: number, r0: number, r1: number, r2: number, r3: number): void {
    if (price < this.optPrice[node]) {
      this.optPrice[node] = price;
      this.optLength[node] = len;
      this.optDistance[node] = dist;
      this.optPrevious[node] = previous;
      this.optState[node] = state;
      this.optRep0[node] = r0;
      this.optRep1[node] = r1;
      this.optRep2[node] = r2;
      this.optRep3[node] = r3;
      if (node > this.optEnd) this.optEnd = node;
    }
  }

  /**
   * Parses a window of moves from the current position with a forward dynamic program over node prices, then queues the
   * cheapest path. The match finder is left at the position the path ends at.
   */
  private parseOptimal(limit: number): void {
    const finder = this.finder;
    const base = this.position;
    const window = Math.min(this.optimumWindow, limit - base);
    const lengths = finder.lengths;
    const distances = finder.distances;
    const nice = this.niceLength;

    let count = finder.findMatches();
    let mainLen = count > 0 ? lengths[count - 1] : 0;
    const avail0 = Math.min(MATCH_LEN_MAX, limit - base);
    if (mainLen > avail0) mainLen = avail0;

    // A match or repeat that reaches the nice length ends the search at once.
    let bestRepLen = 0;
    let bestRepDist = 0;
    for (let r = 0; r < 4; r++) {
      const dist = r === 0 ? this.rep0 : r === 1 ? this.rep1 : r === 2 ? this.rep2 : this.rep3;
      if (dist >= base) continue;
      const len = this.matchLengthAt(base, base - dist - 1, avail0);
      if (len > bestRepLen) {
        bestRepLen = len;
        bestRepDist = dist;
      }
    }
    if (bestRepLen >= nice) {
      this.pushMove(bestRepLen, bestRepDist);
      finder.skip(bestRepLen - 1);
      return;
    }
    if (mainLen >= nice) {
      this.pushMove(mainLen, distances[count - 1]);
      finder.skip(mainLen - 1);
      return;
    }

    for (let i = 0; i <= window + OPT_NODE_PAD; i++) this.optPrice[i] = PRICE_INFINITY;
    this.optPrice[0] = 0;
    this.optState[0] = this.state;
    this.optRep0[0] = this.rep0;
    this.optRep1[0] = this.rep1;
    this.optRep2[0] = this.rep2;
    this.optRep3[0] = this.rep3;
    this.optEnd = 0;

    let cur = 0;
    let finish = -1;
    for (;;) {
      const done = this.expandNode(cur, base, limit, count, nice);
      if (done > 0) {
        // A match of the nice length at this node ends the window right after it.
        finish = cur + done;
        finder.skip(done - 1);
        break;
      }
      cur++;
      if (cur >= this.optEnd || cur >= window) break;
      count = finder.findMatches();
    }
    const end = finish >= 0 ? finish : cur;

    // Walk the cheapest path back from `end` and queue it in order.
    let node = end;
    let n = 0;
    while (node > 0) {
      this.moveLengths[this.moveTail + n] = this.optLength[node];
      this.moveDistances[this.moveTail + n] = this.optDistance[node];
      n++;
      node = this.optPrevious[node];
    }
    for (let i = 0; i < n >> 1; i++) {
      const a = this.moveTail + i;
      const b = this.moveTail + n - 1 - i;
      const length = this.moveLengths[a];
      const distance = this.moveDistances[a];
      this.moveLengths[a] = this.moveLengths[b];
      this.moveDistances[a] = this.moveDistances[b];
      this.moveLengths[b] = length;
      this.moveDistances[b] = distance;
    }
    this.moveTail += n;
  }

  /**
   * Relaxes every move that starts at node `cur`. Returns a length when a match of at least the nice length starts here (its
   * end node has been relaxed and the caller should stop), else 0.
   */
  private expandNode(cur: number, base: number, limit: number, matchCount: number, nice: number): number {
    const data = this.data;
    const pos = base + cur;
    const price0 = this.optPrice[cur];
    const state = this.optState[cur];
    const r0 = this.optRep0[cur];
    const r1 = this.optRep1[cur];
    const r2 = this.optRep2[cur];
    const r3 = this.optRep3[cur];
    const posState = pos & POS_STATE_MASK;
    const avail = Math.min(MATCH_LEN_MAX, limit - pos);
    const matchIndex = IS_MATCH + (state << 4) + posState;
    const isMatchZero = this.bitPrice(matchIndex, 0);
    const isMatchOne = this.bitPrice(matchIndex, 1);

    // Literal.
    const byte = data[pos];
    const literal = price0 + isMatchZero + this.literalPrice(pos, state, r0, byte);
    this.relax(cur + 1, literal, 1, -1, cur, STATE_AFTER_LITERAL[state], r0, r1, r2, r3);

    const repBase = price0 + isMatchOne + this.bitPrice(IS_REP + state, 1);
    // One-byte repeat of the last distance.
    if (r0 < pos && data[pos - r0 - 1] === byte) {
      const price = repBase + this.bitPrice(IS_REP_G0 + state, 0) + this.bitPrice(IS_REP0_LONG + (state << 4) + posState, 0);
      this.relax(cur + 1, price, 1, r0, cur, state < 7 ? 9 : 11, r0, r1, r2, r3);
    }

    // Repeats of each of the four last distances.
    const repState = state < 7 ? 8 : 11;
    for (let r = 0; r < 4; r++) {
      const dist = r === 0 ? r0 : r === 1 ? r1 : r === 2 ? r2 : r3;
      if (dist >= pos) continue;
      // The same distance listed twice only needs one pass.
      if ((r === 1 && dist === r0) || (r === 2 && (dist === r0 || dist === r1)) || (r === 3 && (dist === r0 || dist === r1 || dist === r2))) continue;
      const len = this.matchLengthAt(pos, pos - dist - 1, avail);
      if (len < MATCH_LEN_MIN) continue;
      let indexPrice: number;
      if (r === 0) {
        indexPrice = this.bitPrice(IS_REP_G0 + state, 0) + this.bitPrice(IS_REP0_LONG + (state << 4) + posState, 1);
      } else if (r === 1) {
        indexPrice = this.bitPrice(IS_REP_G0 + state, 1) + this.bitPrice(IS_REP_G1 + state, 0);
      } else {
        indexPrice = this.bitPrice(IS_REP_G0 + state, 1) + this.bitPrice(IS_REP_G1 + state, 1) + this.bitPrice(IS_REP_G2 + state, r - 2);
      }
      const total = repBase + indexPrice;
      const n0 = dist;
      const n1 = r === 0 ? r1 : r0;
      const n2 = r <= 1 ? r2 : r1;
      const n3 = r <= 2 ? r3 : r2;
      for (let l = MATCH_LEN_MIN; l <= len; l++) {
        this.relax(cur + l, total + this.repLenPrice(l, posState), l, dist, cur, repState, n0, n1, n2, n3);
      }
      if (len >= nice) return len;
    }

    // Matches from the finder.
    if (matchCount > 0) {
      const lengths = this.finder.lengths;
      const distances = this.finder.distances;
      const matchBase = price0 + isMatchOne + this.bitPrice(IS_REP + state, 0);
      const matchState = state < 7 ? 7 : 10;
      let lenStart = MATCH_LEN_MIN;
      for (let k = 0; k < matchCount; k++) {
        const dist = distances[k];
        const maxLen = Math.min(lengths[k], avail);
        // The distance price depends on the length only up to the last length state, so it is looked up once for the rest.
        const shortEnd = Math.min(maxLen, MATCH_LEN_MIN + LEN_TO_POS_STATES - 2);
        let l = lenStart;
        for (; l <= shortEnd; l++) {
          this.relax(cur + l, matchBase + this.matchLenPrice(l, posState) + this.distancePrice(dist, l), l, dist, cur, matchState, dist, r0, r1, r2);
        }
        if (l <= maxLen) {
          const longBase = matchBase + this.distancePrice(dist, l);
          for (; l <= maxLen; l++) {
            this.relax(cur + l, longBase + this.matchLenPrice(l, posState), l, dist, cur, matchState, dist, r0, r1, r2);
          }
        }
        if (maxLen >= nice) return maxLen;
        lenStart = Math.max(lenStart, maxLen + 1);
      }
    }
    return 0;
  }
}

/** The part of the range encoder the move writers use. */
export interface RangeSink {
  encodeBit(probs: Uint16Array, index: number, bit: number): void;
  encodeDirectBits(value: number, bits: number): void;
  readonly pendingSize: number;
}
