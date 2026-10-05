import zlib from 'node:zlib';
import { readXMins, reconstructGlyf, reconstructHmtx, serializeLoca, type GlyfReconstruction } from './font-woff2-glyf';
import {
  WOFF2_KNOWN_TAGS,
  WOFF2_MAX_DECODED_BYTES,
  WOFF2_MAX_FONTS,
  WOFF2_MAX_TABLES,
  Woff2FormatError,
  Woff2LimitError,
  alignUp,
  decode255UInt16,
  decodeUIntBase128,
  sfntChecksum,
  truncated,
} from './font-woff2-primitives';

export * from './font-woff2-primitives';

/**
 * WOFF2 container codec authored from the W3C WOFF2 Recommendation (https://www.w3.org/TR/WOFF2/):
 * the header, the table directory with its known tags, the collection directory, the Brotli stream
 * and the optional metadata and private blocks. The table transforms live in font-woff2-glyf.
 *
 * Every size read from the file is checked against the file itself or against the named limits
 * before it drives an allocation or a loop; malformed input throws {@link Woff2FormatError}.
 */

const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'
const COLLECTION_FLAVOR = 0x74746366; // 'ttcf'
const COLLECTION_VERSION_1 = 0x00010000;
const COLLECTION_VERSION_2 = 0x00020000;
const SIGNATURE_BYTES = 4;
const HEADER_BYTES = 48;
const HEADER_FLAVOR_AT = 4;
const HEADER_LENGTH_AT = 8;
const HEADER_NUM_TABLES_AT = 12;
const HEADER_TOTAL_SFNT_AT = 16;
const HEADER_COMPRESSED_SIZE_AT = 20;
const HEADER_META_OFFSET_AT = 28;
const HEADER_META_LENGTH_AT = 32;
const HEADER_META_ORIG_LENGTH_AT = 36;
const HEADER_PRIV_OFFSET_AT = 40;
const HEADER_PRIV_LENGTH_AT = 44;

const TAG_INDEX_MASK = 0x3f;
const TAG_EXPLICIT = 63;
const TRANSFORM_SHIFT = 6;
const TAG_BYTES = 4;
const TAG_FIRST_PRINTABLE = 0x20;
const TAG_LAST_PRINTABLE = 0x7e;

/** glyf and loca use version 0 for the transform and 3 for "stored as is"; hmtx uses 0 and 1; the others only 0. */
const GLYF_LOCA_TRANSFORMED = 0;
const GLYF_LOCA_NULL_TRANSFORM = 3;
const HMTX_TRANSFORMED = 1;

const SFNT_HEADER_BYTES = 12;
const SFNT_RECORD_BYTES = 16;
const SFNT_CHECKSUM_MAGIC = 0xb1b0afba;
const HEAD_ADJUSTMENT_AT = 8;
const HEAD_INDEX_TO_LOC_AT = 50;
const HEAD_MIN_BYTES = 54;
const HHEA_NUM_H_METRICS_AT = 34;
const HHEA_MIN_BYTES = 36;
const MAXP_NUM_GLYPHS_AT = 4;
const MAXP_MIN_BYTES = 6;
const COLLECTION_VERSION_BYTES = 4;
const FLAVOR_BYTES = 4;

export interface Woff2DecodedTable {
  tag: string;
  data: Buffer;
  /** sfnt directory checksum; for head it is taken with checkSumAdjustment zeroed. */
  checkSum: number;
}

export interface Woff2DecodedFont {
  /** sfnt version of the font (0x00010000, 'OTTO', 'true'). */
  flavor: number;
  tables: Woff2DecodedTable[];
}

interface DirectoryEntry {
  tag: string;
  transformed: boolean;
  /** Length of the table once reconstructed. */
  origLength: number;
  /** Length of the bytes stored in the compressed stream. */
  storedLength: number;
  /** Offset of the stored bytes in the decompressed stream. */
  offset: number;
}

interface FontSlice {
  flavor: number;
  indices: number[];
}

