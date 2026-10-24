import { UnprocessableCadInputError } from '../types';

/**
 * What the worker checks in an IGES file before the Open CASCADE reader sees it, so that two damaged-file cases end in a typed
 * answer instead of a wrong model or a crash.
 *
 * The file is read the way the kernel's own reader reads it (OCCT src/IGESFile, igesread.c and liriges.c): fixed 80-column
 * records, the section letter in column 73, the Global section as the first 72 columns of its records joined into one parameter list.
 *
 * Terminate line (IGES 5.3, 2.2.6): one record, `S`, `G`, `D` and `P` each followed by a seven-digit count of the records of that
 * section. The kernel only warns about a missing or wrong line (igesread.c:125-128), reads whatever records are there, and faults on a
 * file cut off inside a section (a segmentation fault in the reader, seen with a copy of testfile.igs cut after 75 percent); here a
 * file whose counts differ from the records it holds is refused with the count named.
 *
 * Hollerith count (IGES 5.3, 2.2.2 and 2.2.3): `nHtext`, n characters of text, then the parameter delimiter. The kernel honours n
 * literally (analiges.c:220-243) and neither checks the delimiter nor recovers: a count that is too large swallows the delimiter and
 * the blanks to the end of the record, the next parameter is dropped (analiges.c:259, `reste = -1`), and every later parameter of
 * the Global section moves one place (testfile.igs counts 38 for the 32 characters of its file name, so the unit flag is read as
 * the scale and the model is 25.4 times too large). No reader this was compared with recovers (the other open reader, libIGES
 * iges_io.cpp:231-330, refuses such a record). The one count that is repaired is the one the file itself shows to be too large: the text
 * ends in a delimiter that is followed by blanks only up to the declared end. Any other count that no delimiter follows is refused.
 */

const RECORD_LENGTH = 80;
const SECTION_COLUMN = 72;
const GLOBAL_COLUMNS = 72;
const COUNT_FIELD_LENGTH = 8;
/** Digits of a Hollerith count that are read; a longer count is larger than any Global section. */
const MAX_COUNT_DIGITS = 9;
const SEQUENCE_FIELD = /^ *\d+ *$/;
/** A record and the line end after it (a lone carriage return ends a record too, as in liriges.c:53-57). */
const LINE = /([^\r\n]*)(\r\n|\r|\n|$)/g;
/** A Hollerith count and its H, matched where `lastIndex` points. */
const HOLLERITH = /(\d+)H/y;
const SECTIONS = ['S', 'G', 'D', 'P'] as const;
type CountedSection = (typeof SECTIONS)[number];
const SECTION_NAMES: Readonly<Record<CountedSection, string>> = { S: 'Start', G: 'Global', D: 'Directory Entry', P: 'Parameter Data' };
const DEFAULT_PARAMETER_DELIMITER = ',';
const DEFAULT_RECORD_DELIMITER = ';';

interface IgesRecord {
  section: string;
  /** Byte offset of the record in the file. */
  offset: number;
  text: string;
}

