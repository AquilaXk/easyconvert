import fs from 'node:fs';
import path from 'node:path';
import { extraObjectNumber, rawPdf } from './raw-pdf';

/** The DejaVu Sans subset of tests/fixtures/woff2 (written by fontTools, see its PROVENANCE.txt). */
export const FONT_PROGRAM = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));

export interface CompositeFontOptions {
  /** The CIDs the page shows. */
  cids: number[];
  program?: Buffer | null;
  /** CID to glyph id pairs written as a /CIDToGIDMap stream; the map is /Identity when absent. */
  cidToGid?: Map<number, number>;
  ordering?: { registry: string; ordering: string };
  /** The text of a /ToUnicode CMap stream for the font; none when absent. */
  toUnicode?: string;
}

export function hex(values: number[]): string {
  return values.map((value) => value.toString(16).padStart(4, '0')).join('');
}

export function stream(dictionary: string, bytes: Buffer): string {
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
}

function cidToGidStream(pairs: Map<number, number>): Buffer {
  const map = Buffer.alloc((Math.max(...pairs.keys()) + 1) * 2);
  for (const [cid, gid] of pairs) map.writeUInt16BE(gid, cid * 2);
  return map;
}

/** One page showing `cids` in a Type0 font with an Identity-H encoding, with the /ToUnicode map given or none. */
export function compositeFontPdf({ cids, program = FONT_PROGRAM, cidToGid, ordering = { registry: 'Adobe', ordering: 'Identity' }, toUnicode }: CompositeFontOptions): Buffer {
  const type0 = extraObjectNumber(1);
  const [descendant, descriptor, file, map, toUnicodeStream] = [type0 + 1, type0 + 2, type0 + 3, type0 + 4, type0 + 5];
  const fontFile = program === null ? '' : `/FontFile2 ${file} 0 R`;
  const toUnicodeEntry = toUnicode === undefined ? '' : `/ToUnicode ${toUnicodeStream} 0 R`;
  const objects = [
    `<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] ${toUnicodeEntry} >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (${ordering.registry}) /Ordering (${ordering.ordering}) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 600 /W [1 [318]] /CIDToGIDMap ${cidToGid ? `${map} 0 R` : '/Identity'} >>`,
    `<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1021 -463 1793 1232] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 ${fontFile} >>`,
    stream(`/Length1 ${program?.length ?? 0}`, program ?? Buffer.alloc(0)),
    stream('', cidToGid ? cidToGidStream(cidToGid) : Buffer.alloc(0)),
    ...(toUnicode === undefined ? [] : [stream('', Buffer.from(toUnicode, 'latin1'))]),
  ];
  const content = `BT /F2 14 Tf 20 100 Td <${hex(cids)}> Tj ET`;
  return rawPdf([{ width: 400, height: 200, content, fonts: `/F2 ${type0} 0 R` }], objects);
}
