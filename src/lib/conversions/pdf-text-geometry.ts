import './pdfjs-node-compat';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { PdfPageAnalysis } from '../types';
import type { OcrBaseline, OcrLayoutGroup, OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';
import { runPdfTextJobInThread } from './pdf-text-host';
import {
  PDF_TEXT_MAX_CHARS_PER_PAGE,
  PDF_TEXT_MAX_ITEM_CHARS,
  PDF_TEXT_MAX_ITEMS_PER_PAGE,
  PDF_TEXT_MAX_WORDS_PER_PAGE,
  PDF_TEXT_OPERATOR_LIST_MAX_ITEMS,
  PdfTextGeometryError,
  type PdfGeometryPages,
  type PdfTextJob,
  type PdfTextJobResult,
} from './pdf-text-types';

export {
  PDF_TEXT_MAX_CHARS_PER_PAGE,
  PDF_TEXT_MAX_ITEM_CHARS,
  PDF_TEXT_MAX_ITEMS_PER_PAGE,
  PDF_TEXT_MAX_WORDS_PER_PAGE,
  PDF_TEXT_OPERATOR_LIST_MAX_ITEMS,
  PdfTextGeometryError,
};
export type { PdfGeometryPages, PdfTextJob, PdfTextJobResult };

/**
 * Word, line, paragraph and block geometry for PDF pages whose text comes from the PDF's own text
 * layer, so hOCR and ALTO can be written for them without inventing boxes.
 *
 * pdfjs reports text as items (one per run of shown text) with a transform that places the run in PDF
 * user space (points, origin bottom-left). Everything is converted with the page viewport (scale 1),
 * which applies /Rotate and flips y, so results are in the page as displayed: top-left origin, points,
 * `viewport.width` x `viewport.height`.
 *
 * Splitting items into words. The page's operator list holds the glyphs in drawing order with their
 * advances; they are matched to each item's text (compatibility-normalized, so ligature glyphs match
 * their letters) and the item's width, which pdfjs reports exactly, is divided between its characters
 * in proportion to the advances (including character and word spacing, horizontal scaling and TJ
 * adjustments, which are tracked through the operator list). Where the glyphs cannot be matched, every
 * UTF-16 unit of the item gets an equal share. A gap pdfjs turned into a space counts as a quarter em.
 * Items that touch on a row without white space between them are one word (ligature glyphs, kerned
 * runs), unless their sizes differ, as for a superscript.
 *
 * Direction. The glyph stream is in drawing (visual) order and the item text in logical order. Text with
 * right-to-left characters is reordered by a compact form of the Unicode bidirectional algorithm (levels
 * by strong type, neutrals by their neighbours, numbers, reversal per level) and the result must equal
 * the drawn glyph sequence exactly; items that mix left-to-right and right-to-left letters and do not
 * match, or cannot be checked, raise PdfTextGeometryError. A right-to-left item without left-to-right
 * letters that does not match keeps equal shares. Words stay in logical order; the first word of a
 * right-to-left line is its rightmost.
 *
 * Vertical writing (style.vertical, dir ttb) runs down the page from the item origin; each glyph's cell
 * is one vertical advance long and as wide as the glyph, centred on the origin. Such lines, like text
 * drawn at an angle, are one line each, with the axis-aligned box of their words and no baseline.
 */

const PAGE_TEXT_OPERATORS = [
  'showText',
  'showSpacedText',
  'nextLineShowText',
  'nextLineSetSpacingShowText',
  'setFont',
  'setCharSpacing',
  'setWordSpacing',
  'setHScale',
  'save',
  'restore',
] as const;

/** How far ahead in the glyph stream to look for an item's glyphs after a mismatch. */
const GLYPH_RESYNC_WINDOW = 256;
/** After this many items in a row whose glyphs cannot be matched, matching stops for the rest of the page. */
const MAX_CONSECUTIVE_MISMATCHES = 16;
/** Glyph comparisons one item's matching may make per character of the item, resync attempts included ... */
const MATCH_STEPS_PER_CHAR = 8;
/** ... but at least this many, so short items can still search their whole resync window. */
const MATCH_STEPS_MIN = 4096;
/** Glyph comparisons all the matching of one page may make; beyond it items get equal shares. */
const MATCH_STEPS_PER_PAGE = 50_000_000;
/** PDF glyph widths are in thousandths of an em. */
const GLYPH_UNITS_PER_EM = 1000;
/** Weight of a gap pdfjs turned into a space, in em. */
const SYNTHETIC_SPACE_EM = 0.25;
/** Largest rise over run (about 1.7 degrees) at which an item still counts as horizontal. */
const HORIZONTAL_SLOPE_TOLERANCE = 0.03;
/** A run joins a row when its vertical extent overlaps the row's by at least this fraction of the smaller height. */
const ROW_OVERLAP_FRACTION = 0.5;
/** Two touching runs form one word when this close (em) horizontally. */
const WORD_JOIN_GAP_EM = 0.15;
/** ... and when their sizes differ by less than this ratio and their baselines by less than this many em. */
const WORD_JOIN_SIZE_RATIO = 1.25;
const WORD_JOIN_BASELINE_EM = 0.1;
/** A gap on a row is a column break when it exceeds this many times the median gap of the row ... */
const COLUMN_GAP_MEDIAN_FACTOR = 3;
/** ... and this many em, or whatever the median says when it exceeds this many em. */
const COLUMN_GAP_MIN_EM = 2.5;
const COLUMN_GAP_ALWAYS_EM = 8;
/** A baseline step of more than this many em starts a new paragraph. */
const PARAGRAPH_GAP_EM = 1.6;
/** A baseline step of more than this many em starts a new block. */
const BLOCK_GAP_EM = 3;
/** Baselines closer than this many em are the same row when deciding whether a line follows another. */
const SAME_ROW_EM = 0.35;
/** The newest this many open paragraphs are searched for the paragraph a line continues. */
const PARAGRAPH_CANDIDATE_LIMIT = 256;
/** Ascent and descent in em for a font that reports none: a typical split of the em box. */
const FALLBACK_ASCENT_EM = 0.8;
const FALLBACK_DESCENT_EM = 0.2;
const TRANSFORM_VALUES = 6;
const PERCENT_SCALE = 100;
const CH_SPACE = 0x20;
const CH_NBSP = 0xa0;
const FIRST_UNICODE_SPACE = 0x2000;
const LAST_UNICODE_SPACE = 0x200a;
const CH_IDEOGRAPHIC_SPACE = 0x3000;

interface Viewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}

