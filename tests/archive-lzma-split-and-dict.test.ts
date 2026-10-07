import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  compressLzma,
  compressLzma2,
  decompressLzma,
  decompressLzma2,
  create7zArchive,
  extract7zArchive,
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  convertArchive,
  createRarArchive,
  extractRarArchive,
} from '../src/lib/conversions';
import { buildStoredRar4 } from './helpers/rar4-stored';

/** A stored RAR 4.x archive written by the independent fixture writer (tests/helpers/rar4-stored.ts). */
function storedRar(files: { filename: string; buffer: Buffer }[]): Buffer {
  return buildStoredRar4(files.map((file) => ({ name: file.filename, data: file.buffer })));
}

describe('Archive Domain: Pure TS LZMA/LZMA2, Multi-Volume Splitting/Stitching & RFC 9842 Zstd Dict (#133)', () => {
  const sha256 = (b: Buffer | Uint8Array): string =>
    crypto.createHash('sha256').update(b).digest('hex');

  // ==========================================================================
  // 1. Pure TypeScript Authentic LZMA & LZMA2 Encoders and Decoders
  // ==========================================================================
  describe('1. Authentic LZMA & LZMA2 Range Coding & Packaging', () => {
    it('round-trips lossless compression with pure TS LZMA preserving exact SHA-256 hash', () => {
      const payload = Buffer.from(
        (
          'EasyConvert Enterprise Pure TypeScript LZMA Range Coder. ' +
          'Lossless bit-tree matched literal compression with fast position table. ' +
          '{"metric": "compression_ratio", "valid": true, "status": "active"}\n'
        ).repeat(40),
        'utf-8'
      );

      const compressed = compressLzma(payload);
      expect(compressed.buffer.length).toBeLessThan(payload.length);
      expect(compressed.props.length).toBe(5);
      expect(compressed.uncompressedSize).toBe(payload.length);

      const decompressed = decompressLzma(
        compressed.buffer,
        compressed.props,
        compressed.uncompressedSize
      );

      expect(decompressed.length).toBe(payload.length);
      expect(sha256(decompressed)).toBe(sha256(payload));
    });

    it('round-trips lossless compression with pure TS LZMA2 chunk container packaging', () => {
      const payload = Buffer.from(
        (
          'RFC-compliant LZMA2 Stream Packaging. Mode 3 reset chunks with dictionary preservation. ' +
          'Tested against commercial enterprise conversion standards. ' +
          '0123456789abcdefghijklmnopqrstuvwxyz!\n'
        ).repeat(30),
        'utf-8'
      );

      const compressed = compressLzma2(payload);
      expect(compressed.buffer.length).toBeLessThan(payload.length);
      expect(compressed.props.length).toBe(1);

      const decompressed = decompressLzma2(
        compressed.buffer,
        compressed.props,
        compressed.uncompressedSize
      );

      expect(decompressed.length).toBe(payload.length);
      expect(sha256(decompressed)).toBe(sha256(payload));
    });

    it('handles boundary and edge cases: empty input in LZMA and LZMA2', () => {
      const empty = Buffer.alloc(0);

      const lzmaRes = compressLzma(empty);
      expect(lzmaRes.uncompressedSize).toBe(0);
      const lzmaDec = decompressLzma(lzmaRes.buffer, lzmaRes.props, 0);
      expect(lzmaDec.length).toBe(0);

      const lzma2Res = compressLzma2(empty);
      expect(lzma2Res.uncompressedSize).toBe(0);
      const lzma2Dec = decompressLzma2(lzma2Res.buffer, lzma2Res.props, 0);
      expect(lzma2Dec.length).toBe(0);
    });

    it('handles binary random payload round-trip without corruption', () => {
      const randomBytes = crypto.randomBytes(1024);

      const lzmaRes = compressLzma(randomBytes);
      const lzmaDec = decompressLzma(lzmaRes.buffer, lzmaRes.props, randomBytes.length);
      expect(sha256(lzmaDec)).toBe(sha256(randomBytes));

      const lzma2Res = compressLzma2(randomBytes);
      const lzma2Dec = decompressLzma2(lzma2Res.buffer, lzma2Res.props, randomBytes.length);
      expect(sha256(lzma2Dec)).toBe(sha256(randomBytes));
    });

    it('handles large payloads with match distance >= 1024 without slot corruption or dictionary overflow in LZMA', () => {
      // 35KB and 70KB payloads probe distances across slot boundaries (slot 20..25)
      for (const size of [35000, 70000]) {
        const payload = crypto.randomBytes(size);
        const lzmaRes = compressLzma(payload);
        const lzmaDec = decompressLzma(lzmaRes.buffer, lzmaRes.props, payload.length);
        expect(sha256(lzmaDec)).toBe(sha256(payload));
      }
    });

    it('handles multi-chunk streaming in LZMA2 with uncompressed chunks and large repetitive text', () => {
      // 1. 70KB random payload forces uncompressed chunk emission (control 0x01/0x02) without 16-bit packSize overflow
      const random70k = crypto.randomBytes(70000);
      const lzma2Rand = compressLzma2(random70k);
      const decRand = decompressLzma2(lzma2Rand.buffer, lzma2Rand.props, random70k.length);
      expect(sha256(decRand)).toBe(sha256(random70k));

      // 2. 180KB repetitive payload exercises multi-chunk LZMA mode 3 chunks
      const text180k = Buffer.from('Commercial enterprise conversion standards high fidelity LZMA2 stream.\n'.repeat(2500));
      const lzma2Text = compressLzma2(text180k);
      expect(lzma2Text.buffer.length).toBeLessThan(text180k.length);
      const decText = decompressLzma2(lzma2Text.buffer, lzma2Text.props, text180k.length);
      expect(sha256(decText)).toBe(sha256(text180k));
    });
  });

  // ==========================================================================
  // 2. 7z Container Integration with options.archiveCoder
  // ==========================================================================
  describe('2. 7z Archive Creation and Extraction across Coder Types', () => {
    const testFiles = [
      {
        filename: 'data.json',
        buffer: Buffer.from(
          JSON.stringify({
            service: 'easyconvert',
            coder: 'lzma2',
            tags: ['archive', 'split', 'zstd-dict'],
            nested: { ok: true, count: 42 },
          })
        ),
      },
      {
        filename: 'notes.txt',
        buffer: Buffer.from('High performance archive compression in pure TypeScript.\n'.repeat(25)),
      },
      {
        filename: 'binary.dat',
        buffer: Buffer.from([0x00, 0xff, 0xaa, 0x55, 0x12, 0x34, 0x56, 0x78, 0x90]),
      },
    ];

    it('creates and extracts 7z archive with LZMA2 coder (default when compressed)', () => {
      const archive = create7zArchive(testFiles, { archiveCoder: 'lzma2' }, 'test_lzma2.7z');
      expect(archive.buffer.length).toBeGreaterThan(32);
      expect(archive.filename).toBe('test_lzma2.7z');

      const extracted = extract7zArchive(archive.buffer);
      expect(extracted).toHaveLength(testFiles.length);

      for (let i = 0; i < testFiles.length; i++) {
        expect(extracted[i].filename).toBe(testFiles[i].filename);
        expect(sha256(extracted[i].buffer)).toBe(sha256(testFiles[i].buffer));
      }
    });

    it('creates and extracts 7z archive with LZMA coder', () => {
      const archive = create7zArchive(testFiles, { archiveCoder: 'lzma' }, 'test_lzma.7z');
      expect(archive.buffer.length).toBeGreaterThan(32);

      const extracted = extract7zArchive(archive.buffer);
      expect(extracted).toHaveLength(testFiles.length);

      for (let i = 0; i < testFiles.length; i++) {
        expect(extracted[i].filename).toBe(testFiles[i].filename);
        expect(sha256(extracted[i].buffer)).toBe(sha256(testFiles[i].buffer));
      }
    });

    it('creates and extracts 7z archive with Deflate coder', () => {
      const archive = create7zArchive(testFiles, { archiveCoder: 'deflate' }, 'test_deflate.7z');
      expect(archive.buffer.length).toBeGreaterThan(32);

      const extracted = extract7zArchive(archive.buffer);
      expect(extracted).toHaveLength(testFiles.length);

      for (let i = 0; i < testFiles.length; i++) {
        expect(extracted[i].filename).toBe(testFiles[i].filename);
        expect(sha256(extracted[i].buffer)).toBe(sha256(testFiles[i].buffer));
      }
    });

    it('creates and extracts 7z archive with Copy coder (uncompressed)', () => {
      const archive = create7zArchive(testFiles, { archiveCoder: 'copy' }, 'test_copy.7z');
      expect(archive.buffer.length).toBeGreaterThan(32);

      const extracted = extract7zArchive(archive.buffer);
      expect(extracted).toHaveLength(testFiles.length);

      for (let i = 0; i < testFiles.length; i++) {
        expect(extracted[i].filename).toBe(testFiles[i].filename);
        expect(sha256(extracted[i].buffer)).toBe(sha256(testFiles[i].buffer));
      }
    });
  });

  // ==========================================================================
  // 3. Multi-Volume Archive Splitting and Stitching
  // ==========================================================================
  describe('3. Multi-Volume Archive Pipeline (isSplitArchive, splitArchive, stitchMultiVolumeArchive)', () => {
    it('detects and parses split archive parts across 7z, RAR, Zip, Tar, and numeric schemes', () => {
      expect(isSplitArchive('backup.7z.001')).toBe(true);
      expect(isSplitArchive('backup.7z.002')).toBe(true);
      expect(isSplitArchive('data.part1.rar')).toBe(true);
      expect(isSplitArchive('data.part02.rar')).toBe(true);
      expect(isSplitArchive('archive.z01')).toBe(true);
      expect(isSplitArchive('collection.tar.001')).toBe(true);
      expect(isSplitArchive('collection.tar.gz.001')).toBe(true);
      expect(isSplitArchive('largefile.bin.001')).toBe(true);

      expect(isSplitArchive('regular_archive.zip')).toBe(false);
      expect(isSplitArchive('regular_archive.7z')).toBe(false);
      expect(isSplitArchive('regular_archive.rar')).toBe(false);
      expect(isSplitArchive('photo.jpg')).toBe(false);

      const rarPart = parseSplitArchivePart('dataset.part03.rar');
      expect(rarPart).not.toBeNull();
      expect(rarPart?.baseName).toBe('dataset.rar');
      expect(rarPart?.partNumber).toBe(3);
      expect(rarPart?.format).toBe('rar');

      const sevenZipPart = parseSplitArchivePart('dataset.7z.005');
      expect(sevenZipPart).not.toBeNull();
      expect(sevenZipPart?.baseName).toBe('dataset.7z');
      expect(sevenZipPart?.partNumber).toBe(5);
      expect(sevenZipPart?.format).toBe('7z');
    });

    it('splits archive buffer into sequential volumes with splitArchive', () => {
      const rawData = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(10));
      const archiveResult = create7zArchive(
        [{ filename: 'data.txt', buffer: rawData }],
        { archiveCoder: 'copy' },
        'sample.7z'
      );

      // Split into 80-byte chunks
      const chunkSize = 80;
      const parts = splitArchive(archiveResult.buffer, 'sample.7z', chunkSize, '7z');

      expect(parts.length).toBe(Math.ceil(archiveResult.buffer.length / chunkSize));
      expect(parts[0].filename).toBe('sample.7z.001');
      expect(parts[1].filename).toBe('sample.7z.002');

      // Verify concatenating parts recovers the exact buffer
      const reassembled = Buffer.concat(parts.map((p) => p.buffer));
      expect(sha256(reassembled)).toBe(sha256(archiveResult.buffer));
    });

    it('stitches multi-volume 7z archive parts and successfully extracts original files', () => {
      const content = Buffer.from('Multi-volume 7z stitching test payload.\n'.repeat(50));
      const original7z = create7zArchive(
        [{ filename: 'payload.txt', buffer: content }],
        { archiveCoder: 'lzma2' },
        'split_test.7z'
      );

      // Split into 60-byte parts
      const parts = splitArchive(original7z.buffer, 'split_test.7z', 60, '7z');
      expect(parts.length).toBeGreaterThan(1);

      // Stitch back
      const stitched = stitchMultiVolumeArchive(parts);
      expect(stitched.baseFilename).toBe('split_test.7z');
      expect(stitched.format).toBe('7z');
      expect(stitched.totalParts).toBe(parts.length);
      expect(sha256(stitched.buffer)).toBe(sha256(original7z.buffer));

      // Extract from stitched buffer
      const extracted = extract7zArchive(stitched.buffer);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].filename).toBe('payload.txt');
      expect(sha256(extracted[0].buffer)).toBe(sha256(content));
    });

    it('stitches multi-volume RAR archive parts and successfully extracts original files', () => {
      const content = Buffer.from('Multi-volume RAR test payload data.\n'.repeat(40));
      const rarBuffer = storedRar([
        { filename: 'document.txt', buffer: content },
      ]);

      // Split into 50-byte parts
      const parts = splitArchive(rarBuffer, 'dataset.rar', 50, 'rar');
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0].filename).toBe('dataset.part1.rar');
      expect(parts[1].filename).toBe('dataset.part2.rar');

      // Stitch back
      const stitched = stitchMultiVolumeArchive(parts);
      expect(stitched.baseFilename).toBe('dataset.rar');
      expect(stitched.format).toBe('rar');
      expect(sha256(stitched.buffer)).toBe(sha256(rarBuffer));

      // Extract from stitched buffer
      const extracted = extractRarArchive(stitched.buffer);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].filename).toBe('document.txt');
      expect(sha256(extracted[0].buffer)).toBe(sha256(content));
    });

    it('enforces Fail-Closed validation when multi-volume archive parts are missing or out of sequence', () => {
      const dummy = Buffer.alloc(100, 0xaa);

      // Missing volume 1 (starts at volume 2)
      expect(() =>
        stitchMultiVolumeArchive([
          { filename: 'archive.part2.rar', buffer: dummy },
          { filename: 'archive.part3.rar', buffer: dummy },
        ])
      ).toThrow(/missing volume 1/i);

      // Gap in sequence: part 1 and part 3 without part 2
      expect(() =>
        stitchMultiVolumeArchive([
          { filename: 'archive.part1.rar', buffer: dummy },
          { filename: 'archive.part3.rar', buffer: dummy },
        ])
      ).toThrow(/missing volume 2/i);

      // Mismatched base archive names
      expect(() =>
        stitchMultiVolumeArchive([
          { filename: 'archiveA.part1.rar', buffer: dummy },
          { filename: 'archiveB.part2.rar', buffer: dummy },
        ])
      ).toThrow(/Mismatched multi-volume archives/i);

      // Duplicate part in batch (e.g., two volume 1 parts)
      expect(() =>
        stitchMultiVolumeArchive([
          { filename: 'archive.part1.rar', buffer: dummy },
          { filename: 'archive.part1.rar', buffer: dummy },
        ])
      ).toThrow(/duplicate multi-volume archive part/i);

      // Empty part array
      expect(() => stitchMultiVolumeArchive([])).toThrow(/empty/i);
    });

    it('integrates multi-volume splitting in convertArchive via splitVolumeBytes', async () => {
      const input = Buffer.from('ConvertArchive splitVolumeBytes test payload.\n'.repeat(40));
      const res = await convertArchive(input, 'txt', '7z', {
        splitVolumeBytes: 70,
        archiveCoder: 'lzma2',
      }, 'report.txt');

      expect(res.parts).toBeDefined();
      expect(res.parts!.length).toBeGreaterThan(1);
      expect(res.parts![0].filename).toMatch(/\.7z\.001$/);

      // Stitched parts must form a valid 7z extracting the original report.txt
      const stitched = stitchMultiVolumeArchive(res.parts!);
      const extracted = extract7zArchive(stitched.buffer);
      expect(extracted).toHaveLength(1);
      expect(sha256(extracted[0].buffer)).toBe(sha256(input));
    });

    it('integrates multi-volume stitching on input in convertArchive via archiveParts', async () => {
      const originalContent = Buffer.from('Stitched input test content.\n'.repeat(30));
      const rarBuffer = storedRar([
        { filename: 'source.txt', buffer: originalContent },
      ]);
      const parts = splitArchive(rarBuffer, 'source.rar', 60, 'rar');

      // Convert multi-part RAR input to ZIP
      const zipResult = await convertArchive(
        parts[0].buffer,
        'rar',
        'zip',
        { archiveParts: parts },
        parts[0].filename
      );

      expect(zipResult.filename).toBe('source.zip');
      expect(zipResult.buffer.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 4. RFC 9842 & RFC 8878 Zstandard Dictionary Compression & Decompression
  // ==========================================================================
  describe('4. RFC 9842 & RFC 8878 Zstandard Dictionary Acceleration', () => {
    it('compresses and decompresses JSON/CSV payload with pre-trained data dictionary preserving checksum', () => {
      const jsonPayload = Buffer.from(
        JSON.stringify({
          status: 'ok',
          code: 200,
          data: {
            results: [
              { id: 101, name: 'Item Alpha', type: 'standard', active: true, count: 50 },
              { id: 102, name: 'Item Beta', type: 'standard', active: false, count: 120 },
              { id: 103, name: 'Item Gamma', type: 'standard', active: true, count: 75 },
            ],
            total: 3,
            version: '1.0',
            encoding: 'utf-8',
          },
          message: 'ok',
          success: true,
          error: null,
        }),
        'utf-8'
      );

      const dict = DATA_DICTIONARY_JSON_CSV;
      const compressed = compressWithZstdDict(jsonPayload, dict);

      // Frame validation: ZSTD magic number (0xFD2FB528 LE)
      expect(compressed.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));

      // 4-byte dictionary ID check
      const fhd = compressed[4];
      expect(fhd & 0x03).toBe(3); // dictIdFlag = 3 (4 bytes)

      // Decompress and verify exact match and XXH64 content checksum
      const decompressed = decompressWithZstdDict(compressed, dict);
      expect(sha256(decompressed)).toBe(sha256(jsonPayload));
      expect(decompressed.toString('utf-8')).toBe(jsonPayload.toString('utf-8'));
    });

    it('compresses and decompresses Office XML payload with pre-trained office dictionary', () => {
      const xmlPayload = Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Quarterly Financial Performance Overview</w:t></w:r></w:p>',
          '<w:p><w:r><w:t>Net Operating Revenue exceeds target estimates by 18.4%.</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
        'utf-8'
      );

      const dict = OFFICE_XML_DICTIONARY;
      const compressed = compressWithZstdDict(xmlPayload, dict);

      const decompressed = decompressWithZstdDict(compressed, dict);
      expect(sha256(decompressed)).toBe(sha256(xmlPayload));
      expect(decompressed.toString('utf-8')).toBe(xmlPayload.toString('utf-8'));
    });

    it('enforces Fail-Closed verification on corrupt Zstd dictionary frame or wrong dictionary', () => {
      const sample = Buffer.from('{"id": 1, "status": "active", "code": 200}');
      const compressed = compressWithZstdDict(sample, DATA_DICTIONARY_JSON_CSV);

      // Truncated buffer
      expect(() => decompressWithZstdDict(compressed.subarray(0, 8), DATA_DICTIONARY_JSON_CSV)).toThrow(
        /too small/i
      );

      // Corrupt magic
      const corruptMagic = Buffer.from(compressed);
      corruptMagic[0] = 0x00;
      expect(() => decompressWithZstdDict(corruptMagic, DATA_DICTIONARY_JSON_CSV)).toThrow(
        /magic number mismatch/i
      );

      // Tampered checksum (last 4 bytes)
      const tamperedChecksum = Buffer.from(compressed);
      tamperedChecksum[tamperedChecksum.length - 1] ^= 0xff;
      expect(() => decompressWithZstdDict(tamperedChecksum, DATA_DICTIONARY_JSON_CSV)).toThrow(
        /checksum mismatch/i
      );

      // Dictionary ID mismatch
      expect(() => decompressWithZstdDict(compressed, OFFICE_XML_DICTIONARY)).toThrow(
        /Dictionary mismatch/i
      );
    });


    it('integrates zstdDict in convertArchive for both compression and decompression', async () => {
      const apiData = Buffer.from(
        JSON.stringify({
          data: { results: [{ id: 1, name: 'EasyConvert API Payload', count: 10 }] },
          status: 'ok',
          code: 200,
          success: true,
          error: null,
        }),
        'utf-8'
      );

      // Convert to ZST with dictionary
      const zstResult = await convertArchive(
        apiData,
        'json',
        'zst',
        { zstdDict: 'data' },
        'payload.json'
      );

      expect(zstResult.mimeType).toBe('application/zstd');
      expect(zstResult.filename).toBe('payload.json.zst');

      // Convert back from ZST using dictionary
      const jsonResult = await convertArchive(
        zstResult.buffer,
        'zst',
        'zip',
        { zstdDict: 'data' },
        'payload.json.zst'
      );

      expect(jsonResult.buffer.length).toBeGreaterThan(0);
    });

    it('integrates zstdDict with tar.zst in convertArchive and verifies Fail-Closed rejection on corrupt frame', async () => {
      const officeXml = Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Corporate Document</w:t></w:r></w:p></w:body></w:document>',
        'utf-8'
      );

      // 1. Convert to tar.zst with office dictionary
      const tarZstResult = await convertArchive(
        officeXml,
        'xml',
        'tar.zst',
        { zstdDict: 'office' },
        'document.xml'
      );

      expect(tarZstResult.mimeType).toBe('application/x-zstd-compressed-tar');
      expect(tarZstResult.filename).toBe('document.tar.zst');

      // 2. Fail-Closed check: corrupt the frame and ensure convertArchive throws without silent fallback
      const corruptFrame = Buffer.from(tarZstResult.buffer);
      corruptFrame[corruptFrame.length - 1] ^= 0xff; // corrupt checksum

      await expect(
        convertArchive(
          corruptFrame,
          'tar.zst',
          'zip',
          { zstdDict: 'office' },
          'document.tar.zst'
        )
      ).rejects.toThrow(/checksum mismatch/i);
    });
  });
});
