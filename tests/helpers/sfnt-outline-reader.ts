/**
 * Independent SFNT reader for tests: table directory, checksums, cmap, post, name, hmtx, glyf
 * outlines and CFF Type 2 charstrings, written from the OpenType and CFF specifications. It imports
 * nothing from src, so conversion output is checked by code the engine never shares.
 */

export type Polyline = Array<[number, number]>;

export interface SfntEntry {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

export interface SfntFile {
  version: number;
  entries: SfntEntry[];
  raw: Buffer;
  table(tag: string): Buffer;
  has(tag: string): boolean;
}

const HEAD_MAGIC = 0x5f0f3cf5;
const FILE_CHECKSUM_TARGET = 0xb1b0afba;
const CURVE_STEPS = 24;
const CFF_STANDARD_STRING_COUNT = 391;

export function sumUInt32(data: Buffer): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word = Buffer.alloc(4);
    data.copy(word, 0, i, Math.min(i + 4, data.length));
    sum = (sum + word.readUInt32BE(0)) >>> 0;
  }
  return sum;
}

export function readSfntFile(raw: Buffer): SfntFile {
  const numTables = raw.readUInt16BE(4);
  const entries: SfntEntry[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    entries.push({
      tag: raw.toString('latin1', at, at + 4),
      checksum: raw.readUInt32BE(at + 4),
      offset: raw.readUInt32BE(at + 8),
      length: raw.readUInt32BE(at + 12),
    });
  }
  const find = (tag: string): SfntEntry => {
    const entry = entries.find((e) => e.tag === tag);
    if (!entry) throw new Error(`table ${tag} is missing`);
    return entry;
  };
  return {
    version: raw.readUInt32BE(0),
    entries,
    raw,
    has: (tag) => entries.some((e) => e.tag === tag),
    table: (tag) => {
      const entry = find(tag);
      return raw.subarray(entry.offset, entry.offset + entry.length);
    },
  };
}

