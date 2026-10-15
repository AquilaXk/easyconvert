import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { checkConversionOutput } from '../src/lib/conversions/output-check';
import { InvalidConversionOutputError } from '../src/lib/types';
import { craftDocx } from './helpers/docx-craft';

/**
 * No conversion returns an empty or invalid file as a success (#671). Inputs are written from ECMA-376 markup with
 * nothing in them, so the expectation (no content) does not come from the readers.
 */

const HTTP_SERVER_ERROR = 500;
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const resultOf = (text: string | Buffer) => {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return { buffer, size: buffer.length, filePath: undefined as string | undefined, metadata: undefined as Record<string, unknown> | undefined };
};

async function emptyWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('final output check', () => {
  it('returns an empty or blank text target as a success that carries a warning', async () => {
    for (const target of ['txt', 'md', 'csv', 'tsv']) {
      for (const blank of [Buffer.alloc(0), Buffer.from(' \r\n\t')]) {
        const checked = await checkConversionOutput(resultOf(blank), 'xlsx', target);
        expect(checked.buffer).toEqual(blank);
        expect(checked.metadata).toEqual({ emptyOutput: true });
      }
    }
  });

  it('refuses container bytes under a text target with a typed 500', async () => {
    for (const bytes of [Buffer.from('PK\u0003\u0004rest', 'latin1'), Buffer.from('%PDF-1.7\n'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])]) {
      await expect(checkConversionOutput(resultOf(bytes), 'xlsm', 'csv')).rejects.toThrow('The conversion of the .xlsm file to .csv produced bytes that are not a .csv file.');
    }
    expect(new InvalidConversionOutputError('xlsm', 'csv')).toMatchObject({ status: HTTP_SERVER_ERROR });
  });

  it('lets text through unchanged, including an HTML page and a same-format copy', async () => {
    const passes = async (text: string | Buffer, source: string, target: string) => {
      const checked = await checkConversionOutput(resultOf(text), source, target);
      expect(checked.metadata).toBeUndefined();
      return checked.buffer.toString('latin1');
    };
    expect(await passes('Region,Units\nNorth,12\n', 'xlsx', 'csv')).toBe('Region,Units\nNorth,12\n');
    expect(await passes('<!DOCTYPE html><html><body></body></html>', 'docx', 'html')).toContain('<body></body>');
    expect(await passes('\n', 'txt', 'txt')).toBe('\n');
    expect(await passes(Buffer.from('PK\u0003\u0004', 'latin1'), 'docx', 'pdf')).toBe('PK\u0003\u0004');
  });

  it('accepts a ZIP declared as the archive of a split conversion when every member is text, and no other ZIP', async () => {
    const archive = (members: Record<string, string | Buffer>) => {
      const zip = new JSZip();
      for (const [name, content] of Object.entries(members)) zip.file(name, content);
      return zip.generateAsync({ type: 'nodebuffer' });
    };
    const declared = async (buffer: Buffer) => ({ ...resultOf(buffer), mimeType: 'application/zip' });
    const fine = await archive({ 'b-Sheet1.csv': 'a,b\n1,2\n', 'b-Sheet2.csv': '' });
    expect((await checkConversionOutput(await declared(fine), 'xlsx', 'csv')).buffer).toEqual(fine);
    const withBinary = await archive({ 'b-Sheet1.csv': 'a,b\n', 'b-Sheet2.csv': Buffer.from('PK\u0003\u0004x', 'latin1') });
    await expect(checkConversionOutput(await declared(withBinary), 'xlsx', 'csv')).rejects.toThrow('produced bytes that are not a .csv file');
    await expect(checkConversionOutput(await declared(Buffer.from('not a zip at all')), 'xlsx', 'csv')).rejects.toThrow('produced bytes that are not a .csv file');
    await expect(checkConversionOutput(resultOf(fine), 'xlsx', 'csv')).rejects.toThrow('produced bytes that are not a .csv file');
  });

  it('reads the head of an output left on disk, and never judges a long whitespace output as empty', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'output-check-')), 'out.csv');
    fs.writeFileSync(file, Buffer.from('PK\u0003\u0004 and more', 'latin1'));
    const onDisk = { filePath: file, size: fs.statSync(file).size, get buffer(): Buffer { throw new Error('the whole file must not be read'); } };
    await expect(checkConversionOutput(onDisk, 'xlsm', 'csv')).rejects.toBeInstanceOf(InvalidConversionOutputError);
    expect((await checkConversionOutput(resultOf(' '.repeat(100_000)), 'docx', 'txt')).metadata).toBeUndefined();
  });
});

