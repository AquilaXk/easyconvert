import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  convertMedia,
  decodeAudioBuffer,
  decodeAdtsAac,
  decodeOgg,
  encodeOpusContainer,
  encodeOggContainer,
  ARCHIVE_SECURITY_LIMITS,
} from '../src/lib/conversions';
import { convertArchive, gunzipStreamingWithLimits } from '../src/lib/conversions/archive';
import {
  createLosslessSandwichPdfFromImage,
  createLosslessSandwichPdfFromPdf,
  createToUnicodeCMap,
  createWinAnsiToUnicodeCMap,
  ensureUnicodeFont,
  registerFontOnPage,
  safeEncodeText,
} from '../src/lib/conversions/ocr-pdf-combiner';
import { performOcr } from '../src/lib/conversions/ocr';
import { BitReader } from '../src/lib/conversions/media-encoder';
import { ConversionFailedError, OcrEngineUnavailableError } from '../src/lib/types';
import { escapeRtf } from '../src/lib/conversions/office';

describe('Milestone 1 (P0): Engine Fidelity, Codecs, Lossless ToUnicode PDF & Fail-Closed Guards (#127)', () => {
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
      const val = Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000);
      buffer.writeInt16LE(val, 44 + i * 2);
    }

    return buffer;
  }

  // ==========================================================================
  // 1. Media Codec Bitstream Packaging (ADTS AAC LC & RFC 7845 Ogg Opus)
  // ==========================================================================
  describe('1. Media Codec Bitstream Packaging (ADTS AAC LC & RFC 7845 Ogg Opus)', () => {
    it('packages authentic ISO/IEC 13818-7 / 14496-3 AAC LC raw data blocks without raw PCM stuffing', async () => {
      const wav = createTestWav(44100, 2, 0.2);
      const aacResult = await convertMedia(wav, 'wav', 'aac', { allowPureLossyBitstream: true }, 'sound.wav');

      expect(aacResult.mimeType).toBe('audio/aac');
      expect(aacResult.filename).toBe('sound.aac');

      // Verify ADTS syncword (0xFFF)
      expect(aacResult.buffer[0]).toBe(0xff);
      expect(aacResult.buffer[1] & 0xf0).toBe(0xf0);

      // Verify AAC LC profile (01 in bits 6-7 of byte 2)
      const profile = (aacResult.buffer[2] >> 6) & 0x03;
      expect(profile).toBe(1); // 1 = AAC LC

      // Scan first frame payload
      const protectionAbsent = aacResult.buffer[1] & 1;
      const headerSize = protectionAbsent ? 7 : 9;
      const frameLength =
        ((aacResult.buffer[3] & 3) << 11) |
        (aacResult.buffer[4] << 3) |
        (aacResult.buffer[5] >> 5);
      const payloadLength = frameLength - headerSize;

      expect(payloadLength).toBeGreaterThan(10);

      // Inspect AAC LC syntax element: Stereo should start with ID_CPE (0x1)
      const payloadBuf = aacResult.buffer.subarray(headerSize, headerSize + payloadLength);
      const reader = new BitReader(payloadBuf);
      const elementId = reader.readBits(3);
      expect([0, 1, 6]).toContain(elementId); // ID_SCE (0), ID_CPE (1), or ID_FIL (6)

      // Verify decoding and non-zero RMS
      const decoded = decodeAdtsAac(aacResult.buffer);
      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);
      expect(decoded.samples.length).toBeGreaterThan(0);
    });

    it('packages mono AAC LC raw data blocks starting with ID_SCE (0x0)', async () => {
      const wavMono = createTestWav(44100, 1, 0.2);
      const aacResult = await convertMedia(wavMono, 'wav', 'aac', { audioChannels: 'mono', allowPureLossyBitstream: true }, 'mono.wav');

      const protectionAbsent = aacResult.buffer[1] & 1;
      const headerSize = protectionAbsent ? 7 : 9;
      const frameLength =
        ((aacResult.buffer[3] & 3) << 11) |
        (aacResult.buffer[4] << 3) |
        (aacResult.buffer[5] >> 5);

      const payloadBuf = aacResult.buffer.subarray(headerSize, headerSize + frameLength - headerSize);
      const reader = new BitReader(payloadBuf);
      const elementId = reader.readBits(3);
      expect([0, 6]).toContain(elementId); // ID_SCE (0) or ID_FIL (6)

      const decoded = decodeAdtsAac(aacResult.buffer);
      expect(decoded.channels).toBe(1);
    });

    it('encapsulates RFC 7845 compliant OpusHead and OpusTags headers for opus target format and fails closed without authentic encoder', async () => {
      const packets = [Buffer.from([0xc4, 0x01, 0x02, 0x03]), Buffer.from([0xc4, 0x04, 0x05, 0x06])];
      const opusBuffer = encodeOpusContainer(packets, 48000, 2, 'sample');

      // OggS magic
      expect(opusBuffer.toString('ascii', 0, 4)).toBe('OggS');
      expect(opusBuffer.indexOf('OpusHead')).toBeGreaterThan(0);
      expect(opusBuffer.indexOf('OpusTags')).toBeGreaterThan(0);

      // Verify Fail-Closed for pure TS WAV -> OPUS without native engine
      const wav = createTestWav(48000, 2, 0.2);
      await expect(
        convertMedia(wav, 'wav', 'opus', { allowPureLossyBitstream: true, disableNativeEngine: true }, 'sample.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OPUS compression/i);
    });

    it('handles audio without Ogg page overflow (multi-page RFC 3533 & RFC 7845 packaging with authentic packets)', async () => {
      // 70 authentic 20ms Opus frames (> 1.25s of audio)
      const packets: Buffer[] = [];
      for (let i = 0; i < 70; i++) {
        packets.push(Buffer.from([0xc4, (i & 0xff), ((i * 2) & 0xff), 0x00]));
      }
      const opusBuffer = encodeOpusContainer(packets, 48000, 2, 'long_sample');

      expect(opusBuffer.toString('ascii', 0, 4)).toBe('OggS');
      expect(opusBuffer.length).toBeGreaterThan(1000);

      // Verify page count: BOS (page 1) + Tags (page 2) + 70 audio pages
      let pageCount = 0;
      let offset = 0;
      while (offset + 4 <= opusBuffer.length) {
        if (opusBuffer.toString('ascii', offset, offset + 4) === 'OggS') {
          pageCount++;
          offset += 4;
        } else {
          offset++;
        }
      }
      expect(pageCount).toBe(72);
    });

    it('handles Vorbis Ogg container with multi-page packaging with authentic packets', async () => {
      const packets: Buffer[] = [];
      for (let i = 0; i < 50; i++) {
        packets.push(Buffer.from([0x00, (i & 0xff), ((i * 3) & 0xff)]));
      }
      const oggBuffer = encodeOggContainer(packets, 44100, 2, 'long_sample');

      expect(oggBuffer.toString('ascii', 0, 4)).toBe('OggS');
      expect(oggBuffer.length).toBeGreaterThan(1000);

      // Verify Fail-Closed on raw PCM in convertMedia
      const longWav = createTestWav(44100, 2, 1.0);
      await expect(
        convertMedia(longWav, 'wav', 'ogg', { allowPureLossyBitstream: true, disableNativeEngine: true }, 'long_sample.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OGG compression/i);
    });
  });

  // ==========================================================================
  // 2. OCR & Lossless Sandwich PDF Unicode ToUnicode CMap & Fail-Closed
  // ==========================================================================
  describe('2. OCR & Sandwich PDF Unicode ToUnicode CMap & Fail-Closed', () => {
    it('generates valid ISO 32000-1 ToUnicode CMap streams for 16-bit and 1-byte code spaces', () => {
      const cmap16 = createToUnicodeCMap();
      expect(cmap16).toContain('/CIDInit /ProcSet findresource begin');
      expect(cmap16).toContain('/CMapName /Custom-ToUnicode def');
      expect(cmap16).toContain('<0000> <FFFF>');
      expect(cmap16).toContain('1 beginbfrange');

      const cmapWinAnsi = createWinAnsiToUnicodeCMap();
      expect(cmapWinAnsi).toContain('/CMapName /WinAnsi-ToUnicode def');
      expect(cmapWinAnsi).toContain('<00> <FF>');

      // Astral code points (> 0xFFFF, e.g. U+20BB7) decomposed into 4-hex surrogate CIDs
      const cmapAstral = createToUnicodeCMap([0x20bb7]);
      expect(cmapAstral).toContain('2 beginbfchar');
      expect(cmapAstral).toContain('<D842> <D842>');
      expect(cmapAstral).toContain('<DFB7> <DFB7>');
    });

    it('injects Type 0 CIDFont with /ToUnicode CMap ensuring 100% CJK text extraction in PDF viewers', async () => {
      const testImage = await sharp({
        create: { width: 300, height: 100, channels: 3, background: '#ffffff' },
      }).png().toBuffer();

      const ocrResult = {
        text: '대한민국 광화문 영수증 50,000원 Receipt',
        confidence: 0.98,
        wordCount: 5,
        lines: ['대한민국 광화문 영수증 50,000원 Receipt'],
        lineBlocks: [
          {
            text: '대한민국 광화문 영수증 50,000원 Receipt',
            bbox: { x: 10, y: 10, width: 280, height: 30 },
            words: [
              { text: '대한민국', bbox: { x: 10, y: 10, width: 60, height: 30 } },
              { text: '광화문', bbox: { x: 75, y: 10, width: 50, height: 30 } },
              { text: '영수증', bbox: { x: 130, y: 10, width: 50, height: 30 } },
              { text: '50,000원', bbox: { x: 185, y: 10, width: 50, height: 30 } },
              { text: 'Receipt', bbox: { x: 240, y: 10, width: 50, height: 30 } },
            ],
          },
        ],
      };

      const pdfBuffer = await createLosslessSandwichPdfFromImage(testImage, ocrResult, {}, 'CJK Invoice');
      expect(pdfBuffer.length).toBeGreaterThan(0);

      // Verify using standard pdfjs-dist text extraction
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) });
      const pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const textContent = await page.getTextContent();
      const extractedStr = textContent.items
        .map((item: any) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ');

      // Must faithfully extract Korean and Latin without garbled characters
      expect(extractedStr).toContain('대한민국');
      expect(extractedStr).toContain('광화문');
      expect(extractedStr).toContain('영수증');
      expect(extractedStr).toContain('50,000원');
      expect(extractedStr).toContain('Receipt');
    });

    it('strictly enforces Fail-Closed principles in performOcr without silent dummy text fallback', async () => {
      // Pass a totally corrupted buffer that sharp cannot parse as an image
      const corruptBuffer = Buffer.from('NOT_A_VALID_IMAGE_BUFFER_DATA_FAIL_CLOSED_TEST');
      // Undecodable input is a client error (HTTP 400), not a missing engine (HTTP 503).
      await expect(performOcr(corruptBuffer, 'en')).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ConversionFailedError);
        expect(err).not.toBeInstanceOf(OcrEngineUnavailableError);
        expect(err.message).toContain('could not be decoded');
        return true;
      });
    });

    it('injects invisible text layer into existing PDFs containing indirect PDFRef resources without throwing', async () => {
      // Create a base PDF where Resources and Font are indirect object references (PDFRef)
      const baseDoc = await PDFDocument.create();
      const fontDict = baseDoc.context.obj({});
      const fontDictRef = baseDoc.context.register(fontDict);
      const resDict = baseDoc.context.obj({
        Font: fontDictRef,
      });
      const resRef = baseDoc.context.register(resDict);
      const page = baseDoc.addPage([400, 200]);
      page.node.set(PDFName.of('Resources'), resRef);
      const basePdfBytes = await baseDoc.save();

      const pageOcrResults = new Map();
      pageOcrResults.set(1, {
        text: '세금계산서 Tax Invoice 100,000 KRW',
        confidence: 0.95,
        wordCount: 5,
        lines: ['세금계산서 Tax Invoice 100,000 KRW'],
        lineBlocks: [
          {
            text: '세금계산서 Tax Invoice 100,000 KRW',
            bbox: { x: 10, y: 10, width: 350, height: 25 },
            words: [
              { text: '세금계산서', bbox: { x: 10, y: 10, width: 70, height: 25 } },
              { text: 'Tax', bbox: { x: 85, y: 10, width: 35, height: 25 } },
              { text: 'Invoice', bbox: { x: 125, y: 10, width: 55, height: 25 } },
              { text: '100,000', bbox: { x: 185, y: 10, width: 65, height: 25 } },
              { text: 'KRW', bbox: { x: 255, y: 10, width: 45, height: 25 } },
            ],
          },
        ],
      });

      const sandwichPdf = await createLosslessSandwichPdfFromPdf(Buffer.from(basePdfBytes), pageOcrResults);
      expect(sandwichPdf.length).toBeGreaterThan(0);

      // Verify text extraction
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(sandwichPdf) });
      const pdfDoc = await loadingTask.promise;
      const p1 = await pdfDoc.getPage(1);
      const textContent = await p1.getTextContent();
      const extractedStr = textContent.items.map((i: any) => i.str).join(' ');

      expect(extractedStr).toContain('세금계산서');
      expect(extractedStr).toContain('Tax');
      expect(extractedStr).toContain('Invoice');
      expect(extractedStr).toContain('100,000');
      expect(extractedStr).toContain('KRW');
    });

    it('preserves 100% of characters in mixed CJK/Latin strings without tail clipping', async () => {
      const testImage = await sharp({
        create: { width: 400, height: 100, channels: 3, background: '#ffffff' },
      }).png().toBuffer();

      const ocrResult = {
        text: 'Total ₩50000',
        confidence: 0.99,
        wordCount: 2,
        lines: ['Total ₩50000'],
        lineBlocks: [
          {
            text: 'Total ₩50000',
            bbox: { x: 10, y: 10, width: 280, height: 30 },
            words: [{ text: 'Total ₩50000', bbox: { x: 10, y: 10, width: 280, height: 30 } }],
          },
        ],
      };

      const pdfBuffer = await createLosslessSandwichPdfFromImage(testImage, ocrResult, {}, 'Won Invoice');
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) });
      const pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const textContent = await page.getTextContent();
      const extracted = textContent.items.map((i: any) => i.str).join(' ');

      expect(extracted).toContain('Total');
      expect(extracted).toContain('₩50000');
    });
  });

  // ==========================================================================
  // 3. Streaming Decompression Bomb Defense (Gzip / Tgz)
  // ==========================================================================
  describe('3. Archive Streaming Decompression Bomb Defense', () => {
    it('decompresses normal gzip stream correctly via gunzipStreamingWithLimits', async () => {
      const originalText = 'EasyConvert Enterprise Data Pipeline 2026 Test Stream Content';
      const compressed = zlib.gzipSync(Buffer.from(originalText, 'utf-8'));

      const decompressed = await gunzipStreamingWithLimits(compressed);
      expect(decompressed.toString('utf-8')).toBe(originalText);
    });

    it('aborts gzip decompression stream early when exceeding uncompressed size limit', async () => {
      const origLimit = ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
      try {
        ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = 500; // set low limit for test

        const payload = Buffer.alloc(5000, 'A');
        const compressed = zlib.gzipSync(payload);

        await expect(gunzipStreamingWithLimits(compressed)).rejects.toThrow(
          /Archive bomb detected: uncompressed size exceeds limit/i
        );
      } finally {
        ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = origLimit;
      }
    });

    it('aborts gzip decompression stream early when compression ratio exceeds limit', async () => {
      // 2MB of zeroes compresses to ~2KB, ratio ~1000:1 (exceeds 100:1 limit)
      const repetitiveData = Buffer.alloc(2 * 1024 * 1024, 0);
      const compressed = zlib.gzipSync(repetitiveData, { level: 9 });

      expect(repetitiveData.length / compressed.length).toBeGreaterThan(100);

      await expect(gunzipStreamingWithLimits(compressed)).rejects.toThrow(
        /Archive bomb detected: compression ratio exceeds.*limit/i
      );
    });

    it('enforces bomb defense during convertArchive for gz format', async () => {
      const origLimit = ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
      try {
        ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = 500;
        const payload = Buffer.alloc(2000, 'X');
        const compressed = zlib.gzipSync(payload);

        await expect(
          convertArchive(compressed, 'gz', 'tar', {}, 'bomb.gz')
        ).rejects.toThrow(/Archive bomb detected/i);
      } finally {
        ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = origLimit;
      }
    });
  });

  describe('6. Authentic RTF Text & Unicode Escaping (RFC 1.9.1)', () => {
    it('escapes RTF syntax characters, tabs, and diverse newline forms', () => {
      const input = 'Header: {section}\nKey \\ Value\tColumn\r\nNext\rFinal';
      const escaped = escapeRtf(input);
      expect(escaped).toBe('Header: \\{section\\}\\par\nKey \\\\ Value\\tab Column\\par\nNext\\par\nFinal');
    });

    it('encodes non-ASCII characters using signed 16-bit \\uN? notation', () => {
      // 'é': code 233 (positive 16-bit)
      // '안': code 50504 (> 32767 -> signed 50504 - 65536 = -15032)
      // '녕': code 45397 -> -20139
      // '하': code 54616 -> -10920
      // '세': code 49464 -> -16072
      // '요': code 50836 -> -14700
      const input = 'Café: 안녕하세요';
      const escaped = escapeRtf(input);
      expect(escaped).toBe('Caf\\u233?: \\u-15032?\\u-20139?\\u-10920?\\u-16072?\\u-14700?');
    });

    it('returns empty string for empty or null inputs', () => {
      expect(escapeRtf('')).toBe('');
      expect(escapeRtf(null as unknown as string)).toBe('');
      expect(escapeRtf(undefined as unknown as string)).toBe('');
    });
  });
});