/**
 * head.checkSumAdjustment that makes the checksum of the whole font 0xB1B0AFBA, given the directory
 * layout (tags in ascending order, tables padded to four bytes) and the table checksums, head's taken
 * with the adjustment zeroed.
 */
export function checksumAdjustment(flavor: number, tables: ReadonlyArray<{ tag: string; length: number; checkSum: number }>): number {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const directory = new Uint8Array(SFNT_HEADER_BYTES + SFNT_RECORD_BYTES * sorted.length);
  const view = new DataView(directory.buffer);
  const entrySelector = Math.floor(Math.log2(sorted.length));
  const searchRange = 2 ** entrySelector * SFNT_RECORD_BYTES;
  view.setUint32(0, flavor);
  view.setUint16(4, sorted.length);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, sorted.length * SFNT_RECORD_BYTES - searchRange);
  let offset = directory.length;
  let total = 0;
  sorted.forEach((table, i) => {
    const at = SFNT_HEADER_BYTES + i * SFNT_RECORD_BYTES;
    for (let k = 0; k < TAG_BYTES; k++) directory[at + k] = table.tag.charCodeAt(k);
    view.setUint32(at + 4, table.checkSum);
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, table.length);
    offset += alignUp(table.length);
    total = (total + table.checkSum) >>> 0;
  });
  total = (total + sfntChecksum(directory)) >>> 0;
  return (SFNT_CHECKSUM_MAGIC - total) >>> 0;
}

function readTag(input: Uint8Array, at: number): string {
  let tag = '';
  for (let i = 0; i < TAG_BYTES; i++) {
    const c = input[at + i];
    if (c < TAG_FIRST_PRINTABLE || c > TAG_LAST_PRINTABLE) throw new Woff2FormatError('Invalid WOFF2: a table tag holds a non-printable character.');
    tag += String.fromCharCode(c);
  }
  return tag;
}

/**
 * Decodes every font of a WOFF2 file: one for a plain font, several for a collection. Throws
 * {@link Woff2FormatError} for anything the Recommendation does not allow.
 */
