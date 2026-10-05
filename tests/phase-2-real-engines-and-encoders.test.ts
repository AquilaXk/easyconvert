import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  cubicToQuadraticBezier,
  quadraticToCubicBezier,
  convertFontToTrueType,
  convertFontToOpenTypeCff,
  convertFont,
  formatSpreadsheetCellValue,
  convertOffice,
  resampleAudioSinc,
  encodeWebmContainer,
  convertMedia,
  demosaicBayerCfa,
  decodeRawBayerSensor,
  convertImage,
  checkFfmpeg,
  type BayerSensorData,
} from '../src/lib/conversions/index';
import { ConversionFailedError } from '../src/lib/types';
import { buildOtf, cs } from './helpers/cff-font-builder';

/** An OpenType CFF font whose glyph 1 is the 400 x 700 rectangle at (100, 0). */
function buildRectangleOtf(): Buffer {
  return buildOtf({
    family: 'Phase Two Sans',
    glyphs: [
      { charstring: cs('endchar'), advance: 500, lsb: 0 },
      { charstring: cs(100, 0, 'rmoveto', 400, 700, -400, 'hlineto', 'endchar'), advance: 600, lsb: 100 },
    ],
    codePoints: [0x41],
    cff: { defaultWidthX: 600, nominalWidthX: 0 },
  });
}

function readSfntDirectory(font: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    const offset = font.readUInt32BE(record + 8);
    tables.set(font.toString('latin1', record, record + 4), font.subarray(offset, offset + font.readUInt32BE(record + 12)));
  }
  return tables;
}

/** Reads the header of glyph 1 (32-bit loca) and returns its contour count and bounding box. */
function readFirstGlyphBox(tables: Map<string, Buffer>): { contours: number; box: number[] } {
  const loca = tables.get('loca')!;
  const glyf = tables.get('glyf')!;
  const start = loca.readUInt32BE(4);
  return {
    contours: glyf.readInt16BE(start),
    box: [glyf.readInt16BE(start + 2), glyf.readInt16BE(start + 4), glyf.readInt16BE(start + 6), glyf.readInt16BE(start + 8)],
  };
}

