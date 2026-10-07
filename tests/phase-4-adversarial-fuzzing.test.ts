import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import {
  parseHwpxDocument,
  isHwpxContainer,
  buildHwpxContainer,
} from '../src/lib/conversions/hwpx';
import {
  decodeParquet,
  encodeParquet,
  CompactProtocolReader,
  ParquetFormatError,
} from '../src/lib/conversions/parquet';
import { decodeAudioBuffer } from '../src/lib/conversions/media-decoder';
import {
  decompressZstd,
  compressZstd,
  parseZstdFrameHeader,
} from '../src/lib/conversions/zstd';
import {
  inspectVariableFont,
  instantiateVariableFont,
  parseFvarTable,
  parseStatTable,
} from '../src/lib/conversions/font';
import {
  parseCfbf,
  parseHwpDocument,
  parseHwpRecords,
  isCfbfContainer,
} from '../src/lib/conversions/hwp';
import { synthesizeVariableFontCorpus } from './helpers/corpus-synthesizer';
import { ConversionFailedError, CorruptStreamError, DataParseError } from '../src/lib/types';
import { buildRleBombFrame } from './helpers/zstd-frames';
import { expectNoHang, settle } from './helpers/timing';

// ============================================================================
// Adversarial Mutator Primitives
// ============================================================================

/** Small deterministic generator (mulberry32) so every fuzz run, and any failure, replays from its seed. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutateBitFlip(buf: Buffer, random: () => number, count = 5): Buffer {
  const mutated = Buffer.from(buf);
  for (let i = 0; i < count; i++) {
    const byteIdx = Math.floor(random() * mutated.length);
    const bitIdx = Math.floor(random() * 8);
    mutated[byteIdx] ^= 1 << bitIdx;
  }
  return mutated;
}

const sha256Hex = (data: Buffer | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Fuzz iterations of the Zstandard bit-flip test; every one must end in a typed error or the original bytes. */
const ZSTD_FUZZ_ITERATIONS = 25;
const ZSTD_FUZZ_FLIPS_PER_ITERATION = 3;
/** Parser fuzz rounds over a 256-byte seed buffer. */
const PARSER_FUZZ_ROUNDS = 100;
const PARSER_FUZZ_SEED_BYTES = 256;
const PARSER_FUZZ_FLIPS = 4;
/** A 12-bit size field of 0xfff means the real size follows as a 32-bit word (HWP 5.0 record header). */
const HWP_EXTENDED_SIZE_MARKER = 0xfff;
const HWP_ABSURD_RECORD_SIZE = 0x7fffffff;

function mutateTruncate(buf: Buffer, fraction = 0.5): Buffer {
  const targetLen = Math.max(1, Math.floor(buf.length * fraction));
  return buf.subarray(0, targetLen);
}

function mutateByteBursts(buf: Buffer, offset: number, count: number, byteVal = 0xff): Buffer {
  const mutated = Buffer.from(buf);
  const end = Math.min(mutated.length, offset + count);
  for (let i = offset; i < end; i++) {
    mutated[i] = byteVal;
  }
  return mutated;
}

