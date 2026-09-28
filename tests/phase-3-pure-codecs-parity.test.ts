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
  encodeAacLcFramePayload,
  decodeAacLcFramePayload,
} from '../src/lib/conversions/media-encoder';
import {
  computeOggCrc,
  createOggPage,
  encodeAacContainer,
  encodeOpusContainer,
  encodeOggContainer,
  convertMedia,
} from '../src/lib/conversions/media';
import {
  decodeAdtsAac,
  decodeOgg,
  decodeAudioBuffer,
} from '../src/lib/conversions/media-decoder';

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
    it('encodes and decodes Single Channel Element (ID_SCE = 0x0) mono AAC LC payloads', () => {
      const monoSamples = new Int16Array(1024);
      for (let i = 0; i < 1024; i++) {
        monoSamples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * 15000);
      }

      const payload = encodeAacLcFramePayload(monoSamples, 0, 1);
      expect(payload.length).toBeGreaterThan(10);
      // Bit 0-2 of ID_SCE must be 000
      expect((payload[0] >> 5) & 0x07).toBe(0);

      const decoded = decodeAacLcFramePayload(payload, 1);
      expect(decoded).not.toBeNull();
      expect(decoded!).toHaveLength(1024);

      let sumSq = 0;
      for (let i = 0; i < decoded!.length; i++) {
        sumSq += decoded![i] * decoded![i];
      }
      const rms = Math.sqrt(sumSq / decoded!.length);
      expect(rms).toBeGreaterThan(100);
    });

    it('encodes and decodes Channel Pair Element (ID_CPE = 0x1) stereo AAC LC payloads', () => {
      const stereoSamples = new Int16Array(2048);
      for (let i = 0; i < 1024; i++) {
        stereoSamples[i * 2] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * 14000);
        stereoSamples[i * 2 + 1] = Math.round(Math.cos((2 * Math.PI * 880 * i) / 44100) * 14000);
      }

      const payload = encodeAacLcFramePayload(stereoSamples, 0, 2);
      expect(payload.length).toBeGreaterThan(20);
      // Bit 0-2 of ID_CPE must be 001
      expect((payload[0] >> 5) & 0x07).toBe(1);

      const decoded = decodeAacLcFramePayload(payload, 2);
      expect(decoded).not.toBeNull();
      expect(decoded!).toHaveLength(2048);

      let sumSq = 0;
      for (let i = 0; i < decoded!.length; i++) {
        sumSq += decoded![i] * decoded![i];
      }
      const rms = Math.sqrt(sumSq / decoded!.length);
      expect(rms).toBeGreaterThan(100);
    });

    it('performs end-to-end WAV -> AAC -> WAV conversion and verifies ADTS bitstream header structure', async () => {
      const wav = createSineWavBuffer(44100, 2, 0.25);
      const aacRes = await convertMedia(wav, 'wav', 'aac', { disableNativeEngine: true, allowPureLossyBitstream: true }, 'audio.wav');
      expect(aacRes.mimeType).toBe('audio/aac');
      expect(aacRes.buffer.length).toBeGreaterThan(100);

      // Verify ADTS syncword (0xFFF) and 7-byte header fields
      expect(aacRes.buffer[0]).toBe(0xff);
      expect(aacRes.buffer[1] & 0xf0).toBe(0xf0);
      // MPEG-4 Audio (bit 3 = 0), Layer 0 (bits 1-2 = 00), Protection absent (bit 0 = 1)
      expect(aacRes.buffer[1] & 0x0f).toBe(0x01);
      // Profile: AAC LC = 01
      expect((aacRes.buffer[2] >> 6) & 0x03).toBe(1);
      // Sample rate: 44.1kHz = idx 4
      expect((aacRes.buffer[2] >> 2) & 0x0f).toBe(4);

      // Decode using decodeAdtsAac
      const decodedAac = decodeAdtsAac(aacRes.buffer);
      expect(decodedAac.sampleRate).toBe(44100);
      expect(decodedAac.channels).toBe(2);
      expect(decodedAac.samples.length).toBeGreaterThan(1024);

      // Roundtrip back to WAV
      const wavRes = await convertMedia(aacRes.buffer, 'aac', 'wav', { disableNativeEngine: true }, 'audio.aac');
      expect(wavRes.mimeType).toBe('audio/wav');
      expect(wavRes.buffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wavRes.buffer.toString('ascii', 8, 12)).toBe('WAVE');

      const finalDec = decodeAudioBuffer(wavRes.buffer, 'wav');
      let sumSq = 0;
      for (let i = 0; i < finalDec.samples.length; i++) {
        sumSq += finalDec.samples[i] * finalDec.samples[i];
      }
      const rms = Math.sqrt(sumSq / finalDec.samples.length);
      expect(rms).toBeGreaterThan(100);
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
      const samples = new Int16Array(960 * 2);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.1) * 8000);

      const oggOpus = encodeOpusContainer(samples, 48000, 2, 'Test Song');
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
    });

    it('packages discrete Opus audio packets with RFC 6716 TOC byte structure (0xC0 mono, 0xC4 stereo)', () => {
      // Stereo: TOC = 0xC4
      const stereoSamples = new Int16Array(960 * 2);
      for (let i = 0; i < stereoSamples.length; i++) stereoSamples[i] = 1000;
      const stereoOgg = encodeOpusContainer(stereoSamples, 48000, 2, 'Stereo');

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
      const monoSamples = new Int16Array(960);
      for (let i = 0; i < monoSamples.length; i++) monoSamples[i] = 1000;
      const monoOgg = encodeOpusContainer(monoSamples, 48000, 1, 'Mono');

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

    it('performs roundtrip WAV -> OPUS -> WAV with non-zero RMS waveform reconstruction', async () => {
      const wav = createSineWavBuffer(48000, 2, 0.2);
      const opusRes = await convertMedia(wav, 'wav', 'opus', { disableNativeEngine: true, allowPureLossyBitstream: true }, 'test.wav');
      expect(opusRes.mimeType).toBe('audio/opus');
      expect(opusRes.buffer.toString('ascii', 0, 4)).toBe('OggS');

      // Decode using decodeOgg
      const decodedOgg = decodeOgg(opusRes.buffer);
      expect(decodedOgg.sampleRate).toBe(48000);
      expect(decodedOgg.channels).toBe(2);
      expect(decodedOgg.samples.length).toBeGreaterThan(0);

      // Re-encode to WAV and check RMS
      const roundtripWav = await convertMedia(opusRes.buffer, 'opus', 'wav', { disableNativeEngine: true }, 'test.opus');
      expect(roundtripWav.mimeType).toBe('audio/wav');
      const wavDec = decodeAudioBuffer(roundtripWav.buffer, 'wav');

      let sumSq = 0;
      for (let i = 0; i < wavDec.samples.length; i++) {
        sumSq += wavDec.samples[i] * wavDec.samples[i];
      }
      const rms = Math.sqrt(sumSq / wavDec.samples.length);
      expect(rms).toBeGreaterThan(100);
    });
  });

  // ==========================================================================
  // 6. RFC 3533 Ogg Vorbis Header Triad & Discrete Audio Framing
  // ==========================================================================
  describe('6. RFC 3533 Ogg Vorbis Header Triad & Discrete Audio Framing', () => {
    it('encodes all 3 mandatory Vorbis headers (Identification, Comments, Setup) in order', () => {
      const samples = new Int16Array(2048);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.1) * 8000);

      const oggVorbis = encodeOggContainer(samples, 44100, 2, 'Vorbis Song');

      // Verify all 3 headers are present
      const idIdx = oggVorbis.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
      const commentIdx = oggVorbis.indexOf(Buffer.from([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));
      const setupIdx = oggVorbis.indexOf(Buffer.from([0x05, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]));

      expect(idIdx).toBeGreaterThan(0);
      expect(commentIdx).toBeGreaterThan(idIdx);
      expect(setupIdx).toBeGreaterThan(commentIdx);

      // Verify setup header codebook magic 'BCV' (0x564342)
      expect(oggVorbis.indexOf(Buffer.from([0x42, 0x43, 0x56]))).toBeGreaterThan(setupIdx);
    });

    it('performs roundtrip WAV -> OGG (Vorbis) -> WAV with authentic discrete audio framing', async () => {
      const wav = createSineWavBuffer(44100, 2, 0.2);
      const oggRes = await convertMedia(wav, 'wav', 'ogg', { disableNativeEngine: true, allowPureLossyBitstream: true }, 'vorbis.wav');
      expect(oggRes.mimeType).toBe('audio/ogg');

      const decodedOgg = decodeOgg(oggRes.buffer);
      expect(decodedOgg.sampleRate).toBe(44100);
      expect(decodedOgg.channels).toBe(2);
      expect(decodedOgg.samples.length).toBeGreaterThan(0);

      const roundtripWav = await convertMedia(oggRes.buffer, 'ogg', 'wav', { disableNativeEngine: true }, 'vorbis.ogg');
      expect(roundtripWav.mimeType).toBe('audio/wav');
      const wavDec = decodeAudioBuffer(roundtripWav.buffer, 'wav');

      let sumSq = 0;
      for (let i = 0; i < wavDec.samples.length; i++) {
        sumSq += wavDec.samples[i] * wavDec.samples[i];
      }
      const rms = Math.sqrt(sumSq / wavDec.samples.length);
      expect(rms).toBeGreaterThan(100);
    });
  });

  // ==========================================================================
  // 7. Negative & Boundary Fuzzing (Fail-Closed)
  // ==========================================================================
  describe('7. Negative & Boundary Fuzzing (Fail-Closed)', () => {
    it('handles 0-sample empty audio buffers gracefully without crashing', () => {
      const empty = new Int16Array(0);
      const opusOgg = encodeOpusContainer(empty, 48000, 2, 'Empty');
      expect(opusOgg.length).toBeGreaterThan(0);
      expect(opusOgg.toString('ascii', 0, 4)).toBe('OggS');

      const vorbisOgg = encodeOggContainer(empty, 44100, 2, 'Empty');
      expect(vorbisOgg.length).toBeGreaterThan(0);
      expect(vorbisOgg.toString('ascii', 0, 4)).toBe('OggS');
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
  });
});
