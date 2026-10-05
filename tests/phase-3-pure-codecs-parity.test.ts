import { describe, it, expect } from 'vitest';
import {
  AAC_SWB_OFFSET_1024_48,
  AAC_SCALEFACTOR_CODES,
  AAC_SCALEFACTOR_BITS,
  AAC_SPECTRAL_CODES,
  AAC_SPECTRAL_BITS,
  AAC_SPECTRAL_CODES_1,
  AAC_SPECTRAL_BITS_1,
  AAC_SPECTRAL_CODES_2,
  AAC_SPECTRAL_BITS_2,
  AAC_SPECTRAL_CODES_3,
  AAC_SPECTRAL_BITS_3,
  AAC_SPECTRAL_CODES_4,
  AAC_SPECTRAL_BITS_4,
  AAC_SPECTRAL_CODES_5,
  AAC_SPECTRAL_BITS_5,
  AAC_SPECTRAL_CODES_6,
  AAC_SPECTRAL_BITS_6,
  AAC_SPECTRAL_CODES_7,
  AAC_SPECTRAL_BITS_7,
  AAC_SPECTRAL_CODES_8,
  AAC_SPECTRAL_BITS_8,
  AAC_SPECTRAL_CODES_9,
  AAC_SPECTRAL_BITS_9,
  AAC_SPECTRAL_CODES_10,
  AAC_SPECTRAL_BITS_10,
  AAC_SPECTRAL_CODES_11,
  AAC_SPECTRAL_BITS_11,
  encodeScalefactorDiff,
  decodeScalefactorDiff,
  selectAacCodebook,
  encodeSpectralBand,
  decodeSpectralBand,
} from '../src/lib/conversions/media-aac-tables';
import {
  BitWriter,
  BitReader,
  decodeAacLcFramePayload,
} from '../src/lib/conversions/media-encoder';
import {
  computeOggCrc,
  createOggPage,
  encodeOpusContainer,
  encodeOggContainer,
  convertMedia,
} from '../src/lib/conversions/media';
import {
  decodeAdtsAac,
  decodeOgg,
  decodeAudioBuffer,
} from '../src/lib/conversions/media-decoder';
import { EngineUnavailableError } from '../src/lib/types';
import { adtsStream, silentRawDataBlock } from './helpers/media-lossy-oracle';

function createSineWavBuffer(sampleRate: number, channels: number, durationSec: number): Buffer {
  const totalSamplesPerChannel = Math.floor(sampleRate * durationSec);
  const totalSamples = totalSamplesPerChannel * channels;
  const pcmBytes = totalSamples * 2;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // Audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // Byte rate
  header.writeUInt16LE(channels * 2, 32); // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);

  const data = Buffer.alloc(pcmBytes);
  const freq = 440.0;
  for (let i = 0; i < totalSamplesPerChannel; i++) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 12000);
    for (let c = 0; c < channels; c++) {
      data.writeInt16LE(sample, (i * channels + c) * 2);
    }
  }

  return Buffer.concat([header, data]);
}