/** The records of the file: lines, or 80-byte chunks when the file has no line ends (the fixed-length form IGES allows). */
function recordsOf(text: string): IgesRecord[] {
  const records: IgesRecord[] = [];
  const hasLineEnds = /[\r\n]/.test(text.slice(0, 2 * RECORD_LENGTH));
  const push = (line: string, offset: number): void => {
    if (line.length <= SECTION_COLUMN + 1 || !SEQUENCE_FIELD.test(line.slice(SECTION_COLUMN + 1))) return;
    records.push({ section: line[SECTION_COLUMN], offset, text: line });
  };
  if (!hasLineEnds) {
    for (let offset = 0; offset + RECORD_LENGTH <= text.length; offset += RECORD_LENGTH) push(text.slice(offset, offset + RECORD_LENGTH), offset);
    return records;
  }
  let offset = 0;
  for (const [, line, lineEnd] of text.matchAll(LINE)) {
    push(line, offset);
    offset += line.length + lineEnd.length;
  }
  return records;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}`;
}

/** Checks the Terminate line against the records the file holds; throws when it is missing or any of its four counts is wrong. */
function checkTerminateLine(records: readonly IgesRecord[]): void {
  const held: Record<CountedSection, number> = { S: 0, G: 0, D: 0, P: 0 };
  const terminates: IgesRecord[] = [];
  for (const record of records) {
    if (record.section === 'T') terminates.push(record);
    else if (record.section in held) held[record.section as CountedSection]++;
  }
  if (terminates.length !== 1) {
    const found = terminates.length === 0 ? 'no Terminate line' : `${terminates.length} Terminate lines`;
    throw new UnprocessableCadInputError(`The IGES file is cut off or damaged: it has ${found} where the format has one.`);
  }
  SECTIONS.forEach((section, index) => {
    const field = terminates[0].text.slice(index * COUNT_FIELD_LENGTH, (index + 1) * COUNT_FIELD_LENGTH);
    const declared = /^([SGDP]) *(\d+)$/.exec(field);
    if (declared === null || declared[1] !== section) {
      throw new UnprocessableCadInputError(`The IGES file is damaged: its Terminate line has no count of ${SECTION_NAMES[section]} records.`);
    }
    if (Number(declared[2]) !== held[section]) {
      throw new UnprocessableCadInputError(
        `The IGES file is cut off or damaged: its Terminate line counts ${plural(Number(declared[2]), `${SECTION_NAMES[section]} records`)}, but the file holds ${held[section].toLocaleString('en-US')}.`
      );
    }
  });
}

/** The delimiters of the Global section, chosen as the kernel's reader chooses them (igesread.c:107-108). */
function globalDelimiters(firstRecord: string): { parameter: string; record: string } {
  let parameter = DEFAULT_PARAMETER_DELIMITER;
  let record = DEFAULT_RECORD_DELIMITER;
  let start = 0;
  if (firstRecord[0] !== ',') {
    parameter = firstRecord[2] ?? DEFAULT_PARAMETER_DELIMITER;
    start = 3;
  }
  if (firstRecord[start + 1] !== parameter) record = firstRecord[start + 3] ?? DEFAULT_RECORD_DELIMITER;
  return { parameter, record };
}

/** Where a count whose text the file shows to be shorter ends: the last delimiter of the declared text that only blanks follow. */
function repairedLength(global: string, textStart: number, declaredEnd: number, delimiters: ReadonlySet<string>): number | null {
  let end = declaredEnd;
  while (end > textStart && global[end - 1] === ' ') end--;
  if (end - 1 <= textStart || !delimiters.has(global[end - 1])) return null;
  return end - 1 - textStart;
}

function nextNonBlank(text: string, from: number): number {
  let index = from;
  while (index < text.length && text[index] === ' ') index++;
  return index;
}

interface CountFix {
  /** Offset in the joined Global text of the first digit of the count. */
  digitsAt: number;
  digits: number;
  value: number;
}

/** Walks the parameters of the joined Global text and returns the Hollerith counts to rewrite; throws for a count no delimiter follows. */
function findCountFixes(global: string, delimiters: { parameter: string; record: string }): CountFix[] {
  const ends = new Set([delimiters.parameter, delimiters.record]);
  const fixes: CountFix[] = [];
  let position = 0;
  let parameter = 1;
  while (position < global.length) {
    const tokenStart = nextNonBlank(global, position);
    HOLLERITH.lastIndex = tokenStart;
    const hollerith = HOLLERITH.exec(global);
    if (hollerith === null) {
      let end = tokenStart;
      while (end < global.length && !ends.has(global[end])) end++;
      if (end >= global.length || global[end] === delimiters.record) return fixes;
      position = end + 1;
      parameter++;
      continue;
    }
    const count = hollerith[1].length > MAX_COUNT_DIGITS ? Infinity : Number(hollerith[1]);
    const textStart = tokenStart + hollerith[0].length;
    const declaredEnd = textStart + count;
    const refuse = (): never => {
      const named = hollerith[1].length > MAX_COUNT_DIGITS ? `more than ${'9'.repeat(MAX_COUNT_DIGITS)}` : String(count);
      throw new UnprocessableCadInputError(
        `The IGES Global section declares a text of ${named} characters in parameter ${parameter} that no delimiter follows: the count is wrong, and every later parameter (the length unit among them) would be read in the wrong place.`
      );
    };
    if (hollerith[1].length > MAX_COUNT_DIGITS || declaredEnd > global.length) return refuse();
    const after = nextNonBlank(global, declaredEnd);
    if (after >= global.length || ends.has(global[after])) {
      if (after >= global.length || global[after] === delimiters.record) return fixes;
      position = after + 1;
      parameter++;
      continue;
    }
    const length = repairedLength(global, textStart, declaredEnd, ends);
    if (length === null) return refuse();
    fixes.push({ digitsAt: tokenStart, digits: hollerith[1].length, value: length });
    position = declaredEnd;
    parameter++;
  }
  return fixes;
}

/** The Global text rewritten in the bytes of the file: each count in the width it had, padded with zeros, so no record changes length. */
function applyFixes(input: Buffer, globalRecords: readonly IgesRecord[], fixes: readonly CountFix[]): Buffer {
  const fixed = Buffer.from(input);
  for (const fix of fixes) {
    const replacement = String(fix.value).padStart(fix.digits, '0');
    for (let digit = 0; digit < fix.digits; digit++) {
      const at = fix.digitsAt + digit;
      fixed[globalRecords[Math.floor(at / GLOBAL_COLUMNS)].offset + (at % GLOBAL_COLUMNS)] = replacement.charCodeAt(digit);
    }
  }
  return fixed;
}

/**
 * The file as the kernel should read it: refused when the Terminate line disagrees with the records, with a Hollerith count of
 * the Global section that a delimiter shows to be too large rewritten. A file with no IGES record is returned as it is, for the
 * kernel to refuse in its own words.
 */
export function prepareIgesForKernel(input: Buffer): Buffer {
  const text = input.toString('latin1');
  const records = recordsOf(text);
  if (records.length === 0) return input;
  checkTerminateLine(records);
  const globalRecords = records.filter((record) => record.section === 'G');
  if (globalRecords.length === 0) return input;
  const global = globalRecords.map((record) => record.text.slice(0, GLOBAL_COLUMNS)).join('');
  const fixes = findCountFixes(global, globalDelimiters(globalRecords[0].text));
  return fixes.length === 0 ? input : applyFixes(input, globalRecords, fixes);
}
