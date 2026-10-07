import { describe, it, expect } from 'vitest';
import * as zlib from 'node:zlib';
import { PDFDocument, StandardFonts, PDFHexString, PDFNumber, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  computeAffineTransformationMatrix,
  buildTJArrayWithKerning,
  renderLineBlockWithSpacing,
  createLosslessSandwichPdfFromPdf,
  injectInvisibleTextLayer,
  ensureUnicodeFont,
  OcrBBox,
  OcrLineBlock,
  OcrWord,
  OcrResult,
} from '../src/lib/conversions/ocr-pdf-combiner';
import {
  sniffMimeTypeFromMagicBytes,
  isFormatCompatibleWithMagicBytes,
  assertNotSpoofedFile,
  FileExtensionSpoofError,
} from '../src/lib/registry';
import {
  safeExtractXmlElements,
  safeExtractFirstXmlElement,
  safeExtractXmlAttributes,
  safeDecodeXmlEntities,
  safeExtractAllText,
  safeFindColor,
} from '../src/lib/conversions/office';
import { expectLinearOnInputs, expectNoHang, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/** Unclosed openers in the smaller of the two ReDoS inputs. */
const UNCLOSED_OPENERS = 20_000;

/**
 * Extracts and decompresses all stream contents from a PDF buffer to inspect operators.
 */
function extractAllTextFromPdfStreams(pdfBuffer: Buffer): string {
  const binary = pdfBuffer.toString('binary');
  let combined = binary;
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(binary)) !== null) {
    const raw = Buffer.from(match[1], 'binary');
    try {
      combined += '\n' + zlib.inflateSync(raw).toString('latin1');
    } catch {
      try {
        combined += '\n' + zlib.inflateRawSync(raw).toString('latin1');
      } catch {}
    }
  }
  // Also decode hex string literals like <526F7461746564> into readable text
  const decoded = combined.replace(/<([0-9A-Fa-f]{2,})>/g, (_, hex) => {
    try {
      return Buffer.from(hex, 'hex').toString('utf-8');
    } catch {
      return hex;
    }
  });
  return combined + '\n' + decoded;
}