describe('Phase 3: Pure TypeScript Codecs Parity (ISO/IEC 13818-7 AAC LC & RFC 7845 Ogg Bitstream)', () => {
  // ==========================================================================
  // 1. ISO/IEC 13818-7 AAC LC Authentic Huffman Tables & Prefix Verification
  // ==========================================================================
  describe('1. ISO/IEC 13818-7 Huffman Codebook Tables & Prefix Integrity', () => {
    it('verifies that Table B.22 scalefactor codebook has exactly 121 entries and satisfies prefix property', () => {
      expect(AAC_SCALEFACTOR_CODES.length).toBe(121);
      expect(AAC_SCALEFACTOR_BITS.length).toBe(121);

      // Verify diff = 0 is index 60 and uses exactly 1 bit (code 0)
      expect(AAC_SCALEFACTOR_BITS[60]).toBe(1);
      expect(AAC_SCALEFACTOR_CODES[60]).toBe(0);

      // Verify prefix-free property across all 121 scalefactor Huffman entries using an independent trie
      interface TrieNode {
        children: [TrieNode | null, TrieNode | null];
        isLeaf: boolean;
      }
      const root: TrieNode = { children: [null, null], isLeaf: false };

      for (let i = 0; i < 121; i++) {
        const code = AAC_SCALEFACTOR_CODES[i];
        const len = AAC_SCALEFACTOR_BITS[i];
        expect(len).toBeGreaterThanOrEqual(1);
        expect(len).toBeLessThanOrEqual(19);

        let cur = root;
        for (let b = len - 1; b >= 0; b--) {
          const bit = (code >> b) & 1;
          // If we encounter a leaf along the path, this code has a prefix that is already a valid code
          expect(cur.isLeaf).toBe(false);
          if (!cur.children[bit]) {
            cur.children[bit] = { children: [null, null], isLeaf: false };
          }
          cur = cur.children[bit]!;
        }
        // If the node already has children, an existing code has this code as a prefix
        expect(cur.children[0]).toBeNull();
        expect(cur.children[1]).toBeNull();
        expect(cur.isLeaf).toBe(false);
        cur.isLeaf = true;
      }
    });

    it('verifies all 11 spectral codebooks satisfy the Huffman prefix-free property', () => {
      const codebooks = [
        { codes: AAC_SPECTRAL_CODES_1, bits: AAC_SPECTRAL_BITS_1, id: 1 },
        { codes: AAC_SPECTRAL_CODES_2, bits: AAC_SPECTRAL_BITS_2, id: 2 },
        { codes: AAC_SPECTRAL_CODES_3, bits: AAC_SPECTRAL_BITS_3, id: 3 },
        { codes: AAC_SPECTRAL_CODES_4, bits: AAC_SPECTRAL_BITS_4, id: 4 },
        { codes: AAC_SPECTRAL_CODES_5, bits: AAC_SPECTRAL_BITS_5, id: 5 },
        { codes: AAC_SPECTRAL_CODES_6, bits: AAC_SPECTRAL_BITS_6, id: 6 },
        { codes: AAC_SPECTRAL_CODES_7, bits: AAC_SPECTRAL_BITS_7, id: 7 },
        { codes: AAC_SPECTRAL_CODES_8, bits: AAC_SPECTRAL_BITS_8, id: 8 },
        { codes: AAC_SPECTRAL_CODES_9, bits: AAC_SPECTRAL_BITS_9, id: 9 },
        { codes: AAC_SPECTRAL_CODES_10, bits: AAC_SPECTRAL_BITS_10, id: 10 },
        { codes: AAC_SPECTRAL_CODES_11, bits: AAC_SPECTRAL_BITS_11, id: 11 },
      ];

      for (const { codes, bits, id } of codebooks) {
        expect(codes.length).toBe(bits.length);
        expect(codes.length).toBeGreaterThan(0);

        interface TrieNode {
          left: TrieNode | null;
          right: TrieNode | null;
          isLeaf: boolean;
        }
        const root: TrieNode = { left: null, right: null, isLeaf: false };

        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          const len = bits[i];
          expect(len).toBeGreaterThanOrEqual(1);

          let cur = root;
          for (let b = len - 1; b >= 0; b--) {
            const bit = (code >> b) & 1;
            expect(cur.isLeaf).toBe(false);
            if (bit === 0) {
              if (!cur.left) cur.left = { left: null, right: null, isLeaf: false };
              cur = cur.left;
            } else {
              if (!cur.right) cur.right = { left: null, right: null, isLeaf: false };
              cur = cur.right;
            }
          }
          expect(cur.left).toBeNull();
          expect(cur.right).toBeNull();
          expect(cur.isLeaf).toBe(false);
          cur.isLeaf = true;
        }
      }
    });

    it('verifies 1024-sample Scalefactor Window Band (SWB) offset table covers 0 to 1024 over 49 bands', () => {
      expect(AAC_SWB_OFFSET_1024_48).toHaveLength(50);
      expect(AAC_SWB_OFFSET_1024_48[0]).toBe(0);
      expect(AAC_SWB_OFFSET_1024_48[49]).toBe(1024);

      // Verify strictly monotonic increasing band boundaries
      for (let i = 0; i < 49; i++) {
        expect(AAC_SWB_OFFSET_1024_48[i + 1]).toBeGreaterThan(AAC_SWB_OFFSET_1024_48[i]);
      }
    });
  });

  // ==========================================================================
  // 2. DPCM Differential Scalefactor Quantizer & Huffman Bitstream Operations
  // ==========================================================================
  describe('2. DPCM Scalefactor Quantization & Huffman Bitstream', () => {
    it('roundtrips all differential scalefactor values from -60 to +60 with 100% precision', () => {
      for (let diff = -60; diff <= 60; diff++) {
        const writer = new BitWriter();
        encodeScalefactorDiff(writer, diff);
        const encodedBytes = writer.toBuffer();
        expect(encodedBytes.length).toBeGreaterThan(0);

        const reader = new BitReader(encodedBytes);
        const decodedDiff = decodeScalefactorDiff(reader);
        expect(decodedDiff).toBe(diff);
      }
    });

    it('selects appropriate AAC codebooks based on spectral magnitude boundaries', () => {
      const buf = new Int16Array(4);
      buf[0] = 0;
      expect(selectAacCodebook(buf, 0, 1)).toBe(0);
      buf[0] = 1;
      expect(selectAacCodebook(buf, 0, 1)).toBe(1);
      buf[0] = 3;
      expect(selectAacCodebook(buf, 0, 1)).toBe(5);
      buf[0] = 7;
      expect(selectAacCodebook(buf, 0, 1)).toBe(7);
      buf[0] = 12;
      expect(selectAacCodebook(buf, 0, 1)).toBe(9);
      buf[0] = 25;
      expect(selectAacCodebook(buf, 0, 1)).toBe(11);
    });

    it('roundtrips spectral bands with quads, pairs, and escape sequences accurately', () => {
      const q = new Int16Array(40);

      // Quad band test (values in -1, 0, 1)
      const quadStart = 0;
      const quadEnd = 8;
      q[0] = 1; q[1] = 0; q[2] = -1; q[3] = 0;
      q[4] = 0; q[5] = 1; q[6] = 1;  q[7] = -1;

      const writerQuad = new BitWriter();
      encodeSpectralBand(writerQuad, 2, q, quadStart, quadEnd);
      const quadBytes = writerQuad.toBuffer();
      expect(quadBytes.length).toBeGreaterThan(0);

      const decodedQ = new Int16Array(40);
      const readerQuad = new BitReader(quadBytes);
      decodeSpectralBand(readerQuad, 2, decodedQ, quadStart, quadEnd);

      for (let i = quadStart; i < quadEnd; i++) {
        expect(decodedQ[i]).toBe(q[i]);
      }

      // Escape codebook (codebook 11) for larger coefficients (> 15)
      const escStart = 16;
      const escEnd = 20;
      q[16] = 20;
      q[17] = -18;
      q[18] = 0;
      q[19] = 15;

      const writerEsc = new BitWriter();
      encodeSpectralBand(writerEsc, 11, q, escStart, escEnd);
      const escBytes = writerEsc.toBuffer();
      expect(escBytes.length).toBeGreaterThan(0);

      const readerEsc = new BitReader(escBytes);
      decodeSpectralBand(readerEsc, 11, decodedQ, escStart, escEnd);

      for (let i = escStart; i < escEnd; i++) {
        expect(decodedQ[i]).toBe(q[i]);
      }
    });
  });

  // ==========================================================================
  // 3. AAC LC Raw Data Block & ADTS Container Fidelity
  // ==========================================================================
  describe('3. AAC LC Raw Data Block & ADTS Container Fidelity', () => {
    it('decodes a hand-authored Single Channel Element (ID_SCE = 0x0) block to one frame of silence', () => {
      const payload = silentRawDataBlock(1);
      // Bit 0-2 of ID_SCE must be 000
      expect((payload[0] >> 5) & 0x07).toBe(0);

      const decoded = decodeAacLcFramePayload(payload, 1);
      expect(decoded).not.toBeNull();
      expect(decoded!).toHaveLength(1024);
      expect(decoded!.every((v) => v === 0)).toBe(true);
    });

    it('decodes a hand-authored Channel Pair Element (ID_CPE = 0x1) block to one frame of silence', () => {
      const payload = silentRawDataBlock(2);
      // Bit 0-2 of ID_CPE must be 001
      expect((payload[0] >> 5) & 0x07).toBe(1);

      const decoded = decodeAacLcFramePayload(payload, 2);
      expect(decoded).not.toBeNull();
      expect(decoded!).toHaveLength(2048);
      expect(decoded!.every((v) => v === 0)).toBe(true);
    });

    it('refuses to encode AAC without the native engine and re-wraps a hand-authored ADTS stream as WAV', async () => {
      const wav = createSineWavBuffer(44100, 2, 0.25);
      const encodeError = await convertMedia(
        wav,
        'wav',
        'aac',
        { disableNativeEngine: true, allowPureLossyBitstream: true },
        'audio.wav'
      ).catch((err: unknown) => err);
      expect(encodeError).toBeInstanceOf(EngineUnavailableError);

      const frames = 4;
      const adts = adtsStream(new Array(frames).fill(silentRawDataBlock(2)), 44100, 2);
      // ADTS header fields: MPEG-4, layer 0, protection absent; AAC LC; 44.1 kHz = index 4
      expect(adts[1] & 0x0f).toBe(0x01);
      expect((adts[2] >> 6) & 0x03).toBe(1);
      expect((adts[2] >> 2) & 0x0f).toBe(4);

      const decodedAac = decodeAdtsAac(adts);
      expect(decodedAac.sampleRate).toBe(44100);
      expect(decodedAac.channels).toBe(2);
      expect(decodedAac.samples.length).toBe(frames * 1024 * 2);

      const wavRes = await convertMedia(adts, 'aac', 'wav', { disableNativeEngine: true }, 'audio.aac');
      expect(wavRes.mimeType).toBe('audio/wav');
      expect(wavRes.buffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wavRes.buffer.toString('ascii', 8, 12)).toBe('WAVE');

      const finalDec = decodeAudioBuffer(wavRes.buffer, 'wav');
      expect(finalDec.sampleRate).toBe(44100);
      expect(finalDec.channels).toBe(2);
      expect(finalDec.samples.length).toBe(frames * 1024 * 2);
      expect(finalDec.samples.every((v) => v === 0)).toBe(true);
    });
  });

  // ==========================================================================
  // 4. RFC 3533 Ogg Page Checksum (0x04C11DB7) & Page Framing
  // ==========================================================================
  describe('4. RFC 3533 Ogg CRC-32 Generator Polynomial (0x04C11DB7)', () => {
    it('computes exact RFC 3533 32-bit CRC checksum matching polynomial 0x04C11DB7', () => {
      // Direct calculation on standard test vectors
      const testBuffer = Buffer.from('OggS');
      const crc = computeOggCrc(testBuffer);
      expect(crc).toBe(0x5fb0a94f);

      // Verify that all pages generated by createOggPage have valid non-zero CRC-32
      const payload = Buffer.from('TEST_OGG_PAYLOAD_STRING_12345');
      const page = createOggPage(payload, 0x02, 0, 1, 0x12345678);

      expect(page.toString('ascii', 0, 4)).toBe('OggS');
      const storedCrc = page.readUInt32LE(22);
      expect(storedCrc).not.toBe(0);

      // Verify self-consistency: zeroing bytes 22-25 and recalculating CRC must yield storedCrc
      const pageCopy = Buffer.from(page);
      pageCopy.writeUInt32LE(0, 22);
      const recomputedCrc = computeOggCrc(pageCopy);
      expect(recomputedCrc).toBe(storedCrc);
    });

    it('detects any byte alteration in header or payload via CRC divergence', () => {
      const payload = Buffer.from('AUTHENTIC_PAYLOAD_DATA');
      const page = createOggPage(payload, 0x00, 1000, 2, 0x12345678);
      const expectedCrc = page.readUInt32LE(22);

      // Tamper with payload byte
      const tampered = Buffer.from(page);
      tampered[tampered.length - 1] ^= 0x01;
      tampered.writeUInt32LE(0, 22);
      const tamperedCrc = computeOggCrc(tampered);

      expect(tamperedCrc).not.toBe(expectedCrc);
    });

    it('handles segment table segmentation and limit boundaries (> 255 bytes)', () => {
      const largePayload = Buffer.alloc(1000, 0xaa);
      const page = createOggPage(largePayload, 0x00, 2000, 3, 0x12345678);

      const segCount = page[26];
      // 1000 = 3 * 255 + 235 => 4 segments
      expect(segCount).toBe(4);
      expect(page[27]).toBe(255);
      expect(page[28]).toBe(255);
      expect(page[29]).toBe(255);
      expect(page[30]).toBe(235);

      const headerLen = 27 + segCount;
      expect(page.length).toBe(headerLen + 1000);
      expect(page.readUInt32LE(22)).not.toBe(0);
    });
  });

  // ==========================================================================
  // 5. RFC 7845 Ogg Opus & RFC 6716 TOC Byte Framing
  // ==========================================================================
  describe('5. RFC 7845 Ogg Opus Container & RFC 6716 TOC Framing', () => {
    it('creates RFC 7845 compliant OpusHead (BOS) and OpusTags pages with valid CRCs', () => {
      const packets = [Buffer.from([0xc4, 0x01, 0x02, 0x03]), Buffer.from([0xc4, 0x04, 0x05, 0x06])];

      const oggOpus = encodeOpusContainer(packets, 48000, 2, 'Test Song');
      expect(oggOpus.toString('ascii', 0, 4)).toBe('OggS');

      // Verify Page 1: OpusHead
      expect(oggOpus[5]).toBe(0x02); // BOS flag
      expect(oggOpus.readBigInt64LE(6)).toBe(0n); // Granule = 0
      expect(oggOpus.readUInt32LE(18)).toBe(1); // Sequence = 1
      const p1Crc = oggOpus.readUInt32LE(22);
      expect(p1Crc).not.toBe(0);

      const headIdx = oggOpus.indexOf('OpusHead');
      expect(headIdx).toBeGreaterThan(0);
      expect(oggOpus.readUInt8(headIdx + 8)).toBe(1); // Version 1
      expect(oggOpus.readUInt8(headIdx + 9)).toBe(2); // 2 channels
      expect(oggOpus.readUInt16LE(headIdx + 10)).toBe(384); // Pre-skip 384
      expect(oggOpus.readUInt32LE(headIdx + 12)).toBe(48000); // 48kHz

      // Verify Page 2: OpusTags
      const tagsIdx = oggOpus.indexOf('OpusTags');
      expect(tagsIdx).toBeGreaterThan(headIdx);
      expect(oggOpus.indexOf('EasyConvert Engine')).toBeGreaterThan(tagsIdx);

      // Verify Fail-Closed on raw PCM Int16Array
      expect(() => encodeOpusContainer(new Int16Array(960 * 2), 48000, 2)).toThrow(
        /Authentic Opus bitstream encoder is required/i
      );
    });

    it('packages discrete Opus audio packets with RFC 6716 TOC byte structure (0xC0 mono, 0xC4 stereo)', () => {
      // Stereo: TOC = 0xC4
      const stereoPackets = [Buffer.from([0xc4, 0x10, 0x20, 0x30]), Buffer.from([0xc4, 0x40, 0x50, 0x60])];
      const stereoOgg = encodeOpusContainer(stereoPackets, 48000, 2, 'Stereo');

      // Find third OggS page (first audio page)
      let offset = 0;
      let pageCount = 0;
      let audioPageOffset = -1;
      while (offset + 27 <= stereoOgg.length) {
        if (stereoOgg.toString('ascii', offset, offset + 4) === 'OggS') {
          pageCount++;
          if (pageCount === 3) {
            audioPageOffset = offset;
            break;
          }
          const segCount = stereoOgg[offset + 26];
          let payloadLen = 0;
          for (let s = 0; s < segCount; s++) payloadLen += stereoOgg[offset + 27 + s];
          offset += 27 + segCount + payloadLen;
        } else {
          offset++;
        }
      }

      expect(audioPageOffset).toBeGreaterThan(0);
      const segCount = stereoOgg[audioPageOffset + 26];
      const payloadStart = audioPageOffset + 27 + segCount;
      const tocByteStereo = stereoOgg[payloadStart];
      expect(tocByteStereo).toBe(0xc4); // Config 24 CELT 20ms + Stereo flag 0x04

      // Mono: TOC = 0xC0
      const monoPackets = [Buffer.from([0xc0, 0x10, 0x20, 0x30]), Buffer.from([0xc0, 0x40, 0x50, 0x60])];
      const monoOgg = encodeOpusContainer(monoPackets, 48000, 1, 'Mono');

      offset = 0;
      pageCount = 0;
      audioPageOffset = -1;
      while (offset + 27 <= monoOgg.length) {
        if (monoOgg.toString('ascii', offset, offset + 4) === 'OggS') {
          pageCount++;
          if (pageCount === 3) {
            audioPageOffset = offset;
            break;
          }
          const segCount = monoOgg[offset + 26];
          let payloadLen = 0;
          for (let s = 0; s < segCount; s++) payloadLen += monoOgg[offset + 27 + s];
          offset += 27 + segCount + payloadLen;
        } else {
          offset++;
        }
      }

      expect(audioPageOffset).toBeGreaterThan(0);
      const segCountMono = monoOgg[audioPageOffset + 26];
      const payloadStartMono = audioPageOffset + 27 + segCountMono;
      const tocByteMono = monoOgg[payloadStartMono];
      expect(tocByteMono).toBe(0xc0); // Config 24 CELT 20ms + Mono
    });

    it('enforces Fail-Closed for pure TS WAV -> OPUS without native FFmpeg engine', async () => {
      const wav = createSineWavBuffer(48000, 2, 0.2);
      await expect(
        convertMedia(wav, 'wav', 'opus', { disableNativeEngine: true, allowPureLossyBitstream: true }, 'test.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OPUS compression/i);
    });
  });

  // ==========================================================================
  // 6. RFC 3533 Ogg Vorbis Header Triad & Discrete Audio Framing
  // ==========================================================================
  describe('6. RFC 3533 Ogg Vorbis Header Triad & Discrete Audio Framing', () => {
    it('encodes all 3 mandatory Vorbis headers (Identification, Comments, Setup) in order', () => {
      const packets = [Buffer.from([0x00, 0x11, 0x22]), Buffer.from([0x00, 0x33, 0x44])];

      const oggVorbis = encodeOggContainer(packets, 44100, 2, 'Vorbis Song');

      // Verify all 3 headers are present
      const idIdx = oggVorbis.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
      const commentIdx = oggVorbis.indexOf(Buffer.from([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
      const setupIdx = oggVorbis.indexOf(Buffer.from([0x05, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));

      expect(idIdx).toBeGreaterThan(0);
      expect(commentIdx).toBeGreaterThan(idIdx);
      expect(setupIdx).toBeGreaterThan(commentIdx);

      // Verify setup header codebook magic 'BCV' (0x564342)
      expect(oggVorbis.indexOf(Buffer.from([0x42, 0x43, 0x56]))).toBeGreaterThan(setupIdx);

      // Verify Fail-Closed on raw PCM Int16Array
      expect(() => encodeOggContainer(new Int16Array(1024), 44100, 2)).toThrow(
        /Authentic Vorbis bitstream encoder is required/i
      );
    });

    it('enforces Fail-Closed for pure TS WAV -> OGG (Vorbis) without native FFmpeg engine', async () => {
      const wav = createSineWavBuffer(44100, 2, 0.2);
      await expect(
        convertMedia(wav, 'wav', 'ogg', { disableNativeEngine: true, allowPureLossyBitstream: true }, 'vorbis.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OGG compression/i);
    });
  });

  // ==========================================================================
  // 7. Negative & Boundary Fuzzing (Fail-Closed)
  // ==========================================================================
  describe('7. Negative & Boundary Fuzzing (Fail-Closed)', () => {
    it('handles 0-packet empty audio buffers gracefully without crashing and decodes to 0-length PCM', () => {
      const empty: Buffer[] = [];
      const opusOgg = encodeOpusContainer(empty, 48000, 2, 'Empty');
      expect(opusOgg.length).toBeGreaterThan(0);
      expect(opusOgg.toString('ascii', 0, 4)).toBe('OggS');

      const decOpus = decodeOgg(opusOgg);
      expect(decOpus.samples.length).toBe(0);
      expect(decOpus.duration).toBe(0);
      expect(decOpus.channels).toBe(2);

      const vorbisOgg = encodeOggContainer(empty, 44100, 2, 'Empty');
      expect(vorbisOgg.length).toBeGreaterThan(0);
      expect(vorbisOgg.toString('ascii', 0, 4)).toBe('OggS');

      const decVorbis = decodeOgg(vorbisOgg);
      expect(decVorbis.samples.length).toBe(0);
      expect(decVorbis.duration).toBe(0);
      expect(decVorbis.channels).toBe(2);
    });

    it('fails closed when decoding severely truncated or corrupt Ogg headers', () => {
      const truncated = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]); // 'OggS' only 6 bytes
      expect(() => decodeOgg(truncated)).toThrow(/Unsupported audio format/i);
    });

    it('fails closed on unknown container streams lacking OggS or ADTS sync markers', () => {
      const garbage = Buffer.from('RANDOM_CORRUPT_DATA_STRING_FOR_AUDIO_TESTING');
      expect(() => decodeOgg(garbage)).toThrow(/Unsupported audio format/i);
      expect(() => decodeAdtsAac(garbage)).toThrow(/Unsupported audio format/i);
    });

    it('rejects multi-channel audio (> 2 channels) and invalid channels with fail-closed errors', () => {
      const packets = [Buffer.from([0xc0, 0x01, 0x02])];
      expect(() => encodeOpusContainer(packets, 48000, 6, 'surround')).toThrow(/Unsupported channel configuration for Ogg Opus/i);
      expect(() => encodeOpusContainer(packets, 48000, 0, 'invalid')).toThrow(/Unsupported channel configuration for Ogg Opus/i);
      expect(() => encodeOggContainer(packets, 44100, 6, 'surround')).toThrow(/Unsupported channel configuration for Ogg Vorbis/i);
      expect(() => encodeOggContainer(packets, 44100, 0, 'invalid')).toThrow(/Unsupported channel configuration for Ogg Vorbis/i);

      const fakePayload = Buffer.alloc(20, 0);
      expect(decodeAacLcFramePayload(fakePayload, 6)).toBeNull();
      expect(decodeAacLcFramePayload(fakePayload, 0)).toBeNull();
    });

    it('fails closed on truncated AAC raw data blocks or missing ID_END terminators', () => {
      // 1. Valid header specifying max_sfb = 40, but cut off before scalefactor and spectral data
      const writer = new BitWriter();
      writer.writeBits(0, 3); // ID_SCE
      writer.writeBits(0, 4); // tag
      writer.writeBits(100, 8); // gain
      writer.writeBit(0); // reserved
      writer.writeBits(0, 2); // winSeq
      writer.writeBit(0); // winShape
      writer.writeBits(40, 6); // max_sfb = 40
      writer.writeBit(0); // pred
      writer.writeBits(5, 4); // cb = 5
      writer.writeBits(31, 5); // run 31
      writer.writeBits(9, 5); // + 9 = 40
      writer.alignToByte();
      const truncatedBuf = writer.toBuffer();

      // Reader overrun must cause decodeAacLcFramePayload to return null
      expect(decodeAacLcFramePayload(truncatedBuf, 1)).toBeNull();

      // 2. Complete hand-authored SCE payload decodes, but the same block with a corrupt ID_END (000 instead of 111) does not
      expect(decodeAacLcFramePayload(silentRawDataBlock(1), 1)).not.toBeNull();
      const tamperedEnd = silentRawDataBlock(1, 4, 0);
      expect(decodeAacLcFramePayload(tamperedEnd, 1)).toBeNull();
    });

    it('fails closed on AAC raw data blocks with invalid section spectral codebooks (cb > 11)', () => {
      // Mono SCE with cb = 12
      const wMono = new BitWriter();
      wMono.writeBits(0, 3); // ID_SCE
      wMono.writeBits(0, 4); // tag
      wMono.writeBits(100, 8); // gain
      wMono.writeBit(0);
      wMono.writeBits(0, 2);
      wMono.writeBit(0);
      wMono.writeBits(2, 6); // max_sfb = 2
      wMono.writeBit(0);
      wMono.writeBits(12, 4); // cb = 12 (INVALID for spectral data!)
      wMono.writeBits(2, 5); // run = 2
      wMono.writeBits(0, 1); // diff 0
      wMono.writeBits(0, 1); // diff 0
      wMono.writeBit(0); // pulse
      wMono.writeBit(0); // tns
      wMono.writeBit(0); // gain
      wMono.writeBits(7, 3); // ID_END
      wMono.alignToByte();
      expect(decodeAacLcFramePayload(wMono.toBuffer(), 1)).toBeNull();

      // Stereo CPE with cb = 13
      const wStereo = new BitWriter();
      wStereo.writeBits(1, 3); // ID_CPE
      wStereo.writeBits(0, 4);
      wStereo.writeBit(1); // common_window
      wStereo.writeBit(0);
      wStereo.writeBits(0, 2);
      wStereo.writeBit(0);
      wStereo.writeBits(2, 6);
      wStereo.writeBit(0);
      wStereo.writeBits(0, 2); // ms_mask_present = 0
      // ch0 with cb = 13 (INVALID)
      wStereo.writeBits(100, 8);
      wStereo.writeBits(13, 4);
      wStereo.writeBits(2, 5);
      wStereo.writeBits(0, 1);
      wStereo.writeBits(0, 1);
      wStereo.writeBit(0);
      wStereo.writeBit(0);
      wStereo.writeBit(0);
      // ch1
      wStereo.writeBits(100, 8);
      wStereo.writeBits(0, 4); // cb = 0
      wStereo.writeBits(2, 5);
      wStereo.writeBit(0);
      wStereo.writeBit(0);
      wStereo.writeBit(0);
      wStereo.writeBits(7, 3); // ID_END
      wStereo.alignToByte();
      expect(decodeAacLcFramePayload(wStereo.toBuffer(), 2)).toBeNull();
    });

    it('handles Codebook 11 escape sequence prefix safely without 32-bit integer overflow', () => {
      // Decode a spectral band using cb = 11 with escape prefix capped
      const writer = new BitWriter();
      // Write huffman codeword for cx = 16, cy = 0 (idx = 16 * 17 = 272)
      const code11 = AAC_SPECTRAL_CODES_11[272];
      const bits11 = AAC_SPECTRAL_BITS_11[272];
      writer.writeBits(code11, bits11);
      writer.writeBit(0); // signX = 0 (+)
      // Write 25 ones (would exceed 32-bit shift if unbounded) followed by 0
      for (let i = 0; i < 25; i++) writer.writeBit(1);
      writer.writeBit(0);
      writer.writeBits(100, 16); // 16-bit remainder
      writer.alignToByte();

      const r = new BitReader(writer.toBuffer());
      const out = new Int16Array(2);
      decodeSpectralBand(r, 11, out, 0, 2);
      expect(Number.isFinite(out[0])).toBe(true);
      expect(out[0]).toBeGreaterThan(0);
    });

    it('parses M/S stereo mask (ms_mask_present === 1) in stereo AAC LC payloads without bitstream desync', () => {
      const max_sfb = 4;
      const w = new BitWriter();
      w.writeBits(1, 3); // ID_CPE
      w.writeBits(0, 4); // tag
      w.writeBit(1); // common_window
      w.writeBit(0); // reserved
      w.writeBits(0, 2); // winSeq
      w.writeBit(0); // winShape
      w.writeBits(max_sfb, 6);
      w.writeBit(0); // pred
      w.writeBits(1, 2); // ms_mask_present = 1 (followed by max_sfb bits)
      for (let s = 0; s < max_sfb; s++) {
        w.writeBit(s % 2); // ms_used mask bits
      }

      // ch0
      w.writeBits(100, 8); // gain
      w.writeBits(0, 4); // cb = 0 (zero hcb)
      w.writeBits(max_sfb, 5); // run
      w.writeBit(0); // pulse
      w.writeBit(0); // tns
      w.writeBit(0); // gain

      // ch1
      w.writeBits(100, 8); // gain
      w.writeBits(0, 4); // cb = 0 (zero hcb)
      w.writeBits(max_sfb, 5); // run
      w.writeBit(0); // pulse
      w.writeBit(0); // tns
      w.writeBit(0); // gain

      w.writeBits(7, 3); // ID_END
      w.alignToByte();

      const decoded = decodeAacLcFramePayload(w.toBuffer(), 2);
      expect(decoded).not.toBeNull();
      expect(decoded!.length).toBe(1024 * 2);
    });
  });
});