const EMPTY_WARNING = { emptyOutput: true };

async function workbookOf(sheets: string[][][]): Promise<Buffer> {
  const strings: string[] = [];
  const zip = new JSZip();
  const overrides = sheets.map((_, n) => `<Override PartName="/xl/worksheets/sheet${n + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${sheets.map((_, n) => `<sheet name="Part${n + 1}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join('')}</sheets></workbook>`);
  const relationships = sheets.map((_, n) => `<Relationship Id="rId${n + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`).join('');
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}">${relationships}<Relationship Id="rId99" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  sheets.forEach((rows, n) => {
    const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((text, c) => { strings.push(text); return `<c r="${'ABC'[c]}${r + 1}" t="s"><v>${strings.length - 1}</v></c>`; }).join('')}</row>`).join('');
    zip.file(`xl/worksheets/sheet${n + 1}.xml`, `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>${body}</sheetData></worksheet>`);
  });
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="${SHEET_NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('conversions of inputs without content', () => {
  it('returns an empty workbook written as CSV or TSV, and an empty document written as text, as an empty file with a warning', async () => {
    const workbook = await emptyWorkbook();
    for (const target of ['csv', 'tsv']) {
      const result = await dispatchConversion(workbook, 'xlsx', target, {}, 'empty.xlsx');
      expect(result.buffer.toString('utf-8').trim()).toBe('');
      expect(result.metadata).toEqual(EMPTY_WARNING);
    }
    const document = await craftDocx({ body: '<w:p/>' });
    for (const target of ['txt', 'md']) {
      const result = await dispatchConversion(document, 'docx', target, {}, 'empty.docx');
      expect(result.buffer.toString('utf-8').trim()).toBe('');
      expect(result.metadata).toEqual(EMPTY_WARNING);
    }
  });

  it('returns a page that is only a frameset, written as text or Markdown, as an empty file with a warning', async () => {
    const frameset = Buffer.from('<frameset cols="*,300"><frame src="a.php"><frame src="b.php"></frameset>');
    for (const target of ['txt', 'md']) {
      const result = await dispatchConversion(frameset, 'html', target, {}, 'frames.html');
      expect(result.buffer.toString('utf-8').trim()).toBe('');
      expect(result.metadata).toEqual(EMPTY_WARNING);
    }
  });
});

describe('split-sheet conversions through the dispatcher', () => {
  const SHEETS = [
    [['Region', 'Units'], ['North', '12']],
    [['Item', 'Price'], ['Pen', '3']],
    [['Name', 'Note'], ['Ann', 'ok']],
  ];

  it.each([['csv', ','], ['tsv', '\t']])('returns one %s file per sheet in a ZIP, each holding that sheet\'s cells', async (target, delimiter) => {
    const workbook = await workbookOf(SHEETS);
    const result = await dispatchConversion(workbook, 'xlsx', target, { sheetMode: 'split' }, 'book.xlsx');
    expect(result.mimeType).toBe('application/zip');
    const zip = await JSZip.loadAsync(result.buffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(SHEETS.map((_, n) => `book-Part${n + 1}.${target}`));
    for (const [n, rows] of SHEETS.entries()) {
      const text = await zip.file(names[n])!.async('string');
      expect(text.trim().split(/\r?\n/).map((line) => line.split(delimiter))).toEqual(rows);
    }
  });
});
