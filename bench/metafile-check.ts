/**
 * Structural check of Windows metafiles against their specifications ([MS-EMF] 2.2.9 and 2.3.4.1 for EMR_EOF,
 * [MS-WMF] 2.2.2.6 and 2.3 for the placeable header, the header and the record stream). It is written for the benchmark
 * from the specifications and imports nothing from the conversion engines, so it is an independent reader: it lists
 * every rule the bytes break, and an empty list means a consumer that follows the specification can walk the file.
 */

const EMR_HEADER = 1;
const EMR_EOF = 14;
const EMF_SIGNATURE = 0x464d4520;
const EMF_HEADER_MIN_BYTES = 88;
const EMF_RECORD_MIN_BYTES = 8;
const EMF_SIGNATURE_OFFSET = 40;
const EMF_BYTES_OFFSET = 48;
const EMF_RECORDS_OFFSET = 52;
const EMF_FRAME_OFFSET = 24;

const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_BYTES = 22;
const WMF_PLACEABLE_CHECKSUM_OFFSET = 20;
const WMF_HEADER_BYTES = 18;
const WMF_HEADER_SIZE_WORDS = 9;
const WMF_VERSIONS: ReadonlySet<number> = new Set([0x0100, 0x0300]);
const WMF_TYPES: ReadonlySet<number> = new Set([1, 2]);
const WMF_RECORD_MIN_WORDS = 3;
const WMF_EOF_FUNCTION = 0x0000;
const WORD_BYTES = 2;

/** The rules an EMF file breaks; empty when it is a well-formed enhanced metafile. */
export function emfViolations(file: Buffer): string[] {
  const found: string[] = [];
  if (file.length < EMF_HEADER_MIN_BYTES) return [`shorter than the ${EMF_HEADER_MIN_BYTES} byte header`];
  if (file.readUInt32LE(0) !== EMR_HEADER) found.push('first record is not EMR_HEADER');
  if (file.readUInt32LE(EMF_SIGNATURE_OFFSET) !== EMF_SIGNATURE) found.push('header signature is not " EMF"');
  if (file.readUInt32LE(EMF_BYTES_OFFSET) !== file.length) found.push(`header says ${file.readUInt32LE(EMF_BYTES_OFFSET)} bytes, file has ${file.length}`);
  const frameWidth = file.readInt32LE(EMF_FRAME_OFFSET + 8) - file.readInt32LE(EMF_FRAME_OFFSET);
  const frameHeight = file.readInt32LE(EMF_FRAME_OFFSET + 12) - file.readInt32LE(EMF_FRAME_OFFSET + 4);
  if (frameWidth <= 0 || frameHeight <= 0) found.push('header frame has no area');
  let offset = 0;
  let count = 0;
  let lastType = -1;
  while (offset < file.length) {
    if (offset + EMF_RECORD_MIN_BYTES > file.length) {
      found.push(`record ${count} is cut off at byte ${offset}`);
      break;
    }
    const size = file.readUInt32LE(offset + 4);
    if (size < EMF_RECORD_MIN_BYTES || size % 4 !== 0 || offset + size > file.length) {
      found.push(`record ${count} at byte ${offset} has size ${size}`);
      break;
    }
    lastType = file.readUInt32LE(offset);
    offset += size;
    count++;
  }
  if (lastType !== EMR_EOF) found.push('last record is not EMR_EOF');
  if (file.readUInt32LE(EMF_RECORDS_OFFSET) !== count) found.push(`header says ${file.readUInt32LE(EMF_RECORDS_OFFSET)} records, file has ${count}`);
  return found;
}

/** The rules a WMF file breaks; empty when it is a well-formed Windows metafile (placeable or not). */
export function wmfViolations(file: Buffer): string[] {
  const found: string[] = [];
  let start = 0;
  if (file.length >= WMF_PLACEABLE_BYTES && file.readUInt32LE(0) === WMF_PLACEABLE_KEY) {
    let checksum = 0;
    for (let at = 0; at < WMF_PLACEABLE_CHECKSUM_OFFSET; at += WORD_BYTES) checksum ^= file.readUInt16LE(at);
    if (checksum !== file.readUInt16LE(WMF_PLACEABLE_CHECKSUM_OFFSET)) found.push('placeable header checksum is wrong');
    if (file.readUInt16LE(WMF_PLACEABLE_CHECKSUM_OFFSET - WORD_BYTES * 3) === 0) found.push('placeable header has no units per inch');
    start = WMF_PLACEABLE_BYTES;
  }
  if (file.length < start + WMF_HEADER_BYTES) return [...found, 'shorter than the metafile header'];
  const type = file.readUInt16LE(start);
  if (!WMF_TYPES.has(type)) found.push(`header type ${type} is neither memory nor disk`);
  if (file.readUInt16LE(start + 2) !== WMF_HEADER_SIZE_WORDS) found.push('header size is not 9 words');
  if (!WMF_VERSIONS.has(file.readUInt16LE(start + 4))) found.push('header version is neither 0x0100 nor 0x0300');
  const sizeWords = file.readUInt32LE(start + 6);
  if (sizeWords * WORD_BYTES !== file.length - start) found.push(`header says ${sizeWords * WORD_BYTES} bytes, file has ${file.length - start}`);
  let offset = start + WMF_HEADER_BYTES;
  let largest = 0;
  let lastFunction = -1;
  let count = 0;
  while (offset < file.length) {
    if (offset + 6 > file.length) {
      found.push(`record ${count} is cut off at byte ${offset}`);
      break;
    }
    const words = file.readUInt32LE(offset);
    if (words < WMF_RECORD_MIN_WORDS || offset + words * WORD_BYTES > file.length) {
      found.push(`record ${count} at byte ${offset} has ${words} words`);
      break;
    }
    largest = Math.max(largest, words);
    lastFunction = file.readUInt16LE(offset + 4);
    offset += words * WORD_BYTES;
    count++;
  }
  if (lastFunction !== WMF_EOF_FUNCTION) found.push('last record is not the end-of-file record');
  if (file.readUInt32LE(start + 12) !== largest) found.push(`header says the largest record is ${file.readUInt32LE(start + 12)} words, the largest is ${largest}`);
  return found;
}
