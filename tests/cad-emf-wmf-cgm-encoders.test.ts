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
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { CadGeometryUnavailableError, ConversionFailedError } from '../src/lib/types';
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
      // MS-EMF 2.2.19 LogPen: a cosmetic pen (PS_COSMETIC) MUST have width 1;
      // wider strokes require PS_GEOMETRIC (0x00010000) with a logical-unit width.
      const PEN_TYPE_MASK = 0x000f0000;
      const penStyle = buffer.readUInt32LE(offset + 12);
      const penWidth = buffer.readInt32LE(offset + 16);
      if ((penStyle & PEN_TYPE_MASK) === 0) {
        expect(penWidth).toBe(1);
      }
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
  observedMaxRecordWords: number;
  observedTotalWords: number;
  maxObjectSlotsInUse: number;
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
  let observedMaxRecordWords = 0;
  const META_HEADER_WORDS = 9;
  let observedTotalWords = META_HEADER_WORDS;
  // WMF object table: create records take the lowest free slot, delete frees it
  const slots: boolean[] = [];
  let maxObjectSlotsInUse = 0;

  while (offset + 6 <= buffer.length) {
    const recWords = buffer.readUInt32LE(offset);
    const fnCode = buffer.readUInt16LE(offset + 4);
    recordCount++;
    observedMaxRecordWords = Math.max(observedMaxRecordWords, recWords);
    observedTotalWords += recWords;
    // Fixed-size records: RecordSize in WORDs as defined by MS-WMF section 2.3
    const fixedRecordWords: Record<number, number> = {
      0x020b: 5, // META_SETWINDOWORG
      0x020c: 5, // META_SETWINDOWEXT
      0x02fa: 8, // META_CREATEPENINDIRECT
      0x02fc: 7, // META_CREATEBRUSHINDIRECT
      0x012d: 4, // META_SELECTOBJECT
      0x01f0: 4, // META_DELETEOBJECT
    };
    if (fixedRecordWords[fnCode] !== undefined) {
      expect(recWords).toBe(fixedRecordWords[fnCode]);
    }
    if (fnCode === 0x02fa || fnCode === 0x02fc) {
      let free = slots.indexOf(false);
      if (free === -1) free = slots.length;
      slots[free] = true;
      maxObjectSlotsInUse = Math.max(maxObjectSlotsInUse, slots.length);
    }
    if (fnCode === 0x012d) {
      expect(slots[buffer.readUInt16LE(offset + 6)]).toBe(true);
    }
    if (fnCode === 0x01f0) {
      const idx = buffer.readUInt16LE(offset + 6);
      expect(slots[idx]).toBe(true);
      slots[idx] = false;
    }
    if (fnCode === 0x0324 || fnCode === 0x0325) {
      expect(recWords).toBe(4 + 2 * buffer.readInt16LE(offset + 6));
    }

    if (fnCode === 0x020b) hasSetWindowOrg = true;
    if (fnCode === 0x020c) hasSetWindowExt = true;
    if (fnCode === 0x02fa) hasCreatePen = true;
    if (fnCode === 0x02fc) hasCreateBrush = true;
    if (fnCode === 0x0324) hasPolygon = true;
    if (fnCode === 0x0325) hasPolyline = true;
    if (fnCode === 0x0000) {
      expect(recWords).toBe(3);
      expect(offset + recWords * 2).toBe(buffer.length);
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
    observedMaxRecordWords,
    observedTotalWords,
    maxObjectSlotsInUse,
  };
}

// ============================================================================
// Independent ISO/IEC 8632-4 Clear-Text CGM Oracle Parser
// ============================================================================

interface CgmElement {
  name: string;
  params: string;
}

