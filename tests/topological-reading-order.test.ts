import { describe, it, expect } from 'vitest';
import * as zlib from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import {
  detectColumnGutters,
  sortLineBlocksTopological,
  parseTesseractBlocks,
  injectInvisibleTextLayer,
  createLosslessSandwichPdfFromImage,
  OcrLineBlock,
  OcrResult,
} from '../src/lib/conversions/ocr-pdf-combiner';

/**
 * Extracts and decompresses all stream contents from a PDF buffer to inspect raw text operators.
 */
function extractDecompressedPdfStreams(pdfBuffer: Buffer): string {
  const binary = pdfBuffer.toString('binary');
  let combined = '';
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(binary)) !== null) {
    const raw = Buffer.from(match[1], 'binary');
    try {
      combined += '\n' + zlib.inflateSync(raw).toString('latin1');
    } catch {
      try {
        combined += '\n' + zlib.inflateRawSync(raw).toString('latin1');
      } catch {
        combined += '\n' + raw.toString('latin1');
      }
    }
  }

  // Also decode hex string literals like <48656C6C6F> into human-readable characters
  const decodedHex = combined.replace(/<([0-9A-Fa-f]{2,})>/g, (_, hex) => {
    try {
      if (hex.length % 2 !== 0) hex = '0' + hex;
      // Handle potential UTF-16BE / CID hex encoding (4 hex chars per glyph)
      const buf = Buffer.from(hex, 'hex');
      if (buf.length >= 2 && buf[0] === 0) {
        // UTF-16BE
        let s = '';
        for (let i = 0; i < buf.length; i += 2) {
          const code = (buf[i] << 8) | buf[i + 1];
          if (code > 0) s += String.fromCharCode(code);
        }
        return s;
      }
      return buf.toString('latin1');
    } catch {
      return hex;
    }
  });

  return combined + '\n' + decodedHex;
}

