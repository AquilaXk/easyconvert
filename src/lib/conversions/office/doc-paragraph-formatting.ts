import type { CheckedReader } from './cfb-streams';
import { FKP_FC_BYTES, FKP_RUN_COUNT_OFFSET, fkpPageAt, readFkpPageNumbers, refuse, type TableRange } from './doc-properties';

/**
 * Paragraph styles of a Word 97-2003 binary document ([MS-DOC] 2.9.? PlcBtePapx and PapxFkp), read for one purpose: the
 * style (istd) of the paragraph a character belongs to, which names the font the paragraph takes when its runs set none.
 * PapxFkp pages hold one entry per paragraph: its file offsets, a 13-byte BxPap whose first byte locates its
 * PapxInFkp, and the PapxInFkp (GrpprlAndIstd: the istd, then the paragraph properties, which are not read).
 */

/** Most paragraphs one PapxFkp page holds: 17 bytes of offsets and BxPap per paragraph in the 511 bytes before the count. */
export const DOC_MAX_PARAGRAPHS_PER_PAGE = 29;
/** Most styled paragraphs one document may carry, whatever its text length claims. */
export const DOC_MAX_PARAGRAPH_RUNS = 1_048_576;

const BX_PAP_BYTES = 13;
const PAPX_OFFSET_UNIT = 2;
const ISTD_BYTES = 2;

interface ParagraphRun {
  fcStart: number;
  fcEnd: number;
  istd: number;
}

/** The size and start of the GrpprlAndIstd of a PapxInFkp: cb non-zero gives 2 * cb - 1 bytes, zero a second byte of half the size. */
function papxExtent(page: Buffer, papxAt: number): { start: number; size: number } {
  const cb = page[papxAt];
  if (cb !== 0) return { start: papxAt + 1, size: cb * 2 - 1 };
  return { start: papxAt + 2, size: page[papxAt + 1] * 2 };
}

/** Reads the paragraphs of one PapxFkp page whose style is not Normal into `runs`; returns the file offset where the page ended. */
function readPapxPage(word: Buffer, pageNumber: number, previousEnd: number, runs: ParagraphRun[], maxRuns: number): number {
  const page = fkpPageAt(word, pageNumber);
  const count = page[FKP_RUN_COUNT_OFFSET];
  if (count < 1 || count > DOC_MAX_PARAGRAPHS_PER_PAGE) {
    refuse(`the FKP page ${pageNumber} declares ${count} paragraphs; a page holds 1 to ${DOC_MAX_PARAGRAPHS_PER_PAGE}.`);
  }
  const bxStart = (count + 1) * FKP_FC_BYTES;
  const offsetsEnd = bxStart + count * BX_PAP_BYTES;
  let end = previousEnd;
  for (let i = 0; i < count; i++) {
    const fcStart = page.readUInt32LE(i * FKP_FC_BYTES);
    const fcEnd = page.readUInt32LE((i + 1) * FKP_FC_BYTES);
    if (fcStart < end || fcEnd < fcStart) refuse(`the file offsets of the FKP page ${pageNumber} are not in ascending order.`);
    end = fcEnd;
    const papxAt = page[bxStart + i * BX_PAP_BYTES] * PAPX_OFFSET_UNIT;
    if (papxAt === 0) continue; // no paragraph properties: the paragraph is in the Normal style
    if (papxAt < offsetsEnd || papxAt + 1 >= FKP_RUN_COUNT_OFFSET) {
      refuse(`the paragraph properties at offset ${papxAt} of the FKP page ${pageNumber} lie outside the space after its offset arrays.`);
    }
    const { start, size } = papxExtent(page, papxAt);
    if (size < ISTD_BYTES || start + size > FKP_RUN_COUNT_OFFSET) {
      refuse(`the paragraph properties at offset ${papxAt} of the FKP page ${pageNumber} lie outside the space after its offset arrays.`);
    }
    const istd = page.readUInt16LE(start);
    if (fcEnd === fcStart || istd === 0) continue;
    if (runs.length >= maxRuns) refuse(`the document has more styled paragraphs than its text can hold (limit ${maxRuns}).`);
    runs.push({ fcStart, fcEnd, istd });
  }
  return end;
}

/** The styles of the paragraphs of a document, by the file offset a character is stored at. */
export class ParagraphRuns {
  private constructor(private readonly runs: readonly ParagraphRun[]) {}

  /** Reads the PlcBtePapx and its PapxFkp pages. A document without one has only Normal paragraphs. */
  static read(word: Buffer, table: CheckedReader, range: TableRange, textChars: number): ParagraphRuns {
    const pageNumbers = readFkpPageNumbers(table, range, 'paragraph');
    // A paragraph covers at least one character and file offsets ascend strictly, so paragraphs cannot outnumber characters plus pages.
    const maxRuns = Math.min(textChars + pageNumbers.length, DOC_MAX_PARAGRAPH_RUNS);
    const runs: ParagraphRun[] = [];
    let end = 0;
    for (const pageNumber of pageNumbers) end = readPapxPage(word, pageNumber, end, runs, maxRuns);
    return new ParagraphRuns(runs);
  }

  /** The istd of the paragraph that holds file offset `fc`; undefined for a Normal paragraph or text outside any entry. */
  istdAt(fc: number): number | undefined {
    let low = 0;
    let high = this.runs.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const run = this.runs[middle];
      if (fc < run.fcStart) high = middle - 1;
      else if (fc >= run.fcEnd) low = middle + 1;
      else return run.istd;
    }
    return undefined;
  }
}
