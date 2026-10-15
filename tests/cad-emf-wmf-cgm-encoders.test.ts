import { describe, it, expect } from 'vitest';
import {
  encodeEmf,
  encodeWmf,
  encodeCgm,
  parseSvgGeometries,
  parseCssColor,
  convertVectorCad,
  parseCgmToSvg,
} from '../src/lib/conversions/vector-cad';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { oracleTest } from './helpers/oracle-test';
import { emfOracleRecords, wmfOracleRecords, cgmOracleDocument, cgmOracleColour, cgmOraclePoints } from './helpers/metafile-oracle';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { CadGeometryUnavailableError, ConversionFailedError } from '../src/lib/types';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { compareImages } from './helpers/vrt-engine';
import { renderPdfPagesWithPdftoppm } from './oracles/product/pdf-oracle';

// ============================================================================
// Test Suite
// ============================================================================

describe('WP-46c: Genuine EMF, WMF, and CGM Vector Encoders', () => {
  const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
    <!-- Rectangle with blue fill and red stroke -->
    <rect x="20" y="20" width="120" height="80" fill="#0000ff" stroke="#ff0000" stroke-width="3" />
    
    <!-- Circle with green fill -->
    <circle cx="250" cy="80" r="40" fill="#00ff00" stroke="#111827" stroke-width="2" />
    
    <!-- Polyline -->
    <polyline points="20,150 70,220 120,160 170,240" fill="none" stroke="#ff8800" stroke-width="4" />
    
    <!-- Polygon -->
    <polygon points="220,180 280,180 300,240 240,260" fill="#800080" stroke="#000000" stroke-width="2" />
    
    <!-- Line -->
    <line x1="10" y1="280" x2="390" y2="280" stroke="#333333" stroke-width="2" />
    
    <!-- Complex Bézier Path with Cubic, Quadratic, and Arc -->
    <path d="M 50,50 C 75,10 125,10 150,50 S 225,90 250,50 Q 280,20 300,50 A 20 20 0 0 1 340 50 Z"
          fill="#ffff00" stroke="#0000ff" stroke-width="2" />
  </svg>`;

  const svgBuffer = Buffer.from(sampleSvg, 'utf-8');

  describe('Color and Geometry Parsing', () => {
    it('parses various CSS color formats accurately', () => {
      expect(parseCssColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
      expect(parseCssColor('#00f')).toEqual({ r: 0, g: 0, b: 255 });
      expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
      expect(parseCssColor('blue')).toEqual({ r: 0, g: 0, b: 255 });
      expect(parseCssColor('none')).toBeNull();
      expect(parseCssColor('transparent')).toBeNull();
      expect(parseCssColor(null)).toBeNull();
    });

    it('extracts all SVG geometry primitives and flattens Bézier curves', () => {
      const doc = parseSvgGeometries(sampleSvg);
      expect(doc.width).toBe(400);
      expect(doc.height).toBe(300);
      expect(doc.elements.length).toBeGreaterThanOrEqual(6);

      // Verify rect, circle, polyline, polygon, line, path are present
      const closedElements = doc.elements.filter((e) => e.isClosed);
      const openElements = doc.elements.filter((e) => !e.isClosed);
      expect(closedElements.length).toBeGreaterThanOrEqual(4);
      expect(openElements.length).toBeGreaterThanOrEqual(2);

      // Verify Bézier curve path flattening generates high-resolution sampled vertices
      const pathEl = doc.elements.find((e) => e.stroke?.b === 255 && e.fill?.r === 255);
      expect(pathEl).toBeDefined();
      expect(pathEl!.subpaths[0].length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('EMF Encoder (MS-EMF)', () => {
    it('generates a strictly compliant Win32 EMF binary file with accurate records', () => {
      const emfBuf = encodeEmf(svgBuffer);
      expect(emfBuf).toBeInstanceOf(Buffer);
      expect(emfBuf.length).toBeGreaterThan(88);

      const parsed = emfOracleRecords(emfBuf);

      // MS-EMF 2.2.9: dSignature MUST be ENHMETA_SIGNATURE, the ASCII bytes " EMF"
      expect(emfBuf.subarray(40, 44).toString('latin1')).toBe(' EMF');
      expect(parsed.header.signature).toBe(0x464d4520);
      expect(parsed.header.version).toBe(0x00010000); // 1.0
      expect(parsed.header.reserved).toBe(0);
      // nHandles = highest object table index used + 1 (index 0 is reserved)
      expect(parsed.header.handles).toBe(parsed.maxObjectIndex + 1);
      // EMR_EOF: no palette, nSizeLast repeats the record size
      expect(parsed.eof?.nPalEntries).toBe(0);
      // MS-EMF 2.3.4.1: with no palette, offPalEntries is the conventional 16 (end of the fixed fields)
      expect(parsed.eof?.offPalEntries).toBe(16);
      expect(parsed.eof?.nSizeLast).toBe(parsed.eof?.size);

      // Dimensions & Device bounds
      expect(parsed.header.bounds.right).toBe(400);
      expect(parsed.header.bounds.bottom).toBe(300);
      expect(parsed.header.device.cx).toBe(400);
      expect(parsed.header.device.cy).toBe(300);
      expect(parsed.header.millimeters.cx).toBe(Math.round((400 * 25.4) / 96));
      expect(parsed.header.millimeters.cy).toBe(Math.round((300 * 25.4) / 96));

      // File size and Record count integrity
      expect(parsed.header.bytes).toBe(emfBuf.length);
      expect(parsed.header.records).toBe(parsed.records.length);

      // Core GDI state records
      expect(parsed.hasSetMapMode).toBe(true);
      expect(parsed.hasSetBkMode).toBe(true);
      expect(parsed.hasSetPolyFillMode).toBe(true);

      // Object creation and Drawing records
      expect(parsed.hasCreatePen).toBe(true);
      expect(parsed.hasCreateBrush).toBe(true);
      expect(parsed.hasPolygon16).toBe(true);
      expect(parsed.hasPolyline16).toBe(true);
      expect(parsed.hasEof).toBe(true);

      // Verify colors: red pen (0x000000FF in BGR) and blue brush (0x00FF0000 in BGR)
      expect(parsed.penColors.some((c) => (c & 0xff) === 255)).toBe(true); // Red pen
      expect(parsed.brushColors.some((c) => ((c >> 16) & 0xff) === 255)).toBe(true); // Blue brush
    });

    it('rejects empty input buffer fail-closed', () => {
      expect(() => encodeEmf(Buffer.alloc(0))).toThrow(/empty/i);
    });
  });

  describe('WMF Encoder (MS-WMF)', () => {
    it('generates a strictly compliant Windows Metafile with Aldus Placeable Header', () => {
      const wmfBuf = encodeWmf(svgBuffer);
      expect(wmfBuf).toBeInstanceOf(Buffer);
      expect(wmfBuf.length).toBeGreaterThan(40);

      const parsed = wmfOracleRecords(wmfBuf);

      // Aldus Header Integrity
      expect(parsed.header.aldusKey).toBe(0x9ac6cdd7);
      expect(parsed.header.aldusRight).toBe(400);
      expect(parsed.header.aldusBottom).toBe(300);
      expect(parsed.header.aldusInch).toBe(96);
      expect(parsed.header.aldusChecksum).toBe(parsed.header.computedChecksum);

      // Standard WMF Header Integrity
      expect(parsed.header.fileType).toBe(1); // MEMORYMETAFILE
      expect(parsed.header.headerSize).toBe(9); // 9 words = 18 bytes
      expect(parsed.header.version).toBe(0x0300);
      expect(parsed.header.fileSizeInWords).toBe((wmfBuf.length - 22) / 2);
      expect(parsed.header.fileSizeInWords).toBe(parsed.observedTotalWords);
      expect(parsed.header.maxRecordInWords).toBe(parsed.observedMaxRecordWords);
      expect(parsed.header.numOfObjects).toBe(parsed.maxObjectSlotsInUse);

      // Records
      expect(parsed.hasSetWindowOrg).toBe(true);
      expect(parsed.hasSetWindowExt).toBe(true);
      expect(parsed.hasCreatePen).toBe(true);
      expect(parsed.hasCreateBrush).toBe(true);
      expect(parsed.hasPolygon).toBe(true);
      expect(parsed.hasPolyline).toBe(true);
      expect(parsed.hasEof).toBe(true);
      expect(parsed.recordCount).toBeGreaterThan(10);
    });

    it('rejects empty input buffer fail-closed', () => {
      expect(() => encodeWmf(Buffer.alloc(0))).toThrow(/empty/i);
    });

    it('rejects a sub-path whose point count exceeds the signed 16-bit WMF limit with a typed error', () => {
      const WMF_MAX_POINTS = 32767;
      const pts = Array.from({ length: WMF_MAX_POINTS + 1 }, (_, k) => `${k % 100},${Math.floor(k / 100)}`).join(' ');
      const bigSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="400"><polyline points="${pts}" stroke="#000" fill="none"/></svg>`, 'utf-8');
      expect(() => encodeWmf(bigSvg)).toThrow(CadGeometryUnavailableError);
    });

    it('reports mtMaxRecord as the largest record actually written', () => {
      const lineSvg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><line x1="0" y1="0" x2="40" y2="40" stroke="#000"/></svg>',
        'utf-8'
      );
      const parsed = wmfOracleRecords(encodeWmf(lineSvg));
      // Largest record here is CREATEPENINDIRECT / two-point POLYLINE: 8 WORDs
      expect(parsed.observedMaxRecordWords).toBe(8);
      expect(parsed.header.maxRecordInWords).toBe(8);
      expect(parsed.header.fileSizeInWords).toBe(parsed.observedTotalWords);
    });
  });

  describe('CGM Encoder (ISO 8632 Clear-Text)', () => {
    it('generates ISO 8632-4 clear-text CGM with valid element names, structure and syntax', () => {
      const cgmBuf = encodeCgm(svgBuffer, 'My "Engineering" Model');
      const doc = cgmOracleDocument(cgmBuf.toString('utf-8'));

      // Quoted strings round-trip through the clear-text doubled-delimiter rule
      expect(doc.mfName).toBe('My "Engineering" Model');
      expect(doc.elements.find((e) => e.name === 'MFVERSION')?.params).toBe('1');
      expect(doc.elements.some((e) => e.name === 'MFELEMLIST')).toBe(true);
      expect(doc.elements.find((e) => e.name === 'COLRMODE')?.params).toBe('DIRECT');

      // VDC y axis points up; the extent's first corner is the SVG bottom-left so
      // the picture is not mirrored vertically.
      expect(doc.vdcExtent).toEqual([{ x: 0, y: 300 }, { x: 400, y: 0 }]);

      // Fill colour only shows with a solid interior style, set before the first POLYGON
      const firstPolygon = doc.body.findIndex((e) => e.name === 'POLYGON');
      const solidIdx = doc.body.findIndex((e) => e.name === 'INTSTYLE' && e.params === 'SOLID');
      expect(firstPolygon).toBeGreaterThan(-1);
      expect(solidIdx).toBeGreaterThan(-1);
      expect(solidIdx).toBeLessThan(firstPolygon);

      // Direct colours: three integers without parentheses
      const lineColours = doc.body.filter((e) => e.name === 'LINECOLR').map((e) => cgmOracleColour(e.params));
      const fillColours = doc.body.filter((e) => e.name === 'FILLCOLR').map((e) => cgmOracleColour(e.params));
      expect(lineColours).toContainEqual([255, 0, 0]); // rect stroke
      expect(fillColours).toContainEqual([0, 0, 255]); // rect fill
      expect(fillColours).toContainEqual([128, 0, 128]); // polygon fill

      // Geometry: rect corners in VDC match the SVG coordinates
      const polygons = doc.body.filter((e) => e.name === 'POLYGON').map((e) => cgmOraclePoints(e.params));
      const polylines = doc.body.filter((e) => e.name === 'POLYLINE').map((e) => cgmOraclePoints(e.params));
      for (const pg of polygons) expect(pg.length).toBeGreaterThanOrEqual(3);
      for (const pl of polylines) expect(pl.length).toBeGreaterThanOrEqual(2);
      // Filled rings are closed implicitly, so the closing vertex is not repeated
      expect(polygons).toContainEqual([{ x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 100 }, { x: 20, y: 100 }]);
      expect(polylines).toContainEqual([{ x: 20, y: 150 }, { x: 70, y: 220 }, { x: 120, y: 160 }, { x: 170, y: 240 }]);
    });

    it('encodes every SVG shape as CGM geometry in SVG coordinates (independent parser)', () => {
      const doc = cgmOracleDocument(encodeCgm(svgBuffer, 'shapes').toString('utf-8'));
      const distinct = (pts: { x: number; y: number }[]) => {
        const last = pts[pts.length - 1];
        return pts.length > 1 && last.x === pts[0].x && last.y === pts[0].y ? pts.slice(0, -1) : pts;
      };
      const polygons = doc.body.filter((e) => e.name === 'POLYGON').map((e) => distinct(cgmOraclePoints(e.params)));
      const polylines = doc.body.filter((e) => e.name === 'POLYLINE').map((e) => cgmOraclePoints(e.params));

      // Picture extent covers the SVG viewport with a flipped y axis
      expect(doc.vdcExtent).toEqual([{ x: 0, y: 300 }, { x: 400, y: 0 }]);
      // rect, circle, polygon and path are filled areas
      expect(polygons).toHaveLength(4);
      expect(polygons).toContainEqual([{ x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 100 }, { x: 20, y: 100 }]);
      expect(polygons).toContainEqual([{ x: 220, y: 180 }, { x: 280, y: 180 }, { x: 300, y: 240 }, { x: 240, y: 260 }]);
      const circle = polygons.find((p) => p.length > 20 && p.every((pt) => Math.hypot(pt.x - 250, pt.y - 80) <= 41));
      expect(circle, 'circle approximated around (250,80) r=40').toBeDefined();
      // polyline and line are open strokes
      expect(polylines).toContainEqual([{ x: 20, y: 150 }, { x: 70, y: 220 }, { x: 120, y: 160 }, { x: 170, y: 240 }]);
      expect(polylines).toContainEqual([{ x: 10, y: 280 }, { x: 390, y: 280 }]);
    });

    it('decodes CGM POLYLINE elements without also emitting LINE primitives', () => {
      const svgOut = parseCgmToSvg(
        'BEGMF "p";\nMFVERSION 1;\nBEGPIC "p";\nVDCEXT (0,100) (100,0);\nBEGPICBODY;\nPOLYLINE (0,0) (10,10) (20,0);\nENDPIC;\nENDMF;\n'
      );
      const polylines = [...(svgOut ?? '').matchAll(/<polyline points="([^"]*)"/g)].map((m) => m[1]);
      expect(polylines).toEqual(['0,0 10,10 20,0']);
      expect((svgOut ?? '').match(/<line\b/g)).toBeNull();
      expect(/viewBox="([^"]*)"/.exec(svgOut ?? '')?.[1]).toBe('0 0 100 100');
    });

    it('rejects empty input buffer fail-closed', () => {
      expect(() => encodeCgm(Buffer.alloc(0))).toThrow(/empty/i);
    });
  });

  describe('Fail-closed input validation', () => {
    const encoders = [
      ['emf', (b: Buffer) => encodeEmf(b)],
      ['wmf', (b: Buffer) => encodeWmf(b)],
      ['cgm', (b: Buffer) => encodeCgm(b)],
    ] as const;
    const invalidInputs: [string, Buffer][] = [
      ['empty buffer', Buffer.alloc(0)],
      ['non-SVG text', Buffer.from('hello world, not a drawing', 'utf-8')],
      ['SVG without drawable geometry', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', 'utf-8')],
      ['SVG with only degenerate shapes', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="0" height="5"/><circle r="0"/></svg>', 'utf-8')],
    ];

    for (const [target, encode] of encoders) {
      for (const [label, input] of invalidInputs) {
        it(`throws CadGeometryUnavailableError for ${label} -> ${target}`, () => {
          expect(() => encode(input)).toThrow(CadGeometryUnavailableError);
        });
      }

      it(`rejects geometry-less SVG through convertVectorCad -> ${target} with a typed error`, async () => {
        const input = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8');
        const err = await convertVectorCad(input, 'svg', target, {}, 'blank.svg').then(
          () => null,
          (e: unknown) => e
        );
        expect(err).toBeInstanceOf(ConversionFailedError);
        expect((err as Error).name).toBe('CadGeometryUnavailableError');
        expect((err as Error).message).toMatch(new RegExp(`^${target.toUpperCase()} encoding failed: SVG contains no drawable vector geometry`));
      });
    }
  });

  describe('Integration & Registry Routing', () => {
    it('exposes emf, wmf, and cgm as available targets for SVG in FORMAT_REGISTRY', () => {
      const availableTargets = getAvailableTargetFormats('svg');
      const targetIds = availableTargets.map((t) => t.id);

      expect(targetIds.length).toBeGreaterThanOrEqual(3);
      expect(targetIds).toContain('emf');
      expect(targetIds).toContain('wmf');
      expect(targetIds).toContain('cgm');
    });

    it('routes svg to emf conversion with authentic mimeType and filename', async () => {
      const res = await convertVectorCad(svgBuffer, 'svg', 'emf', {}, 'diagram.svg');
      expect(res.mimeType).toBe('image/emf');
      expect(res.filename).toBe('diagram.emf');
      expect(res.size).toBeGreaterThan(88);

      const parsed = emfOracleRecords(res.buffer);
      expect(parsed.hasEof).toBe(true);
    });

    it('routes svg to wmf conversion with authentic mimeType and filename', async () => {
      const res = await convertVectorCad(svgBuffer, 'svg', 'wmf', {}, 'diagram.svg');
      expect(res.mimeType).toBe('image/wmf');
      expect(res.filename).toBe('diagram.wmf');
      expect(res.size).toBeGreaterThan(40);

      const parsed = wmfOracleRecords(res.buffer);
      expect(parsed.hasEof).toBe(true);
    });

    it('routes svg to cgm conversion with authentic mimeType and filename', async () => {
      const res = await convertVectorCad(svgBuffer, 'svg', 'cgm', {}, 'diagram.svg');
      expect(res.mimeType).toBe('image/cgm');
      expect(res.filename).toBe('diagram.cgm');
      expect(cgmOracleDocument(res.buffer.toString('utf-8')).mfName).toBe('diagram');
    });
  });

  describe('Differential Visual Oracle (LibreOffice soffice)', () => {
    const SOFFICE_TIMEOUT_MS = 60000;
    /** Plan value. Measured against LibreOffice 24.x + pdftoppm on the sample drawing: EMF 0.992, WMF 0.994. */
    const MIN_SSIM = 0.9;
    const COMPARE_WIDTH = 400;
    const COMPARE_HEIGHT = 300;

    /** EMF/WMF import lives in the Draw module; a Writer/Calc-only install cannot load them. */
    function requireSofficeDrawModule(): void {
      const sofficePath = getOracleToolPath('soffice');
      if (!sofficePath) throw new OracleToolMissingError('soffice');
      const programDir = path.dirname(fs.realpathSync(sofficePath));
      const hasDraw = fs.readdirSync(programDir).some((f) => /^(lib)?sdlo\.(so|dll|dylib)$/.test(f));
      if (!hasDraw) {
        throw new OracleToolMissingError('soffice-draw', 'LibreOffice Draw module (libreoffice-draw) is not installed');
      }
    }

    async function renderMetafileWithSoffice(metafile: Buffer, fileName: string): Promise<Buffer> {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-oracle-'));
      try {
        const inputPath = path.join(tempDir, fileName);
        fs.writeFileSync(inputPath, metafile);
        execFileSync(
          'soffice',
          [
            '--headless',
            '--norestore',
            '--nofirststartwizard',
            '--nologo',
            `-env:UserInstallation=file://${tempDir}/user`,
            '--convert-to',
            'pdf',
            inputPath,
            '--outdir',
            tempDir,
          ],
          {
            timeout: SOFFICE_TIMEOUT_MS,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, HOME: tempDir, SAL_USE_VCLPLUGIN: 'svp' },
          }
        );
        const pdfPath = path.join(tempDir, `${path.parse(fileName).name}.pdf`);
        expect(fs.existsSync(pdfPath), `soffice could not load ${fileName}`).toBe(true);
        const pages = await renderPdfPagesWithPdftoppm(fs.readFileSync(pdfPath));
        expect(pages.length).toBeGreaterThanOrEqual(1);
        return pages[0];
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    /** Crops to the drawn content on a white page and scales to a common comparison size. */
    async function normalizeDrawing(png: Buffer): Promise<Buffer> {
      const flat = await sharp(png).flatten({ background: '#ffffff' }).png().toBuffer();
      return sharp(flat)
        .trim({ background: '#ffffff', threshold: 10 })
        .resize(COMPARE_WIDTH, COMPARE_HEIGHT, { fit: 'fill' })
        .png()
        .toBuffer();
    }

    for (const target of ['emf', 'wmf'] as const) {
      oracleTest(
        `keeps the hole of an even-odd ring path open when LibreOffice renders ${target.toUpperCase()}`,
        ['soffice', 'pdftoppm'],
        async () => {
          requireSofficeDrawModule();
          const donut = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
              '<path fill-rule="evenodd" fill="#0000ff" d="M0 0 H200 V200 H0 Z M50 50 H150 V150 H50 Z"/></svg>',
            'utf-8'
          );
          const metafile = target === 'emf' ? encodeEmf(donut) : encodeWmf(donut);
          const page = await renderMetafileWithSoffice(metafile, `donut.${target}`);
          const drawing = await normalizeDrawing(page);
          const { data, info } = await sharp(drawing).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          const pixel = (fx: number, fy: number) => {
            const idx = (Math.round(fy * (info.height - 1)) * info.width + Math.round(fx * (info.width - 1))) * 3;
            return [data[idx], data[idx + 1], data[idx + 2]];
          };
          const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;
          const isWhite = ([r, g, b]: number[]) => r > 230 && g > 230 && b > 230;
          expect(isBlue(pixel(0.125, 0.5)), 'ring is filled').toBe(true);
          expect(isWhite(pixel(0.5, 0.5)), 'hole stays open').toBe(true);
        },
        SOFFICE_TIMEOUT_MS + 15000
      );

      oracleTest(
        `renders ${target.toUpperCase()} via LibreOffice and matches the SVG reference raster`,
        ['soffice', 'pdftoppm'],
        async () => {
          requireSofficeDrawModule();
          const metafile = target === 'emf' ? encodeEmf(svgBuffer) : encodeWmf(svgBuffer);
          const rendered = await renderMetafileWithSoffice(metafile, `sample.${target}`);
          const reference = await sharp(svgBuffer, { density: 192 }).png().toBuffer();

          const vrtResult = await compareImages(await normalizeDrawing(rendered), await normalizeDrawing(reference));
          expect(vrtResult.ssim).toBeGreaterThanOrEqual(MIN_SSIM);
        },
        SOFFICE_TIMEOUT_MS + 15000
      );
    }
  });
});
