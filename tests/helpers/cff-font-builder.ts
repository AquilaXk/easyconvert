import { assembleSfnt, buildCmapTable, buildNameTable } from './mac-font-containers';

/**
 * Independent writer for CFF 1 fonts wrapped in OpenType ('OTTO') containers, authored from
 * Adobe Technical Notes #5176 (CFF) and #5177 (Type 2 charstrings) with no dependency on src/.
 * Used to build CFF-flavoured inputs and hostile variants of them.
 */

// ---------------------------------------------------------------------------
// Type 2 charstring assembler
// ---------------------------------------------------------------------------

const OPERATORS: Readonly<Record<string, number[]>> = {
  hstem: [1],
  vstem: [3],
  vmoveto: [4],
  rlineto: [5],
  hlineto: [6],
  vlineto: [7],
  rrcurveto: [8],
  callsubr: [10],
  return: [11],
  endchar: [14],
  hstemhm: [18],
  hintmask: [19],
  cntrmask: [20],
  rmoveto: [21],
  hmoveto: [22],
  vstemhm: [23],
  rcurveline: [24],
  rlinecurve: [25],
  vvcurveto: [26],
  hhcurveto: [27],
  callgsubr: [29],
  vhcurveto: [30],
  hvcurveto: [31],
  dotsection: [12, 0],
  and: [12, 3],
  or: [12, 4],
  not: [12, 5],
  abs: [12, 9],
  add: [12, 10],
  sub: [12, 11],
  div: [12, 12],
  neg: [12, 14],
  eq: [12, 15],
  drop: [12, 18],
  put: [12, 20],
  get: [12, 21],
  ifelse: [12, 22],
  random: [12, 23],
  mul: [12, 24],
  sqrt: [12, 26],
  dup: [12, 27],
  exch: [12, 28],
  index: [12, 29],
  roll: [12, 30],
  hflex: [12, 34],
  flex: [12, 35],
  hflex1: [12, 36],
  flex1: [12, 37],
};

function encodeCharstringNumber(value: number): number[] {
  if (!Number.isInteger(value)) {
    const fixed = Math.round(value * 65536);
    return [255, (fixed >>> 24) & 0xff, (fixed >>> 16) & 0xff, (fixed >>> 8) & 0xff, fixed & 0xff];
  }
  if (value >= -107 && value <= 107) return [value + 139];
  if (value >= 108 && value <= 1131) {
    const v = value - 108;
    return [247 + (v >> 8), v & 0xff];
  }
  if (value >= -1131 && value <= -108) {
    const v = -value - 108;
    return [251 + (v >> 8), v & 0xff];
  }
  return [28, (value >> 8) & 0xff, value & 0xff];
}

/** One charstring item: a number, an operator name, or raw bytes (hint masks, hostile data). */
export type CharstringItem = number | keyof typeof OPERATORS | Buffer;

