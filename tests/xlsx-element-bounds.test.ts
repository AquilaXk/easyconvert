import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { OPC_MAX_RELATIONSHIPS_SCANNED } from '../src/lib/conversions/office/opc-parts';
import { assertWorkbookFitsXls } from '../src/lib/conversions/office/xls-limits';
import { XLSX_MAX_RANGES_PER_WORKBOOK, XLSX_MAX_SHEETS } from '../src/lib/conversions/office/xlsx-sheets';
import { writeXlsx } from '../src/lib/conversions/xlsx-writer';
import { DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { sofficeConvert } from './helpers/soffice-office';
import { DEFAULT_HANG_GUARD_MS, cpuClockMs, expectSizeIndependentOnInputs } from './helpers/timing';

/**
 * The lists a worksheet part carries beside its cells (merged ranges, hyperlinks, relationships) and the list of sheets of a
 * workbook are taken one element at a time into their final shape and bounded, so that a few hundred kilobytes of repeated
 * elements cannot ask for gigabytes of heap or minutes of CPU. Merged ranges and hyperlinks past their bound are left out and the
 * conversion goes on; relationships scanned past theirs, and sheets past theirs, are refused (413). Each hostile package below is
 * a few hundred kilobytes compressed. CPU time is read, not wall-clock time: it does not count the time a busy runner keeps the
 * process waiting.
 */

const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MERGE = '<mergeCell ref="A1:B2"/>';
const MILLIONS = 3_000_000;

/** The worksheet root of the writer declares the main namespace only; a sheet with `r:id` attributes declares the relationships one as well. */
const withRelationshipsNamespace = (sheet: string): string => sheet.replace('<worksheet ', `<worksheet xmlns:r="${RELATIONSHIPS_NAMESPACE}" `);

async function workbookWith(sheetTail: string, extra: (zip: JSZip) => void = () => undefined): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await writeXlsx([['a']], 'verbatim'));
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  zip.file('xl/worksheets/sheet1.xml', withRelationshipsNamespace(sheet).replace('</worksheet>', `${sheetTail}</worksheet>`));
  extra(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A copy of the first worksheet as sheet `index`, listed in the workbook and its relationships under the name `S<index>`. */
async function addSheetCopy(zip: JSZip, index: number, relationshipsPart: string | Buffer | undefined): Promise<void> {
  zip.file(`xl/worksheets/sheet${index}.xml`, await zip.file('xl/worksheets/sheet1.xml')!.async('text'));
  if (relationshipsPart !== undefined) zip.file(`xl/worksheets/_rels/sheet${index}.xml.rels`, relationshipsPart);
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('text')).replace('</sheets>', `<sheet name="S${index}" sheetId="${index}" r:id="rIdS${index}"/></sheets>`));
  zip.file(
    'xl/_rels/workbook.xml.rels',
    (await zip.file('xl/_rels/workbook.xml.rels')!.async('text')).replace(
      '</Relationships>',
      `<Relationship Id="rIdS${index}" Type="${RELATIONSHIPS_NAMESPACE}/worksheet" Target="worksheets/sheet${index}.xml"/></Relationships>`
    )
  );
}

const mergeCells = (count: number): string => `<mergeCells count="${count}">${MERGE.repeat(count)}</mergeCells>`;

