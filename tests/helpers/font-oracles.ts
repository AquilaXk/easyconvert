/**
 * Independent readers and geometry helpers for font tests, authored from the OpenType (sfnt, glyf,
 * cmap, hmtx, post) and Adobe Technical Note 5176 / 5177 (CFF, Type 2 charstring) specifications.
 * Nothing here imports from src/, so expected values never come from the code under test.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync as brotliDecompress, inflateSync as zlibInflate } from 'node:zlib';

/** Oracle binaries are resolved from fixed system directories, never from a writable PATH entry. */
const ORACLE_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin'];
const FREETYPE_OTF_FORMAT = /OTF\*?\s+.*Freetype/;

function resolveOracleBinary(name: string): string | null {
  for (const dir of ORACLE_BIN_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const FC_SCAN_BIN = resolveOracleBinary('fc-scan');
const CONVERT_BIN = resolveOracleBinary('convert');

export const HAS_FC_SCAN = FC_SCAN_BIN !== null && spawnSync(FC_SCAN_BIN, ['--version'], { stdio: 'ignore' }).status === 0;
export const HAS_CONVERT = CONVERT_BIN !== null && spawnSync(CONVERT_BIN, ['-version'], { stdio: 'ignore' }).status === 0;
export const HAS_FREETYPE =
  HAS_CONVERT &&
  FREETYPE_OTF_FORMAT.test(spawnSync(CONVERT_BIN!, ['-list', 'format'], { encoding: 'utf8' }).stdout ?? '');

function requireBinary(bin: string | null, name: string): string {
  if (bin === null) throw new Error(`${name} oracle binary is not installed in ${ORACLE_BIN_DIRS.join(', ')}`);
  return bin;
}

/** CI runs the oracles in strict mode: a missing fc-scan must fail there instead of skipping the oracle. */
export function requireStrictFcScan(suite: string): void {
  if (process.env.ORACLE_STRICT_MODE === '1' && !HAS_FC_SCAN) {
    throw new Error(`ORACLE_STRICT_MODE requires fc-scan (fontconfig) for the ${suite} oracle`);
  }
}

/** CI runs the oracles in strict mode: a missing FreeType renderer (ImageMagick) must fail there instead of skipping the oracle. */
export function requireStrictFreeType(suite: string): void {
  if (process.env.ORACLE_STRICT_MODE === '1' && !HAS_FREETYPE) {
    throw new Error(`ORACLE_STRICT_MODE requires ImageMagick built with FreeType for the ${suite} render oracle`);
  }
}

export interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// sfnt directory
// ---------------------------------------------------------------------------

const SFNT_HEADER_SIZE = 12;
const SFNT_DIRECTORY_ENTRY_SIZE = 16;

export function readSfntTables(font: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const base = SFNT_HEADER_SIZE + i * SFNT_DIRECTORY_ENTRY_SIZE;
    const tag = font.toString('latin1', base, base + 4);
    const offset = font.readUInt32BE(base + 8);
    const length = font.readUInt32BE(base + 12);
    if (offset + length > font.length) throw new Error(`table ${tag} extends past the end of the font`);
    tables.set(tag, font.subarray(offset, offset + length));
  }
  return tables;
}

export function requireTable(tables: Map<string, Buffer>, tag: string): Buffer {
  const table = tables.get(tag);
  if (table === undefined) throw new Error(`font has no '${tag}' table`);
  return table;
}

// ---------------------------------------------------------------------------
// glyf / loca / hmtx / cmap / post readers
// ---------------------------------------------------------------------------

export interface TtPoint extends Pt {
  on: boolean;
}

export interface TtGlyph {
  bbox: [number, number, number, number];
  contours: TtPoint[][];
}

const HEAD_UNITS_PER_EM_OFFSET = 18;
const HEAD_INDEX_TO_LOC_FORMAT_OFFSET = 50;

export function readUnitsPerEm(tables: Map<string, Buffer>): number {
  return requireTable(tables, 'head').readUInt16BE(HEAD_UNITS_PER_EM_OFFSET);
}

export function readGlyphCount(tables: Map<string, Buffer>): number {
  return requireTable(tables, 'maxp').readUInt16BE(4);
}

/** Reads a simple glyph; returns null for an empty glyph and throws on composite or truncated data. */
export function readGlyf(tables: Map<string, Buffer>, glyphId: number): TtGlyph | null {
  const head = requireTable(tables, 'head');
  const loca = requireTable(tables, 'loca');
  const glyf = requireTable(tables, 'glyf');
  const long = head.readInt16BE(HEAD_INDEX_TO_LOC_FORMAT_OFFSET) === 1;
  const start = long ? loca.readUInt32BE(glyphId * 4) : loca.readUInt16BE(glyphId * 2) * 2;
  const end = long ? loca.readUInt32BE(glyphId * 4 + 4) : loca.readUInt16BE(glyphId * 2 + 2) * 2;
  if (end === start) return null;
  const numberOfContours = glyf.readInt16BE(start);
  if (numberOfContours <= 0) throw new Error(`glyph ${glyphId} is not a simple glyph (${numberOfContours} contours)`);
  const bbox: [number, number, number, number] = [
    glyf.readInt16BE(start + 2),
    glyf.readInt16BE(start + 4),
    glyf.readInt16BE(start + 6),
    glyf.readInt16BE(start + 8),
  ];
  let p = start + 10;
  const endPoints: number[] = [];
  for (let c = 0; c < numberOfContours; c++, p += 2) endPoints.push(glyf.readUInt16BE(p));
  const numPoints = endPoints[endPoints.length - 1] + 1;
  p += 2 + glyf.readUInt16BE(p);
  const flags: number[] = [];
  while (flags.length < numPoints) {
    const flag = glyf[p++];
    flags.push(flag);
    if (flag & 0x08) {
      const repeat = glyf[p++];
      for (let r = 0; r < repeat; r++) flags.push(flag);
    }
  }
  const coordinates = (shortBit: number, sameBit: number): number[] => {
    const values: number[] = [];
    let value = 0;
    for (const flag of flags) {
      if (flag & shortBit) {
        const delta = glyf[p++];
        value += flag & sameBit ? delta : -delta;
      } else if (!(flag & sameBit)) {
        value += glyf.readInt16BE(p);
        p += 2;
      }
      values.push(value);
    }
    return values;
  };
  const xs = coordinates(0x02, 0x10);
  const ys = coordinates(0x04, 0x20);
  const contours: TtPoint[][] = [];
  let first = 0;
  for (const last of endPoints) {
    const contour: TtPoint[] = [];
    for (let i = first; i <= last; i++) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    contours.push(contour);
    first = last + 1;
  }
  if (p > end) throw new Error(`glyph ${glyphId} data runs past its loca extent`);
  return { bbox, contours };
}

export function readHmtx(tables: Map<string, Buffer>, glyphId: number): { advance: number; lsb: number } {
  const hhea = requireTable(tables, 'hhea');
  const hmtx = requireTable(tables, 'hmtx');
  const metrics = hhea.readUInt16BE(34);
  if (glyphId < metrics) {
    return { advance: hmtx.readUInt16BE(glyphId * 4), lsb: hmtx.readInt16BE(glyphId * 4 + 2) };
  }
  return {
    advance: hmtx.readUInt16BE((metrics - 1) * 4),
    lsb: hmtx.readInt16BE(metrics * 4 + (glyphId - metrics) * 2),
  };
}

/** Maps code points to glyph ids from every Windows Unicode subtable (formats 4 and 12). */
export function readCmap(tables: Map<string, Buffer>): Map<number, number> {
  const cmap = requireTable(tables, 'cmap');
  const map = new Map<number, number>();
  const numSubtables = cmap.readUInt16BE(2);
  for (let i = 0; i < numSubtables; i++) {
    const offset = cmap.readUInt32BE(4 + i * 8 + 4);
    const format = cmap.readUInt16BE(offset);
    if (format === 12) {
      const groups = cmap.readUInt32BE(offset + 12);
      for (let g = 0; g < groups; g++) {
        const base = offset + 16 + g * 12;
        const first = cmap.readUInt32BE(base);
        const last = cmap.readUInt32BE(base + 4);
        const glyph = cmap.readUInt32BE(base + 8);
        for (let c = first; c <= last; c++) map.set(c, glyph + (c - first));
      }
    } else if (format === 4) {
      const segCount = cmap.readUInt16BE(offset + 6) / 2;
      const endBase = offset + 14;
      const startBase = endBase + segCount * 2 + 2;
      const deltaBase = startBase + segCount * 2;
      const rangeBase = deltaBase + segCount * 2;
      for (let s = 0; s < segCount; s++) {
        const end = cmap.readUInt16BE(endBase + s * 2);
        const start = cmap.readUInt16BE(startBase + s * 2);
        const delta = cmap.readInt16BE(deltaBase + s * 2);
        const rangeOffset = cmap.readUInt16BE(rangeBase + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (rangeOffset === 0) {
            glyph = (c + delta) & 0xffff;
          } else {
            const raw = cmap.readUInt16BE(rangeBase + s * 2 + rangeOffset + (c - start) * 2);
            glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (glyph !== 0 && !map.has(c)) map.set(c, glyph);
        }
      }
    }
  }
  return map;
}

/** Glyph names of a post table version 2.0 that are stored in the table (indices 258 and up). */
export function readPostCustomNames(tables: Map<string, Buffer>): Map<number, string> {
  const post = requireTable(tables, 'post');
  const names = new Map<number, string>();
  if (post.readUInt32BE(0) !== 0x00020000) throw new Error('post table is not version 2.0');
  const numGlyphs = post.readUInt16BE(32);
  const stringsStart = 34 + numGlyphs * 2;
  const strings: string[] = [];
  for (let p = stringsStart; p < post.length; ) {
    const length = post[p];
    strings.push(post.toString('latin1', p + 1, p + 1 + length));
    p += 1 + length;
  }
  for (let g = 0; g < numGlyphs; g++) {
    const index = post.readUInt16BE(34 + g * 2);
    if (index >= 258) names.set(g, strings[index - 258]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Cmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['Q', number, number, number, number]
  | ['C', number, number, number, number, number, number];

const CURVE_SAMPLES = 96;
const RESAMPLE_STEP = 3;

function sampleQuadratic(a: Pt, c: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    });
  }
  return out;
}

export function sampleCubic(a: Pt, c1: Pt, c2: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

/** Flattens a TrueType contour (implied on-curve midpoints between consecutive off-curve points). */
export function flattenTrueType(points: TtPoint[]): Pt[] {
  const expanded: TtPoint[] = [];
  points.forEach((cur, i) => {
    const next = points[(i + 1) % points.length];
    expanded.push(cur);
    if (!cur.on && !next.on) expanded.push({ x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2, on: true });
  });
  const firstOn = expanded.findIndex((p) => p.on);
  if (firstOn < 0) throw new Error('contour has no on-curve point');
  const ring = [...expanded.slice(firstOn), ...expanded.slice(0, firstOn)];
  const poly: Pt[] = [{ x: ring[0].x, y: ring[0].y }];
  let i = 1;
  while (i <= ring.length) {
    const point = ring[i % ring.length];
    const prev = poly[poly.length - 1];
    if (point.on) {
      poly.push({ x: point.x, y: point.y });
      i += 1;
    } else {
      const end = ring[(i + 1) % ring.length];
      poly.push(...sampleQuadratic(prev, point, end));
      i += 2;
    }
  }
  poly.pop(); // the loop returns to the start point
  return poly;
}

/** Flattens hand-written path commands (one closed contour) into a polygon. */
export function flattenCommands(contour: Cmd[]): Pt[] {
  const poly: Pt[] = [];
  for (const cmd of contour) {
    if (cmd[0] === 'M' || cmd[0] === 'L') {
      poly.push({ x: cmd[1], y: cmd[2] });
    } else if (cmd[0] === 'Q') {
      poly.push(...sampleQuadratic(poly[poly.length - 1], { x: cmd[1], y: cmd[2] }, { x: cmd[3], y: cmd[4] }));
    } else {
      poly.push(
        ...sampleCubic(
          poly[poly.length - 1],
          { x: cmd[1], y: cmd[2] },
          { x: cmd[3], y: cmd[4] },
          { x: cmd[5], y: cmd[6] }
        )
      );
    }
  }
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (poly.length > 1 && first.x === last.x && first.y === last.y) poly.pop();
  return poly;
}

/** Shoelace area: positive for counter-clockwise polygons in a y-up coordinate system. */
export function signedArea(poly: Pt[]): number {
  let sum = 0;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  });
  return sum / 2;
}

function resample(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / RESAMPLE_STEP));
    for (let s = 0; s < steps; s++) {
      out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
    }
  });
  return out;
}