/** Lists every structural problem in the table directory and the three checksum layers. */
export function checkDirectoryIntegrity(file: SfntFile): string[] {
  const problems: string[] = [];
  const tags = file.entries.map((e) => e.tag);
  const sortedTags = [...tags].sort((a, b) => Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1')));
  if (tags.join('|') !== sortedTags.join('|')) problems.push(`directory not sorted: ${tags.join(',')}`);

  const numTables = file.entries.length;
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = 16 * 2 ** entrySelector;
  if (file.raw.readUInt16BE(6) !== searchRange) problems.push('searchRange');
  if (file.raw.readUInt16BE(8) !== entrySelector) problems.push('entrySelector');
  if (file.raw.readUInt16BE(10) !== numTables * 16 - searchRange) problems.push('rangeShift');

  for (const entry of file.entries) {
    const data = Buffer.from(file.raw.subarray(entry.offset, entry.offset + entry.length));
    if (entry.offset % 4 !== 0) problems.push(`${entry.tag} offset not 4-byte aligned`);
    if (entry.tag === 'head') data.writeUInt32BE(0, 8);
    if (sumUInt32(data) !== entry.checksum) problems.push(`${entry.tag} checksum`);
  }
  const head = file.table('head');
  if (head.readUInt32BE(12) !== HEAD_MAGIC) problems.push('head magic');
  if (sumUInt32(file.raw) !== FILE_CHECKSUM_TARGET) problems.push('head.checkSumAdjustment');
  return problems;
}

// ---------------------------------------------------------------------------------------------
// cmap, post, name, hmtx
// ---------------------------------------------------------------------------------------------

export function readCmapSubtables(cmap: Buffer): Array<{ platform: number; encoding: number; map: Map<number, number> }> {
  const count = cmap.readUInt16BE(2);
  const result: Array<{ platform: number; encoding: number; map: Map<number, number> }> = [];
  for (let i = 0; i < count; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const offset = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(offset);
    const map = new Map<number, number>();
    if (format === 4) {
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
        for (let code = start; code <= end && code !== 0xffff; code++) {
          let gid: number;
          if (rangeOffset === 0) {
            gid = (code + delta) & 0xffff;
          } else {
            const at = rangeBase + s * 2 + rangeOffset + (code - start) * 2;
            const raw = cmap.readUInt16BE(at);
            gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (gid !== 0) map.set(code, gid);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(offset + 12);
      for (let g = 0; g < groups; g++) {
        const at = offset + 16 + g * 12;
        const start = cmap.readUInt32BE(at);
        const end = cmap.readUInt32BE(at + 4);
        const firstGid = cmap.readUInt32BE(at + 8);
        for (let code = start; code <= end; code++) map.set(code, firstGid + code - start);
      }
    } else {
      throw new Error(`unsupported cmap format ${format}`);
    }
    result.push({ platform, encoding, map });
  }
  return result;
}

export function readPostGlyphNames(post: Buffer): string[] {
  if (post.readUInt32BE(0) !== 0x00020000) throw new Error('post is not format 2.0');
  const count = post.readUInt16BE(32);
  const indexes: number[] = [];
  for (let i = 0; i < count; i++) indexes.push(post.readUInt16BE(34 + i * 2));
  const custom: string[] = [];
  let at = 34 + count * 2;
  while (at < post.length) {
    const length = post[at];
    custom.push(post.toString('latin1', at + 1, at + 1 + length));
    at += 1 + length;
  }
  return indexes.map((index) => (index === 0 ? '.notdef' : custom[index - 258]));
}

export function readNameRecords(name: Buffer): Array<{ platform: number; id: number; text: string }> {
  const count = name.readUInt16BE(2);
  const storage = name.readUInt16BE(4);
  const records: Array<{ platform: number; id: number; text: string }> = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at);
    const length = name.readUInt16BE(at + 8);
    const offset = name.readUInt16BE(at + 10);
    const data = Buffer.from(name.subarray(storage + offset, storage + offset + length));
    const text = platform === 3 ? data.swap16().toString('utf16le') : data.toString('latin1');
    records.push({ platform, id: name.readUInt16BE(at + 6), text });
  }
  return records;
}

export function readHmtx(hmtx: Buffer, numberOfHMetrics: number): Array<{ advance: number; lsb: number }> {
  const metrics: Array<{ advance: number; lsb: number }> = [];
  for (let i = 0; i < numberOfHMetrics; i++) {
    metrics.push({ advance: hmtx.readUInt16BE(i * 4), lsb: hmtx.readInt16BE(i * 4 + 2) });
  }
  return metrics;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

function quadraticPoints(p0: [number, number], c: [number, number], p1: [number, number]): Polyline {
  const out: Polyline = [];
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

export function cubicPoints(p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number]): Polyline {
  const out: Polyline = [];
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

/** Signed shoelace area (positive when the polyline runs counter-clockwise with y pointing up). */
export function signedArea(poly: Polyline): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

export function outlineBounds(outline: Polyline[]): [number, number, number, number] | null {
  let bounds: [number, number, number, number] | null = null;
  for (const poly of outline) {
    for (const [x, y] of poly) {
      bounds = bounds === null ? [x, y, x, y] : [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)];
    }
  }
  return bounds;
}

// ---------------------------------------------------------------------------------------------
// glyf
// ---------------------------------------------------------------------------------------------

interface TtPoint {
  x: number;
  y: number;
  on: boolean;
}

function contourToPolyline(points: TtPoint[]): Polyline {
  let startIndex = points.findIndex((p) => p.on);
  let start: [number, number];
  let ordered: TtPoint[];
  if (startIndex >= 0) {
    start = [points[startIndex].x, points[startIndex].y];
    ordered = [...points.slice(startIndex + 1), ...points.slice(0, startIndex)];
  } else {
    startIndex = 0;
    start = [(points[0].x + points[points.length - 1].x) / 2, (points[0].y + points[points.length - 1].y) / 2];
    ordered = points;
  }
  const poly: Polyline = [start];
  let current = start;
  let pendingOff: [number, number] | null = null;
  const closeAt = (target: [number, number]): void => {
    if (pendingOff !== null) {
      poly.push(...quadraticPoints(current, pendingOff, target));
      pendingOff = null;
    } else {
      poly.push(target);
    }
    current = target;
  };
  for (const p of ordered) {
    if (p.on) {
      closeAt([p.x, p.y]);
    } else if (pendingOff === null) {
      pendingOff = [p.x, p.y];
    } else {
      const mid: [number, number] = [(pendingOff[0] + p.x) / 2, (pendingOff[1] + p.y) / 2];
      closeAt(mid);
      pendingOff = [p.x, p.y];
    }
  }
  closeAt(start);
  poly.pop();
  return poly;
}

export function readTrueTypeOutlines(file: SfntFile): Polyline[][] {
  const head = file.table('head');
  const maxp = file.table('maxp');
  const loca = file.table('loca');
  const glyf = file.table('glyf');
  const numGlyphs = maxp.readUInt16BE(4);
  const longOffsets = head.readInt16BE(50) === 1;
  const offsetOf = (gid: number): number => (longOffsets ? loca.readUInt32BE(gid * 4) : loca.readUInt16BE(gid * 2) * 2);
  const outlines: Polyline[][] = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    const start = offsetOf(gid);
    const end = offsetOf(gid + 1);
    if (end === start) {
      outlines.push([]);
      continue;
    }
    const contourCount = glyf.readInt16BE(start);
    if (contourCount < 0) throw new Error('composite glyphs are not expected');
    const endPts: number[] = [];
    for (let c = 0; c < contourCount; c++) endPts.push(glyf.readUInt16BE(start + 10 + c * 2));
    const pointCount = endPts.length === 0 ? 0 : endPts[endPts.length - 1] + 1;
    let at = start + 10 + contourCount * 2;
    const instructionLength = glyf.readUInt16BE(at);
    at += 2 + instructionLength;
    const flags: number[] = [];
    while (flags.length < pointCount) {
      const flag = glyf[at++];
      flags.push(flag);
      if (flag & 0x08) {
        const repeat = glyf[at++];
        for (let r = 0; r < repeat; r++) flags.push(flag);
      }
    }
    const xs: number[] = [];
    let x = 0;
    for (const flag of flags) {
      if (flag & 0x02) {
        const dx = glyf[at++];
        x += flag & 0x10 ? dx : -dx;
      } else if (!(flag & 0x10)) {
        x += glyf.readInt16BE(at);
        at += 2;
      }
      xs.push(x);
    }
    const ys: number[] = [];
    let y = 0;
    for (const flag of flags) {
      if (flag & 0x04) {
        const dy = glyf[at++];
        y += flag & 0x20 ? dy : -dy;
      } else if (!(flag & 0x20)) {
        y += glyf.readInt16BE(at);
        at += 2;
      }
      ys.push(y);
    }
    const polys: Polyline[] = [];
    let first = 0;
    for (const last of endPts) {
      const points: TtPoint[] = [];
      for (let i = first; i <= last; i++) points.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
      polys.push(contourToPolyline(points));
      first = last + 1;
    }
    outlines.push(polys);
  }
  return outlines;
}

// ---------------------------------------------------------------------------------------------
// CFF
// ---------------------------------------------------------------------------------------------

interface CffIndex {
  items: Buffer[];
  end: number;
}

function readCffIndex(cff: Buffer, offset: number): CffIndex {
  const count = cff.readUInt16BE(offset);
  if (count === 0) return { items: [], end: offset + 2 };
  const offSize = cff[offset + 2];
  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) {
    let value = 0;
    for (let b = 0; b < offSize; b++) value = value * 256 + cff[offset + 3 + i * offSize + b];
    offsets.push(value);
  }
  const base = offset + 3 + (count + 1) * offSize - 1;
  const items = offsets.slice(0, -1).map((o, i) => cff.subarray(base + o, base + offsets[i + 1]));
  return { items, end: base + offsets[count] };
}