interface Point {
  x: number;
  y: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  dir: string;
}

interface FontStyle {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

/** One shown glyph: its text as the font maps it and in compatibility form, its advance in text-space units, and its width in em for vertical text. */
export interface Glyph {
  /** The glyph's text as the font reports it (a ligature stays one character). */
  text: string;
  /** The same text after NFKC normalisation, which is how pdfjs reports some characters in the item text. */
  folded: string;
  advance: number;
  cross: number;
  /** One em in text-space units (font size times horizontal scaling), used to weigh a synthetic space. */
  em: number;
  /** Text-space units a TJ adjustment of one thousandth moves the next glyph; negative for vertical text, which advances downwards. */
  adjustment: number;
}

/** Positioned word pieces of one text item, in logical order. */
export interface ItemRun {
  words: OcrWord[];
  box: Box;
  /** The item's baseline in the displayed page; undefined when it runs steeper than 45 degrees or right to left. */
  baseline?: OcrBaseline;
  horizontal: boolean;
  /** The item has right-to-left letters, so its words are in logical order, right to left on the page. */
  rtl: boolean;
  /** Em size in points. */
  size: number;
  baselineY: number;
  /** The first (last) word starts (ends) at the edge of the item text, so it may continue in a neighbouring item. */
  startsWithWord?: boolean;
  endsWithWord?: boolean;
}

function isWordSpace(code: number): boolean {
  return (
    code <= CH_SPACE ||
    code === CH_NBSP ||
    (code >= FIRST_UNICODE_SPACE && code <= LAST_UNICODE_SPACE) ||
    code === CH_IDEOGRAPHIC_SPACE
  );
}

function isTextItem(candidate: unknown): candidate is TextItem {
  const item = candidate as Partial<TextItem> | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    item.transform.length === TRANSFORM_VALUES &&
    item.transform.every((value) => Number.isFinite(value)) &&
    typeof item.width === 'number' &&
    Number.isFinite(item.width)
  );
}

// ---------------------------------------------------------------------------------------------
// Glyph stream
// ---------------------------------------------------------------------------------------------

interface OperatorList {
  fnArray: number[];
  argsArray: unknown[][];
}

interface TextState {
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  scale: number;
}

/** The glyphs of every text-showing operator on the page in drawing order, with their advances. */
function collectGlyphs(operatorList: OperatorList, ops: Record<string, number>): Glyph[] {
  const code: Record<string, number> = {};
  for (const name of PAGE_TEXT_OPERATORS) code[name] = ops[name];
  const glyphs: Glyph[] = [];
  let state: TextState = { fontSize: 1, charSpacing: 0, wordSpacing: 0, scale: 1 };
  const saved: TextState[] = [];

  const show = (shown: unknown): void => {
    if (!Array.isArray(shown)) return;
    for (const entry of shown) {
      if (typeof entry === 'number') {
        // A TJ adjustment moves the next glyph back by thousandths of an em; it is part of the previous advance.
        const previous = glyphs[glyphs.length - 1];
        if (previous) previous.advance -= entry * previous.adjustment;
        continue;
      }
      const glyph = entry as { unicode?: unknown; width?: unknown; isSpace?: unknown; vmetric?: unknown } | null;
      if (typeof glyph !== 'object' || glyph === null || typeof glyph.unicode !== 'string' || typeof glyph.width !== 'number') continue;
      const em = state.fontSize * state.scale;
      const vertical = Array.isArray(glyph.vmetric) && typeof glyph.vmetric[0] === 'number';
      let advance: number;
      if (vertical) {
        advance = (Math.abs((glyph.vmetric as number[])[0]) / GLYPH_UNITS_PER_EM) * state.fontSize;
      } else {
        const spacing = state.charSpacing + (glyph.isSpace === true ? state.wordSpacing : 0);
        advance = ((glyph.width / GLYPH_UNITS_PER_EM) * state.fontSize + spacing) * state.scale;
      }
      const adjustment = ((vertical ? -state.fontSize : state.fontSize * state.scale)) / GLYPH_UNITS_PER_EM;
      glyphs.push({ text: glyph.unicode, folded: glyph.unicode.normalize('NFKC'), advance, cross: glyph.width / GLYPH_UNITS_PER_EM, em, adjustment });
    }
  };

  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index];
    if (fn === code.save) {
      saved.push({ ...state });
    } else if (fn === code.restore) {
      state = saved.pop() ?? state;
    } else if (fn === code.setFont) {
      if (typeof args?.[1] === 'number') state = { ...state, fontSize: args[1] };
    } else if (fn === code.setCharSpacing) {
      if (typeof args?.[0] === 'number') state = { ...state, charSpacing: args[0] };
    } else if (fn === code.setWordSpacing) {
      if (typeof args?.[0] === 'number') state = { ...state, wordSpacing: args[0] };
    } else if (fn === code.setHScale) {
      if (typeof args?.[0] === 'number') state = { ...state, scale: args[0] / PERCENT_SCALE };
    } else if (fn === code.showText || fn === code.showSpacedText || fn === code.nextLineShowText) {
      show(args?.[0]);
    } else if (fn === code.nextLineSetSpacingShowText) {
      if (typeof args?.[0] === 'number' && typeof args?.[1] === 'number') state = { ...state, wordSpacing: args[0], charSpacing: args[1] };
      show(args?.[2]);
    }
  });
  return glyphs;
}

interface Match {
  /** Advance per UTF-16 unit of the matched string. */
  advance: number[];
  /** Glyph width in em per unit (vertical text). */
  cross: number[];
  next: number;
}

interface MatchBudget {
  left: number;
}

/** The text of `glyph` that `target` has at `at`: as the font reports it, else in compatibility form, else null. */
function glyphTextAt(target: string, glyph: Glyph, at: number): string | null {
  if (target.startsWith(glyph.text, at)) return glyph.text;
  if (glyph.folded !== glyph.text && target.startsWith(glyph.folded, at)) return glyph.folded;
  return null;
}

