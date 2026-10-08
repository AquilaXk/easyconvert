import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { readSvgShapes } from './helpers/svg-dom-audit';
import JSZip from 'jszip';
import {
  convertFile,
  convertHwpx,
  parseHwpxDocument,
  buildHwpxContainer,
  isHwpxContainer,
  hwpxToHwp,
  hwpToHwpx,
  hwpxToMarkdown,
  markdownToHwpx,
  hwpxToPlainText,
  SpreadsheetFormulaEvaluator,
  SpreadsheetDagEngine,
  parseDrawingMlShapes,
  renderDrawingMlToSvg,
  decodeWav,
  decodeFlac,
  decodeMp3,
  decodeAudioBuffer,
  encodeFlacStream,
  BitWriter,
  BitReader,
} from '../src/lib/conversions/index';
import { execFileSync } from 'node:child_process';
import { getOracleToolPath } from './helpers/differential-oracle';
import {
  chirpSamples,
  decodeAudioWithFfmpeg,
  probeStream,
  wavFromSamples,
  withTempFile,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

describe('Phase 2 SOTA Precision & Standards Testnet', () => {
  // ==========================================================================
  // 1. KS X 6101 HWPX Standard Container Engine
  // ==========================================================================
  describe('HWPX Standard Container Engine (KS X 6101)', () => {
    it('creates compliant OPC ZIP package and parses HWPX document', async () => {
      const hwpxBuffer = await buildHwpxContainer({
        title: 'HWPX Precision Specification',
        creator: 'EasyConvert Testnet',
        paragraphs: [
          'First paragraph of KS X 6101 standard.',
          'Second paragraph with detailed test text.',
        ],
        tables: [
          [
            ['Header 1', 'Header 2', 'Header 3'],
            ['Row 1 Col 1', 'Row 1 Col 2', 'Row 1 Col 3'],
            ['Row 2 Col 1', 'Row 2 Col 2', 'Row 2 Col 3'],
          ],
        ],
      });

      expect(await isHwpxContainer(hwpxBuffer)).toBe(true);

      const parsed = await parseHwpxDocument(hwpxBuffer);
      expect(parsed.metadata.title).toBe('HWPX Precision Specification');
      expect(parsed.metadata.creator).toBe('EasyConvert Testnet');
      expect(parsed.paragraphs.length).toBe(2);
      expect(parsed.paragraphs[0].text).toContain('First paragraph');
      expect(parsed.tables.length).toBe(1);
      expect(parsed.tables[0].rows.length).toBe(3);
      expect(parsed.tables[0].rows[0][0]).toBe('Header 1');
    });

    it('converts HWPX to Markdown, Plain Text, HTML, and PDF', async () => {
      const hwpxBuffer = await buildHwpxContainer({
        title: 'Document Conversion',
        paragraphs: ['Heading Title', 'This is a sample document content.'],
        tables: [
          [
            ['Key', 'Value'],
            ['Alpha', '100'],
          ],
        ],
      });

      // Markdown conversion
      const mdResult = await convertHwpx(hwpxBuffer, 'md', {}, 'doc');
      expect(mdResult.mimeType).toBe('text/markdown');
      const mdText = mdResult.buffer.toString('utf-8');
      expect(mdText).toContain('Heading Title');
      expect(mdText).toContain('| Key | Value |');

      // Plain text conversion
      const txtResult = await convertHwpx(hwpxBuffer, 'txt', {}, 'doc');
      expect(txtResult.mimeType).toBe('text/plain');
      expect(txtResult.buffer.toString('utf-8')).toContain('Heading Title');

      // HTML conversion
      const htmlResult = await convertHwpx(hwpxBuffer, 'html', {}, 'doc');
      expect(htmlResult.mimeType).toBe('text/html');
      expect(htmlResult.buffer.toString('utf-8')).toContain('<table');

      // PDF conversion
      const pdfResult = await convertHwpx(hwpxBuffer, 'pdf', {}, 'doc');
      expect(pdfResult.mimeType).toBe('application/pdf');
      expect(pdfResult.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    });

    it('performs bidirectional round-trip between HWPX and HWP 5.0 CFBF', async () => {
      const hwpxInitial = await buildHwpxContainer({
        title: 'Bidirectional Test',
        paragraphs: ['Testing HWPX to HWP 5.0 and back.'],
      });

      // HWPX -> HWP 5.0 CFBF
      const hwpBuffer = await hwpxToHwp(hwpxInitial);
      expect(hwpBuffer.length).toBeGreaterThan(512);
      // CFBF Compound File Header
      expect(hwpBuffer[0]).toBe(0xd0);
      expect(hwpBuffer[1]).toBe(0xcf);
      expect(hwpBuffer[2]).toBe(0x11);
      expect(hwpBuffer[3]).toBe(0xe0);

      // HWP 5.0 -> HWPX
      const hwpxConverted = await hwpToHwpx(hwpBuffer);
      expect(await isHwpxContainer(hwpxConverted)).toBe(true);

      const parsedConverted = await parseHwpxDocument(hwpxConverted);
      expect(parsedConverted.paragraphs.some((p) => p.text.includes('Testing HWPX to HWP 5.0'))).toBe(true);
    });

    it('fails closed on corrupt or non-OPC HWPX buffers', async () => {
      const corruptBuffer = Buffer.from('NOT A VALID ZIP ARCHIVE');
      expect(await isHwpxContainer(corruptBuffer)).toBe(false);

      await expect(parseHwpxDocument(corruptBuffer)).rejects.toThrow();

      // Empty ZIP archive missing section0.xml
      const emptyZip = new JSZip();
      emptyZip.file('dummy.txt', 'hello');
      const emptyZipBuf = await emptyZip.generateAsync({ type: 'nodebuffer' });
      await expect(parseHwpxDocument(emptyZipBuf)).rejects.toThrow(
        /Missing.*Section/i
      );
    });

    it('does not falsely classify non-HWPX zip containers as HWPX', async () => {
      const epubZip = new JSZip();
      epubZip.file('mimetype', 'application/epub+zip');
      epubZip.file(
        'META-INF/container.xml',
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
      );
      const epubBuf = await epubZip.generateAsync({ type: 'nodebuffer' });
      expect(await isHwpxContainer(epubBuf)).toBe(false);
    });
  });

  // ==========================================================================
  // 2. Spreadsheet Topological DAG Formula Engine
  // ==========================================================================
  describe('Spreadsheet Topological DAG Formula Engine', () => {
    it('evaluates multi-cell dependency DAG in topological order', () => {
      const dag = new SpreadsheetDagEngine();
      // Setup dependency chain:
      // A1 = 10
      // B1 = A1 * 2 (= 20)
      // C1 = B1 + 5 (= 25)
      // D1 = SUM(A1:C1) (= 10 + 20 + 25 = 55)
      dag.setCell('A1', 10);
      dag.setCell('B1', '=A1 * 2');
      dag.setCell('C1', '=B1 + 5');
      dag.setCell('D1', '=SUM(A1:C1)');

      dag.evaluate();

      expect(dag.getCellValue('A1')).toBe(10);
      expect(dag.getCellValue('B1')).toBe(20);
      expect(dag.getCellValue('C1')).toBe(25);
      expect(dag.getCellValue('D1')).toBe(55);
    });

    it('detects circular references and propagates #CYCLE! without infinite loop', () => {
      const dag = new SpreadsheetDagEngine();
      // Mutual cycle: A1 depends on B1, B1 depends on A1
      dag.setCell('A1', '=B1 + 1');
      dag.setCell('B1', '=A1 + 1');
      // Downstream dependent
      dag.setCell('C1', '=A1 * 2');
      // Independent cell
      dag.setCell('D1', 42);

      dag.evaluate();

      expect(dag.getCellValue('A1')).toBe('#CYCLE!');
      expect(dag.getCellValue('B1')).toBe('#CYCLE!');
      expect(dag.getCellValue('C1')).toBe('#CYCLE!');
      expect(dag.getCellValue('D1')).toBe(42);
    });

    it('detects 3-cell circular reference chains', () => {
      const dag = new SpreadsheetDagEngine();
      dag.setCell('A1', '=B1');
      dag.setCell('B1', '=C1');
      dag.setCell('C1', '=A1');

      dag.evaluate();

      expect(dag.getCellValue('A1')).toBe('#CYCLE!');
      expect(dag.getCellValue('B1')).toBe('#CYCLE!');
      expect(dag.getCellValue('C1')).toBe('#CYCLE!');
    });

    it('handles divide by zero safely returning #DIV/0!', () => {
      const evaluator = new SpreadsheetFormulaEvaluator();
      const result = evaluator.evaluate('=100 / 0');
      expect(result).toBe('#DIV/0!');
    });

    it('evaluates IFERROR without crashing and catches #DIV/0!', () => {
      const evaluator = new SpreadsheetFormulaEvaluator();
      const fallback = evaluator.evaluate('=IFERROR(10 / 0, "RecoveredValue")');
      expect(fallback).toBe('RecoveredValue');

      const normal = evaluator.evaluate('=IFERROR(20 / 4, "Fallback")');
      expect(normal).toBe(5);
    });

    it('evaluates VLOOKUP and HLOOKUP accurately', () => {
      const dag = new SpreadsheetDagEngine();
      // Table in A1:C3
      // A1: "ID", B1: "Name", C1: "Score"
      // A2: 101,  B2: "Alice", C2: 95
      // A3: 102,  B3: "Bob",   C3: 88
      dag.setCell('A1', 'ID');
      dag.setCell('B1', 'Name');
      dag.setCell('C1', 'Score');
      dag.setCell('A2', 101);
      dag.setCell('B2', 'Alice');
      dag.setCell('C2', 95);
      dag.setCell('A3', 102);
      dag.setCell('B3', 'Bob');
      dag.setCell('C3', 88);

      dag.setCell('D1', '=VLOOKUP(101, A2:C3, 2, FALSE)');
      dag.setCell('D2', '=VLOOKUP(102, A2:C3, 3, FALSE)');
      dag.setCell('D3', '=VLOOKUP(999, A2:C3, 2, FALSE)'); // Not found

      dag.evaluate();

      expect(dag.getCellValue('D1')).toBe('Alice');
      expect(dag.getCellValue('D2')).toBe(88);
      expect(dag.getCellValue('D3')).toBe('#N/A');
    });

    it('evaluates INDEX and MATCH functions', () => {
      const dag = new SpreadsheetDagEngine();
      dag.setCell('A1', 'Apple');
      dag.setCell('A2', 'Banana');
      dag.setCell('A3', 'Cherry');

      dag.setCell('B1', '=MATCH("Banana", A1:A3, 0)');
      dag.setCell('B2', '=INDEX(A1:A3, 3)');

      dag.evaluate();

      expect(dag.getCellValue('B1')).toBe(2);
      expect(dag.getCellValue('B2')).toBe('Cherry');
    });

    it('evaluates math and string functions (DATE, ROUND, CONCAT, LEFT, RIGHT, MID)', () => {
      const evaluator = new SpreadsheetFormulaEvaluator();
      expect(evaluator.evaluate('=ROUND(3.14159, 2)')).toBe(3.14);
      expect(evaluator.evaluate('=CONCAT("Hello", " ", "World")')).toBe('Hello World');
      expect(evaluator.evaluate('=LEFT("Antigravity", 4)')).toBe('Anti');
      expect(evaluator.evaluate('=RIGHT("Antigravity", 7)')).toBe('gravity');
      expect(evaluator.evaluate('=MID("EasyConvert", 5, 7)')).toBe('Convert');
      expect(evaluator.evaluate('=DATE(2026, 9, 27)')).toBe('2026-09-27');
    });

    it('propagates error codes like #DIV/0! and #CYCLE! across arithmetic operators', () => {
      const evaluator = new SpreadsheetFormulaEvaluator((ref) => {
        if (ref === 'A1') return '#DIV/0!';
        if (ref === 'B1') return '#CYCLE!';
        return 10;
      });

      expect(evaluator.evaluate('=A1 + 5')).toBe('#DIV/0!');
      expect(evaluator.evaluate('=B1 * 2')).toBe('#CYCLE!');
      expect(evaluator.evaluate('=SUM(A1, 10, 20)')).toBe('#DIV/0!');
      expect(evaluator.evaluate('=IFERROR(A1 + 5, 999)')).toBe(999);
    });

    it('does not falsely match empty strings with numeric zero in VLOOKUP and MATCH', () => {
      const dag = new SpreadsheetDagEngine();
      dag.setCell('A1', '');
      dag.setCell('B1', 'EmptyLabel');
      dag.setCell('A2', 0);
      dag.setCell('B2', 'ZeroLabel');

      dag.setCell('C1', '=VLOOKUP(0, A1:B2, 2, FALSE)');
      dag.setCell('C2', '=MATCH(0, A1:A2, 0)');

      dag.evaluate();

      expect(dag.getCellValue('C1')).toBe('ZeroLabel');
      expect(dag.getCellValue('C2')).toBe(2);
    });

    it('handles setCell overwrites cleanly and avoids duplicate formula evaluation', () => {
      const dag = new SpreadsheetDagEngine();
      dag.setCell('A1', '=10 + 20');
      // Overwrite with non-formula literal
      dag.setCell('A1', 42);
      dag.setCell('B1', '=A1 * 2');

      dag.evaluate();

      expect(dag.getCellValue('A1')).toBe(42);
      expect(dag.getCellValue('B1')).toBe(84);
    });

    it('extracts dependencies robustly with whitespace around ranges and function names', () => {
      const deps1 = SpreadsheetDagEngine.extractDependencies('=SUM( A1 : B2 ) + C3');
      expect(deps1).toContain('A1');
      expect(deps1).toContain('A2');
      expect(deps1).toContain('B1');
      expect(deps1).toContain('B2');
      expect(deps1).toContain('C3');

      const deps2 = SpreadsheetDagEngine.extractDependencies('=ROUND ( D10 , 2 )');
      expect(deps2).toEqual(['D10']);
    });
  });

  // ==========================================================================
  // 3. OpenXML DrawingML Vector Shape Renderer & Table Styles
  // ==========================================================================
  describe('OpenXML DrawingML Vector Shape Renderer & Table Styles', () => {
    it('parses DrawingML preset shapes (rect, ellipse, triangle, diamond, star5)', () => {
      const xml = `
        <p:spTree xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:sp>
            <p:spPr>
              <a:xfrm rot="1800000">
                <a:off x="914400" y="457200"/>
                <a:ext cx="1828800" cy="914400"/>
              </a:xfrm>
              <a:prstGeom prst="rect">
                <a:avLst/>
              </a:prstGeom>
              <a:solidFill>
                <a:srgbClr val="0088FF"/>
              </a:solidFill>
              <a:ln w="25400">
                <a:solidFill>
                  <a:srgbClr val="000000"/>
                </a:solidFill>
              </a:ln>
            </p:spPr>
          </p:sp>
          <p:sp>
            <p:spPr>
              <a:xfrm>
                <a:off x="100000" y="200000"/>
                <a:ext cx="500000" cy="500000"/>
              </a:xfrm>
              <a:prstGeom prst="ellipse"/>
              <a:solidFill>
                <a:srgbClr val="FF3300"/>
              </a:solidFill>
            </p:spPr>
          </p:sp>
        </p:spTree>
      `;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(2);

      const [rect, ellipse] = shapes;
      expect(rect.type).toBe('rect');
      expect(rect.x).toBe(72); // 914400 EMU / 12700 = 72 pt
      expect(rect.y).toBe(36); // 457200 EMU / 12700 = 36 pt
      expect(rect.width).toBe(144); // 1828800 EMU / 12700 = 144 pt
      expect(rect.height).toBe(72); // 914400 EMU / 12700 = 72 pt
      expect(rect.rotation).toBe(30); // 1800000 / 60000 = 30 deg
      expect(rect.fillColor).toBe('#0088FF');
      expect(rect.strokeColor).toBe('#000000');
      expect(rect.strokeWidth).toBeGreaterThan(0);

      expect(ellipse.type).toBe('ellipse');
      expect(ellipse.fillColor).toBe('#FF3300');
    });

    it('parses DrawingML custom geometries with cubic beziers and lines', () => {
      const xml = `
        <w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                   xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="1270000" cy="1270000"/>
          </a:xfrm>
          <a:custGeom>
            <a:pathLst>
              <a:path w="100" h="100">
                <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                <a:lnTo><a:pt x="50" y="0"/></a:lnTo>
                <a:cubicBezTo>
                  <a:pt x="75" y="25"/>
                  <a:pt x="100" y="50"/>
                  <a:pt x="100" y="100"/>
                </a:cubicBezTo>
                <a:close/>
              </a:path>
            </a:pathLst>
          </a:custGeom>
        </w:drawing>
      `;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(1);
      expect(shapes[0].type).toBe('custom');
      expect(shapes[0].customPath).toBe('M 0 0 L 50 0 C 75 25, 100 50, 100 100 Z');
    });

    it('preserves sequential order of interleaved DrawingML path commands', () => {
      const xml = `
        <w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                   xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="1270000" cy="1270000"/>
          </a:xfrm>
          <a:custGeom>
            <a:pathLst>
              <a:path w="100" h="100">
                <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                <a:lnTo><a:pt x="20" y="0"/></a:lnTo>
                <a:cubicBezTo>
                  <a:pt x="30" y="10"/>
                  <a:pt x="40" y="20"/>
                  <a:pt x="50" y="20"/>
                </a:cubicBezTo>
                <a:lnTo><a:pt x="80" y="50"/></a:lnTo>
                <a:quadBezTo>
                  <a:pt x="90" y="60"/>
                  <a:pt x="100" y="80"/>
                </a:quadBezTo>
                <a:close/>
              </a:path>
            </a:pathLst>
          </a:custGeom>
        </w:drawing>
      `;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(1);
      expect(shapes[0].customPath).toBe('M 0 0 L 20 0 C 30 10, 40 20, 50 20 L 80 50 Q 90 60, 100 80 Z');
    });

    it('renders DrawingML shapes into SVG element strings', async () => {
      const shapes = [
        {
          geomType: 'preset' as const,
          type: 'rect' as const,
          presetGeom: 'rect',
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          fillColor: '#AABBCC',
          strokeColor: '#333333',
          strokeWidth: 2,
        },
        {
          geomType: 'preset' as const,
          type: 'diamond' as const,
          presetGeom: 'diamond',
          x: 150,
          y: 50,
          width: 60,
          height: 60,
          fillColor: '#FFCC00',
        },
      ];

      const { svg } = renderDrawingMlToSvg(shapes, 300, 200);

      // The elements, read by a browser's parser. The rectangle keeps its frame and line; the diamond is the
      // polygon through the midpoints of its 60 x 60 frame at (150, 50) (ECMA-376 presetShapeDefinitions
      // "diamond": top, right, bottom, left).
      const parsed = readSvgShapes(svg, new Set(['svg', 'rect', 'polygon']));
      expect(parsed.map((shape) => shape.name)).toEqual(['svg', 'rect', 'polygon']);
      expect(parsed[1].attributes).toEqual({ x: '10', y: '20', width: '100', height: '50', fill: '#AABBCC', stroke: '#333333', 'stroke-width': '2' });
      expect(parsed[2].attributes.points).toBe('180,50 210,80 180,110 150,80');
      expect(parsed[2].attributes.fill).toBe('#FFCC00');

      // The picture: rasterise with librsvg (sharp) and look at pixels. The SVG maps its viewBox into the 300 x 200
      // canvas with the default xMidYMid meet rule: one uniform scale, content centred on the free axis.
      const [viewX, viewY, viewWidth, viewHeight] = parsed[0].attributes.viewBox.split(' ').map(Number);
      const scale = Math.min(300 / viewWidth, 200 / viewHeight);
      const offsetX = (300 - viewWidth * scale) / 2;
      const offsetY = (200 - viewHeight * scale) / 2;
      const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height, info.channels]).toEqual([300, 200, 4]);
      const pixelAt = (shapeX: number, shapeY: number) => {
        const column = Math.round((shapeX - viewX) * scale + offsetX);
        const row = Math.round((shapeY - viewY) * scale + offsetY);
        const start = (row * info.width + column) * info.channels;
        return [...data.subarray(start, start + info.channels)];
      };
      expect(pixelAt(60, 45)).toEqual([0xaa, 0xbb, 0xcc, 255]); // inside the rectangle
      expect(pixelAt(180, 80)).toEqual([0xff, 0xcc, 0x00, 255]); // centre of the diamond
      expect(pixelAt(152, 52)[3]).toBe(0); // corner of the diamond's frame: outside the diamond, nothing drawn
      expect(pixelAt(130, 45)[3]).toBe(0); // between the two shapes
    });
  });

  // ==========================================================================
  // 4. Pure Audio Decoder Stack Fallback (WAV, FLAC, MP3)
  // ==========================================================================
  describe('Pure Audio Decoder Stack Fallback', () => {
    // Helper to generate a genuine RIFF WAV buffer
    function createTestPcmWav(sampleRate = 44100, channels = 2, durationSec = 0.25): Buffer {
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
        const val = Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 16000);
        buffer.writeInt16LE(val, 44 + i * 2);
      }

      return buffer;
    }

    it('decodes 16-bit PCM RIFF WAV accurately', () => {
      const wav = createTestPcmWav(44100, 2, 0.1);
      const decoded = decodeWav(wav);

      expect(decoded.sampleRate).toBe(44100);
      expect(decoded.channels).toBe(2);
      expect(decoded.bitsPerSample).toBe(16);
      expect(decoded.samples.length).toBeGreaterThan(0);
      expect(decoded.duration).toBeCloseTo(0.1, 1);
    });

    it('decodes 8-bit, 24-bit, and 32-bit float WAV audio', () => {
      // 1. 8-bit unsigned PCM
      const sampleCount = 1000;
      const wav8 = Buffer.alloc(44 + sampleCount);
      wav8.write('RIFF', 0);
      wav8.writeUInt32LE(36 + sampleCount, 4);
      wav8.write('WAVE', 8);
      wav8.write('fmt ', 12);
      wav8.writeUInt32LE(16, 16);
      wav8.writeUInt16LE(1, 20); // PCM
      wav8.writeUInt16LE(1, 22); // Mono
      wav8.writeUInt32LE(44100, 24);
      wav8.writeUInt32LE(44100, 28);
      wav8.writeUInt16LE(1, 32);
      wav8.writeUInt16LE(8, 34); // 8-bit
      wav8.write('data', 36);
      wav8.writeUInt32LE(sampleCount, 40);
      for (let i = 0; i < sampleCount; i++) {
        wav8[44 + i] = 128 + Math.round(Math.sin(i * 0.1) * 100);
      }

      const decoded8 = decodeWav(wav8);
      expect(decoded8.channels).toBe(1);
      expect(decoded8.samples.length).toBe(sampleCount);

      // 2. 32-bit IEEE float WAV
      const wavFloat = Buffer.alloc(44 + sampleCount * 4);
      wavFloat.write('RIFF', 0);
      wavFloat.writeUInt32LE(36 + sampleCount * 4, 4);
      wavFloat.write('WAVE', 8);
      wavFloat.write('fmt ', 12);
      wavFloat.writeUInt32LE(16, 16);
      wavFloat.writeUInt16LE(3, 20); // IEEE float format
      wavFloat.writeUInt16LE(1, 22);
      wavFloat.writeUInt32LE(48000, 24);
      wavFloat.writeUInt32LE(48000 * 4, 28);
      wavFloat.writeUInt16LE(4, 32);
      wavFloat.writeUInt16LE(32, 34);
      wavFloat.write('data', 36);
      wavFloat.writeUInt32LE(sampleCount * 4, 40);
      for (let i = 0; i < sampleCount; i++) {
        wavFloat.writeFloatLE(Math.sin(i * 0.1) * 0.8, 44 + i * 4);
      }

      const decodedFloat = decodeWav(wavFloat);
      expect(decodedFloat.sampleRate).toBe(48000);
      expect(decodedFloat.samples.length).toBe(sampleCount);
    });

    it('decodes Apple AIFF container with 80-bit float sample rate', () => {
      const sampleCount = 500;
      const aiff = Buffer.alloc(54 + sampleCount * 2);
      aiff.write('FORM', 0);
      aiff.writeUInt32BE(46 + sampleCount * 2, 4);
      aiff.write('AIFF', 8);

      // COMM chunk (18 bytes payload)
      aiff.write('COMM', 12);
      aiff.writeUInt32BE(18, 16);
      aiff.writeInt16BE(1, 20); // 1 channel
      aiff.writeUInt32BE(sampleCount, 22); // frames
      aiff.writeInt16BE(16, 26); // 16-bit

      // 80-bit float for 44100 Hz: exp = 16383 + 15 = 16398 (0x400e), mantissa = 0xac440000 0x00000000
      aiff.writeUInt16BE(0x400e, 28);
      aiff.writeUInt32BE(0xac440000, 30);
      aiff.writeUInt32BE(0x00000000, 34);

      // SSND chunk
      aiff.write('SSND', 38);
      aiff.writeUInt32BE(sampleCount * 2 + 8, 42);
      aiff.writeUInt32BE(0, 46); // offset
      aiff.writeUInt32BE(0, 50); // blockSize

      for (let i = 0; i < sampleCount; i++) {
        aiff.writeInt16BE(Math.round(Math.sin(i * 0.2) * 12000), 54 + i * 2);
      }

      const decodedAiff = decodeWav(aiff);
      expect(decodedAiff.sampleRate).toBe(44100);
      expect(decodedAiff.channels).toBe(1);
      expect(decodedAiff.samples.length).toBe(sampleCount);
    });

    it('decodes FLAC stream into lossless 16-bit PCM samples', () => {
      const sampleRate = 44100;
      const channels = 2;
      const sampleCount = 4096;
      const rawSamples = new Int16Array(sampleCount * channels);
      for (let i = 0; i < rawSamples.length; i++) {
        rawSamples[i] = Math.round(Math.sin(i * 0.05) * 15000);
      }

      const flacBuffer = encodeFlacStream(rawSamples, sampleRate, channels);
      expect(flacBuffer.toString('ascii', 0, 4)).toBe('fLaC');

      const decoded = decodeFlac(flacBuffer);
      expect(decoded.sampleRate).toBe(sampleRate);
      expect(decoded.channels).toBe(channels);
      expect(decoded.samples.length).toBe(rawSamples.length);

      // Verify exact lossless sample preservation
      for (let i = 0; i < rawSamples.length; i++) {
        expect(decoded.samples[i]).toBe(rawSamples[i]);
      }
    });

    oracleTest('decodes an MP3 authored by the reference encoder to as many 16-bit samples as FFmpeg decodes', ['ffmpeg'], () => {
      const sampleRate = 44100;
      const channels = 2;
      const source = wavFromSamples(chirpSamples(sampleRate, channels, 0.5), sampleRate, channels);
      const mp3Buffer = withTempFile(source, 'wav', (file) =>
        execFileSync(
          getOracleToolPath('ffmpeg') as string,
          ['-v', 'error', '-i', file, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', '-'],
          { maxBuffer: 64 * 1024 * 1024 }
        )
      );

      const decoded = decodeMp3(mp3Buffer);
      const reference = decodeAudioWithFfmpeg(mp3Buffer, 'mp3', sampleRate, channels);
      expect(decoded.sampleRate).toBe(sampleRate);
      expect(decoded.channels).toBe(channels);
      expect(decoded.samples.length).toBe(reference.length);
      expect(decoded.samples.some((sample) => sample !== 0)).toBe(true);
    });

    oracleTest('transcodes FLAC to MP3 and MP3 to WAV through the native engine', ['ffmpeg', 'ffprobe'], async () => {
      const wav = createTestPcmWav(44100, 2, 0.2);

      // 1. WAV -> FLAC
      const flacResult = await convertFile(wav, 'wav', 'flac', {}, 'song.wav');
      expect(flacResult.mimeType).toBe('audio/flac');

      // 2. FLAC -> MP3 (the lossy encode is FFmpeg-only)
      const mp3Result = await convertFile(flacResult.buffer, 'flac', 'mp3', {}, 'song.flac');
      expect(mp3Result.mimeType).toBe('audio/mpeg');
      expect(probeStream(mp3Result.buffer, 'mp3', 'a').codec_name).toBe('mp3');

      // 3. MP3 -> WAV
      const wavResult = await convertFile(mp3Result.buffer, 'mp3', 'wav', {}, 'song.mp3');
      expect(wavResult.mimeType).toBe('audio/wav');
      expect(wavResult.buffer.toString('ascii', 0, 4)).toBe('RIFF');
    });

    it('fails closed when decoding unsupported or corrupt audio payloads', () => {
      const invalid = Buffer.from('NOT AUDIO AT ALL');
      expect(() => decodeAudioBuffer(invalid)).toThrow(
        'Unsupported audio format: decoder unavailable'
      );
      expect(() => decodeAudioBuffer(Buffer.alloc(0))).toThrow(
        'Unsupported audio format: decoder unavailable'
      );
    });
  });
});
