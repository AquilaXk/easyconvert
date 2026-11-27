import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { readLegacySpreadsheetRows } from '../src/lib/conversions/office/sheet-legacy';
import { isLotusRelease3Bof } from '../src/lib/format-signatures';
import { interchangeFor } from '../src/worker/office-suite-route';
import { EngineUnavailableError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Lotus 1-2-3 release 3 and later (`.wk3`, `.wk4`, `.123`) start with a BOF record of 0x1A bytes and keep their cells in 3-D worksheet records. The
 * in-process reader reads the records of release 1 and 2 only, so the office suite (LibreOffice Calc, which opens them through libwps) reads these
 * files and the in-process converter writes the targets it does not write from the workbook. The files are real: they are the Lotus 1-2-3 files of the
 * format corpus of the Open Preservation Foundation and of the LibreOffice test data (bench/realworld/PROVENANCE.md).
 */

const sofficeMissing = skipWithoutTools('soffice');
const CONVERSION_TIMEOUT_MS = 180_000;

function bof(length: number, revision: number): Buffer {
  const buf = Buffer.alloc(8 + length);
  buf.writeUInt16LE(length, 2);
  buf.writeUInt16LE(revision, 4);
  return buf;
}

describe('the BOF record of Lotus 1-2-3 release 3 and later', () => {
  it.each([0x1000, 0x1002, 0x1003, 0x1005])('is recognised for revision %d behind a 0x1A byte record', (revision) => {
    expect(isLotusRelease3Bof(bof(0x1a, revision))).toBe(true);
  });

  it.each([
    ['a release 1 revision behind a 0x1A byte record', bof(0x1a, 0x0404)],
    ['a release 3 revision behind a 2 byte record', bof(2, 0x1000)],
    ['a revision past the last release', bof(0x1a, 0x1006)],
    ['a header too short to hold a revision', Buffer.from([0, 0, 0x1a, 0, 0x00])],
  ])('is not recognised for %s', (_name, header) => {
    expect(isLotusRelease3Bof(header)).toBe(false);
  });
});

describe('the in-process reader on a release 3 file', () => {
  it('names the office suite as the engine that opens it, in place of a missing BOF record', () => {
    let failure: unknown;
    try {
      readLegacySpreadsheetRows(bof(0x1a, 0x1002), 'wks');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).reason).toBe(
      '.wks files of Lotus 1-2-3 release 3 and later (.wk3, .wk4, .123) are opened by LibreOffice Calc; the in-process engine reads release 1 and 2 files only.'
    );
  });
});

describe('the route of a release 3 file', () => {
  const request = (src: string, tgt: string, input: Buffer) => ({ input, src, tgt, options: {}, originalFilename: `book.${src}` });

  it.each([
    ['wks', 'csv', 'xlsx'],
    ['wk1', 'csv', 'xlsx'],
    ['wks', 'xlsx', undefined],
    ['wks', 'pdf', undefined],
    ['wks', 'zip', undefined],
  ])('writes .%s as .%s through %s', (src, tgt, interchange) => {
    expect(interchangeFor(request(src, tgt, bof(0x1a, 0x1000)), tgt === 'pdf' || tgt === 'zip')).toBe(interchange);
  });

  it('leaves a release 1 or 2 file to the in-process reader', () => {
    expect(interchangeFor(request('wks', 'csv', bof(2, 0x0404)), false)).toBeUndefined();
  });
});

interface Sample {
  id: string;
  /** Rows the file holds, read in the file's own bytes: the label text, which is stored as text after a one byte alignment prefix. */
  labels: readonly string[];
  /** The first rows of the CSV the conversion writes. */
  firstRows: readonly string[];
  rowCount: number;
}

const SAMPLES: readonly Sample[] = [
  {
    id: 'opf-testlotus123-lotusftp.wk4',
    labels: ['EMPID', 'Mordocs', 'Kaplan', 'Donovan'],
    firstRows: [',,,,,,,', ',,EMPID,LAST,FIRST,DOH,SALARIED,DEPTNUM', ',,67543,Mordocs,Arthur,1988-08-13,1,2323', ',,65437,Smith,Wendy,1989-12-21,0,3434'],
    rowCount: 16,
  },
  {
    id: 'opf-peytrend.wk3',
    labels: ['VMC5_10', 'VMC15_20', 'VMC30_35'],
    firstRows: ['NO,DATE,VMC5_10,VMC15_20,VMC30_35', '5,219,0.25921844,0.27645291,0.3257515', '6,219,0.26533066,0.25380762,0.19509018'],
    rowCount: 223,
  },
  {
    id: 'lo-lotus123_3.123',
    labels: ['italic', 'underline', 'protected', 'align across column'],
    firstRows: ['### Sheet: Sheet1', '3,3,italic,underline', 'red,yellow,red(pattern),14pt,18pt,centaur', 'red(back),yellow(backpatt),'],
    rowCount: 37,
  },
  {
    id: 'lo-lotus123_98.123',
    labels: ['titre', 'aacccddeeeeeeeeeeeeeee', 'qqqqwwqwqqwwq', 'feuille 2'],
    firstRows: ['### Sheet: Sheet1', 'titre,,,,,,,,titre,q', '', ''],
    rowCount: 25,
  },
];

describe.skipIf(sofficeMissing)('a real Lotus 1-2-3 release 3 and later file converted through the office suite', () => {
  it.for(SAMPLES)('$id: the labels are bytes of the file and the CSV holds its rows', { timeout: CONVERSION_TIMEOUT_MS }, async (sample, ctx) => {
    const { bytes } = await requireRealworldSample(ctx, sample.id);
    for (const label of sample.labels) expect(bytes.includes(Buffer.from(label, 'latin1'))).toBe(true);
    const csv = (await dispatchConversion(bytes, 'wks', 'csv', {}, `${sample.id}.wks`)).buffer.toString('utf-8');
    const rows = csv.split('\n');
    expect(rows.slice(0, sample.firstRows.length)).toEqual(sample.firstRows);
    expect(rows).toHaveLength(sample.rowCount);
    for (const label of sample.labels) expect(csv.split(/,|\n|### Sheet: /)).toContain(label);
  });

  it('writes the XLSX of the employee sheet with the rows of the CSV', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'opf-testlotus123-lotusftp.wk4');
    const xlsx = (await dispatchConversion(bytes, 'wks', 'xlsx', {}, 'book.wks')).buffer;
    const fromXlsx = (await dispatchConversion(xlsx, 'xlsx', 'csv', {}, 'book.xlsx')).buffer.toString('utf-8');
    const fromLotus = (await dispatchConversion(bytes, 'wks', 'csv', {}, 'book.wks')).buffer.toString('utf-8');
    expect(fromXlsx).toBe(fromLotus);
  });
});