function distanceToPolygon(pt: Pt, poly: Pt[]): number {
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)));
  });
  return best;
}

/** Two-sided Hausdorff distance between two closed polygons. */
export function hausdorff(a: Pt[], b: Pt[]): number {
  const forward = Math.max(...resample(a).map((pt) => distanceToPolygon(pt, b)));
  const backward = Math.max(...resample(b).map((pt) => distanceToPolygon(pt, a)));
  return Math.max(forward, backward);
}

// ---------------------------------------------------------------------------
// CFF reader and Type 2 charstring decoder (Adobe TN 5176 / 5177)
// ---------------------------------------------------------------------------

export interface CffIndex {
  items: Buffer[];
  end: number;
}

export function readCffIndex(cff: Buffer, offset: number): CffIndex {
  const count = cff.readUInt16BE(offset);
  if (count === 0) return { items: [], end: offset + 2 };
  const offSize = cff[offset + 2];
  if (offSize < 1 || offSize > 4) throw new Error(`INDEX offSize ${offSize} is out of range`);
  const offsetAt = (i: number): number => {
    let value = 0;
    for (let b = 0; b < offSize; b++) value = value * 256 + cff[offset + 3 + i * offSize + b];
    return value;
  };
  const dataStart = offset + 3 + (count + 1) * offSize - 1;
  const items: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const from = offsetAt(i);
    const to = offsetAt(i + 1);
    if (from < 1 || to < from) throw new Error('INDEX offsets are not ascending');
    if (dataStart + to > cff.length) throw new Error('INDEX data runs past the end of the CFF table');
    items.push(cff.subarray(dataStart + from, dataStart + to));
  }
  return { items, end: dataStart + offsetAt(count) };
}