function realNibbleText(nibble: number): string {
  if (nibble <= 9) return String(nibble);
  if (nibble === 10) return '.';
  if (nibble === 14) return '-';
  return '';
}

function readCffDict(data: Buffer): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b0 = data[i++];
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + data[i++] : b0;
      dict.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(data.readInt16BE(i));
      i += 2;
    } else if (b0 === 29) {
      operands.push(data.readInt32BE(i));
      i += 4;
    } else if (b0 === 30) {
      let text = '';
      for (let done = false; !done; ) {
        const byte = data[i++];
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble === 15) {
            done = true;
            break;
          }
          text += realNibbleText(nibble);
        }
      }
      operands.push(Number.parseFloat(text));
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + data[i++] + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - data[i++] - 108);
    } else {
      throw new Error(`bad CFF DICT byte ${b0}`);
    }
  }
  return dict;
}

function runType2CharString(code: Buffer, defaultWidth: number, nominalWidth: number): { width: number; outline: Polyline[] } {
  const stack: number[] = [];
  const outline: Polyline[] = [];
  let current: Polyline = [];
  let x = 0;
  let y = 0;
  let width = defaultWidth;
  let widthPending = true;
  const startPath = (nx: number, ny: number): void => {
    if (current.length > 0) outline.push(current);
    current = [[nx, ny]];
    x = nx;
    y = ny;
  };
  const takeWidth = (expected: number): void => {
    if (widthPending && stack.length === expected + 1) width = nominalWidth + (stack.shift() as number);
    widthPending = false;
  };

  let i = 0;
  while (i < code.length) {
    const b0 = code[i++];
    if (b0 === 28) {
      stack.push(code.readInt16BE(i));
      i += 2;
    } else if (b0 >= 32 && b0 <= 246) {
      stack.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      stack.push((b0 - 247) * 256 + code[i++] + 108);
    } else if (b0 >= 251 && b0 <= 254) {
      stack.push(-(b0 - 251) * 256 - code[i++] - 108);
    } else if (b0 === 255) {
      stack.push(code.readInt32BE(i) / 65536);
      i += 4;
    } else if (b0 === 21) {
      takeWidth(2);
      startPath(x + stack[0], y + stack[1]);
      stack.length = 0;
    } else if (b0 === 22) {
      takeWidth(1);
      startPath(x + stack[0], y);
      stack.length = 0;
    } else if (b0 === 4) {
      takeWidth(1);
      startPath(x, y + stack[0]);
      stack.length = 0;
    } else if (b0 === 5) {
      for (let k = 0; k + 1 < stack.length; k += 2) {
        x += stack[k];
        y += stack[k + 1];
        current.push([x, y]);
      }
      stack.length = 0;
    } else if (b0 === 6 || b0 === 7) {
      let horizontal = b0 === 6;
      for (const delta of stack) {
        if (horizontal) x += delta;
        else y += delta;
        current.push([x, y]);
        horizontal = !horizontal;
      }
      stack.length = 0;
    } else if (b0 === 8) {
      for (let k = 0; k + 5 < stack.length; k += 6) {
        const c1: [number, number] = [x + stack[k], y + stack[k + 1]];
        const c2: [number, number] = [c1[0] + stack[k + 2], c1[1] + stack[k + 3]];
        const p1: [number, number] = [c2[0] + stack[k + 4], c2[1] + stack[k + 5]];
        current.push(...cubicPoints([x, y], c1, c2, p1));
        x = p1[0];
        y = p1[1];
      }
      stack.length = 0;
    } else if (b0 === 14) {
      takeWidth(0);
      if (current.length > 0) outline.push(current);
      return { width, outline };
    } else {
      throw new Error(`unsupported Type 2 operator ${b0}`);
    }
  }
  throw new Error('Type 2 charstring ended without endchar');
}