/**
 * Walks the glyphs from `start` over `target`, writing each unit's advance and width into `out` when given.
 * Returns the index after the last glyph used, or -1 when the glyphs do not spell `target` or the budget
 * ran out. Allocates nothing, so a failed attempt costs only its steps.
 */
function walkGlyphs(target: string, glyphs: Glyph[], start: number, budget: MatchBudget, out: { advance: number[]; cross: number[] } | null): number {
  let at = 0;
  let index = start;
  while (at < target.length) {
    if (index >= glyphs.length || budget.left-- <= 0) return -1;
    const glyph = glyphs[index];
    const shown = glyphTextAt(target, glyph, at);
    if (shown === '') {
      index++;
    } else if (shown !== null) {
      if (out) {
        for (let i = 0; i < shown.length; i++) {
          out.advance[at + i] = glyph.advance / shown.length;
          out.cross[at + i] = glyph.cross;
        }
      }
      at += shown.length;
      index++;
    } else if (isWordSpace(target.charCodeAt(at))) {
      // A gap pdfjs turned into a space is not a glyph of its own.
      if (out) {
        out.advance[at] = SYNTHETIC_SPACE_EM * glyph.em;
        out.cross[at] = SYNTHETIC_SPACE_EM;
      }
      at++;
    } else {
      return -1;
    }
  }
  return index;
}

export interface Cursor {
  glyphs: Glyph[];
  next: number;
  failures: number;
  /** Glyph comparisons made so far on this page. */
  steps: number;
}

/** Spreads the glyphs from the cursor over `target` (searching ahead after a mismatch), or null when they do not spell it. */
function matchFromCursor(target: string, cursor: Cursor): Match | null {
  if (cursor.glyphs.length === 0 || cursor.failures >= MAX_CONSECUTIVE_MISMATCHES) return null;
  const budget: MatchBudget = {
    left: Math.min(Math.max(MATCH_STEPS_MIN, MATCH_STEPS_PER_CHAR * target.length), MATCH_STEPS_PER_PAGE - cursor.steps),
  };
  const allowed = budget.left;
  let found = -1;
  let from = cursor.next;
  for (let offset = 0; offset <= GLYPH_RESYNC_WINDOW && budget.left > 0; offset++) {
    from = cursor.next + offset;
    found = walkGlyphs(target, cursor.glyphs, from, budget, null);
    if (found >= 0) break;
  }
  cursor.steps += allowed - Math.max(budget.left, 0);
  if (found < 0) {
    cursor.failures++;
    return null;
  }
  const matched: Match = { advance: new Array<number>(target.length).fill(0), cross: new Array<number>(target.length).fill(0), next: found };
  walkGlyphs(target, cursor.glyphs, from, { left: Number.POSITIVE_INFINITY }, matched);
  cursor.steps += target.length;
  cursor.failures = 0;
  cursor.next = found;
  return matched;
}

// ---------------------------------------------------------------------------------------------
// Bidirectional order
// ---------------------------------------------------------------------------------------------

/** Scripts written right to left; the lookahead keeps their digits and marks out of the letter tests. */
const RIGHT_TO_LEFT_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const RIGHT_TO_LEFT_LETTER = /(?=\p{L})[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
/** Scripts whose letters are Arabic letters (bidirectional class AL): a number after one is an Arabic number. */
const ARABIC_SCRIPT = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;
const ANY_LETTER = /\p{L}/u;
const COMBINING_MARK = /\p{M}/u;
/** Arabic-Indic digits and the Arabic decimal and thousands separators (class AN). */
const ARABIC_NUMBER = /[\u0660-\u0669\u066b\u066c]/;
/** Digits of the European and extended Arabic-Indic sets (class EN). */
const EUROPEAN_NUMBER = /[0-9\u06f0-\u06f9]/;
/** Separators that stay part of a number between two digits: , . / : and the no-break space. */
const COMMON_SEPARATORS = new Set([',', '.', '/', ':', '\u00a0']);
/** Signs that stay part of a number between two digits. */
const NUMBER_SIGNS = new Set(['+', '-']);
/** Currency, percent and similar symbols that cling to an adjacent number. */
const NUMBER_TERMINATORS = /[\p{Sc}%#\u00b0\u00b1\u2030\u2032\u2033]/u;

/** Bidirectional classes of Unicode Annex 9 that matter here; N stands for every neutral. */
type BidiType = 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'ES' | 'ET' | 'CS' | 'N' | 'M';

function bidiType(unit: string): BidiType {
  if (ARABIC_NUMBER.test(unit)) return 'AN';
  if (EUROPEAN_NUMBER.test(unit)) return 'EN';
  if (COMBINING_MARK.test(unit)) return 'M';
  if (ARABIC_SCRIPT.test(unit)) return 'AL';
  if (RIGHT_TO_LEFT_SCRIPT.test(unit)) return 'R';
  if (ANY_LETTER.test(unit)) return 'L';
  if (COMMON_SEPARATORS.has(unit)) return 'CS';
  if (NUMBER_SIGNS.has(unit)) return 'ES';
  if (NUMBER_TERMINATORS.test(unit)) return 'ET';
  return 'N';
}

function isNumberType(type: BidiType): boolean {
  return type === 'EN' || type === 'AN';
}

/** W2 and W3: a European number after an Arabic letter is an Arabic number; Arabic letters then count as right-to-left. */
function resolveArabicContext(types: BidiType[], base: BidiType): void {
  let lastStrong: BidiType = base;
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if (type === 'L' || type === 'R' || type === 'AL') lastStrong = type;
    if (type === 'EN' && lastStrong === 'AL') types[i] = 'AN';
  }
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'AL') types[i] = 'R';
  }
}

/** W4: a single separator between two numbers of its kind joins them. */
function resolveSeparators(types: BidiType[]): void {
  for (let i = 1; i < types.length - 1; i++) {
    const before = types[i - 1];
    const type = types[i];
    if (before !== types[i + 1]) continue;
    if (before === 'EN' && (type === 'CS' || type === 'ES')) types[i] = 'EN';
    else if (before === 'AN' && type === 'CS') types[i] = 'AN';
  }
}