describe('Topological Reading Order Sort for Multi-Column Documents & Sandwich PDFs', () => {
  // =========================================================================
  // 1. Two-Column Academic Paper Layout (Interleaving Prevention)
  // =========================================================================
  describe('1. Two-Column Academic Paper Layout', () => {
    it('sorts interleaved lines into strict column-first reading order', () => {
      // 2-column document envelope: width 600, height 800
      // Col 1: X in [50, 260] (width 210)
      // Gutter: X in [260, 310] (width 50)
      // Col 2: X in [310, 520] (width 210)
      // Lines share IDENTICAL Y coordinates to simulate extreme interleaving bug
      const col1Lines: OcrLineBlock[] = [
        { text: 'Col1 Line 1: Introduction to DLA', bbox: { x: 50, y: 100, width: 200, height: 12 }, words: [] },
        { text: 'Col1 Line 2: Previous methods failed', bbox: { x: 50, y: 130, width: 195, height: 12 }, words: [] },
        { text: 'Col1 Line 3: Interleaving occurred here', bbox: { x: 50, y: 160, width: 205, height: 12 }, words: [] },
        { text: 'Col1 Line 4: Our method fixes reading order', bbox: { x: 50, y: 190, width: 210, height: 12 }, words: [] },
      ];

      const col2Lines: OcrLineBlock[] = [
        { text: 'Col2 Line 1: Related Work and Taxonomy', bbox: { x: 310, y: 100, width: 200, height: 12 }, words: [] },
        { text: 'Col2 Line 2: XY-Cut and projection profiles', bbox: { x: 310, y: 130, width: 205, height: 12 }, words: [] },
        { text: 'Col2 Line 3: Spatial channel detection', bbox: { x: 310, y: 160, width: 190, height: 12 }, words: [] },
        { text: 'Col2 Line 4: Evaluation and conclusions', bbox: { x: 310, y: 190, width: 200, height: 12 }, words: [] },
      ];

      // Pass input deliberately interleaved by Y (Col1 L1, Col2 L1, Col1 L2, Col2 L2, ...)
      const interleavedInput: OcrLineBlock[] = [
        col1Lines[0],
        col2Lines[0],
        col1Lines[1],
        col2Lines[1],
        col1Lines[2],
        col2Lines[2],
        col1Lines[3],
        col2Lines[3],
      ];

      // 1. Verify gutter detection
      const gutters = detectColumnGutters(interleavedInput);
      expect(gutters.length).toBe(1);
      expect(gutters[0].start).toBeGreaterThanOrEqual(250);
      expect(gutters[0].end).toBeLessThanOrEqual(315);
      expect(gutters[0].width).toBeGreaterThanOrEqual(40);

      // 2. Verify topological sort
      const sorted = sortLineBlocksTopological(interleavedInput);
      expect(sorted.length).toBe(8);

      const sortedTexts = sorted.map((b) => b.text);
      expect(sortedTexts).toEqual([
        'Col1 Line 1: Introduction to DLA',
        'Col1 Line 2: Previous methods failed',
        'Col1 Line 3: Interleaving occurred here',
        'Col1 Line 4: Our method fixes reading order',
        'Col2 Line 1: Related Work and Taxonomy',
        'Col2 Line 2: XY-Cut and projection profiles',
        'Col2 Line 3: Spatial channel detection',
        'Col2 Line 4: Evaluation and conclusions',
      ]);
    });
  });

  // =========================================================================
  // 2. Full-Width Title + 2-Column Body + Full-Width Footer
  // =========================================================================
  describe('2. Spanning Headers and Footers Separation', () => {
    it('orders spanning title -> column 1 -> column 2 -> spanning footer', () => {
      const title: OcrLineBlock = {
        text: 'Advances in Autonomous Optical Character Recognition',
        bbox: { x: 50, y: 30, width: 500, height: 24 }, // Spanning title (width 500 out of 500)
        words: [],
      };

      const subtitle: OcrLineBlock = {
        text: 'A Robust Topological Reading Order Architecture',
        bbox: { x: 50, y: 60, width: 450, height: 16 }, // Spanning subtitle
        words: [],
      };

      const col1Lines: OcrLineBlock[] = [
        { text: 'Section 1.1 First Paragraph', bbox: { x: 50, y: 120, width: 200, height: 12 }, words: [] },
        { text: 'Section 1.2 Second Paragraph', bbox: { x: 50, y: 150, width: 195, height: 12 }, words: [] },
      ];

      const col2Lines: OcrLineBlock[] = [
        { text: 'Section 2.1 First Paragraph', bbox: { x: 320, y: 120, width: 200, height: 12 }, words: [] },
        { text: 'Section 2.2 Second Paragraph', bbox: { x: 320, y: 150, width: 195, height: 12 }, words: [] },
      ];

      const footer: OcrLineBlock = {
        text: 'Page 1 of 12 - EasyConvert Technical Report 2026',
        bbox: { x: 50, y: 750, width: 480, height: 12 }, // Spanning footer
        words: [],
      };

      // Shuffled input
      const shuffled: OcrLineBlock[] = [
        col2Lines[1],
        title,
        col1Lines[0],
        footer,
        col2Lines[0],
        subtitle,
        col1Lines[1],
      ];

      const sorted = sortLineBlocksTopological(shuffled);
      const sortedTexts = sorted.map((b) => b.text);

      expect(sortedTexts).toEqual([
        'Advances in Autonomous Optical Character Recognition',
        'A Robust Topological Reading Order Architecture',
        'Section 1.1 First Paragraph',
        'Section 1.2 Second Paragraph',
        'Section 2.1 First Paragraph',
        'Section 2.2 Second Paragraph',
        'Page 1 of 12 - EasyConvert Technical Report 2026',
      ]);
    });
  });

  // =========================================================================
  // 3. Three-Column Magazine Layout
  // =========================================================================
  describe('3. Three-Column Magazine Layout', () => {
    it('detects two column gutters and sequences columns 1 -> 2 -> 3 correctly', () => {
      // 3 columns:
      // Col 1: [30, 180] (width 150)
      // Gutter 1: [180, 210] (width 30)
      // Col 2: [210, 360] (width 150)
      // Gutter 2: [360, 390] (width 30)
      // Col 3: [390, 540] (width 150)
      const col1: OcrLineBlock[] = [
        { text: 'Col 1 Top', bbox: { x: 30, y: 100, width: 140, height: 12 }, words: [] },
        { text: 'Col 1 Mid', bbox: { x: 30, y: 140, width: 145, height: 12 }, words: [] },
        { text: 'Col 1 Bottom', bbox: { x: 30, y: 180, width: 135, height: 12 }, words: [] },
      ];

      const col2: OcrLineBlock[] = [
        { text: 'Col 2 Top', bbox: { x: 210, y: 100, width: 140, height: 12 }, words: [] },
        { text: 'Col 2 Mid', bbox: { x: 210, y: 140, width: 145, height: 12 }, words: [] },
        { text: 'Col 2 Bottom', bbox: { x: 210, y: 180, width: 135, height: 12 }, words: [] },
      ];

      const col3: OcrLineBlock[] = [
        { text: 'Col 3 Top', bbox: { x: 390, y: 100, width: 140, height: 12 }, words: [] },
        { text: 'Col 3 Mid', bbox: { x: 390, y: 140, width: 145, height: 12 }, words: [] },
        { text: 'Col 3 Bottom', bbox: { x: 390, y: 180, width: 135, height: 12 }, words: [] },
      ];

      // Pass in interleaved order (Top of each col, then Mid of each col, etc.)
      const input = [
        col1[0], col2[0], col3[0],
        col1[1], col2[1], col3[1],
        col1[2], col2[2], col3[2],
      ];

      const gutters = detectColumnGutters(input);
      expect(gutters.length).toBe(2);

      const sorted = sortLineBlocksTopological(input);
      const sortedTexts = sorted.map((b) => b.text);

      expect(sortedTexts).toEqual([
        'Col 1 Top',
        'Col 1 Mid',
        'Col 1 Bottom',
        'Col 2 Top',
        'Col 2 Mid',
        'Col 2 Bottom',
        'Col 3 Top',
        'Col 3 Mid',
        'Col 3 Bottom',
      ]);
    });
  });

  // =========================================================================
  // 4. Mid-Page Spanning Banners & Section Headings
  // =========================================================================
  describe('4. Mid-Page Spanning Banners & Recursive Slices', () => {
    it('correctly handles mid-page full-width section banner dividing columns', () => {
      // Document structure:
      // Title (spanning) at y=40
      // Upper section: Col 1 & Col 2 at y=100, 130
      // Mid-page Section Heading (spanning both cols) at y=250
      // Lower section: Col 1 & Col 2 at y=320, 350
      // Footer (spanning) at y=700
      const title: OcrLineBlock = {
        text: 'Document Title',
        bbox: { x: 50, y: 40, width: 480, height: 20 },
        words: [],
      };

      const upperCol1: OcrLineBlock[] = [
        { text: 'Upper Col 1 Line 1', bbox: { x: 50, y: 100, width: 190, height: 12 }, words: [] },
        { text: 'Upper Col 1 Line 2', bbox: { x: 50, y: 130, width: 190, height: 12 }, words: [] },
      ];

      const upperCol2: OcrLineBlock[] = [
        { text: 'Upper Col 2 Line 1', bbox: { x: 300, y: 100, width: 190, height: 12 }, words: [] },
        { text: 'Upper Col 2 Line 2', bbox: { x: 300, y: 130, width: 190, height: 12 }, words: [] },
      ];

      const midHeading: OcrLineBlock = {
        text: '3. EXPERIMENTAL BENCHMARK AND RESULTS',
        bbox: { x: 50, y: 250, width: 450, height: 16 }, // Spanning across the gutter
        words: [],
      };

      const lowerCol1: OcrLineBlock[] = [
        { text: 'Lower Col 1 Line 1', bbox: { x: 50, y: 320, width: 190, height: 12 }, words: [] },
        { text: 'Lower Col 1 Line 2', bbox: { x: 50, y: 350, width: 190, height: 12 }, words: [] },
      ];

      const lowerCol2: OcrLineBlock[] = [
        { text: 'Lower Col 2 Line 1', bbox: { x: 300, y: 320, width: 190, height: 12 }, words: [] },
        { text: 'Lower Col 2 Line 2', bbox: { x: 300, y: 350, width: 190, height: 12 }, words: [] },
      ];

      const footer: OcrLineBlock = {
        text: 'Confidential Report Footer',
        bbox: { x: 50, y: 700, width: 480, height: 12 },
        words: [],
      };

      const shuffled: OcrLineBlock[] = [
        lowerCol2[0],
        upperCol1[1],
        title,
        midHeading,
        upperCol2[0],
        lowerCol1[0],
        footer,
        upperCol1[0],
        lowerCol2[1],
        upperCol2[1],
        lowerCol1[1],
      ];

      const sorted = sortLineBlocksTopological(shuffled);
      const sortedTexts = sorted.map((b) => b.text);

      expect(sortedTexts).toEqual([
        'Document Title',
        'Upper Col 1 Line 1',
        'Upper Col 1 Line 2',
        'Upper Col 2 Line 1',
        'Upper Col 2 Line 2',
        '3. EXPERIMENTAL BENCHMARK AND RESULTS',
        'Lower Col 1 Line 1',
        'Lower Col 1 Line 2',
        'Lower Col 2 Line 1',
        'Lower Col 2 Line 2',
        'Confidential Report Footer',
      ]);
    });
  });

  // =========================================================================
  // 5. Single-Column and Edge Cases
  // =========================================================================
  describe('5. Single-Column Fallback & Robustness Edge Cases', () => {
    it('maintains strict top-down order for standard single-column documents', () => {
      const singleCol: OcrLineBlock[] = [
        { text: 'Line 1 at top', bbox: { x: 50, y: 100, width: 400, height: 14 }, words: [] },
        { text: 'Line 2 in middle', bbox: { x: 50, y: 150, width: 380, height: 14 }, words: [] },
        { text: 'Line 3 further down', bbox: { x: 50, y: 200, width: 420, height: 14 }, words: [] },
        { text: 'Line 4 at bottom', bbox: { x: 50, y: 250, width: 390, height: 14 }, words: [] },
      ];

      const gutters = detectColumnGutters(singleCol);
      expect(gutters.length).toBe(0);

      const shuffled = [singleCol[2], singleCol[0], singleCol[3], singleCol[1]];
      const sorted = sortLineBlocksTopological(shuffled);
      expect(sorted.map((b) => b.text)).toEqual([
        'Line 1 at top',
        'Line 2 in middle',
        'Line 3 further down',
        'Line 4 at bottom',
      ]);
    });

    it('handles empty inputs, single blocks, and degenerate bboxes gracefully', () => {
      expect(sortLineBlocksTopological([])).toEqual([]);
      expect(detectColumnGutters([])).toEqual([]);

      const single: OcrLineBlock = {
        text: 'Single line only',
        bbox: { x: 10, y: 10, width: 100, height: 10 },
        words: [],
      };
      expect(sortLineBlocksTopological([single])).toEqual([single]);
      expect(detectColumnGutters([single])).toEqual([]);

      // Degenerate coordinates (NaN, 0 width, negative values)
      const degenerate: OcrLineBlock[] = [
        { text: 'Bad line 1', bbox: { x: NaN, y: 10, width: 0, height: 10 }, words: [] },
        { text: 'Bad line 2', bbox: { x: 10, y: NaN, width: 10, height: 0 }, words: [] },
      ];
      expect(() => sortLineBlocksTopological(degenerate)).not.toThrow();
    });

    it('tolerates asymmetric column widths (e.g. sidebar + main body)', () => {
      // Sidebar on left: X in [30, 170] (width 140)
      // Gutter: X in [170, 200] (width 30)
      // Main body on right: X in [200, 540] (width 340)
      const sidebar: OcrLineBlock[] = [
        { text: 'Sidebar Nav Item 1', bbox: { x: 30, y: 100, width: 120, height: 12 }, words: [] },
        { text: 'Sidebar Nav Item 2', bbox: { x: 30, y: 130, width: 125, height: 12 }, words: [] },
      ];

      const mainContent: OcrLineBlock[] = [
        { text: 'Main Body Article Header', bbox: { x: 200, y: 100, width: 320, height: 12 }, words: [] },
        { text: 'Main Body Paragraph One', bbox: { x: 200, y: 130, width: 330, height: 12 }, words: [] },
      ];

      const shuffled = [mainContent[1], sidebar[0], mainContent[0], sidebar[1]];
      const sorted = sortLineBlocksTopological(shuffled);
      expect(sorted.map((b) => b.text)).toEqual([
        'Sidebar Nav Item 1',
        'Sidebar Nav Item 2',
        'Main Body Article Header',
        'Main Body Paragraph One',
      ]);
    });

    it('ignores tiny noise speckles in the gutter channel', () => {
      // 2 columns with a tiny 1px noise speckle at x=280 (inside gutter [260, 300])
      const col1: OcrLineBlock[] = [
        { text: 'Alpha One', bbox: { x: 50, y: 100, width: 200, height: 12 }, words: [] },
        { text: 'Alpha Two', bbox: { x: 50, y: 130, width: 200, height: 12 }, words: [] },
      ];
      const col2: OcrLineBlock[] = [
        { text: 'Beta One', bbox: { x: 310, y: 100, width: 200, height: 12 }, words: [] },
        { text: 'Beta Two', bbox: { x: 310, y: 130, width: 200, height: 12 }, words: [] },
      ];
      const noise: OcrLineBlock = {
        text: '.',
        bbox: { x: 280, y: 115, width: 1, height: 1 }, // 1px dust speckle
        words: [],
      };

      const blocks = [col1[0], col2[0], noise, col1[1], col2[1]];
      const gutters = detectColumnGutters(blocks);
      expect(gutters.length).toBe(1);
    });

    it('clusters lines with slight baseline jitter / skew into same baseline', () => {
      // Two fragments on the same line with 2pt baseline jitter:
      // Fragment 1: x=50, y=100
      // Fragment 2: x=160, y=102 (line height = 14)
      const lineFragments: OcrLineBlock[] = [
        { text: 'Right Fragment', bbox: { x: 160, y: 102, width: 80, height: 14 }, words: [] },
        { text: 'Left Fragment', bbox: { x: 50, y: 100, width: 80, height: 14 }, words: [] },
      ];

      const sorted = sortLineBlocksTopological(lineFragments);
      // Even though Right Fragment has y=102 and Left has y=100, they are clustered into same baseline
      // and sorted by X ascending: Left Fragment -> Right Fragment
      expect(sorted.map((b) => b.text)).toEqual(['Left Fragment', 'Right Fragment']);
    });
  });

  // =========================================================================
  // 6. Tesseract Block Hierarchy Synchronization
  // =========================================================================
  describe('6. parseTesseractBlocks Synchronization', () => {
    it('synchronizes lines string array and lineBlocks array in topological order', () => {
      // Mock Tesseract block output for a 2-column page
      const mockBlocks = [
        {
          paragraphs: [
            {
              lines: [
                {
                  text: 'Right Column Text',
                  bbox: { x0: 320, y0: 100, x1: 520, y1: 114 },
                  words: [{ text: 'Right', bbox: { x0: 320, y0: 100, x1: 360, y1: 114 } }],
                },
                {
                  text: 'Left Column Text',
                  bbox: { x0: 50, y0: 100, x1: 250, y1: 114 },
                  words: [{ text: 'Left', bbox: { x0: 50, y0: 100, x1: 90, y1: 114 } }],
                },
              ],
            },
          ],
        },
      ];

      const parsed = parseTesseractBlocks(mockBlocks);

      // Verify that topological sort re-ordered Left Column before Right Column
      expect(parsed.lines).toEqual(['Left Column Text', 'Right Column Text']);
      expect(parsed.lineBlocks.map((b) => b.text)).toEqual(['Left Column Text', 'Right Column Text']);
    });
  });

  // =========================================================================
  // 7. Anti-Cheating Decompressed PDF Stream Byte Inspection
  // =========================================================================
  describe('7. Authentic Lossless Sandwich PDF Stream Content Verification', () => {
    it('embeds invisible text layer into PDF stream in exact topological column order without interleaving', async () => {
      // 1. Create a synthetic high-contrast document image (600x400)
      const baseImage = await sharp({
        create: {
          width: 600,
          height: 400,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      // 2. Synthesize 2-column OCR result with identical Y coordinates
      const ocrResult: OcrResult = {
        text: '',
        confidence: 0.95,
        wordCount: 8,
        lines: [],
        lineBlocks: [
          // Interleaved input
          {
            text: 'Left Column Line One',
            bbox: { x: 50, y: 100, width: 200, height: 14 },
            words: [{ text: 'Left Column Line One', bbox: { x: 50, y: 100, width: 200, height: 14 } }],
          },
          {
            text: 'Right Column Line One',
            bbox: { x: 320, y: 100, width: 200, height: 14 },
            words: [{ text: 'Right Column Line One', bbox: { x: 320, y: 100, width: 200, height: 14 } }],
          },
          {
            text: 'Left Column Line Two',
            bbox: { x: 50, y: 140, width: 200, height: 14 },
            words: [{ text: 'Left Column Line Two', bbox: { x: 50, y: 140, width: 200, height: 14 } }],
          },
          {
            text: 'Right Column Line Two',
            bbox: { x: 320, y: 140, width: 200, height: 14 },
            words: [{ text: 'Right Column Line Two', bbox: { x: 320, y: 140, width: 200, height: 14 } }],
          },
        ],
      };

      // 3. Generate lossless sandwich PDF
      const pdfBuffer = await createLosslessSandwichPdfFromImage(baseImage, ocrResult);
      expect(pdfBuffer.toString('ascii', 0, 4)).toBe('%PDF');

      // 4. Decompress PDF /Contents stream and inspect raw text operator sequence
      const decompressed = extractDecompressedPdfStreams(pdfBuffer);

      // Verify all 4 lines exist in the decompressed text
      expect(decompressed).toContain('Left Column Line One');
      expect(decompressed).toContain('Left Column Line Two');
      expect(decompressed).toContain('Right Column Line One');
      expect(decompressed).toContain('Right Column Line Two');

      // 5. Assert strict topological order in the decompressed stream:
      // Left Col Line 1 -> Left Col Line 2 -> Right Col Line 1 -> Right Col Line 2
      const posLeft1 = decompressed.indexOf('Left Column Line One');
      const posLeft2 = decompressed.indexOf('Left Column Line Two');
      const posRight1 = decompressed.indexOf('Right Column Line One');
      const posRight2 = decompressed.indexOf('Right Column Line Two');

      expect(posLeft1).toBeGreaterThanOrEqual(0);
      expect(posLeft2).toBeGreaterThan(posLeft1);
      expect(posRight1).toBeGreaterThan(posLeft2); // Right col MUST come AFTER ALL left col lines!
      expect(posRight2).toBeGreaterThan(posRight1);
    });

    it('injectInvisibleTextLayer sorts blocks prior to rendering onto existing PDF page', async () => {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 400]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      const ocrResult: OcrResult = {
        text: '',
        confidence: 0.95,
        wordCount: 4,
        lines: [],
        lineBlocks: [
          // Interleaved input
          {
            text: 'Alpha Column Left',
            bbox: { x: 50, y: 80, width: 180, height: 12 },
            words: [{ text: 'Alpha Column Left', bbox: { x: 50, y: 80, width: 180, height: 12 } }],
          },
          {
            text: 'Beta Column Right',
            bbox: { x: 330, y: 80, width: 180, height: 12 },
            words: [{ text: 'Beta Column Right', bbox: { x: 330, y: 80, width: 180, height: 12 } }],
          },
        ],
      };

      injectInvisibleTextLayer(page, font, ocrResult);
      const pdfBytes = await pdfDoc.save();
      const decompressed = extractDecompressedPdfStreams(Buffer.from(pdfBytes));

      const posLeft = decompressed.indexOf('Alpha Column Left');
      const posRight = decompressed.indexOf('Beta Column Right');

      expect(posLeft).toBeGreaterThanOrEqual(0);
      expect(posRight).toBeGreaterThan(posLeft);
    });
  });
});