export type DictValues = Map<string, number[]>;

/** Reads a DICT; keys are the operator number, or "12.n" for escaped operators. */
export function readCffDict(data: Buffer): DictValues {
  const dict: DictValues = new Map();
  let operands: number[] = [];
  let p = 0;
  while (p < data.length) {
    const b0 = data[p++];
    if (b0 <= 21) {
      let key = String(b0);
      if (b0 === 12) key = `12.${data[p++]}`;
      dict.set(key, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(data.readInt16BE(p));
      p += 2;
    } else if (b0 === 29) {
      operands.push(data.readInt32BE(p));
      p += 4;
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + data[p++] + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - data[p++] - 108);
    } else {
      throw new Error(`unsupported DICT byte ${b0}`);
    }
  }
  if (operands.length > 0) throw new Error('DICT ends with operands and no operator');
  return dict;
}

export interface CharstringSegment {
  kind: 'line' | 'curve';
  c1?: Pt;
  c2?: Pt;
  to: Pt;
}

export interface CharstringContour {
  start: Pt;
  segments: CharstringSegment[];
}

export interface DecodedCharstring {
  width: number;
  contours: CharstringContour[];
  maxStackDepth: number;
  bytesConsumed: number;
}

const OP_RMOVETO = 21;
const OP_HMOVETO = 22;
const OP_VMOVETO = 4;
const OP_RLINETO = 5;
const OP_RRCURVETO = 8;
const OP_ENDCHAR = 14;
const CFF_STACK_LIMIT = 48;

