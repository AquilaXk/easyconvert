/**
 * The two-byte codes a /ToUnicode CMap (ISO 32000-1 section 9.10.3) gives text, read as pdf.js reads it.
 *
 * pdf.js reads the CMap token by token (`parseCMap`, pdf.js 6.3.289 `src/core/cmap.js`, `pdf.worker.mjs` lines 18465 to
 * 18520): `beginbfchar`, `beginbfrange`, `begincidchar` and `begincidrange` open blocks of entries, an entry that does not
 * parse is skipped with a warning and the scan goes on, and a range wider than `MAX_MAP_RANGE` (2^24 - 1, line 18143) throws
 * and so maps nothing, and `endcmap` ends the scan (line 18483). A font whose map ends up with no code is read as a font without a map (`buildToUnicode`, line 42874:
 * `hasIncludedToUnicodeMap = toUnicode.length > 0`); Poppler does the same, since `CharCodeToUnicode::parseCMap1` reports
 * failure when it mapped nothing (`poppler/CharCodeToUnicode.cc` 26.09, lines 167 to 175 and 199 to 340, GPL, followed for
 * its behaviour only). A code whose destination is empty counts as listed but has no text: pdf.js writes the code itself for
 * it (`toUnicode.get(charcode) || charcode`, an empty string being false).
 *
 * One pass over the text, which the caller has bounded by the inflate budget. A range is recorded as two marks in a table of
 * the 65,536 codes, so the work is the number of tokens plus 65,536 however wide the ranges are.
 */

/** pdf.js `MAX_MAP_RANGE`: the widest range of codes one entry may map. */
const MAX_MAP_RANGE = 2 ** 24 - 1;
/** The codes of a two-byte code space, which Identity-H selects. */
const CODE_SPACE = 0x10000;
/** A hex string, `[`, `]`, a comment, a literal string (to the end of the text when unterminated, as the lexer reads it, so the scan stays linear), or a word (name, number or operator). */
const TOKEN = /<([0-9A-Fa-f\s]*)>|\[|\]|%[^\r\n]*|\([^)]*\)?|[^\s<>[\]()%]+/g;
const USECMAP = 'usecmap';
const END_CMAP = 'endcmap';
const BLOCK_END = /^end/;
const ARRAY_OPEN = '[';
const ARRAY_CLOSE = ']';

/** What a block of entries holds, as the operands of one entry: hex codes, an integer CID, or the destination of a range (a string, or an array of strings). */
type Operand = 'hex' | 'int' | 'rangeTarget';

const ENTRIES: ReadonlyMap<string, readonly Operand[]> = new Map([
  ['beginbfchar', ['hex', 'hex']],
  ['beginbfrange', ['hex', 'hex', 'rangeTarget']],
  ['begincidchar', ['hex', 'int']],
  ['begincidrange', ['hex', 'hex', 'int']],
]);

interface Token {
  text: string;
  /** The digits when the token is a hex string. */
  hex: string | null;
}

export interface ToUnicodeCoverage {
  /** Whether pdf.js ends up with at least one entry; a map with none is read as no map. */
  listsCodes: boolean;
  /** Whether the code has text in the map. */
  covers(code: number): boolean;
}

/** The low 32 bits of the code a hex string spells, as pdf.js reads it (`strToInt`: `(n << 8) | byte`, then `>>> 0`). */
function codeOf(digits: string): number {
  const compact = digits.replace(/\s/g, '');
  const even = compact.length % 2 === 0 ? compact : `${compact}0`;
  return Number.parseInt(even.slice(-8) || '0', 16);
}

function hasText(token: Token): boolean {
  return token.hex !== null && token.hex.replace(/\s/g, '').length > 0;
}

function fits(operand: Operand, { text, hex }: Token): boolean {
  if (operand === 'int') return /^\d+$/.test(text);
  return hex !== null || (operand === 'rangeTarget' && text === ARRAY_OPEN);
}

/** A table of marks that a range sets with two writes, and `covers` reads back as the number of ranges over a code. */
class Marks {
  private readonly counts = new Int32Array(CODE_SPACE + 1);
  private sums: Int32Array | null = null;
  listsCodes = false;

  /** Records an entry for the codes `low` to `high`; without `text` it is listed and has no text. */
  add(low: number, high: number, text: boolean): void {
    this.listsCodes = true;
    if (!text || low >= CODE_SPACE) return;
    this.counts[low]++;
    this.counts[Math.min(high, CODE_SPACE - 1) + 1]--;
  }

  covers(code: number): boolean {
    if (this.sums === null) {
      this.sums = new Int32Array(CODE_SPACE);
      let running = 0;
      for (let at = 0; at < CODE_SPACE; at++) {
        running += this.counts[at];
        this.sums[at] = running;
      }
    }
    return code < CODE_SPACE && this.sums[code] > 0;
  }
}

/** Whether the operands are an entry pdf.js maps: well formed and, for a range, rising and no wider than `MAX_MAP_RANGE`. */
function isRange(low: number, high: number): boolean {
  return low <= high && high - low <= MAX_MAP_RANGE;
}

/** Whether the entry's destination is text: a CID is always a code point, a string must not be empty. */
function hasDestination(block: string, entry: readonly Token[]): boolean {
  return block.startsWith('begincid') || hasText(entry[entry.length - 1]);
}

/** Records the entry the operands make, if they make one. */
function record(block: string, operands: readonly Operand[], entry: readonly Token[], marks: Marks): void {
  if (!operands.every((operand, index) => fits(operand, entry[index]))) return;
  const low = codeOf(entry[0].hex as string);
  const high = operands.length === 3 ? codeOf(entry[1].hex as string) : low;
  if (operands.length === 3 && !isRange(low, high)) return;
  marks.add(low, high, hasDestination(block, entry));
}

/**
 * The coverage of the CMap, or `inherits` when it names another CMap with `usecmap`: pdf.js adds that CMap's codes to its
 * own (`extendCMap`, line 18521), so the listed codes are then not the whole map.
 */
export function readToUnicodeCoverage(cmap: string): ToUnicodeCoverage | 'inherits' {
  const marks = new Marks();
  let block: string | null = null;
  let entry: Token[] = [];
  let array: { low: number; high: number; filled: number } | null = null;
  for (const match of cmap.matchAll(TOKEN)) {
    const token: Token = { text: match[0], hex: match[1] ?? null };
    if (token.text === USECMAP) return 'inherits';
    if (token.text === END_CMAP) break;
    if (array !== null) {
      if (token.text === ARRAY_CLOSE || BLOCK_END.test(token.text)) {
        if (array.filled > 0) marks.add(array.low, Math.min(array.high, array.low + array.filled - 1), true);
        array = null;
        if (BLOCK_END.test(token.text)) block = null;
      } else if (hasText(token)) {
        array.filled++;
      }
    } else if (BLOCK_END.test(token.text)) {
      block = null;
    } else if (ENTRIES.has(token.text)) {
      block = token.text;
      entry = [];
    } else if (block !== null && !token.text.startsWith('%')) {
      entry.push(token);
      const operands = ENTRIES.get(block) as readonly Operand[];
      if (entry.length < operands.length) continue;
      if (token.text === ARRAY_OPEN && operands.every((operand, index) => fits(operand, entry[index]))) {
        const [low, high] = [codeOf(entry[0].hex as string), codeOf(entry[1].hex as string)];
        if (isRange(low, high)) array = { low, high, filled: 0 };
      } else {
        record(block, operands, entry, marks);
      }
      entry = [];
    }
  }
  return { listsCodes: marks.listsCodes, covers: (code) => marks.covers(code) };
}