/** W5: a run of terminators next to a European number is part of it. */
function resolveTerminators(types: BidiType[]): void {
  for (let i = 0; i < types.length; ) {
    if (types[i] !== 'ET') {
      i++;
      continue;
    }
    let end = i;
    while (end < types.length && types[end] === 'ET') end++;
    const touchesNumber = (i > 0 && types[i - 1] === 'EN') || (end < types.length && types[end] === 'EN');
    if (touchesNumber) types.fill('EN', i, end);
    i = end;
  }
}

/** W6 and W7: leftover separators and terminators are neutral, and a European number after left-to-right text is left-to-right. */
function resolveRemainingWeak(types: BidiType[], base: BidiType): void {
  let lastStrong: BidiType = base;
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if (type === 'L' || type === 'R') lastStrong = type;
    else if (type === 'EN' && lastStrong === 'L') types[i] = 'L';
    else if (type === 'CS' || type === 'ES' || type === 'ET') types[i] = 'N';
  }
}

/** The direction a neighbour counts as for neutrals: numbers count as right-to-left (N1). */
function strongDirection(type: BidiType): BidiType {
  if (isNumberType(type)) return 'R';
  return type;
}

/** N1 and N2: a run of neutrals takes the direction of the strong types on both sides when they agree, otherwise the paragraph's. */
function resolveNeutrals(types: BidiType[], base: BidiType): BidiType[] {
  const resolved = types.slice();
  for (let i = 0; i < types.length; ) {
    if (types[i] !== 'N') {
      i++;
      continue;
    }
    let end = i;
    while (end < types.length && types[end] === 'N') end++;
    const before = i > 0 ? strongDirection(types[i - 1]) : base;
    const after = end < types.length ? strongDirection(types[end]) : base;
    resolved.fill(before === after ? before : base, i, end);
    i = end;
  }
  return resolved;
}

/** Embedding levels: even levels run left to right, odd ones right to left; a number or left-to-right text inside right-to-left text sits one level higher. */
const LEVEL_LTR = 0;
const LEVEL_RTL = 1;
const LEVEL_NUMBER = 2;

/** The level of a resolved strong or number type in a paragraph of the given direction (rules I1 and I2). */
function levelOf(type: BidiType, baseRightToLeft: boolean): number {
  if (type === 'R') return LEVEL_RTL;
  if (isNumberType(type)) return LEVEL_NUMBER;
  if (baseRightToLeft) return LEVEL_NUMBER;
  return LEVEL_LTR;
}

/** The lowest level whose runs are reversed (rule L2): the lowest odd level, or none when there is no odd level. */
function lowestReversedLevel(baseRightToLeft: boolean, lowestOdd: number, highest: number): number {
  if (baseRightToLeft) return LEVEL_RTL;
  if (Number.isFinite(lowestOdd)) return lowestOdd;
  return highest + 1;
}

/** Reverses, from the highest level down to `floor`, every run of units at that level or above. */
function reverseByLevels(levels: number[], floor: number, highest: number): number[] {
  const order = Array.from({ length: levels.length }, (_, i) => i);
  for (let level = highest; level >= floor; level--) {
    for (let i = 0; i < order.length; ) {
      if (levels[order[i]] < level) {
        i++;
        continue;
      }
      let end = i;
      while (end < order.length && levels[order[end]] >= level) end++;
      for (let a = i, b = end - 1; a < b; a++, b--) [order[a], order[b]] = [order[b], order[a]];
      i = end;
    }
  }
  return order;
}

interface VisualOrder {
  /** Logical unit index of each visual position. */
  order: number[];
  hasRight: boolean;
  hasLeft: boolean;
}

/** W1 and the initial classes: a mark takes the class of the unit before it. */
function initialTypes(text: string, base: BidiType): BidiType[] {
  const types: BidiType[] = new Array<BidiType>(text.length);
  let previous: BidiType = base;
  for (let i = 0; i < text.length; i++) {
    let type = bidiType(text[i]);
    if (type === 'M') type = previous;
    types[i] = type;
    previous = type;
  }
  return types;
}

/**
 * Visual order of `text` by a compact form of the Unicode bidirectional algorithm (Annex 9, one paragraph,
 * no embeddings or isolates): weak types (W1 to W7), neutrals (N1, N2), levels (I1, I2) and reversal (L2).
 */
function visualOrder(text: string, baseRightToLeft: boolean): VisualOrder {
  const base: BidiType = baseRightToLeft ? 'R' : 'L';
  const types = initialTypes(text, base);
  const hasRight = types.some((type) => type === 'R' || type === 'AL');
  const hasLeft = types.includes('L');
  resolveArabicContext(types, base);
  resolveSeparators(types);
  resolveTerminators(types);
  resolveRemainingWeak(types, base);
  const levels = resolveNeutrals(types, base).map((type) => levelOf(type, baseRightToLeft));
  let highest = LEVEL_LTR;
  let lowestOdd = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    highest = Math.max(highest, level);
    if (level % 2 === 1) lowestOdd = Math.min(lowestOdd, level);
  }
  const order = reverseByLevels(levels, lowestReversedLevel(baseRightToLeft, lowestOdd, highest), highest);
  return { order, hasRight, hasLeft };
}

// ---------------------------------------------------------------------------------------------
// Item to words
// ---------------------------------------------------------------------------------------------

/** How an item's text maps to drawn positions: a weight per visual unit and the visual index of each logical unit. */
export interface Placement {
  advance: number[];
  cross: number[];
  /** Visual index of each logical unit; null when they are the same. */
  toVisual: Int32Array | null;
  rightToLeft: boolean;
}

function equalShares(length: number): { advance: number[]; cross: number[] } {
  return { advance: new Array<number>(length).fill(1), cross: new Array<number>(length).fill(1) };
}

/** Where each unit of the item's text is drawn; exported so the matching rules can be tested with a synthetic glyph stream. */
export function placeItem(item: Pick<TextItem, 'str' | 'dir'>, cursor: Cursor, vertical: boolean, pageNumber: number): Placement {
  const text = item.str;
  const hasRightLetter = !vertical && RIGHT_TO_LEFT_LETTER.test(text);
  if (!hasRightLetter) {
    const matched = matchFromCursor(text, cursor);
    const weights = matched ?? equalShares(text.length);
    return { advance: weights.advance, cross: weights.cross, toVisual: null, rightToLeft: false };
  }
  const { order, hasLeft } = visualOrder(text, item.dir === 'rtl');
  const visual = order.map((logical) => text[logical]).join('');
  const matched = matchFromCursor(visual, cursor);
  if (matched === null && hasLeft) {
    throw new PdfTextGeometryError(`PDF page ${pageNumber} has mixed-direction text whose visual order cannot be resolved exactly.`);
  }
  const toVisual = new Int32Array(text.length);
  order.forEach((logical, visualIndex) => {
    toVisual[logical] = visualIndex;
  });
  const weights = matched ?? equalShares(text.length);
  return { advance: weights.advance, cross: weights.cross, toVisual, rightToLeft: true };
}

