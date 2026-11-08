import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { dispatchConversion as convertFile } from '../src/lib/conversions/dispatch';
import { ConversionFailedError } from '../src/lib/types';
import { craftDocx, paragraph } from './helpers/docx-craft';

/**
 * The pairs that once answered with an empty or unusable file: a page, workbook or template with nothing to write is an
 * empty file with an `emptyOutput` warning (policy entry 8), content is written, and a package that cannot be read
 * one way only is a typed refusal. The inputs are written from ECMA-376 and the HTML standard, not from the readers.
 */

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const EXCEL_MACRO_TYPE = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml';
const WORD_TEMPLATE_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml';
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const EMPTY_WARNING = { emptyOutput: true };

/** A workbook of the given sheets: each is a list of rows of inline strings; an empty list is an empty `sheetData`. */
async function workbook(sheets: string[][][], mainType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'): Promise<Buffer> {
  const zip = new JSZip();
  const overrides = sheets.map((_, n) => `<Override PartName="/xl/worksheets/sheet${n + 1}.xml" ContentType="${SHEET_TYPE}"/>`).join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${mainType}"/>${overrides}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${sheets.map((_, n) => `<sheet name="Part${n + 1}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}">${sheets.map((_, n) => `<Relationship Id="rId${n + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((rows, n) => {
    const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((text, c) => `<c r="${'ABC'[c]}${r + 1}" t="inlineStr"><is><t>${text}</t></is></c>`).join('')}</row>`).join('');
    zip.file(`xl/worksheets/sheet${n + 1}.xml`, `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>${body}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function template(body: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await craftDocx({ body }));
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WORD_TEMPLATE_TYPE}"/></Types>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const text = (result: { buffer: Buffer }) => result.buffer.toString('utf-8');

describe('html to txt and md', () => {
  const FRAMESET = '<META HTTP-EQUIV="expires" VALUE="Thu, 16 Mar 2000 11:00:00 GMT"><frameset cols="*,300"><frame src="a.php?num=1"><frame src="b.php"></frameset>';

  it.each(['txt', 'md'])('writes a page that is only a frameset as an empty file with a warning (%s)', async (target) => {
    const result = await convertFile(Buffer.from(FRAMESET), 'html', target, {}, 'frames.html');
    expect(text(result).trim()).toBe('');
    expect(result.metadata).toEqual(EMPTY_WARNING);
  });

  it.each(['txt', 'md'])('writes the words of a page with content (%s)', async (target) => {
    const result = await convertFile(Buffer.from('<html><body><h1>Harbour</h1><p>Ships leave at noon.</p></body></html>'), 'html', target, {}, 'page.html');
    expect(text(result)).toContain('Harbour');
    expect(text(result)).toContain('Ships leave at noon.');
    expect(result.metadata?.emptyOutput).toBeUndefined();
  });
});

describe('xlsx and xlsm to csv and tsv', () => {
  it.each([['xlsx', 'csv'], ['xlsx', 'tsv'], ['xlsm', 'csv']])('writes a workbook with no cell as an empty file with a warning (%s to %s)', async (source, target) => {
    const input = await workbook([[]], source === 'xlsm' ? EXCEL_MACRO_TYPE : undefined);
    const result = await convertFile(input, source, target, {}, `empty.${source}`);
    expect(text(result).trim()).toBe('');
    expect(result.metadata).toEqual(EMPTY_WARNING);
  });

  it.each([['xlsx', 'csv', ','], ['xlsx', 'tsv', '\t'], ['xlsm', 'csv', ',']])('writes the cells of a later sheet when the sheets before it are empty (%s to %s)', async (source, target, delimiter) => {
    const input = await workbook([[], [['Region', 'Units'], ['North', '12']]], source === 'xlsm' ? EXCEL_MACRO_TYPE : undefined);
    const result = await convertFile(input, source, target, {}, `book.${source}`);
    const lines = text(result).split(/\r?\n/);
    expect(lines).toContain(['Region', 'Units'].join(delimiter));
    expect(lines).toContain(['North', '12'].join(delimiter));
    expect(result.metadata?.emptyOutput).toBeUndefined();
  });

  it('refuses a workbook that holds one part name twice, as a typed error, and not as an empty file', async () => {
    // Two sheet parts are written under two names, then one name is made equal to the other in both ZIP headers.
    const input = await workbook([[['v1']], [['v2']]]);
    const duplicated = Buffer.from(input.toString('latin1').replaceAll('sheet2.xml', 'sheet1.xml'), 'latin1');
    for (const target of ['csv', 'tsv']) {
      await expect(convertFile(duplicated, 'xlsx', target, {}, 'twice.xlsx')).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(convertFile(duplicated, 'xlsx', target, {}, 'twice.xlsx')).rejects.toThrow('more than once');
    }
  });
});

describe('dotx to txt', () => {
  it('writes a template with no text as an empty file with a warning', async () => {
    const result = await convertFile(await template('<w:p/>'), 'dotx', 'txt', {}, 'blank.dotx');
    expect(text(result).trim()).toBe('');
    expect(result.metadata).toEqual(EMPTY_WARNING);
  });

  it('writes the paragraphs of a template', async () => {
    const result = await convertFile(await template(paragraph('Dear reader') + paragraph('Yours truly')), 'dotx', 'txt', {}, 'letter.dotx');
    expect(text(result)).toContain('Dear reader');
    expect(text(result)).toContain('Yours truly');
    expect(result.metadata?.emptyOutput).toBeUndefined();
  });
});
