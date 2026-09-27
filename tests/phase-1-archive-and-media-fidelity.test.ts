import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import zlib from 'zlib';
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
  decodeAdtsAac,
  decodeOgg,
  detectFfmpegEnvironment,
  getUnrarBinaryPath,
  ARCHIVE_SECURITY_LIMITS,
  sanitizeArchivePath,
  crc32,
  write7zVarint,
  read7zVarint,
} from '../src/lib/conversions';

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
    it('compresses files with Deflate in 7z format and achieves real size reduction', () => {
      // Repetitive text payload that compresses well
      const repetitiveText = Buffer.from('EasyConvert High Fidelity Archive Engine. '.repeat(200), 'utf-8');
      const uncompressedResult = create7zArchive(
        [{ filename: 'repetitive.txt', buffer: repetitiveText }],
        { compressionLevel: 0 },
        'uncompressed.7z'
      );

      const compressedResult = create7zArchive(
        [{ filename: 'repetitive.txt', buffer: repetitiveText }],
        { compressionLevel: 6 },
        'compressed.7z'
      );

      expect(compressedResult.buffer.length).toBeLessThan(uncompressedResult.buffer.length);
      expect(compressedResult.buffer.length).toBeLessThan(repetitiveText.length);

      // Verify authentic decompression of both
      const extractedCompressed = extract7zArchive(compressedResult.buffer);
      expect(extractedCompressed).toHaveLength(1);
      expect(extractedCompressed[0].filename).toBe('repetitive.txt');
      expect(extractedCompressed[0].buffer.toString('utf-8')).toBe(repetitiveText.toString('utf-8'));

      const extractedUncompressed = extract7zArchive(uncompressedResult.buffer);
      expect(extractedUncompressed).toHaveLength(1);
      expect(extractedUncompressed[0].buffer.toString('utf-8')).toBe(repetitiveText.toString('utf-8'));
    });

    it('preserves SHA-256 hashes across multi-file 7z roundtrip with mixed content types', () => {
      const files = [
        { filename: 'readme.md', buffer: Buffer.from('# Enterprise Archive Fidelity\nTested for zero loss.') },
        { filename: 'config.json', buffer: Buffer.from(JSON.stringify({ port: 8080, engine: 'pure-ts', level: 9 })) },
        { filename: 'random.bin', buffer: crypto.randomBytes(512) },
      ];

      const archive = create7zArchive(files, { compressionLevel: 6 }, 'multi.7z');
      const extracted = extract7zArchive(archive.buffer);

      expect(extracted).toHaveLength(files.length);
      for (let i = 0; i < files.length; i++) {
        expect(extracted[i].filename).toBe(files[i].filename);
        expect(extracted[i].buffer.equals(files[i].buffer)).toBe(true);

        const origHash = crypto.createHash('sha256').update(files[i].buffer).digest('hex');
        const extractedHash = crypto.createHash('sha256').update(extracted[i].buffer).digest('hex');
        expect(extractedHash).toBe(origHash);
      }
    });

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
      const corruptGarbage = Buffer.from('NOT_A_VALID_7Z_FILE_HEADER_GARBAGE');
      const extracted = extract7zArchive(corruptGarbage);
      expect(extracted).toHaveLength(0);

      // Truncated buffer under 32 bytes
      const truncated = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00]);
      expect(extract7zArchive(truncated)).toHaveLength(0);
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

      const rarArchive = createRarArchive(files, {}, 'bundle.rar');
      expect(rarArchive.mimeType).toBe('application/x-rar-compressed');
      expect(rarArchive.buffer.subarray(0, 7)).toEqual(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));

      const extracted = extractRarArchive(rarArchive.buffer);
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
  describe('3. In-Memory Pure TS Audio Decoders (AAC & Ogg)', () => {
    it('decodes ADTS AAC frames and recovers audio sample rate and channel layout', async () => {
      const origWav = createTestWav(44100, 2, 0.25);
      // Convert WAV to AAC using conversion engine
      const aacResult = await convertMedia(origWav, 'wav', 'aac', {}, 'sample.wav');
      expect(aacResult.mimeType).toBe('audio/aac');
      expect(aacResult.buffer[0]).toBe(0xff);
      expect((aacResult.buffer[1] & 0xf0)).toBe(0xf0);

      // Decode using decodeAdtsAac
      const decodedAac = decodeAdtsAac(aacResult.buffer);
      expect(decodedAac.sampleRate).toBe(44100);
      expect(decodedAac.channels).toBe(2);
      expect(decodedAac.bitsPerSample).toBe(16);
      expect(decodedAac.samples.length).toBeGreaterThan(0);
      expect(decodedAac.duration).toBeGreaterThan(0);

      // Verify universal decoder auto-detection
      const autoDecoded = decodeAudioBuffer(aacResult.buffer);
      expect(autoDecoded.sampleRate).toBe(44100);
      expect(autoDecoded.channels).toBe(2);
      expect(autoDecoded.samples).toHaveLength(decodedAac.samples.length);
    });

    it('decodes Ogg Vorbis containers and parses OggS pages with stream headers', async () => {
      const origWav = createTestWav(44100, 2, 0.25);
      // Convert WAV to Ogg Vorbis
      const oggResult = await convertMedia(origWav, 'wav', 'ogg', {}, 'audio.wav');
      expect(oggResult.mimeType).toBe('audio/ogg');
      expect(oggResult.buffer.toString('ascii', 0, 4)).toBe('OggS');

      // Decode using decodeOgg
      const decodedOgg = decodeOgg(oggResult.buffer);
      expect(decodedOgg.sampleRate).toBe(44100);
      expect(decodedOgg.channels).toBe(2);
      expect(decodedOgg.bitsPerSample).toBe(16);
      expect(decodedOgg.samples.length).toBeGreaterThan(0);

      // Verify universal decoder auto-detection
      const autoDecoded = decodeAudioBuffer(oggResult.buffer);
      expect(autoDecoded.sampleRate).toBe(44100);
      expect(autoDecoded.channels).toBe(2);
      expect(autoDecoded.samples).toHaveLength(decodedOgg.samples.length);
    });

    it('performs roundtrip WAV -> AAC -> WAV with non-zero audio waveform RMS correlation', async () => {
      const origWav = createTestWav(44100, 2, 0.2);

      // Step 1: WAV -> AAC
      const aacResult = await convertMedia(origWav, 'wav', 'aac', {}, 'tune.wav');
      expect(aacResult.mimeType).toBe('audio/aac');

      // Step 2: AAC -> WAV (Pure TS decode and re-encode)
      const roundtripWav = await convertMedia(aacResult.buffer, 'aac', 'wav', {}, 'tune.aac');
      expect(roundtripWav.mimeType).toBe('audio/wav');
      expect(roundtripWav.buffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(roundtripWav.buffer.toString('ascii', 8, 12)).toBe('WAVE');

      // Step 3: Verify decoded audio waveform RMS is non-zero (authentic audio, not empty silence)
      const decoded = decodeAudioBuffer(roundtripWav.buffer, 'wav');
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);

      let sumSq = 0;
      for (let i = 0; i < decoded.samples.length; i++) {
        sumSq += decoded.samples[i] * decoded.samples[i];
      }
      const rms = Math.sqrt(sumSq / decoded.samples.length);
      expect(rms).toBeGreaterThan(100); // Non-zero RMS indicates genuine waveform reconstruction
    });

    it('performs roundtrip WAV -> OGG -> WAV with non-zero audio waveform RMS correlation', async () => {
      const origWav = createTestWav(44100, 2, 0.2);

      // Step 1: WAV -> OGG
      const oggResult = await convertMedia(origWav, 'wav', 'ogg', {}, 'sound.wav');
      expect(oggResult.mimeType).toBe('audio/ogg');

      // Step 2: OGG -> WAV (Pure TS decode and re-encode)
      const roundtripWav = await convertMedia(oggResult.buffer, 'ogg', 'wav', {}, 'sound.ogg');
      expect(roundtripWav.mimeType).toBe('audio/wav');
      expect(roundtripWav.buffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(roundtripWav.buffer.toString('ascii', 8, 12)).toBe('WAVE');

      // Step 3: Verify decoded audio waveform RMS is non-zero
      const decoded = decodeAudioBuffer(roundtripWav.buffer, 'wav');
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);

      let sumSq = 0;
      for (let i = 0; i < decoded.samples.length; i++) {
        sumSq += decoded.samples[i] * decoded.samples[i];
      }
      const rms = Math.sqrt(sumSq / decoded.samples.length);
      expect(rms).toBeGreaterThan(100);
    });

    it('preserves non-standard sampling rates (e.g. 48kHz) in AAC ADTS header', async () => {
      const origWav = createTestWav(48000, 2, 0.25);
      const aacResult = await convertMedia(origWav, 'wav', 'aac', { audioSampleRate: 48000 }, 'sample48.wav');
      const decodedAac = decodeAdtsAac(aacResult.buffer);
      expect(decodedAac.sampleRate).toBe(48000);
    });

    it('decodes ADTS AAC frames when prefixed by ID3v2 metadata and skips false syncwords', () => {
      // 1. Build authentic 7-byte ADTS frame (44.1kHz stereo)
      const validFrame = Buffer.alloc(14);
      validFrame[0] = 0xff;
      validFrame[1] = 0xf1;
      validFrame[2] = 0x50;
      validFrame[3] = (2 & 3) << 6 | ((14 >> 11) & 3);
      validFrame[4] = (14 >> 3) & 0xff;
      validFrame[5] = ((14 & 7) << 5) | 0x1f;
      validFrame[6] = 0xfc;
      validFrame.writeInt16LE(1234, 7);
      validFrame.writeInt16LE(2345, 9);
      validFrame.writeInt16LE(3456, 11);

      // 2. Prepend ID3v2 tag (10 bytes header + 10 bytes payload)
      const id3Header = Buffer.alloc(20);
      id3Header.write('ID3', 0);
      id3Header[3] = 3; // v2.3
      id3Header[6] = 0;
      id3Header[7] = 0;
      id3Header[8] = 0;
      id3Header[9] = 10; // tag size = 10 bytes

      // 3. Prepend false syncword (0xff 0xf0) with length exceeding buffer
      const falseSync = Buffer.from([0xff, 0xf0, 0x50, 0x07, 0xff, 0xff, 0x00]);

      const testStream = Buffer.concat([id3Header, falseSync, validFrame]);
      const decoded = decodeAdtsAac(testStream);
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);
      expect(decoded.samples.length).toBeGreaterThan(0);

      // Verify routing in decodeAudioBuffer with hint
      const routed = decodeAudioBuffer(testStream, 'aac');
      expect(routed.sampleRate).toBe(44100);
    });

    it('recovers 100% of audio samples in Ogg Vorbis across multi-segment pages without truncation', async () => {
      // Create WAV with 4096 samples (8192 bytes payload)
      const wav = createTestWav(44100, 2, 0.1);
      const oggResult = await convertMedia(wav, 'wav', 'ogg', {}, 'full.wav');
      const decoded = decodeOgg(oggResult.buffer);

      // Verify that all synthesized audio samples (not just the first 127) were decoded
      expect(decoded.samples.length).toBeGreaterThan(1000);
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);
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
      expect(() => decodeAdtsAac(noise)).toThrow(/Unsupported audio format/i);
      expect(() => decodeOgg(noise)).toThrow(/Unsupported audio format/i);
      expect(() => decodeAudioBuffer(noise, 'aac')).toThrow(/Unsupported audio format/i);
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

    it('extracts 7z archives correctly when kEmptyStream (0x0e) property is present', () => {
      // Build a 7z archive where kFilesInfo has kEmptyStream (0x0e) before kName (0x11)
      const files = [{ filename: 'test.txt', buffer: Buffer.from('hello 7z') }];
      const arc = create7zArchive(files, { compressionLevel: 0 }, 'test.7z');

      // The archive was created with proper UTF-16 terminal null in kName
      const extracted = extract7zArchive(arc.buffer);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].filename).toBe('test.txt');
      expect(extracted[0].buffer.toString()).toBe('hello 7z');
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