/** Splits clear-text CGM into elements at ';' outside quoted strings (8632-4 clause 6). */
function tokenizeClearTextCgm(text: string): CgmElement[] {
  const elements: CgmElement[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        // A doubled delimiter inside a string is a literal quote character
        if (text[i + 1] === quote) {
          current += text[++i];
        } else {
          quote = null;
        }
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ';' || ch === '/') {
      const trimmed = current.trim();
      if (trimmed) {
        const m = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(trimmed);
        expect(m, `malformed element: ${trimmed}`).not.toBeNull();
        elements.push({ name: m![1].toUpperCase(), params: m![2].trim() });
      }
      current = '';
    } else {
      current += ch;
    }
  }
  expect(quote, 'unterminated string').toBeNull();
  expect(current.trim(), 'trailing element without terminator').toBe('');
  return elements;
}

/** Decodes one quoted clear-text string parameter, honouring doubled delimiters. */
function decodeCgmString(param: string): string {
  const delim = param[0];
  expect(delim === '"' || delim === "'").toBe(true);
  expect(param.endsWith(delim)).toBe(true);
  const body = param.slice(1, -1);
  expect(body.split(delim + delim).join('')).not.toContain(delim);
  return body.split(delim + delim).join(delim);
}

function parseCgmPoints(params: string): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const rest = params.replace(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g, (_m, x, y) => {
    pts.push({ x: Number(x), y: Number(y) });
    return '';
  });
  expect(rest.trim(), `unparsed point data: ${rest}`).toBe('');
  return pts;
}

function parseCgmDirectColour(params: string): [number, number, number] {
  expect(params).toMatch(/^\d+\s+\d+\s+\d+$/);
  const parts = params.split(/\s+/).map(Number);
  for (const c of parts) {
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(255);
  }
  return parts as [number, number, number];
}

// Element names from ISO/IEC 8632-4 Table 3, grouped by where they may appear
const CGM_METAFILE_DESCRIPTOR = new Set(['MFVERSION', 'MFDESC', 'VDCTYPE', 'INTEGERPREC', 'REALPREC', 'INDEXPREC', 'COLRPREC', 'COLRINDEXPREC', 'MAXCOLRINDEX', 'COLRVALUEEXT', 'MFELEMLIST', 'BEGMFDEFAULTS', 'ENDMFDEFAULTS', 'FONTLIST', 'CHARSETLIST', 'CHARCODING']);
const CGM_PICTURE_DESCRIPTOR = new Set(['SCALEMODE', 'COLRMODE', 'LINEWIDTHMODE', 'MARKERSIZEMODE', 'EDGEWIDTHMODE', 'VDCEXT', 'BACKCOLR']);
const CGM_PICTURE_BODY = new Set(['POLYLINE', 'POLYGON', 'LINECOLR', 'LINEWIDTH', 'LINETYPE', 'FILLCOLR', 'INTSTYLE', 'EDGEVIS', 'EDGECOLR', 'EDGEWIDTH', 'TEXT', 'TEXTCOLR', 'CHARHEIGHT', 'CLIPRECT', 'CLIP']);

interface CgmDocument {
  elements: CgmElement[];
  mfName: string;
  vdcExtent: { x: number; y: number }[];
  body: CgmElement[];
}

