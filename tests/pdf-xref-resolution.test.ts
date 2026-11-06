import { describe, expect, it } from 'vitest';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { InlinePictureCollector, planPictureDecoding } from '../src/lib/conversions/pdf-picture-guard';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { expectNoHang } from './helpers/timing';

/**
 * Which definition of an object number the picture check reads (#783, row of #887). pdf.js does not take the last definition
 * in the file: it follows the cross-reference (src/core/xref.js of v6.3.289: `readXRef`, `fetchUncompressed`,
 * `fetchCompressed`) and falls back to scanning the file only when that fails (`indexObjects`). Each file here is built twice
 * from one layout: with a raw picture whose width is an indirect object, which pdf.js reads and reports (the oracle: the
 * pdfjs-dist of the repository, not the code under test), and with a CCITT picture whose /Columns is the same indirect
 * object, which the check reads and which is past the decoder limit only when the object holds 65,535. The layouts differ in
 * where the live definition of that object lives and where a decoy sits that a scan in file order would take instead.
 */

const HUGE = 65_535;
const SMALL = 8;
const PICTURE = 10;
const VALUE = 30;
const HOLDER = 20;
const XREF_STREAM = 21;
const CARRIER = 40;

type Kind = 'raw' | 'ccitt' | 'jpx';

/** The picture dictionary; its width (raw) or column count (CCITT) is the object `VALUE`. */
function pictureDictionary(kind: Kind): string {
  if (kind === 'jpx') return '/Type /XObject /Subtype /Image /Width 16 /Height 16 /Filter /JPX';
  return kind === 'raw'
    ? `/Type /XObject /Subtype /Image /Width ${VALUE} 0 R /Height 1 /BitsPerComponent 1 /ColorSpace /DeviceGray`
    : `/Type /XObject /Subtype /Image /Width 8 /Height ${HUGE} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${VALUE} 0 R >>`;
}

/**
 * A JPEG 2000 main header (ISO 15444-1 A.5.1 SIZ, A.6.1 COD) for a `side` x `side` greyscale image in one tile, and no tile data.
 * Spelled /JPX in the picture dictionary it decodes at full size, which at 8,000 pixels a side is past the decoder budget; the
 * check has to read the stream to know, which it cannot do in a file it takes for encrypted.
 */
function jpxHeader(side: number): Buffer {
  const siz = Buffer.alloc(43);
  siz.writeUInt16BE(0xff51, 0);
  siz.writeUInt16BE(41, 2);
  siz.writeUInt32BE(side, 6);
  siz.writeUInt32BE(side, 10);
  siz.writeUInt32BE(side, 22);
  siz.writeUInt32BE(side, 26);
  siz.writeUInt16BE(1, 38);
  siz.set([7, 1, 1], 40);
  const cod = Buffer.from([0xff, 0x52, 0, 12, 0, 0, 0, 1, 0, 5, 4, 4, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0x4f]), siz, cod, Buffer.from([0xff, 0x90])]);
}

/** Writes a file piece by piece and remembers where each object begins. */
class Writer {
  private readonly parts: Buffer[] = [];
  private length = 0;
  readonly offsets = new Map<number, number>();

  constructor() {
    this.raw('%PDF-1.7\n');
  }

  get offset(): number {
    return this.length;
  }

  raw(data: string | Buffer): number {
    const at = this.length;
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    this.parts.push(buffer);
    this.length += buffer.length;
    return at;
  }

  /** An object that the cross-reference lists (`list`) or not. */
  object(num: number, body: string, list = true): number {
    const at = this.raw(`${num} 0 obj\n${body}\nendobj\n`);
    if (list) this.offsets.set(num, at);
    return at;
  }

