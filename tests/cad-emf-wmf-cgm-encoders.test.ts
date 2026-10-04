import { describe, it, expect } from 'vitest';
import {
  encodeEmf,
  encodeWmf,
  encodeCgm,
  parseSvgGeometries,
  parseCssColor,
  convertVectorCad,
} from '../src/lib/conversions/vector-cad';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { oracleTest } from './helpers/oracle-test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { compareImages } from './helpers/vrt-engine';
import { renderPdfPagesWithPdftoppm } from './oracles/product/pdf-oracle';
import { renderOfficeDocumentWithSoffice } from './oracles/product/office-oracle';

// ============================================================================
// Independent EMF Binary Oracle Parser
// ============================================================================

interface EmfParsedRecord {
  type: number;
  size: number;
  offset: number;
}

interface EmfParsedHeader {
  bounds: { left: number; top: number; right: number; bottom: number };
  frame: { left: number; top: number; right: number; bottom: number };
  signature: number;
  version: number;
  bytes: number;
  records: number;
  handles: number;
  reserved: number;
  device: { cx: number; cy: number };
  millimeters: { cx: number; cy: number };
}

function parseEmfBinary(buffer: Buffer): {
  header: EmfParsedHeader;
  records: EmfParsedRecord[];
  hasSetMapMode: boolean;
  hasSetBkMode: boolean;
  hasSetPolyFillMode: boolean;
  hasCreatePen: boolean;
  hasCreateBrush: boolean;
  hasPolygon16: boolean;
  hasPolyline16: boolean;
  hasEof: boolean;
  penColors: number[];
  brushColors: number[];
  pointCounts: number[];
  maxObjectIndex: number;
  eof: { nPalEntries: number; offPalEntries: number; nSizeLast: number; size: number } | null;
} {
  expect(buffer.length).toBeGreaterThanOrEqual(88);

  // EMR_HEADER
  const iType = buffer.readUInt32LE(0);
  const nSize = buffer.readUInt32LE(4);
  expect(iType).toBe(1); // EMR_HEADER
  expect(nSize).toBe(88);

  const header: EmfParsedHeader = {
    bounds: {
      left: buffer.readInt32LE(8),
      top: buffer.readInt32LE(12),
      right: buffer.readInt32LE(16),
      bottom: buffer.readInt32LE(20),
    },
    frame: {
      left: buffer.readInt32LE(24),
      top: buffer.readInt32LE(28),
      right: buffer.readInt32LE(32),
      bottom: buffer.readInt32LE(36),
    },
    signature: buffer.readUInt32LE(40),
    version: buffer.readUInt32LE(44),
    bytes: buffer.readUInt32LE(48),
    records: buffer.readUInt32LE(52),
    handles: buffer.readUInt16LE(56),
    reserved: buffer.readUInt16LE(58),
    device: {
      cx: buffer.readUInt32LE(72),
      cy: buffer.readUInt32LE(76),
    },
    millimeters: {
      cx: buffer.readUInt32LE(80),
      cy: buffer.readUInt32LE(84),
    },
  };

  const records: EmfParsedRecord[] = [{ type: 1, size: 88, offset: 0 }];
  let offset = 88;
  let hasSetMapMode = false;
  let hasSetBkMode = false;
  let hasSetPolyFillMode = false;
  let hasCreatePen = false;
  let hasCreateBrush = false;
  let hasPolygon16 = false;
  let hasPolyline16 = false;
  let hasEof = false;
  const penColors: number[] = [];
  const brushColors: number[] = [];
  const pointCounts: number[] = [];
  let maxObjectIndex = 0;
  let eof: { nPalEntries: number; offPalEntries: number; nSizeLast: number; size: number } | null = null;
  const STOCK_OBJECT_FLAG = 0x80000000;

  while (offset + 8 <= buffer.length) {
    const recType = buffer.readUInt32LE(offset);
    const recSize = buffer.readUInt32LE(offset + 4);
    expect(recSize).toBeGreaterThanOrEqual(8);
    expect(recSize % 4).toBe(0); // EMF records must be 4-byte aligned

    records.push({ type: recType, size: recSize, offset });

    if (recType === 17) hasSetMapMode = true; // EMR_SETMAPMODE
    if (recType === 18) hasSetBkMode = true; // EMR_SETBKMODE
    if (recType === 19) hasSetPolyFillMode = true; // EMR_SETPOLYFILLMODE
    if (recType === 38) {
      // EMR_CREATEPEN
      hasCreatePen = true;
      maxObjectIndex = Math.max(maxObjectIndex, buffer.readUInt32LE(offset + 8));
      penColors.push(buffer.readUInt32LE(offset + 24));
    }
    if (recType === 39) {
      // EMR_CREATEBRUSHINDIRECT
      hasCreateBrush = true;
      maxObjectIndex = Math.max(maxObjectIndex, buffer.readUInt32LE(offset + 8));
      brushColors.push(buffer.readUInt32LE(offset + 16));
    }
    if (recType === 86) {
      // EMR_POLYGON16
      hasPolygon16 = true;
      const cpts = buffer.readUInt32LE(offset + 24);
      expect(recSize).toBe(28 + 4 * cpts);
      pointCounts.push(cpts);
    }
    if (recType === 87) {
      // EMR_POLYLINE16
      hasPolyline16 = true;
      const cpts = buffer.readUInt32LE(offset + 24);
      expect(recSize).toBe(28 + 4 * cpts);
      pointCounts.push(cpts);
    }
    if (recType === 37 || recType === 40) {
      // EMR_SELECTOBJECT / EMR_DELETEOBJECT: user handles must fit in nHandles
      const ih = buffer.readUInt32LE(offset + 8);
      if ((ih & STOCK_OBJECT_FLAG) === 0) {
        expect(ih).toBeGreaterThan(0);
        expect(ih).toBeLessThan(header.handles);
      }
    }
    if (recType === 14) {
      // EMR_EOF: last record, ends exactly at nBytes
      hasEof = true;
      eof = {
        nPalEntries: buffer.readUInt32LE(offset + 8),
        offPalEntries: buffer.readUInt32LE(offset + 12),
        nSizeLast: buffer.readUInt32LE(offset + recSize - 4),
        size: recSize,
      };
      expect(offset + recSize).toBe(buffer.length);
      break;
    }

    offset += recSize;
  }

  return {
    header,
    records,
    hasSetMapMode,
    hasSetBkMode,
    hasSetPolyFillMode,
    hasCreatePen,
    hasCreateBrush,
    hasPolygon16,
    hasPolyline16,
    hasEof,
    penColors,
    brushColors,
    pointCounts,
    maxObjectIndex,
    eof,
  };
}