/**
 * Decodes a charstring made of numbers, rmoveto, hmoveto, vmoveto, rlineto, rrcurveto and endchar.
 * Any other operator makes the decoder throw, so a charstring that uses features this decoder does
 * not model cannot pass unnoticed.
 */
export function decodeCharstring(code: Buffer, defaultWidthX: number, nominalWidthX: number): DecodedCharstring {
  const stack: number[] = [];
  const contours: CharstringContour[] = [];
  let x = 0;
  let y = 0;
  let width = defaultWidthX;
  let firstStackClearing = true;
  let maxStackDepth = 0;
  let p = 0;
  const push = (value: number): void => {
    stack.push(value);
    maxStackDepth = Math.max(maxStackDepth, stack.length);
    if (stack.length > CFF_STACK_LIMIT) throw new Error('charstring overflows the 48 entry argument stack');
  };
  const takeWidth = (expectedArgs: number): void => {
    if (!firstStackClearing) return;
    firstStackClearing = false;
    if (stack.length === expectedArgs + 1) {
      width = nominalWidthX + (stack.shift() as number);
    } else if (stack.length !== expectedArgs) {
      throw new Error(`first stack-clearing operator got ${stack.length} operands, expected ${expectedArgs} (+ width)`);
    }
  };
  const moveTo = (nx: number, ny: number): void => {
    x = nx;
    y = ny;
    contours.push({ start: { x, y }, segments: [] });
  };
  const current = (): CharstringContour => {
    const contour = contours[contours.length - 1];
    if (contour === undefined) throw new Error('drawing operator before the first moveto');
    return contour;
  };
  for (;;) {
    if (p >= code.length) throw new Error('charstring ends without endchar');
    const b0 = code[p++];
    if (b0 >= 32 && b0 <= 246) {
      push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      push((b0 - 247) * 256 + code[p++] + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      push(-(b0 - 251) * 256 - code[p++] - 108);
    } else if (b0 === 28) {
      push(code.readInt16BE(p));
      p += 2;
    } else if (b0 === 255) {
      push(code.readInt32BE(p) / 65536);
      p += 4;
    } else if (b0 === OP_RMOVETO) {
      takeWidth(2);
      moveTo(x + stack[0], y + stack[1]);
      stack.length = 0;
    } else if (b0 === OP_HMOVETO) {
      takeWidth(1);
      moveTo(x + stack[0], y);
      stack.length = 0;
    } else if (b0 === OP_VMOVETO) {
      takeWidth(1);
      moveTo(x, y + stack[0]);
      stack.length = 0;
    } else if (b0 === OP_RLINETO) {
      if (stack.length === 0 || stack.length % 2 !== 0) throw new Error('rlineto needs pairs of operands');
      for (let i = 0; i < stack.length; i += 2) {
        x += stack[i];
        y += stack[i + 1];
        current().segments.push({ kind: 'line', to: { x, y } });
      }
      stack.length = 0;
    } else if (b0 === OP_RRCURVETO) {
      if (stack.length === 0 || stack.length % 6 !== 0) throw new Error('rrcurveto needs groups of six operands');
      for (let i = 0; i < stack.length; i += 6) {
        const c1 = { x: x + stack[i], y: y + stack[i + 1] };
        const c2 = { x: c1.x + stack[i + 2], y: c1.y + stack[i + 3] };
        const to = { x: c2.x + stack[i + 4], y: c2.y + stack[i + 5] };
        current().segments.push({ kind: 'curve', c1, c2, to });
        x = to.x;
        y = to.y;
      }
      stack.length = 0;
    } else if (b0 === OP_ENDCHAR) {
      takeWidth(0);
      if (stack.length !== 0) throw new Error('endchar with stray operands');
      return { width, contours, maxStackDepth, bytesConsumed: p };
    } else {
      throw new Error(`charstring operator ${b0} is not modelled by the test decoder`);
    }
  }
}

export interface DecodedCff {
  fontName: string;
  fontBBox: number[] | null;
  numGlyphs: number;
  defaultWidthX: number;
  nominalWidthX: number;
  /** SID of every glyph in charset order, glyph 0 (.notdef) first. */
  charsetSids: number[];
  strings: string[];
  charstrings: Buffer[];
  privateExtent: { offset: number; size: number };
  glyphs: DecodedCharstring[];
}

const CFF_STANDARD_STRING_COUNT = 391;

export function decodeCff(cff: Buffer): DecodedCff {
  if (cff[0] !== 1) throw new Error(`CFF major version ${cff[0]} is not 1`);
  const nameIndex = readCffIndex(cff, cff[2]);
  const topDictIndex = readCffIndex(cff, nameIndex.end);
  const stringIndex = readCffIndex(cff, topDictIndex.end);
  const globalSubrs = readCffIndex(cff, stringIndex.end);
  if (globalSubrs.items.length !== 0) throw new Error('test decoder does not model global subroutines');
  const top = readCffDict(topDictIndex.items[0]);
  const charStringsOffset = top.get('17')?.[0];
  const charsetOffset = top.get('15')?.[0];
  const privateOperands = top.get('18');
  if (charStringsOffset === undefined || charsetOffset === undefined || privateOperands === undefined) {
    throw new Error('Top DICT lacks CharStrings, charset or Private');
  }
  const charstrings = readCffIndex(cff, charStringsOffset).items;
  const [privateSize, privateOffset] = privateOperands;
  if (privateOffset + privateSize > cff.length) {
    throw new Error(`Private DICT (${privateOffset}+${privateSize}) runs past the end of the ${cff.length} byte CFF table`);
  }
  const priv = readCffDict(cff.subarray(privateOffset, privateOffset + privateSize));
  if (priv.has('19')) throw new Error('test decoder does not model local subroutines');
  const defaultWidthX = priv.get('20')?.[0] ?? 0;
  const nominalWidthX = priv.get('21')?.[0] ?? 0;

  if (cff[charsetOffset] !== 0) throw new Error(`charset format ${cff[charsetOffset]} is not modelled`);
  const charsetSids = [0];
  for (let g = 1; g < charstrings.length; g++) charsetSids.push(cff.readUInt16BE(charsetOffset + 1 + (g - 1) * 2));

  const glyphs = charstrings.map((code) => decodeCharstring(code, defaultWidthX, nominalWidthX));
  glyphs.forEach((glyph, g) => {
    if (glyph.bytesConsumed !== charstrings[g].length) throw new Error(`glyph ${g} has bytes after endchar`);
  });
  return {
    fontName: nameIndex.items[0].toString('latin1'),
    fontBBox: top.get('5') ?? null,
    numGlyphs: charstrings.length,
    defaultWidthX,
    nominalWidthX,
    charsetSids,
    strings: stringIndex.items.map((item) => item.toString('latin1')),
    charstrings,
    privateExtent: { offset: privateOffset, size: privateSize },
    glyphs,
  };
}

/** Name of a glyph from the charset: custom strings only (standard strings are not modelled). */
export function cffGlyphName(cff: DecodedCff, glyphId: number): string {
  const sid = cff.charsetSids[glyphId];
  if (glyphId === 0) return '.notdef';
  if (sid < CFF_STANDARD_STRING_COUNT) throw new Error(`glyph ${glyphId} is named by standard string ${sid}`);
  return cff.strings[sid - CFF_STANDARD_STRING_COUNT];
}

/** Flattens a decoded charstring contour into a polygon, sampling cubic segments. */
export function flattenCharstringContour(contour: CharstringContour): Pt[] {
  const poly: Pt[] = [contour.start];
  for (const segment of contour.segments) {
    if (segment.kind === 'line') {
      poly.push(segment.to);
    } else {
      poly.push(...sampleCubic(poly[poly.length - 1], segment.c1 as Pt, segment.c2 as Pt, segment.to));
    }
  }
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (poly.length > 1 && first.x === last.x && first.y === last.y) poly.pop();
  return poly;
}

// ---------------------------------------------------------------------------
// External oracles
// ---------------------------------------------------------------------------

export function fcScan(font: Buffer, extension: string): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-oracle-'));
  try {
    const file = path.join(dir, `probe.${extension}`);
    fs.writeFileSync(file, font);
    const out = execFileSync(
      requireBinary(FC_SCAN_BIN, 'fc-scan'),
      ['--format', '%{family}\t%{style}\t%{fullname}\t%{postscriptname}\t%{charset}\t%{fontformat}\n', file],
      { encoding: 'utf8' }
    );
    const [family, style, fullname, postscriptname, charset, fontformat] = out.trim().split('\t');
    return { family, style, fullname, postscriptname, charset, fontformat };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PNG_RENDER_SIZE = 96;
const PNG_POINT_SIZE = 72;
const PNG_ORIGIN_X = 4;
const PNG_BASELINE_Y = 80;
export const INK_THRESHOLD = 128;

/** Renders one character with FreeType through ImageMagick into an 8-bit grayscale buffer. */
export function renderGlyph(fontFile: string, char: string): Buffer {
  const pgm = execFileSync(
    requireBinary(CONVERT_BIN, 'convert'),
    [
      '-size', `${PNG_RENDER_SIZE}x${PNG_RENDER_SIZE}`, 'xc:white',
      '-font', fontFile,
      '-pointsize', String(PNG_POINT_SIZE),
      '-fill', 'black',
      // Without gravity the position is the glyph origin on the baseline, so the placement does not
      // depend on how each format reports its glyph bounding box.
      '-annotate', `+${PNG_ORIGIN_X}+${PNG_BASELINE_Y}`, char,
      '-depth', '8',
      'pgm:-',
    ],
    { maxBuffer: 1024 * 1024 }
  );
  // P5 header: "P5\nW H\n255\n"
  let newlines = 0;
  let at = 0;
  while (newlines < 3) {
    if (pgm[at++] === 0x0a) newlines++;
  }
  return pgm.subarray(at);
}

export function inkCount(pixels: Buffer): number {
  return pixels.filter((v) => v < INK_THRESHOLD).length;
}

/** Intersection over union of the ink of two renders of equal size. */
export function inkOverlap(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) throw new Error('renders differ in size');
  let union = 0;
  let intersection = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] < INK_THRESHOLD;
    const inB = b[i] < INK_THRESHOLD;
    if (inA || inB) union++;
    if (inA && inB) intersection++;
  }
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Container readers (W3C WOFF 1.0 and WOFF2 recommendations, EOT 2.1 submission)
// ---------------------------------------------------------------------------

