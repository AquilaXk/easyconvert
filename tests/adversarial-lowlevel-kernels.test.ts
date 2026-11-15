import zlib from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  CadExpansionLimitError,
  ConversionFailedError,
  CorruptStreamError,
  DataParseError,
  DecompressionLimitError,
  OcrPreprocessError,
  PayloadLimitError,
} from '../src/lib/types';
import { deflateRawInBlocks } from '../src/lib/conversions/deflate-blocks';
import { decompressZstdNative } from '../src/lib/conversions/zstd-native';
import { DelimitedByteScanner, DelimitedBytesUnsupported, releaseChunkScratch } from '../src/lib/conversions/delimited-bytes';
import { decodeRleHybrid } from '../src/lib/conversions/parquet-rle';
import { decompressPage, decompressPageSlice } from '../src/lib/conversions/parquet-codec';
import { CompressionCodec, ParquetFormatError } from '../src/lib/conversions/parquet-format';
import { float16ToFloat32, getFloat16DecodeTable } from '../src/lib/conversions/float16';
import { decodeLinearBt709 } from '../src/lib/conversions/sdr-linear';
import { KdTree3 } from '../src/lib/conversions/kd-tree';
import { encodeCcittG4 } from '../src/lib/conversions/ccitt-g4';
import { decompressBzip2 } from '../src/lib/conversions/bzip2';
import { decompressZstd } from '../src/lib/conversions/zstd';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office/xlsx-parse';
import { generatePdfFromDocx } from '../src/lib/conversions/office/docx-pdf';
import { XML_TREE_MAX_DEPTH, parseXmlTree } from '../src/lib/conversions/xml-tree';
import { parseDxfDrawing } from '../src/lib/conversions/cad-dxf';
import { detectLatticeTables } from '../src/lib/conversions/pdf-layout/tables';
import { LayoutBudget } from '../src/lib/conversions/pdf-layout/limits';
import { forEachContentToken } from '../src/lib/conversions/pdf-content-tokens';
import { PdfDocument } from '../src/lib/conversions/pdf-document';
import { PREDICTOR_TIFF, undoPredictor } from '../src/lib/conversions/pdf-filters';
import { InflateBudget } from '../src/lib/conversions/bounded-inflate';
import { encodeEmf, encodeWmf } from '../src/lib/conversions/vector-metafile';
import { SAUVOLA_INK, SAUVOLA_MAX_PIXELS, SAUVOLA_PAPER, oddWindow, sauvolaBinarize } from '../src/lib/conversions/ocr-sauvola';

/** Independent Python `bz2.compress` fixture for `(b"Bzip2-24bit-word-refill-kernel-check! " * 40) + bytes(range(256))`. */
const PYTHON_BZ2_FIXTURE_HEX =
  '425a683131415926535923b127760000fd7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffb00158084980026000260000000000000000000000000000000000000000000000000000000024c0013000130000000000' +
  '00000000000000000000000000000000000000000000000495429ed269ea100d001a1a0007a869a0d0190c9a000000d068d3' +
  '1341a69a0000640d0000000000000000000000000013768d5b499bb0e1d9cbbb2f0f2f527944a6552b964b5ee5d2f984c665' +
  '339a4d66cf8f8d12410e02270d6733a7d9dcf27b3e9fd02834274022ec00886011180228eea91498a010fcdc0439a5b4010f' +
  'f4ca6d3a9f0150a8d4aa754aac0c13ea483fd57ac41c256616b55bae576bd5fb0586c563b2596cd67b45a6d56bb65b6dd6fb' +
  '85c61ae5440117374022ea022300443c4008806c0222c04428086102221c008bc3b360111c021901114c0087801116e40441' +
  '0086e02196af2022f2f51a02180117a81680219010ee022f6e580117c84beb80111acdf9fc04473ddfe3dedf1f5f9fe02060' +
  'a0e12161a1e22262a2e32363a3e42464a4e52565a5e62666a6e72767a7e82868a8e92969a9ea2a6aaaeb2b6babec2c6caced' +
  '2d6dadee2e6eaeef2f6faff03070b0f13171b1f23272b2f33373b3f43474b4f53575b5f63676b6f73777b7f83878b8f93979' +
  'b9fa3a7abafb3b7bbbfc3c7cbcfd3d7dbdfe3e7ebeff3f45dc914e142408ec49dd80';

function writeUnsignedVarint(out: number[], value: number): void {
  let rem = BigInt(value);
  while (rem >= 0x80n) {
    out.push(Number(rem & 0x7fn) | 0x80);
    rem >>= 7n;
  }
  out.push(Number(rem));
}

/** Independent Parquet RLE/bit-packed spec builder using BigInt bit accumulation (never calls production encoder). */
function buildSpecBitPackedStream(values: readonly number[], bitWidth: number): Uint8Array {
  const groups = Math.ceil(values.length / 8);
  const paddedCount = groups * 8;
  const header: number[] = [];
  writeUnsignedVarint(header, groups * 2 + 1);
  if (bitWidth === 0) return Uint8Array.from(header);

  let acc = 0n;
  let accBits = 0n;
  const bw = BigInt(bitWidth);
  const payload: number[] = [];
  for (let i = 0; i < paddedCount; i++) {
    const v = i < values.length ? BigInt(values[i] >>> 0) : 0n;
    acc |= v << accBits;
    accBits += bw;
    while (accBits >= 8n) {
      payload.push(Number(acc & 0xffn));
      acc >>= 8n;
      accBits -= 8n;
    }
  }
  return Uint8Array.from([...header, ...payload]);
}

