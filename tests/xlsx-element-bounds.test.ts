import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { assertWorkbookFitsXls } from '../src/lib/conversions/office/xls-limits';
import { XLSX_MAX_HYPERLINKS_PER_SHEET, XLSX_MAX_PART_ENTRIES, XLSX_MAX_RANGES_PER_WORKBOOK, XLSX_MAX_SHEETS } from '../src/lib/conversions/office/xlsx-sheets';
import { writeXlsx } from '../src/lib/conversions/xlsx-writer';
import { PayloadLimitError } from '../src/lib/types';
import { DEFAULT_HANG_GUARD_MS, cpuClockMs } from './helpers/timing';

/**
 * The lists a worksheet part carries beside its cells (merged ranges, hyperlinks, relationships) and the list of sheets of a
 * workbook are taken one element at a time into their final shape and refused (413) past a bound, so that a few hundred kilobytes
 * of repeated elements cannot ask for gigabytes of heap or minutes of CPU. Each hostile package below is a few hundred kilobytes
 * compressed. CPU time is read, not wall-clock time: it does not count the time a busy runner keeps the process waiting.
 */

const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MERGE = '<mergeCell ref="A1:B2"/>';
const MILLIONS = 3_000_000;

async function workbookWith(sheetTail: string, extra: (zip: JSZip) => void = () => undefined): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await writeXlsx([['a']], 'verbatim'));
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
  zip.file('xl/worksheets/sheet1.xml', sheet.replace('</worksheet>', `${sheetTail}</worksheet>`));
  extra(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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

  it('are refused with a 413 in bounded CPU time when millions of them are listed in a small file', async () => {
    const hostile = await workbookWith(mergeCells(MILLIONS));
    expect(hostile.length).toBeLessThan(1024 * 1024);
    const { failure, cpuMs } = await refusal(() => parseAllXlsxWorksheets(hostile));
    expectPayloadLimit(failure, new RegExp(`more than ${XLSX_MAX_RANGES_PER_WORKBOOK} entries`));
    expect(cpuMs, `took ${cpuMs.toFixed(0)} ms of CPU`).toBeLessThan(DEFAULT_HANG_GUARD_MS);
  }, 60_000);

  it('are counted for the whole workbook, not for each sheet', async () => {
    const zip = await JSZip.loadAsync(await workbookWith(mergeCells(Math.ceil(XLSX_MAX_RANGES_PER_WORKBOOK / 2) + 1)));
    zip.file('xl/worksheets/sheet2.xml', await zip.file('xl/worksheets/sheet1.xml')!.async('text'));
    zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('text')).replace('</sheets>', '<sheet name="Sheet2" sheetId="2" r:id="rId9"/></sheets>'));
    zip.file(
      'xl/_rels/workbook.xml.rels',
      (await zip.file('xl/_rels/workbook.xml.rels')!.async('text')).replace('</Relationships>', `<Relationship Id="rId9" Type="${RELATIONSHIPS_NAMESPACE}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`)
    );
    const hostile = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const { failure, cpuMs } = await refusal(() => parseAllXlsxWorksheets(hostile));
    expectPayloadLimit(failure, new RegExp(`more than ${XLSX_MAX_RANGES_PER_WORKBOOK} entries`));
    expect(cpuMs, `took ${cpuMs.toFixed(0)} ms of CPU`).toBeLessThan(DEFAULT_HANG_GUARD_MS);
  }, 60_000);
});

describe('hyperlinks of a worksheet', () => {
  const links = (count: number): string =>
    `<hyperlinks>${Array.from({ length: count }, (_, index) => `<hyperlink ref="A${index + 1}" location="Sheet1!A1"/>`).join('')}</hyperlinks>`;

  it(`are all returned up to ${XLSX_MAX_HYPERLINKS_PER_SHEET}, the most a worksheet of Excel holds`, async () => {
    const [sheet] = await parseAllXlsxWorksheets(await workbookWith(links(XLSX_MAX_HYPERLINKS_PER_SHEET)));
    expect(sheet.hyperlinks).toHaveLength(XLSX_MAX_HYPERLINKS_PER_SHEET);
    expect(sheet.hyperlinks![XLSX_MAX_HYPERLINKS_PER_SHEET - 1]).toEqual({ row: XLSX_MAX_HYPERLINKS_PER_SHEET - 1, col: 0, target: '#Sheet1!A1' });
  });

  it('are refused with a 413 past that', async () => {
    const { failure } = await refusal(async () => parseAllXlsxWorksheets(await workbookWith(links(XLSX_MAX_HYPERLINKS_PER_SHEET + 1))));
    expectPayloadLimit(failure, new RegExp(`at most ${XLSX_MAX_HYPERLINKS_PER_SHEET} hyperlinks`));
  });
});

describe('relationships of a part', () => {
  const relationships = (count: number): string =>
    `<Relationships xmlns="${PACKAGE_NAMESPACE}">${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIPS_NAMESPACE}/hyperlink" Target="https://example.com/${index}" TargetMode="External"/>`).join('')}</Relationships>`;

  it('are read up to the bound and refused with a 413 past it', async () => {
    const withRelationships = (count: number): Promise<Buffer> => workbookWith('', (zip) => zip.file('xl/worksheets/_rels/sheet1.xml.rels', relationships(count)));
    await expect(parseAllXlsxWorksheets(await withRelationships(XLSX_MAX_PART_ENTRIES))).resolves.toHaveLength(1);
    const { failure } = await refusal(async () => parseAllXlsxWorksheets(await withRelationships(XLSX_MAX_PART_ENTRIES + 1)));
    expectPayloadLimit(failure, new RegExp(`more than ${XLSX_MAX_PART_ENTRIES} relationships`));
  }, 60_000);
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