/** Validates metafile/picture structure per ISO/IEC 8632-1 clause 7 and returns its parts. */
function parseClearTextCgm(text: string): CgmDocument {
  const elements = tokenizeClearTextCgm(text);
  expect(elements[0].name).toBe('BEGMF');
  expect(elements[elements.length - 1].name).toBe('ENDMF');
  expect(elements[1].name).toBe('MFVERSION');

  let state: 'mfdesc' | 'picdesc' | 'body' | 'between' = 'mfdesc';
  let vdcExtent: { x: number; y: number }[] = [];
  const body: CgmElement[] = [];
  for (const el of elements.slice(1, -1)) {
    if (el.name === 'BEGPIC') {
      expect(['mfdesc', 'between']).toContain(state);
      decodeCgmString(el.params);
      state = 'picdesc';
    } else if (el.name === 'BEGPICBODY') {
      expect(state).toBe('picdesc');
      state = 'body';
    } else if (el.name === 'ENDPIC') {
      expect(state).toBe('body');
      state = 'between';
    } else if (state === 'mfdesc') {
      expect(CGM_METAFILE_DESCRIPTOR.has(el.name), `${el.name} in metafile descriptor`).toBe(true);
    } else if (state === 'picdesc') {
      expect(CGM_PICTURE_DESCRIPTOR.has(el.name), `${el.name} in picture descriptor`).toBe(true);
      if (el.name === 'VDCEXT') vdcExtent = parseCgmPoints(el.params);
    } else if (state === 'body') {
      expect(CGM_PICTURE_BODY.has(el.name), `${el.name} in picture body`).toBe(true);
      body.push(el);
    } else {
      throw new Error(`element ${el.name} outside any picture`);
    }
  }
  expect(state).toBe('between');
  return { elements, mfName: decodeCgmString(elements[0].params), vdcExtent, body };
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
      const parsed = parseWmfBinary(encodeWmf(lineSvg));
      // Largest record here is CREATEPENINDIRECT / two-point POLYLINE: 8 WORDs
      expect(parsed.observedMaxRecordWords).toBe(8);
      expect(parsed.header.maxRecordInWords).toBe(8);
      expect(parsed.header.fileSizeInWords).toBe(parsed.observedTotalWords);
    });
  });

  describe('CGM Encoder (ISO 8632 Clear-Text)', () => {
    it('generates ISO 8632-4 clear-text CGM with valid element names, structure and syntax', () => {
      const cgmBuf = encodeCgm(svgBuffer, 'My "Engineering" Model');
      const doc = parseClearTextCgm(cgmBuf.toString('utf-8'));

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
      const lineColours = doc.body.filter((e) => e.name === 'LINECOLR').map((e) => parseCgmDirectColour(e.params));
      const fillColours = doc.body.filter((e) => e.name === 'FILLCOLR').map((e) => parseCgmDirectColour(e.params));
      expect(lineColours).toContainEqual([255, 0, 0]); // rect stroke
      expect(fillColours).toContainEqual([0, 0, 255]); // rect fill
      expect(fillColours).toContainEqual([128, 0, 128]); // polygon fill

      // Geometry: rect corners in VDC match the SVG coordinates
      const polygons = doc.body.filter((e) => e.name === 'POLYGON').map((e) => parseCgmPoints(e.params));
      const polylines = doc.body.filter((e) => e.name === 'POLYLINE').map((e) => parseCgmPoints(e.params));
      for (const pg of polygons) expect(pg.length).toBeGreaterThanOrEqual(3);
      for (const pl of polylines) expect(pl.length).toBeGreaterThanOrEqual(2);
      expect(polygons).toContainEqual([
        { x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 100 }, { x: 20, y: 100 }, { x: 20, y: 20 },
      ]);
      expect(polylines).toContainEqual([{ x: 20, y: 150 }, { x: 70, y: 220 }, { x: 120, y: 160 }, { x: 170, y: 240 }]);
    });

    it('round-trips CGM clear text back to SVG elements via parseCgmToSvg', async () => {
      const cgmBuf = encodeCgm(svgBuffer, 'roundtrip');
      const res = await convertVectorCad(cgmBuf, 'cgm', 'svg', {}, 'roundtrip.cgm');

      expect(res.mimeType).toBe('image/svg+xml');
      expect(res.filename).toBe('roundtrip.svg');
      const svgOut = res.buffer.toString('utf-8');

      expect(svgOut).toContain('<svg');
      expect(svgOut).toContain('viewBox="0 0 400 300"');
      expect(svgOut).toContain('<polyline points="20,150 70,220 120,160 170,240"');
      expect(svgOut).toContain('<polygon points="20,20 140,20 140,100 20,100 20,20"');
      // POLYLINE elements must not also be decoded as LINE primitives
      expect(svgOut).not.toContain('<line');
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
      expect(parseClearTextCgm(res.buffer.toString('utf-8')).mfName).toBe('diagram');
    });
  });

  describe('Differential Visual Oracle (LibreOffice soffice)', () => {
    const SOFFICE_TIMEOUT_MS = 60000;
    const MIN_SSIM = 0.85;
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