const WOFF_HEADER_SIZE = 44;
const WOFF_DIRECTORY_ENTRY_SIZE = 20;

/** Returns the sfnt tables stored in a WOFF 1.0 file. */
export function unwrapWoff(woff: Buffer): Map<string, Buffer> {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 file');
  const numTables = woff.readUInt16BE(12);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < numTables; i++) {
    const base = WOFF_HEADER_SIZE + i * WOFF_DIRECTORY_ENTRY_SIZE;
    const tag = woff.toString('latin1', base, base + 4);
    const offset = woff.readUInt32BE(base + 4);
    const compLength = woff.readUInt32BE(base + 8);
    const origLength = woff.readUInt32BE(base + 12);
    const stored = woff.subarray(offset, offset + compLength);
    const table = compLength < origLength ? zlibInflate(stored) : Buffer.from(stored);
    if (table.length !== origLength) throw new Error(`table ${tag} has the wrong length`);
    tables.set(tag, table);
  }
  return tables;
}

// Known table tags by index, WOFF2 recommendation section 5.1
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE',
  'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt',
  'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
  'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];
const WOFF2_HEADER_SIZE = 48;
const WOFF2_CUSTOM_TAG_INDEX = 63;
const WOFF2_TRANSFORM_SHIFT = 6;
const WOFF2_NULL_TRANSFORM = 3;

