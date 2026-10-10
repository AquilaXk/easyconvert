import bidiFactory from 'bidi-js';
import { SHAPE_MAX_CODEPOINTS, assertParagraphWithinLimit } from './limits';

/**
 * Splits one paragraph into runs that can be shaped as a unit: one bidi embedding level (UAX #9) and one script
 * (UAX #24) per run. Runs are in logical order; reordering them for display is done per line by visualOrder().
 */

/** Four-letter ISO 15924 script code handed to the shaping engine. */
export type ScriptTag = string;

export interface ItemizedRun {
  /** UTF-16 offsets into the paragraph text. */
  readonly start: number;
  readonly end: number;
  /** UAX #9 embedding level; odd levels run right to left. */
  readonly level: number;
  readonly script: ScriptTag;
}

export interface ItemizedParagraph {
  readonly runs: ItemizedRun[];
  /** Resolved paragraph level: 0 for left-to-right text, 1 for right-to-left. */
  readonly baseLevel: number;
}

/** Script of code points that take the script of their neighbours (punctuation, digits, spaces). */
export const COMMON_SCRIPT: ScriptTag = 'Zyyy';
const UNKNOWN_SCRIPT: ScriptTag = 'Zzzz';
const ASCII_LIMIT = 0x80;
const SUPPLEMENTARY_PLANE = 0x10000;
const FIRST_COMBINING_MARK = 0x300;
const ZERO_WIDTH_JOINER = 0x200d;
const ZERO_WIDTH_NON_JOINER = 0x200c;

/** Scripts with their own shaping rules or fonts, as [ISO 15924 code, Unicode Script property value]. */
const SCRIPT_TABLE: ReadonlyArray<readonly [ScriptTag, RegExp]> = [
  ['Latn', /\p{Script=Latin}/u],
  ['Arab', /\p{Script=Arabic}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Hang', /\p{Script=Hangul}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hira', /\p{Script=Hiragana}/u],
  ['Kana', /\p{Script=Katakana}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Grek', /\p{Script=Greek}/u],
  ['Beng', /\p{Script=Bengali}/u],
  ['Guru', /\p{Script=Gurmukhi}/u],
  ['Gujr', /\p{Script=Gujarati}/u],
  ['Orya', /\p{Script=Oriya}/u],
  ['Taml', /\p{Script=Tamil}/u],
  ['Telu', /\p{Script=Telugu}/u],
  ['Knda', /\p{Script=Kannada}/u],
  ['Mlym', /\p{Script=Malayalam}/u],
  ['Sinh', /\p{Script=Sinhala}/u],
  ['Laoo', /\p{Script=Lao}/u],
  ['Khmr', /\p{Script=Khmer}/u],
  ['Mymr', /\p{Script=Myanmar}/u],
  ['Tibt', /\p{Script=Tibetan}/u],
  ['Syrc', /\p{Script=Syriac}/u],
  ['Thaa', /\p{Script=Thaana}/u],
  ['Bopo', /\p{Script=Bopomofo}/u],
  ['Geor', /\p{Script=Georgian}/u],
  ['Armn', /\p{Script=Armenian}/u],
];
const INHERITED_SCRIPT = /\p{Script=Inherited}/u;
const COMMON_SCRIPT_PROPERTY = /\p{Script=Common}/u;
/** Marks that stay with the character before them when a run has to be cut. */
const CLUSTER_CONTINUATION = /\p{M}|[︀-️]|[\u{E0100}-\u{E01EF}]/u;
const WHITE_SPACE = /\s/u;

const scriptCache = new Map<number, ScriptTag>();
const bidi = bidiFactory();

/** The Unicode script of one code point; COMMON_SCRIPT for punctuation, digits, spaces and inherited marks. */
export function scriptOf(codePoint: number): ScriptTag {
  if (codePoint < ASCII_LIMIT) {
    const isLetter = (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a);
    return isLetter ? 'Latn' : COMMON_SCRIPT;
  }
  const cached = scriptCache.get(codePoint);
  if (cached !== undefined) return cached;
  const ch = String.fromCodePoint(codePoint);
  let found: ScriptTag = UNKNOWN_SCRIPT;
  if (INHERITED_SCRIPT.test(ch) || COMMON_SCRIPT_PROPERTY.test(ch)) {
    found = COMMON_SCRIPT;
  } else {
    for (const [tag, pattern] of SCRIPT_TABLE) {
      if (pattern.test(ch)) {
        found = tag;
        break;
      }
    }
  }
  scriptCache.set(codePoint, found);
  return found;
}

/** Whether the code point is an inherited-script mark (combining marks, joiners) that follows its base character. */
function isInheriting(codePoint: number): boolean {
  if (codePoint === ZERO_WIDTH_JOINER || codePoint === ZERO_WIDTH_NON_JOINER) return true;
  return codePoint >= FIRST_COMBINING_MARK && INHERITED_SCRIPT.test(String.fromCodePoint(codePoint));
}

/**
 * Script per UTF-16 offset: each Common or Inherited character takes the script of the character before it
 * (UAX #24 section 5.1), and leading Common characters take the first script that follows.
 */
function resolveScripts(text: string): ScriptTag[] {
  const scripts: ScriptTag[] = new Array<ScriptTag>(text.length);
  let previous: ScriptTag = COMMON_SCRIPT;
  let firstResolved = -1;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    const width = codePoint >= SUPPLEMENTARY_PLANE ? 2 : 1;
    let script = scriptOf(codePoint);
    if (script === COMMON_SCRIPT) {
      script = previous;
    } else if (isInheriting(codePoint)) {
      script = previous;
    }
    if (script !== COMMON_SCRIPT && firstResolved < 0) firstResolved = index;
    previous = script;
    for (let unit = 0; unit < width; unit++) scripts[index + unit] = script;
    index += width;
  }
  // A paragraph that starts with Common characters: they take the first real script of the paragraph.
  if (firstResolved > 0) {
    const lead = scripts[firstResolved];
    for (let index = 0; index < firstResolved; index++) scripts[index] = lead;
  }
  return scripts;
}

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

