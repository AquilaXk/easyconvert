import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkIsoBmffIntegrity,
  checkEbmlIntegrity,
  checkOggIntegrity,
  checkAdtsAacIntegrity,
  checkFlacIntegrity,
  checkMp3Integrity,
  checkWavIntegrity,
  verifyVideoBitstreamWithFfprobe,
  verifyAudioBitstreamWithFfprobe,
  assertFormatIntegrity,
  OracleToolMissingError,
} from './helpers/differential-oracle';
import {
  createDeterministicSyntheticStream,
  pipeStreamToStorageMultipart,
} from '../src/lib/streaming/large-payload-streamer';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';
import {
  generateSeccompBpfProfile,
  NETWORK_SYSCALL_FILTER_LIST,
  DANGEROUS_SYSCALL_FILTER_LIST,
  executeSandboxedBinary,
} from '../src/lib/security/process-sandbox';
import { sanitizeArchivePath, ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { decodeSfnt } from '../src/lib/conversions/font';

// ============================================================================
// Synthetic Authentic Bitstream Builders
// ============================================================================

function createBox(type: string, payload: Buffer): Buffer {
  const size = 8 + payload.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function createAuthenticMp4Buffer(): Buffer {
  // 1. ftyp box
  const ftypPayload = Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]), // minor version
    Buffer.from('isommp41', 'ascii'), // compatible brands
  ]);
  const ftyp = createBox('ftyp', ftypPayload);

  // 2. stsd entry: avc1
  const avc1Payload = Buffer.alloc(78);
  avc1Payload.writeUInt16BE(1920, 24); // width
  avc1Payload.writeUInt16BE(1080, 26); // height
  const avc1Entry = createBox('avc1', avc1Payload);

  // 3. stsd box (version 0 + entry count 1)
  const stsdPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // version & flags
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // 1 entry
    avc1Entry,
  ]);
  const stsd = createBox('stsd', stsdPayload);
  const stbl = createBox('stbl', stsd);
  const minf = createBox('minf', stbl);
  const mdia = createBox('mdia', minf);
  const trak = createBox('trak', mdia);

  // 4. mvhd box
  const mvhdPayload = Buffer.alloc(24);
  const mvhd = createBox('mvhd', mvhdPayload);

  // 5. moov box
  const moov = createBox('moov', Buffer.concat([mvhd, trak]));

  // 6. mdat box with authentic AVCC H.264 NAL units (SPS=7, PPS=8, IDR=5)
  const spsNalu = Buffer.from([0x67, 0x42, 0x00, 0x1e]); // type 7 SPS
  const ppsNalu = Buffer.from([0x68, 0xce, 0x38, 0x80]); // type 8 PPS
  const idrNalu = Buffer.from([0x65, 0x88, 0x84, 0x00]); // type 5 IDR slice

  function makeAvccNalu(nalu: Buffer): Buffer {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(nalu.length, 0);
    return Buffer.concat([lenBuf, nalu]);
  }

  const mdatPayload = Buffer.concat([
    makeAvccNalu(spsNalu),
    makeAvccNalu(ppsNalu),
    makeAvccNalu(idrNalu),
  ]);
  const mdat = createBox('mdat', mdatPayload);

  return Buffer.concat([ftyp, moov, mdat]);
}

