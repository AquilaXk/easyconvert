import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { convertArchive, extractZipArchive, extractTarArchive } from '../src/lib/conversions/archive';
import { buildFfmpegArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { convertMedia, LOSSY_PSYCHOACOUSTIC_FORMATS } from '../src/lib/conversions/media';
import { ConversionFailedError } from '../src/lib/types';
import { compressWithZstdDict, decompressWithZstdDict, DATA_DICTIONARY_JSON_CSV } from '../src/lib/conversions/zstd-dict';
import { compressLzma, compressLzma2 } from '../src/lib/conversions/lzma-encoder';
import { decompressLzma, decompressLzma2 } from '../src/lib/conversions/archive';

describe('Phase 2: Media & Archive Fail-Closed & Spec Parity (#141)', () => {
  // ==========================================================================
  // 1. Media Dimension Normalization & Fail-Closed Checks
  // ==========================================================================
  describe('1. Media Video Dimension Normalization & Fail-Closed', () => {
    it('normalizes odd video dimensions with scale=trunc(iw/2)*2:trunc(ih/2)*2 and pix_fmt yuv420p', () => {
      const args = buildFfmpegArguments('/tmp/sample.avi', '/tmp/output.mp4', 'avi', 'mp4', {
        videoCodec: 'h264',
      });

      expect(args).toContain('-vf');
      expect(args).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      expect(args).toContain('-pix_fmt');
      expect(args).toContain('yuv420p');
    });

    it('preserves explicit resolution while adding video transcoding flags', () => {
      const args = buildFfmpegArguments('/tmp/sample.avi', '/tmp/output.mp4', 'avi', 'mp4', {
        videoCodec: 'h264',
        videoResolution: '720p',
      });

      expect(args).toContain('-vf');
      expect(args).toContain('scale=1280:720:force_original_aspect_ratio=decrease');
      expect(args).toContain('-pix_fmt');
      expect(args).toContain('yuv420p');
    });

    it('strictly fails closed for lossy formats when native engine is disabled', async () => {
      const sampleWav = Buffer.alloc(44);
      sampleWav.write('RIFF', 0, 'ascii');
      sampleWav.writeUInt32LE(36, 4);
      sampleWav.write('WAVE', 8, 'ascii');
      sampleWav.write('fmt ', 12, 'ascii');
      sampleWav.writeUInt32LE(16, 16);
      sampleWav.writeUInt16LE(1, 20); // PCM
      sampleWav.writeUInt16LE(1, 22); // Mono
      sampleWav.writeUInt32LE(44100, 24);
      sampleWav.writeUInt32LE(88200, 28);
      sampleWav.writeUInt16LE(2, 32);
      sampleWav.writeUInt16LE(16, 34);
      sampleWav.write('data', 36, 'ascii');
      sampleWav.writeUInt32LE(0, 40);

      for (const lossyFmt of ['opus', 'ogg', 'aac', 'mp4']) {
        await expect(
          convertMedia(sampleWav, 'wav', lossyFmt, { disableNativeEngine: true }, 'test.wav')
        ).rejects.toThrow(ConversionFailedError);
      }
    });

  });

  // ==========================================================================
  // 2. Archive Fail-Closed Protection Against Corrupt Archives
  // ==========================================================================
  describe('2. Archive Fail-Closed Protection on Corrupt Streams', () => {
    it('strictly throws ConversionFailedError on corrupt ZIP input without falling open', async () => {
      const corruptZip = Buffer.from('PK\x03\x04CORRUPTED_ZIP_GARBAGE_PAYLOAD');

      await expect(
        convertArchive(corruptZip, 'zip', 'tar', {}, 'corrupted.zip')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('strictly throws ConversionFailedError on corrupt TAR input', async () => {
      const corruptTar = Buffer.from('NOT_A_VALID_TAR_FILE_AT_ALL_JUST_RANDOM_BYTES');

      await expect(
        convertArchive(corruptTar, 'tar', 'zip', {}, 'corrupted.tar')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('strictly throws ConversionFailedError on corrupt GZ input', async () => {
      const corruptGz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff]);

      await expect(
        convertArchive(corruptGz, 'gz', 'tar', {}, 'corrupted.gz')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('strictly throws ConversionFailedError on corrupt BZ2 input', async () => {
      const corruptBz2 = Buffer.from([0x42, 0x5a, 0x68, 0x39, 0x00, 0x00, 0x00]);

      await expect(
        convertArchive(corruptBz2, 'bz2', 'zip', {}, 'corrupted.bz2')
      ).rejects.toThrow(ConversionFailedError);
    });
  });

  // ==========================================================================
  // 3. RFC 8878 Zstandard Frame & 0-Byte LZMA Handling
  // ==========================================================================
  describe('3. RFC 8878 Zstd Frame & Compliant 0-Byte LZMA Handling', () => {
    it('encodes RFC 8878 compliant Zstandard frame without proprietary DICT_ESC tokens', () => {
      const sample = Buffer.from('{"status":"ok","code":200,"message":"success","id":42}');
      const compressed = compressWithZstdDict(sample, DATA_DICTIONARY_JSON_CSV);

      // Verify magic number 0xFD2FB528
      expect(compressed.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));

      // Verify no proprietary DICT_ESC (0x1B) tokens were injected into payload
      // Offsets: magic (4) + FHD (1) + FCS (1) + DictID (4) = 10
      const blockHeader = compressed.subarray(10, 13);
      const headerVal = blockHeader[0] | (blockHeader[1] << 8) | (blockHeader[2] << 16);
      const blockType = (headerVal >> 1) & 0x03;
      expect(blockType).toBe(0); // Raw block per RFC 8878

      // Lossless round-trip
      const decompressed = decompressWithZstdDict(compressed, DATA_DICTIONARY_JSON_CSV);
      expect(decompressed.toString('utf-8')).toBe(sample.toString('utf-8'));
    });

    it('handles 0-byte streams compliantly in LZMA and LZMA2 encoders and decoders', () => {
      const empty = Buffer.alloc(0);

      // LZMA
      const lzmaRes = compressLzma(empty);
      expect(lzmaRes.uncompressedSize).toBe(0);
      expect(lzmaRes.props.length).toBe(5);
      const lzmaDec = decompressLzma(lzmaRes.buffer, lzmaRes.props, 0);
      expect(lzmaDec.length).toBe(0);

      // LZMA2
      const lzma2Res = compressLzma2(empty);
      expect(lzma2Res.uncompressedSize).toBe(0);
      expect(lzma2Res.buffer).toEqual(Buffer.from([0x00])); // EOS
      const lzma2Dec = decompressLzma2(lzma2Res.buffer, lzma2Res.props, 0);
      expect(lzma2Dec.length).toBe(0);
    });
  });
});