interface WordBudget {
  left: number;
  pageNumber: number;
}

function toViewport(viewport: Viewport, x: number, y: number): Point {
  const [vx, vy] = viewport.convertToViewportPoint(x, y);
  return { x: vx, y: vy };
}

function boxOf(points: Point[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const point of points) {
    if (point.x < x0) x0 = point.x;
    if (point.y < y0) y0 = point.y;
    if (point.x > x1) x1 = point.x;
    if (point.y > y1) y1 = point.y;
  }
  return { x0, y0, x1, y1 };
}

function toBBox(box: Box): OcrLineBlock['bbox'] {
  return { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

/** The item's text-space axes in user space, with its origin and the page viewport. */
interface TextFrame {
  viewport: Viewport;
  e: number;
  f: number;
  /** Unit vector along the baseline. */
  ux: number;
  uy: number;
  /** Unit vector up from the baseline. */
  vx: number;
  vy: number;
}

/** Distances along the item's advance direction. */
interface Span {
  d0: number;
  d1: number;
}

interface WordSpan {
  start: number;
  end: number;
}

interface FontMetrics {
  ascent: number;
  descent: number;
}

function fontMetrics(style: FontStyle | undefined): FontMetrics {
  const ascent = typeof style?.ascent === 'number' && Number.isFinite(style.ascent) ? style.ascent : FALLBACK_ASCENT_EM;
  const descent = typeof style?.descent === 'number' && Number.isFinite(style.descent) ? -style.descent : FALLBACK_DESCENT_EM;
  return { ascent, descent };
}

/** Offset of each unit's start along the item, sharing `length` between the units in proportion to their weights. */
function shareOffsets(placement: Placement, count: number, length: number): Float64Array {
  let total = 0;
  for (let i = 0; i < count; i++) total += placement.advance[i];
  if (!(total > 0)) {
    // Glyphs with no advance at all: share the item's width equally rather than dropping its text.
    placement.advance.fill(1);
    total = count;
  }
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + (placement.advance[i] / total) * length;
  return offsets;
}

/** The words of `text` (runs of non-space units), counted against the page's word budget. */
function wordSpansOf(text: string, budget: WordBudget): WordSpan[] {
  const spans: WordSpan[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const space = i === text.length || isWordSpace(text.charCodeAt(i));
    if (!space) {
      if (start === -1) start = i;
      continue;
    }
    if (start === -1) continue;
    if (budget.left-- <= 0) throw new PdfTextGeometryError(`PDF page ${budget.pageNumber} has more than ${PDF_TEXT_MAX_WORDS_PER_PAGE} words.`);
    spans.push({ start, end: i });
    start = -1;
  }
  return spans;
}

/** The corners of one word in the displayed page. */
function wordCorners(span: WordSpan, placement: Placement, offsets: Float64Array, frame: TextFrame, vertical: boolean, size: number, metrics: FontMetrics): Point[] {
  let d0 = Infinity;
  let d1 = -Infinity;
  let wide = 0;
  for (let k = span.start; k < span.end; k++) {
    const visualIndex = placement.toVisual ? placement.toVisual[k] : k;
    d0 = Math.min(d0, offsets[visualIndex]);
    d1 = Math.max(d1, offsets[visualIndex + 1]);
    wide = Math.max(wide, placement.cross[visualIndex]);
  }
  if (vertical) {
    const cell = wide > 0 ? wide : 1;
    return verticalCorners(frame, { d0, d1 }, (cell * size) / 2);
  }
  return horizontalCorners(frame, { d0, d1 }, { up: metrics.ascent * size, down: metrics.descent * size });
}

/** Splits one item into positioned words, or null when it has none or is invisible (zero scale). */
function splitItem(
  item: TextItem,
  style: FontStyle | undefined,
  viewport: Viewport,
  placement: Placement,
  vertical: boolean,
  budget: WordBudget
): ItemRun | null {
  const [a, b, c, d, e, f] = item.transform;
  const run = Math.hypot(a, b);
  const size = Math.hypot(c, d);
  const length = vertical ? item.height : item.width;
  if (run === 0 || size === 0 || !(length > 0)) return null;
  const frame: TextFrame = { viewport, e, f, ux: a / run, uy: b / run, vx: c / size, vy: d / size };
  const offsets = shareOffsets(placement, item.str.length, length);
  const spans = wordSpansOf(item.str, budget);
  if (spans.length === 0) return null;

  const metrics = fontMetrics(style);
  const words: OcrWord[] = [];
  const corners: Point[] = [];
  for (const span of spans) {
    const spanCorners = wordCorners(span, placement, offsets, frame, vertical, size, metrics);
    words.push({ text: item.str.slice(span.start, span.end), bbox: toBBox(boxOf(spanCorners)) });
    corners.push(...spanCorners);
  }
  return itemRun(item, words, boxOf(corners), frame, { vertical, length, size, rtl: placement.rightToLeft });
}

interface RunShape {
  vertical: boolean;
  length: number;
  size: number;
  rtl: boolean;
}

/** The item's run: its words with the box, direction, size and (for horizontal text) baseline in the displayed page. */
function itemRun(item: TextItem, words: OcrWord[], box: Box, frame: TextFrame, shape: RunShape): ItemRun {
  const { viewport, e, f, ux, uy, vx, vy } = frame;
  const first = toViewport(viewport, e, f);
  const last = shape.vertical
    ? toViewport(viewport, e - vx * shape.length, f - vy * shape.length)
    : toViewport(viewport, e + ux * shape.length, f + uy * shape.length);
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const horizontal = !shape.vertical && dx > 0 && Math.abs(dy) <= HORIZONTAL_SLOPE_TOLERANCE * dx;
  const result: ItemRun = {
    words,
    box,
    horizontal,
    rtl: shape.rtl,
    size: shape.size,
    baselineY: first.y,
    startsWithWord: !isWordSpace(item.str.charCodeAt(0)),
    endsWithWord: !isWordSpace(item.str.charCodeAt(item.str.length - 1)),
  };
  if (!shape.vertical && dx > 0 && Math.abs(dy) <= dx) result.baseline = { x0: first.x, y0: first.y, x1: last.x, y1: last.y };
  return result;
}

/** Corners of a horizontal word: `up` above the baseline and `down` below it, between the distances `span`. */
function horizontalCorners(frame: TextFrame, span: Span, extent: { up: number; down: number }): Point[] {
  const { viewport, e, f, ux, uy, vx, vy } = frame;
  const p0x = e + ux * span.d0;
  const p0y = f + uy * span.d0;
  const p1x = e + ux * span.d1;
  const p1y = f + uy * span.d1;
  return [
    toViewport(viewport, p0x + vx * extent.up, p0y + vy * extent.up),
    toViewport(viewport, p1x + vx * extent.up, p1y + vy * extent.up),
    toViewport(viewport, p1x - vx * extent.down, p1y - vy * extent.down),
    toViewport(viewport, p0x - vx * extent.down, p0y - vy * extent.down),
  ];
}

/** Vertical text runs down from the origin: the cell of a word is `half` either side of the path. */
function verticalCorners(frame: TextFrame, span: Span, half: number): Point[] {
  const { viewport, e, f, ux, uy, vx, vy } = frame;
  const p0x = e - vx * span.d0;
  const p0y = f - vy * span.d0;
  const p1x = e - vx * span.d1;
  const p1y = f - vy * span.d1;
  return [
    toViewport(viewport, p0x + ux * half, p0y + uy * half),
    toViewport(viewport, p0x - ux * half, p0y - uy * half),
    toViewport(viewport, p1x - ux * half, p1y - uy * half),
    toViewport(viewport, p1x + ux * half, p1y + uy * half),
  ];
}

// ---------------------------------------------------------------------------------------------
// Layout: rows, lines, paragraphs, blocks
// ---------------------------------------------------------------------------------------------

/** A word, or a whole right-to-left run, placed on a row. */
interface Unit {
  words: OcrWord[];
  box: Box;
  run: ItemRun;
  rtl: boolean;
  /** The unit starts (ends) a run at a word edge, so it may be joined to the run before (after) it. */
  joinsBefore: boolean;
  joinsAfter: boolean;
}

interface TextLine {
  words: OcrWord[];
  box: Box;
  baseline: OcrBaseline | undefined;
  size: number;
  baselineY: number;
  row: number;
  /** Left edge, to order lines of one row. */
  left: number;
}

function wordBox(word: OcrWord): Box {
  return { x0: word.bbox.x, y0: word.bbox.y, x1: word.bbox.x + word.bbox.width, y1: word.bbox.y + word.bbox.height };
}

function mergeBoxes(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function unitsOf(run: ItemRun): Unit[] {
  if (run.rtl) {
    return [{ words: run.words, box: run.box, run, rtl: true, joinsBefore: false, joinsAfter: false }];
  }
  return run.words.map((word, index) => ({
    words: [word],
    box: wordBox(word),
    run,
    rtl: false,
    joinsBefore: index === 0 && run.startsWithWord === true,
    joinsAfter: index === run.words.length - 1 && run.endsWithWord === true,
  }));
}

function canJoin(left: Unit, right: Unit): boolean {
  if (left.rtl || right.rtl || !left.joinsAfter || !right.joinsBefore) return false;
  const size = Math.max(left.run.size, right.run.size);
  const ratio = Math.max(left.run.size, right.run.size) / Math.min(left.run.size, right.run.size);
  return (
    right.box.x0 - left.box.x1 <= WORD_JOIN_GAP_EM * size &&
    ratio <= WORD_JOIN_SIZE_RATIO &&
    Math.abs(left.run.baselineY - right.run.baselineY) <= WORD_JOIN_BASELINE_EM * size
  );
}

function joinTouching(units: Unit[]): Unit[] {
  const joined: Unit[] = [];
  for (const unit of units) {
    const previous = joined[joined.length - 1];
    if (previous && canJoin(previous, unit)) {
      const word: OcrWord = {
        text: previous.words[0].text + unit.words[0].text,
        bbox: toBBox(mergeBoxes(previous.box, unit.box)),
      };
      joined[joined.length - 1] = {
        words: [word],
        box: mergeBoxes(previous.box, unit.box),
        run: previous.run.size >= unit.run.size ? previous.run : unit.run,
        rtl: false,
        joinsBefore: previous.joinsBefore,
        joinsAfter: unit.joinsAfter,
      };
    } else {
      joined.push(unit);
    }
  }
  return joined;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((p, q) => p - q);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function baselineAt(baseline: OcrBaseline, x: number): number {
  const slope = (baseline.y1 - baseline.y0) / (baseline.x1 - baseline.x0);
  return baseline.y0 + slope * (x - baseline.x0);
}

function lineFromUnits(units: Unit[], row: number): TextLine {
  let main = units[0].run;
  let box = units[0].box;
  let rightToLeftLetters = 0;
  let leftToRightLetters = 0;
  for (const unit of units) {
    if (unit.run.size > main.size) main = unit.run;
    box = mergeBoxes(box, unit.box);
    for (const word of unit.words) {
      for (const character of word.text) {
        if (RIGHT_TO_LEFT_LETTER.test(character)) rightToLeftLetters++;
        else if (ANY_LETTER.test(character)) leftToRightLetters++;
      }
    }
  }
  // Reading order follows the direction most of the line's letters have.
  const ordered = rightToLeftLetters > leftToRightLetters && rightToLeftLetters > 0 ? units.slice().reverse() : units;
  const words = ordered.flatMap((unit) => unit.words);
  let baseline: OcrBaseline | undefined;
  if (main.baseline) {
    baseline = { x0: box.x0, y0: baselineAt(main.baseline, box.x0), x1: box.x1, y1: baselineAt(main.baseline, box.x1) };
  }
  return { words, box, baseline, size: main.size, baselineY: main.baselineY, row, left: box.x0 };
}

/** Rows of horizontal runs: runs whose vertical extents overlap by at least half the smaller height. */
function clusterRows(runs: ItemRun[]): ItemRun[][] {
  const sorted = runs.slice().sort((p, q) => p.box.y0 - q.box.y0 || p.box.x0 - q.box.x0);
  const rows: ItemRun[][] = [];
  let current: ItemRun[] = [];
  let top = 0;
  let bottom = 0;
  for (const run of sorted) {
    if (current.length > 0) {
      const overlap = Math.min(bottom, run.box.y1) - Math.max(top, run.box.y0);
      const smaller = Math.min(bottom - top, run.box.y1 - run.box.y0);
      if (overlap >= ROW_OVERLAP_FRACTION * smaller) {
        current.push(run);
        top = Math.min(top, run.box.y0);
        bottom = Math.max(bottom, run.box.y1);
        continue;
      }
      rows.push(current);
    }
    current = [run];
    top = run.box.y0;
    bottom = run.box.y1;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Splits one row into lines at gaps that are wide compared with the row's own word gaps. */
function rowToLines(row: ItemRun[], rowIndex: number): TextLine[] {
  const ordered = row.slice().sort((p, q) => p.box.x0 - q.box.x0);
  const units = joinTouching(ordered.flatMap(unitsOf));
  if (units.length === 0) return [];
  let largest = 0;
  for (const unit of units) largest = Math.max(largest, unit.run.size);
  const gaps: number[] = [];
  for (let i = 1; i < units.length; i++) gaps.push(Math.max(0, units[i].box.x0 - units[i - 1].box.x1));
  const typical = gaps.length > 0 ? median(gaps) : 0;
  const threshold = Math.min(
    COLUMN_GAP_ALWAYS_EM * largest,
    Math.max(COLUMN_GAP_MEDIAN_FACTOR * typical, COLUMN_GAP_MIN_EM * largest)
  );
  const lines: TextLine[] = [];
  let segment: Unit[] = [units[0]];
  for (let i = 1; i < units.length; i++) {
    if (gaps[i - 1] > threshold) {
      lines.push(lineFromUnits(segment, rowIndex));
      segment = [];
    }
    segment.push(units[i]);
  }
  lines.push(lineFromUnits(segment, rowIndex));
  return lines;
}

interface BlockState {
  group: OcrLayoutGroup;
  paragraphs: ParagraphState[];
}

interface ParagraphState {
  group: OcrLayoutGroup;
  block: BlockState;
  box: Box;
  baselineY: number;
  lines: TextLine[];
}

function horizontalOverlap(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
}

function lineBlockOf(line: TextLine, block: OcrLayoutGroup, paragraph: OcrLayoutGroup): OcrLineBlock {
  const lineBlock: OcrLineBlock = {
    text: line.words.map((word) => word.text).join(' '),
    bbox: toBBox(line.box),
    words: line.words,
    block,
    paragraph,
  };
  if (line.baseline) lineBlock.baseline = line.baseline;
  return lineBlock;
}

/**
 * Lines, paragraphs and blocks of a page from its item runs, in reading order (block, paragraph, line).
 * Runs that are not horizontal, such as rotated or vertical text, each form a line, paragraph and block
 * of their own after the horizontal text.
 */
export function layoutItemRuns(runs: ItemRun[]): OcrLineBlock[] {
  const horizontal: ItemRun[] = [];
  const standalone: ItemRun[] = [];
  for (const run of runs) (run.horizontal ? horizontal : standalone).push(run);

  const blocks: BlockState[] = [];
  const paragraphs: ParagraphState[] = [];
  let rowStart = 0;
  clusterRows(horizontal).forEach((row, rowIndex) => {
    rowStart = paragraphs.length;
    const lines = rowToLines(row, rowIndex).sort((p, q) => p.left - q.left);
    for (const line of lines) {
      let parent: ParagraphState | undefined;
      // Only paragraphs from earlier rows can be continued, and only the newest few are searched.
      const oldest = Math.max(0, rowStart - PARAGRAPH_CANDIDATE_LIMIT);
      for (let i = rowStart - 1; i >= oldest; i--) {
        const candidate = paragraphs[i];
        const step = line.baselineY - candidate.baselineY;
        if (step > SAME_ROW_EM * line.size && step <= BLOCK_GAP_EM * line.size && horizontalOverlap(candidate.box, line.box)) {
          parent = candidate;
          break;
        }
      }
      if (parent && line.baselineY - parent.baselineY <= PARAGRAPH_GAP_EM * line.size) {
        parent.box = mergeBoxes(parent.box, line.box);
        parent.baselineY = line.baselineY;
        parent.lines.push(line);
        continue;
      }
      let block: BlockState;
      if (parent) {
        block = parent.block;
      } else {
        block = { group: {}, paragraphs: [] };
        blocks.push(block);
      }
      const paragraph: ParagraphState = { group: {}, block, box: { ...line.box }, baselineY: line.baselineY, lines: [line] };
      block.paragraphs.push(paragraph);
      paragraphs.push(paragraph);
    }
  });

  const result: OcrLineBlock[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) result.push(lineBlockOf(line, block.group, paragraph.group));
    }
  }
  for (const run of standalone) {
    const line = lineFromUnits(unitsOf(run), 0);
    result.push(lineBlockOf(line, {}, {}));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

interface PdfJsPage {
  view: number[];
  getViewport(options: { scale: number }): Viewport;
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, FontStyle> }>;
  getOperatorList(): Promise<OperatorList>;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}

interface PdfJs {
  OPS: Record<string, number>;
  getDocument(options: Record<string, unknown>): PdfJsLoadingTask;
}

let warnedNoGlyphs = false;

/** Geometry of one page from its text content (already read) and, when affordable, its operator list. */
async function readPage(
  pdfjs: PdfJs,
  page: PdfJsPage,
  content: { items: unknown[]; styles: Record<string, FontStyle> },
  pageNumber: number
): Promise<OcrResult> {
  const viewport = page.getViewport({ scale: 1 });
  if (content.items.length > PDF_TEXT_MAX_ITEMS_PER_PAGE) {
    throw new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
  }
  let characters = 0;
  for (const item of content.items) {
    if (isTextItem(item)) characters += item.str.length;
    if (characters > PDF_TEXT_MAX_CHARS_PER_PAGE) {
      throw new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_CHARS_PER_PAGE} characters of text.`);
    }
  }
  const wantAdvances = content.items.length <= PDF_TEXT_OPERATOR_LIST_MAX_ITEMS;
  const glyphs = wantAdvances ? collectGlyphs(await page.getOperatorList(), pdfjs.OPS) : [];
  const hasText = content.items.some((item) => isTextItem(item) && item.str.trim() !== '');
  if (wantAdvances && hasText && glyphs.length === 0 && !warnedNoGlyphs) {
    warnedNoGlyphs = true;
    console.warn('[pdf-text] pdfjs returned no glyph advances for a page with text; word boxes use equal shares per character');
  }
  const cursor: Cursor = { glyphs, next: 0, failures: 0, steps: 0 };
  const budget: WordBudget = { left: PDF_TEXT_MAX_WORDS_PER_PAGE, pageNumber };

  const runs: ItemRun[] = [];
  for (const candidate of content.items) {
    if (!isTextItem(candidate) || candidate.str.length === 0) continue;
    if (candidate.str.length > PDF_TEXT_MAX_ITEM_CHARS) {
      throw new PdfTextGeometryError(`PDF page ${pageNumber} has a text item longer than ${PDF_TEXT_MAX_ITEM_CHARS} characters.`);
    }
    const style = content.styles[candidate.fontName];
    const vertical = style?.vertical === true || candidate.dir === 'ttb';
    // Every item consumes its glyphs, even when it is only white space, so the stream stays in step.
    const placement = placeItem(candidate, cursor, vertical, pageNumber);
    if (candidate.str.trim() === '') continue;
    const run = splitItem(candidate, style, viewport, placement, vertical, budget);
    if (run) runs.push(run);
  }
  if (runs.length === 0 && hasText) {
    throw new PdfTextGeometryError(`PDF page ${pageNumber} has text but no usable word geometry.`);
  }

  const lineBlocks = layoutItemRuns(runs);
  const lines = lineBlocks.map((block) => block.text);
  let wordCount = 0;
  for (const block of lineBlocks) wordCount += block.words.length;
  return {
    text: lines.join('\n'),
    // The page's own text layer is exact; word confidence is left unknown.
    confidence: 1,
    wordCount,
    lines,
    lineBlocks,
    imageWidth: viewport.width,
    imageHeight: viewport.height,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function standardFontDataUrl(): string | undefined {
  try {
    const manifest = createRequire(path.join(process.cwd(), 'package.json')).resolve('pdfjs-dist/package.json');
    return `${path.join(path.dirname(manifest), 'standard_fonts')}${path.sep}`;
  } catch {
    return undefined;
  }
}

/**
 * Reads a PDF in this thread: per-page text-layer density (when `densityThreshold` is set) and word
 * geometry for the requested pages, reading each page's text content once.
 * @throws PdfTextGeometryError when the document cannot be read, a page does not exist, or a page
 * exceeds the item, word or length limits.
 */
export async function analyzePdfPagesInProcess(pdfBuffer: Buffer | Uint8Array, job: PdfTextJob): Promise<PdfTextJobResult> {
  const result: PdfTextJobResult = { analyses: [], geometry: new Map() };
  const explicit = Array.isArray(job.geometry) ? new Set<number>(job.geometry) : null;
  if (job.densityThreshold === undefined && explicit?.size === 0) return result;
  if (job.densityThreshold === undefined && job.geometry === 'none') return result;
  let task: PdfJsLoadingTask | undefined;
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
    task = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      standardFontDataUrl: standardFontDataUrl(),
      verbosity: 0,
    });
    const doc = await task.promise;
    for (const pageNumber of explicit ?? []) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
        throw new PdfTextGeometryError(`PDF page ${pageNumber} does not exist; the document has ${doc.numPages} pages.`);
      }
    }
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const wanted = explicit?.has(pageNumber) === true;
      if (job.densityThreshold === undefined && !wanted && job.geometry !== 'text-pages') continue;
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const strings = content.items.map((item) => (item as { str?: string }).str || '');
      const pageText = strings.join(' ').trim();
      if (job.densityThreshold !== undefined) {
        const view = page.view || [0, 0, 612, 792];
        const charCount = pageText.replace(/\s+/g, '').length;
        const analysis: PdfPageAnalysis = {
          pageNumber,
          width: Math.abs(view[2] - view[0]),
          height: Math.abs(view[3] - view[1]),
          charCount,
          wordCount: pageText.split(/\s+/).filter(Boolean).length,
          hasTextLayer: charCount >= job.densityThreshold,
          text: pageText,
        };
        result.analyses.push(analysis);
      }
      if (wanted || (job.geometry === 'text-pages' && pageText !== '')) {
        result.geometry.set(pageNumber, await readPage(pdfjs, page, content, pageNumber));
      }
    }
    return result;
  } catch (err) {
    if (err instanceof PdfTextGeometryError) throw err;
    throw new PdfTextGeometryError(`PDF text geometry could not be read: ${messageOf(err)}`);
  } finally {
    await task?.destroy().catch(() => undefined);
  }
}

/** Runs a job on a worker thread with a deadline, or in this thread where no worker entry exists. */
export async function runPdfTextJob(pdfBuffer: Buffer, job: PdfTextJob): Promise<PdfTextJobResult> {
  return (await runPdfTextJobInThread(pdfBuffer, job)) ?? analyzePdfPagesInProcess(pdfBuffer, job);
}

/** Word geometry for the requested pages, as one OcrResult per page; a page without text yields an empty result. */
export async function extractPdfTextLayerPages(pdfBuffer: Buffer, pageNumbers: ReadonlySet<number>): Promise<Map<number, OcrResult>> {
  if (pageNumbers.size === 0) return new Map();
  return (await runPdfTextJob(pdfBuffer, { geometry: [...pageNumbers].sort((p, q) => p - q) })).geometry;
}

/** Per-page density analyses plus word geometry for every page that has text, in one pass over the document. */
export function analyzePdfPagesWithGeometry(pdfBuffer: Buffer, densityThreshold: number): Promise<PdfTextJobResult> {
  return runPdfTextJob(pdfBuffer, { densityThreshold, geometry: 'text-pages' });
}