function buildSpecRleRun(value: number, runLength: number, bitWidth: number): Uint8Array {
  const bytes: number[] = [];
  writeUnsignedVarint(bytes, runLength * 2);
  const widthBytes = (bitWidth + 7) >> 3;
  for (let i = 0; i < widthBytes; i++) {
    bytes.push((value >>> (i * 8)) & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** Independent IEEE 754-2008 binary16 reference formula. */
function referenceBinary16ToFloat32(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const frac = bits & 0x03ff;
  if (exp === 0) {
    if (frac === 0) return sign < 0 ? -0 : 0;
    return Math.fround(sign * 2 ** -14 * (frac / 1024));
  }
  if (exp === 0x1f) {
    return frac === 0 ? sign * Infinity : Number.NaN;
  }
  return Math.fround(sign * 2 ** (exp - 15) * (1 + frac / 1024));
}

function buildMinimalXlsxZip(sheetXml: string, sharedStringsXml?: string): JSZip {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="MainSheet" sheetId="1" r:id="rId1"/></sheets></workbook>'
  );
  const sstRel = sharedStringsXml
    ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    : '';
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${sstRel}</Relationships>`
  );
  if (sharedStringsXml) zip.file('xl/sharedStrings.xml', sharedStringsXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip;
}

describe('Track A low-level bit/word/LUT/SWAR/codec/parser kernels', () => {
  describe('F-10 deflateRawInBlocks bounded concurrency', () => {
    it('inflates multi-block streams with cross-block dictionary matches deterministically', async () => {
      const blockSize = 16 * 1024;
      const source = Buffer.alloc(blockSize * 12 + 333);
      for (let i = 0; i < source.length; i++) {
        source[i] = (i * 29 + (i >>> 6) * 7) & 0xff;
      }
      // Repeat a 512-byte phrase straddling every 16 KiB block boundary to verify preset dictionary linking.
      const phrase = Buffer.from('Cross-block-dictionary-match-verification-pattern-0123456789ABCDEF!'.repeat(8), 'utf8');
      for (let b = 1; b < 12; b++) {
        phrase.copy(source, b * blockSize - 128, 0, 256);
        phrase.copy(source, b * blockSize + 64, 0, 256);
      }

      const first = await deflateRawInBlocks(source, 6, blockSize);
      const second = await deflateRawInBlocks(source, 6, blockSize);
      expect(first.equals(second)).toBe(true);
      const inflated = zlib.inflateRawSync(first);
      expect(inflated.equals(source)).toBe(true);
    });
  });

  describe('F-11 zstd-native verified-empty frame fast path & fail-closed guards', () => {
    it('decodes 20,000 concatenated empty Zstandard frames with and without checksums', async () => {
      const emptyWithChecksum = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0x00, 0x00, 0x99, 0xe9, 0xd8, 0x51]);
      const emptyNoChecksum = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00]);
      const count = 10_000;
      const stride = emptyWithChecksum.length + emptyNoChecksum.length;
      const stream = Buffer.allocUnsafe(count * stride);
      for (let i = 0; i < count; i++) {
        emptyWithChecksum.copy(stream, i * stride);
        emptyNoChecksum.copy(stream, i * stride + emptyWithChecksum.length);
      }

      const decoded = await decompressZstdNative(stream);
      expect(decoded.length).toBe(0);
    });

    it('rejects empty frame with corrupted XXH64 checksum or reserved FHD bit instead of skipping C check', async () => {
      const badChecksumEmpty = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0x00, 0x00, 0x98, 0xe9, 0xd8, 0x51]);
      await expect(decompressZstdNative(badChecksumEmpty)).rejects.toThrow(ConversionFailedError);

      // Reserved bit 0x08 set on an otherwise 0-byte frame must not bypass libzstd validation.
      const reservedBitFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x28, 0x00, 0x01, 0x00, 0x00]);
      await expect(decompressZstdNative(reservedBitFrame)).rejects.toThrow(ConversionFailedError);
    });

    it('interleaves verified-empty frames, skippable frames, and non-empty frames while enforcing maxOutputBytes', async () => {
      const empty = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00]);
      const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x03, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc]);
      const p1 = Buffer.from('First payload across multi-frame stream!', 'utf8');
      const p2 = Buffer.from('Second payload after empty frames!', 'utf8');
      const f1 = zlib.zstdCompressSync(p1);
      const f2 = zlib.zstdCompressSync(p2);

      const combined = Buffer.concat([empty, skippable, f1, empty, empty, f2, empty]);
      const out = await decompressZstdNative(combined);
      expect(out.equals(Buffer.concat([p1, p2]))).toBe(true);

      await expect(decompressZstdNative(combined, { maxOutputBytes: p1.length + p2.length - 1 })).rejects.toThrow(
        DecompressionLimitError
      );
    });
  });

  describe('F-14 DelimitedByteScanner SWAR word scan & slice-only quote unescaping', () => {
    it('scans space-heavy and exclamation-heavy unquoted fields across all 4-byte alignments and rejects stray quotes', () => {
      const rows = [
        'col a!,col b!,col c!,col d!',
        'hello world!,a! b! c! d!,   leading spaces,trailing spaces   ',
        '!bang!start!,mid ! bang,x y z w 1 2 3,utf8 café naïve!',
      ];
      const buf = Buffer.from(rows.join('\n') + '\n', 'utf8');
      const scanner = DelimitedByteScanner.open(buf, ',', false);
      expect(scanner.header).toEqual(['col a!', 'col b!', 'col c!', 'col d!']);

      const chunk = scanner.nextChunk(16, 1024 * 1024);
      expect(chunk).not.toBeNull();
      expect(chunk!.rows).toBe(2);
      const readCell = (r: number, c: number): string => {
        const idx = r * scanner.width + c;
        return chunk!.data.toString('utf8', chunk!.starts[idx], chunk!.starts[idx] + chunk!.lengths[idx]);
      };
      expect(readCell(0, 0)).toBe('hello world!');
      expect(readCell(0, 1)).toBe('a! b! c! d!');
      expect(readCell(0, 2)).toBe('   leading spaces');
      expect(readCell(1, 3)).toBe('utf8 café naïve!');

      // Stray quote in each of the 4 SWAR byte lanes inside an unquoted cell must throw DelimitedBytesUnsupported.
      for (let lane = 0; lane < 4; lane++) {
        const prefix = 'a'.repeat(lane);
        const bad = Buffer.from(`h1,h2\n${prefix}"bad,ok\n`, 'utf8');
        expect(() => {
          const s = DelimitedByteScanner.open(bad, ',', false);
          s.nextChunk(8, 65536);
        }).toThrow(DelimitedBytesUnsupported);
      }
    });

    it('unescapes doubled quotes in header and body without copying or mutating the input Buffer', () => {
      const originalCsv =
        '"col ""A""",col B,col C\n' +
        '"he said ""hi""!",plain text,"""""triple"""" "\n' +
        'row2 a,"no escape",row2 c\n';
      const source = Buffer.from(originalCsv, 'utf8');
      const snapshot = Buffer.from(source);

      const scanner = DelimitedByteScanner.open(source, ',', false);
      expect(scanner.data).toBe(source);
      expect(scanner.header).toEqual(['col "A"', 'col B', 'col C']);

      const chunk = scanner.nextChunk(16, 1024 * 1024);
      expect(chunk).not.toBeNull();
      expect(source.equals(snapshot)).toBe(true);
      expect(scanner.data).toBe(source);

      const cell = (r: number, c: number): string => {
        const i = r * scanner.width + c;
        return chunk!.data.toString('utf8', chunk!.starts[i], chunk!.starts[i] + chunk!.lengths[i]);
      };
      expect(cell(0, 0)).toBe('he said "hi"!');
      expect(cell(0, 1)).toBe('plain text');
      expect(cell(0, 2)).toBe('""triple"" ');
      expect(cell(1, 0)).toBe('row2 a');
      expect(cell(1, 1)).toBe('no escape');
      expect(cell(1, 2)).toBe('row2 c');
      releaseChunkScratch();
    });
  });

  describe('F-15 parquet-rle 8-value word-unrolled bit unpacker across bitWidths 0..32', () => {
    it('unpacks full 8-value groups and partial tails bit-exactly for every bitWidth from 0 to 32', () => {
      for (let bw = 0; bw <= 32; bw++) {
        const headCount = 24; // 3 full 8-value groups
        const rleCount = 11;
        const tailCount = 5; // final partial 8-value group (scalar tail)
        const mask = bw === 0 ? 0 : 0xffffffff >>> (32 - bw);
        const headValues = new Uint32Array(headCount);
        for (let i = 0; i < headCount; i++) {
          const raw = (Math.imul(i + 1, 0x9e3779b1) ^ (i * 17)) >>> 0;
          headValues[i] = bw === 0 ? 0 : (raw & mask) >>> 0;
        }
        const tailValues = new Uint32Array(tailCount);
        for (let i = 0; i < tailCount; i++) {
          const raw = (Math.imul(i + 41, 0x85ebca6b) ^ (i * 31)) >>> 0;
          tailValues[i] = bw === 0 ? 0 : (raw & mask) >>> 0;
        }
        const rleMidValue = bw === 0 ? 0 : (0xa5a5a5a5 & mask) >>> 0;
        const part1 = buildSpecBitPackedStream(Array.from(headValues), bw);
        const part2 = buildSpecRleRun(rleMidValue, rleCount, bw);
        const part3 = buildSpecBitPackedStream(Array.from(tailValues), bw);
        const combined = Buffer.concat([part1, part2, part3]);

        const total = headCount + rleCount + tailCount;
        const out = new Uint32Array(total);
        decodeRleHybrid(combined, 0, combined.length, bw, total, out);
        for (let i = 0; i < headCount; i++) {
          expect(out[i], `bitWidth=${bw} head index=${i}`).toBe(headValues[i]);
        }
        for (let i = 0; i < rleCount; i++) {
          expect(out[headCount + i], `bitWidth=${bw} rle index=${i}`).toBe(rleMidValue);
        }
        for (let i = 0; i < tailCount; i++) {
          expect(out[headCount + rleCount + i], `bitWidth=${bw} tail index=${i}`).toBe(tailValues[i]);
        }
      }
    });

    it('fails closed on invalid bitWidth, overlong varint, and truncated bit-packed/RLE payloads', () => {
      const out = new Uint32Array(16);
      expect(() => decodeRleHybrid(Uint8Array.of(2, 0), 0, 2, -1, 1, out)).toThrow(ParquetFormatError);
      expect(() => decodeRleHybrid(Uint8Array.of(2, 0), 0, 2, 33, 1, out)).toThrow(ParquetFormatError);
      // 6-byte varint with continuation bits set
      expect(() => decodeRleHybrid(Uint8Array.of(0x81, 0x80, 0x80, 0x80, 0x80, 0x01), 0, 6, 4, 8, out)).toThrow(
        ParquetFormatError
      );
      // Bit-packed header claims 2 groups at bitWidth=5 (10 bytes needed), only 4 bytes supplied
      expect(() => decodeRleHybrid(Uint8Array.of(5, 1, 2, 3, 4), 0, 5, 5, 16, out)).toThrow(ParquetFormatError);
    });
  });

  describe('F-16 parquet-codec LZ4_RAW & Hadoop LZ4 match-copy kernels and length safety', () => {
    it('decodes RLE (offset=1), overlapping doubling (offset=3, 5), and non-overlapping matches accurately', () => {
      // Sequence 1: 1 literal [0x5a], offset=1, matchLen=19 (token: lit=1, ml=15 -> ext=0) => 20 x 0x5a
      // Sequence 2: 3 literals [0x11, 0x22, 0x33], offset=3, matchLen=25 (token: lit=3, ml=15 -> ext=6) => 28 bytes repeating 11,22,33
      // Sequence 3: 5 literals [1,2,3,4,5], offset=5, matchLen=37 (token: lit=5, ml=15 -> ext=18) => 42 bytes repeating 1..5
      // Sequence 4 (final): 6 literals [9,8,7,6,5,4] (token: lit=6, ml=0)
      const lz4Raw = Buffer.from([
        (1 << 4) | 15, 0x5a, 1, 0, 0,
        (3 << 4) | 15, 0x11, 0x22, 0x33, 3, 0, 6,
        (5 << 4) | 15, 1, 2, 3, 4, 5, 5, 0, 18,
        6 << 4, 9, 8, 7, 6, 5, 4,
      ]);
      const expected = Buffer.concat([
        Buffer.alloc(20, 0x5a),
        Buffer.from(Array.from({ length: 28 }, (_, i) => [0x11, 0x22, 0x33][i % 3])),
        Buffer.from(Array.from({ length: 42 }, (_, i) => (i % 5) + 1)),
        Buffer.from([9, 8, 7, 6, 5, 4]),
      ]);

      const decoded = decompressPage(CompressionCodec.LZ4_RAW, lz4Raw, expected.length);
      expect(decoded.equals(expected)).toBe(true);

      // Wrap two blocks in Hadoop LZ4 framing inside a padded parent buffer and decode via decompressPageSlice
      const block2 = Buffer.from([5 << 4, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
      const hadoop = Buffer.alloc(12 + lz4Raw.length + 8 + block2.length + 6, 0xff);
      let p = 4; // leading guard bytes
      hadoop.writeUInt32BE(expected.length, p); p += 4;
      hadoop.writeUInt32BE(lz4Raw.length, p); p += 4;
      lz4Raw.copy(hadoop, p); p += lz4Raw.length;
      hadoop.writeUInt32BE(5, p); p += 4;
      hadoop.writeUInt32BE(block2.length, p); p += 4;
      block2.copy(hadoop, p); p += block2.length;

      const hadoopOut = decompressPageSlice(CompressionCodec.LZ4, hadoop, 4, p, expected.length + 5);
      expect(hadoopOut.equals(Buffer.concat([expected, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee])]))).toBe(true);
    });

    it('rejects short output, zero offset, out-of-bounds offset, and non-empty zero-expected blocks', () => {
      const validFiveBytes = Buffer.from([5 << 4, 1, 2, 3, 4, 5]);
      // Declaring 8 expected bytes when stream produces 5 must throw instead of leaking 3 uninitialized bytes!
      expect(() => decompressPage(CompressionCodec.LZ4_RAW, validFiveBytes, 8)).toThrow(ParquetFormatError);
      // Zero offset
      expect(() => decompressPage(CompressionCodec.LZ4_RAW, Buffer.from([(4 << 4) | 0, 1, 2, 3, 4, 0, 0]), 8)).toThrow(
        ParquetFormatError
      );
      // Offset larger than already-decoded prefix
      expect(() => decompressPage(CompressionCodec.LZ4_RAW, Buffer.from([(2 << 4) | 0, 1, 2, 5, 0]), 6)).toThrow(
        ParquetFormatError
      );
      // Non-empty compressed payload when expectedBytes === 0
      expect(() => decompressPage(CompressionCodec.LZ4_RAW, Buffer.from([0x10, 0x41]), 0)).toThrow(ParquetFormatError);
    });
  });

  describe('F-17 IEEE 754 binary16 exhaustive 65,536-entry table & 16-bit SDR alignment', () => {
    it('matches the IEEE 754-2008 binary16 mathematical definition across all 65,536 16-bit patterns', () => {
      const table = getFloat16DecodeTable();
      expect(table.length).toBe(65_536);
      expect(getFloat16DecodeTable()).toBe(table);

      for (let bits = 0; bits <= 0xffff; bits++) {
        const expected = referenceBinary16ToFloat32(bits);
        const fromFn = float16ToFloat32(bits);
        const fromTbl = table[bits];
        if (Number.isNaN(expected)) {
          expect(Number.isNaN(fromFn), `NaN fn at 0x${bits.toString(16)}`).toBe(true);
          expect(Number.isNaN(fromTbl), `NaN tbl at 0x${bits.toString(16)}`).toBe(true);
        } else {
          expect(Object.is(fromFn, expected), `fn mismatch at 0x${bits.toString(16)}`).toBe(true);
          expect(Object.is(fromTbl, expected), `tbl mismatch at 0x${bits.toString(16)}`).toBe(true);
        }
      }
    });

    it('decodes 16-bit RGB samples through decodeLinearBt709 into finite unit-range linear Rec. 709 values', async () => {
      const pngChunk = (type: string, data: Buffer): Buffer => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 4, 'ascii');
        data.copy(out, 8);
        out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(2, 0);
      ihdr.writeUInt32BE(2, 4);
      ihdr[8] = 16;
      ihdr[9] = 2; // truecolour RGB
      const samples = [0, 32768, 65535, 65535, 0, 16384, 8192, 49152, 65535, 65535, 65535, 0];
      const scan = Buffer.alloc(2 * (1 + 2 * 3 * 2));
      for (let y = 0; y < 2; y++) {
        const rowOff = y * 13;
        scan[rowOff] = 0;
        for (let x = 0; x < 6; x++) scan.writeUInt16BE(samples[y * 6 + x], rowOff + 1 + x * 2);
      }
      const png16 = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(scan)),
        pngChunk('IEND', Buffer.alloc(0)),
      ]);
      const pipe = sharp(png16);
      const meta = await pipe.metadata();
      expect(meta.depth).toBe('ushort');
      const raster = await decodeLinearBt709(pipe, meta, null);
      expect(raster.width).toBe(2);
      expect(raster.height).toBe(2);
      expect(raster.rgb.length).toBe(12);
      expect(raster.rgb[0]).toBe(0);
      expect(raster.rgb[1]).toBeCloseTo(((32768 / 65535 + 0.055) / 1.055) ** 2.4, 4);
      expect(raster.rgb[2]).toBeCloseTo(1, 4);
      expect(raster.rgb[9]).toBeCloseTo(1, 4);
      expect(raster.rgb[10]).toBeCloseTo(1, 4);
      expect(raster.rgb[11]).toBe(0);
    });
  });

  describe('F-18 KdTree3 SoA quickselect & voxel grid exactness', () => {
    it('matches brute-force Euclidean nearest-neighbor (including tie-breaking and hints) across 5,000 queries', () => {
      const count = 128;
      const coords = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) {
        // Include duplicate/equidistant coordinates to exercise lowest-index tie-breaking
        const k = i >= 120 ? i - 8 : i;
        coords[i * 3] = (k * 67 + 11) % 256;
        coords[i * 3 + 1] = (k * 131 + 29) % 256;
        coords[i * 3 + 2] = (k * 197 + 53) % 256;
      }
      const tree = new KdTree3(coords, count);

      const bruteNearest = (qx: number, qy: number, qz: number): { index: number; d2: number } => {
        let bestIdx = 0;
        let bestD2 = Infinity;
        for (let i = 0; i < count; i++) {
          const dx = qx - coords[i * 3];
          const dy = qy - coords[i * 3 + 1];
          const dz = qz - coords[i * 3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD2 || (d2 === bestD2 && i < bestIdx)) {
            bestD2 = d2;
            bestIdx = i;
          }
        }
        return { index: bestIdx, d2: bestD2 };
      };

      let prev = -1;
      for (let q = 0; q < 5000; q++) {
        const qx = ((q * 83 + 7) % 270) - 7;
        const qy = ((q * 149 + 19) % 270) - 7;
        const qz = ((q * 211 + 31) % 270) - 7;
        const expected = bruteNearest(qx, qy, qz);
        const got = q % 3 === 0 ? tree.nearestIndex(qx, qy, qz, prev, 0) : tree.nearestIndex(qx, qy, qz);
        expect(got).toBe(expected.index);
        expect(tree.lastDistance2).toBe(expected.d2);
        prev = got;
      }

      expect(() => new KdTree3(coords, 0)).toThrow(RangeError);
      expect(() => new KdTree3(coords, 4097)).toThrow(RangeError);
    });
  });

  describe('F-19 CCITT Group 4 32-bit word XOR + clz32 transition scanner', () => {
    it('encodes all-white and non-word-aligned transition scanlines to exact ITU-T T.6 bitstreams', () => {
      // 73x2 all-white raster (non-multiple of 8 and 32; trailing 7 unused bits in byte 9 are 0 to test end-of-row masking!)
      const rowBytes = 10;
      const whiteData = new Uint8Array(rowBytes * 2);
      whiteData.fill(0xff);
      // Set trailing unused bits past x=73 (bits 0..6 of byte 9) to 0 (black) — encoder MUST mask them as white!
      whiteData[9] = 0x80;
      whiteData[19] = 0x80;

      const encoded = encodeCcittG4({ width: 73, height: 2, data: whiteData }, 256);
      expect(encoded).not.toBeNull();
      // Two all-white rows against an all-white reference line emit V(0)='1', V(0)='1', followed by EOFB='000000000001000000000001'
      // Total 26 bits: '11' + '000000000001' + '000000000001' + '000000' = 0xc0, 0x04, 0x00, 0x40
      expect(Array.from(encoded!)).toEqual([0xc0, 0x04, 0x00, 0x40]);
    });
  });

  describe('F-20 bzip2 word-refill BitReader & Zstandard word bitstream / overlapping match decode', () => {
    it('decodes system-bzip2 compressed payload across 24-bit/16-bit word refills and rejects corrupted CRC', () => {
      const bzBytes = Buffer.from(PYTHON_BZ2_FIXTURE_HEX, 'hex');
      const expected = Buffer.concat([
        Buffer.from('Bzip2-24bit-word-refill-kernel-check! '.repeat(40), 'utf8'),
        Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      ]);
      const decoded = decompressBzip2(bzBytes);
      expect(decoded.equals(expected)).toBe(true);

      const corrupted = Buffer.from(bzBytes);
      corrupted[corrupted.length - 2] ^= 0x01;
      expect(() => decompressBzip2(corrupted)).toThrow(CorruptStreamError);
    });

    it('decodes Zstandard frames with RLE, short-offset overlapping matches, and FSE tables via pure TS decoder', () => {
      const chunks: Buffer[] = [
        Buffer.alloc(4096, 0x7a),
        Buffer.from('abc'.repeat(1500), 'utf8'),
        Buffer.from('abcde'.repeat(900), 'utf8'),
        Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 73 + 19) & 0xff)),
      ];
      const expected = Buffer.concat(chunks);
      const zstdFrame = zlib.zstdCompressSync(expected);
      const decoded = decompressZstd(zstdFrame);
      expect(decoded.equals(expected)).toBe(true);
    });
  });

  describe('F-21 single-pass saxes XLSX worksheet parser, immutable EMPTY_ATTRS, and DOCX PDF table layout', () => {
    it('parses cells, strips phonetic <rPh> runs, reads merges/colWidths, and enforces XML well-formedness & depth', async () => {
      const sst =
        '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<si><t>SharedZero</t></si><si><r><t>Kan</t></r><rPh sb="0" eb="3"><t>IGNORE</t></rPh><r><t>ji</t></r></si></sst>';
      const sheet =
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<cols><col min="1" max="2" width="18.5"/></cols>' +
        '<sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Inline</t><rPh><t>NO</t></rPh></is></c></row>' +
        '<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><v>42.5</v></c><c r="C2" t="str"><f>SUM(B2,1)</f><v>43.5</v></c></row>' +
        '</sheetData>' +
        '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' +
        '</worksheet>';

      const sheets = await parseAllXlsxWorksheets(buildMinimalXlsxZip(sheet, sst));
      expect(sheets).toHaveLength(1);
      expect(sheets[0].rows).toEqual([
        ['SharedZero', 'Kanji', 'Inline'],
        ['TRUE', '42.5', '43.5'],
      ]);
      expect(sheets[0].mergedRanges).toEqual([{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }]);
      expect(sheets[0].columnWidths).toEqual([139, 139]);

      const malformedZip = buildMinimalXlsxZip('<worksheet><sheetData><row r="1"><c r="A1"></row></sheetData></worksheet>');
      await expect(parseAllXlsxWorksheets(malformedZip)).rejects.toThrow(DataParseError);
    });

    it('reuses a frozen immutable EMPTY_ATTRS map on attribute-free elements and enforces XML_TREE_MAX_DEPTH', () => {
      const root = parseXmlTree('<root><a/><b/><c k="v"/></root>', 'word/document.xml', 'DOCX');
      const [a, b, c] = root.children as ReturnType<typeof parseXmlTree>[];
      expect(a.attrs).toBe(b.attrs);
      expect(a.attrs.size).toBe(0);
      expect(c.attrs.get('k')).toBe('v');
      expect(() => (a.attrs as Map<string, string>).set('x', 'y')).toThrow(TypeError);

      const deepOpen = '<n>'.repeat(XML_TREE_MAX_DEPTH + 2);
      const deepClose = '</n>'.repeat(XML_TREE_MAX_DEPTH + 2);
      expect(() => parseXmlTree(deepOpen + deepClose, 'word/document.xml', 'DOCX')).toThrow(PayloadLimitError);
    });

    it('renders DOCX structured tables with colSpan, rowSpan, and nested tables into a valid PDF buffer', async () => {
      const tbl = {
        colCount: 3,
        colWidths: [2000, 2000, 2000],
        rows: [
          ['H1', 'H2'],
          [' Tall spanned cell ', 'R1C2', 'R1C3'],
          ['', 'R2C2', 'R2C3'],
        ],
        structuredRows: [
          [{ text: 'Header Left', isHeader: true }, { text: 'Header Span', colSpan: 2, isHeader: true }],
          [
            { text: 'Multi-row spanned content\nLine 2\nLine 3\nLine 4', rowSpan: 2 },
            { text: 'Cell B2', nestedTables: [{ rows: [['N1', 'N2'], ['N3', 'N4']] }] },
            { text: 'Cell C2' },
          ],
          [{ text: '', rowSpan: 0 }, { text: 'Cell B3' }, { text: 'Cell C3' }],
        ],
      };
      const pdf = await generatePdfFromDocx([], [tbl], {}, 'Table Span Check');
      expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(500);
    });
  });

  describe('F-22 CAD DXF contiguous GroupTable parser & expansion bounds', () => {
    it('parses closed LWPOLYLINE with bulge, skips frozen layers, and enforces block expansion limits', () => {
      const dxf = [
        '0', 'SECTION', '2', 'TABLES',
        '0', 'TABLE', '2', 'LAYER',
        '0', 'LAYER', '2', 'HIDDEN_LAYER', '70', '1', '62', '7',
        '0', 'ENDTAB',
        '0', 'ENDSEC',
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'LWPOLYLINE', '8', '0', '70', '1',
        '10', '0', '20', '0', '42', '1',
        '10', '10', '20', '0',
        '10', '10', '20', '10',
        '0', 'LINE', '8', 'HIDDEN_LAYER', '10', '0', '20', '0', '11', '999', '21', '999',
        '0', 'ENDSEC', '0', 'EOF',
      ].join('\n');

      const drawing = parseDxfDrawing(dxf);
      expect(drawing.strokes).toHaveLength(1);
      expect(drawing.strokes[0].kind).toBe('poly');
      expect(drawing.extents.maxX).toBeLessThan(100);

      // Self-referencing block insertion cycle must fail closed with CadExpansionLimitError
      const cycleDxf = [
        '0', 'SECTION', '2', 'BLOCKS',
        '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
        '0', 'INSERT', '2', 'B2', '10', '0', '20', '0',
        '0', 'ENDBLK',
        '0', 'BLOCK', '2', 'B2', '10', '0', '20', '0',
        '0', 'INSERT', '2', 'B1', '10', '0', '20', '0',
        '0', 'ENDBLK',
        '0', 'ENDSEC',
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'INSERT', '2', 'B1', '10', '0', '20', '0',
        '0', 'ENDSEC', '0', 'EOF',
      ].join('\n');
      expect(() => parseDxfDrawing(cycleDxf)).toThrow(CadExpansionLimitError);
    });
  });

  describe('F-23, F-24, 5.5, 6.2 PDF layout/tokens/document/filters, vector metafiles, and Sauvola', () => {
    it('detects lattice tables with fragmented rule spans and colSpan cells', () => {
      // 2 rows x 2 cols grid (x = 0, 100, 200; y = 0, 30, 60), omitting interior top vertical segment (x=100, y=0..30) => row 0 spans 2 cols
      const rules = [
        { x0: 0, y0: 0, x1: 110, y1: 0, thickness: 1 },
        { x0: 95, y0: 0, x1: 200, y1: 0, thickness: 1 },
        { x0: 0, y0: 30, x1: 200, y1: 30, thickness: 1 },
        { x0: 0, y0: 60, x1: 200, y1: 60, thickness: 1 },
        { x0: 0, y0: 0, x1: 0, y1: 60, thickness: 1 },
        { x0: 100, y0: 30, x1: 100, y1: 60, thickness: 1 },
        { x0: 200, y0: 0, x1: 200, y1: 60, thickness: 1 },
      ];
      const item = (text: string, x: number, baseline: number) => ({
        text,
        x,
        baseline,
        width: 24,
        size: 10,
        font: 0,
        rtl: false,
        angled: false,
        vertical: false,
      });
      const fonts = [{ name: 'Helvetica', bold: false, italic: false, monospace: false, serif: false }];
      const items = [item('Title', 40, 20), item('A', 20, 50), item('B', 120, 50)];
      const res = detectLatticeTables(rules, items, fonts, new LayoutBudget(1), 1);
      expect(res.tables).toHaveLength(1);
      expect(res.tables[0].rows.some((r) => r.some((c) => c.colSpan === 2))).toBe(true);
    });

    it('classifies PDF content tokens through the 256-entry LUT while skipping comments, strings, names, and inline images', () => {
      const stream = 'q 1 0 0 1 10 20 cm % comment with fake Tj\nBT /F1 12 Tf (nested (paren\\)) fake ET) Tj <48656C6C6F> Tj BI /W 1 /H 1 ID \x00\xff EI ET Q';
      const tokens: string[] = [];
      forEachContentToken(stream, (tok) => {
        tokens.push(tok);
      });
      expect(tokens).toEqual(['q', '1', '0', '0', '1', '10', '20', 'cm', 'BT', '12', 'Tf', 'Tj', 'Tj', 'BI', '1', '1', 'ID', 'ET', 'Q']);
    });

    it('exposes superseded first/last PDF object readings without rescanning when xref is absent', () => {
      const pdfText =
        '%PDF-1.4\n' +
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
        '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n' +
        '4 0 obj << /Length 5 0 R >>\nstream\nBT (First) Tj ET\nendstream\nendobj\n' +
        '5 0 obj 16 endobj\n' +
        '4 0 obj << /Length 17 >>\nstream\nBT (Second) Tj ET\nendstream\nendobj\n' +
        'trailer << /Root 1 0 R >>\n%%EOF\n';
      const doc = new PdfDocument(Buffer.from(pdfText, 'latin1'), new InflateBudget(), false);
      const others = doc.otherReadings();
      expect(others).toHaveLength(1);
    });

    it('reverses PNG Sub/Up/Average/Paeth and 8/16-bit TIFF predictors and rejects invalid filter bytes', () => {
      // 2 pixels per row, 3 bytes/pixel (rowBytes = 6), 5 rows exercising filters 0, 1, 2, 3, 4
      const r0 = [10, 20, 30, 40, 50, 60];
      const r1 = [15, 25, 35, 55, 75, 95]; // Sub from r1: [15,25,35, 40,50,60]
      const r2 = [20, 30, 40, 60, 80, 100]; // Up from r1: [5,5,5, 5,5,5]
      const r3 = [24, 34, 44, 70, 90, 110]; // Average: i<3 pred=floor(r2[i]/2)=[10,15,20], diff=[14,19,24]; i>=3 pred=floor((r3[i-3]+r2[i])/2)=[42,57,72], diff=[28,33,38]
      const r4 = [24, 34, 44, 72, 92, 112]; // Paeth: i<3 diff=[0,0,0]; i>=3 paeth([24,34,44],[70,90,110],[20,30,40])=[70,90,110], diff=[2,2,2]
      const pngEncoded = Buffer.from([
        0, ...r0,
        1, 15, 25, 35, 40, 50, 60,
        2, 5, 5, 5, 5, 5, 5,
        3, 14, 19, 24, 28, 33, 38,
        4, 0, 0, 0, 2, 2, 2,
      ]);
      const pngDecoded = undoPredictor(pngEncoded, { predictor: 15, colors: 3, bitsPerComponent: 8, columns: 2 }, 'test');
      expect(Array.from(pngDecoded)).toEqual([...r0, ...r1, ...r2, ...r3, ...r4]);

      // 16-bit TIFF predictor 2: 2 pixels, 1 channel (4 bytes/row): pixel0 = 0x1234, pixel1 delta = 0x0102 -> pixel1 = 0x1336
      const tiff16 = Buffer.from([0x12, 0x34, 0x01, 0x02]);
      const tiffOut = undoPredictor(tiff16, { predictor: PREDICTOR_TIFF, colors: 1, bitsPerComponent: 16, columns: 2 }, 'tiff');
      expect(Array.from(tiffOut)).toEqual([0x12, 0x34, 0x13, 0x36]);

      expect(() =>
        undoPredictor(Buffer.from([9, 1, 2, 3]), { predictor: 12, colors: 3, bitsPerComponent: 8, columns: 1 }, 'bad')
      ).toThrow(CorruptStreamError);
    });

    it('encodes multi-ring SVG paths and thousands of strokes into valid EMF and WMF records without stack spread overflow', () => {
      const lines: string[] = [];
      for (let i = 0; i < 1500; i++) {
        const y = (i % 100) + 1;
        lines.push(`<line x1="1" y1="${y}" x2="99" y2="${y}" stroke="#112233" stroke-width="1"/>`);
      }
      // Compound multi-ring path to exercise EMR_POLYPOLYGON16 and META_POLYPOLYGON ring-point writing
      lines.push('<path d="M10 10 L90 10 L90 90 L10 90 Z M30 30 L30 70 L70 70 L70 30 Z" fill="#445566" fill-rule="evenodd"/>');
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${lines.join('')}</svg>`, 'utf8');

      const emf = encodeEmf(svg);
      expect(emf.readUInt32LE(0)).toBe(1); // EMR_HEADER
      expect(emf.readUInt32LE(40)).toBe(0x464d4520); // ' EMF'
      expect(emf.readUInt32LE(48)).toBe(emf.length);

      const wmf = encodeWmf(svg);
      expect(wmf.readUInt32LE(0)).toBe(0x9ac6cdd7); // Aldus placeable key
      let xor = 0;
      for (let off = 0; off < 20; off += 2) xor ^= wmf.readUInt16LE(off);
      expect(wmf.readUInt16LE(20)).toBe(xor);
    });

    it('matches exact clipped window statistics on narrow and wide images in sauvolaBinarize and enforces pixel cap', async () => {
      const checkOracle = async (width: number, height: number, windowSize: number) => {
        const gray = new Uint8Array(width * height);
        for (let i = 0; i < gray.length; i++) gray[i] = (i * 53 + (i >> 3) * 19) & 0xff;
        const actual = await sauvolaBinarize(gray, width, height, { windowSize, yieldEveryPixels: 257 });
        const half = (oddWindow(windowSize) - 1) >> 1;
        for (let y = 0; y < height; y++) {
          const y0 = Math.max(0, y - half);
          const y1 = Math.min(height, y + half + 1);
          for (let x = 0; x < width; x++) {
            const x0 = Math.max(0, x - half);
            const x1 = Math.min(width, x + half + 1);
            let sum = 0;
            let sq = 0;
            const n = (y1 - y0) * (x1 - x0);
            for (let yy = y0; yy < y1; yy++) {
              for (let xx = x0; xx < x1; xx++) {
                const v = gray[yy * width + xx];
                sum += v;
                sq += v * v;
              }
            }
            const mean = sum / n;
            const variance = sq / n - mean * mean;
            const std = variance > 0 ? Math.sqrt(variance) : 0;
            const threshold = mean * (1 + 0.34 * (std / 128 - 1));
            const exp = gray[y * width + x] <= threshold ? SAUVOLA_INK : SAUVOLA_PAPER;
            expect(actual[y * width + x]).toBe(exp);
          }
        }
      };

      await checkOracle(7, 9, 15); // narrow: width <= 2 * half
      await checkOracle(43, 29, 11); // wide: left border + interior + right border
      await expect(sauvolaBinarize(new Uint8Array(1), SAUVOLA_MAX_PIXELS + 1, 1, { windowSize: 15 })).rejects.toThrow(
        OcrPreprocessError
      );
    });
  });
});
