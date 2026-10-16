/**
 * The text of a MOBI or AZW3 book, read from the layout the MobileRead wiki documents for the Palm database, the PalmDOC
 * header and the MOBI header, without any code of the converter. Only the uncompressed form (PalmDOC compression 1) is read:
 * the text records are joined and cut to the text length that record 0 states, and anything that does not add up (a record
 * list that ends early, text records that are shorter than the length) is an error instead of a guess.
 */

const PALM_RECORD_COUNT_OFFSET = 76;
const PALM_RECORD_LIST_OFFSET = 78;
const PALM_RECORD_ENTRY_BYTES = 8;
const PALMDOC_COMPRESSION_NONE = 1;
const MOBI_MAGIC_OFFSET = 16;
const MOBI_TEXT_ENCODING_OFFSET = 28;
const MOBI_ENCODING_UTF8 = 65001;

function recordOffsets(book: Buffer): number[] {
  const count = book.readUInt16BE(PALM_RECORD_COUNT_OFFSET);
  return Array.from({ length: count }, (_, index) => book.readUInt32BE(PALM_RECORD_LIST_OFFSET + index * PALM_RECORD_ENTRY_BYTES));
}

export function mobiText(book: Buffer): string {
  const offsets = recordOffsets(book);
  const header = book.subarray(offsets[0], offsets[1]);
  if (header.readUInt16BE(0) !== PALMDOC_COMPRESSION_NONE) throw new Error(`The PalmDOC compression ${header.readUInt16BE(0)} is not read here.`);
  if (header.toString('latin1', MOBI_MAGIC_OFFSET, MOBI_MAGIC_OFFSET + 4) !== 'MOBI') throw new Error('The first record has no MOBI header.');
  if (header.readUInt32BE(MOBI_TEXT_ENCODING_OFFSET) !== MOBI_ENCODING_UTF8) throw new Error('The book does not declare UTF-8 text.');
  const textLength = header.readUInt32BE(4);
  const textRecords = header.readUInt16BE(8);
  const text = Buffer.concat(offsets.slice(1, 1 + textRecords).map((start, index) => book.subarray(start, offsets[index + 2])));
  if (text.length < textLength) throw new Error(`The text records hold ${text.length} of the ${textLength} bytes the header states.`);
  return text.subarray(0, textLength).toString('utf-8');
}