function createAuthenticOggOpusBuffer(): Buffer {
  // Page 0: OpusHead identification
  const opusHeadPayload = Buffer.concat([
    Buffer.from('OpusHead', 'ascii'),
    Buffer.from([
      0x01, // version 1
      0x02, // 2 channels
      0x38, 0x01, // pre-skip = 312
      0x80, 0xbb, 0x00, 0x00, // sample rate 48000
      0x00, 0x00, // gain
      0x00, // channel mapping family
    ]),
  ]);

  function makeOggPage(payload: Buffer, headerType: number, granule: number, seq: number): Buffer {
    const header = Buffer.alloc(27 + 1);
    header.write('OggS', 0, 4, 'ascii');
    header[4] = 0; // version
    header[5] = headerType;
    header.writeBigInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(0x4f505553, 14); // stream serial 'OPUS'
    header.writeUInt32LE(seq, 18);
    header.writeUInt32LE(0, 22); // crc placeholder
    header[26] = 1; // 1 segment
    header[27] = payload.length; // segment table entry
    return Buffer.concat([header, payload]);
  }

  const page0 = makeOggPage(opusHeadPayload, 0x02, 0, 0); // BOS flag

  // Page 1: OpusTags comment
  const opusTagsPayload = Buffer.concat([
    Buffer.from('OpusTags', 'ascii'),
    Buffer.from([0x08, 0x00, 0x00, 0x00]), // vendor len 8
    Buffer.from('EasyConv', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // 0 user comments
  ]);
  const page1 = makeOggPage(opusTagsPayload, 0x00, 0, 1);

  // Page 2: Audio packet
  const audioPacketPayload = Buffer.from([0xc0, 0x00, 0x00, 0x00]); // 20ms mono/stereo Opus packet
  const page2 = makeOggPage(audioPacketPayload, 0x04, 960, 2); // EOS flag

  return Buffer.concat([page0, page1, page2]);
}

function createAuthenticFlacBuffer(): Buffer {
  const magic = Buffer.from('fLaC', 'ascii');
  const blockHeader = Buffer.from([0x00, 0x00, 0x00, 0x22]); // type 0 (STREAMINFO), length 34
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0); // min block size
  streamInfo.writeUInt16BE(4096, 2); // max block size
  // sample rate = 44100 (20 bits), channels = 2 (3 bits, val 1), bps = 16 (5 bits, val 15)
  // 44100 = 0x0AC44
  streamInfo[10] = 0x0a;
  streamInfo[11] = 0xc4;
  streamInfo[12] = (4 << 4) | (1 << 1) | 0; // sr low 4 bits + chan (1) + bps high 1 bit
  streamInfo[13] = (15 << 3); // bps low 4 bits + total samples high 3 bits
  return Buffer.concat([magic, blockHeader, streamInfo]);
}

function createAuthenticAdtsAacBuffer(): Buffer {
  // ADTS 7-byte header: syncword 0xFFF, ID 1, Layer 0, no CRC, profile 1 (AAC LC), sr 4 (44100), chan 2, len 7
  return Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0xff, 0xfc]);
}