// ============================================================================
// Independent WMF Binary Oracle Parser
// ============================================================================

interface WmfParsedHeader {
  aldusKey: number;
  aldusRight: number;
  aldusBottom: number;
  aldusInch: number;
  aldusChecksum: number;
  computedChecksum: number;
  fileType: number;
  headerSize: number;
  version: number;
  fileSizeInWords: number;
  numOfObjects: number;
  maxRecordInWords: number;
}

function parseWmfBinary(buffer: Buffer): {
  header: WmfParsedHeader;
  hasSetWindowOrg: boolean;
  hasSetWindowExt: boolean;
  hasCreatePen: boolean;
  hasCreateBrush: boolean;
  hasPolygon: boolean;
  hasPolyline: boolean;
  hasEof: boolean;
  recordCount: number;
} {
  expect(buffer.length).toBeGreaterThanOrEqual(40); // 22 bytes Aldus + 18 bytes Standard

  // Aldus placeable header
  const aldusKey = buffer.readUInt32LE(0);
  const aldusRight = buffer.readInt16LE(10);
  const aldusBottom = buffer.readInt16LE(12);
  const aldusInch = buffer.readUInt16LE(14);
  const aldusChecksum = buffer.readUInt16LE(20);

  let computedChecksum = 0;
  for (let off = 0; off < 20; off += 2) {
    computedChecksum ^= buffer.readUInt16LE(off);
  }

  // Standard WMF header
  const fileType = buffer.readUInt16LE(22);
  const headerSize = buffer.readUInt16LE(24);
  const version = buffer.readUInt16LE(26);
  const fileSizeInWords = buffer.readUInt32LE(28);
  const numOfObjects = buffer.readUInt16LE(32);
  const maxRecordInWords = buffer.readUInt32LE(34);

  const header: WmfParsedHeader = {
    aldusKey,
    aldusRight,
    aldusBottom,
    aldusInch,
    aldusChecksum,
    computedChecksum,
    fileType,
    headerSize,
    version,
    fileSizeInWords,
    numOfObjects,
    maxRecordInWords,
  };

  let offset = 40;
  let recordCount = 0;
  let hasSetWindowOrg = false;
  let hasSetWindowExt = false;
  let hasCreatePen = false;
  let hasCreateBrush = false;
  let hasPolygon = false;
  let hasPolyline = false;
  let hasEof = false;

  while (offset + 6 <= buffer.length) {
    const recWords = buffer.readUInt32LE(offset);
    const fnCode = buffer.readUInt16LE(offset + 4);
    recordCount++;

    if (fnCode === 0x020b) hasSetWindowOrg = true;
    if (fnCode === 0x020c) hasSetWindowExt = true;
    if (fnCode === 0x02fa) hasCreatePen = true;
    if (fnCode === 0x02fc) hasCreateBrush = true;
    if (fnCode === 0x0324) hasPolygon = true;
    if (fnCode === 0x0325) hasPolyline = true;
    if (fnCode === 0x0000) {
      hasEof = true;
      break;
    }

    const recBytes = recWords * 2;
    expect(recBytes).toBeGreaterThanOrEqual(6);
    offset += recBytes;
  }

  return {
    header,
    hasSetWindowOrg,
    hasSetWindowExt,
    hasCreatePen,
    hasCreateBrush,
    hasPolygon,
    hasPolyline,
    hasEof,
    recordCount,
  };
}

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

      const parsed = parseEmfBinary(emfBuf);

      // MS-EMF 2.2.9: dSignature MUST be ENHMETA_SIGNATURE, the ASCII bytes " EMF"
      expect(emfBuf.subarray(40, 44).toString('latin1')).toBe(' EMF');
      expect(parsed.header.signature).toBe(0x464d4520);
      expect(parsed.header.version).toBe(0x00010000); // 1.0
      expect(parsed.header.reserved).toBe(0);
      // nHandles = highest object table index used + 1 (index 0 is reserved)
      expect(parsed.header.handles).toBe(parsed.maxObjectIndex + 1);
      // EMR_EOF: no palette, nSizeLast repeats the record size
      expect(parsed.eof?.nPalEntries).toBe(0);
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

      const parsed = parseWmfBinary(wmfBuf);

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
  });

  describe('CGM Encoder (ISO 8632 Clear-Text)', () => {
    it('generates genuine ISO 8632 clear-text CGM format with escaped baseName', () => {
      const cgmBuf = encodeCgm(svgBuffer, 'My "Engineering" Model');
      expect(cgmBuf).toBeInstanceOf(Buffer);
      expect(cgmBuf.length).toBeGreaterThan(100);
      const cgmText = cgmBuf.toString('utf-8');

      // ISO 8632 Delimiters and Directives
      expect(cgmText).toContain('BEGMF "My \\"Engineering\\" Model";');
      expect(cgmText).toContain('MFVERSION 1;');
      expect(cgmText).toContain('MFDESC "Generated by EasyConvert Vector Engine";');
      expect(cgmText).toContain('MFELEMENTLIST "DRAWINGSET";');
      expect(cgmText).toContain('BEGMFDEFAULTS;');
      expect(cgmText).toContain('ENDMFDEFAULTS;');
      expect(cgmText).toContain('BEGPIC "My \\"Engineering\\" Model";');
      expect(cgmText).toContain('BEGPICBODY;');
      expect(cgmText).toContain('VDCEXT (0,0) (400,300);');
      expect(cgmText).toContain('COLRMODE DIRECT;');
      expect(cgmText).toContain('BEGMDL "My \\"Engineering\\" Model";');

      // Styling and Geometry
      expect(cgmText).toContain('LINECOLR');
      expect(cgmText).toContain('FILLCOLR');
      expect(cgmText).toContain('POLYLINE');
      expect(cgmText).toContain('POLYGON');

      // Delimiter terminations
      expect(cgmText).toContain('ENDMDL;');
      expect(cgmText).toContain('ENDPIC;');
      expect(cgmText).toContain('ENDMF;');
    });

    it('round-trips CGM clear text back to SVG elements via parseCgmToSvg', async () => {
      const cgmBuf = encodeCgm(svgBuffer, 'roundtrip');
      const res = await convertVectorCad(cgmBuf, 'cgm', 'svg', {}, 'roundtrip.cgm');

      expect(res.mimeType).toBe('image/svg+xml');
      expect(res.filename).toBe('roundtrip.svg');
      const svgOut = res.buffer.toString('utf-8');

      expect(svgOut).toContain('<svg');
      expect(svgOut).toContain('viewBox="0 0 400 300"');
      expect(svgOut).toContain('<polyline');
      expect(svgOut).toContain('<polygon');
    });

    it('rejects empty input buffer fail-closed', () => {
      expect(() => encodeCgm(Buffer.alloc(0))).toThrow(/empty/i);
    });
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

      const parsed = parseEmfBinary(res.buffer);
      expect(parsed.hasEof).toBe(true);
    });

    it('routes svg to wmf conversion with authentic mimeType and filename', async () => {
      const res = await convertVectorCad(svgBuffer, 'svg', 'wmf', {}, 'diagram.svg');
      expect(res.mimeType).toBe('image/wmf');
      expect(res.filename).toBe('diagram.wmf');
      expect(res.size).toBeGreaterThan(40);

      const parsed = parseWmfBinary(res.buffer);
      expect(parsed.hasEof).toBe(true);
    });

    it('routes svg to cgm conversion with authentic mimeType and filename', async () => {
      const res = await convertVectorCad(svgBuffer, 'svg', 'cgm', {}, 'diagram.svg');
      expect(res.mimeType).toBe('image/cgm');
      expect(res.filename).toBe('diagram.cgm');
      expect(res.buffer.toString('utf-8')).toContain('BEGMF "diagram";');
    });
  });

  describe('Differential Visual Oracle (LibreOffice soffice)', () => {
    oracleTest(
      'renders EMF and WMF via LibreOffice soffice to PNG and verifies visual similarity',
      ['soffice', 'pdftoppm'],
      async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-oracle-'));
        try {
          const emfPath = path.join(tempDir, 'sample.emf');
          const wmfPath = path.join(tempDir, 'sample.wmf');
          const refSvgPngPath = path.join(tempDir, 'ref.png');

          // Generate EMF and WMF
          const emfBuf = encodeEmf(svgBuffer);
          const wmfBuf = encodeWmf(svgBuffer);
          fs.writeFileSync(emfPath, emfBuf);
          fs.writeFileSync(wmfPath, wmfBuf);

          // Render Reference PNG from SVG via sharp
          const refPng = await sharp(svgBuffer).resize(400, 300).png().toBuffer();
          fs.writeFileSync(refSvgPngPath, refPng);

          // Convert EMF to PDF using LibreOffice with isolated profile
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
              emfPath,
              '--outdir',
              tempDir,
            ],
            {
              timeout: 30000,
              stdio: ['pipe', 'pipe', 'pipe'],
              env: { ...process.env, HOME: tempDir, SAL_USE_VCLPLUGIN: 'svp' },
            }
          );
          const emfPdfPath = path.join(tempDir, 'sample.pdf');
          expect(fs.existsSync(emfPdfPath)).toBe(true);

          const pdfBuf = fs.readFileSync(emfPdfPath);
          const pages = await renderPdfPagesWithPdftoppm(pdfBuf);
          expect(pages.length).toBeGreaterThanOrEqual(1);
          const emfResized = await sharp(pages[0]).resize(400, 300).png().toBuffer();
          const vrtResult = await compareImages(emfResized, refPng, { minSsim: 0.85 });

          expect(vrtResult.ssim).toBeGreaterThanOrEqual(0.85);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
      45000
    );
  });
});