/** Number of code points in the text, counted without allocating an array. */
function countCodePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST && index + 1 < text.length) index++;
    count++;
  }
  return count;
}

/**
 * Offset at which a run that would pass SHAPE_MAX_CODEPOINTS is cut: just after the last white space inside the
 * limit, or else at the last character boundary that does not separate a mark from its base.
 */
function cutOffset(text: string, start: number, end: number): number {
  const limit = Math.min(end, start + SHAPE_MAX_CODEPOINTS);
  let lastSpace = -1;
  let lastBoundary = -1;
  for (let index = start; index < limit; ) {
    const codePoint = text.codePointAt(index) as number;
    const width = codePoint >= SUPPLEMENTARY_PLANE ? 2 : 1;
    const next = index + width;
    if (next > limit) break;
    if (WHITE_SPACE.test(String.fromCodePoint(codePoint))) lastSpace = next;
    const following = next < end ? (text.codePointAt(next) as number) : -1;
    const continues = following >= 0 && (following === ZERO_WIDTH_JOINER || following === ZERO_WIDTH_NON_JOINER || CLUSTER_CONTINUATION.test(String.fromCodePoint(following)));
    if (!continues) lastBoundary = next;
    index = next;
  }
  if (lastSpace > start) return lastSpace;
  return lastBoundary > start ? lastBoundary : limit;
}

function pushBounded(runs: ItemizedRun[], text: string, start: number, end: number, level: number, script: ScriptTag): void {
  let from = start;
  while (from < end) {
    const to = end - from <= SHAPE_MAX_CODEPOINTS ? end : cutOffset(text, from, end);
    runs.push({ start: from, end: to, level, script });
    from = to;
  }
}

/**
 * Itemizes one paragraph (no line feeds). Throws ShapingLimitError (413) for a paragraph past
 * SHAPE_MAX_PARAGRAPH_CODEPOINTS; no run is longer than SHAPE_MAX_CODEPOINTS code points.
 */
export function itemizeParagraph(text: string): ItemizedParagraph {
  assertParagraphWithinLimit(countCodePoints(text));
  if (text.length === 0) return { runs: [], baseLevel: 0 };
  const { levels, paragraphs } = bidi.getEmbeddingLevels(text);
  const scripts = resolveScripts(text);
  const runs: ItemizedRun[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index++) {
    const boundary = index === text.length || levels[index] !== levels[start] || scripts[index] !== scripts[start];
    if (boundary) {
      pushBounded(runs, text, start, index, levels[start], scripts[start]);
      start = index;
    }
  }
  return { runs, baseLevel: paragraphs[0]?.level ?? 0 };
}

/**
 * Display order of the pieces of one line (UAX #9 rule L2): from the highest level down to the lowest odd level,
 * every maximal sequence of pieces at that level or higher is reversed. Returns indexes into `levels`.
 */
export function visualOrder(levels: readonly number[]): number[] {
  const order = levels.map((_, index) => index);
  if (levels.length === 0) return order;
  let highest = 0;
  let lowestOdd = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    highest = Math.max(highest, level);
    if (level % 2 === 1) lowestOdd = Math.min(lowestOdd, level);
  }
  for (let level = highest; level >= lowestOdd; level--) {
    let index = 0;
    while (index < order.length) {
      if (levels[order[index]] < level) {
        index++;
        continue;
      }
      let end = index;
      while (end + 1 < order.length && levels[order[end + 1]] >= level) end++;
      for (let low = index, high = end; low < high; low++, high--) {
        const swap = order[low];
        order[low] = order[high];
        order[high] = swap;
      }
      index = end + 1;
    }
  }
  return order;
}
