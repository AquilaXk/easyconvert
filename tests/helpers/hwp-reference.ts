import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';

/**
 * Reference reader for HWP 5.0 files used to check files the converter writes. The compound file is opened by the
 * 7-Zip command line (its Compound handler lists and extracts the streams), and the records of each BodyText section
 * are walked here from the Hancom "Hangul Document File Format 5.0" specification. It shares no code with the
 * converter's own reader. The same walk, written in Python, produced the goldens under tests/fixtures/hwp.
 */

const SEVEN_ZIP_TIMEOUT_MS = 30_000;
const HEADER_SIGNATURE = 'HWP Document File';
const FLAGS_OFFSET = 36;
const FLAG_COMPRESSED = 0x01;
const TAG_PARA_TEXT = 67;
const TAG_CTRL_HEADER = 71;
const TAG_LIST_HEADER = 72;
const TAG_TABLE = 77;
const EXTENDED_SIZE = 0xfff;
const TABLE_CONTROL_ID = 0x74626c20;
const TAB = 9;
const LINE_BREAK = 10;
const EIGHT_UNIT_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const CONTROL_UNITS = 8;
const FIRST_PRINTABLE = 32;

export interface HwpReferenceContent {
  version: string;
  compressed: boolean;
  /** Paragraphs outside tables, in file order. */
  paragraphs: string[];
  /** Each table as rows of cell texts. */
  tables: string[][][];
  /** The stream paths 7-Zip lists, sorted. */
  streamPaths: string[];
}

interface RecordView {
  tag: number;
  level: number;
  payload: Buffer;
}

function* records(data: Buffer): Generator<RecordView> {
  let at = 0;
  while (at < data.length) {
    const header = data.readUInt32LE(at);
    at += 4;
    let size = header >>> 20;
    if (size === EXTENDED_SIZE) {
      size = data.readUInt32LE(at);
      at += 4;
    }
    yield { tag: header & 0x3ff, level: (header >>> 10) & 0x3ff, payload: data.subarray(at, at + size) };
    at += size;
  }
}

function paragraphText(payload: Buffer): string {
  let text = '';
  for (let at = 0; at + 2 <= payload.length; at += 2) {
    const unit = payload.readUInt16LE(at);
    if (EIGHT_UNIT_CONTROLS.has(unit)) {
      if (unit === TAB) text += '\t';
      at += (CONTROL_UNITS - 1) * 2;
    } else if (unit === LINE_BREAK) {
      text += '\n';
    } else if (unit >= FIRST_PRINTABLE) {
      text += String.fromCodePoint(unit);
    }
  }
  return text;
}

interface OpenTable {
  level: number;
  rows: number;
  cols: number;
  cells: Map<string, string[]>;
  cell: string | null;
}

function gridOf(table: OpenTable): string[][] {
  return Array.from({ length: table.rows }, (_, row) =>
    Array.from({ length: table.cols }, (_, col) => (table.cells.get(`${row},${col}`) ?? []).join(' '))
  );
}

/** Opens `hwp` with 7-Zip and reads its text and tables with the specification's record layout. */
export function readHwpWithReference(hwp: Buffer): HwpReferenceContent {
  const sevenZip = requireOracleTool('7z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-reference-'));
  try {
    const file = path.join(dir, 'document.hwp');
    fs.writeFileSync(file, hwp);
    const listing = execFileSync(sevenZip, ['l', '-slt', file], { encoding: 'utf-8', timeout: SEVEN_ZIP_TIMEOUT_MS });
    const streamPaths = [...listing.matchAll(/^Path = (.+)$/gm)]
      .map((match) => match[1])
      .filter((entry) => entry !== file && !/^(BodyText|BinData|Scripts|DocOptions)$/.test(entry))
      .sort((a, b) => a.localeCompare(b));
    const out = path.join(dir, 'streams');
    execFileSync(sevenZip, ['x', `-o${out}`, '-y', file], { encoding: 'utf-8', timeout: SEVEN_ZIP_TIMEOUT_MS });

    const header = fs.readFileSync(path.join(out, 'FileHeader'));
    if (header.toString('latin1', 0, HEADER_SIGNATURE.length) !== HEADER_SIGNATURE) throw new Error('FileHeader lacks the HWP signature');
    const versionWord = header.readUInt32LE(32);
    const compressed = (header.readUInt32LE(FLAGS_OFFSET) & FLAG_COMPRESSED) !== 0;

    const sections = fs
      .readdirSync(path.join(out, 'BodyText'))
      .filter((name) => /^Section\d+$/.test(name))
      .sort((a, b) => Number(a.slice('Section'.length)) - Number(b.slice('Section'.length)));

    const paragraphs: string[] = [];
    const tables: string[][][] = [];
    for (const section of sections) {
      let data = fs.readFileSync(path.join(out, 'BodyText', section));
      if (compressed) data = zlib.inflateRawSync(data);
      const open: OpenTable[] = [];
      const closeInnermost = (): void => {
        const done = open.pop() as OpenTable;
        const grid = gridOf(done);
        const parent = open[open.length - 1];
        if (parent && parent.cell !== null) {
          parent.cells.get(parent.cell)?.push(...grid.flat().filter(Boolean));
        } else {
          tables.push(grid);
        }
      };
      for (const rec of records(data)) {
        while (open.length > 0 && rec.level <= open[open.length - 1].level) closeInnermost();
        const table = open[open.length - 1];
        if (rec.tag === TAG_CTRL_HEADER && rec.payload.length >= 4 && rec.payload.readUInt32LE(0) === TABLE_CONTROL_ID) {
          open.push({ level: rec.level, rows: 0, cols: 0, cells: new Map(), cell: null });
        } else if (rec.tag === TAG_TABLE && table) {
          table.rows = rec.payload.readUInt16LE(4);
          table.cols = rec.payload.readUInt16LE(6);
        } else if (rec.tag === TAG_LIST_HEADER && table && table.rows > 0 && rec.level === table.level + 1) {
          table.cell = `${rec.payload.readUInt16LE(10)},${rec.payload.readUInt16LE(8)}`;
          if (!table.cells.has(table.cell)) table.cells.set(table.cell, []);
        } else if (rec.tag === TAG_PARA_TEXT) {
          const text = paragraphText(rec.payload).trim();
          if (!text) continue;
          if (table && table.cell !== null) table.cells.get(table.cell)?.push(text);
          else paragraphs.push(text);
        }
      }
      while (open.length > 0) closeInnermost();
    }
    return {
      version: `${(versionWord >>> 24) & 0xff}.${(versionWord >>> 16) & 0xff}.${(versionWord >>> 8) & 0xff}.${versionWord & 0xff}`,
      compressed,
      paragraphs,
      tables,
      streamPaths,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
