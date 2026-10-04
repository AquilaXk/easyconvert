/**
 * Independent metafile oracles: minimal MS-EMF / MS-WMF record walkers and an
 * ISO/IEC 8632-4 clear-text CGM tokenizer, written from the specifications and
 * sharing no code with src/lib/conversions/vector-metafile.ts.
 */
import { expect } from 'vitest';

// ============================================================================
// Independent EMF Binary Oracle Parser
// ============================================================================

export interface EmfParsedRecord {
  type: number;
  size: number;
  offset: number;
}

export interface EmfParsedHeader {
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

export function parseEmfBinary(buffer: Buffer): {
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
    if (recType === 95) {
      // EMR_EXTCREATEPEN (MS-EMF 2.3.7.9): ihPen, offBmi, cbBmi, offBits, cbBits, LogPenEx
      hasCreatePen = true;
      maxObjectIndex = Math.max(maxObjectIndex, buffer.readUInt32LE(offset + 8));
      const numStyleEntries = buffer.readUInt32LE(offset + 48);
      expect(recSize).toBe(52 + 4 * numStyleEntries);
      penColors.push(buffer.readUInt32LE(offset + 40));
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

export interface WmfParsedHeader {
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

export function parseWmfBinary(buffer: Buffer): {
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

export interface CgmElement {
  name: string;
  params: string;
}

/** Splits clear-text CGM into elements at ';' outside quoted strings (8632-4 clause 6). */
export function tokenizeClearTextCgm(text: string): CgmElement[] {
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
export function decodeCgmString(param: string): string {
  const delim = param[0];
  expect(delim === '"' || delim === "'").toBe(true);
  expect(param.endsWith(delim)).toBe(true);
  const body = param.slice(1, -1);
  expect(body.split(delim + delim).join('')).not.toContain(delim);
  return body.split(delim + delim).join(delim);
}

export function parseCgmPoints(params: string): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const rest = params.replace(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g, (_m, x, y) => {
    pts.push({ x: Number(x), y: Number(y) });
    return '';
  });
  expect(rest.trim(), `unparsed point data: ${rest}`).toBe('');
  return pts;
}

export function parseCgmDirectColour(params: string): [number, number, number] {
  expect(params).toMatch(/^\d+\s+\d+\s+\d+$/);
  const parts = params.split(/\s+/).map(Number);
  for (const c of parts) {
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(255);
  }
  return parts as [number, number, number];
}

// Element names from ISO/IEC 8632-4 Table 3, grouped by where they may appear
export const CGM_METAFILE_DESCRIPTOR = new Set(['MFVERSION', 'MFDESC', 'VDCTYPE', 'INTEGERPREC', 'REALPREC', 'INDEXPREC', 'COLRPREC', 'COLRINDEXPREC', 'MAXCOLRINDEX', 'COLRVALUEEXT', 'MFELEMLIST', 'BEGMFDEFAULTS', 'ENDMFDEFAULTS', 'FONTLIST', 'CHARSETLIST', 'CHARCODING']);
export const CGM_PICTURE_DESCRIPTOR = new Set(['SCALEMODE', 'COLRMODE', 'LINEWIDTHMODE', 'MARKERSIZEMODE', 'EDGEWIDTHMODE', 'VDCEXT', 'BACKCOLR']);
export const CGM_PICTURE_BODY = new Set(['POLYLINE', 'POLYGON', 'POLYGONSET', 'LINEWIDTHMODE', 'LINECOLR', 'LINEWIDTH', 'LINETYPE', 'FILLCOLR', 'INTSTYLE', 'EDGEVIS', 'EDGECOLR', 'EDGEWIDTH', 'TEXT', 'TEXTCOLR', 'CHARHEIGHT', 'CLIPRECT', 'CLIP']);

export interface CgmDocument {
  elements: CgmElement[];
  mfName: string;
  vdcExtent: { x: number; y: number }[];
  body: CgmElement[];
}

/** Validates metafile/picture structure per ISO/IEC 8632-1 clause 7 and returns its parts. */
export function parseClearTextCgm(text: string): CgmDocument {
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
// Metafile playback: replays drawing records into device-space shapes
// ============================================================================

export interface PlaybackPoint {
  x: number;
  y: number;
}

export interface PlaybackShape {
  /** 'polygon' covers POLYGON and POLYPOLYGON records; 'polyline' is stroke only. */
  kind: 'polygon' | 'polyline';
  /** One entry per polygon/polyline, in reference-device pixels (96 DPI). */
  rings: PlaybackPoint[][];
  /** Pen colour as 0xRRGGBB and width in device pixels, or null for a null pen. */
  pen: { color: number; width: number; style: number } | null;
  /** Brush colour as 0xRRGGBB, or null for a hollow/null brush. */
  brush: number | null;
  /** 1 = ALTERNATE (even-odd), 2 = WINDING (nonzero). */
  fillMode: number;
  /** Miter limit in effect (EMR_SETMITERLIMIT), or null when never set. */
  miterLimit: number | null;
}

interface GdiPen {
  type: 'pen';
  color: number | null;
  width: number;
  /** Raw PenStyle bits (line style, end cap, join, pen type). */
  style: number;
}
interface GdiBrush {
  type: 'brush';
  color: number | null;
}
type GdiObject = GdiPen | GdiBrush;

function colorRefToRgb(colorRef: number): number {
  const r = colorRef & 0xff;
  const g = (colorRef >> 8) & 0xff;
  const b = (colorRef >> 16) & 0xff;
  return (r << 16) | (g << 8) | b;
}

interface MappingState {
  mapMode: number;
  windowOrg: PlaybackPoint;
  windowExt: PlaybackPoint;
  viewportOrg: PlaybackPoint;
  viewportExt: PlaybackPoint;
}

const MM_TEXT = 1;
const MM_ANISOTROPIC = 8;

function mapEmfPoint(m: MappingState, x: number, y: number): PlaybackPoint {
  if (m.mapMode === MM_ANISOTROPIC) {
    return {
      x: ((x - m.windowOrg.x) * m.viewportExt.x) / m.windowExt.x + m.viewportOrg.x,
      y: ((y - m.windowOrg.y) * m.viewportExt.y) / m.windowExt.y + m.viewportOrg.y,
    };
  }
  expect(m.mapMode).toBe(MM_TEXT);
  return { x: x - m.windowOrg.x + m.viewportOrg.x, y: y - m.windowOrg.y + m.viewportOrg.y };
}

/** Logical-to-device scale for widths (geometric pen widths are in logical units). */
function emfWidthScale(m: MappingState): number {
  if (m.mapMode === MM_ANISOTROPIC) {
    expect(Math.abs(m.viewportExt.x / m.windowExt.x)).toBeCloseTo(Math.abs(m.viewportExt.y / m.windowExt.y), 6);
    return Math.abs(m.viewportExt.x / m.windowExt.x);
  }
  return 1;
}

/** Replays an EMF file (as written by MS-EMF 2.3) into device-space shapes. */
export function playbackEmf(buffer: Buffer): PlaybackShape[] {
  const nBytes = buffer.readUInt32LE(48);
  expect(nBytes).toBe(buffer.length);
  const objects = new Map<number, GdiObject>();
  const STOCK_NULL_BRUSH = 0x80000005;
  const STOCK_NULL_PEN = 0x80000008;
  const STOCK_BLACK_PEN = 0x80000007;
  const STOCK_WHITE_BRUSH = 0x80000000;
  let pen: GdiPen = { type: 'pen', color: 0, width: 1, style: 0 };
  let brush: GdiBrush = { type: 'brush', color: 0xffffff };
  let fillMode = 1;
  let miterLimit: number | null = null;
  const m: MappingState = {
    mapMode: MM_TEXT,
    windowOrg: { x: 0, y: 0 },
    windowExt: { x: 1, y: 1 },
    viewportOrg: { x: 0, y: 0 },
    viewportExt: { x: 1, y: 1 },
  };
  const shapes: PlaybackShape[] = [];
  const emit = (kind: PlaybackShape['kind'], rings: PlaybackPoint[][]) => {
    const scale = emfWidthScale(m);
    shapes.push({
      kind,
      rings,
      pen: pen.color === null ? null : { color: pen.color, width: pen.width * scale, style: pen.style },
      brush: kind === 'polygon' ? brush.color : null,
      fillMode,
      miterLimit,
    });
  };
  const readPoints16 = (at: number, count: number): PlaybackPoint[] => {
    const pts: PlaybackPoint[] = [];
    for (let k = 0; k < count; k++) {
      pts.push(mapEmfPoint(m, buffer.readInt16LE(at + k * 4), buffer.readInt16LE(at + k * 4 + 2)));
    }
    return pts;
  };

  let offset = buffer.readUInt32LE(4);
  while (offset < buffer.length) {
    const type = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    expect(size % 4).toBe(0);
    expect(offset + size).toBeLessThanOrEqual(buffer.length);
    switch (type) {
      case 17: // EMR_SETMAPMODE
        m.mapMode = buffer.readUInt32LE(offset + 8);
        break;
      case 9: // EMR_SETWINDOWEXTEX
        expect(size).toBe(16);
        m.windowExt = { x: buffer.readInt32LE(offset + 8), y: buffer.readInt32LE(offset + 12) };
        break;
      case 10: // EMR_SETWINDOWORGEX
        expect(size).toBe(16);
        m.windowOrg = { x: buffer.readInt32LE(offset + 8), y: buffer.readInt32LE(offset + 12) };
        break;
      case 11: // EMR_SETVIEWPORTEXTEX
        expect(size).toBe(16);
        m.viewportExt = { x: buffer.readInt32LE(offset + 8), y: buffer.readInt32LE(offset + 12) };
        break;
      case 12: // EMR_SETVIEWPORTORGEX
        expect(size).toBe(16);
        m.viewportOrg = { x: buffer.readInt32LE(offset + 8), y: buffer.readInt32LE(offset + 12) };
        break;
      case 19: {
        // EMR_SETPOLYFILLMODE
        fillMode = buffer.readUInt32LE(offset + 8);
        expect([1, 2]).toContain(fillMode);
        break;
      }
      case 38: {
        // EMR_CREATEPEN: LogPen = PenStyle, Width (PointL), ColorRef
        const style = buffer.readUInt32LE(offset + 12);
        const PS_NULL = 5;
        objects.set(buffer.readUInt32LE(offset + 8), {
          type: 'pen',
          color: (style & 0xf) === PS_NULL ? null : colorRefToRgb(buffer.readUInt32LE(offset + 24)),
          width: buffer.readInt32LE(offset + 16),
          style,
        });
        break;
      }
      case 95: {
        // EMR_EXTCREATEPEN: no DIB pattern; LogPenEx = PenStyle, Width, BrushStyle, Color, BrushHatch, NumStyleEntries
        expect([12, 16, 20, 24].map((o) => buffer.readUInt32LE(offset + o))).toEqual([0, 0, 0, 0]);
        const style = buffer.readUInt32LE(offset + 28);
        const BS_SOLID = 0;
        expect(buffer.readUInt32LE(offset + 36)).toBe(BS_SOLID);
        const PS_NULL = 5;
        objects.set(buffer.readUInt32LE(offset + 8), {
          type: 'pen',
          color: (style & 0xf) === PS_NULL ? null : colorRefToRgb(buffer.readUInt32LE(offset + 40)),
          width: buffer.readUInt32LE(offset + 32),
          style,
        });
        break;
      }
      case 58: // EMR_SETMITERLIMIT: MiterLimit (unsigned integer, MS-EMF 2.3.11.21)
        expect(size).toBe(12);
        miterLimit = buffer.readUInt32LE(offset + 8);
        break;
      case 39: {
        // EMR_CREATEBRUSHINDIRECT: LogBrush32 = BrushStyle, Color, BrushHatch
        const style = buffer.readUInt32LE(offset + 12);
        const BS_SOLID = 0;
        const BS_NULL = 1;
        expect([BS_SOLID, BS_NULL]).toContain(style);
        objects.set(buffer.readUInt32LE(offset + 8), {
          type: 'brush',
          color: style === BS_NULL ? null : colorRefToRgb(buffer.readUInt32LE(offset + 16)),
        });
        break;
      }
      case 37: {
        // EMR_SELECTOBJECT
        const ih = buffer.readUInt32LE(offset + 8);
        if (ih === STOCK_NULL_PEN) pen = { type: 'pen', color: null, width: 0, style: 5 };
        else if (ih === STOCK_BLACK_PEN) pen = { type: 'pen', color: 0, width: 1, style: 0 };
        else if (ih === STOCK_NULL_BRUSH) brush = { type: 'brush', color: null };
        else if (ih === STOCK_WHITE_BRUSH) brush = { type: 'brush', color: 0xffffff };
        else {
          const obj = objects.get(ih);
          expect(obj, `select of undefined object ${ih}`).toBeDefined();
          if (obj!.type === 'pen') pen = obj as GdiPen;
          else brush = obj as GdiBrush;
        }
        break;
      }
      case 40: {
        // EMR_DELETEOBJECT
        const ih = buffer.readUInt32LE(offset + 8);
        expect(objects.has(ih)).toBe(true);
        objects.delete(ih);
        break;
      }
      case 86: // EMR_POLYGON16
      case 87: {
        // EMR_POLYLINE16: Bounds (16), Count, aPoints
        const count = buffer.readUInt32LE(offset + 24);
        expect(size).toBe(28 + 4 * count);
        emit(type === 86 ? 'polygon' : 'polyline', [readPoints16(offset + 28, count)]);
        break;
      }
      case 91: {
        // EMR_POLYPOLYGON16: Bounds, NumberOfPolygons, Count, PolygonPointCount[], aPoints
        const nPolys = buffer.readUInt32LE(offset + 24);
        const total = buffer.readUInt32LE(offset + 28);
        expect(size).toBe(32 + 4 * nPolys + 4 * total);
        const counts: number[] = [];
        for (let k = 0; k < nPolys; k++) counts.push(buffer.readUInt32LE(offset + 32 + k * 4));
        expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
        let at = offset + 32 + 4 * nPolys;
        const rings: PlaybackPoint[][] = [];
        for (const c of counts) {
          rings.push(readPoints16(at, c));
          at += 4 * c;
        }
        emit('polygon', rings);
        break;
      }
      case 14: // EMR_EOF
        expect(offset + size).toBe(buffer.length);
        return shapes;
      default:
        // State records this oracle does not interpret (SETBKMODE, etc.)
        break;
    }
    offset += size;
  }
  throw new Error('EMF has no EMR_EOF record');
}

/** Replays a placeable WMF (MS-WMF 2.3) into shapes in 96-DPI device pixels. */
export function playbackWmf(buffer: Buffer): PlaybackShape[] {
  const bboxLeft = buffer.readInt16LE(6);
  const bboxTop = buffer.readInt16LE(8);
  const inch = buffer.readUInt16LE(14);
  const CSS_DPI = 96;
  const toPx = CSS_DPI / inch;
  const objects: (GdiObject | null)[] = [];
  let pen: GdiPen = { type: 'pen', color: 0, width: 1, style: 0 };
  let brush: GdiBrush = { type: 'brush', color: 0xffffff };
  let fillMode = 1;
  let windowOrg: PlaybackPoint = { x: bboxLeft, y: bboxTop };
  const shapes: PlaybackShape[] = [];
  const pt = (x: number, y: number): PlaybackPoint => ({ x: (x - windowOrg.x) * toPx, y: (y - windowOrg.y) * toPx });
  const readPoints = (at: number, count: number): PlaybackPoint[] => {
    const pts: PlaybackPoint[] = [];
    for (let k = 0; k < count; k++) pts.push(pt(buffer.readInt16LE(at + k * 4), buffer.readInt16LE(at + k * 4 + 2)));
    return pts;
  };
  const emit = (kind: PlaybackShape['kind'], rings: PlaybackPoint[][]) => {
    shapes.push({
      kind,
      rings,
      pen: pen.color === null ? null : { color: pen.color, width: pen.width * toPx, style: pen.style },
      brush: kind === 'polygon' ? brush.color : null,
      fillMode,
      miterLimit: null,
    });
  };

  let offset = 22 + 18;
  while (offset + 6 <= buffer.length) {
    const words = buffer.readUInt32LE(offset);
    const fn = buffer.readUInt16LE(offset + 4);
    switch (fn) {
      case 0x020b: // META_SETWINDOWORG: Y, X
        windowOrg = { x: buffer.readInt16LE(offset + 8), y: buffer.readInt16LE(offset + 6) };
        break;
      case 0x0106: {
        // META_SETPOLYFILLMODE
        fillMode = buffer.readUInt16LE(offset + 6);
        expect([1, 2]).toContain(fillMode);
        break;
      }
      case 0x02fa:
      case 0x02fc: {
        let slot = objects.indexOf(null);
        if (slot === -1) slot = objects.length;
        if (fn === 0x02fa) {
          const PS_NULL = 5;
          const style = buffer.readUInt16LE(offset + 6);
          objects[slot] = {
            type: 'pen',
            color: (style & 0xf) === PS_NULL ? null : colorRefToRgb(buffer.readUInt32LE(offset + 12)),
            width: buffer.readInt16LE(offset + 8),
            style,
          };
        } else {
          const BS_NULL = 1;
          const style = buffer.readUInt16LE(offset + 6);
          objects[slot] = { type: 'brush', color: style === BS_NULL ? null : colorRefToRgb(buffer.readUInt32LE(offset + 8)) };
        }
        break;
      }
      case 0x012d: {
        const obj = objects[buffer.readUInt16LE(offset + 6)];
        expect(obj).toBeTruthy();
        if (obj!.type === 'pen') pen = obj as GdiPen;
        else brush = obj as GdiBrush;
        break;
      }
      case 0x01f0: {
        const idx = buffer.readUInt16LE(offset + 6);
        expect(objects[idx]).toBeTruthy();
        objects[idx] = null;
        break;
      }
      case 0x0324:
      case 0x0325: {
        const count = buffer.readInt16LE(offset + 6);
        expect(words).toBe(4 + 2 * count);
        emit(fn === 0x0324 ? 'polygon' : 'polyline', [readPoints(offset + 8, count)]);
        break;
      }
      case 0x0538: {
        // META_POLYPOLYGON: NumberOfPolygons, aPointsPerPolygon[], aPoints
        const nPolys = buffer.readUInt16LE(offset + 6);
        const counts: number[] = [];
        for (let k = 0; k < nPolys; k++) counts.push(buffer.readUInt16LE(offset + 8 + k * 2));
        const total = counts.reduce((a, b) => a + b, 0);
        expect(words).toBe(4 + nPolys + 2 * total);
        let at = offset + 8 + 2 * nPolys;
        const rings: PlaybackPoint[][] = [];
        for (const c of counts) {
          rings.push(readPoints(at, c));
          at += 4 * c;
        }
        emit('polygon', rings);
        break;
      }
      case 0x0000:
        return shapes;
      default:
        break;
    }
    offset += words * 2;
  }
  throw new Error('WMF has no META_EOF record');
}

/**
 * Parses POLYGONSET parameters, (x,y) followed by an edge-out flag
 * (INVIS | VIS | CLOSEINVIS | CLOSEVIS), into closed rings (ISO/IEC 8632-4).
 */
export function parseCgmPolygonSet(params: string): { x: number; y: number }[][] {
  const rings: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  const pairPattern = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*(INVIS|VIS|CLOSEINVIS|CLOSEVIS)\b/gi;
  const rest = params.replace(pairPattern, (_m, x, y, flag: string) => {
    current.push({ x: Number(x), y: Number(y) });
    if (flag.toUpperCase().startsWith('CLOSE')) {
      rings.push(current);
      current = [];
    }
    return '';
  });
  expect(rest.trim(), `unparsed POLYGONSET data: ${rest}`).toBe('');
  expect(current, 'POLYGONSET must end with a CLOSE flag').toEqual([]);
  return rings;
}