describe('Phase 4: Coverage-Guided Adversarial Parser Fuzzing Suite', () => {
  // =========================================================================
  // 1. HWPX OPC Archives Adversarial Fuzzing
  // =========================================================================
  describe('1. HWPX OPC Archives Adversarial Fuzzing', () => {
    it('fails closed when zip archive contains hostile Zip-Slip paths', async () => {
      const zip = new JSZip();
      zip.file('mimetype', 'application/hwp+zip');
      // Hostile Zip-Slip path attempting traversal
      zip.file('../../../../etc/passwd', 'root:x:0:0:root:/root:/bin/bash');
      zip.file('Contents/section0.xml', '<hp:sec><hp:p><hp:run><hp:t>Safe Text</hp:t></hp:run></hp:p></hp:sec>');
      const hostileZip = await zip.generateAsync({ type: 'nodebuffer' });

      // The package is read in memory by entry name: the traversal entry is never opened as a section or
      // metadata part, so the document is exactly what the one real section holds.
      const doc = await parseHwpxDocument(hostileZip);
      expect(doc.paragraphs.map((p) => p.text)).toEqual(['Safe Text']);
      expect(doc.tables).toEqual([]);
      expect(JSON.stringify(doc)).not.toContain('root:x:0:0');
    });

    it('fails closed on truncated ZIP archives before central directory', async () => {
      const validHwpx = await buildHwpxContainer({
        paragraphs: ['Test paragraph in HWPX'],
      });
      const truncated = mutateTruncate(validHwpx, 0.4);

      const failure = await parseHwpxDocument(truncated).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toMatch(/^Invalid HWPX package: Not a valid ZIP archive/);
    });

    it('fails closed on malformed XML in Contents/section0.xml without parser crash', async () => {
      const zip = new JSZip();
      zip.file('mimetype', 'application/hwp+zip');
      zip.file('Contents/section0.xml', '<<<malformed unclosed << << xml ??? & not escaped');
      const malformedZip = await zip.generateAsync({ type: 'nodebuffer' });

      // A section that is not well-formed XML is refused, not read as an empty document.
      const failure = await parseHwpxDocument(malformedZip).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(DataParseError);
      expect((failure as Error).message).toMatch(/Invalid HWPX package: Contents\/section0\.xml is not well-formed XML/);
    });

    it('fails closed on completely random non-ZIP garbage buffers', async () => {
      const garbage = Buffer.from('DEADBEEF_RANDOM_CORRUPTED_STREAM_BYTES_NOT_ZIP');
      const isContainer = await isHwpxContainer(garbage);
      expect(isContainer).toBe(false);

      const failure = await parseHwpxDocument(garbage).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(CorruptStreamError);
      expect((failure as Error).message).toMatch(/Invalid HWPX package/i);
    });
  });

  // =========================================================================
  // 2. Apache Parquet Thrift Headers & Columnar Bitstreams
  // =========================================================================
  describe('2. Apache Parquet Thrift Headers & Columnar Bitstreams', () => {
    it('fails closed on invalid magic bytes at file head or tail', () => {
      const validParquet = encodeParquet([{ a: 1, b: 'hello' }]);

      // Corrupt head magic
      const badHead = Buffer.from(validParquet);
      badHead.write('PAR9', 0, 'ascii');
      expect(() => decodeParquet(badHead)).toThrow(/Invalid Parquet file/i);

      // Corrupt tail magic
      const badTail = Buffer.from(validParquet);
      badTail.write('NOPE', badTail.length - 4, 'ascii');
      expect(() => decodeParquet(badTail)).toThrow(/Invalid Parquet file/i);
    });

    it('fails closed when footer length claims massive offset beyond file bounds', () => {
      const validParquet = encodeParquet([{ a: 1 }]);
      const hostileParquet = Buffer.from(validParquet);
      // Write absurd footer length: 0x7FFFFFFF (2GB) at length - 8
      hostileParquet.writeUInt32LE(0x7fffffff, hostileParquet.length - 8);

      expect(() => decodeParquet(hostileParquet)).toThrow(ParquetFormatError);
      expect(() => decodeParquet(hostileParquet)).toThrow(/Corrupted Parquet metadata: metadata offset -?\d+ overlaps magic header/);
    });

    it('fails closed when string byte length in PLAIN page exceeds available buffer', () => {
      const validParquet = encodeParquet([{ text: 'short string' }]);
      // Mutate data page: inject 4GB string length marker
      const hostile = Buffer.from(validParquet);
      // Search for length prefix of 'short string' (12 bytes: 0x0c 0x00 0x00 0x00)
      for (let i = 4; i < hostile.length - 20; i++) {
        if (hostile.readUInt32LE(i) === 12) {
          hostile.writeUInt32LE(0x7fffffff, i); // Malicious length
          break;
        }
      }

      expect(() => decodeParquet(hostile)).toThrow(ParquetFormatError);
      expect(() => decodeParquet(hostile)).toThrow(/string length 2147483647 exceeds page bounds in column 'text'/);
    });

    it('fails closed across progressive truncation intervals (10%, 25%, 50%, 75%)', () => {
      const validParquet = encodeParquet([
        { id: 101, name: 'Alice', score: 99.4, active: true },
        { id: 102, name: 'Bob', score: 88.2, active: false },
      ]);

      // The untouched file reads back exactly, so the refusals below come from the cut and not from the reader.
      expect(decodeParquet(validParquet)).toEqual([
        { id: 101, name: 'Alice', score: 99.4, active: true },
        { id: 102, name: 'Bob', score: 88.2, active: false },
      ]);

      const fractions = [0.1, 0.25, 0.5, 0.75];
      for (const frac of fractions) {
        const truncated = mutateTruncate(validParquet, frac);
        expect(() => decodeParquet(truncated), `cut to ${frac}`).toThrow(ParquetFormatError);
        expect(() => decodeParquet(truncated), `cut to ${frac}`).toThrow(/Invalid Parquet file: magic header='PAR1', magic footer=/);
      }
    });

    it('fails closed on Thrift varint continuation bomb (200 consecutive 0x80 bytes)', () => {
      const bomb = Buffer.alloc(200, 0x80);
      const reader = new CompactProtocolReader(bomb, 0);
      expect(() => reader.readVarint()).toThrow(/varint exceeds 10 bytes/i);
    });

    it('fails closed on Thrift list allocation bomb (claiming 100,000,000 items in small payload)', () => {
      // 0xf0 = size >= 15 | list type 0. Followed by varint 100,000,000 (0xc0, 0x94, 0xa3, 0x2f)
      const listBomb = Buffer.from([0xf0, 0xc0, 0x94, 0xa3, 0x2f, 0x00, 0x00]);
      const reader = new CompactProtocolReader(listBomb, 0);
      expect(() => reader.readListBegin()).toThrow(/exceeds remaining buffer bytes/i);
    });

    it('fails closed when footer length is 0 or overlaps magic header', () => {
      const validParquet = encodeParquet([{ a: 1 }]);

      // Footer length = 0
      const zeroLen = Buffer.from(validParquet);
      zeroLen.writeUInt32LE(0, zeroLen.length - 8);
      expect(() => decodeParquet(zeroLen)).toThrow(/invalid footer length 0/i);

      // Footer length causing overlap with 'PAR1' header (offset < 4)
      const overlap = Buffer.from(validParquet);
      overlap.writeUInt32LE(overlap.length - 8, overlap.length - 8); // metaOffset = 0 < 4
      expect(() => decodeParquet(overlap)).toThrow(/overlaps magic header/i);
    });
  });

  // =========================================================================
  // 3. Zstandard Frame Descriptors & Stream Decompressor (RFC 8878)
  // =========================================================================
  describe('3. Zstandard Frame Descriptors & Stream Decompressor (RFC 8878)', () => {
    it('fails closed on invalid Zstandard magic numbers', () => {
      const badMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfc, 0x00, 0x00]); // Off by 1
      expect(() => decompressZstd(badMagic)).toThrow(/Invalid Zstandard magic/i);
      expect(() => parseZstdFrameHeader(badMagic, 0)).toThrow(/Invalid Zstandard magic/i);
    });

    it('fails closed on truncated frame before block header', () => {
      const data = Buffer.from('Testing Zstandard frame header validation');
      const validZstd = compressZstd(data);
      const truncated = validZstd.subarray(0, 4); // Only magic number

      expect(() => decompressZstd(truncated)).toThrow(ConversionFailedError);
      expect(() => decompressZstd(truncated)).toThrow(/Malformed Zstandard frame: header truncated/);
    });

    it('enforces archive bomb safeguards for suspicious compression ratios (>100:1) beyond the floor', () => {
      // 300 RLE blocks of 128 KiB: 37.5 MiB from ~1.2 KB
      const bomb = buildRleBombFrame(300);
      expect(bomb.length * 100).toBeLessThan(300 * 128 * 1024);
      expect(() => decompressZstd(bomb)).toThrow(/Archive bomb detected/i);
    });

    it('ends every bit-flip fuzz iteration in a typed error or the original bytes, never in different bytes', () => {
      const original = Buffer.from('Robustness fuzzing against corrupted Zstandard bitstreams in pure TypeScript');
      const validZstd = compressZstd(original);
      const originalDigest = sha256Hex(original);
      expect(sha256Hex(decompressZstd(validZstd))).toBe(originalDigest);

      let typedErrors = 0;
      let identicalOutputs = 0;
      const silentCorruptions: number[] = [];

      for (let seed = 1; seed <= ZSTD_FUZZ_ITERATIONS; seed++) {
        const corrupted = mutateBitFlip(validZstd, seededRandom(seed), ZSTD_FUZZ_FLIPS_PER_ITERATION);
        try {
          const output = decompressZstd(corrupted);
          if (sha256Hex(output) === originalDigest) identicalOutputs++;
          else silentCorruptions.push(seed);
        } catch (err) {
          expect(err, `seed ${seed}`).toBeInstanceOf(ConversionFailedError);
          typedErrors++;
        }
      }

      // The frame carries a content checksum, so a flipped bit cannot decode to other bytes: all 25 outcomes
      // are accounted for, none of them as silently different output.
      expect(silentCorruptions).toEqual([]);
      expect(typedErrors + identicalOutputs).toBe(ZSTD_FUZZ_ITERATIONS);
      expect(typedErrors).toBeGreaterThanOrEqual(ZSTD_FUZZ_ITERATIONS - 1);
    });

    it('handles large window descriptor exponents (>= 21) without 32-bit bitwise integer overflow or negative window size', () => {
      // Magic (4 bytes) + Frame Header Descriptor (1 byte: singleSegment=0, dictId=0)
      // + Window Descriptor byte: exponent = 21, mantissa = 0. (21 << 3) = 168 (0xA8)
      const frameWithLargeWindow = Buffer.from([
        0x28, 0xb5, 0x2f, 0xfd, // Magic
        0x00,                   // FHD: singleSegment = 0, fcsFlag = 0
        0xa8,                   // WD: exponent = 21, mantissa = 0
      ]);

      const header = parseZstdFrameHeader(frameWithLargeWindow, 0);
      expect(header.windowSize).toBeGreaterThan(0);
      expect(header.windowSize).toBe(2147483648); // 2GB, strictly positive without signed overflow
    });
  });

  // =========================================================================
  // 4. SFNT fvar & STAT Variable Font Tables
  // =========================================================================
  describe('4. SFNT fvar & STAT Variable Font Tables', () => {
    it('reads an fvar with zero axes as an empty axis list and refuses one cut short', () => {
      // fvar header: majorVersion(2), minorVersion(2), axesOffset(2), reserved(2), axisCount(2), axisSize(2)
      const emptyFvar = Buffer.alloc(16);
      emptyFvar.writeUInt16BE(1, 0); // majorVersion 1
      emptyFvar.writeUInt16BE(0, 2); // minorVersion 0
      emptyFvar.writeUInt16BE(16, 4); // axesOffset
      emptyFvar.writeUInt16BE(2, 6); // reserved
      emptyFvar.writeUInt16BE(0, 8); // axisCount = 0
      emptyFvar.writeUInt16BE(20, 10); // axisSize = 20

      expect(parseFvarTable(emptyFvar)).toEqual({ axes: [], instances: [] });
      expect(() => parseFvarTable(emptyFvar.subarray(0, 8))).toThrow(ConversionFailedError);
      expect(() => parseFvarTable(emptyFvar.subarray(0, 8))).toThrow(/truncated header \(less than 16 bytes\)/);
    });

    it('fails closed when fvar axis count claims more axes than buffer contains', () => {
      const hostileFvar = Buffer.alloc(24);
      hostileFvar.writeUInt16BE(1, 0);
      hostileFvar.writeUInt16BE(0, 2);
      hostileFvar.writeUInt16BE(16, 4);
      hostileFvar.writeUInt16BE(2, 6);
      hostileFvar.writeUInt16BE(500, 8); // Claiming 500 axes in 24 bytes!
      hostileFvar.writeUInt16BE(20, 10);

      // Must fail closed with handled Error without unhandled exception or crash
      expect(() => parseFvarTable(hostileFvar)).toThrow(ConversionFailedError);
      expect(() => parseFvarTable(hostileFvar)).toThrow(/Invalid fvar table: truncated axis record 0 of 500/i);
    });

    it('fails closed when STAT table claims out-of-bounds design axis count', () => {
      const hostileStat = Buffer.alloc(20);
      hostileStat.writeUInt16BE(1, 0); // majorVersion 1
      hostileStat.writeUInt16BE(2, 2); // minorVersion 2
      hostileStat.writeUInt16BE(8, 4); // designAxisSize = 8
      hostileStat.writeUInt16BE(1000, 6); // Claiming 1000 design axes!
      hostileStat.writeUInt32BE(20, 8); // offset

      expect(() => parseStatTable(hostileStat)).toThrow(ConversionFailedError);
      expect(() => parseStatTable(hostileStat)).toThrow(/Invalid STAT table: design axis record 0 of 1000 lies outside the table/);
    });

    it('fails closed when font buffer has truncated table directory', () => {
      const truncatedFont = Buffer.alloc(24);
      truncatedFont.writeUInt32BE(0x00010000, 0); // TrueType
      truncatedFont.writeUInt16BE(10, 4); // numTables = 10 (needs 12 + 10*16 = 172 bytes)

      // Fail closed: a directory that does not fit is rejected instead of read as a font without tables.
      expect(() => inspectVariableFont(truncatedFont)).toThrow(ConversionFailedError);
      expect(() => inspectVariableFont(truncatedFont)).toThrow(/directory of 10 tables is cut short/);
    });

    it('fails closed when fvar axisSize is less than minimum 20 bytes', () => {
      const hostileFvar = Buffer.alloc(32);
      hostileFvar.writeUInt16BE(1, 0);
      hostileFvar.writeUInt16BE(0, 2);
      hostileFvar.writeUInt16BE(16, 4);
      hostileFvar.writeUInt16BE(2, 6);
      hostileFvar.writeUInt16BE(1, 8); // 1 axis
      hostileFvar.writeUInt16BE(4, 10); // Malicious axisSize = 4 (needs >= 20)

      expect(() => parseFvarTable(hostileFvar)).toThrow(/axisSize 4 is less than minimum 20 bytes/i);
    });

    it('fails closed when fvar instanceSize is less than coordinates footprint', () => {
      const hostileFvar = Buffer.alloc(64);
      hostileFvar.writeUInt16BE(1, 0);
      hostileFvar.writeUInt16BE(0, 2);
      hostileFvar.writeUInt16BE(16, 4);
      hostileFvar.writeUInt16BE(2, 6);
      hostileFvar.writeUInt16BE(1, 8); // 1 axis
      hostileFvar.writeUInt16BE(20, 10); // axisSize = 20
      hostileFvar.writeUInt16BE(1, 12); // 1 instance
      hostileFvar.writeUInt16BE(2, 14); // Malicious instanceSize = 2 (needs >= 8)

      // Mock 1 valid axis
      hostileFvar.write('wght', 16, 4, 'ascii');

      expect(() => parseFvarTable(hostileFvar)).toThrow(/instanceSize 2 is less than minimum required 8 bytes/i);
    });

    it('refuses NaN or infinite coordinates in instantiateVariableFont instead of pinning a default', () => {
      const fontCorpus = synthesizeVariableFontCorpus();

      expect(() => instantiateVariableFont(fontCorpus.fontBuffer, { wght: NaN })).toThrow(ConversionFailedError);
      expect(() => instantiateVariableFont(fontCorpus.fontBuffer, { wght: NaN })).toThrow(
        /Variation coordinate for axis 'wght' must be a finite number, got NaN/
      );
      expect(() => instantiateVariableFont(fontCorpus.fontBuffer, { wdth: Infinity })).toThrow(
        /Variation coordinate for axis 'wdth' must be a finite number, got Infinity/
      );
    });

    it('pins a finite coordinate and clamps it to the axis range', () => {
      const fontCorpus = synthesizeVariableFontCorpus();
      const axisDefaults = (coordinates: Record<string, number>) => {
        const meta = inspectVariableFont(instantiateVariableFont(fontCorpus.fontBuffer, coordinates));
        return Object.fromEntries(meta.axes.map((axis) => [axis.tag, axis.defaultValue]));
      };

      // The corpus font declares wght 100..900 (default 400) and wdth 50..150 (default 100).
      expect(axisDefaults({ wght: 700 })).toMatchObject({ wght: 700, wdth: 100 });
      expect(axisDefaults({ wght: 5000, wdth: 1 })).toMatchObject({ wght: 900, wdth: 50 });
    });
  });

  // =========================================================================
  // 5. HWP 5.0 OLE / CFBF Containers
  // =========================================================================
  describe('5. HWP 5.0 OLE / CFBF Containers', () => {
    it('fails closed when OLE2 compound file magic bytes are invalid', () => {
      const invalidMagic = Buffer.alloc(512);
      invalidMagic.write('NOT_AN_OLE_FILE', 0, 'ascii');

      expect(() => parseCfbf(invalidMagic)).toThrow(CorruptStreamError);
      expect(() => parseCfbf(invalidMagic)).toThrow(/Invalid CFBF container/i);
      expect(isCfbfContainer(invalidMagic)).toBe(false);
    });

    it('fails closed on cyclic sector allocation table (SAT) loops without infinite loop', async () => {
      const cyclicOle = Buffer.alloc(1536);
      // Valid CFBF magic: 0xD0CF11E0A1B11AE1
      cyclicOle[0] = 0xd0;
      cyclicOle[1] = 0xcf;
      cyclicOle[2] = 0x11;
      cyclicOle[3] = 0xe0;
      cyclicOle[4] = 0xa1;
      cyclicOle[5] = 0xb1;
      cyclicOle[6] = 0x1a;
      cyclicOle[7] = 0xe1;

      cyclicOle.writeUInt16BE(0xfffe, 28); // Byte order FE FF
      cyclicOle.writeUInt16LE(9, 30); // Sector shift 9 (512 bytes)
      cyclicOle.writeUInt16LE(6, 32); // Mini sector shift 6 (64 bytes)
      cyclicOle.writeUInt32LE(1, 44); // 1 SAT sector
      cyclicOle.writeUInt32LE(0, 48); // Dir stream at sector 0
      cyclicOle.writeUInt32LE(0, 76); // MSAT[0] at sector 0

      // In SAT table at sector 0 (byte offset 512):
      // Sector 0 points to sector 1, sector 1 points back to sector 0 (infinite cycle)
      cyclicOle.writeUInt32LE(1, 512);
      cyclicOle.writeUInt32LE(0, 512 + 4);

      // The walk ends at the first repeated sector and the container is refused.
      const outcome = await expectNoHang('cyclic SAT', () => settle(() => parseCfbf(cyclicOle)));
      expect(outcome.ok).toBe(false);
      const error = (outcome as { ok: false; error: unknown }).error;
      expect(error).toBeInstanceOf(CorruptStreamError);
      expect((error as Error).message).toMatch(/Corrupt CFBF container: the sector chain starting at sector 0 returns to sector 0/);
    });

    it('fails closed on record headers with negative or absurd payload lengths in parseHwpRecords', () => {
      const corruptedRecord = Buffer.alloc(20);
      // HWP record header format: (tagId: 10 bits) | (level: 10 bits) | (size: 12 bits)
      // If size is 0xFFF (4095), it reads extended 32-bit size
      const headerVal = 0x01 | (0 << 10) | (HWP_EXTENDED_SIZE_MARKER << 20);
      corruptedRecord.writeUInt32LE(headerVal >>> 0, 0);
      corruptedRecord.writeUInt32LE(HWP_ABSURD_RECORD_SIZE, 4); // Extended size: 2GB payload in a 20-byte stream

      expect(() => parseHwpRecords(corruptedRecord)).toThrow(CorruptStreamError);
      expect(() => parseHwpRecords(corruptedRecord)).toThrow(
        /Corrupt HWP record: tag 1 declares 2147483647 payload bytes but only 12 remain/
      );
    });
  });

  // =========================================================================
  // 6. Anti-Hang & Strict Millisecond Execution Oracle
  // =========================================================================
  describe('6. Parser robustness over seeded random mutations', () => {
    it('answers 100 random bitstream mutations with a typed error from every parser, within the hang guard', async () => {
      const seedBuffer = Buffer.alloc(PARSER_FUZZ_SEED_BYTES);
      for (let i = 0; i < seedBuffer.length; i++) {
        seedBuffer[i] = (i * 37) % 256;
      }

      const outcomes = await expectNoHang('parser fuzz rounds', () => {
        const typed: Record<string, number> = { parquet: 0, zstd: 0, cfbf: 0 };
        const untyped: string[] = [];
        for (let seed = 1; seed <= PARSER_FUZZ_ROUNDS; seed++) {
          const mutated = mutateBitFlip(seedBuffer, seededRandom(seed), PARSER_FUZZ_FLIPS);
          const parsers: Array<[string, () => unknown, new (...args: never[]) => Error]> = [
            ['parquet', () => decodeParquet(mutated), ParquetFormatError],
            ['zstd', () => decompressZstd(mutated), ConversionFailedError],
            ['cfbf', () => parseCfbf(mutated), CorruptStreamError],
          ];
          for (const [name, run, expectedType] of parsers) {
            const result = settle(run);
            if (result.ok) untyped.push(`${name} accepted seed ${seed}`);
            else if (result.error instanceof expectedType) typed[name]++;
            else untyped.push(`${name} seed ${seed}: ${String(result.error)}`);
          }
        }
        return { typed, untyped };
      });

      // The seed bytes are not a Parquet, Zstandard or CFBF file, so each parser must refuse every mutation with
      // its own typed error; a TypeError or RangeError from a read past the buffer would be listed here.
      expect(outcomes.untyped).toEqual([]);
      expect(outcomes.typed).toEqual({ parquet: PARSER_FUZZ_ROUNDS, zstd: PARSER_FUZZ_ROUNDS, cfbf: PARSER_FUZZ_ROUNDS });
    });
  });

  // =========================================================================
  // 7. Audio Bitstream Adversarial Fuzzing
  // =========================================================================
  describe('7. Audio Bitstream Adversarial Fuzzing', () => {
    const REFUSAL = /^Unsupported audio format: decoder unavailable$/;

    it('decodes a well-formed WAV, so the refusals below are about the input', () => {
      const SAMPLE_RATE = 8000;
      const samples = [0, 1000, -1000, 32767];
      const data = Buffer.alloc(samples.length * 2);
      samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
      const fmt = Buffer.alloc(16);
      fmt.writeUInt16LE(1, 0); // PCM
      fmt.writeUInt16LE(1, 2); // mono
      fmt.writeUInt32LE(SAMPLE_RATE, 4);
      fmt.writeUInt32LE(SAMPLE_RATE * 2, 8);
      fmt.writeUInt16LE(2, 12);
      fmt.writeUInt16LE(16, 14);
      const chunk = (id: string, body: Buffer) => {
        const header = Buffer.alloc(8);
        header.write(id, 0, 'ascii');
        header.writeUInt32LE(body.length, 4);
        return Buffer.concat([header, body]);
      };
      const wav = chunk('RIFF', Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', data)]));

      const decoded = decodeAudioBuffer(wav, 'wav');
      expect([...decoded.samples]).toEqual(samples);
      expect(decoded.sampleRate).toBe(SAMPLE_RATE);
      expect(decoded.channels).toBe(1);
    });

    it('fails closed on truncated WAV bitstreams missing subchunk header', () => {
      const badWav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '); // Truncated mid fmt chunk
      expect(() => decodeAudioBuffer(badWav, 'wav')).toThrow(ConversionFailedError);
      expect(() => decodeAudioBuffer(badWav, 'wav')).toThrow(REFUSAL);
    });

    it('fails closed on corrupted FLAC stream with broken sync word or truncated header', () => {
      const badFlac = Buffer.from('fLaC\x80\x00\x00\x22TRUNCATED_STREAMINFO_LESS_THAN_34_BYTES');
      expect(() => decodeAudioBuffer(badFlac, 'flac')).toThrow(ConversionFailedError);
      expect(() => decodeAudioBuffer(badFlac, 'flac')).toThrow(REFUSAL);
    });

    it('fails closed on non-audio random noise bitstreams without unhandled crashes', () => {
      const noise = Buffer.from('RANDOM_NOISE_NON_AUDIO_BYTES_0123456789');
      for (const hint of ['wav', 'flac']) {
        expect(() => decodeAudioBuffer(noise, hint), hint).toThrow(ConversionFailedError);
        expect(() => decodeAudioBuffer(noise, hint), hint).toThrow(REFUSAL);
      }
    });
  });
});
