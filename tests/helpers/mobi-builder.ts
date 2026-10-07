/**
 * Hand-written MOBI / PalmDOC e-book builder for tests, following the PalmDB record layout and the PalmDOC and
 * MOBI header offsets of the MobileRead format notes. It shares no code with the reader under test: the text
 * records are compressed here with a small LZ77 encoder that emits the three PalmDOC codes (literal runs, space
 * pairs and back references).
 */

const PALMDB_HEADER_BYTES = 78;
const RECORD_ENTRY_BYTES = 8;
const PALMDOC_HEADER_BYTES = 16;
const MOBI_HEADER_BYTES = 232;
const RECORD0_BYTES = PALMDOC_HEADER_BYTES + MOBI_HEADER_BYTES;
const EXTRA_FLAGS_OFFSET = 0xf2;
const MAX_DISTANCE = 2047;
const MAX_MATCH = 10;
const MIN_MATCH = 3;

export const KNOWN_PALMDOC_VECTOR = {
  /** Hand-derived from the PalmDOC code table: "Hello" as literals, 0xC2 = space + "B", 0x8031 = copy 4 bytes from 6 back ("ello"). */
  compressed: Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xc2, 0x80, 0x31]),
  text: 'Hello Bello',
};

/** PalmDOC LZ77 compression of one record. */
export function palmDocCompress(input: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    let bestLength = 0;
    let bestDistance = 0;
    for (let distance = 1; distance <= Math.min(MAX_DISTANCE, i); distance += 1) {
      let length = 0;
      while (length < MAX_MATCH && i + length < input.length && input[i + length] === input[i - distance + length]) length += 1;
      if (length > bestLength) {
        bestLength = length;
        bestDistance = distance;
      }
    }
    if (bestLength >= MIN_MATCH) {
      const pair = 0x8000 | (bestDistance << 3) | (bestLength - MIN_MATCH);
      out.push(pair >> 8, pair & 0xff);
      i += bestLength;
    } else if (input[i] === 0x20 && i + 1 < input.length && input[i + 1] >= 0x40 && input[i + 1] <= 0x7f) {
      out.push(input[i + 1] ^ 0x80);
      i += 2;
    } else if (input[i] === 0 || (input[i] >= 0x09 && input[i] <= 0x7f)) {
      out.push(input[i]);
      i += 1;
    } else {
      // Bytes 0x01-0x08 and 0x80-0xFF travel in a literal run of up to eight bytes, introduced by the run length.
      let run = 1;
      while (run < 8 && i + run < input.length && (input[i + run] < 0x09 || input[i + run] > 0x7f) && input[i + run] !== 0) run += 1;
      out.push(run, ...input.subarray(i, i + run));
      i += run;
    }
  }
  return Buffer.from(out);
}

export interface MobiOptions {
  /** The text records exactly as stored (already compressed and with any trailing entries). */
  textRecords: Buffer[];
  /** Records after the text (an index or image record stands in for them). */
  extraRecords?: Buffer[];
  compression: 1 | 2 | 17480;
  /** 1252 or 65001. */
  encoding: number;
  /** PalmDOC header offset 12: 0 for an unprotected book. */
  encryption?: number;
  /** MOBI header trailing-entry flags (offset 0xF2). */
  extraFlags?: number;
  /** Declared uncompressed text length. */
  textLength: number;
  /** A plain PalmDOC book: type TEXt, creator REAd, no MOBI header. */
  plainPalmDoc?: boolean;
}

function record0(options: MobiOptions): Buffer {
  const length = options.plainPalmDoc ? PALMDOC_HEADER_BYTES : RECORD0_BYTES;
  const record = Buffer.alloc(length);
  record.writeUInt16BE(options.compression, 0);
  record.writeUInt32BE(options.textLength, 4);
  record.writeUInt16BE(options.textRecords.length, 8);
  record.writeUInt16BE(4096, 10);
  record.writeUInt16BE(options.encryption ?? 0, 12);
  if (!options.plainPalmDoc) {
    record.write('MOBI', 16, 'latin1');
    record.writeUInt32BE(MOBI_HEADER_BYTES, 20);
    record.writeUInt32BE(2, 24);
    record.writeUInt32BE(options.encoding, 28);
    record.writeUInt32BE(6, 36);
    record.writeUInt16BE(options.extraFlags ?? 0, EXTRA_FLAGS_OFFSET);
  }
  return record;
}

/** A complete PalmDB file holding the record 0 headers, the text records and any extra records. */
export function buildMobi(options: MobiOptions): Buffer {
  const records = [record0(options), ...options.textRecords, ...(options.extraRecords ?? [Buffer.from('INDX-record')])];
  const listEnd = PALMDB_HEADER_BYTES + records.length * RECORD_ENTRY_BYTES + 2;
  const header = Buffer.alloc(listEnd);
  header.write('Test book', 0, 'latin1');
  header.write(options.plainPalmDoc ? 'TEXt' : 'BOOK', 60, 'latin1');
  header.write(options.plainPalmDoc ? 'REAd' : 'MOBI', 64, 'latin1');
  header.writeUInt16BE(records.length, 76);
  let offset = listEnd;
  records.forEach((record, index) => {
    header.writeUInt32BE(offset, PALMDB_HEADER_BYTES + index * RECORD_ENTRY_BYTES);
    offset += record.length;
  });
  return Buffer.concat([header, ...records]);
}
