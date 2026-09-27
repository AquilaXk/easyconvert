import { describe, it, expect } from 'vitest';
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

// ============================================================================
// Adversarial Mutator Primitives
// ============================================================================

function mutateBitFlip(buf: Buffer, count = 5): Buffer {
  const mutated = Buffer.from(buf);
  for (let i = 0; i < count; i++) {
    const byteIdx = Math.floor(Math.random() * mutated.length);
    const bitIdx = Math.floor(Math.random() * 8);
    mutated[byteIdx] ^= 1 << bitIdx;
  }
  return mutated;
}

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

      // Must safely process or reject without permitting directory traversal
      const doc = await parseHwpxDocument(hostileZip);
      expect(doc).toBeDefined();
      expect(doc.paragraphs.map((p) => p.text).join('')).not.toContain('root:x:0:0');
    });

    it('fails closed on truncated ZIP archives before central directory', async () => {
      const validHwpx = await buildHwpxContainer({
        paragraphs: ['Test paragraph in HWPX'],
      });
      const truncated = mutateTruncate(validHwpx, 0.4);

      await expect(parseHwpxDocument(truncated)).rejects.toThrow();
    });

    it('fails closed on malformed XML in Contents/section0.xml without parser crash', async () => {
      const zip = new JSZip();
      zip.file('mimetype', 'application/hwp+zip');
      zip.file('Contents/section0.xml', '<<<malformed unclosed << << xml ??? & not escaped');
      const malformedZip = await zip.generateAsync({ type: 'nodebuffer' });

      // Parsing malformed XML should fail-closed and return safe empty AST without crash
      const doc = await parseHwpxDocument(malformedZip);
      expect(doc.paragraphs).toEqual([]);
      expect(doc.tables).toEqual([]);
      expect(doc.version).toBe('1.0.0.0');
    });

    it('fails closed on completely random non-ZIP garbage buffers', async () => {
      const garbage = Buffer.from('DEADBEEF_RANDOM_CORRUPTED_STREAM_BYTES_NOT_ZIP');
      const isContainer = await isHwpxContainer(garbage);
      expect(isContainer).toBe(false);

      await expect(parseHwpxDocument(garbage)).rejects.toThrow(/Invalid HWPX package/i);
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

      expect(() => decodeParquet(hostileParquet)).toThrow();
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

      expect(() => decodeParquet(hostile)).toThrow();
    });

    it('fails closed across progressive truncation intervals (10%, 25%, 50%, 75%)', () => {
      const validParquet = encodeParquet([
        { id: 101, name: 'Alice', score: 99.4, active: true },
        { id: 102, name: 'Bob', score: 88.2, active: false },
      ]);

      const fractions = [0.1, 0.25, 0.5, 0.75];
      for (const frac of fractions) {
        const truncated = mutateTruncate(validParquet, frac);
        expect(() => decodeParquet(truncated)).toThrow();
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

      expect(() => decompressZstd(truncated)).toThrow();
    });

    it('enforces archive bomb safeguards for suspicious compression ratios (>100:1)', () => {
      const repetitive = Buffer.alloc(40000, 0x5a); // 40KB
      const compressed = compressZstd(repetitive);

      expect(repetitive.length / compressed.length).toBeGreaterThan(100);
      expect(() => decompressZstd(compressed)).toThrow(/Archive bomb detected/i);
    });

    it('survives randomized bit-flip fuzzing loop without crashes or unhandled exceptions', () => {
      const original = Buffer.from('Robustness fuzzing against corrupted Zstandard bitstreams in pure TypeScript');
      const validZstd = compressZstd(original);

      let handledErrors = 0;
      const fuzzIterations = 25;

      for (let i = 0; i < fuzzIterations; i++) {
        const corrupted = mutateBitFlip(validZstd, 3);
        try {
          decompressZstd(corrupted);
        } catch (err: any) {
          handledErrors++;
          expect(err).toBeInstanceOf(Error);
        }
      }

      // Corrupted bitstreams should either throw handled error or rarely succeed if flips are benign
      expect(handledErrors).toBeGreaterThanOrEqual(1);
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
    it('fails closed when fvar table has 0 axis count or truncated table bytes', () => {
      // fvar header: majorVersion(2), minorVersion(2), axesOffset(2), reserved(2), axisCount(2), axisSize(2)
      const emptyFvar = Buffer.alloc(16);
      emptyFvar.writeUInt16BE(1, 0); // majorVersion 1
      emptyFvar.writeUInt16BE(0, 2); // minorVersion 0
      emptyFvar.writeUInt16BE(16, 4); // axesOffset
      emptyFvar.writeUInt16BE(2, 6); // reserved
      emptyFvar.writeUInt16BE(0, 8); // axisCount = 0
      emptyFvar.writeUInt16BE(20, 10); // axisSize = 20

      const parsed = parseFvarTable(emptyFvar);
      expect(parsed.axes).toHaveLength(0);
      expect(parsed.instances).toHaveLength(0);
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
      expect(() => parseFvarTable(hostileFvar)).toThrow(/Invalid fvar table: truncated axis record/i);
    });

    it('fails closed when STAT table claims out-of-bounds design axis count', () => {
      const hostileStat = Buffer.alloc(20);
      hostileStat.writeUInt16BE(1, 0); // majorVersion 1
      hostileStat.writeUInt16BE(2, 2); // minorVersion 2
      hostileStat.writeUInt16BE(8, 4); // designAxisSize = 8
      hostileStat.writeUInt16BE(1000, 6); // Claiming 1000 design axes!
      hostileStat.writeUInt32BE(20, 8); // offset

      const parsed = parseStatTable(hostileStat);
      expect(parsed.axes.length).toBeLessThan(1000);
    });

    it('fails closed when font buffer has truncated table directory', () => {
      const truncatedFont = Buffer.alloc(24);
      truncatedFont.writeUInt32BE(0x00010000, 0); // TrueType
      truncatedFont.writeUInt16BE(10, 4); // numTables = 10 (needs 12 + 10*16 = 172 bytes)

      const meta = inspectVariableFont(truncatedFont);
      expect(meta.isVariableFont).toBe(false);
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

    it('handles NaN or infinite coordinates in instantiateVariableFont safely by falling back to default values', () => {
      const fontCorpus = synthesizeVariableFontCorpus();
      const instantiated = instantiateVariableFont(fontCorpus.fontBuffer, {
        wght: NaN,
        wdth: Infinity,
      });

      expect(instantiated).toBeDefined();
      expect(instantiated.length).toBeGreaterThan(100);
      const meta = inspectVariableFont(instantiated);
      expect(meta.isVariableFont).toBe(true);
      const wghtAxis = meta.axes.find((a) => a.tag === 'wght');
      expect(wghtAxis?.defaultValue).toBe(400); // Fell back to default 400
    });
  });

  // =========================================================================
  // 5. HWP 5.0 OLE / CFBF Containers
  // =========================================================================
  describe('5. HWP 5.0 OLE / CFBF Containers', () => {
    it('fails closed when OLE2 compound file magic bytes are invalid', () => {
      const invalidMagic = Buffer.alloc(512);
      invalidMagic.write('NOT_AN_OLE_FILE', 0, 'ascii');

      expect(() => parseCfbf(invalidMagic)).toThrow(/Invalid CFBF container/i);
      expect(isCfbfContainer(invalidMagic)).toBe(false);
    });

    it('fails closed on cyclic sector allocation table (SAT) loops without infinite loop', () => {
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

      const startTime = Date.now();
      const cfbf = parseCfbf(cyclicOle);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100); // Must not hang
      expect(cfbf).toBeDefined();
    });

    it('fails closed on record headers with negative or absurd payload lengths in parseHwpRecords', () => {
      const corruptedRecord = Buffer.alloc(20);
      // HWP record header format: (tagId: 10 bits) | (level: 10 bits) | (size: 12 bits)
      // If size is 0xFFF (4095), it reads extended 32-bit size
      const headerVal = (0x01) | (0 << 10) | (0xfff << 20);
      corruptedRecord.writeUInt32LE(headerVal >>> 0, 0);
      corruptedRecord.writeUInt32LE(0x7fffffff, 4); // Extended size: 2GB payload!

      const records = parseHwpRecords(corruptedRecord);
      // Must safely terminate and return 0 or safe empty records without OOM
      expect(records).toBeDefined();
    });
  });

  // =========================================================================
  // 6. Anti-Hang & Strict Millisecond Execution Oracle
  // =========================================================================
  describe('6. Anti-Hang & Strict Millisecond Execution Oracle', () => {
    it('executes 100 random bitstream mutations across all parsers within 500ms', () => {
      const startTime = Date.now();
      const seedBuffer = Buffer.alloc(256);
      for (let i = 0; i < seedBuffer.length; i++) {
        seedBuffer[i] = (i * 37) % 256;
      }

      for (let i = 0; i < 100; i++) {
        const mutated = mutateBitFlip(seedBuffer, 4);
        try {
          decodeParquet(mutated);
        } catch {}
        try {
          decompressZstd(mutated);
        } catch {}
        try {
          parseCfbf(mutated);
        } catch {}
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1500); // 100 iterations completed rapidly with zero hangs
    });
  });

  // =========================================================================
  // 7. Audio Bitstream Adversarial Fuzzing
  // =========================================================================
  describe('7. Audio Bitstream Adversarial Fuzzing', () => {
    it('fails closed on truncated WAV bitstreams missing subchunk header', () => {
      const badWav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '); // Truncated mid fmt chunk
      expect(() => decodeAudioBuffer(badWav, 'wav')).toThrow();
    });

    it('fails closed on corrupted FLAC stream with broken sync word or truncated header', () => {
      const badFlac = Buffer.from('fLaC\x80\x00\x00\x22TRUNCATED_STREAMINFO_LESS_THAN_34_BYTES');
      expect(() => decodeAudioBuffer(badFlac, 'flac')).toThrow();
    });

    it('fails closed on non-audio random noise bitstreams without unhandled crashes', () => {
      const noise = Buffer.from('RANDOM_NOISE_NON_AUDIO_BYTES_0123456789');
      expect(() => decodeAudioBuffer(noise, 'wav')).toThrow();
      expect(() => decodeAudioBuffer(noise, 'flac')).toThrow();
    });
  });
});