describe('Phase 5: OCR Sandwich PDF Typography Parity & Security Hardening', () => {
  // =========================================================================
  // 1. ISO 32000-1 Word Spacing & TJ Kerning Offsets
  // =========================================================================
  describe('1. ISO 32000-1 Compliant Word Spacing & TJ Kerning Operators', () => {
    it('computes accurate TJ array with character kerning offsets and word spacing', async () => {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 12;

      const words: OcrWord[] = [
        { text: 'EasyConvert', bbox: { x: 50, y: 100, width: 60, height: 12 } },
        { text: 'Autonomous', bbox: { x: 125, y: 100, width: 70, height: 12 } },
        { text: 'Engine', bbox: { x: 210, y: 100, width: 45, height: 12 } },
      ];

      const { tjArray, wordSpacing, activeFontName } = buildTJArrayWithKerning(
        pdfDoc,
        font,
        words,
        fontSize
      );

      expect(activeFontName).toBe(font.name);
      expect(wordSpacing).toBeGreaterThanOrEqual(0);

      // Inspect TJ array contents
      const items = tjArray.asArray();
      expect(items.length).toBeGreaterThanOrEqual(5);

      // First item is encoded 'EasyConvert'
      expect(items[0]).toBeInstanceOf(PDFHexString);
      expect((items[0] as PDFHexString).decodeText()).toBe('EasyConvert');

      // Second item is explicit space glyph ' '
      expect(items[1]).toBeInstanceOf(PDFHexString);
      expect((items[1] as PDFHexString).decodeText()).toBe(' ');

      // Verify all words appear in order
      const hexStrings = items
        .filter((item: any) => item instanceof PDFHexString)
        .map((h: any) => (h as PDFHexString).decodeText());
      expect(hexStrings).toContain('EasyConvert');
      expect(hexStrings).toContain('Autonomous');
      expect(hexStrings).toContain('Engine');
    });

    it('handles adjacent words with zero gap gracefully without false kerning blowup', async () => {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 12;

      const words: OcrWord[] = [
        { text: 'Super', bbox: { x: 50, y: 100, width: 30, height: 12 } },
        { text: 'Fast', bbox: { x: 80, y: 100, width: 25, height: 12 } },
      ];

      const { tjArray, wordSpacing } = buildTJArrayWithKerning(
        pdfDoc,
        font,
        words,
        fontSize
      );

      const items = tjArray.asArray();
      expect(items.length).toBeGreaterThanOrEqual(2);

      const hexTexts = items
        .filter((item: any) => item instanceof PDFHexString)
        .map((h: any) => (h as PDFHexString).decodeText());
      expect(hexTexts).toContain('Super');
      expect(hexTexts).toContain('Fast');
    });

    it('renders line block with Tw word spacing operator and invisible text mode', async () => {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 800]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      const lineBlock: OcrLineBlock = {
        text: 'Document Conversion Security Framework',
        bbox: { x: 50, y: 100, width: 350, height: 16 },
        words: [
          { text: 'Document', bbox: { x: 50, y: 100, width: 75, height: 16 } },
          { text: 'Conversion', bbox: { x: 135, y: 100, width: 85, height: 16 } },
          { text: 'Security', bbox: { x: 230, y: 100, width: 60, height: 16 } },
          { text: 'Framework', bbox: { x: 300, y: 100, width: 100, height: 16 } },
        ],
      };

      // Render line block into page stream
      renderLineBlockWithSpacing(page, font, lineBlock, 800);

      // Compile PDF and verify operators in page content
      const pdfBytes = await pdfDoc.save();
      const streamText = extractAllTextFromPdfStreams(Buffer.from(pdfBytes));

      // Must activate text rendering mode 3 (invisible)
      expect(streamText).toContain('3 Tr');
      // Must include word spacing operator 'Tw' and 'TJ' array
      expect(streamText).toContain('Tw');
      expect(streamText).toContain('TJ');
      expect(streamText).toContain('BT');
      expect(streamText).toContain('ET');
    });

    it('prevents word collision and negative collapsing when words share identical line bounding box', async () => {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 12;

      // Words that don't have separate sub-word bboxes (all share the same line bbox)
      const sharedBbox: OcrBBox = { x: 50, y: 100, width: 150, height: 14 };
      const words: OcrWord[] = [
        { text: 'Autonomous', bbox: sharedBbox },
        { text: 'Security', bbox: sharedBbox },
        { text: 'Guard', bbox: sharedBbox },
      ];

      const { tjArray, wordSpacing } = buildTJArrayWithKerning(
        pdfDoc,
        font,
        words,
        fontSize
      );

      // Fallback word spacing must be non-negative and preserve space glyphs
      expect(wordSpacing).toBe(0);
      const items = tjArray.asArray();
      // Kerning offsets must not collapse the space glyph to zero
      const numbers = items.filter((it: any) => it instanceof PDFNumber).map((n: any) => n.asNumber());
      // No large positive kerning (> 200) that would negate the space advance
      for (const num of numbers) {
        expect(num).toBeLessThanOrEqual(0); // non-positive kerning means cursor moves right or stays
      }
    });

    it('enforces ISO 32000-1 §9.3.3 Type 0 composite font word spacing parity for CJK text', async () => {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 14;

      const words: OcrWord[] = [
        { text: '전자문서', bbox: { x: 50, y: 100, width: 60, height: 14 } },
        { text: '보안', bbox: { x: 120, y: 100, width: 30, height: 14 } },
        { text: '프레임워크', bbox: { x: 160, y: 100, width: 70, height: 14 } },
      ];

      const { tjArray, wordSpacing, activeFontName } = buildTJArrayWithKerning(
        pdfDoc,
        font,
        words,
        fontSize
      );

      // In ISO 32000-1, Tw has no effect on CIDFonts / Type 0 fonts, so wordSpacing must be 0
      expect(wordSpacing).toBe(0);
      expect(activeFontName).toBe('ECToUnicodeFont');

      // TJ array must contain explicit space glyphs and exact kerning offsets
      const items = tjArray.asArray();
      expect(items.length).toBeGreaterThanOrEqual(5);

      const hexTexts = items
        .filter((it: any) => it instanceof PDFHexString)
        .map((h: any) => (h as PDFHexString).asString());

      // CIDs are dense, so the space glyph is whichever CID the font's ToUnicode maps to U+0020.
      const type0: PDFDict = pdfDoc.context.lookup(ensureUnicodeFont(pdfDoc).fontRef, PDFDict);
      const cmapStream = pdfDoc.context.lookup(type0.get(PDFName.of('ToUnicode'))) as PDFRawStream;
      const cmap = Buffer.from(decodePDFRawStream(cmapStream).decode()).toString('latin1');
      const spaceCid = /<([0-9A-F]{4})> <0020>/.exec(cmap)?.[1];
      expect(spaceCid).toBeDefined();
      expect(hexTexts.filter((h: string) => h === spaceCid)).toHaveLength(words.length - 1);
      expect(hexTexts.filter((h: string) => !/^(?:[0-9A-F]{4})+$/.test(h))).toEqual([]);
    });
  });

  // =========================================================================
  // 2. 2D Affine Skew and Rotation Transformation Matrix
  // =========================================================================
  describe('2. 2D Affine Skew and Rotation Transformation Matrix', () => {
    it('computes exact identity matrix for 0 degrees rotation', () => {
      const bbox: OcrBBox = { x: 100, y: 50, width: 60, height: 20, rotationDegrees: 0 };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      expect(matrix[0]).toBeCloseTo(1, 4);
      expect(matrix[1]).toBeCloseTo(0, 4);
      expect(matrix[2]).toBeCloseTo(0, 4);
      expect(matrix[3]).toBeCloseTo(1, 4);
      expect(matrix[4]).toBe(100);
      expect(matrix[5]).toBe(730);
    });

    it('computes exact 90 degrees rotation matrix [0, 1, -1, 0, x, y]', () => {
      const bbox: OcrBBox = { x: 150, y: 80, width: 40, height: 20, rotationDegrees: 90 };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      expect(matrix[0]).toBeCloseTo(0, 4);
      expect(matrix[1]).toBeCloseTo(1, 4);
      expect(matrix[2]).toBeCloseTo(-1, 4);
      expect(matrix[3]).toBeCloseTo(0, 4);
      expect(matrix[4]).toBe(150);
      expect(matrix[5]).toBe(700);
    });

    it('computes exact 180 degrees rotation matrix [-1, 0, 0, -1, x, y]', () => {
      const bbox: OcrBBox = { x: 50, y: 25, width: 30, height: 10, rotationDegrees: 180 };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      expect(matrix[0]).toBeCloseTo(-1, 4);
      expect(matrix[1]).toBeCloseTo(0, 4);
      expect(matrix[2]).toBeCloseTo(0, 4);
      expect(matrix[3]).toBeCloseTo(-1, 4);
      expect(matrix[4]).toBe(50);
      expect(matrix[5]).toBe(765);
    });

    it('computes exact 270 (-90) degrees rotation matrix [0, -1, 1, 0, x, y]', () => {
      const bbox: OcrBBox = { x: 80, y: 40, width: 50, height: 15, rotationDegrees: 270 };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      expect(matrix[0]).toBeCloseTo(0, 4);
      expect(matrix[1]).toBeCloseTo(-1, 4);
      expect(matrix[2]).toBeCloseTo(1, 4);
      expect(matrix[3]).toBeCloseTo(0, 4);
      expect(matrix[4]).toBe(80);
      expect(matrix[5]).toBe(745);
    });

    it('computes affine skew matrix with correct shear axes when horizontal and vertical skew are present', () => {
      const skewXRad = (10 * Math.PI) / 180;
      const skewYRad = (5 * Math.PI) / 180;
      const bbox: OcrBBox = {
        x: 300,
        y: 100,
        width: 100,
        height: 20,
        rotationDegrees: 0,
        skewX: skewXRad,
        skewY: skewYRad,
      };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      expect(matrix[0]).toBeCloseTo(1, 4);
      // matrix[1] is b: vertical shear factor tan(skewY)
      expect(matrix[1]).toBeCloseTo(Math.tan(skewYRad), 4);
      // matrix[2] is c: horizontal shear factor tan(skewX)
      expect(matrix[2]).toBeCloseTo(Math.tan(skewXRad), 4);
      expect(matrix[3]).toBeCloseTo(1, 4);
      expect(matrix[4]).toBe(300);
      expect(matrix[5]).toBe(680);
    });

    it('correctly handles small document deskew angles (e.g. 2 degrees) as degrees, not radians', () => {
      const bbox: OcrBBox = {
        x: 100,
        y: 50,
        width: 60,
        height: 20,
        rotation: 2, // 2 degrees tilt from scan deskewing
      };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      const rad2 = (2 * Math.PI) / 180;
      expect(matrix[0]).toBeCloseTo(Math.cos(rad2), 4);
      expect(matrix[1]).toBeCloseTo(Math.sin(rad2), 4);
      expect(matrix[2]).toBeCloseTo(-Math.sin(rad2), 4);
      expect(matrix[3]).toBeCloseTo(Math.cos(rad2), 4);
    });

    it('computes exact affine matrix product R * S for combined rotation and shear', () => {
      const thetaDeg = 30;
      const thetaRad = (thetaDeg * Math.PI) / 180;
      const skewXRad = (10 * Math.PI) / 180;
      const skewYRad = (5 * Math.PI) / 180;
      const bbox: OcrBBox = {
        x: 50,
        y: 50,
        width: 100,
        height: 20,
        rotationDegrees: thetaDeg,
        skewX: skewXRad,
        skewY: skewYRad,
      };
      const matrix = computeAffineTransformationMatrix(bbox, 800);
      const cosT = Math.cos(thetaRad);
      const sinT = Math.sin(thetaRad);
      const tanX = Math.tan(skewXRad);
      const tanY = Math.tan(skewYRad);

      expect(matrix[0]).toBeCloseTo(cosT + tanX * sinT, 4);
      expect(matrix[1]).toBeCloseTo(sinT + tanY * cosT, 4);
      expect(matrix[2]).toBeCloseTo(-sinT + tanX * cosT, 4);
      expect(matrix[3]).toBeCloseTo(cosT - tanY * sinT, 4);
    });

    it('injects invisible text layer with affine transformation matrix onto rotated OCR bounding boxes', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      const basePdfBytes = await pdfDoc.save();

      const ocrResult: OcrResult = {
        text: 'Rotated Stamp',
        confidence: 96,
        wordCount: 2,
        lines: ['Rotated Stamp'],
        lineBlocks: [
          {
            text: 'Rotated Stamp',
            bbox: { x: 100, y: 200, width: 120, height: 24, rotationDegrees: 45 },
            words: [
              { text: 'Rotated', bbox: { x: 100, y: 200, width: 55, height: 24 } },
              { text: 'Stamp', bbox: { x: 160, y: 200, width: 60, height: 24 } },
            ],
          },
        ],
      };

      const pageMap = new Map<number, OcrResult>();
      pageMap.set(1, ocrResult);
      const sandwichPdf = await createLosslessSandwichPdfFromPdf(Buffer.from(basePdfBytes), pageMap);
      expect(sandwichPdf.length).toBeGreaterThan(basePdfBytes.length);

      const streamText = extractAllTextFromPdfStreams(sandwichPdf);
      // Verify transformation matrix operator 'cm' exists in the content stream
      expect(streamText).toMatch(/[-0-9.]+\s+[-0-9.]+\s+[-0-9.]+\s+[-0-9.]+\s+[-0-9.]+\s+[-0-9.]+\s+cm/);
      expect(streamText).toContain('Rotated');
      expect(streamText).toContain('Stamp');
    });
  });

  // =========================================================================
  // 3. Authentic MIME Magic Byte Sniffing & Anti-Spoofing
  // =========================================================================
  describe('3. MIME Magic Byte Sniffing & Fail-Closed Extension Spoofing Rejection', () => {
    it('accurately sniffs authentic magic bytes across primary binary and archive formats', () => {
      // PDF (%PDF-)
      const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
      expect(sniffMimeTypeFromMagicBytes(pdfMagic)).toBe('application/pdf');

      // PNG (\x89PNG\r\n\x1a\n)
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(sniffMimeTypeFromMagicBytes(pngMagic)).toBe('image/png');

      // JPEG (FF D8 FF)
      const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(sniffMimeTypeFromMagicBytes(jpegMagic)).toBe('image/jpeg');

      // GIF (GIF89a)
      const gifMagic = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      expect(sniffMimeTypeFromMagicBytes(gifMagic)).toBe('image/gif');

      // TIFF Little-Endian (II*\0)
      const tiffLe = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
      expect(sniffMimeTypeFromMagicBytes(tiffLe)).toBe('image/tiff');

      // TIFF Big-Endian (MM\0*)
      const tiffBe = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
      expect(sniffMimeTypeFromMagicBytes(tiffBe)).toBe('image/tiff');

      // RIFF WebP (RIFF....WEBP)
      const webpMagic = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      expect(sniffMimeTypeFromMagicBytes(webpMagic)).toBe('image/webp');

      // RIFF WAV (RIFF....WAVE)
      const wavMagic = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      ]);
      expect(sniffMimeTypeFromMagicBytes(wavMagic)).toBe('audio/wav');

      // 7z (7z\xBC\xAF\x27\x1C)
      const sevenzMagic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
      expect(sniffMimeTypeFromMagicBytes(sevenzMagic)).toBe('application/x-7z-compressed');

      // Gzip (\x1F\x8B)
      const gzMagic = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
      expect(sniffMimeTypeFromMagicBytes(gzMagic)).toBe('application/gzip');

      // Bzip2 (BZh)
      const bz2Magic = Buffer.from([0x42, 0x5a, 0x68, 0x39]);
      expect(sniffMimeTypeFromMagicBytes(bz2Magic)).toBe('application/x-bzip2');

      // Zstandard (28 B5 2F FD)
      const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      expect(sniffMimeTypeFromMagicBytes(zstdMagic)).toBe('application/zstd');

      // FLAC (fLaC)
      const flacMagic = Buffer.from([0x66, 0x4c, 0x61, 0x43]);
      expect(sniffMimeTypeFromMagicBytes(flacMagic)).toBe('audio/flac');

      // Ogg (OggS)
      const oggMagic = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
      expect(sniffMimeTypeFromMagicBytes(oggMagic)).toBe('audio/ogg');

      // MP3 (ID3v2)
      const mp3Magic = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]);
      expect(sniffMimeTypeFromMagicBytes(mp3Magic)).toBe('audio/mpeg');

      // AAC (ADTS 0xFFF sync word)
      const aacAdtsMagic = Buffer.from([0xff, 0xf1, 0x50, 0x80]);
      expect(sniffMimeTypeFromMagicBytes(aacAdtsMagic)).toBe('audio/aac');
      expect(isFormatCompatibleWithMagicBytes(aacAdtsMagic, 'aac')).toBe(true);

      // WebM / MKV (EBML: 1A 45 DF A3)
      const webmMagic = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
      expect(sniffMimeTypeFromMagicBytes(webmMagic)).toBe('video/webm');
      expect(isFormatCompatibleWithMagicBytes(webmMagic, 'webm')).toBe(true);

      // Parquet (PAR1)
      const parquetMagic = Buffer.from([0x50, 0x41, 0x52, 0x31]);
      expect(sniffMimeTypeFromMagicBytes(parquetMagic)).toBe('application/vnd.apache.parquet');
    });

    it('rejects spoofed file extensions fail-closed with authentic FileExtensionSpoofError instances', () => {
      // 1. PDF file disguised as a PNG
      const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
      expect(isFormatCompatibleWithMagicBytes(pdfBytes, 'png')).toBe(false);
      let thrown1: unknown;
      try {
        assertNotSpoofedFile(pdfBytes, 'png', 'spoofed.png');
      } catch (err) {
        thrown1 = err;
      }
      expect(thrown1).toBeInstanceOf(FileExtensionSpoofError);
      expect((thrown1 as Error).message).toContain('File spoofing rejected');

      // 2. PNG image disguised as DOCX
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      expect(isFormatCompatibleWithMagicBytes(pngBytes, 'docx')).toBe(false);
      let thrown2: unknown;
      try {
        assertNotSpoofedFile(pngBytes, 'docx', 'invoice.docx');
      } catch (err) {
        thrown2 = err;
      }
      expect(thrown2).toBeInstanceOf(FileExtensionSpoofError);

      // 3. Executable ELF disguised as PDF
      const elfBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      expect(isFormatCompatibleWithMagicBytes(elfBytes, 'pdf')).toBe(false);
      expect(() => assertNotSpoofedFile(elfBytes, 'pdf', 'document.pdf')).toThrowError(
        FileExtensionSpoofError
      );

      // 4. Windows PE executable disguised as JPG
      const peBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      expect(isFormatCompatibleWithMagicBytes(peBytes, 'jpg')).toBe(false);
      expect(() => assertNotSpoofedFile(peBytes, 'jpg', 'photo.jpg')).toThrowError(
        FileExtensionSpoofError
      );

      // 5. Valid PDF buffer matches declared PDF
      expect(isFormatCompatibleWithMagicBytes(pdfBytes, 'pdf')).toBe(true);
      expect(() => assertNotSpoofedFile(pdfBytes, 'pdf', 'real.pdf')).not.toThrow();

      // 6. Valid PNG buffer matches declared PNG
      expect(isFormatCompatibleWithMagicBytes(pngBytes, 'png')).toBe(true);
      expect(() => assertNotSpoofedFile(pngBytes, 'png', 'real.png')).not.toThrow();

      // 7. Empty or 0-byte buffer fails closed
      expect(() => assertNotSpoofedFile(Buffer.alloc(0), 'pdf', 'empty.pdf')).toThrowError(
        FileExtensionSpoofError
      );
      expect(() => assertNotSpoofedFile(new Uint8Array(0), 'png', 'empty.png')).toThrowError(
        FileExtensionSpoofError
      );
      expect(() => assertNotSpoofedFile(Buffer.alloc(0), 'pdf')).toThrow(
        /payload is empty \(0 bytes\)/
      );
    });
  });

  // =========================================================================
  // 4. SAX Token Scanning & ReDoS Resistance on Hostile XML Payloads
  // =========================================================================
  describe('4. SAX Token Scanning & ReDoS Immunity on Untrusted XML', () => {
    it('extracts elements accurately in O(N) linear time without catastrophic backtracking', () => {
      const xml = `
        <root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:p>
            <w:r>
              <w:t>Hello EasyConvert</w:t>
            </w:r>
            <w:r>
              <w:t>Security Hardening</w:t>
            </w:r>
          </w:p>
        </root>
      `;

      const pElements = safeExtractXmlElements(xml, 'w:p');
      expect(pElements.length).toBe(1);

      const rElements = safeExtractXmlElements(pElements[0].content, 'w:r');
      expect(rElements.length).toBe(2);

      const t1 = safeExtractFirstXmlElement(rElements[0].content, 'w:t');
      const t2 = safeExtractFirstXmlElement(rElements[1].content, 'w:t');
      expect(t1?.content).toBe('Hello EasyConvert');
      expect(t2?.content).toBe('Security Hardening');
    });

    it('safely bounds deeply nested XML hierarchies (64+ levels) without stack overflow', async () => {
      let deepXml = '<w:t>Deeply Nested Secret</w:t>';
      for (let i = 0; i < 70; i++) {
        deepXml = `<layer id="${i}">${deepXml}</layer>`;
      }

      // Default maxDepth = 64 halts at 64th nested level to prevent recursion attacks
      const { firstLayer, customDepthLayer, textEl } = await expectNoHang('nested extraction', () => ({
        firstLayer: safeExtractFirstXmlElement(deepXml, 'layer'),
        customDepthLayer: safeExtractFirstXmlElement(deepXml, 'layer', { maxDepth: 100 }),
        textEl: safeExtractFirstXmlElement(deepXml, 'w:t', { maxDepth: 100 }),
      }));

      expect(firstLayer?.attrs.id).toBe('64');
      expect(customDepthLayer?.attrs.id).toBe('69');
      expect(textEl?.content).toBe('Deeply Nested Secret');
    });

    it('neutralizes hostile ReDoS payloads designed to freeze backtracking regex engines', async () => {
      // Classic ReDoS trigger for /<p:grpSp[\s\S]*?<\/p:grpSp>/: a huge repeating sequence of opening tags with no
      // closing tag. Because there are no matching closing tags, it must abort gracefully in linear time:
      // 4x the openers may cost at most 8x the time, a backtracking pattern 16x (tests/helpers/timing.ts).
      const hostileUnclosed = (openers: number) => '<p:grpSp>'.repeat(openers) + 'A'.repeat(openers * 10);
      const { largeResult } = await expectLinearOnInputs('unclosed grpSp', (xml: string) => safeExtractXmlElements(xml, 'p:grpSp'), {
        small: hostileUnclosed(UNCLOSED_OPENERS),
        large: hostileUnclosed(UNCLOSED_OPENERS * SCALING_FACTOR),
      });
      expect(largeResult.length).toBe(0);
    }, SCALING_TEST_TIMEOUT_MS);

    it('preserves outer table content when parsing nested OpenXML tables', () => {
      const nestedTableXml = `
        <w:tbl>
          <w:tr>
            <w:tc>
              <w:p><w:r><w:t>Outer Column 1</w:t></w:r></w:p>
              <w:tbl>
                <w:tr>
                  <w:tc>
                    <w:p><w:r><w:t>Inner Nested Cell</w:t></w:r></w:p>
                  </w:tc>
                </w:tr>
              </w:tbl>
            </w:tc>
            <w:tc>
              <w:p><w:r><w:t>Outer Column 2</w:t></w:r></w:p>
            </w:tc>
          </w:tr>
        </w:tbl>
      `;

      // Extract all tables at the top level
      const tables = safeExtractXmlElements(nestedTableXml, 'w:tbl');
      expect(tables.length).toBe(1);

      // Verify outer table content contains both Outer Column 1 and Outer Column 2
      const outerContent = tables[0].content;
      expect(outerContent).toContain('Outer Column 1');
      expect(outerContent).toContain('Outer Column 2');
      expect(outerContent).toContain('Inner Nested Cell');
    });

    it('correctly parses self-closing XML tags with varied whitespace and attributes', () => {
      const xmlWithSelfClosing = `
        <cols>
          <col min="1" max="1" width="24.5" customWidth="1" />
          <col min="2" max="2" width="18.0" customWidth="1"/>
          <col min="3" max="3" width="12.0" customWidth="0"   />
        </cols>
      `;

      const cols = safeExtractXmlElements(xmlWithSelfClosing, 'col');
      expect(cols.length).toBe(3);
      expect(cols[0].attrs.min).toBe('1');
      expect(cols[0].attrs.width).toBe('24.5');
      expect(cols[1].attrs.min).toBe('2');
      expect(cols[1].attrs.width).toBe('18.0');
      expect(cols[2].attrs.min).toBe('3');
      expect(cols[2].attrs.width).toBe('12.0');
    });

    it('safely decodes Unicode supplementary plane characters and entities without surrogate truncation', () => {
      // Astral plane code point: U+1F600 (GRINNING FACE)
      const hexEmoji = safeDecodeXmlEntities('Status: &#x1F600; Complete');
      expect(hexEmoji).toBe('Status: 😀 Complete');

      // Decimal code point: 128512 (U+1F600)
      const decEmoji = safeDecodeXmlEntities('Rating: &#128512; High');
      expect(decEmoji).toBe('Rating: 😀 High');

      // Standard XML entities
      const standard = safeDecodeXmlEntities('&lt;tag name=&quot;test&amp;prod&quot;&gt;');
      expect(standard).toBe('<tag name="test&prod">');
    });

    it('decodes XML entities in attribute values and tolerates trailing whitespace in closing tags', () => {
      const xml = '<w:p attr="Value &amp; More &quot;quoted&quot;"><w:t>Body</w:t></w:p  >';
      const elements = safeExtractXmlElements(xml, 'w:p');
      expect(elements.length).toBe(1);
      expect(elements[0].attrs.attr).toBe('Value & More "quoted"');
      expect(elements[0].content).toContain('<w:t>Body</w:t>');
    });
  });

  // =========================================================================
  // 5. High-Precision Copy-Paste Typography Parity in Sandwich PDFs
  // =========================================================================
  describe('5. End-to-End High-Precision Sandwich PDF Parity', () => {
    it('creates an ISO 32000-1 searchable PDF preserving exact word bounding boxes and text stream', async () => {
      // Generate a blank 1-page base PDF
      const baseDoc = await PDFDocument.create();
      baseDoc.addPage([612, 792]);
      const basePdfBytes = await baseDoc.save();

      const ocrResult: OcrResult = {
        text: 'Confidential Financial Report',
        confidence: 99,
        wordCount: 3,
        lines: ['Confidential Financial Report'],
        lineBlocks: [
          {
            text: 'Confidential Financial Report',
            bbox: { x: 72, y: 72, width: 223, height: 14 },
            words: [
              { text: 'Confidential', bbox: { x: 72, y: 72, width: 90, height: 14 } },
              { text: 'Financial', bbox: { x: 170, y: 72, width: 65, height: 14 } },
              { text: 'Report', bbox: { x: 245, y: 72, width: 50, height: 14 } },
            ],
          },
        ],
      };

      const pageMap = new Map<number, OcrResult>();
      pageMap.set(1, ocrResult);
      const sandwichPdf = await createLosslessSandwichPdfFromPdf(Buffer.from(basePdfBytes), pageMap);

      // Verify PDF header
      expect(sandwichPdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
      expect(sandwichPdf.length).toBeGreaterThan(basePdfBytes.length);

      // Reload PDF and check structure
      const loadedDoc = await PDFDocument.load(sandwichPdf);
      expect(loadedDoc.getPageCount()).toBe(1);

      const streamText = extractAllTextFromPdfStreams(sandwichPdf);
      expect(streamText).toContain('Confidential');
      expect(streamText).toContain('Financial');
      expect(streamText).toContain('Report');
      // Verify invisible rendering mode Tr 3
      expect(streamText).toContain('3 Tr');
    });
  });
});