function readBase128(data: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = data[at + i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error('UIntBase128 is longer than five bytes');
}

/**
 * Returns the sfnt tables stored in a WOFF2 file. Only tables without a transform are supported:
 * a transformed glyf, loca or hmtx makes the reader throw rather than guess.
 */
export function unwrapWoff2(woff2: Buffer): Map<string, Buffer> {
  if (woff2.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = woff2.readUInt16BE(12);
  const compressedSize = woff2.readUInt32BE(20);
  let at = WOFF2_HEADER_SIZE;
  const entries: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = woff2[at++];
    const index = flags & 0x3f;
    let tag: string;
    if (index === WOFF2_CUSTOM_TAG_INDEX) {
      tag = woff2.toString('latin1', at, at + 4);
      at += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[index];
    }
    const transform = flags >> WOFF2_TRANSFORM_SHIFT;
    const orig = readBase128(woff2, at);
    at = orig.next;
    const isGlyfOrLoca = tag === 'glyf' || tag === 'loca';
    const transformed = isGlyfOrLoca ? transform !== WOFF2_NULL_TRANSFORM : transform !== 0;
    if (transformed) throw new Error(`table ${tag} uses WOFF2 transform ${transform}, which the test reader does not model`);
    entries.push({ tag, length: orig.value });
  }
  const stream = brotliDecompress(woff2.subarray(at, at + compressedSize));
  const tables = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of entries) {
    tables.set(entry.tag, stream.subarray(offset, offset + entry.length));
    offset += entry.length;
  }
  if (offset !== stream.length) throw new Error('WOFF2 table lengths do not add up to the decompressed stream');
  return tables;
}

/** Returns the embedded sfnt of an EOT file (FontDataSize bytes at the end of the file). */
export function unwrapEot(eot: Buffer): Buffer {
  const fontDataSize = eot.readUInt32LE(4);
  if (eot.readUInt16LE(34) !== 0x504c) throw new Error('missing EOT magic number');
  return eot.subarray(eot.length - fontDataSize);
}

/** Runs `body` with the font written to a temporary file of the given extension. */
export function withFontFile<T>(font: Buffer, extension: string, body: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-render-'));
  try {
    const file = path.join(dir, `probe.${extension}`);
    fs.writeFileSync(file, font);
    return body(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
