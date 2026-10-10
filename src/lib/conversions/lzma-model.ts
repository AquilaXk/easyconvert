/**
 * The LZMA probability model: the layout of its single probability array, shared by the encoder and the decoder so that
 * the two cannot drift apart (LZMA specification, "The range decoder" and "Decoding of LZMA streams").
 */

export const STATES = 12;
export const POS_STATES_MAX = 16;
export const LEN_LOW_SYMBOLS = 8;
export const LEN_MID_SYMBOLS = 8;
export const LEN_HIGH_SYMBOLS = 256;
export const MATCH_LEN_MIN = 2;
export const MATCH_LEN_MAX = 273;
export const END_POS_MODEL_INDEX = 14;
export const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
export const POS_SLOT_BITS = 6;
export const LEN_TO_POS_STATES = 4;
export const ALIGN_BITS = 4;
export const LITERAL_CODER_SIZE = 0x300;
export const PROB_INIT = 1024;
export const BIT_MODEL_TOTAL_BITS = 11;
export const BIT_MODEL_TOTAL = 1 << BIT_MODEL_TOTAL_BITS;
export const MOVE_BITS = 5;

// Offsets of the model's parts inside the probability array.
export const IS_MATCH = 0;
export const IS_REP = IS_MATCH + STATES * POS_STATES_MAX;
export const IS_REP_G0 = IS_REP + STATES;
export const IS_REP_G1 = IS_REP_G0 + STATES;
export const IS_REP_G2 = IS_REP_G1 + STATES;
export const IS_REP0_LONG = IS_REP_G2 + STATES;
export const POS_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX;
export const POS_SPECIAL = POS_SLOT + LEN_TO_POS_STATES * (1 << POS_SLOT_BITS);
export const ALIGN = POS_SPECIAL + FULL_DISTANCES - END_POS_MODEL_INDEX + 1;
export const LEN_CODER = ALIGN + (1 << ALIGN_BITS);
// Inside a length coder:
export const LEN_CHOICE = 0;
export const LEN_CHOICE2 = 1;
export const LEN_LOW = 2;
export const LEN_MID = LEN_LOW + POS_STATES_MAX * LEN_LOW_SYMBOLS;
export const LEN_HIGH = LEN_MID + POS_STATES_MAX * LEN_MID_SYMBOLS;
export const LEN_CODER_SIZE = LEN_HIGH + LEN_HIGH_SYMBOLS;
export const REP_LEN_CODER = LEN_CODER + LEN_CODER_SIZE;
export const LITERAL = REP_LEN_CODER + LEN_CODER_SIZE;

/** Number of probabilities for the given literal context bits. */
export function probabilityCount(lc: number, lp: number): number {
  return LITERAL + (LITERAL_CODER_SIZE << (lc + lp));
}

/** State after a literal, a match, a repeated match and a short repeat (LZMA specification, "UpdateState"). */
export const STATE_AFTER_LITERAL: readonly number[] = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 4, 5];
export const STATE_LITERAL_LIMIT = 7;
export const STATE_AFTER_MATCH_FROM_LITERAL = 7;
export const STATE_AFTER_MATCH_FROM_MATCH = 10;
export const STATE_AFTER_REP_FROM_LITERAL = 8;
export const STATE_AFTER_REP_FROM_MATCH = 11;
export const STATE_AFTER_SHORT_REP_FROM_LITERAL = 9;
export const STATE_AFTER_SHORT_REP_FROM_MATCH = 11;
