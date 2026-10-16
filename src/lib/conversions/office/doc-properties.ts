import type { CheckedReader } from './cfb-streams';
import { LegacyOfficeFormatError } from './legacy-office-errors';

/**
 * Shared parts of the formatting readers of a Word 97-2003 binary document: the character properties they care about,
 * read from a grpprl (a list of sprms, [MS-DOC] 2.6.1, the property modifiers of a Chpx or of the character part of a
 * style), and the checks every structure of the table stream goes through. A sprm is an opcode and an operand whose size
 * follows from the opcode; every property but the ones named below is stepped over.
 */

const LABEL = 'Word document';
const HEX_RADIX = 16;
const UTF16_UNIT_BYTES = 2;

// Sprm structure ([MS-DOC] 2.6.1): the operand size follows from spra, the top three bits of the opcode.
const SPRM_BYTES = 2;
const SPRA_SHIFT = 13;
const SPRA_ONE_BYTE_A = 0;
const SPRA_ONE_BYTE_B = 1;
const SPRA_TWO_BYTES_A = 2;
const SPRA_FOUR_BYTES = 3;
const SPRA_TWO_BYTES_B = 4;
const SPRA_TWO_BYTES_C = 5;
const SPRA_VARIABLE = 6;
const SPRA_THREE_BYTES = 7;
const SPRM_C_RG_FTC0 = 0x4a4f;
const SPRM_C_RG_FTC1 = 0x4a50;
const SPRM_C_RG_FTC2 = 0x4a51;
const SPRM_C_SYMBOL = 0x6a09;
const SPRM_C_ISTD = 0x4a30;


/** Font indexes (into SttbfFfn) of one run or style: undefined means it does not set that font. */
export interface FontSlots {
  ascii?: number;
  farEast?: number;
  other?: number;
}

/** What a grpprl says about the font of a character: its font indexes, its character style and a Symbol field. */
export interface CharacterProperties {
  slots: FontSlots;
  /** The character style of the run (sprmCIstd). */
  istd?: number;
  /** The font index and character code of a Symbol field (sprmCSymbol). */
  symbol?: { ftc: number; xchar: number };
}

/** Where a structure lies in the table stream: the (fc, lcb) pair of the FIB. */
export interface TableRange {
  fc: number;
  lcb: number;
}

/** Most FKP pages (512 bytes each) one PlcBteChpx or PlcBtePapx may address: 16 MiB of formatting. */
export const DOC_MAX_FKP_PAGES = 32_768;

export function assertInTable(table: CheckedReader, range: TableRange, what: string): void {
  if (range.fc + range.lcb > table.length) refuse(`the ${what} lies outside the table stream.`);
}

/** Bytes of an FKP page, and of the file offset and page number entries of a PlcBteChpx or PlcBtePapx. */
export const FKP_BYTES = 512;
/** The last byte of an FKP page holds its run count. */
export const FKP_RUN_COUNT_OFFSET = FKP_BYTES - 1;
export const FKP_FC_BYTES = 4;
const PN_BYTES = 4;
const PN_MASK = 0x3fffff;

/**
 * The FKP page numbers a PlcBteChpx or PlcBtePapx addresses ([MS-DOC] 2.8.? Plc: n + 1 file offsets then n PnFkpChpx or
 * PnFkpPapx), in order. The size, the page count and repeated pages are checked: a page addressed twice would make a few
 * kilobytes of input stand for any amount of runs.
 */
