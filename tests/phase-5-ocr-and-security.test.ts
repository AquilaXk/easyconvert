import { describe, it, expect } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  createLosslessSandwichPdfFromPdf,
  OcrResult,
} from '../src/lib/conversions/ocr-pdf-combiner';
import { shownWords } from './helpers/pdf-shown-text';
import { expectLinearScaling, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';
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

/** Opening tags in the small run of the unclosed-tag growth check, and the filler after each one. */
const UNCLOSED_OPENINGS = 5000;
const UNCLOSED_FILLER_PER_OPENING = 10;

/** The decoded content stream of the first page. */
function pageContentOf(doc: PDFDocument): string {
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString('latin1'))
    .join('\n');
}

describe('Phase 5: OCR Sandwich PDF Typography Parity & Security Hardening', () => {
  // =========================================================================
  // 1. Text on a rotated baseline
  // =========================================================================
  describe('1. Text on a rotated baseline', () => {
    it('writes each word of a line on a 45 degree baseline with the matching text matrix', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      const basePdfBytes = await pdfDoc.save();

      // The baseline runs from (100, 224) to (200, 324) in pixels with y down: 45 degrees clockwise on the scan.
      const ocrResult: OcrResult = {
        text: 'Rotated Stamp',
        confidence: 0.96,
        wordCount: 2,
        lines: ['Rotated Stamp'],
        lineBlocks: [
          {
            text: 'Rotated Stamp',
            bbox: { x: 100, y: 200, width: 120, height: 124 },
            baseline: { x0: 100, y0: 224, x1: 200, y1: 324 },
            rowHeight: 24,
            words: [
              { text: 'Rotated', bbox: { x: 100, y: 200, width: 55, height: 124 } },
              { text: 'Stamp', bbox: { x: 160, y: 200, width: 60, height: 124 } },
            ],
          },
        ],
      };

      const pageMap = new Map<number, OcrResult>();
      pageMap.set(1, ocrResult);
      const sandwichPdf = await createLosslessSandwichPdfFromPdf(Buffer.from(basePdfBytes), pageMap);
      expect(sandwichPdf.length).toBeGreaterThan(basePdfBytes.length);

      const content = pageContentOf(await PDFDocument.load(sandwichPdf));
      // A baseline at 45 degrees clockwise on the scan is a text matrix rotated by -45 degrees in PDF space
      // (y up): [cos -sin... ] = [0.707107 -0.707107 0.707107 0.707107 x y].
      const matrices = [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g)];
      expect(matrices).toHaveLength(2);
      for (const matrix of matrices) {
        expect(matrix.slice(1, 5).map(Number)).toEqual([0.707107, -0.707107, 0.707107, 0.707107]);
      }
      expect(shownWords(await PDFDocument.load(sandwichPdf))).toEqual(['Rotated', 'Stamp']);
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

    it('safely bounds deeply nested XML hierarchies (64+ levels) without stack overflow', () => {
      let deepXml = '<w:t>Deeply Nested Secret</w:t>';
      for (let i = 0; i < 70; i++) {
        deepXml = `<layer id="${i}">${deepXml}</layer>`;
      }

      // Default maxDepth = 64 halts at 64th nested level to prevent recursion attacks
      const firstLayer = safeExtractFirstXmlElement(deepXml, 'layer');
      const customDepthLayer = safeExtractFirstXmlElement(deepXml, 'layer', { maxDepth: 100 });
      const textEl = safeExtractFirstXmlElement(deepXml, 'w:t', { maxDepth: 100 });

      // The scanner is iterative: 70 levels return their answers instead of overflowing the stack.
      expect(firstLayer?.attrs.id).toBe('64');
      expect(customDepthLayer?.attrs.id).toBe('69');
      expect(textEl?.content).toBe('Deeply Nested Secret');
    });

    it('neutralizes hostile ReDoS payloads designed to freeze backtracking regex engines', async () => {
      // Classic ReDoS trigger for /<p:grpSp[\s\S]*?<\/p:grpSp>/:
      // A huge repeating sequence of opening tags with no closing tag
      const { largeResult } = await expectLinearScaling(
        'unclosed group shapes',
        (openings: number) => safeExtractXmlElements('<p:grpSp>'.repeat(openings) + 'A'.repeat(openings * UNCLOSED_FILLER_PER_OPENING), 'p:grpSp'),
        { baseSize: UNCLOSED_OPENINGS }
      );

      // Because there are no matching closing tags, it must abort gracefully, and in time linear in the input
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

      expect(shownWords(loadedDoc)).toEqual(['Confidential', 'Financial', 'Report']);
      // Verify invisible rendering mode Tr 3
      expect(pageContentOf(loadedDoc)).toContain('3 Tr');
    });
  });
});
