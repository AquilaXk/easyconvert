import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { parseHwpDocument } from '../src/lib/conversions/hwp';
import { HWP_MAX_LIST_DEPTH, HWP_MAX_RECORDS, readHwpSections } from '../src/lib/conversions/hwp-reader';
import { decodeHwpParagraph } from '../src/lib/conversions/hwp-records';
import type { Block, DocumentModel, Inline, ListBlock, TableBlock } from '../src/lib/conversions/document-model/model';
import { blockRuns, bodyBlocks, cellBlocks } from '../src/lib/conversions/document-model/support';
import { blockText, inlineText, listMarkers } from '../src/lib/conversions/document-model/text';
import { CorruptStreamError, PayloadLimitError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { expectNoHang } from './helpers/timing';
import { zipEntryBytes } from './helpers/zip-entry';
import { sha256 } from './helpers/document-fixtures';
import {
  TAG,
  binData,
  bullet,
  cell,
  charShape,
  controlUnits,
  ctrl,
  fieldControl,
  listHeader,
  numbering,
  objectProperties,
  pack,
  para,
  paraShape,
  picture,
  rec,
  style,
  table,
  type RawRecord,
} from './helpers/hwp-craft';
import { parseHwpRecords } from '../src/lib/conversions/hwp-records';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * HWP 5.0 documents keep their reading order, headings, numbering, merged cells, pictures, links, notes and text boxes,
 * and control characters never leak their payload into text. Real documents are checked against the reference reader
 * (tests/fixtures/hwp/reference-extract.py); record-level behaviour against records built from the specification by
 * tests/helpers/hwp-craft.ts.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'hwp');

interface Reference {
  paragraphs: { level: number; text: string }[];
  tables: { rows: number; cols: number; cells: string[][]; spans: { row: number; col: number; colSpan: number; rowSpan: number }[] }[];
  body: ({ kind: 'paragraph'; text: string } | { kind: 'table'; index: number })[];
  headerFooter: string[];
  notes: string[];
  captions: string[];
  pictures: { item: number; stream: string; sha256: string; bytes: number }[];
}

