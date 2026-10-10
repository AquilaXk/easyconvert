import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { assertUsableOutput } from '../src/lib/conversions/output-check';
import { InvalidConversionOutputError, NoConvertibleContentError } from '../src/lib/types';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { craftDocx } from './helpers/docx-craft';

/**
 * No conversion returns an empty or invalid file as a success (#671). Inputs are written from ECMA-376 markup with
 * nothing in them, so the expectation (no content) does not come from the readers.
 */

const HTTP_UNPROCESSABLE = 422;
const HTTP_SERVER_ERROR = 500;
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const resultOf = (text: string | Buffer) => {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return { buffer, size: buffer.length, filePath: undefined };
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
  it('refuses an empty or blank text target with a typed 422 that names both formats', () => {
    for (const target of ['txt', 'md', 'csv', 'tsv']) {
      const run = () => assertUsableOutput(resultOf(' \r\n\t'), 'xlsx', target);
      expect(run).toThrow(NoConvertibleContentError);
      expect(run).toThrow(`The .xlsx file holds no content to write as .${target}.`);
    }
    expect(classifyJobFailure(new NoConvertibleContentError('xlsx', 'csv'))).toMatchObject({ status: HTTP_UNPROCESSABLE, retryable: false });
    expect(() => assertUsableOutput(resultOf(Buffer.alloc(0)), 'docx', 'txt')).toThrow(NoConvertibleContentError);
  });

  it('refuses container bytes under a text target with a typed 500', () => {
    for (const bytes of [Buffer.from('PK\u0003\u0004rest', 'latin1'), Buffer.from('%PDF-1.7\n'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])]) {
      expect(() => assertUsableOutput(resultOf(bytes), 'xlsm', 'csv')).toThrow(InvalidConversionOutputError);
    }
    expect(new InvalidConversionOutputError('xlsm', 'csv')).toMatchObject({ status: HTTP_SERVER_ERROR });
  });

  it('lets text through, including an HTML page and a same-format copy', () => {
    expect(() => assertUsableOutput(resultOf('Region,Units\nNorth,12\n'), 'xlsx', 'csv')).not.toThrow();
    expect(() => assertUsableOutput(resultOf('<!DOCTYPE html><html><body></body></html>'), 'docx', 'html')).not.toThrow();
    expect(() => assertUsableOutput(resultOf('\n'), 'txt', 'txt')).not.toThrow();
    expect(() => assertUsableOutput(resultOf(Buffer.from('PK\u0003\u0004', 'latin1')), 'docx', 'pdf')).not.toThrow();
  });

  it('reads the head of an output left on disk, and never judges a long whitespace output as empty', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'output-check-')), 'out.csv');
    fs.writeFileSync(file, Buffer.from('PK\u0003\u0004 and more', 'latin1'));
    const onDisk = { filePath: file, size: fs.statSync(file).size, get buffer(): Buffer { throw new Error('the whole file must not be read'); } };
    expect(() => assertUsableOutput(onDisk, 'xlsm', 'csv')).toThrow(InvalidConversionOutputError);
    expect(() => assertUsableOutput(resultOf(' '.repeat(100_000)), 'docx', 'txt')).not.toThrow();
  });
});

describe('conversions of inputs without content', () => {
  it('answers an empty workbook written as CSV or TSV, and an empty document written as text, with the typed refusal', async () => {
    const workbook = await emptyWorkbook();
    for (const target of ['csv', 'tsv']) {
      await expect(dispatchConversion(workbook, 'xlsx', target, {}, 'empty.xlsx')).rejects.toBeInstanceOf(NoConvertibleContentError);
    }
    const document = await craftDocx({ body: '<w:p/>' });
    await expect(dispatchConversion(document, 'docx', 'txt', {}, 'empty.docx')).rejects.toBeInstanceOf(NoConvertibleContentError);
  });

  it('answers a page that is only a frameset, written as text or Markdown, with the typed refusal', async () => {
    const frameset = Buffer.from('<frameset cols="*,300"><frame src="a.php"><frame src="b.php"></frameset>');
    for (const target of ['txt', 'md']) {
      await expect(dispatchConversion(frameset, 'html', target, {}, 'frames.html')).rejects.toBeInstanceOf(NoConvertibleContentError);
    }
  });
});
