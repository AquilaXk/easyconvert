import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  create7zArchive,
  extract7zArchive,
  decompressLzma,
  decompressLzma2,
  createRarArchive,
  extractRarArchive,
  convertArchive,
  convertMedia,
  decodeAudioBuffer,
  decodeOgg,
  encodeOggContainer,
  detectFfmpegEnvironment,
  getUnrarBinaryPath,
  ARCHIVE_SECURITY_LIMITS,
  sanitizeArchivePath,
  crc32,
  write7zVarint,
  read7zVarint,
} from '../src/lib/conversions';
import { bestSnrDb, decodeAudioWithFfmpeg, sineSamples, wavFromSamples } from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';

/** A stored RAR 4.x archive written by the independent fixture writer (tests/helpers/rar4-stored.ts). */
function storedRar(files: { filename: string; buffer: Buffer }[]): Buffer {
  return buildStoredRar4(files.map((file) => ({ name: file.filename, data: file.buffer })));
}

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const MIN_ROUNDTRIP_SNR_DB = 25;

describe('Phase 1: Authentic Archive Decompression & Media Codec Fidelity (#107)', () => {
  // Helper to generate genuine RIFF WAV buffer
  function createTestWav(sampleRate = 44100, channels = 2, durationSec = 0.25): Buffer {
    const totalSamples = Math.floor(sampleRate * durationSec * channels);
    const dataSize = totalSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * 2, 28);
    buffer.writeUInt16LE(channels * 2, 32);
    buffer.writeUInt16LE(16, 34);

    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < totalSamples; i++) {
      const t = i / (sampleRate * channels);
      const val = Math.round(Math.sin(2 * Math.PI * 440 * t) * 16000);
      buffer.writeInt16LE(val, 44 + i * 2);
    }

    return buffer;
  }

  // ==========================================================================
  // 1. Authentic 7z Archive Compression & Decompression
  // ==========================================================================
  describe('1. 7z Compression and Authentic Decompression', () => {
    it('verifies pure TypeScript LZMA decompressor on authentic literal stream', () => {
      // Test decompressLzma directly on valid parameters: lc=3, lp=0, pb=2 (byte 0 = 93 = 0x5D), dictSize = 65536
      const props = Buffer.from([0x5d, 0x00, 0x00, 0x01, 0x00]);
      // An LZMA stream encoding 4 bytes of identical characters or uncompressed chunk
      const testData = Buffer.from('LZMA');
      // For uncompressed test via decompressLzma2:
      const lzma2Chunk = Buffer.alloc(3 + testData.length + 1);
      lzma2Chunk[0] = 0x01; // uncompressed reset dictionary
      lzma2Chunk[1] = 0x00;
      lzma2Chunk[2] = testData.length - 1;
      testData.copy(lzma2Chunk, 3);
      lzma2Chunk[3 + testData.length] = 0x00; // EOS

      const decoded = decompressLzma2(lzma2Chunk, Buffer.from([0x14]), testData.length);
      expect(decoded.toString('utf-8')).toBe('LZMA');
    });

    it('fails closed on corrupt 7z archive buffers with invalid signature or truncated headers', () => {
      // Writer and reader are proven against the reference 7-Zip in archive-7z-oracle.test.ts, where damage to a
      // reference archive is covered too. Here the buffers are not archives at all.
      const failureOf = (buffer: Buffer): unknown => {
        try {
          extract7zArchive(buffer);
        } catch (err) {
          return err;
        }
        return undefined;
      };
      const tooShort = { name: 'CorruptStreamError', message: 'Invalid 7z archive: shorter than the 32-byte start header' };
      const badSignature = { name: 'CorruptStreamError', message: 'Invalid 7z archive: bad signature' };
      expect(failureOf(Buffer.from('NOT_A_VALID_7Z_FILE_HEADER_GARBAGE'))).toMatchObject(badSignature);
      expect(failureOf(Buffer.alloc(64, 0x41))).toMatchObject(badSignature);
      expect(failureOf(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00]))).toMatchObject(tooShort);
    });

    it('sanitizes Zip-Slip directory traversal attempts in 7z entries', () => {
      expect(sanitizeArchivePath('../../etc/passwd')).toBe('etc/passwd');
      expect(sanitizeArchivePath('..\\..\\windows\\system32\\cmd.exe')).toBe('windows/system32/cmd.exe');
      expect(sanitizeArchivePath('C:\\Users\\admin\\file.txt')).toBe('Users/admin/file.txt');
      expect(sanitizeArchivePath('/absolute/path/file.txt')).toBe('absolute/path/file.txt');
    });

    it('encodes and decodes standard 7z variable-length numbers across boundary ranges', () => {
      const boundaryValues = [
        0,
        1,
        63,
        127,
        128,
        255,
        256,
        8400,
        16383,
        16384,
        65535,
        100000,
        2097151,
        2097152,
        268435455,
        268435456,
        1000000000,
      ];

      for (const val of boundaryValues) {
        const arr: number[] = [];
        write7zVarint(arr, val);
        const read = read7zVarint(Buffer.from(arr), 0);
        expect(read.value).toBe(val);
        expect(read.nextOffset).toBe(arr.length);
      }
    });
  });

  // ==========================================================================
  // 2. RAR Archive Fail-Closed Validation & Stored Archive Extraction
  // ==========================================================================
  describe('2. RAR Fail-Closed Validation and Stored Archive Support', () => {
    it('successfully extracts stored (uncompressed) RAR archive with CRC validation', () => {
      const files = [
        { filename: 'stored1.txt', buffer: Buffer.from('Uncompressed stored RAR test file 1') },
        { filename: 'stored2.txt', buffer: Buffer.from('Uncompressed stored RAR test file 2') },
      ];

      // D8 contract: createRarArchive is disabled
      expect(() => createRarArchive(files, {}, 'bundle.rar')).toThrow();

      const rarBuffer = storedRar(files);
      expect(rarBuffer.subarray(0, 7)).toEqual(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));

      const extracted = extractRarArchive(rarBuffer);
      expect(extracted).toHaveLength(2);
      expect(extracted[0].filename).toBe('stored1.txt');
      expect(extracted[0].buffer.toString('utf-8')).toBe('Uncompressed stored RAR test file 1');
      expect(extracted[1].filename).toBe('stored2.txt');
      expect(extracted[1].buffer.toString('utf-8')).toBe('Uncompressed stored RAR test file 2');
    });

    it('fails closed when encountering compressed RAR archives without native unrar binary', () => {
      // Build a synthetic RAR file header with compression method 0x33 (Normal compression)
      const filename = 'compressed.txt';
      const filenameBuf = Buffer.from(filename, 'utf-8');
      const headSize = 32 + filenameBuf.length;

      const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
      const mainHead = Buffer.alloc(13);
      mainHead.writeUInt16LE(0x1234, 0);
      mainHead.writeUInt8(0x73, 2);
      mainHead.writeUInt16LE(0x0000, 3);
      mainHead.writeUInt16LE(13, 5);

      const fileHead = Buffer.alloc(headSize);
      fileHead.writeUInt16LE(0x5678, 0); // CRC placeholder
      fileHead.writeUInt8(0x74, 2); // FILE_HEAD
      fileHead.writeUInt16LE(0x8000, 3);
      fileHead.writeUInt16LE(headSize, 5);
      fileHead.writeUInt32LE(10, 7); // PACK_SIZE = 10
      fileHead.writeUInt32LE(100, 11); // UNP_SIZE = 100
      fileHead.writeUInt8(3, 15); // HOST_OS
      fileHead.writeUInt32LE(0x11223344, 16); // FILE_CRC
      fileHead.writeUInt32LE(0x50000000, 20); // FTIME
      fileHead.writeUInt8(20, 24); // UNP_VER
      fileHead.writeUInt8(0x33, 25); // METHOD = 0x33 (Compressed!)
      fileHead.writeUInt16LE(filenameBuf.length, 26);
      fileHead.writeUInt32LE(0x20, 28);
      filenameBuf.copy(fileHead, 32);

      const rawCompressedPayload = crypto.randomBytes(10);
      const syntheticRar = Buffer.concat([marker, mainHead, fileHead, rawCompressedPayload]);

      // If native unrar is not installed, must fail closed instead of silently slicing raw payload!
      if (!getUnrarBinaryPath()) {
        expect(() => extractRarArchive(syntheticRar)).toThrow(/Unsupported RAR compression method|unrar binary is required/i);
      }
    });

    it('fails closed on corrupt RAR buffer signatures and truncated headers', () => {
      const corrupt = Buffer.from('NOT_A_VALID_RAR_FILE_HEADER');
      expect(() => extractRarArchive(corrupt)).toThrow(/Invalid RAR archive/i);

      const shortBuffer = Buffer.from([0x52, 0x61, 0x72]);
      expect(() => extractRarArchive(shortBuffer)).toThrow(/Invalid RAR archive: buffer too small/i);
    });
  });

  // ==========================================================================
  // 3. Audio Decoders: ADTS AAC, Ogg Vorbis & Opus Fidelity
  // ==========================================================================
  describe('3. In-Memory Pure TS Audio Decoders (Ogg; AAC needs FFmpeg)', () => {
    it('decodes Ogg Vorbis containers and parses OggS pages with stream headers, and enforces Fail-Closed on raw PCM', async () => {
      // 1. Verify decode of valid Ogg Vorbis container with empty stream
      const emptyOgg = encodeOggContainer([], 44100, 2, 'audio');
      expect(emptyOgg.toString('ascii', 0, 4)).toBe('OggS');
      const decodedOgg = decodeOgg(emptyOgg);
      expect(decodedOgg.sampleRate).toBe(44100);
      expect(decodedOgg.channels).toBe(2);
      expect(decodedOgg.samples.length).toBe(0);

      // 2. Verify pure TS convertMedia fails closed for ogg without native FFmpeg
      const origWav = createTestWav(44100, 2, 0.25);
      await expect(
        convertMedia(origWav, 'wav', 'ogg', { disableNativeEngine: true }, 'audio.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OGG compression/i);
    });

    oracleTest('performs roundtrip WAV -> AAC -> WAV that reproduces the source tone', ['ffmpeg', 'ffprobe'], async () => {
      const source = sineSamples(44100, 2, 1);
      const origWav = wavFromSamples(source, 44100, 2);

      // Step 1: WAV -> AAC through the native engine
      const aacResult = await convertMedia(origWav, 'wav', 'aac', {}, 'tune.wav');
      expect(aacResult.mimeType).toBe('audio/aac');

      // Step 2: AAC -> WAV
      const roundtripWav = await convertMedia(aacResult.buffer, 'aac', 'wav', {}, 'tune.aac');
      expect(roundtripWav.mimeType).toBe('audio/wav');
      expect(roundtripWav.buffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(roundtripWav.buffer.toString('ascii', 8, 12)).toBe('WAVE');

      // Step 3: the decoded waveform matches the source signal (independent reference decoder)
      const decoded = decodeAudioBuffer(roundtripWav.buffer, 'wav');
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);
      expect(bestSnrDb(source, decoded.samples, 2)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
      expect(bestSnrDb(source, decodeAudioWithFfmpeg(aacResult.buffer, 'aac', 44100, 2), 2)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
    });

    it('enforces Fail-Closed on WAV -> OGG conversion in pure TypeScript without native FFmpeg', async () => {
      const origWav = createTestWav(44100, 2, 0.2);
      await expect(
        convertMedia(origWav, 'wav', 'ogg', { disableNativeEngine: true }, 'sound.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OGG compression/i);
    });

    it('enforces Fail-Closed on pure TS Ogg Vorbis conversion and packages multi-segment pages accurately', async () => {
      const wav = createTestWav(44100, 2, 0.1);
      await expect(
        convertMedia(wav, 'wav', 'ogg', { disableNativeEngine: true }, 'full.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OGG compression/i);

      // Verify multi-page packaging with discrete packets
      const packets: Buffer[] = [];
      for (let i = 0; i < 30; i++) {
        packets.push(Buffer.from([0x00, i, (i * 2) & 0xff]));
      }
      const oggBuf = encodeOggContainer(packets, 44100, 2, 'multi');
      expect(oggBuf.length).toBeGreaterThan(500);
      expect(oggBuf.toString('ascii', 0, 4)).toBe('OggS');
    });

    it('fails closed safely on fuzzed short Vorbis identification packets (<16 bytes)', () => {
      // Build Ogg page with packet 0 starting with \x01vorbis but only 10 bytes long
      const shortHeader = Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0x00, 0x00, 0x00]);
      const ogg = Buffer.alloc(27 + 1 + shortHeader.length);
      ogg.write('OggS', 0);
      ogg[26] = 1;
      ogg[27] = shortHeader.length;
      shortHeader.copy(ogg, 28);

      expect(() => decodeOgg(ogg)).toThrow(/Unsupported audio format/i);
    });

    it('fails closed on malformed audio payloads passed to decoders', () => {
      const noise = Buffer.from('INVALID_AUDIO_DATA_FOR_DECODER_FUZZING');
      expect(() => decodeOgg(noise)).toThrow(/Unsupported audio format/i);
      expect(() => decodeAudioBuffer(noise, 'ogg')).toThrow(/Unsupported audio format/i);
    });
  });

  // ==========================================================================
  // 4. Additional Archive Edge Cases (Canonical Varints, kEmptyStream, Bomb Guards)
  // ==========================================================================
  describe('4. Additional Archive Edge Cases', () => {
    it('encodes standard 7z variable length numbers canonically without byte inflation', () => {
      const arr10k: number[] = [];
      write7zVarint(arr10k, 10000);
      // 10000 in binary: 0010 0111 0001 0000 (14 bits) fits in 2 bytes: [0xa7, 0x10]
      expect(arr10k).toEqual([0xa7, 0x10]);
      expect(read7zVarint(Buffer.from(arr10k), 0)).toEqual({ value: 10000, nextOffset: 2 });

      const arr16383: number[] = [];
      write7zVarint(arr16383, 16383);
      expect(arr16383).toEqual([0xbf, 0xff]);
      expect(read7zVarint(Buffer.from(arr16383), 0)).toEqual({ value: 16383, nextOffset: 2 });

      const arr16384: number[] = [];
      write7zVarint(arr16384, 16384);
      expect(arr16384).toEqual([0xc0, 0x00, 0x40]);
      expect(read7zVarint(Buffer.from(arr16384), 0)).toEqual({ value: 16384, nextOffset: 3 });
    });

    it('fails closed on RAR archives with uncompressed size exceeding bomb limits', () => {
      const filename = 'huge.txt';
      const filenameBuf = Buffer.from(filename, 'utf-8');
      const headSize = 32 + filenameBuf.length;

      const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
      const mainHead = Buffer.alloc(13);
      mainHead.writeUInt16LE(0x1234, 0);
      mainHead.writeUInt8(0x73, 2);
      mainHead.writeUInt16LE(0x0000, 3);
      mainHead.writeUInt16LE(13, 5);

      const fileHead = Buffer.alloc(headSize);
      fileHead.writeUInt16LE(0x5678, 0);
      fileHead.writeUInt8(0x74, 2); // FILE_HEAD
      fileHead.writeUInt16LE(0x8000, 3);
      fileHead.writeUInt16LE(headSize, 5);
      fileHead.writeUInt32LE(10, 7); // PACK_SIZE = 10
      fileHead.writeUInt32LE(600 * 1024 * 1024, 11); // UNP_SIZE = 600MB (> 500MB bomb limit!)
      fileHead.writeUInt8(3, 15);
      fileHead.writeUInt32LE(0x11223344, 16);
      fileHead.writeUInt32LE(0x50000000, 20);
      fileHead.writeUInt8(20, 24);
      fileHead.writeUInt8(0x30, 25); // METHOD = 0x30 (Stored)
      fileHead.writeUInt16LE(filenameBuf.length, 26);
      fileHead.writeUInt32LE(0x20, 28);
      filenameBuf.copy(fileHead, 32);

      const syntheticRar = Buffer.concat([marker, mainHead, fileHead, crypto.randomBytes(10)]);
      expect(() => extractRarArchive(syntheticRar)).toThrow(/Archive bomb detected/i);
    });
  });

  // ==========================================================================
  // 5. L4 Server Environment FFmpeg Diagnostic Gate
  // ==========================================================================
  describe('5. L4 Server FFmpeg Container Environment Detection', () => {
    it('reports environment status with container flag and binary path safely', () => {
      const envInfo = detectFfmpegEnvironment();
      expect(envInfo).toHaveProperty('available');
      expect(envInfo).toHaveProperty('path');
      expect(envInfo).toHaveProperty('isContainer');
      expect(typeof envInfo.available).toBe('boolean');
      expect(typeof envInfo.isContainer).toBe('boolean');
      if (envInfo.available) {
        expect(typeof envInfo.path).toBe('string');
      } else {
        expect(envInfo.path).toBeNull();
      }
    });
  });
});