const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, `${name}.hwp`));
const readReference = (name: string): Reference => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.reference.json`), 'utf-8')) as Reference;
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The reading order of a model as the reference lists it: paragraph texts and table positions. */
function modelOrder(model: DocumentModel): ({ kind: 'paragraph'; text: string } | { kind: 'table'; index: number })[] {
  const order: ({ kind: 'paragraph'; text: string } | { kind: 'table'; index: number })[] = [];
  let tables = 0;
  for (const block of bodyBlocks(model)) {
    if (block.type === 'table') {
      order.push({ kind: 'table', index: tables });
      tables += 1;
    } else {
      for (const runs of blockRuns(block)) {
        const text = squash(inlineText(runs));
        if (text !== '') order.push({ kind: 'paragraph', text });
      }
    }
  }
  return order;
}

const REAL_DOCUMENTS = ['changing-paragraph-text', 'merging-cell', 'noori', 'basics-report'];

describe('real HWP documents keep their reading order', () => {
  it.each(REAL_DOCUMENTS)('%s: paragraphs and tables come in the order of the reference reader', (name) => {
    const reference = readReference(name);
    const expected = reference.body.map((item) => (item.kind === 'paragraph' ? squash(item.text) : `table ${item.index}`));
    // A table's caption is placed by the table's caption position, which the reference does not model.
    const captions = new Set(reference.captions.map(squash));
    const found = modelOrder(parseHwpDocument(readFixture(name)).model)
      .filter((item) => item.kind === 'table' || !captions.has(item.text))
      .map((item) => (item.kind === 'paragraph' ? item.text : `table ${item.index}`));
    expect(found).toEqual(expected);
  });

  it('noori: the first table (the press release header) comes before the first paragraph that follows it', () => {
    const model = parseHwpDocument(readFixture('noori')).model;
    const blocks = bodyBlocks(model);
    const firstTable = blocks.findIndex((block) => block.type === 'table');
    const firstBody = blocks.findIndex((block) => block.type === 'paragraph' && inlineText(block.runs).startsWith('□ 과학기술정보통신부'));
    expect(firstTable).toBeGreaterThanOrEqual(0);
    expect(firstTable).toBeLessThan(firstBody);
  });

  it('headers and footers are not body text', () => {
    const reference = readReference('basics-report');
    expect(reference.headerFooter).toHaveLength(1);
    const text = squash(modelOrder(parseHwpDocument(readFixture('basics-report')).model).map((item) => (item.kind === 'paragraph' ? item.text : '')).join(' '));
    expect(text.includes(squash(reference.headerFooter[0]))).toBe(false);
  });

  it('noori: a cell that spans three columns keeps its span', () => {
    const model = parseHwpDocument(readFixture('noori')).model;
    const first = bodyBlocks(model).find((block): block is TableBlock => block.type === 'table') as TableBlock;
    expect(first.rows.map((row) => row.filter((c) => !c.continuation).map((c) => c.colSpan))).toEqual([[1, 3], [1, 1, 1, 1], [1, 1, 1, 1]]);
    expect(first.rows.map((row) => row.map((c) => (c.continuation ? '.'.repeat(c.colSpan) : `x${'.'.repeat(c.colSpan - 1)}`)).join(''))).toEqual(['xx..', 'xxxx', 'xxxx']);
    const reference = readReference('noori').tables[0];
    expect(reference.spans.filter((span) => span.colSpan > 1)).toEqual([{ row: 0, col: 1, colSpan: 3, rowSpan: 1 }]);
  });

  it.each(['noori', 'basics-report'])('%s: the text differs from the reference reader by at most 2% (character error rate)', async (name) => {
    const reference = readReference(name);
    const expectedText = [
      ...reference.body.map((item) => (item.kind === 'paragraph' ? item.text : reference.tables[item.index].cells.flat().filter((cellText) => cellText !== '').join(' '))),
      ...reference.captions,
    ].join(' ');
    const converted = (await convertFile(readFixture(name), 'hwp', 'txt', {}, `${name}.hwp`)).buffer.toString('utf-8');
    expect(characterErrorRatePercent(expectedText, converted)).toBeLessThanOrEqual(2);
  });

  it.each(['noori', 'basics-report'])('%s: no control payload reaches the output', async (name) => {
    const converted = (await convertFile(readFixture(name), 'hwp', 'txt', {}, `${name}.hwp`)).buffer.toString('utf-8');
    for (const id of ['secd', 'cold', 'gso ', 'tbl ', 'pgnp', 'dces', 'dloc', '%hlk', 'nwno', 'atno', 'pghd']) expect(converted.includes(id), id).toBe(false);
    expect(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(converted)).toBe(false);
  });
});

describe('pictures of real HWP documents', () => {
  it.each(['noori', 'basics-report'])('%s: every picture is carried with the bytes of its BinData stream', async (name) => {
    const reference = readReference(name);
    const { images } = parseHwpDocument(readFixture(name)).model;
    expect(images.map((image) => sha256(Buffer.from(image.data)))).toEqual(reference.pictures.map((entry) => entry.sha256));
  });

  it('noori: the pictures appear unchanged in word/media of the DOCX', async () => {
    const reference = readReference('noori');
    const wanted = new Set(reference.pictures.map((entry) => entry.sha256));
    const docx = await JSZip.loadAsync((await convertFile(readFixture('noori'), 'hwp', 'docx', {}, 'noori.hwp')).buffer);
    const inDocx = await Promise.all(Object.keys(docx.files).filter((name) => name.startsWith('word/media/')).map(async (name) => sha256(await zipEntryBytes(docx, name))));
    expect(new Set(inDocx)).toEqual(wanted);
  });

  oracleTest('noori: the DOCX is a Word document LibreOffice reads, with its four pictures', ['soffice', 'unzip'], async () => {
    const docx = (await convertFile(readFixture('noori'), 'hwp', 'docx', {}, 'noori.hwp')).buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-docx-'));
    try {
      fs.writeFileSync(path.join(dir, 'noori.docx'), docx);
      execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', dir, path.join(dir, 'noori.docx')], { stdio: 'ignore', timeout: 180_000 });
      const text = fs.readFileSync(path.join(dir, 'noori.txt'), 'utf-8');
      expect(text.includes('한국형발사체')).toBe(true);
      const listing = execFileSync(requireOracleTool('unzip'), ['-Z1', path.join(dir, 'noori.docx')], { encoding: 'utf-8' });
      expect(listing.split('\n').filter((entry) => entry.startsWith('word/media/'))).toHaveLength(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('HWP to PDF', () => {
  oracleTest('real documents convert without a complex-script error and keep their words', ['pdftotext'], async () => {
    for (const name of ['noori', 'basics-report']) {
      const pdf = (await convertFile(readFixture(name), 'hwp', 'pdf', {}, `${name}.hwp`)).buffer;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-pdf-'));
      try {
        fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
        const text = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
        const reference = readReference(name);
        const sample = reference.body.find((item): item is { kind: 'paragraph'; text: string } => item.kind === 'paragraph' && item.text.length > 20 && !item.text.includes('\t'));
        const first = squash(sample?.text ?? '').slice(0, 12);
        expect(squash(text).normalize('NFC').includes(first.normalize('NFC')), name).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('control characters of paragraph text (HWP 5.0 file format, character controls)', () => {
  const text = (units: number[]): Buffer => Buffer.from(Uint16Array.from(units).buffer);
  const EXTENDED = [1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23];
  const INLINE = [4, 5, 6, 7, 8, 9, 19, 20];
  const SECD = [0x65, 0x73, 0x64, 0x63];

  it.each([...EXTENDED, ...INLINE])('control %i skips its eight units and leaks no payload', (code) => {
    const payload = text([0x41, code, ...SECD, 0x7a, 0x7a, code, 0x42, 0x0d]);
    const decoded = decodeHwpParagraph(payload);
    expect(decoded.text).toBe(code === 9 ? 'A\tB' : 'AB');
    expect(decoded.controls.map((control) => [control.code, control.offset, control.extended])).toEqual([[code, 1, EXTENDED.includes(code)]]);
  });

  it('single-unit controls: line break, hyphen, fixed spaces, paragraph end and unusable codes', () => {
    expect(decodeHwpParagraph(text([0x61, 10, 0x62, 24, 0x63, 30, 0x64, 31, 0x65, 0, 25, 26, 27, 28, 29, 0x66, 13])).text).toBe('a\nb-c d ef');
  });

  it('records where each control stood in the decoded text and maps record positions to text offsets', () => {
    const decoded = decodeHwpParagraph(text([0x61, 11, 1, 2, 3, 4, 5, 6, 11, 0x62, 0x63]));
    expect(decoded.text).toBe('abc');
    expect(decoded.controls.map((control) => control.offset)).toEqual([1]);
    // Record units 0..10 map to text offsets 0,1,1,1,1,1,1,1,1,1,2 (the control takes eight units and no text).
    expect([...decoded.offsetOfUnit]).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3]);
  });

  it('a control cut off by the end of the record is a corrupt record', () => {
    const failure = (() => {
      try {
        decodeHwpParagraph(text([0x41, 11, 1, 2, 3]));
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Corrupt HWP paragraph text: control character 11 is cut off by the end of the record.');
  });

  it('a control whose closing unit does not repeat its code is a corrupt record', () => {
    const failure = (() => {
      try {
        decodeHwpParagraph(text([11, 1, 2, 3, 4, 5, 6, 12, 0x41]));
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Corrupt HWP paragraph text: control character 11 is not repeated at its end.');
  });
});

/** Reads records built by hwp-craft into the model. */
function read(docInfo: RawRecord[], section: RawRecord[], bins: Record<string, Buffer> = {}): DocumentModel {
  const reread = (records: RawRecord[]) => parseHwpRecords(pack(records));
  return readHwpSections(reread(docInfo), [reread(section)], (name) => bins[name]);
}

const first = (model: DocumentModel): Block => bodyBlocks(model)[0];
const textOfBlock = (block: Block): string => blockText(block);
const runsOf = (block: Block): Inline[] => blockRuns(block)[0] ?? [];
const listsOf = (model: DocumentModel): ListBlock[] => bodyBlocks(model).filter((block): block is ListBlock => block.type === 'list');

describe('record-level reading', () => {
  it('outline styles and outline paragraph shapes are headings', () => {
    const model = read(
      [style('Normal'), style('Outline 1'), style('Outline 2'), paraShape(), paraShape({ headType: 1, level: 2 })],
      [...para(0, { text: 'Chapter', style: 1 }), ...para(0, { text: 'Section', style: 2 }), ...para(0, { text: 'Deep', style: 0, shape: 1 }), ...para(0, { text: 'Body text' })]
    );
    expect(bodyBlocks(model).map((block) => (block.type === 'heading' ? `h${block.level} ${textOfBlock(block)}` : `${block.type} ${textOfBlock(block)}`))).toEqual(['h1 Chapter', 'h2 Section', 'h3 Deep', 'paragraph Body text']);
  });

  it('numbered paragraphs get their markers from the numbering definition, with levels and resets', () => {
    const docInfo = [
      numbering([
        { shape: 0, format: '^1.' },
        { shape: 8, format: '^2.' },
        { shape: 0, format: '^3)' },
      ]),
      paraShape({ headType: 2, level: 0, numberingId: 1 }),
      paraShape({ headType: 2, level: 1, numberingId: 1 }),
      paraShape({ headType: 2, level: 2, numberingId: 1 }),
    ];
    const section = [
      ...para(0, { text: 'one', shape: 0 }),
      ...para(0, { text: 'sub a', shape: 1 }),
      ...para(0, { text: 'sub b', shape: 1 }),
      ...para(0, { text: 'deep', shape: 2 }),
      ...para(0, { text: 'two', shape: 0 }),
      ...para(0, { text: 'sub again', shape: 1 }),
    ];
    const lists = listsOf(read(docInfo, section));
    expect(lists.flatMap((list) => list.items.map((item, index) => `${item.level} ${listMarkers(list)[index]} ${inlineText(item.runs)}`))).toEqual(['0 1. one', '1 가. sub a', '1 나. sub b', '2 1) deep', '0 2. two', '1 가. sub again']);
    expect(lists).toHaveLength(1);
  });

  it('bullet paragraphs use the bullet character of their definition', () => {
    const model = read([bullet('-'), paraShape({ headType: 3, level: 0, numberingId: 1 })], [...para(0, { text: 'item', shape: 0 })]);
    const [list] = listsOf(model);
    expect([list.levels[0].kind !== 'bullet', listMarkers(list)[0]]).toEqual([false, '-']);
  });

  it('character shapes split a paragraph into bold, italic and underlined runs', () => {
    const model = read(
      [charShape(), charShape({ bold: true }), charShape({ italic: true, underline: true })],
      [...para(0, { text: 'plain BOLD ital end', charShapes: [[0, 0], [6, 1], [11, 2], [15, 0]] })]
    );
    const runs = runsOf(first(model)).map((run) => `${run.text}|${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}${run.underline ? 'u' : ''}`);
    expect(runs).toEqual(['plain |', 'BOLD |b', 'ital|iu', ' end|']);
  });

  it('a hyperlink field gives the text between its begin and end the target', () => {
    const units = Buffer.concat([Buffer.from('see ', 'utf16le'), controlUnits(3, '%hlk'), Buffer.from('portal', 'utf16le'), controlUnits(4, '%hlk'), Buffer.from(' now', 'utf16le')]);
    const model = read([], [...para(0, { units }), fieldControl(1, '%hlk', 'https://example.org/x;1;0;0;')]);
    expect(runsOf(first(model)).map((run) => [run.text, run.href])).toEqual([['see '.trimStart(), undefined], ['portal', 'https://example.org/x'], [' now', undefined]]);
  });

  it('a footnote leaves a reference in its paragraph and its paragraphs in the notes', () => {
    const units = Buffer.concat([Buffer.from('Body', 'utf16le'), controlUnits(17, 'fn  '), Buffer.from('.', 'utf16le')]);
    const model = read([], [...para(0, { units }), ctrl(1, 'fn  ', Buffer.alloc(8)), listHeader(2), ...para(2, { text: 'Note text' })]);
    expect(runsOf(first(model)).map((run) => (run.note ? `note:${run.note.label}` : run.text))).toEqual(['Body', 'note:1', '.']);
    expect((model.footnotes ?? []).map((note) => note.blocks.map(textOfBlock))).toEqual([['Note text']]);
    expect(model.endnotes ?? []).toHaveLength(0);
  });

  it('a text box contributes its paragraphs in place, between the paragraphs around it', () => {
    const box = Buffer.concat([controlUnits(11, 'gso ')]);
    const model = read(
      [],
      [...para(0, { text: 'before' }), ...para(0, { units: box }), ctrl(1, 'gso ', objectProperties(7200, 3600)), rec(TAG.SHAPE_COMPONENT, 2), listHeader(3), ...para(3, { text: 'boxed' }), ...para(0, { text: 'after' })]
    );
    expect(bodyBlocks(model).map(textOfBlock)).toEqual(['before', 'boxed', 'after']);
  });

  it('headers and footers are left out of the body', () => {
    const model = read([], [...para(0, { text: 'body' }), ...para(0, { units: controlUnits(16, 'head') }), ctrl(1, 'head', Buffer.alloc(8)), listHeader(2), ...para(2, { text: 'running header' })]);
    expect(bodyBlocks(model).map(textOfBlock)).toEqual(['body']);
  });

  it('a page-break paragraph starts a new page', () => {
    const model = read([], [...para(0, { text: 'one' }), ...para(0, { text: 'two', breakFlags: 0x04 })]);
    expect(bodyBlocks(model).map((block) => block.type)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
  });

  it('a picture is carried with its BinData bytes and displayed size', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const model = read(
      [binData(7, 'png')],
      [...para(0, { units: controlUnits(11, 'gso ') }), ctrl(1, 'gso ', objectProperties(7200, 3600)), rec(TAG.SHAPE_COMPONENT, 2), picture(3, 1)],
      { 'BinData/BIN0007.png': png }
    );
    const [image] = model.images;
    const placed = runsOf(first(model))[0].image;
    expect(Buffer.from(image.data).equals(png)).toBe(true);
    expect([image.format, placed?.widthPt, placed?.heightPt]).toEqual(['png', 72, 36]);
  });

  it('a picture that is not an image the model carries is left out with a warning', () => {
    const model = read([binData(1, 'wmf')], [...para(0, { units: controlUnits(11, 'gso ') }), ctrl(1, 'gso ', objectProperties(100, 100)), rec(TAG.SHAPE_COMPONENT, 2), picture(3, 1)], { 'BinData/BIN0001.wmf': Buffer.from('not an image') });
    expect(model.images).toHaveLength(0);
    expect(model.warnings).toEqual(['The picture BinData/BIN0001.wmf is not a PNG, JPEG, GIF, BMP, TIFF or SVG image and was left out.']);
  });

  it('tables keep merged cells, the header row and their caption', () => {
    const tableUnits = controlUnits(11, 'tbl ');
    const model = read(
      [],
      [
        ...para(0, { units: tableUnits }),
        ctrl(1, 'tbl '),
        listHeader(2),
        ...para(2, { text: 'Caption' }),
        table(2, 2, 3, true),
        cell(2, 0, 0, 2, 1),
        ...para(2, { text: 'wide head' }),
        cell(2, 2, 0, 1, 2),
        ...para(2, { text: 'tall' }),
        cell(2, 0, 1),
        ...para(2, { text: 'a' }),
        cell(2, 1, 1),
        ...para(2, { text: 'b' }),
      ]
    );
    const blocks = bodyBlocks(model);
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'table']);
    const grid = blocks[1] as TableBlock;
    expect(grid.rows.map((row) => [row.some((c) => c.header), row.filter((c) => !c.continuation).map((c) => `${cellBlocks(c).map(textOfBlock).join('')}:${c.colSpan}x${c.rowSpan}`)])).toEqual([
      [true, ['wide head:2x1', 'tall:1x2']],
      [false, ['a:1x1', 'b:1x1']],
    ]);
    expect(textOfBlock(blocks[0])).toBe('Caption');
  });
});

describe('malformed and hostile records fail with typed errors', () => {
  it('a paragraph that names a paragraph shape the document does not define', () => {
    const failure = (() => {
      try {
        read([paraShape()], [...para(0, { text: 'x', shape: 5 })]);
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: a paragraph names the missing paragraph shape 5.');
  });

  it('a table cell outside its grid', () => {
    const failure = (() => {
      try {
        read([], [...para(0, { units: controlUnits(11, 'tbl ') }), ctrl(1, 'tbl '), table(2, 1, 1), cell(2, 3, 0), ...para(2, { text: 'x' })]);
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: a table cell at row 0, column 3 lies outside its 1 x 1 table.');
  });

  it('a picture record shorter than its fixed fields', () => {
    const failure = (() => {
      try {
        read([binData(1, 'png')], [...para(0, { units: controlUnits(11, 'gso ') }), ctrl(1, 'gso ', objectProperties(1, 1)), rec(TAG.SHAPE_COMPONENT, 2), rec(TAG.PICTURE, 3, Buffer.alloc(10))]);
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: a picture record is shorter than its fixed fields.');
  });

  it('tables nested deeper than the limit', () => {
    // Each level is a paragraph holding a table whose only cell holds the next level.
    const build = (depth: number, level: number): RawRecord[] => {
      if (depth === 0) return para(level, { text: 'core' });
      return [...para(level, { units: controlUnits(11, 'tbl ') }), ctrl(level + 1, 'tbl '), table(level + 2, 1, 1), cell(level + 2, 0, 0), ...build(depth - 1, level + 2)];
    };
    const failure = (() => {
      try {
        read([], build(HWP_MAX_LIST_DEPTH + 4, 0));
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe(`Invalid HWP document: paragraph lists nest deeper than ${HWP_MAX_LIST_DEPTH} levels.`);
  });

  it('a section with more records than the limit is refused without being walked', async () => {
    const filler = { tagId: TAG.PARA_CHAR_SHAPE, level: 1, size: 0, payload: Buffer.alloc(0) };
    const records = Array.from({ length: HWP_MAX_RECORDS + 1 }, () => filler);
    const failure = await expectNoHang('record limit', () => {
      try {
        readHwpSections([], [records], () => undefined);
      } catch (err) {
        return err;
      }
      return undefined;
    });
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe(`The HWP document holds more than ${HWP_MAX_RECORDS} records.`);
  });

  it('a numbering definition cut off inside its levels', () => {
    const failure = (() => {
      try {
        read([rec(TAG.NUMBERING, 1, Buffer.alloc(20))], []);
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: a numbering record is cut off inside its level formats.');
  });
});

describe('HWP field command arguments', () => {
  it('reads the first argument and turns an escaped semicolon into a semicolon inside it', async () => {
    const { firstFieldArgument } = await import('../src/lib/conversions/hwp-reader');
    expect(firstFieldArgument('https://example.org/a;1;0;')).toBe('https://example.org/a');
    expect(firstFieldArgument('https://example.org/a\\;b=c;1;')).toBe('https://example.org/a;b=c');
    expect(firstFieldArgument('no-separator')).toBe('no-separator');
    expect(firstFieldArgument(';empty-first')).toBe('');
    expect(firstFieldArgument('trailing\\')).toBe('trailing\\');
  });
});