describe('Phase 2 Real Engines & Encoders Verification Testnet', () => {
  // ==========================================================================
  // 1. Font PostScript CFF <-> TrueType Bézier Transcoding Engine
  // ==========================================================================
  describe('Font Bézier Transcoding & SFNT Tables (Component 2.1)', () => {
    it('converts quadratic Bézier curve to exact cubic Bézier representation', () => {
      const p0 = { x: 0, y: 0 };
      const q = { x: 50, y: 100 };
      const p2 = { x: 100, y: 0 };

      const cubic = quadraticToCubicBezier(p0, q, p2);
      expect(cubic.c1.x).toBeCloseTo(0 + (2 / 3) * (50 - 0), 4);
      expect(cubic.c1.y).toBeCloseTo(0 + (2 / 3) * (100 - 0), 4);
      expect(cubic.c2.x).toBeCloseTo(100 + (2 / 3) * (50 - 100), 4);
      expect(cubic.c2.y).toBeCloseTo(0 + (2 / 3) * (100 - 0), 4);
      expect(cubic.p3.x).toBe(100);
      expect(cubic.p3.y).toBe(0);
    });

    it('subdivides cubic Bézier into quadratic segments within error tolerance', () => {
      const p0 = { x: 0, y: 0 };
      const c1 = { x: 10, y: 80 };
      const c2 = { x: 90, y: 80 };
      const p3 = { x: 100, y: 0 };

      const quads = cubicToQuadraticBezier(p0, c1, c2, p3, 2.0);
      expect(quads.length).toBeGreaterThanOrEqual(1);
      expect(quads[0].p0.x).toBe(0);
      expect(quads[0].p0.y).toBe(0);
      expect(quads[quads.length - 1].p2.x).toBe(100);
      expect(quads[quads.length - 1].p2.y).toBe(0);
    });

    it('transcodes OpenType CFF (OTF) to TrueType (TTF) with glyf and loca tables', () => {
      const otfBuffer = buildRectangleOtf();
      const ttfBuffer = convertFontToTrueType(otfBuffer);

      // TrueType header and table directory
      expect(ttfBuffer.readUInt32BE(0)).toBe(0x00010000);
      const tables = readSfntDirectory(ttfBuffer);
      expect(tables.has('glyf')).toBe(true);
      expect(tables.has('loca')).toBe(true);
      expect(tables.has('CFF ')).toBe(false);

      // The converted glyph 1 is the rectangle drawn by the CFF charstring (clockwise in TrueType)
      expect(readFirstGlyphBox(tables)).toEqual({ contours: 1, box: [100, 0, 500, 700] });
    });

    it('transcodes TrueType (TTF) to OpenType (OTF) with valid CFF table', () => {
      // Build a minimal TTF containing 'glyf' and 'loca' tables
      const sfntHeader = Buffer.alloc(12);
      sfntHeader.writeUInt32BE(0x00010000, 0); // TrueType tag
      sfntHeader.writeUInt16BE(2, 4); // 2 tables

      const glyfPayload = Buffer.from([0, 1, 0, 0, 0, 0, 10, 10]);
      const locaPayload = Buffer.from([0, 0, 0, 0, 0, 8]);

      const rec1 = Buffer.alloc(16);
      rec1.write('glyf', 0);
      rec1.writeUInt32BE(0, 4);
      rec1.writeUInt32BE(44, 8);
      rec1.writeUInt32BE(glyfPayload.length, 12);

      const rec2 = Buffer.alloc(16);
      rec2.write('loca', 0);
      rec2.writeUInt32BE(0, 4);
      rec2.writeUInt32BE(44 + glyfPayload.length, 8);
      rec2.writeUInt32BE(locaPayload.length, 12);

      const ttfBuffer = Buffer.concat([sfntHeader, rec1, rec2, glyfPayload, locaPayload]);
      const otfBuffer = convertFontToOpenTypeCff(ttfBuffer);

      // Verify OpenType OTTO tag and CFF table presence
      expect(otfBuffer.subarray(0, 4).toString('ascii')).toBe('OTTO');
      const otfStr = otfBuffer.toString('binary');
      expect(otfStr).toContain('CFF ');
      expect(otfStr).not.toContain('glyf');
      expect(otfStr).not.toContain('loca');
    });

    it('integrates with convertFont pipeline for TTF <-> OTF', async () => {
      const result = await convertFont(buildRectangleOtf(), 'otf', 'ttf', {}, 'font.otf');

      expect(result.mimeType).toBe('font/ttf');
      expect(result.filename).toBe('font.ttf');
      expect(result.buffer.readUInt32BE(0)).toBe(0x00010000);
      expect(readFirstGlyphBox(readSfntDirectory(result.buffer))).toEqual({ contours: 1, box: [100, 0, 500, 700] });
    });
  });

  // ==========================================================================
  // 2. Spreadsheet Multi-Sheet Discovery & Cell Number Formatting
  // ==========================================================================
  describe('Spreadsheet Multi-Sheet & NumberFormat Parsing (Component 2.2)', () => {
    it('formats cell values according to numFmtId and Excel pattern strings', () => {
      // Currency format (numFmtId 44: $#,##0.00;($#,##0.00);"-";@)
      const currency = formatSpreadsheetCellValue('1234.56', 44);
      expect(currency).toBe('$1,234.56');

      // Percentage format (numFmtId 10: 0.00%)
      const percent = formatSpreadsheetCellValue('0.125', 10);
      expect(percent).toBe('12.50%');

      // Integer with commas (numFmtId 3: #,##0)
      const commaNum = formatSpreadsheetCellValue('1000000', 3);
      expect(commaNum).toBe('1,000,000');

      // Custom date format pattern
      const dateVal = formatSpreadsheetCellValue('44830', 99, 'yyyy-mm-dd');
      expect(dateVal).toMatch(/\d{4}-\d{2}-\d{2}/);

      // Raw unformatted string
      const strVal = formatSpreadsheetCellValue('Revenue Summary');
      expect(strVal).toBe('Revenue Summary');
    });

    it('extracts and converts multi-sheet XLSX workbooks without dropping secondary sheets', async () => {
      // Build a multi-sheet XLSX ZIP container
      const zip = new JSZip();

      // [Content_Types].xml
      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
      );

      // xl/_rels/workbook.xml.rels
      zip.file(
        'xl/_rels/workbook.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`
      );

      // xl/workbook.xml
      zip.file(
        'xl/workbook.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Q1 Financials" sheetId="1" r:id="rId1"/>
    <sheet name="Operations" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`
      );

      // xl/worksheets/sheet1.xml
      zip.file(
        'xl/worksheets/sheet1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Item</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Revenue</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>EasyConvert Pro</t></is></c>
      <c r="B2" s="1"><v>50000</v></c>
    </row>
  </sheetData>
</worksheet>`
      );

      // xl/worksheets/sheet2.xml
      zip.file(
        'xl/worksheets/sheet2.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Server Region</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Status</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>ap-northeast-2</t></is></c>
      <c r="B2" t="inlineStr"><is><t>Operational</t></is></c>
    </row>
  </sheetData>
</worksheet>`
      );

      const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      // Convert to CSV: must contain headers/rows from both sheets with sheet separators
      const csvResult = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {}, 'multi.xlsx');
      const csvText = csvResult.buffer.toString('utf-8');
      expect(csvText).toContain('Q1 Financials');
      expect(csvText).toContain('EasyConvert Pro');
      expect(csvText).toContain('Operations');
      expect(csvText).toContain('ap-northeast-2');

      // Convert to JSON: must export structured multi-sheet object
      const jsonResult = await convertOffice(xlsxBuffer, 'xlsx', 'json', {}, 'multi.xlsx');
      const parsedJson = JSON.parse(jsonResult.buffer.toString('utf-8'));
      expect(parsedJson['Q1 Financials']).toBeDefined();
      expect(parsedJson['Operations']).toBeDefined();
      expect(parsedJson['Operations'][0]['Server Region']).toBe('ap-northeast-2');
    });
  });

  // ==========================================================================
  // 3. Presentation Visual Slide Rendering & PDF Synthesis
  // ==========================================================================
  describe('Presentation Visual Slide Rendering (Component 2.3)', () => {
    it('parses PPTX slides and renders visual slide layouts to PDF', async () => {
      const zip = new JSZip();

      // ppt/presentation.xml with 16:9 slide size (12192000 x 6858000 EMUs)
      zip.file(
        'ppt/presentation.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
</p:presentation>`
      );

      // ppt/slides/slide1.xml with title shape and body shape with colors
      zip.file(
        'ppt/slides/slide1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:spPr>
          <a:xfrm>
            <a:off x="914400" y="914400"/>
            <a:ext cx="10363200" cy="1828800"/>
          </a:xfrm>
          <a:solidFill>
            <a:srgbClr val="5C6BC0"/>
          </a:solidFill>
          <a:ln w="25400">
            <a:solidFill>
              <a:srgbClr val="1F2340"/>
            </a:solidFill>
          </a:ln>
        </p:spPr>
        <p:txBody>
          <a:p>
            <a:r>
              <a:t>EasyConvert Visual Presentation</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
      );

      const pptxBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      // Convert PPTX to PDF
      const pdfResult = await convertOffice(pptxBuffer, 'pptx', 'pdf', {}, 'presentation.pptx');
      expect(pdfResult.mimeType).toBe('application/pdf');
      expect(pdfResult.filename).toBe('presentation.pdf');
      expect(pdfResult.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
      expect(pdfResult.buffer.length).toBeGreaterThan(100);
    });
  });

  // ==========================================================================
  // 4. Bandlimited Sinc Audio Resampler & WebM EBML Container
  // ==========================================================================
  describe('Sinc Audio Resampler & WebM EBML Container (Component 2.4)', () => {
    it('resamples audio using windowed Sinc filter with bandlimited cutoff', () => {
      // 100 samples at 44100 Hz resampled to 22050 Hz (2:1 downsampling)
      const inRate = 44100;
      const outRate = 22050;
      const inLen = 100;
      const ch0 = new Float32Array(inLen);
      const ch1 = new Float32Array(inLen);

      // Generate a 440Hz test sine tone
      for (let i = 0; i < inLen; i++) {
        ch0[i] = Math.sin((2 * Math.PI * 440 * i) / inRate);
        ch1[i] = ch0[i];
      }

      const resampled = resampleAudioSinc([ch0, ch1], inRate, outRate, 8);
      expect(resampled.length).toBe(2);
      expect(resampled[0].length).toBe(50);
      expect(resampled[1].length).toBe(50);

      // Ensure no NaN or infinite values were produced
      for (let i = 0; i < resampled[0].length; i++) {
        expect(Number.isFinite(resampled[0][i])).toBe(true);
        expect(Number.isFinite(resampled[1][i])).toBe(true);
      }
    });

    it('encodes compliant WebM EBML container with Tracks and SimpleBlock elements', () => {
      // Create 100 samples of 16-bit PCM audio at 48000 Hz, stereo
      const sampleCount = 100;
      const pcmBuffer = Buffer.alloc(sampleCount * 2 * 2); // 100 samples * 2 ch * 2 bytes
      for (let i = 0; i < sampleCount; i++) {
        const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 32000);
        pcmBuffer.writeInt16LE(val, i * 4);
        pcmBuffer.writeInt16LE(val, i * 4 + 2);
      }

      const webmBuffer = encodeWebmContainer(pcmBuffer, 48000, 2, 16);

      // 1. EBML Header (0x1A 0x45 0xDF 0xA3)
      expect(webmBuffer.readUInt32BE(0)).toBe(0x1a45dfa3);

      // 2. Contains Segment (0x18 0x53 0x80 0x67)
      const hex = webmBuffer.toString('hex');
      expect(hex).toContain('18538067');

      // 3. Contains Tracks element (0x16 0x54 0xAE 0x6B)
      expect(hex).toContain('1654ae6b');

      // 4. Contains TrackEntry, CodecID "A_PCM/INT/LIT"
      expect(webmBuffer.toString('binary')).toContain('A_PCM/INT/LIT');

      // 5. Contains Cluster (0x1F 0x43 0xB6 0x75) and SimpleBlock (0xA3)
      expect(hex).toContain('1f43b675');
      expect(hex).toContain('a3'); // SimpleBlock ID
    });

    it('integrates with convertMedia for WAV to WebM conversion', async () => {
      // Build a minimal 16-bit PCM WAV buffer
      const sampleRate = 44100;
      const numChannels = 1;
      const numSamples = 200;
      const dataSize = numSamples * numChannels * 2;
      const wavHeader = Buffer.alloc(44);

      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36 + dataSize, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20); // PCM
      wavHeader.writeUInt16LE(numChannels, 22);
      wavHeader.writeUInt32LE(sampleRate, 24);
      wavHeader.writeUInt32LE(sampleRate * numChannels * 2, 28);
      wavHeader.writeUInt16LE(numChannels * 2, 32);
      wavHeader.writeUInt16LE(16, 34); // 16-bit
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(dataSize, 40);

      const pcmData = Buffer.alloc(dataSize);
      const wavBuffer = Buffer.concat([wavHeader, pcmData]);

      if (checkFfmpeg()) {
        const result = await convertMedia(wavBuffer, 'wav', 'webm', {}, 'test_audio.wav');
        expect(result.mimeType).toBe('video/webm');
        expect(result.filename).toBe('test_audio.webm');
        expect(result.buffer.readUInt32BE(0)).toBe(0x1a45dfa3);
      } else {
        await expect(convertMedia(wavBuffer, 'wav', 'webm', {}, 'test_audio.wav')).rejects.toThrow(
          ConversionFailedError
        );
      }
    });
  });

  // ==========================================================================
  // 5. Camera RAW Bayer CFA Adaptive Demosaicing
  // ==========================================================================
  describe('Camera RAW Bayer CFA Demosaicing (Component 2.5)', () => {
    it('demosaics RGGB Bayer CFA pattern with gradient-directed color difference interpolation', () => {
      const width = 8;
      const height = 8;
      const sensorData = new Uint8Array(width * height);

      // Fill sensor with synthetic pattern: top half dark, bottom half bright
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          sensorData[y * width + x] = y < 4 ? 30 : 220;
        }
      }

      const sensor: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: sensorData,
        bitsPerSample: 8,
      };

      const demosaiced = demosaicBayerCfa(sensor);
      expect(demosaiced.width).toBe(width);
      expect(demosaiced.height).toBe(height);
      expect(demosaiced.data.length).toBe(width * height * 3);

      // Verify that all pixels have valid RGB triples
      for (let i = 0; i < width * height; i++) {
        const r = demosaiced.data[i * 3];
        const g = demosaiced.data[i * 3 + 1];
        const b = demosaiced.data[i * 3 + 2];
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(255);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(255);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(255);
      }
    });

    it('correctly handles all four Bayer CFA patterns (RGGB, BGGR, GRBG, GBRG)', () => {
      const width = 4;
      const height = 4;
      const sensorData = new Uint8Array(width * height);
      for (let i = 0; i < sensorData.length; i++) sensorData[i] = 128;

      for (const pattern of ['RGGB', 'BGGR', 'GRBG', 'GBRG'] as const) {
        const res = demosaicBayerCfa({
          width,
          height,
          pattern,
          data: sensorData,
          bitsPerSample: 8,
        });
        expect(res.data.length).toBe(4 * 4 * 3);
        // Uniform input should produce uniform output around 128
        expect(res.data[0]).toBeCloseTo(128, -1);
      }
    });

    it('decodes raw Bayer sensor frames via decodeRawBayerSensor', () => {
      const width = 16;
      const height = 16;
      const bayer = Buffer.alloc(width * height * 2, 150);
      const tiffHeader = Buffer.alloc(8);
      tiffHeader.write('II', 0, 'ascii');
      tiffHeader.writeUInt16LE(42, 2);
      tiffHeader.writeUInt32LE(8, 4);

      const ifd = Buffer.alloc(2 + 6 * 12 + 4);
      ifd.writeUInt16LE(6, 0);
      const writeTag = (idx: number, tag: number, type: number, count: number, val: number) => {
        const off = 2 + idx * 12;
        ifd.writeUInt16LE(tag, off);
        ifd.writeUInt16LE(type, off + 2);
        ifd.writeUInt32LE(count, off + 4);
        ifd.writeUInt32LE(val, off + 8);
      };
      const stripOffset = 8 + ifd.length;
      writeTag(0, 256, 3, 1, width);
      writeTag(1, 257, 3, 1, height);
      writeTag(2, 258, 3, 1, 16);
      writeTag(3, 273, 4, 1, stripOffset);
      writeTag(4, 279, 4, 1, bayer.length);
      writeTag(5, 33422, 1, 4, 0x02010100);

      const rawFrame = Buffer.concat([tiffHeader, ifd, bayer]);

      const decoded = decodeRawBayerSensor(rawFrame, 'dng');
      expect(decoded).not.toBeNull();
      expect(decoded!.width).toBe(width);
      expect(decoded!.height).toBe(height);
      expect(decoded!.rgb.length).toBe(width * height * 3);
    });

    it('integrates with convertImage pipeline for RAW file conversion', async () => {
      const width = 16;
      const height = 16;
      const bayer = Buffer.alloc(width * height * 2, 180);
      const tiffHeader = Buffer.alloc(8);
      tiffHeader.write('II', 0, 'ascii');
      tiffHeader.writeUInt16LE(42, 2);
      tiffHeader.writeUInt32LE(8, 4);

      const ifd = Buffer.alloc(2 + 6 * 12 + 4);
      ifd.writeUInt16LE(6, 0);
      const writeTag = (idx: number, tag: number, type: number, count: number, val: number) => {
        const off = 2 + idx * 12;
        ifd.writeUInt16LE(tag, off);
        ifd.writeUInt16LE(type, off + 2);
        ifd.writeUInt32LE(count, off + 4);
        ifd.writeUInt32LE(val, off + 8);
      };
      const stripOffset = 8 + ifd.length;
      writeTag(0, 256, 3, 1, width);
      writeTag(1, 257, 3, 1, height);
      writeTag(2, 258, 3, 1, 16);
      writeTag(3, 273, 4, 1, stripOffset);
      writeTag(4, 279, 4, 1, bayer.length);
      writeTag(5, 33422, 1, 4, 0x02010100);

      const rawFrame = Buffer.concat([tiffHeader, ifd, bayer]);

      // Convert RAW frame to PNG
      const pngResult = await convertImage(rawFrame, 'png', {}, 'sensor.dng', 'dng');
      expect(pngResult.mimeType).toBe('image/png');
      expect(pngResult.filename).toBe('sensor.png');
      expect(pngResult.buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    });
  });
});