export function readFkpPageNumbers(table: CheckedReader, range: TableRange, what: string): number[] {
  if (range.lcb === 0) return [];
  assertInTable(table, range, `${what} formatting table`);
  const entryBytes = FKP_FC_BYTES + PN_BYTES;
  if (range.lcb < FKP_FC_BYTES || (range.lcb - FKP_FC_BYTES) % entryBytes !== 0) refuse(`the ${what} formatting table size ${range.lcb} is not valid.`);
  const pages = (range.lcb - FKP_FC_BYTES) / entryBytes;
  if (pages > DOC_MAX_FKP_PAGES) refuse(`the ${what} formatting table addresses ${pages} pages, more than the ${DOC_MAX_FKP_PAGES} limit.`);
  const plc = table.slice(range.fc, range.lcb);
  const pnBase = (pages + 1) * FKP_FC_BYTES;
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (let i = 0; i < pages; i++) {
    const pageNumber = plc.readUInt32LE(pnBase + i * PN_BYTES) & PN_MASK;
    if (seen.has(pageNumber)) refuse(`the FKP page ${pageNumber} is addressed more than once.`);
    seen.add(pageNumber);
    numbers.push(pageNumber);
  }
  return numbers;
}

/** The 512 bytes of FKP page `pageNumber`; a page outside the WordDocument stream is refused. */
export function fkpPageAt(word: Buffer, pageNumber: number): Buffer {
  const pageStart = pageNumber * FKP_BYTES;
  if (pageStart + FKP_BYTES > word.length) refuse(`the FKP page ${pageNumber} lies outside the WordDocument stream.`);
  return word.subarray(pageStart, pageStart + FKP_BYTES);
}

export function refuse(message: string): never {
  throw new LegacyOfficeFormatError(`${LABEL}: ${message}`);
}

export function hex(value: number): string {
  return value.toString(HEX_RADIX);
}

/** Size of the operand of a sprm in a Chpx; the variable-size operand carries its own length in its first byte. */
function operandBytes(grpprl: Buffer, at: number, opcode: number): number {
  switch (opcode >> SPRA_SHIFT) {
    case SPRA_ONE_BYTE_A:
    case SPRA_ONE_BYTE_B:
      return 1;
    case SPRA_TWO_BYTES_A:
    case SPRA_TWO_BYTES_B:
    case SPRA_TWO_BYTES_C:
      return 2;
    case SPRA_FOUR_BYTES:
      return 4;
    case SPRA_THREE_BYTES:
      return 3;
    case SPRA_VARIABLE:
      if (at + SPRM_BYTES >= grpprl.length) refuse(`the property modifier 0x${hex(opcode)} has no operand length before the end of its Chpx.`);
      return 1 + grpprl[at + SPRM_BYTES];
    default:
      return refuse(`the property modifier 0x${hex(opcode)} has an unknown operand size.`);
  }
}

/** Reads the font, character style and Symbol sprms of one grpprl; every other property is stepped over. */
export function readCharacterProperties(grpprl: Buffer): CharacterProperties {
  const slots: FontSlots = {};
  let symbol: CharacterProperties['symbol'];
  let istd: number | undefined;
  let at = 0;
  while (at < grpprl.length) {
    if (at + SPRM_BYTES > grpprl.length) refuse('a property modifier is cut off by the end of its Chpx.');
    const opcode = grpprl.readUInt16LE(at);
    const size = operandBytes(grpprl, at, opcode);
    if (at + SPRM_BYTES + size > grpprl.length) refuse(`the property modifier 0x${hex(opcode)} runs past the end of its Chpx.`);
    const operand = at + SPRM_BYTES;
    if (opcode === SPRM_C_RG_FTC0) slots.ascii = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_RG_FTC1) slots.farEast = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_RG_FTC2) slots.other = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_ISTD) istd = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_SYMBOL) symbol = { ftc: grpprl.readUInt16LE(operand), xchar: grpprl.readUInt16LE(operand + UTF16_UNIT_BYTES) };
    at += SPRM_BYTES + size;
  }
  return { slots, istd, symbol };
}

/** Whether a grpprl sets a font, a character style or a Symbol field, so it matters to the font of a character. */
export function setsFontOrStyle({ slots, istd, symbol }: CharacterProperties): boolean {
  return symbol !== undefined || istd !== undefined || slots.ascii !== undefined || slots.farEast !== undefined || slots.other !== undefined;
}

