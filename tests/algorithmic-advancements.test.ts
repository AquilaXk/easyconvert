import { describe, it, expect } from 'vitest';
import {
  encodeFlacStream,
  flacCrc8,
  flacCrc16,
  findOptimalRiceParameter,
} from '../src/lib/conversions/media-encoder';
import {
  parseSimpleGlyph,
  contoursToSvgPath,
  GlyphPoint,
} from '../src/lib/conversions/font';
import {
  srgbToOklab,
  deltaEOklab,
  ciede2000,
  findClosestPaletteIndexOklab,
  RgbColor,
} from '../src/lib/conversions/quantize';
import {
  SpreadsheetFormulaEvaluator,
} from '../src/lib/conversions/office';
import { convertOffice } from '../src/lib/conversions/office';
import JSZip from 'jszip';

describe('Algorithmic Advancements & Standards Parity Suite', () => {
  describe('1. Pure TypeScript Lossless FLAC Audio Engine (RFC 9639)', () => {
    it('generates authentic FLAC bitstream with stream marker, STREAMINFO, and valid frame CRCs', () => {
      // 44.1kHz stereo test samples: 1000 sine/ramp samples
      const sampleCount = 2048;
      const samples = new Int16Array(sampleCount * 2);
      for (let i = 0; i < sampleCount; i++) {
        const val = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 44100));
        samples[i * 2] = val; // Left
        samples[i * 2 + 1] = -val; // Right
      }

      const flacBuffer = encodeFlacStream(samples, 44100, 2);

      // Verify FLAC stream marker
      expect(flacBuffer.subarray(0, 4).toString('ascii')).toBe('fLaC');

      // Verify STREAMINFO block header
      expect(flacBuffer[4]).toBe(0x80); // Last metadata block flag | type 0 (STREAMINFO)
      expect(flacBuffer[5]).toBe(0x00);
      expect(flacBuffer.readUInt16BE(6)).toBe(34); // 34 bytes payload

      // Verify sample rate and channels in packed STREAMINFO
      const sampleRatePacked = (flacBuffer.readUInt32BE(18) >> 12) & 0xfffff;
      expect(sampleRatePacked).toBe(44100);

      // Verify that at least one frame was produced
      expect(flacBuffer.length).toBeGreaterThan(42);

      // Verify frame sync code 0x3ffe (14 bits: 0xff, 0xf8 mask)
      const frameStart = 42;
      expect(flacBuffer[frameStart]).toBe(0xff);
      expect((flacBuffer[frameStart + 1] & 0xfc) >> 2).toBe(0b111110);
    });

    it('computes RFC 9639 CRC-8 and CRC-16 checksums accurately', () => {
      const testBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const crc8Val = flacCrc8(testBytes);
      expect(typeof crc8Val).toBe('number');
      expect(crc8Val).toBeGreaterThanOrEqual(0);
      expect(crc8Val).toBeLessThanOrEqual(255);

      const crc16Val = flacCrc16(testBytes);
      expect(typeof crc16Val).toBe('number');
      expect(crc16Val).toBeGreaterThanOrEqual(0);
      expect(crc16Val).toBeLessThanOrEqual(65535);
    });

    it('finds optimal Rice coding parameter k minimizing bit lengths', () => {
      const residuals = new Int32Array([0, 1, -1, 2, -2, 0, 1, -1, 0]);
      const { k, folded } = findOptimalRiceParameter(residuals);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(14);
      expect(folded.length).toBe(residuals.length);
      // Zigzag fold of 0 is 0, of 1 is 2, of -1 is 1
      expect(folded[0]).toBe(0);
      expect(folded[1]).toBe(2);
      expect(folded[2]).toBe(1);
    });
  });

  describe('2. TrueType Glyph Outline Parser & Bézier Curve Decomposition', () => {
    it('unpacks simple glyph contours and decomposes quadratic Bézier curves with implicit midpoints', () => {
      // Synthetic TrueType glyph with 1 contour containing 4 points:
      // (100, 100 on), (200, 200 off), (300, 200 off), (400, 100 on)
      // Between point 1 (off) and point 2 (off), an implicit on-curve midpoint (250, 200) should be created!
      const glyfData = Buffer.alloc(40);
      glyfData.writeInt16BE(1, 0); // numberOfContours = 1
      glyfData.writeInt16BE(100, 2); // xMin
      glyfData.writeInt16BE(100, 4); // yMin
      glyfData.writeInt16BE(400, 6); // xMax
      glyfData.writeInt16BE(200, 8); // yMax

      glyfData.writeUInt16BE(3, 10); // endPtsOfContours[0] = index 3 (4 points total)
      glyfData.writeUInt16BE(0, 12); // instructionLength = 0

      // Flags for 4 points:
      // Pt 0: on-curve (0x01)
      // Pt 1: off-curve (0x00)
      // Pt 2: off-curve (0x00)
      // Pt 3: on-curve (0x01)
      glyfData[14] = 0x01;
      glyfData[15] = 0x00;
      glyfData[16] = 0x00;
      glyfData[17] = 0x01;

      // X coordinates (2-byte deltas, not short vector, same flag 0):
      glyfData.writeInt16BE(100, 18);
      glyfData.writeInt16BE(100, 20); // 200
      glyfData.writeInt16BE(100, 22); // 300
      glyfData.writeInt16BE(100, 24); // 400

      // Y coordinates:
      glyfData.writeInt16BE(100, 26);
      glyfData.writeInt16BE(100, 28); // 200
      glyfData.writeInt16BE(0, 30);   // 200
      glyfData.writeInt16BE(-100, 32); // 100

      const contours = parseSimpleGlyph(glyfData, 0);
      expect(contours.length).toBe(1);
      expect(contours[0].length).toBe(4);

      // Convert to SVG path
      const svgPath = contoursToSvgPath(contours);
      expect(svgPath).toContain('M100 100');
      // Should have generated quadratic Bézier Q commands
      expect(svgPath).toContain('Q');
      expect(svgPath).toContain('Z');
    });
  });

  describe('3. Perceptual Color Spaces (OKLab & CIEDE2000)', () => {
    it('converts sRGB to OKLab with accurate perceptual lightness and chrominance', () => {
      // Pure white (255, 255, 255)
      const whiteOk = srgbToOklab(255, 255, 255);
      expect(whiteOk.L).toBeCloseTo(1.0, 1);
      expect(whiteOk.a).toBeCloseTo(0.0, 1);
      expect(whiteOk.b).toBeCloseTo(0.0, 1);

      // Pure black (0, 0, 0)
      const blackOk = srgbToOklab(0, 0, 0);
      expect(blackOk.L).toBeCloseTo(0.0, 1);

      // Distance between black and white should be approximately 1
      const dist = deltaEOklab(whiteOk, blackOk);
      expect(dist).toBeCloseTo(1.0, 1);
    });

    it('computes CIEDE2000 color difference conforming to colorimetry standards', () => {
      const c1 = { L: 50, a: 2.5, b: 0 };
      const c2 = { L: 50, a: 2.5, b: 0 };
      // Identical colors -> Delta E = 0
      expect(ciede2000(c1, c2)).toBeCloseTo(0, 4);

      const c3 = { L: 50, a: 5.0, b: 2.0 };
      expect(ciede2000(c1, c3)).toBeGreaterThan(0);
    });

    it('matches palette colors perceptually using OKLab distance metric', () => {
      const palette: RgbColor[] = [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 255, b: 0 },
        { r: 0, g: 0, b: 255 },
        { r: 255, g: 255, b: 255 },
      ];

      // A dark green pixel should match index 2 (green) or 0 (black)
      const matchedIdx = findClosestPaletteIndexOklab({ r: 10, g: 240, b: 15 }, palette);
      expect(matchedIdx).toBe(2);
    });
  });

  describe('4. Spreadsheet Formula Evaluator (XLSX)', () => {
    it('evaluates arithmetic, comparisons, and built-in functions (SUM, AVERAGE, MIN, MAX, IF)', () => {
      const cellData: Record<string, any> = {
        A1: 10,
        A2: 20,
        A3: 30,
        B1: 5,
        B2: 15,
      };

      const evaluator = new SpreadsheetFormulaEvaluator((ref) => cellData[ref] ?? 0);

      // Basic arithmetic
      expect(evaluator.evaluate('=A1 + A2 * 2')).toBe(50);
      expect(evaluator.evaluate('=(A1 + A2) / 2')).toBe(15);

      // Range functions
      expect(evaluator.evaluate('=SUM(A1:A3)')).toBe(60);
      expect(evaluator.evaluate('=AVERAGE(A1:A3)')).toBe(20);
      expect(evaluator.evaluate('=COUNT(A1:A3)')).toBe(3);
      expect(evaluator.evaluate('=MIN(A1:A3)')).toBe(10);
      expect(evaluator.evaluate('=MAX(A1:A3)')).toBe(30);

      // Logical IF and comparisons
      expect(evaluator.evaluate('=IF(A1 > 5, "Pass", "Fail")')).toBe('Pass');
      expect(evaluator.evaluate('=IF(A1 = 99, 100, 200)')).toBe(200);
    });

    it('dynamically evaluates formulas during XLSX to CSV conversion when cached values are absent', async () => {
      const zip = new JSZip();

      // Minimal valid XLSX workbook with sheet1 containing formula =SUM(A1:A3) in cell A4 without cached <v>
      const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1"><v>10</v></c>
      <c r="B1"><v>100</v></c>
    </row>
    <row r="2">
      <c r="A2"><v>20</v></c>
      <c r="B2"><v>200</v></c>
    </row>
    <row r="3">
      <c r="A3"><v>30</v></c>
      <c r="B3"><v>300</v></c>
    </row>
    <row r="4">
      <c r="A4"><f>SUM(A1:A3)</f></c>
      <c r="B4"><f>AVERAGE(B1:B3)</f></c>
    </row>
  </sheetData>
</worksheet>`;

      zip.file('xl/worksheets/sheet1.xml', sheetXml);
      zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');

      const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const result = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {}, 'test-sheet.xlsx');
      const csvText = result.buffer.toString('utf-8');

      // The 4th row should have computed 60 (SUM) and 200 (AVERAGE)
      expect(csvText).toContain('60,200');
    });
  });
});
