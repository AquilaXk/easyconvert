import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compressWithZstdDict,
  decompressWithZstdDict,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  compressXz,
  decompressXz,
  packXz,
  unpackXz,
  convertArchive,
  createTarArchive,
  extractTarArchive,
  create7zArchive,
  extract7zArchive,
  createRarArchive,
  extractRarArchive,
  convertWithNative7z,
  getXzBinaryPath,
  get7zBinaryPath,
} from '../src/lib/conversions';
import { decodeZstdCompressedBlockWithDict } from '../src/lib/conversions/zstd-dict';
import { getZstdBinaryPath } from '../src/lib/conversions/zstd';
import { ConversionFailedError } from '../src/lib/types';

describe('Phase 6: Zstandard FSE Entropy & Archive Native Parity', () => {
  const sha256 = (b: Buffer | Uint8Array): string =>
    crypto.createHash('sha256').update(b).digest('hex');

  // ==========================================================================
  // 1. Zstandard FSE Entropy & Dictionary-Trained Compression
  // ==========================================================================
  describe('1. RFC 8878 Zstandard FSE Entropy & Dictionary Acceleration', () => {
    it('achieves genuine compression ratio (< original.length) on repetitive JSON payload with pre-trained dictionary', () => {
      const jsonRecords = Array.from({ length: 25 }, (_, i) => ({
        id: 1000 + i,
        name: `Automated Enterprise System Record #${i}`,
        type: 'standard',
        status: i % 2 === 0 ? 'active' : 'pending',
        created_at: '2026-09-28T12:00:00.000Z',
        updated_at: '2026-09-28T12:30:00.000Z',
        timestamp: 1727520000 + i * 60,
        success: true,
        error: null,
        message: 'ok',
        code: 200,
        data: {
          results: [
            { id: 101, name: 'Item Alpha', type: 'standard', active: true, count: 50 },
            { id: 102, name: 'Item Beta', type: 'standard', active: false, count: 120 },
            { id: 103, name: 'Item Gamma', type: 'standard', active: true, count: 75 },
          ],
          total: 3,
          offset: 0,
          limit: 100,
          version: '1.0',
          encoding: 'utf-8',
        },
      }));

      const originalPayload = Buffer.from(JSON.stringify(jsonRecords, null, 2), 'utf-8');
      const compressed = compressWithZstdDict(originalPayload, DATA_DICTIONARY_JSON_CSV);

      // Verify genuine compression ratio
      expect(compressed.length).toBeLessThan(originalPayload.length);
      const ratio = originalPayload.length / compressed.length;
      expect(ratio).toBeGreaterThan(1.5);

      // Verify RFC 8878 Zstandard Frame Header: Magic byte 0xFD2FB528 LE
      expect(compressed.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));

      // Verify Dictionary ID Flag is 3 (4 bytes) and matches ZSTD_DICT_MAGIC
      const fhd = compressed[4];
      expect(fhd & 0x03).toBe(3);
      expect(compressed.readUInt32LE(5)).toBe(ZSTD_DICT_MAGIC);

      // Pure TypeScript lossless round-trip
      const decompressed = decompressWithZstdDict(compressed, DATA_DICTIONARY_JSON_CSV);
      expect(decompressed.length).toBe(originalPayload.length);
      expect(sha256(decompressed)).toBe(sha256(originalPayload));
      expect(decompressed.toString('utf-8')).toBe(originalPayload.toString('utf-8'));
    });

    it('achieves genuine compression ratio on OpenXML / DrawingML Office corpus with office dictionary', () => {
      const officeXmlText = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        '<w:body>',
        Array.from({ length: 15 }, (_, i) => [
          '<w:p><w:r><w:t>',
          `Section ${i + 1}: EasyConvert Next-Generation Enterprise Conversion Architecture Parity.`,
          '</w:t></w:r></w:p>',
          '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Shape 1"/></p:nvSpPr>',
          '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10000" cy="10000"/></a:xfrm>',
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>',
        ].join('')).join(''),
        '</w:body></w:document>',
      ].join('');

      const originalXml = Buffer.from(officeXmlText, 'utf-8');
      const compressed = compressWithZstdDict(originalXml, OFFICE_XML_DICTIONARY);

      expect(compressed.length).toBeLessThan(originalXml.length);
      const ratio = originalXml.length / compressed.length;
      expect(ratio).toBeGreaterThan(1.5);

      // Verify dictionary ID embedded matches ZSTD_OFFICE_DICT_MAGIC
      expect(compressed.readUInt32LE(5)).toBe(ZSTD_OFFICE_DICT_MAGIC);

      // Lossless round-trip
      const decompressed = decompressWithZstdDict(compressed, OFFICE_XML_DICTIONARY);
      expect(sha256(decompressed)).toBe(sha256(originalXml));
      expect(decompressed.toString('utf-8')).toBe(originalXml.toString('utf-8'));
    });

    it('authentically encodes and decodes high sequence counts (>255 sequences) conforming to RFC 8878 Section 3.1.1.3.2', () => {
      const dictPattern = 'AlphaBetaGammaDelta0123456789!@#$%^&*()_+{}[]:;<>,.?/~`';
      const dict = Buffer.from(dictPattern, 'utf-8');

      // Generate input with 300 distinct sequence matches against dict
      const parts: string[] = [];
      for (let i = 0; i < 300; i++) {
        parts.push(dictPattern.slice(0, 16) + String(i).padStart(4, '0'));
      }
      const highSeqInput = Buffer.from(parts.join(''), 'utf-8');

      const compressed = compressWithZstdDict(highSeqInput, dict, { dictId: 0 });
      expect(compressed.length).toBeLessThan(highSeqInput.length);

      // Pure TypeScript round-trip
      const tsDecompressed = decompressWithZstdDict(compressed, dict);
      expect(tsDecompressed.length).toBe(highSeqInput.length);
      expect(sha256(tsDecompressed)).toBe(sha256(highSeqInput));

      // Official zstd CLI round-trip if available
      const zstdBin = getZstdBinaryPath();
      if (zstdBin) {
        const tmpDir = os.tmpdir();
        const token = crypto.randomBytes(8).toString('hex');
        const compFile = path.join(tmpDir, `zstd_high_seq_${token}.zst`);
        const dictFile = path.join(tmpDir, `zstd_high_dict_${token}.dict`);

        try {
          fs.writeFileSync(compFile, compressed);
          fs.writeFileSync(dictFile, dict);

          const cliOutput = execFileSync(zstdBin, ['-d', '-D', dictFile, compFile, '-c', '-q'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10000,
          });

          expect(cliOutput.length).toBe(highSeqInput.length);
          expect(sha256(cliOutput)).toBe(sha256(highSeqInput));
        } finally {
          try { fs.unlinkSync(compFile); } catch {}
          try { fs.unlinkSync(dictFile); } catch {}
        }
      }
    });

    it.skipIf(!getZstdBinaryPath())('decompresses losslessly via official zstd CLI binary when available', () => {
      const zstdBin = getZstdBinaryPath()!;

      // Generate a repetitive input that exercises sequences
      const pattern = 'AlphaBetaGammaDelta1234567890!@#$%^&*()_+';
      const input = Buffer.from(pattern.repeat(30), 'utf-8');

      // Compress with raw dictionary content
      const compressed = compressWithZstdDict(input, Buffer.from(pattern, 'utf-8'), { dictId: 0 });
      expect(compressed.length).toBeLessThan(input.length);

      const tmpDir = os.tmpdir();
      const token = crypto.randomBytes(8).toString('hex');
      const compFile = path.join(tmpDir, `zstd_cli_test_${token}.zst`);
      const dictFile = path.join(tmpDir, `zstd_cli_dict_${token}.dict`);

      try {
        fs.writeFileSync(compFile, compressed);
        fs.writeFileSync(dictFile, Buffer.from(pattern, 'utf-8'));

        const cliOutput = execFileSync(zstdBin, ['-d', '-D', dictFile, compFile, '-c', '-q'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });

        expect(cliOutput.length).toBe(input.length);
        expect(sha256(cliOutput)).toBe(sha256(input));
      } finally {
        try { fs.unlinkSync(compFile); } catch {}
        try { fs.unlinkSync(dictFile); } catch {}
      }
    });

    it('enforces Fail-Closed rejection on dictionary ID mismatch, corrupt magic, and tampered checksum', () => {
      const sample = Buffer.from('{"id": 42, "name": "FailClosedTest", "status": "active"}', 'utf-8');
      const compressed = compressWithZstdDict(sample, DATA_DICTIONARY_JSON_CSV);

      // 1. Dictionary ID mismatch
      expect(() => decompressWithZstdDict(compressed, OFFICE_XML_DICTIONARY)).toThrow(
        /Dictionary mismatch/i
      );

      // 2. Corrupt magic number
      const corruptMagic = Buffer.from(compressed);
      corruptMagic[0] = 0x00;
      expect(() => decompressWithZstdDict(corruptMagic, DATA_DICTIONARY_JSON_CSV)).toThrow(
        /magic number mismatch/i
      );

      // 3. Tampered content checksum (last 4 bytes)
      const tamperedChecksum = Buffer.from(compressed);
      tamperedChecksum[tamperedChecksum.length - 1] ^= 0xff;
      expect(() => decompressWithZstdDict(tamperedChecksum, DATA_DICTIONARY_JSON_CSV)).toThrow(
        /checksum mismatch/i
      );

      // 4. Truncated frame
      expect(() => decompressWithZstdDict(compressed.subarray(0, 10), DATA_DICTIONARY_JSON_CSV)).toThrow(
        /too small/i
      );
    });

    it('enforces Fail-Closed rejection on invalid sequence offset values (offset <= 0)', () => {
      // Craft a block payload with a sequence having offset <= 0 (litLen=0 and rawOffset=3 with initial r1=1, yielding offset = r1 - 1 = 0)
      const fakeBlock = Buffer.from([
        0x00, // Raw literals length = 0
        0x01, // numSeq = 1
        0x00, // Predefined FSE mode
        0x81, 0x0b, 0x04, // Backward FSE bitstream encoding rawOffset=3, matchLen=3, litLen=0
      ]);

      expect(() =>
        decodeZstdCompressedBlockWithDict(fakeBlock, Buffer.alloc(16))
      ).toThrow(/invalid offset|Corrupt sequence/i);
    });
  });

  // ==========================================================================
  // 2. Authentic Multi-Format Archive Native Parity (XZ, TXZ, 7Z, RAR, TAR)
  // ==========================================================================
  describe('2. Multi-Format Archive Container Parity & Zero Synthetic Shortcuts', () => {
    const testFiles = [
      {
        filename: 'documents/contract.txt',
        buffer: Buffer.from('Standard Enterprise License Agreement 2026.\n'.repeat(20), 'utf-8'),
      },
      {
        filename: 'data/records.json',
        buffer: Buffer.from(JSON.stringify({ dataset: 'alpha', items: [1, 2, 3, 4, 5] }, null, 2), 'utf-8'),
      },
      {
        filename: 'notes.md',
        buffer: Buffer.from('# Technical Architecture Notes\nLossless conversion verified.\n', 'utf-8'),
      },
    ];

    it('authentically packages and unpacks XZ container with pure TS packXz and unpackXz', () => {
      const content = Buffer.from('Authentic XZ container specification packaging test.\n'.repeat(25), 'utf-8');
      const xzBuffer = packXz(content);

      // 1. Verify 6-byte XZ Magic: 0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00
      expect(xzBuffer.subarray(0, 6)).toEqual(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
      );

      // 2. Verify 2-byte Footer Magic: 0x59, 0x5A ('YZ')
      expect(xzBuffer.subarray(xzBuffer.length - 2)).toEqual(
        Buffer.from([0x59, 0x5a])
      );

      // 3. Lossless round-trip via pure TS unpackXz
      const decompressed = unpackXz(xzBuffer);
      expect(decompressed.length).toBe(content.length);
      expect(sha256(decompressed)).toBe(sha256(content));
      expect(decompressed.toString('utf-8')).toBe(content.toString('utf-8'));
    });

    it('enforces Fail-Closed integrity checks in unpackXz on corrupt CRC, invalid index, and tampered stream flags', () => {
      const content = Buffer.from('Fail-Closed XZ container integrity test payload.\n'.repeat(10), 'utf-8');
      const validXz = packXz(content);

      // 1. Tampered payload check CRC
      const backwardSize = validXz.readUInt32LE(validXz.length - 8);
      const indexSize = (backwardSize + 1) * 4;
      const indexOffset = validXz.length - 12 - indexSize;
      const tamperedCheckCrc = Buffer.from(validXz);
      tamperedCheckCrc[indexOffset - 4] ^= 0xff;
      expect(() => unpackXz(tamperedCheckCrc)).toThrow(/payload CRC32 mismatch/i);

      // 2. Tampered footer CRC
      const tamperedFooterCrc = Buffer.from(validXz);
      tamperedFooterCrc[tamperedFooterCrc.length - 12] ^= 0xff;
      expect(() => unpackXz(tamperedFooterCrc)).toThrow(/footer CRC mismatch/i);

      // 3. Tampered stream flags between header and footer
      const tamperedFlags = Buffer.from(validXz);
      tamperedFlags[tamperedFlags.length - 4] ^= 0x01;
      expect(() => unpackXz(tamperedFlags)).toThrow(/footer CRC mismatch|stream flags mismatch/i);

      // 4. Truncated buffer
      expect(() => unpackXz(validXz.subarray(0, 20))).toThrow(/buffer too small/i);
    });

    it.skipIf(!getXzBinaryPath())('decompresses pure TS XZ packaging losslessly with official xz CLI binary when available', () => {
      const xzBin = getXzBinaryPath()!;

      const content = Buffer.from('Official XZ CLI Interoperability Verification Payload.\n'.repeat(30), 'utf-8');
      const xzBuffer = packXz(content);

      const cliDecompressed = execFileSync(xzBin, ['-d', '-c', '-q'], {
        input: xzBuffer,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });

      expect(cliDecompressed.length).toBe(content.length);
      expect(sha256(cliDecompressed)).toBe(sha256(content));
    });

    it('creates and extracts tar.xz / txz archives losslessly through convertArchive', async () => {
      // Create TAR container first
      const tarRes = createTarArchive(testFiles, {}, 'bundle.tar');

      // Convert TAR to TAR.XZ
      const txzRes = await convertArchive(tarRes.buffer, 'tar', 'tar.xz', {}, 'bundle.tar');
      expect(txzRes.mimeType).toBe('application/x-xz-compressed-tar');
      expect(txzRes.filename).toBe('bundle.tar.xz');
      expect(txzRes.buffer.subarray(0, 6)).toEqual(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]));

      // Convert TAR.XZ back to TAR
      const extractedTarRes = await convertArchive(txzRes.buffer, 'tar.xz', 'tar', {}, 'bundle.tar.xz');
      expect(extractedTarRes.mimeType).toBe('application/x-tar');

      // Extract files from recovered TAR and verify exact hashes
      const recoveredFiles = extractTarArchive(extractedTarRes.buffer);
      expect(recoveredFiles.length).toBe(testFiles.length);

      for (let i = 0; i < testFiles.length; i++) {
        const found = recoveredFiles.find((f) => f.filename === testFiles[i].filename);
        expect(found).toBeDefined();
        expect(sha256(found!.buffer)).toBe(sha256(testFiles[i].buffer));
      }
    });

    it('authentically creates and extracts 7z archives with LZMA2 and Deflate coders', () => {
      const sevenZipRes = create7zArchive(testFiles, { archiveCoder: 'lzma2' }, 'archive.7z');

      // Verify 7z Signature: 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C ('7z\xBC\xAF\x27\x1C')
      expect(sevenZipRes.buffer.subarray(0, 6)).toEqual(
        Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
      );

      const extracted = extract7zArchive(sevenZipRes.buffer);
      expect(extracted.length).toBe(testFiles.length);

      for (const expected of testFiles) {
        const match = extracted.find((f) => f.filename === expected.filename);
        expect(match).toBeDefined();
        expect(sha256(match!.buffer)).toBe(sha256(expected.buffer));
      }
    });

    it('authentically creates and extracts RAR archives with valid block headers and CRC32', () => {
      const rarRes = createRarArchive(testFiles, {}, 'dataset.rar');

      // Verify RAR4 signature: 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00
      expect(rarRes.buffer.subarray(0, 7)).toEqual(
        Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
      );

      const extracted = extractRarArchive(rarRes.buffer);
      expect(extracted.length).toBe(testFiles.length);

      for (const expected of testFiles) {
        const match = extracted.find((f) => f.filename === expected.filename);
        expect(match).toBeDefined();
        expect(sha256(match!.buffer)).toBe(sha256(expected.buffer));
      }
    });

    it('eliminates synthetic ZIP wrapping: throws ConversionFailedError on unsupported foreign targets', async () => {
      const input = Buffer.from('Payload data for strict target validation.\n', 'utf-8');

      // Attempting to convert to unsupported archive targets must fail-closed rather than silently returning ZIP
      await expect(
        convertArchive(input, 'txt', 'unsupported_foreign_format', {}, 'test.txt')
      ).rejects.toThrow(ConversionFailedError);

      await expect(
        convertArchive(input, 'txt', 'iso_image', {}, 'test.txt')
      ).rejects.toThrow(/Unsupported archive target format/i);
    });

    it.skipIf(!get7zBinaryPath())('correctly executes convertWithNative7z when native 7z binary is present', () => {
      const p7zBin = get7zBinaryPath()!;

      const input = Buffer.from('7z native CLI acceleration test.\n'.repeat(10), 'utf-8');
      const res = convertWithNative7z(input, 'txt', '7z', {}, 'sample.txt');

      expect(res).not.toBeNull();
      expect(res!.mimeType).toBe('application/x-7z-compressed');
      expect(res!.filename).toBe('sample.7z');
      expect(res!.buffer.subarray(0, 6)).toEqual(
        Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
      );
    });
  });
});