export function decodeWoff2Fonts(input: Buffer): Woff2DecodedFont[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < SIGNATURE_BYTES || view.getUint32(0) !== WOFF2_SIGNATURE) {
    throw new Woff2FormatError('Invalid WOFF2 font: missing wOF2 magic signature.');
  }
  if (input.length < HEADER_BYTES) throw truncated('the WOFF2 header');
  const flavor = view.getUint32(HEADER_FLAVOR_AT);
  if (view.getUint32(HEADER_LENGTH_AT) !== input.length) {
    throw new Woff2FormatError(`Invalid WOFF2: the header declares ${view.getUint32(HEADER_LENGTH_AT)} bytes but the file has ${input.length}.`);
  }
  const numTables = view.getUint16(HEADER_NUM_TABLES_AT);
  if (numTables === 0) throw new Woff2FormatError('Invalid WOFF2: the table directory is empty.');
  if (numTables > WOFF2_MAX_TABLES) throw new Woff2LimitError(`WOFF2 lists ${numTables} tables; at most ${WOFF2_MAX_TABLES} are supported.`);
  if (view.getUint32(HEADER_TOTAL_SFNT_AT) > WOFF2_MAX_DECODED_BYTES) {
    throw new Woff2LimitError(`WOFF2 announces a font larger than ${WOFF2_MAX_DECODED_BYTES} bytes.`);
  }
  const compressedSize = view.getUint32(HEADER_COMPRESSED_SIZE_AT);

  // table directory
  const cursor = { offset: HEADER_BYTES };
  const entries: DirectoryEntry[] = [];
  let storedTotal = 0;
  let origTotal = 0;
  for (let i = 0; i < numTables; i++) {
    if (cursor.offset >= input.length) throw truncated('the table directory');
    const flags = input[cursor.offset++];
    const tagIndex = flags & TAG_INDEX_MASK;
    const version = flags >> TRANSFORM_SHIFT;
    let tag: string;
    if (tagIndex === TAG_EXPLICIT) {
      if (cursor.offset + TAG_BYTES > input.length) throw truncated('the table directory');
      tag = readTag(input, cursor.offset);
      cursor.offset += TAG_BYTES;
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIndex];
    }
    const origLength = decodeUIntBase128(input, cursor);

    let transformed: boolean;
    if (tag === 'glyf' || tag === 'loca') {
      if (version !== GLYF_LOCA_TRANSFORMED && version !== GLYF_LOCA_NULL_TRANSFORM) {
        throw new Woff2FormatError(`Invalid WOFF2: transform version ${version} of '${tag}' is reserved.`);
      }
      transformed = version === GLYF_LOCA_TRANSFORMED;
    } else if (tag === 'hmtx') {
      if (version > HMTX_TRANSFORMED) throw new Woff2FormatError(`Invalid WOFF2: transform version ${version} of 'hmtx' is reserved.`);
      transformed = version === HMTX_TRANSFORMED;
    } else {
      if (version !== 0) throw new Woff2FormatError(`Invalid WOFF2: table '${tag}' has no transform version ${version}.`);
      transformed = false;
    }
    let storedLength = origLength;
    if (transformed) {
      storedLength = decodeUIntBase128(input, cursor);
      if (tag === 'loca' && storedLength !== 0) throw new Woff2FormatError('Invalid WOFF2: the transformLength of a transformed loca table must be 0.');
    }
    storedTotal += storedLength;
    origTotal += origLength;
    if (storedTotal > WOFF2_MAX_DECODED_BYTES || origTotal > WOFF2_MAX_DECODED_BYTES) {
      throw new Woff2LimitError(`The WOFF2 table directory describes more than ${WOFF2_MAX_DECODED_BYTES} bytes of table data.`);
    }
    entries.push({ tag, transformed, origLength, storedLength, offset: storedTotal - storedLength });
  }

  // fonts: the whole directory for a plain font, the collection directory otherwise
  const fonts: FontSlice[] = [];
  if (flavor === COLLECTION_FLAVOR) {
    if (cursor.offset + COLLECTION_VERSION_BYTES > input.length) throw truncated('the collection header');
    const version = view.getUint32(cursor.offset);
    cursor.offset += COLLECTION_VERSION_BYTES;
    if (version !== COLLECTION_VERSION_1 && version !== COLLECTION_VERSION_2) {
      throw new Woff2FormatError(`Invalid WOFF2: unknown collection version 0x${version.toString(16)}.`);
    }
    const numFonts = decode255UInt16(input, cursor);
    if (numFonts === 0) throw new Woff2FormatError('Invalid WOFF2: the collection holds no fonts.');
    if (numFonts > WOFF2_MAX_FONTS) throw new Woff2LimitError(`WOFF2 collection holds ${numFonts} fonts; at most ${WOFF2_MAX_FONTS} are supported.`);
    for (let f = 0; f < numFonts; f++) {
      const fontTables = decode255UInt16(input, cursor);
      if (fontTables === 0 || fontTables > entries.length) {
        throw new Woff2FormatError(`Invalid WOFF2: collection font ${f} lists ${fontTables} tables of a directory of ${entries.length}.`);
      }
      if (cursor.offset + FLAVOR_BYTES > input.length) throw truncated('the collection header');
      const fontFlavor = view.getUint32(cursor.offset);
      cursor.offset += FLAVOR_BYTES;
      const indices: number[] = [];
      for (let t = 0; t < fontTables; t++) {
        const index = decode255UInt16(input, cursor);
        if (index >= entries.length) throw new Woff2FormatError(`Invalid WOFF2: collection font ${f} names table ${index} of ${entries.length}.`);
        indices.push(index);
      }
      fonts.push({ flavor: fontFlavor, indices });
    }
  } else {
    fonts.push({ flavor, indices: entries.map((_, i) => i) });
  }

  // compressed stream, then the optional metadata and private blocks, then at most three bytes of padding
  const compressedEnd = cursor.offset + compressedSize;
  if (compressedSize === 0 || compressedEnd > input.length) throw truncated('the compressed font data');
  let blockEnd = compressedEnd;
  const metaOffset = view.getUint32(HEADER_META_OFFSET_AT);
  const metaLength = view.getUint32(HEADER_META_LENGTH_AT);
  const metaOrigLength = view.getUint32(HEADER_META_ORIG_LENGTH_AT);
  if (metaOffset !== 0 || metaLength !== 0 || metaOrigLength !== 0) {
    if (metaOffset !== alignUp(blockEnd) || metaLength === 0) {
      throw new Woff2FormatError('Invalid WOFF2: the metadata block does not follow the compressed font data.');
    }
    blockEnd = metaOffset + metaLength;
    if (blockEnd > input.length) throw truncated('the metadata block');
  }
  const privOffset = view.getUint32(HEADER_PRIV_OFFSET_AT);
  const privLength = view.getUint32(HEADER_PRIV_LENGTH_AT);
  if (privOffset !== 0 || privLength !== 0) {
    if (privOffset !== alignUp(blockEnd) || privLength === 0) {
      throw new Woff2FormatError('Invalid WOFF2: the private data block does not follow the preceding block.');
    }
    blockEnd = privOffset + privLength;
    if (blockEnd > input.length) throw truncated('the private data block');
  }
  if (input.length > alignUp(blockEnd)) throw new Woff2FormatError('Invalid WOFF2: the file has data after its last block.');

  // Brotli only. The output is capped at the size the directory announces plus one byte, so a stream
  // that expands further is rejected without being inflated.
  let stream: Buffer;
  try {
    stream = zlib.brotliDecompressSync(input.subarray(cursor.offset, compressedEnd), { maxOutputLength: storedTotal + 1 });
  } catch (error) {
    throw new Woff2FormatError(
      `Invalid WOFF2: the compressed font data is not a valid Brotli stream within the size the directory declares (${(error as Error).message}).`,
    );
  }
  if (stream.length !== storedTotal) {
    throw new Woff2FormatError(`Invalid WOFF2: the Brotli stream holds ${stream.length} bytes but the directory describes ${storedTotal}.`);
  }

  return buildFonts(fonts, entries, stream);
}