  stream(num: number, dict: string, data: Buffer, list = true): number {
    const at = this.raw(Buffer.concat([Buffer.from(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]));
    if (list) this.offsets.set(num, at);
    return at;
  }

  /** The objects every layout shares: the catalog, a page that draws the picture, and its content. */
  page(kind: Kind): void {
    this.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    this.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    this.object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 ${PICTURE} 0 R >> >> >>`);
    this.stream(4, '', Buffer.from('q 64 0 0 32 72 700 cm /Im0 Do Q', 'latin1'));
    this.stream(PICTURE, pictureDictionary(kind), kind === 'jpx' ? jpxHeader(8000) : Buffer.alloc(HUGE_RAW_BYTES, 0xff));
  }

  /** `shifted` writes the free first entry under a subsection header that starts at 1, which pdf.js reads as object 0 (xref.js 220-225). */
  table(extraTrailer = '', shifted = false, spell: (num: number, at: number) => string = (_num, at) => `${String(at).padStart(10, '0')} 00000 n`): void {
    this.raw(shifted ? 'xref\n1 1\n0000000000 65535 f \n' : 'xref\n0 1\n0000000000 65535 f \n');
    const entries = [...this.offsets.entries()].sort((a, b) => a[0] - b[0]);
    for (const [num, at] of entries) this.raw(`${num} 1\n${spell(num, at)} \n`);
    const size = Math.max(...this.offsets.keys()) + 1;
    this.raw(`trailer\n<< /Size ${size} /Root 1 0 R ${extraTrailer} >>\n`);
  }

  finish(startxref: number): Buffer {
    this.raw(`startxref\n${startxref}\n%%EOF\n`);
    return Buffer.concat(this.parts);
  }
}

/** Enough picture data for a raw picture of up to 65,535 columns of one row. */
const HUGE_RAW_BYTES = 16;

/** A classic table whose `xref` keyword sits at `tableAt`; the trailer is written after it. */
function finishWithTable(writer: Writer, extraTrailer = '', spell?: (num: number, at: number) => string): Buffer {
  const tableAt = writer.offset;
  writer.table(extraTrailer, false, spell);
  return writer.finish(tableAt);
}

/** The same layout as `trailingDecoy` with bytes in front of the `%PDF-` header: every offset of the file counts from the header (pdf.js `checkHeader`). */
function afterJunk(kind: Kind, live: number, decoy: number): Buffer {
  return Buffer.concat([Buffer.from('junk before the header\n', 'latin1'), trailingDecoy(kind, live, decoy)]);
}

/** The layout where the table's first subsection starts at 1 with the free object as its first entry. */
function shiftedFirstSubsection(kind: Kind, live: number, decoy: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(live));
  const tableAt = writer.offset;
  writer.table('', true);
  return Buffer.concat([writer.finish(tableAt), Buffer.from(`${VALUE} 0 obj\n${decoy}\nendobj\n`, 'latin1')]);
}

/** The layout where the file ends with a definition of `VALUE` that the cross-reference does not list. */
function trailingDecoy(kind: Kind, live: number, decoy: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(live));
  const pdf = finishWithTable(writer);
  return Buffer.concat([pdf, Buffer.from(`${VALUE} 0 obj\n${decoy}\nendobj\n`, 'latin1')]);
}

/** An object stream that holds `VALUE`, an uncompressed cross-reference stream that lists it there, and a later plain definition the stream does not list. */
function objectStreamMember(kind: Kind, live: number, decoy: number, typed = true): Buffer {
  const writer = new Writer();
  writer.page(kind);
  const header = `${VALUE} 0\n`;
  writer.stream(HOLDER, `${typed ? '/Type /ObjStm ' : ''}/N 1 /First ${header.length}`, Buffer.from(`${header}${live}`, 'latin1'));
  const entries: Array<[number, number, number, number]> = [];
  for (let num = 0; num <= XREF_STREAM; num++) {
    const at = writer.offsets.get(num);
    entries.push(at === undefined ? [num, 0, 0, 0] : [num, 1, at, 0]);
  }
  entries.push([VALUE, 2, HOLDER, 0]);
  const rows = entries.sort((a, b) => a[0] - b[0]).map(([, type, field2, field3]) => {
    const row = Buffer.alloc(7);
    row.writeUInt8(type, 0);
    row.writeUInt32BE(field2, 1);
    row.writeUInt16BE(field3, 5);
    return row;
  });
  const streamAt = writer.offset;
  writer.stream(XREF_STREAM, `/Type /XRef /Size ${VALUE + 1} /W [1 4 2] /Index [0 ${XREF_STREAM + 1} ${VALUE} 1] /Root 1 0 R`, Buffer.concat(rows), false);
  const pdf = writer.finish(streamAt);
  return Buffer.concat([pdf, Buffer.from(`${VALUE} 0 obj\n${decoy}\nendobj\n`, 'latin1')]);
}

/** The live definition of `VALUE` is text inside the data of another stream, where a scan of the file does not look; a plain definition elsewhere is the decoy. */
function insideStream(kind: Kind, live: number, decoy: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(decoy), false);
  const prefix = 'filler\n';
  const body = `${prefix}${VALUE} 0 obj\n${live}\nendobj\nmore filler`;
  const carrierAt = writer.raw(`${CARRIER} 0 obj\n<< /Length ${body.length} >>\nstream\n`);
  const dataAt = writer.raw(body);
  writer.raw('\nendstream\nendobj\n');
  writer.offsets.set(CARRIER, carrierAt);
  writer.offsets.set(VALUE, dataAt + prefix.length);
  return finishWithTable(writer);
}

/** A `trailer` dictionary with an /Encrypt entry that lies between two objects and that no cross-reference section leads to. */
function strayEncryptTrailer(kind: Kind, live: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.raw('trailer\n<< /Encrypt 99 0 R /Root 1 0 R >>\n');
  writer.object(VALUE, String(live));
  return finishWithTable(writer);
}

/** An incremental update that redefines `VALUE`; the first revision is the decoy. */
function incrementalUpdate(kind: Kind, live: number, old: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(old));
  const firstTable = writer.offset;
  writer.table();
  const first = writer.finish(firstTable);
  const base = first.length;
  const updateObject = `${VALUE} 0 obj\n${live}\nendobj\n`;
  const tableAt = base + updateObject.length;
  const size = Math.max(...writer.offsets.keys()) + 1;
  const tail = `xref\n${VALUE} 1\n${String(base).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root 1 0 R /Prev ${firstTable} >>\nstartxref\n${tableAt}\n%%EOF\n`;
  return Buffer.concat([first, Buffer.from(updateObject + tail, 'latin1')]);
}

/** A file whose `startxref` leads nowhere: pdf.js scans the file (`indexObjects`) and the later definition wins. */
function brokenCrossReference(kind: Kind, early: number, late: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(early));
  writer.object(VALUE, String(late));
  writer.table();
  return writer.finish(1);
}

interface PdfJs {
  OPS: { paintImageXObject: number };
  getDocument(options: Record<string, unknown>): {
    promise: Promise<{ getPage(number: number): Promise<{ getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: { get(id: string, callback: (image: { width?: number } | null) => void): void } }> }>;
    destroy(): Promise<void>;
  };
}

/** The width pdf.js gives the raw picture of a file: the value of the object `VALUE` that pdf.js read. */
async function widthPdfjsReads(pdf: Buffer): Promise<number | null> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const list = await page.getOperatorList();
    const index = list.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
    if (index < 0) return null;
    const id = list.argsArray[index][0] as string;
    const image = await new Promise<{ width?: number } | null>((resolve) => page.objs.get(id, resolve));
    return image?.width ?? null;
  } finally {
    await task.destroy();
  }
}

/** The numbers of the picture objects the check leaves out of a file. */
function droppedBy(pdf: Buffer): number[] {
  const inline = new InlinePictureCollector();
  const document = assertPdfStreamsWithinLimits(pdf, inline.visit);
  return planPictureDecoding(document, inline).dropped.map(({ num }) => num);
}

interface Layout {
  name: string;
  /** The file for a picture kind, whose object `VALUE` holds `live` for pdf.js and `other` elsewhere in the file. */
  build(kind: Kind, live: number, other: number): Buffer;
  /** The file has no cross-reference to follow, so the check reads every definition of an object, not the one pdf.js reads (policy 167). */
  readsEveryDefinition?: boolean;
}

const LAYOUTS: Layout[] = [
  { name: 'a definition after the last cross-reference section (pdf.js reads the listed one, a scan the last)', build: trailingDecoy },
  { name: 'a member of an object stream beside a later plain definition (pdf.js reads the member, a scan the plain one)', build: objectStreamMember },
  { name: 'a stream with no /Type that holds the member (pdf.js reads the members of any stream)', build: (kind, live, other) => objectStreamMember(kind, live, other, false) },
  { name: 'an offset into the data of an earlier stream (pdf.js reads there, a scan skips the data)', build: insideStream },
  { name: 'bytes before the %PDF- header (every offset counts from the header)', build: afterJunk },
  { name: 'a first subsection that starts at 1 with the free object (it is object 0)', build: shiftedFirstSubsection },
  { name: 'an incremental update (the newest section lists the new definition)', build: incrementalUpdate },
  {
    name: 'a cross-reference that leads nowhere (pdf.js scans the file, the later definition wins)',
    build: (kind, live, other) => brokenCrossReference(kind, other, live),
    readsEveryDefinition: true,
  },
];

describe('the definition of an object that the picture check reads is the one pdf.js reads', () => {
  for (const layout of LAYOUTS) {
    it(`${layout.name}: a decoder-sized live picture is left out, a harmless one is kept`, async () => {
      const liveWidth = SMALL + 3;
      const decoyWidth = SMALL + 14;
      // The oracle: pdf.js reads `liveWidth` or `decoyWidth` from the raw picture of the same layout.
      expect(await widthPdfjsReads(layout.build('raw', liveWidth, decoyWidth)), 'pdf.js').toBe(liveWidth);
      // The live definition past the limit, the decoy harmless: the picture is left out.
      expect(droppedBy(layout.build('ccitt', HUGE, SMALL)), 'live huge').toEqual([PICTURE]);
      // The live definition harmless, the decoy past the limit: pdf.js never reads the decoy, so the picture stays. Where the check
      // cannot follow a cross-reference it takes the definition that costs more, since it cannot know which one pdf.js reads.
      expect(droppedBy(layout.build('ccitt', SMALL, HUGE)), 'decoy huge').toEqual(layout.readsEveryDefinition ? [PICTURE] : []);
    });
  }
});

describe('a trailer that no cross-reference section leads to', () => {
  it('does not turn the picture check off: pdf.js opens the file unencrypted and draws the picture, and the check leaves out the oversized one', async () => {
    expect(await widthPdfjsReads(strayEncryptTrailer('raw', SMALL + 3)), 'pdf.js').toBe(SMALL + 3);
    expect(droppedBy(strayEncryptTrailer('jpx', HUGE))).toEqual([PICTURE]);
  });
});

describe('a cross-reference that leads into the same bytes again and again', () => {
  it('is refused instead of read: 20,000 entries at fake headers inside one unterminated string would parse the same two megabytes 20,000 times', async () => {
    const writer = new Writer();
    writer.page('raw');
    const entries = 20_000;
    const firstFake = 100;
    const filler = 'a'.repeat(80);
    for (let index = 0; index < entries; index++) writer.offsets.set(firstFake + index, writer.raw(`${firstFake + index} 0 obj\n<< /X (${filler}`));
    const pdf = finishWithTable(writer);
    await expectNoHang('20,000 entries into one string', () => expect(() => assertPdfStreamsWithinLimits(pdf, () => {})).toThrow(/same bytes again and again/));
  });
});


const pad10 = (at: number): string => String(at).padStart(10, '0');

/** The ways pdf.js writes an integer of a table entry that the lexer of the guard did not read (`Lexer.getNumber`, then `Number.isInteger`). */
const ENTRY_SPELLINGS: Array<[string, (at: number) => string]> = [
  ['a decimal point and a zero after the offset', (at) => `${pad10(at)}.0 00000 n`],
  ['a decimal point and nothing after the offset', (at) => `${pad10(at)}. 00000 n`],
  ['a plus sign before the offset', (at) => `+${pad10(at)} 00000 n`],
  ['a decimal generation', (at) => `${pad10(at)} 0.0 n`],
  ['the type glued to the generation', (at) => `${pad10(at)} 00000n`],
  ['a sign, a line end and the digits', (at) => `+\n${pad10(at)} 00000 n`],
];

function spelledEntry(kind: Kind, live: number, decoy: number, spell: (at: number) => string): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(live));
  const pdf = finishWithTable(writer, '', (num, at) => (num === VALUE ? spell(at) : `${pad10(at)} 00000 n`));
  return Buffer.concat([pdf, Buffer.from(`${VALUE} 0 obj\n${decoy}\nendobj\n`, 'latin1')]);
}

describe('an integer the cross-reference spells as pdf.js reads it', () => {
  for (const [name, spell] of ENTRY_SPELLINGS) {
    it(`${name}: the section is read, so the listed definition is the one the check reads`, async () => {
      expect(await widthPdfjsReads(spelledEntry('raw', SMALL + 3, SMALL + 14, spell)), 'pdf.js').toBe(SMALL + 3);
      expect(droppedBy(spelledEntry('ccitt', HUGE, SMALL, spell)), 'live huge').toEqual([PICTURE]);
      expect(droppedBy(spelledEntry('ccitt', SMALL, HUGE, spell)), 'decoy huge').toEqual([]);
    });
  }
});

/** The ways an object header at an offset of the table reads for pdf.js (`fetchUncompressed`: three tokens, the number and generation compared as numbers). */
const HEADER_SPELLINGS: Array<[string, (live: number) => string]> = [
  ['a decimal object number and a signed generation', (live) => `${VALUE}.0 +0 obj\n${live}\nendobj\n`],
  ['a comment between the tokens', (live) => `${VALUE} %c\n0 obj\n${live}\nendobj\n`],
  ['the value glued to the keyword (pdf.js takes the digits after obj as the value)', (live) => `${VALUE} 0 obj${live}\nendobj\n`],
];

function spelledHeader(kind: Kind, live: number, decoy: number, spell: (live: number) => string): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.offsets.set(VALUE, writer.raw(spell(live)));
  const pdf = finishWithTable(writer);
  return Buffer.concat([pdf, Buffer.from(`${VALUE} 0 obj\n${decoy}\nendobj\n`, 'latin1')]);
}

describe('an object header at an offset of the cross-reference that pdf.js reads', () => {
  for (const [name, spell] of HEADER_SPELLINGS) {
    it(`${name}: the object it names is the one the check reads`, async () => {
      expect(await widthPdfjsReads(spelledHeader('raw', SMALL + 3, SMALL + 14, spell)), 'pdf.js').toBe(SMALL + 3);
      expect(droppedBy(spelledHeader('ccitt', HUGE, SMALL, spell)), 'live huge').toEqual([PICTURE]);
      expect(droppedBy(spelledHeader('ccitt', SMALL, HUGE, spell)), 'decoy huge').toEqual([]);
    });
  }
});

const EMPTY_NODE = 50;
const BROKEN_KID = 51;

/**
 * A page tree whose kids are an empty Pages node, a kid whose entry cannot be read (`broken`) and the page. pdf.js walks past the
 * empty node to the next kid, fails on the broken one with an `XRefEntryException`, and reads the file by scanning it (the later
 * definition of `VALUE` wins); the xref lists the first.
 */
function emptyNodeBeforeBrokenKid(kind: Kind, live: number, decoy: number): Buffer {
  const writer = new Writer();
  writer.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  writer.object(2, `<< /Type /Pages /Kids [${EMPTY_NODE} 0 R ${BROKEN_KID} 0 R 3 0 R] /Count 1 >>`);
  writer.object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 ${PICTURE} 0 R >> >> >>`);
  writer.stream(4, '', Buffer.from('q 64 0 0 32 72 700 cm /Im0 Do Q', 'latin1'));
  writer.stream(PICTURE, pictureDictionary(kind), kind === 'jpx' ? jpxHeader(8000) : Buffer.alloc(HUGE_RAW_BYTES, 0xff));
  writer.object(EMPTY_NODE, '<< /Type /Pages /Parent 2 0 R /Kids [] >>');
  writer.object(BROKEN_KID, '<< /Type /Pages /Parent 2 0 R /Kids [] >>');
  writer.offsets.set(BROKEN_KID, 9);
  writer.object(VALUE, String(live));
  const pdf = finishWithTable(writer);
  return Buffer.concat([pdf, Buffer.from(`${VALUE} 0 obj\n${decoy}\nendobj\n`, 'latin1')]);
}

describe('a page tree that pdf.js walks past an empty node to a kid it cannot read', () => {
  it("the kid's offset is wrong: pdf.js reads the file by scanning it, and so does the check", async () => {
    // The oracle: the later definition, which the cross-reference does not list.
    expect(await widthPdfjsReads(emptyNodeBeforeBrokenKid('raw', SMALL + 3, SMALL + 14)), 'pdf.js').toBe(SMALL + 14);
    expect(droppedBy(emptyNodeBeforeBrokenKid('ccitt', SMALL, HUGE)), 'the later definition is huge').toEqual([PICTURE]);
  });
});

/** A trailer dictionary that holds `/W [0 0 0]` and the same range `repeats` times. */
function repeatedRange(repeats: number): Buffer {
  const writer = new Writer();
  writer.page('raw');
  const streamAt = writer.offset;
  writer.stream(XREF_STREAM, `/Type /XRef /Size 400000 /W [0 0 0] /Index [${'0 400000 '.repeat(repeats)}] /Root 1 0 R`, Buffer.alloc(0), false);
  return writer.finish(streamAt);
}

describe('a cross-reference stream whose rows take no bytes', () => {
  it('is refused instead of walked: a range repeated over the same numbers adds no object, so no cap on objects bounds the rows', async () => {
    const pdf = repeatedRange(400);
    expect(pdf.length).toBeLessThan(10_000);
    await expectNoHang('400 ranges of 400,000 rows', () => expect(() => assertPdfStreamsWithinLimits(pdf, () => {})).toThrow(PdfStructureError));
  });
});

/** A table of 20,000 entries whose last entry is not one, and `sections` small sections that each lead to it from another offset (white space in front of `xref`). */
function failedTableSections(sections: number): Buffer {
  const writer = new Writer();
  writer.page('raw');
  const tableAt = writer.raw(' '.repeat(sections));
  writer.raw(`xref\n0 20000\n${'0000000000 00000 f \n'.repeat(19_999)}not an entry\n`);
  let previous: number | null = null;
  for (let index = sections - 1; index >= 0; index--) {
    const chain: string = previous === null ? '' : `/Prev ${previous}`;
    previous = writer.raw(`xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R /XRefStm ${tableAt + index} ${chain} >>\n`);
  }
  return writer.finish(previous as number);
}

describe('a table that fails near its end', () => {
  it('is charged for the bytes it read: 200 sections that each lead to it would read it 200 times', async () => {
    const pdf = failedTableSections(200);
    expect(pdf.length).toBeLessThan(500_000);
    await expectNoHang('200 failed reads of a 400 KB table', () => expect(() => assertPdfStreamsWithinLimits(pdf, () => {})).toThrow(/same bytes again and again/));
  });
});

/** An object stream that holds the /Encrypt dictionary, listed by an uncompressed cross-reference stream whose own dictionary names it. */
function encryptInObjectStream(): Buffer {
  const encrypt = `<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'11'.repeat(32)}> /P -4 >>`;
  const encryptNum = 31;
  const writer = new Writer();
  writer.page('raw');
  const header = `${encryptNum} 0\n`;
  writer.stream(HOLDER, `/Type /ObjStm /N 1 /First ${header.length}`, Buffer.from(`${header}${encrypt}`, 'latin1'));
  const entries: Array<[number, number, number, number]> = [];
  for (let num = 0; num <= XREF_STREAM; num++) {
    const at = writer.offsets.get(num);
    entries.push(at === undefined ? [num, 0, 0, 0] : [num, 1, at, 0]);
  }
  entries.push([encryptNum, 2, HOLDER, 0]);
  const rows = entries.sort((a, b) => a[0] - b[0]).map(([, type, field2, field3]) => {
    const row = Buffer.alloc(7);
    row.writeUInt8(type, 0);
    row.writeUInt32BE(field2, 1);
    row.writeUInt16BE(field3, 5);
    return row;
  });
  const streamAt = writer.offset;
  writer.stream(XREF_STREAM, `/Type /XRef /Size ${encryptNum + 1} /W [1 4 2] /Index [0 ${XREF_STREAM + 1} ${encryptNum} 1] /Root 1 0 R /Encrypt ${encryptNum} 0 R`, Buffer.concat(rows), false);
  return writer.finish(streamAt);
}

describe('an /Encrypt dictionary inside an object stream', () => {
  it('encrypts the file for the check as it does for pdf.js, which asks for a password', async () => {
    const pdf = encryptInObjectStream();
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
    const task = pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    await expect(task.promise).rejects.toMatchObject({ name: 'PasswordException' });
    await task.destroy();
    expect(assertPdfStreamsWithinLimits(pdf, () => {}).encrypted).toBe(true);
  });
});

/**
 * An incremental update whose hybrid section (/XRefStm) is a run-length encoded cross-reference stream, which pdf.js reads and the
 * check does not decode: the check rejects that section and goes on to the first revision's table, which leads to the old definition.
 */
function updateTheCheckCannotRead(kind: Kind, live: number, old: number): Buffer {
  const writer = new Writer();
  writer.page(kind);
  writer.object(VALUE, String(old));
  const firstTable = writer.offset;
  writer.table();
  const first = writer.finish(firstTable);
  const updateObject = `${VALUE} 0 obj\n${live}\nendobj\n`;
  const row = Buffer.alloc(7);
  row.writeUInt8(1, 0);
  row.writeUInt32BE(first.length, 1);
  const encoded = Buffer.concat([Buffer.from([6]), row, Buffer.from([128])]);
  const streamAt = first.length + updateObject.length;
  const size = Math.max(...writer.offsets.keys()) + 1;
  const head = `${XREF_STREAM} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${VALUE} 1] /Root 1 0 R /Filter /RunLengthDecode /Length ${encoded.length} >>\nstream\n`;
  const hybrid = Buffer.concat([Buffer.from(updateObject + head, 'latin1'), encoded, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  const tableAt = first.length + hybrid.length;
  const table = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${size} /Root 1 0 R /Prev ${firstTable} /XRefStm ${streamAt} >>\nstartxref\n${tableAt}\n%%EOF\n`;
  return Buffer.concat([first, hybrid, Buffer.from(table, 'latin1')]);
}

describe('a section of the cross-reference that the check rejects and pdf.js reads', () => {
  it('does not leave the check on the older definition: it also reads the file in order, and takes what either reading costs', async () => {
    expect(await widthPdfjsReads(updateTheCheckCannotRead('raw', SMALL + 14, SMALL + 3)), 'pdf.js').toBe(SMALL + 14);
    expect(droppedBy(updateTheCheckCannotRead('ccitt', HUGE, SMALL)), 'the newer definition is huge').toEqual([PICTURE]);
    expect(droppedBy(updateTheCheckCannotRead('ccitt', SMALL, HUGE)), 'the older definition is huge').toEqual([PICTURE]);
  });
});

describe('entries that lead to streams with no end', () => {
  it('are charged for the search for `endstream` that each one makes: 20,000 entries inside one unterminated string would search the rest of the file 20,000 times', async () => {
    const writer = new Writer();
    writer.page('raw');
    const entries = 20_000;
    const firstFake = 100;
    const filler = 'a'.repeat(80);
    writer.raw('999 0 obj\n(');
    for (let index = 0; index < entries; index++) writer.offsets.set(firstFake + index, writer.raw(`${firstFake + index} 0 obj\n<< /Length 99999999 >>\nstream\n${filler}\n`));
    const pdf = finishWithTable(writer);
    await expectNoHang('20,000 entries at streams with no end', () => expect(() => assertPdfStreamsWithinLimits(pdf, () => {})).toThrow(/same bytes again and again/));
  });
});