export interface CffFont {
  glyphNames: string[];
  widths: number[];
  outlines: Polyline[][];
  fontMatrix: number[] | null;
}

export function readCffFont(cff: Buffer): CffFont {
  const hdrSize = cff[2];
  const names = readCffIndex(cff, hdrSize);
  const topDicts = readCffIndex(cff, names.end);
  const strings = readCffIndex(cff, topDicts.end);
  const top = readCffDict(topDicts.items[0]);
  const charStrings = readCffIndex(cff, (top.get(17) as number[])[0]);
  const [privateSize, privateOffset] = top.get(18) as number[];
  const priv = readCffDict(cff.subarray(privateOffset, privateOffset + privateSize));
  const defaultWidth = priv.get(20)?.[0] ?? 0;
  const nominalWidth = priv.get(21)?.[0] ?? 0;

  const charsetOffset = (top.get(15) as number[])[0];
  if (cff[charsetOffset] !== 0) throw new Error('only charset format 0 is expected');
  const glyphNames = ['.notdef'];
  for (let g = 1; g < charStrings.items.length; g++) {
    const sid = cff.readUInt16BE(charsetOffset + 1 + (g - 1) * 2);
    if (sid < CFF_STANDARD_STRING_COUNT) throw new Error(`standard SID ${sid} is not expected`);
    glyphNames.push(strings.items[sid - CFF_STANDARD_STRING_COUNT].toString('latin1'));
  }
  const widths: number[] = [];
  const outlines: Polyline[][] = [];
  for (const code of charStrings.items) {
    const run = runType2CharString(code, defaultWidth, nominalWidth);
    widths.push(run.width);
    outlines.push(run.outline);
  }
  return { glyphNames, widths, outlines, fontMatrix: top.get(1207) ?? null };
}