/** Assembles a Type 2 charstring from numbers, operator names and raw byte runs. */
export function cs(...items: CharstringItem[]): Buffer {
  const bytes: number[] = [];
  for (const item of items) {
    if (typeof item === 'number') {
      bytes.push(...encodeCharstringNumber(item));
    } else if (typeof item === 'string') {
      const op = OPERATORS[item];
      if (!op) throw new Error(`unknown charstring operator ${item}`);
      bytes.push(...op);
    } else {
      bytes.push(...item);
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// CFF writer
// ---------------------------------------------------------------------------

const STANDARD_STRING_COUNT = 391;
const FIXED_INT_OPERAND = 29;

/** Standard string id of an ASCII character (space is SID 1 ... asciitilde is SID 95). */
export function sidForAscii(char: string): number {
  const code = char.charCodeAt(0);
  if (code < 32 || code > 126) throw new Error(`no standard SID for ${char}`);
  return code - 31;
}

function dictInt(value: number): number[] {
  return [FIXED_INT_OPERAND, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function dictReal(text: string): number[] {
  const nibbles: number[] = [];
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') nibbles.push(Number(ch));
    else if (ch === '.') nibbles.push(0xa);
    else if (ch === '-') nibbles.push(0xe);
    else if (ch === 'E') nibbles.push(0xb);
    else throw new Error(`bad real character ${ch}`);
  }
  nibbles.push(0xf);
  if (nibbles.length % 2 === 1) nibbles.push(0xf);
  const bytes: number[] = [30];
  for (let i = 0; i < nibbles.length; i += 2) bytes.push((nibbles[i] << 4) | nibbles[i + 1]);
  return bytes;
}

function buildIndex(items: Buffer[], offSize = 2): Buffer {
  if (items.length === 0) return Buffer.from([0, 0]);
  const header = Buffer.alloc(3 + (items.length + 1) * offSize);
  header.writeUInt16BE(items.length, 0);
  header[2] = offSize;
  let offset = 1;
  header.writeUIntBE(offset, 3, offSize);
  items.forEach((item, i) => {
    offset += item.length;
    header.writeUIntBE(offset, 3 + (i + 1) * offSize, offSize);
  });
  return Buffer.concat([header, ...items]);
}

export interface CffFdSpec {
  localSubrs?: Buffer[];
  defaultWidthX?: number;
  nominalWidthX?: number;
  /** FontMatrix real-number text, six entries, for example ['0.001', '0', '0', '0.001', '0', '0']. */
  fontMatrix?: string[];
}

export interface CffSpec extends CffFdSpec {
  fontName: string;
  /** Charstrings, glyph 0 (.notdef) first. */
  charstrings: Buffer[];
  /** SID (name-keyed) or CID (CID-keyed) of glyphs 1..n; defaults to 1..n. */
  charset?: number[];
  globalSubrs?: Buffer[];
  /** Custom strings, SID 391 onward. */
  strings?: string[];
  cid?: {
    registrySid: number;
    orderingSid: number;
    supplement: number;
    fds: CffFdSpec[];
    fdSelect: { format: 0 | 3; fdOfGlyph: number[] };
  };
}

/** Byte positions inside a built CFF table, for hostile tests that patch fields. */
export interface CffLayout {
  nameIndex: number;
  topDictIndex: number;
  stringIndex: number;
  globalSubrIndex: number;
  charStringsIndex: number;
  /** Position of the 4-byte CharStrings offset operand inside the Top DICT. */
  charStringsOperand: number;
  fdSelect: number;
  fdArray: number;
  privateDict: number;
}

function buildPrivate(fd: CffFdSpec): { dict: Buffer; subrs: Buffer | null } {
  const bytes: number[] = [
    ...dictInt(fd.defaultWidthX ?? 0),
    20,
    ...dictInt(fd.nominalWidthX ?? 0),
    21,
  ];
  let subrs: Buffer | null = null;
  if (fd.localSubrs && fd.localSubrs.length > 0) {
    subrs = buildIndex(fd.localSubrs);
    // Subrs offset is relative to the start of the Private DICT; the INDEX follows the DICT.
    bytes.push(...dictInt(bytes.length + 6), 19);
  }
  return { dict: Buffer.from(bytes), subrs };
}

/** Builds a CFF 1 table. All offsets use fixed-width operands so the Top DICT size is stable. */
export function buildCffWithLayout(spec: CffSpec): { cff: Buffer; layout: CffLayout } {
  const header = Buffer.from([1, 0, 4, 2]);
  const nameIndex = buildIndex([Buffer.from(spec.fontName, 'latin1')]);
  const stringIndex = buildIndex((spec.strings ?? []).map((s) => Buffer.from(s, 'latin1')));
  const globalSubrIndex = buildIndex(spec.globalSubrs ?? []);
  const numGlyphs = spec.charstrings.length;
  const sids = spec.charset ?? Array.from({ length: numGlyphs - 1 }, (_, i) => i + 1);
  const charset = Buffer.alloc(1 + sids.length * 2);
  sids.forEach((sid, i) => charset.writeUInt16BE(sid, 1 + i * 2));
  const charStringsIndex = buildIndex(spec.charstrings);

  const fdSpecs = spec.cid ? spec.cid.fds : [spec];
  const privates = fdSpecs.map(buildPrivate);
  const privateBlocks = privates.map((p) => Buffer.concat(p.subrs ? [p.dict, p.subrs] : [p.dict]));

  let fdSelect: Buffer = Buffer.alloc(0);
  if (spec.cid) {
    const { format, fdOfGlyph } = spec.cid.fdSelect;
    if (format === 0) {
      fdSelect = Buffer.from([0, ...fdOfGlyph]);
    } else {
      const ranges: Array<[number, number]> = [];
      fdOfGlyph.forEach((fd, g) => {
        if (ranges.length === 0 || ranges[ranges.length - 1][1] !== fd) ranges.push([g, fd]);
      });
      fdSelect = Buffer.alloc(3 + ranges.length * 3 + 2);
      fdSelect[0] = 3;
      fdSelect.writeUInt16BE(ranges.length, 1);
      ranges.forEach(([first, fd], i) => {
        fdSelect.writeUInt16BE(first, 3 + i * 3);
        fdSelect[5 + i * 3] = fd;
      });
      fdSelect.writeUInt16BE(fdOfGlyph.length, 3 + ranges.length * 3);
    }
  }

  const topDictBytes = (offsets: {
    charset: number;
    charStrings: number;
    fdSelect: number;
    fdArray: number;
    privateOffset: number;
  }): { bytes: Buffer; charStringsOperand: number } => {
    const out: number[] = [];
    let charStringsOperand = 0;
    if (spec.cid) {
      out.push(...dictInt(spec.cid.registrySid), ...dictInt(spec.cid.orderingSid), ...dictInt(spec.cid.supplement), 12, 30);
    }
    if (spec.fontMatrix) {
      for (const real of spec.fontMatrix) out.push(...dictReal(real));
      out.push(12, 7);
    }
    out.push(...dictInt(offsets.charset), 15);
    if (spec.cid) {
      out.push(...dictInt(offsets.fdSelect), 12, 37);
    }
    charStringsOperand = out.length + 1;
    out.push(...dictInt(offsets.charStrings), 17);
    if (spec.cid) {
      out.push(...dictInt(offsets.fdArray), 12, 36);
    } else {
      out.push(...dictInt(privates[0].dict.length), ...dictInt(offsets.privateOffset), 18);
    }
    return { bytes: Buffer.from(out), charStringsOperand };
  };

  const placeholder = topDictBytes({ charset: 0, charStrings: 0, fdSelect: 0, fdArray: 0, privateOffset: 0 });
  const topDictIndexSize = buildIndex([placeholder.bytes]).length;
  let cursor = header.length + nameIndex.length + topDictIndexSize + stringIndex.length + globalSubrIndex.length;
  const charsetOffset = cursor;
  cursor += charset.length;
  const fdSelectOffset = cursor;
  cursor += fdSelect.length;
  const charStringsOffset = cursor;
  cursor += charStringsIndex.length;

  let fdArray: Buffer = Buffer.alloc(0);
  let fdArrayOffset = 0;
  let privateOffset = cursor;
  const privateOffsets: number[] = [];
  if (spec.cid) {
    // FDArray comes before the Private DICTs; its size depends only on fixed-width operands.
    const fontDictFor = (i: number, offset: number): Buffer => {
      const fd = fdSpecs[i];
      const out: number[] = [];
      if (fd.fontMatrix) {
        for (const real of fd.fontMatrix) out.push(...dictReal(real));
        out.push(12, 7);
      }
      out.push(...dictInt(privates[i].dict.length), ...dictInt(offset), 18);
      return Buffer.from(out);
    };
    const sizing = buildIndex(fdSpecs.map((_, i) => fontDictFor(i, 0)));
    fdArrayOffset = cursor;
    privateOffset = cursor + sizing.length;
    let at = privateOffset;
    for (const block of privateBlocks) {
      privateOffsets.push(at);
      at += block.length;
    }
    fdArray = buildIndex(fdSpecs.map((_, i) => fontDictFor(i, privateOffsets[i])));
  } else {
    privateOffsets.push(privateOffset);
  }

  const topDict = topDictBytes({
    charset: charsetOffset,
    charStrings: charStringsOffset,
    fdSelect: fdSelectOffset,
    fdArray: fdArrayOffset,
    privateOffset,
  });
  const topDictIndex = buildIndex([topDict.bytes]);
  const cff = Buffer.concat([
    header,
    nameIndex,
    topDictIndex,
    stringIndex,
    globalSubrIndex,
    charset,
    fdSelect,
    charStringsIndex,
    fdArray,
    ...privateBlocks,
  ]);
  const topDictOffset = header.length + nameIndex.length;
  return {
    cff,
    layout: {
      nameIndex: header.length,
      topDictIndex: topDictOffset,
      stringIndex: topDictOffset + topDictIndex.length,
      globalSubrIndex: topDictOffset + topDictIndex.length + stringIndex.length,
      charStringsIndex: charStringsOffset,
      charStringsOperand: topDictOffset + 3 + 2 * 2 + topDict.charStringsOperand,
      fdSelect: fdSelectOffset,
      fdArray: fdArrayOffset,
      privateDict: privateOffsets[0],
    },
  };
}

export function buildCff(spec: CffSpec): Buffer {
  return buildCffWithLayout(spec).cff;
}

// ---------------------------------------------------------------------------
// OpenType wrapper
// ---------------------------------------------------------------------------

export interface OtfGlyph {
  charstring: Buffer;
  advance: number;
  /** Left side bearing recorded in hmtx; the outline's xMin. */
  lsb: number;
}

export interface OtfSpec {
  family: string;
  unitsPerEm?: number;
  /** Glyph 0 is .notdef; code points[i] maps to glyph i + 1. */
  glyphs: OtfGlyph[];
  codePoints: number[];
  /** Replaces the generated CFF table (hostile tests). */
  cffOverride?: Buffer;
  /** Extra CFF settings: subroutines, widths, charset, CID structure. */
  cff?: Omit<CffSpec, 'fontName' | 'charstrings'>;
  /** Tables left out of the container, for example 'hmtx'. */
  omitTables?: string[];
  /** Tables added or replaced after the standard set is built. */
  extraTables?: Record<string, Buffer>;
}

const DEFAULT_UPM = 1000;
const HEAD_MAGIC = 0x5f0f3cf5;
const OTTO = 0x4f54544f;

/** Builds an OpenType font with a CFF outline table and the tables a conforming reader expects. */
export function buildOtf(spec: OtfSpec): Buffer {
  const upm = spec.unitsPerEm ?? DEFAULT_UPM;
  const numGlyphs = spec.glyphs.length;
  const cff =
    spec.cffOverride ??
    buildCff({
      fontName: spec.family.replace(/\s+/g, ''),
      charstrings: spec.glyphs.map((g) => g.charstring),
      ...spec.cff,
    });

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(HEAD_MAGIC, 12);
  head.writeUInt16BE(0x000b, 16);
  head.writeUInt16BE(upm, 18);
  head.writeInt16BE(7, 46);
  head.writeInt16BE(2, 48);
  head.writeInt16BE(0, 50); // indexToLocFormat is meaningless for CFF but the field exists

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(Math.round(upm * 0.8), 4);
  hhea.writeInt16BE(-Math.round(upm * 0.2), 6);
  hhea.writeUInt16BE(Math.max(...spec.glyphs.map((g) => g.advance)), 10);
  hhea.writeInt16BE(1, 18);
  hhea.writeUInt16BE(numGlyphs, 34);

  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);

  const hmtx = Buffer.alloc(numGlyphs * 4);
  spec.glyphs.forEach((g, i) => {
    hmtx.writeUInt16BE(g.advance, i * 4);
    hmtx.writeInt16BE(g.lsb, i * 4 + 2);
  });

  const os2 = Buffer.alloc(78);
  os2.writeInt16BE(500, 2);
  os2.writeUInt16BE(400, 4);
  os2.writeUInt16BE(5, 6);
  os2.writeUInt32BE(1, 42);
  os2.write('TEST', 58, 4, 'latin1');
  os2.writeUInt16BE(0x40, 62);
  os2.writeUInt16BE(Math.min(...spec.codePoints), 64);
  os2.writeUInt16BE(Math.max(...spec.codePoints), 66);
  os2.writeInt16BE(Math.round(upm * 0.8), 68);
  os2.writeInt16BE(-Math.round(upm * 0.2), 70);
  os2.writeUInt16BE(Math.round(upm * 0.8), 74);
  os2.writeUInt16BE(Math.round(upm * 0.2), 76);

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);

  const tables: Record<string, Buffer> = {
    'CFF ': cff,
    cmap: buildCmapTable(spec.codePoints),
    head,
    hhea,
    hmtx,
    maxp,
    name: buildNameTable(spec.family, 'Regular'),
    'OS/2': os2,
    post,
    ...spec.extraTables,
  };
  for (const tag of spec.omitTables ?? []) delete tables[tag];
  return assembleSfnt(OTTO, tables);
}

export { STANDARD_STRING_COUNT };