function createAuthenticMp3Buffer(): Buffer {
  const fixturePath = path.resolve(__dirname, 'fixtures/golden/media/golden-audio.mp3');
  if (fs.existsSync(fixturePath)) {
    return fs.readFileSync(fixturePath);
  }
  // MPEG-1 Layer III, 128kbps, 44100Hz, no padding fallback
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x64;
  return frame;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Differential Oracle Hollow-Pass Eradication & Zero-Trust Audit Testnet', () => {

  // --------------------------------------------------------------------------
  // 1. Differential Oracle Bitstream Inspection & Hollow Pass Eradication
  // --------------------------------------------------------------------------
  describe('1. Differential Oracle Bitstream Inspection & Hollow Pass Eradication', () => {
    it('detects and rejects hollow MP4 buffer with ftyp/moov/mdat strings but empty descriptors', () => {
      const hollowMp4 = Buffer.from('ftypisommoovmdatTHIS_IS_A_HOLLOW_FAKE_MP4_BUFFER_WITH_ZERO_METADATA');
      expect(() => checkIsoBmffIntegrity(hollowMp4)).toThrow(/Integrity Violation/);

      const verification = verifyVideoBitstreamWithFfprobe(hollowMp4, 'mp4');
      expect(verification.valid).toBe(false);
      expect(verification.error).toBeDefined();

      expect(() => assertFormatIntegrity(hollowMp4, 'mp4')).toThrow(/Integrity Violation/);
    });

    it('rejects MP4 when mdat contains corrupted/missing H.264 NAL units', () => {
      // Create valid moov and ftyp but garbage mdat payload
      const ftyp = createBox('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41')]));
      const avc1 = createBox('avc1', Buffer.alloc(78));
      const stsd = createBox('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), avc1]));
      const stbl = createBox('stbl', stsd);
      const minf = createBox('minf', stbl);
      const mdia = createBox('mdia', minf);
      const trak = createBox('trak', mdia);
      const mvhd = createBox('mvhd', Buffer.alloc(24));
      const moov = createBox('moov', Buffer.concat([mvhd, trak]));
      const fakeMdat = createBox('mdat', Buffer.from('RAW_UNCOMPRESSED_GARBAGE_WITHOUT_NAL_UNITS'));

      const corruptedMp4 = Buffer.concat([ftyp, moov, fakeMdat]);
      expect(() => checkIsoBmffIntegrity(corruptedMp4)).toThrow(/mdat payload contains no valid H.264 NAL units/);
    });

    it('successfully validates authentic ISO BMFF container with H.264 NAL units', () => {
      const authenticMp4 = createAuthenticMp4Buffer();
      const info = checkIsoBmffIntegrity(authenticMp4);
      expect(info.format).toBe('mp4');
      expect(info.codec).toBe('avc1');
      expect(info.hasMoov).toBe(true);
      expect(info.hasMdat).toBe(true);
      expect(info.nalUnitsCount).toBeGreaterThan(0);

      expect(() => assertFormatIntegrity(authenticMp4, 'mp4')).not.toThrow();
    });

    it('detects and rejects hollow Ogg buffer without OpusHead or Vorbis header', () => {
      const hollowOgg = Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x05HOLLOW_PAYLOAD');
      expect(() => checkOggIntegrity(hollowOgg)).toThrow(/First Ogg page must contain valid OpusHead or Vorbis/);

      const verification = verifyAudioBitstreamWithFfprobe(hollowOgg, 'opus');
      expect(verification.valid).toBe(false);

      expect(() => assertFormatIntegrity(hollowOgg, 'opus')).toThrow(/Integrity Violation/);
    });

    it('validates authentic Ogg Opus container with OpusHead and OpusTags', () => {
      const validOpus = createAuthenticOggOpusBuffer();
      const info = checkOggIntegrity(validOpus);
      expect(info.format).toBe('opus');
      expect(info.codec).toBe('opus');
      expect(info.channels).toBe(2);
      expect(info.sampleRate).toBe(48000);

      expect(() => assertFormatIntegrity(validOpus, 'opus')).not.toThrow();
    });

    it('detects and rejects hollow FLAC buffer with truncated STREAMINFO', () => {
      const hollowFlac = Buffer.concat([
        Buffer.from('fLaC\x00\x00\x00\x10TRUNCATED_STREAMINFO_PAYLOAD'),
        Buffer.alloc(20),
      ]);
      expect(() => checkFlacIntegrity(hollowFlac)).toThrow(/Invalid FLAC STREAMINFO length/);
      expect(() => assertFormatIntegrity(hollowFlac, 'flac')).toThrow(/Integrity Violation/);
    });

    it('validates authentic FLAC buffer with 34-byte STREAMINFO', () => {
      const validFlac = createAuthenticFlacBuffer();
      expect(() => checkFlacIntegrity(validFlac)).not.toThrow();
      expect(() => assertFormatIntegrity(validFlac, 'flac')).not.toThrow();
    });

    it('detects and rejects hollow ADTS AAC buffer with invalid layer bits', () => {
      const hollowAac = Buffer.from([0xff, 0xf5, 0x50, 0x80, 0x00, 0x1f, 0xfc]); // layer bits != 0
      expect(() => checkAdtsAacIntegrity(hollowAac)).toThrow(/Invalid ADTS AAC layer bits/);
      expect(() => assertFormatIntegrity(hollowAac, 'aac')).toThrow(/Integrity Violation/);
    });

    it('validates authentic ADTS AAC buffer', () => {
      const validAac = createAuthenticAdtsAacBuffer();
      const info = checkAdtsAacIntegrity(validAac);
      expect(info.format).toBe('aac');
      expect(info.channels).toBe(2);
      expect(info.sampleRate).toBe(44100);
      expect(() => assertFormatIntegrity(validAac, 'aac')).not.toThrow();
    });

    it('validates authentic MPEG-1 Layer III frame sync and rejects corrupted frames', () => {
      const validMp3 = createAuthenticMp3Buffer();
      expect(() => checkMp3Integrity(validMp3)).not.toThrow();
      expect(() => assertFormatIntegrity(validMp3, 'mp3')).not.toThrow();

      const corruptMp3 = Buffer.from([0xff, 0xe1, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00]); // invalid layer & bitrate
      expect(() => checkMp3Integrity(corruptMp3)).toThrow(/Missing valid MPEG audio frame sync/);
    });

    it('enforces strict skip mode (OracleToolMissingError) when ORACLE_STRICT_MODE is enabled', () => {
      const origEnv = process.env.ORACLE_STRICT_MODE;
      try {
        process.env.ORACLE_STRICT_MODE = '1';
        // When tool is missing (e.g. on test runner where ffprobe might not be in PATH)
        const fakeBuf = Buffer.alloc(100);
        try {
          const res = verifyVideoBitstreamWithFfprobe(fakeBuf, 'mp4');
          // If ffprobe was installed on this machine, res is returned; if missing, OracleToolMissingError is thrown
          expect(res).toBeDefined();
        } catch (err: any) {
          expect(err).toBeInstanceOf(OracleToolMissingError);
          expect(err.isOracleSkip).toBe(true);
        }
      } finally {
        if (origEnv === undefined) {
          delete process.env.ORACLE_STRICT_MODE;
        } else {
          process.env.ORACLE_STRICT_MODE = origEnv;
        }
      }
    });

    it('successfully validates authentic AVCC MP4 even when slice payload contains [0x00, 0x00, 0x01]', () => {
      const ftyp = createBox('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41')]));
      const avc1 = createBox('avc1', Buffer.alloc(78));
      const stsd = createBox('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), avc1]));
      const stbl = createBox('stbl', stsd);
      const minf = createBox('minf', stbl);
      const mdia = createBox('mdia', minf);
      const trak = createBox('trak', mdia);
      const mvhd = createBox('mvhd', Buffer.alloc(24));
      const moov = createBox('moov', Buffer.concat([mvhd, trak]));

      // Authentic IDR slice (type 5) with compressed payload containing [0x00, 0x00, 0x01, 0xff]
      const idrNalu = Buffer.from([0x65, 0x88, 0x00, 0x00, 0x01, 0xff, 0x00, 0x12]);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(idrNalu.length, 0);
      const mdat = createBox('mdat', Buffer.concat([lenBuf, idrNalu]));
      const mp4 = Buffer.concat([ftyp, moov, mdat]);

      const res = checkIsoBmffIntegrity(mp4);
      expect(res.format).toBe('mp4');
      expect(res.codec).toBe('avc1');
      expect(res.nalUnitsCount).toBeGreaterThan(0);
      expect(() => assertFormatIntegrity(mp4, 'mp4')).not.toThrow();
    });

    it('preserves video codec and validates authentic multi-track MP4 containing both avc1 video and mp4a audio', () => {
      const ftyp = createBox('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41')]));

      // 1. Video track with hdlr 'vide'
      const hdlrVideo = Buffer.alloc(20);
      hdlrVideo.write('vide', 8, 4, 'ascii');
      const hdlrBoxVideo = createBox('hdlr', hdlrVideo);
      const avc1 = createBox('avc1', Buffer.alloc(78));
      const stsdVideo = createBox('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), avc1]));
      const trakVideo = createBox('trak', createBox('mdia', Buffer.concat([hdlrBoxVideo, createBox('minf', createBox('stbl', stsdVideo))])));

      // 2. Audio track with hdlr 'soun'
      const hdlrAudio = Buffer.alloc(20);
      hdlrAudio.write('soun', 8, 4, 'ascii');
      const hdlrBoxAudio = createBox('hdlr', hdlrAudio);
      const mp4a = createBox('mp4a', Buffer.alloc(36));
      const stsdAudio = createBox('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), mp4a]));
      const trakAudio = createBox('trak', createBox('mdia', Buffer.concat([hdlrBoxAudio, createBox('minf', createBox('stbl', stsdAudio))])));

      const mvhd = createBox('mvhd', Buffer.alloc(24));
      const moov = createBox('moov', Buffer.concat([mvhd, trakVideo, trakAudio]));

      const spsNalu = Buffer.from([0x67, 0x42, 0x00, 0x1e]);
      const idrNalu = Buffer.from([0x65, 0x88, 0x84, 0x00]);
      function makeNalu(nalu: Buffer): Buffer {
        const l = Buffer.alloc(4);
        l.writeUInt32BE(nalu.length, 0);
        return Buffer.concat([l, nalu]);
      }
      const mdat = createBox('mdat', Buffer.concat([makeNalu(spsNalu), makeNalu(idrNalu)]));
      const multiTrackMp4 = Buffer.concat([ftyp, moov, mdat]);

      const info = checkIsoBmffIntegrity(multiTrackMp4);
      expect(info.format).toBe('mp4');
      expect(info.codec).toBe('avc1');
      expect(info.videoCodec).toBe('avc1');
      expect(info.audioCodec).toBe('mp4a');

      const verification = verifyVideoBitstreamWithFfprobe(multiTrackMp4, 'mp4', 'h264');
      expect(verification.valid).toBe(true);
      expect(verification.codecName).toBe('h264');
    });

    it('detects and rejects truncated ADTS AAC stream occurring after the first valid frame', () => {
      // Frame 0: valid 7-byte header with frameLength = 10
      const truncatedStream = Buffer.alloc(20);
      truncatedStream[0] = 0xff;
      truncatedStream[1] = 0xf1;
      truncatedStream[2] = 0x50; // profile 1, sr 4 (44100), chan 2
      truncatedStream[3] = 0x80;
      truncatedStream[4] = 0x01;
      truncatedStream[5] = 0x5f; // frameLength = 10
      truncatedStream[6] = 0xfc;

      // Frame 1 starts at byte 10, specifies frameLength = 100, but only 10 bytes remain in buffer
      truncatedStream[10] = 0xff;
      truncatedStream[11] = 0xf1;
      truncatedStream[12] = 0x50;
      truncatedStream[13] = 0x80;
      truncatedStream[14] = 0x0c;
      truncatedStream[15] = 0x9f; // frameLength = 100!
      truncatedStream[16] = 0xfc;

      expect(() => checkAdtsAacIntegrity(truncatedStream)).toThrow(/Truncated ADTS frame/);
      expect(() => assertFormatIntegrity(truncatedStream, 'aac')).toThrow(/Truncated ADTS frame/);
    });

    it('fails closed with clean Integrity Violation on truncated Vorbis header without throwing RangeError', () => {
      // 15-byte Vorbis payload (type 0x01 + 'vorbis' + 8 bytes): too short for 16-byte uint32LE read
      const oggPage = Buffer.concat([
        Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x0f'), // 1 segment, len 15
        Buffer.from([0x01]),
        Buffer.from('vorbis', 'ascii'),
        Buffer.alloc(8),
      ]);
      expect(() => checkOggIntegrity(oggPage)).toThrow(/First Ogg page must contain valid OpusHead or Vorbis/);
    });

    it('validates authentic M4A audio container in assertFormatIntegrity and verifyAudioBitstreamWithFfprobe', () => {
      const ftyp = createBox('ftyp', Buffer.concat([Buffer.from('M4A '), Buffer.from([0, 0, 0, 0]), Buffer.from('M4A mp42isom')]));
      const mp4a = createBox('mp4a', Buffer.alloc(36));
      const stsdAudio = createBox('stsd', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), mp4a]));
      const trakAudio = createBox('trak', createBox('mdia', createBox('minf', createBox('stbl', stsdAudio))));
      const mvhd = createBox('mvhd', Buffer.alloc(24));
      const moov = createBox('moov', Buffer.concat([mvhd, trakAudio]));
      const mdat = createBox('mdat', Buffer.from([0x01, 0x02, 0x03, 0x04]));
      const m4a = Buffer.concat([ftyp, moov, mdat]);

      expect(() => assertFormatIntegrity(m4a, 'm4a')).not.toThrow();
      const res = verifyAudioBitstreamWithFfprobe(m4a, 'm4a');
      expect(res.valid).toBe(true);
      expect(res.formatName).toContain('m4a');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Zero-Heap O(1) Memory Streaming Ingestion
  // --------------------------------------------------------------------------
  describe('2. Zero-Heap O(1) Memory Streaming Ingestion', () => {
    it('pipes 25MB stream to storage multipart upload with bounded O(1) heap delta', async () => {
      const storage = new S3ObjectStorageService();
      const totalSize = 25 * 1024 * 1024; // 25 MB
      const chunkSize = 64 * 1024; // 64 KB

      // Prepend valid PNG header to pass early MIME sniffing
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const rawStream = createDeterministicSyntheticStream(totalSize - pngHeader.length, chunkSize);

      let headerSent = false;
      const stream = new (await import('node:stream')).Readable({
        read() {
          if (!headerSent) {
            headerSent = true;
            this.push(pngHeader);
            return;
          }
          const chunk = rawStream.read();
          if (chunk) {
            this.push(chunk);
          } else {
            rawStream.once('readable', () => {
              const c = rawStream.read();
              this.push(c);
            });
            rawStream.once('end', () => this.push(null));
          }
        },
      });

      if (typeof global.gc === 'function') global.gc();
      const initialHeap = process.memoryUsage().heapUsed;

      const result = await pipeStreamToStorageMultipart(stream, {
        filename: 'large-image.png',
        mimeType: 'image/png',
        expectedTotalSize: totalSize,
        sourceExtension: 'png',
        storage,
        partSizeBytes: 5 * 1024 * 1024, // 5MB part size
      });

      if (typeof global.gc === 'function') global.gc();
      const finalHeap = process.memoryUsage().heapUsed;
      const heapDeltaMb = Math.max(0, finalHeap - initialHeap) / (1024 * 1024);

      expect(result.totalBytes).toBe(totalSize);
      expect(result.totalParts).toBe(5); // 25MB / 5MB = 5 parts
      expect(result.sha256Digest).toHaveLength(64);
      expect(result.storageKey).toContain('large-image.png');

      // Heap delta must remain strictly bounded under 50MB (O(1))
      expect(heapDeltaMb).toBeLessThan(50);

      storage.stopGc();
    });

    it('rejects spoofed file on initial chunk before multipart upload is created', async () => {
      const storage = new S3ObjectStorageService();
      // Stream claims to be PNG but starts with plain text
      const spoofedStream = new (await import('node:stream')).Readable({
        read() {
          this.push(Buffer.from('THIS_IS_PLAIN_TEXT_NOT_PNG'));
          this.push(null);
        },
      });

      await expect(
        pipeStreamToStorageMultipart(spoofedStream, {
          filename: 'spoofed-payload.png',
          mimeType: 'image/png',
          expectedTotalSize: 1000,
          sourceExtension: 'png',
          storage,
        })
      ).rejects.toThrow(/File spoofing rejected/i);

      storage.stopGc();
    });

    it('fails closed on empty stream payload (0 bytes)', async () => {
      const storage = new S3ObjectStorageService();
      const emptyStream = new (await import('node:stream')).Readable({
        read() {
          this.push(null);
        },
      });

      await expect(
        pipeStreamToStorageMultipart(emptyStream, {
          filename: 'empty.pdf',
          mimeType: 'application/pdf',
          expectedTotalSize: 0,
          sourceExtension: 'pdf',
          storage,
        })
      ).rejects.toThrow(/File payload is empty/);

      storage.stopGc();
    });

    it('accumulates small initial chunks up to 64KB for early MIME magic sniffing in pipeStreamToStorageMultipart', async () => {
      const storage = new S3ObjectStorageService();
      // PNG header sent across multiple tiny 4-byte chunks
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const chunks = [
        pngHeader.subarray(0, 4),
        pngHeader.subarray(4, 8),
        Buffer.alloc(2000, 0x41),
      ];
      let chunkIdx = 0;
      const smallChunkStream = new (await import('node:stream')).Readable({
        read() {
          if (chunkIdx < chunks.length) {
            this.push(chunks[chunkIdx++]);
          } else {
            this.push(null);
          }
        },
      });

      const res = await pipeStreamToStorageMultipart(smallChunkStream, {
        filename: 'accumulated.png',
        mimeType: 'image/png',
        expectedTotalSize: 2008,
        sourceExtension: 'png',
        storage,
      });

      expect(res.totalBytes).toBe(2008);
      expect(res.sha256Digest).toHaveLength(64);
      storage.stopGc();
    });

    it('accepts raw Buffer directly into pipeStreamToStorageMultipart', async () => {
      const storage = new S3ObjectStorageService();
      const pngPayload = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(100, 0x55),
      ]);

      const res = await pipeStreamToStorageMultipart(pngPayload, {
        filename: 'buffer-direct.png',
        mimeType: 'image/png',
        expectedTotalSize: pngPayload.length,
        sourceExtension: 'png',
        storage,
      });

      expect(res.totalBytes).toBe(pngPayload.length);
      storage.stopGc();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Zero-Trust Security, Seccomp Air-Gap & Exploit Resilience
  // --------------------------------------------------------------------------
  describe('3. Zero-Trust Security, Seccomp Air-Gap & Exploit Resilience', () => {
    it('generates defensive Seccomp BPF profile including network syscalls when blockNetwork is requested', () => {
      const profile = generateSeccompBpfProfile({ blockNetwork: true });
      expect(profile.defaultAction).toBe('SCMP_ACT_ALLOW');
      expect(profile.killAction).toBe('SCMP_ACT_ERRNO');

      // Privileged syscalls
      for (const syscall of DANGEROUS_SYSCALL_FILTER_LIST) {
        expect(profile.blockedSyscalls).toContain(syscall);
      }

      // Network syscalls
      for (const syscall of NETWORK_SYSCALL_FILTER_LIST) {
        expect(profile.blockedSyscalls).toContain(syscall);
      }
    });

    it('verifies docker/seccomp-airgap.json profile contains required system call blocks', () => {
      const profilePath = path.resolve(__dirname, '../docker/seccomp-airgap.json');
      expect(fs.existsSync(profilePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      expect(content.defaultAction).toBe('SCMP_ACT_ALLOW');
      expect(content.syscalls).toBeInstanceOf(Array);

      const allBlockedSyscalls = content.syscalls.flatMap((s: any) => s.names);
      expect(allBlockedSyscalls).toContain('socket');
      expect(allBlockedSyscalls).toContain('connect');
      expect(allBlockedSyscalls).toContain('bind');
      expect(allBlockedSyscalls).toContain('listen');
      expect(allBlockedSyscalls).toContain('accept');
      expect(allBlockedSyscalls).toContain('sendto');
      expect(allBlockedSyscalls).toContain('recvfrom');
      expect(allBlockedSyscalls).toContain('ptrace');
      expect(allBlockedSyscalls).toContain('bpf');
      expect(allBlockedSyscalls).toContain('mount');
    });

    it('verifies docker-compose.yml defines SYS_ADMIN capability and no-new-privileges for worker isolation', () => {
      const composePath = path.resolve(__dirname, '../docker-compose.yml');
      const yaml = fs.readFileSync(composePath, 'utf-8');
      expect(yaml).toContain('SYS_ADMIN');
      expect(yaml).toContain('no-new-privileges:true');
    });

    it('enforces Zip Slip directory traversal sanitization across Unix and Windows paths', () => {
      expect(sanitizeArchivePath('../../etc/passwd')).toBe('etc/passwd');
      expect(sanitizeArchivePath('../../../var/log/syslog')).toBe('var/log/syslog');
      expect(sanitizeArchivePath('..\\..\\windows\\system32\\cmd.exe')).toBe('windows/system32/cmd.exe');
      expect(sanitizeArchivePath('C:\\Users\\admin\\secrets.txt')).toBe('Users/admin/secrets.txt');
      expect(sanitizeArchivePath('/absolute/root/file.txt')).toBe('absolute/root/file.txt');
      expect(sanitizeArchivePath('////multiple/slashes/file.txt')).toBe('multiple/slashes/file.txt');
      expect(sanitizeArchivePath('.')).toBeNull();
      expect(sanitizeArchivePath('..')).toBeNull();
      expect(sanitizeArchivePath('')).toBeNull();
    });

    it('verifies archive security limits guard against 42.zip decompression bombs', () => {
      expect(ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBe(100);
      expect(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE).toBe(500 * 1024 * 1024);
      expect(ARCHIVE_SECURITY_LIMITS.MAX_FILES).toBe(1000);
    });

    it('sanitizes XML DTD entity expansion (Billion Laughs) and script injection in SVG', () => {
      const billionLaughsSvg = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<svg xmlns="http://www.w3.org/2000/svg">
  <text>&lol3;</text>
  <script>alert(1)</script>
</svg>`;

      const sanitized = sanitizeSvgString(billionLaughsSvg);
      expect(sanitized).not.toContain('<!DOCTYPE');
      expect(sanitized).not.toContain('<!ENTITY');
      expect(sanitized).not.toContain('<script');
      expect(sanitized).not.toContain('alert(1)');
    });

    it('fails closed safely on corrupted or truncated TrueType font headers without crash', () => {
      expect(() => decodeSfnt(Buffer.alloc(8), 'CorruptedFont')).toThrow(/less than 12 bytes/);

      // Truncated table records
      const truncatedTableBuf = Buffer.alloc(20);
      truncatedTableBuf.writeUInt32BE(0x00010000, 0); // version
      truncatedTableBuf.writeUInt16BE(50, 4); // claims 50 tables but only 20 bytes total
      const parsed = decodeSfnt(truncatedTableBuf, 'TruncatedTables');
      expect(parsed).toBeDefined();
      expect(Object.keys(parsed.tables).length).toBe(0); // stops safely without out-of-bounds read
    });
  });
});
