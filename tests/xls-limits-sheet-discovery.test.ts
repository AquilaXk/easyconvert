import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertWorkbookFitsXls } from '../src/lib/conversions/office/xls-limits';
import { writeXlsx } from '../src/lib/conversions/xlsx-writer';
import { ConversionFailedError, SheetLimitError } from '../src/lib/types';

/**
 * The BIFF8 bound check has to cover every worksheet the office suite opens, because the suite cuts the rows past 65,536 without
 * a word. Each workbook below holds a sheet of 65,537 rows at a part that only the shape under test reaches: the part is outside
 * `xl/worksheets/` and no content type lists it. A short sheet in the same place passes, so the 413 comes from the extent of the
 * sheet and not from where it sits.
 */

const TALL_ROWS = 65_537;
const SHEET_PART = 'xl/sheets/data.xml';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';

const table = (rows: number): string[][] => Array.from({ length: rows }, () => ['x']);

interface Shape {
  /** The `sheet` element of the workbook, with the relationship id `rId1`. */
  sheet?: string;
  /** The `Target` of the relationship that names the sheet. */
  target?: string;
}

async function workbook(rows: number, shape: Shape = {}): Promise<JSZip> {
  const zip = await JSZip.loadAsync(await writeXlsx(table(rows), 'verbatim'));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  zip.remove('xl/worksheets/sheet1.xml');
  zip.file(SHEET_PART, sheetXml);
  const types = await zip.file('[Content_Types].xml')!.async('text');
  zip.file('[Content_Types].xml', types.replace(/<Override PartName="\/xl\/worksheets\/sheet1.xml"[^>]*\/>/, ''));
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('text');
  zip.file('xl/_rels/workbook.xml.rels', rels.replace('Target="worksheets/sheet1.xml"', `Target="${shape.target ?? 'sheets/data.xml'}"`));
  const book = await zip.file('xl/workbook.xml')!.async('text');
  zip.file('xl/workbook.xml', book.replace(/<sheet [^>]*\/>/, shape.sheet ?? '<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'));
  return zip;
}

const bytes = (zip: JSZip): Promise<Buffer> => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

async function expectRefused(zip: JSZip): Promise<void> {
  const failure = await assertWorkbookFitsXls(await bytes(zip)).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SheetLimitError);
  expect((failure as SheetLimitError).status).toBe(413);
}

const shapes: Array<[string, Shape]> = [
  ['a target that climbs out of the workbook directory', { target: '../xl/sheets/data.xml' }],
  ['an absolute target', { target: '/xl/sheets/data.xml' }],
  ['a sheet without a name', { sheet: '<sheet sheetId="1" r:id="rId1"/>' }],
  ['a sheet with an empty name', { sheet: '<sheet name="" sheetId="1" r:id="rId1"/>' }],
  ['a relationship id under another prefix', { sheet: '<sheet name="Sheet1" sheetId="1" xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships" q:id="rId1"/>' }],
];

describe('the .xls bounds of the sheets an office suite opens', () => {
  let fitting: JSZip;
  beforeAll(async () => {
    fitting = await workbook(3);
  });

  it('pass a short sheet at a part only the relationship reaches', async () => {
    await expect(assertWorkbookFitsXls(await bytes(fitting))).resolves.toBeUndefined();
  });

  it.each(shapes)('reach %s', async (_name, shape) => {
    await expect(assertWorkbookFitsXls(await bytes(await workbook(3, shape)))).resolves.toBeUndefined();
    await expectRefused(await workbook(TALL_ROWS, shape));
  });

  it('reach the workbook that the root relationships name, when it is not xl/workbook.xml', async () => {
    const build = async (rows: number): Promise<JSZip> => {
      const zip = await workbook(rows);
      const book = await zip.file('xl/workbook.xml')!.async('text');
      const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('text');
      zip.file('xl/other.xml', book);
      zip.file('xl/_rels/other.xml.rels', rels);
      zip.file('xl/workbook.xml', book.replace(/<sheet [^>]*\/>/, '<sheet name="Short" sheetId="1" r:id="rId9"/>'));
      zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${PACKAGE_NAMESPACE}"><Relationship Id="rId9" Type="${RELATIONSHIPS_NAMESPACE}/worksheet" Target="short.xml"/></Relationships>`);
      zip.file('xl/short.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>');
      zip.file(
        '_rels/.rels',
        `<Relationships xmlns="${PACKAGE_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIPS_NAMESPACE}/officeDocument" Target="xl/other.xml"/></Relationships>`
      );
      return zip;
    };
    await expect(assertWorkbookFitsXls(await bytes(await build(3)))).resolves.toBeUndefined();
    await expectRefused(await build(TALL_ROWS));
  });

  it('refuse a workbook that lists a sheet whose part is not in the package, instead of passing it unchecked', async () => {
    const zip = await workbook(3);
    zip.remove(SHEET_PART);
    const failure = await assertWorkbookFitsXls(await bytes(zip)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe(`The workbook lists a sheet at "${SHEET_PART}", which is not in the package, so it cannot be checked against the .xls bounds.`);
  });
});