/** A workbook whose `sheets` list holds `sheets`, each a `sheet` element that names `rId1`, the one worksheet part. */
async function workbookListing(sheets: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await writeXlsx([['a']], 'verbatim'));
  const book = await zip.file('xl/workbook.xml')!.async('text');
  zip.file('xl/workbook.xml', book.replace(/<sheets>.*<\/sheets>/, `<sheets>${sheets}</sheets>`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const sheetElements = (count: number, nameOf: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => `<sheet name="${nameOf(index)}" sheetId="${index + 1}" r:id="rId1"/>`).join('');

async function refusal<T>(run: () => Promise<T>): Promise<{ failure: unknown; cpuMs: number }> {
  const started = cpuClockMs();
  const failure = await run().then(
    () => undefined,
    (error: unknown) => error
  );
  return { failure, cpuMs: cpuClockMs() - started };
}

function expectPayloadLimit(failure: unknown, message: RegExp): void {
  expect(failure).toBeInstanceOf(PayloadLimitError);
  expect((failure as PayloadLimitError).status).toBe(413);
  expect((failure as Error).message).toMatch(message);
}

describe('merged ranges of a worksheet', () => {
  it('are all returned up to the bound', async () => {
    const [sheet] = await parseAllXlsxWorksheets(await workbookWith(mergeCells(100_000)));
    expect(sheet.mergedRanges).toHaveLength(100_000);
    expect(sheet.mergedRanges![99_999]).toEqual({ startRow: 0, endRow: 1, startCol: 0, endCol: 1 });
  });

  it('stop at the bound, in bounded CPU time, when millions of them are listed in a small file, and the sheet is still read', async () => {
    const hostile = await workbookWith(mergeCells(MILLIONS));
    expect(hostile.length).toBeLessThan(1024 * 1024);
    const started = cpuClockMs();
    const [sheet] = await parseAllXlsxWorksheets(hostile);
    const cpuMs = cpuClockMs() - started;
    expect(sheet.mergedRanges).toHaveLength(XLSX_MAX_RANGES_PER_WORKBOOK);
    expect(sheet.rows[0]).toEqual(['a']);
    expect(cpuMs, `took ${cpuMs.toFixed(0)} ms of CPU`).toBeLessThan(DEFAULT_HANG_GUARD_MS);
  }, 60_000);

  it('are counted for the whole workbook, not for each sheet', async () => {
    const half = Math.ceil(XLSX_MAX_RANGES_PER_WORKBOOK / 2) + 1;
    const zip = await JSZip.loadAsync(await workbookWith(mergeCells(half)));
    await addSheetCopy(zip, 2, undefined);
    const sheets = await parseAllXlsxWorksheets(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    expect(sheets.map((sheet) => sheet.mergedRanges?.length)).toEqual([half, XLSX_MAX_RANGES_PER_WORKBOOK - half]);
  }, 60_000);

  it('leave the target that shows none its output: a workbook past the bound still converts to CSV', async () => {
    const converted = await convertFile(await workbookWith(mergeCells(MILLIONS)), 'xlsx', 'csv', {}, 'book.xlsx');
    expect(converted.buffer.toString('utf-8').trim()).toBe('a');
  }, 60_000);
});

describe('hyperlinks of a worksheet', () => {
  const LINKS = 70_000;
  const locationLinks = (count: number): string =>
    `<hyperlinks>${Array.from({ length: count }, (_, index) => `<hyperlink ref="A${index + 1}" location="Sheet1!A1"/>`).join('')}</hyperlinks>`;
  /** The shape LibreOffice writes: a `hyperlink` with `r:id` and `display` for each link, and an external `Relationship` for each. */
  const libreOfficeLinks = (count: number): { sheetTail: string; relationships: string } => ({
    sheetTail: `<hyperlinks>${Array.from({ length: count }, (_, index) => `<hyperlink ref="A${index + 1}" r:id="rId${index + 1}" display="l${index}"/>`).join('')}</hyperlinks>`,
    relationships: `<Relationships xmlns="${PACKAGE_NAMESPACE}">${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIPS_NAMESPACE}/hyperlink" Target="https://example.com/p/${index}" TargetMode="External"/>`).join('')}</Relationships>`,
  });

  it('are all returned past 65,530, the most Excel writes: a reader is not an author', async () => {
    const [sheet] = await parseAllXlsxWorksheets(await workbookWith(locationLinks(LINKS)));
    expect(sheet.hyperlinks).toHaveLength(LINKS);
    expect(sheet.hyperlinks![LINKS - 1]).toEqual({ row: LINKS - 1, col: 0, target: '#Sheet1!A1' });
  });

  describe('of a sheet with 70,000 links and 70,000 relationships, as LibreOffice saves a column of URLs', () => {
    const expectReadAndConverted = async (workbook: Buffer): Promise<void> => {
      const [sheet] = await parseAllXlsxWorksheets(workbook);
      expect(sheet.hyperlinks).toHaveLength(LINKS);
      expect(sheet.hyperlinks![0]).toEqual({ row: 0, col: 0, target: 'https://example.com/p/0' });
      expect(sheet.hyperlinks![LINKS - 1]).toEqual({ row: LINKS - 1, col: 0, target: `https://example.com/p/${LINKS - 1}` });
      for (const target of ['csv', 'tsv', 'json']) {
        const converted = await convertFile(workbook, 'xlsx', target, {}, 'links.xlsx');
        expect(converted.buffer.length, target).toBeGreaterThan(0);
      }
    };

    it('are read and convert to CSV, TSV and JSON, as they do on main', async () => {
      const { sheetTail, relationships } = libreOfficeLinks(LINKS);
      const rows = Array.from({ length: LINKS }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>l${index}</t></is></c></row>`).join('');
      const workbook = await workbookWith(sheetTail, (zip) => {
        zip.file('xl/worksheets/_rels/sheet1.xml.rels', relationships);
        zip.file('xl/worksheets/sheet1.xml', withRelationshipsNamespace(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${sheetTail}</worksheet>`));
      });
      await expectReadAndConverted(workbook);
    }, 60_000);

    oracleTest('are read and convert from a workbook the office suite wrote', ['soffice'], async () => {
      const namespaces = [
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
        'xmlns:xlink="http://www.w3.org/1999/xlink"',
      ].join(' ');
      const rows = Array.from(
        { length: LINKS },
        (_, index) => `<table:table-row><table:table-cell office:value-type="string"><text:p><text:a xlink:href="https://example.com/p/${index}">l${index}</text:a></text:p></table:table-cell></table:table-row>`
      ).join('');
      const flat = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><office:document ${namespaces} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet><table:table table:name="Data">${rows}</table:table></office:spreadsheet></office:body></office:document>`,
        'utf-8'
      );
      await expectReadAndConverted(sofficeConvert(flat, 'fods', 'xlsx', 'xlsx'));
    }, 240_000);
  });

  it('count against the workbook allowance only: links past it are left out, and the sheet is still read', async () => {
    const [sheet] = await parseAllXlsxWorksheets(await workbookWith(`${mergeCells(XLSX_MAX_RANGES_PER_WORKBOOK - 2)}${locationLinks(5)}`));
    expect(sheet.mergedRanges).toHaveLength(XLSX_MAX_RANGES_PER_WORKBOOK - 2);
    expect(sheet.hyperlinks).toHaveLength(2);
    expect(sheet.rows[0]).toEqual(['a']);
  }, 60_000);
});

describe('relationships of a part', () => {
  const LISTED = 150_000;
  const listing = (count: number): string =>
    `<Relationships xmlns="${PACKAGE_NAMESPACE}">${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIPS_NAMESPACE}/hyperlink" Target="https://example.com/${index}" TargetMode="External"/>`).join('')}</Relationships>`;
  const linkTo = (id: string): string => `<hyperlinks><hyperlink ref="A1" r:id="${id}"/></hyperlinks>`;

  it('are read for the ids that the links of the sheet name, however many the part lists', async () => {
    const workbook = await workbookWith(linkTo(`rId${LISTED}`), (zip) => zip.file('xl/worksheets/_rels/sheet1.xml.rels', listing(LISTED)));
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.hyperlinks).toEqual([{ row: 0, col: 0, target: `https://example.com/${LISTED - 1}` }]);
  }, 60_000);

  it('are not read at all for a sheet whose links name none, so that a part of any size costs nothing', async () => {
    const withoutIds = '<hyperlinks><hyperlink ref="A1" location="Sheet1!B2"/></hyperlinks>';
    const [sheet] = await parseAllXlsxWorksheets(await workbookWith(withoutIds, (zip) => zip.file('xl/worksheets/_rels/sheet1.xml.rels', 'not xml at all, and never read')));
    expect(sheet.hyperlinks).toEqual([{ row: 0, col: 0, target: '#Sheet1!B2' }]);
  });

  describe('of many sheets', () => {
    /** The parts are runs of the shortest element the reader counts: the scan, not the bytes, is what the allowance bounds. */
    const SHEETS_PAST_THE_ALLOWANCE = 70;
    const ELEMENTS_PER_PART = Math.ceil(OPC_MAX_RELATIONSHIPS_SCANNED / SHEETS_PAST_THE_ALLOWANCE) + 1;

    async function sheetsWithRelationships(sheets: number): Promise<Buffer> {
      const part = `<Relationships xmlns="${PACKAGE_NAMESPACE}"><Relationship Id="rId1" Target="https://example.com/" TargetMode="External"/>${'<Relationship/>'.repeat(ELEMENTS_PER_PART)}</Relationships>`;
      const zip = await JSZip.loadAsync(await workbookWith(linkTo('rId1'), (book) => book.file('xl/worksheets/_rels/sheet1.xml.rels', part)));
      for (let index = 2; index <= sheets; index++) await addSheetCopy(zip, index, part);
      return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    it(`are refused with a 413 once ${OPC_MAX_RELATIONSHIPS_SCANNED} relationships were scanned, and the refusal costs the same for 4 times the sheets`, async () => {
      const modest = await sheetsWithRelationships(SHEETS_PAST_THE_ALLOWANCE);
      const huge = await sheetsWithRelationships(SHEETS_PAST_THE_ALLOWANCE * 4);
      expect(huge.length).toBeLessThan(1024 * 1024);
      const { failure } = await refusal(() => parseAllXlsxWorksheets(modest));
      expectPayloadLimit(failure, new RegExp(`more than ${OPC_MAX_RELATIONSHIPS_SCANNED} relationships in all`));
      await expectSizeIndependentOnInputs(
        'the refusal of sheets past the allowance',
        async (workbook: Buffer) => (await refusal(() => parseAllXlsxWorksheets(workbook))).failure,
        { modest, huge, passes: 2, clock: cpuClockMs }
      );
    }, 120_000);

    it('are read for a workbook within the allowance', async () => {
      const sheets = await parseAllXlsxWorksheets(await sheetsWithRelationships(SHEETS_PAST_THE_ALLOWANCE - 2));
      expect(sheets).toHaveLength(SHEETS_PAST_THE_ALLOWANCE - 2);
      expect(sheets.every((sheet) => sheet.hyperlinks?.[0]?.target === 'https://example.com/')).toBe(true);
    }, 60_000);
  });

  it('are charged to the decoded-byte budget of the workbook: three parts of 100 MiB each, which the cap of one part allows, are refused', async () => {
    const part = Buffer.concat([Buffer.from(`<Relationships xmlns="${PACKAGE_NAMESPACE}"/>`), Buffer.alloc(100 * 1024 * 1024, 0x20)]);
    const zip = await JSZip.loadAsync(await workbookWith(linkTo('rId1'), (book) => book.file('xl/worksheets/_rels/sheet1.xml.rels', part)));
    await addSheetCopy(zip, 2, part);
    await addSheetCopy(zip, 3, part);
    const hostile = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const { failure } = await refusal(() => parseAllXlsxWorksheets(hostile));
    expect(failure).toBeInstanceOf(DecompressionLimitError);
    expect((failure as DecompressionLimitError).status).toBe(413);
    expect((failure as Error).message).toMatch(/decoded-byte budget/);
  }, 120_000);
});

describe('sheets of a workbook', () => {
  it('are listed once each by their part, so one sheet listed a few times is read once', async () => {
    const sheets = await parseAllXlsxWorksheets(await workbookListing(sheetElements(5, (index) => `Copy${index}`)));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Copy0']);
  });

  it('are refused with a 413, quickly, when one is listed 100,000 times, for the reader and for the .xls check', async () => {
    const hostile = await workbookListing(sheetElements(100_000, (index) => `S${index}`));
    expect(hostile.length).toBeLessThan(1024 * 1024);
    const runs: Array<() => Promise<unknown>> = [() => parseAllXlsxWorksheets(hostile), () => assertWorkbookFitsXls(hostile)];
    for (const run of runs) {
      const { failure, cpuMs } = await refusal(run);
      expectPayloadLimit(failure, new RegExp(`more than ${XLSX_MAX_SHEETS} sheets`));
      expect(cpuMs, `took ${cpuMs.toFixed(0)} ms of CPU`).toBeLessThan(DEFAULT_HANG_GUARD_MS);
    }
  });

  it('are accepted up to the bound', async () => {
    const book = await workbookListing(sheetElements(XLSX_MAX_SHEETS, (index) => `S${index}`));
    await expect(assertWorkbookFitsXls(book)).resolves.toBeUndefined();
    await expect(parseAllXlsxWorksheets(book)).resolves.toHaveLength(1);
  });
});