function buildFonts(fonts: FontSlice[], entries: DirectoryEntry[], stream: Buffer): Woff2DecodedFont[] {
  const stored = (index: number): Buffer => stream.subarray(entries[index].offset, entries[index].offset + entries[index].storedLength);
  const glyfCache = new Map<number, GlyfReconstruction>();
  const locaCache = new Map<number, Uint8Array>();
  const hmtxCache = new Map<number, Uint8Array>();
  const sumCache = new Map<number, number>();

  return fonts.map((font) => {
    const byTag = new Map<string, number>();
    for (const index of font.indices) {
      const tag = entries[index].tag;
      if (byTag.has(tag)) throw new Woff2FormatError(`Invalid WOFF2: a font lists table '${tag}' twice.`);
      byTag.set(tag, index);
    }
    const required = (tag: string, minBytes: number, why: string): Buffer => {
      const index = byTag.get(tag);
      if (index === undefined || entries[index].transformed) throw new Woff2FormatError(`Invalid WOFF2: ${why} needs a '${tag}' table.`);
      const data = stored(index);
      if (data.length < minBytes) throw truncated(`the '${tag}' table`);
      return data;
    };
    const u16At = (data: Buffer, at: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(at);

    const glyfIndex = byTag.get('glyf');
    const locaIndex = byTag.get('loca');
    const glyfTransformed = glyfIndex !== undefined && entries[glyfIndex].transformed;
    const locaTransformed = locaIndex !== undefined && entries[locaIndex].transformed;
    if (glyfTransformed !== locaTransformed) {
      throw new Woff2FormatError('Invalid WOFF2: glyf and loca must both be transformed or both be stored.');
    }

    let reconstruction: GlyfReconstruction | undefined;
    if (glyfTransformed && glyfIndex !== undefined && locaIndex !== undefined) {
      const maxp = required('maxp', MAXP_MIN_BYTES, 'the glyf transform');
      required('head', HEAD_MIN_BYTES, 'the glyf transform');
      reconstruction = glyfCache.get(glyfIndex);
      if (reconstruction === undefined) {
        reconstruction = reconstructGlyf(stored(glyfIndex), entries[glyfIndex].origLength);
        glyfCache.set(glyfIndex, reconstruction);
      }
      const declared = u16At(maxp, MAXP_NUM_GLYPHS_AT);
      if (declared !== reconstruction.numGlyphs) {
        throw new Woff2FormatError(`Invalid WOFF2: maxp declares ${declared} glyphs but the glyf transform holds ${reconstruction.numGlyphs}.`);
      }
      if (!locaCache.has(locaIndex)) {
        const loca = serializeLoca(reconstruction.offsets, reconstruction.indexFormat);
        if (loca.length !== entries[locaIndex].origLength) {
          throw new Woff2FormatError(`Invalid WOFF2: loca reconstructs to ${loca.length} bytes but the directory declares ${entries[locaIndex].origLength}.`);
        }
        locaCache.set(locaIndex, loca);
      }
    }

    const hmtxIndex = byTag.get('hmtx');
    if (hmtxIndex !== undefined && entries[hmtxIndex].transformed && !hmtxCache.has(hmtxIndex)) {
      const numHMetrics = u16At(required('hhea', HHEA_MIN_BYTES, 'the hmtx transform'), HHEA_NUM_H_METRICS_AT);
      let numGlyphs: number;
      let xMin: Int16Array;
      if (reconstruction !== undefined) {
        ({ numGlyphs, xMin } = reconstruction);
      } else {
        numGlyphs = u16At(required('maxp', MAXP_MIN_BYTES, 'the hmtx transform'), MAXP_NUM_GLYPHS_AT);
        const head = required('head', HEAD_MIN_BYTES, 'the hmtx transform');
        if (glyfIndex === undefined || locaIndex === undefined) throw new Woff2FormatError('Invalid WOFF2: the hmtx transform needs glyf and loca.');
        const longLoca = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt16(HEAD_INDEX_TO_LOC_AT) === 1;
        xMin = readXMins(stored(glyfIndex), stored(locaIndex), longLoca, numGlyphs);
      }
      hmtxCache.set(hmtxIndex, reconstructHmtx(stored(hmtxIndex), entries[hmtxIndex].origLength, numGlyphs, numHMetrics, xMin));
    }

    const dataOf = (index: number): Uint8Array => {
      const entry = entries[index];
      if (!entry.transformed) return stored(index);
      if (entry.tag === 'glyf') return reconstruction!.glyf;
      if (entry.tag === 'loca') return locaCache.get(index)!;
      return hmtxCache.get(index)!;
    };

    const tables: Woff2DecodedTable[] = font.indices.map((index) => {
      const entry = entries[index];
      let data = dataOf(index);
      if (entry.tag === 'head') {
        // head is patched per font: the loca format of the reconstructed glyf and, below, the checksum adjustment
        data = Uint8Array.from(data);
        const headView = new DataView(data.buffer);
        if (reconstruction !== undefined) headView.setInt16(HEAD_INDEX_TO_LOC_AT, reconstruction.indexFormat);
        if (data.length >= HEAD_ADJUSTMENT_AT + 4) headView.setUint32(HEAD_ADJUSTMENT_AT, 0);
      }
      let checkSum = entry.tag === 'head' ? undefined : sumCache.get(index);
      if (checkSum === undefined) {
        checkSum = sfntChecksum(data);
        if (entry.tag !== 'head') sumCache.set(index, checkSum);
      }
      return { tag: entry.tag, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), checkSum };
    });

    const head = tables.find((table) => table.tag === 'head');
    if (head !== undefined && head.data.length >= HEAD_ADJUSTMENT_AT + 4) {
      const adjustment = checksumAdjustment(font.flavor, tables.map((t) => ({ tag: t.tag, length: t.data.length, checkSum: t.checkSum })));
      head.data.writeUInt32BE(adjustment, HEAD_ADJUSTMENT_AT);
    }
    return { flavor: font.flavor, tables };
  });
}
