import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { convertOffice } from '../src/lib/conversions/office';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { DataLimitExceededError, DataParseError, UnsupportedTargetError } from '../src/lib/types';
import { readXlsCells } from './helpers/biff8-records';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { parseCsvWithPython, sheetRowsViaLibreOffice } from './helpers/sheet-rows';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * An `.xls` output is a BIFF8 workbook in a Compound File, the format Excel 97-2003 reads, and not SpreadsheetML 2003 XML under an
 * `.xls` name. Each test reads the output the way a program that is not this project's code does: the `file` command, the record
 * walker of the test helpers, and LibreOffice exporting the sheet to CSV.
 */

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const LONG_TIMEOUT_MS = 180_000;

const SALES_CSV = [
  'name,amount,when,code,note',
  'widget,1.5,2024-03-05,00004,"a,b"',
  'gadget,-153.375,1999-12-31,K-255,"say ""hi"""',
  'gizmo,123456789012345,2000-01-01,1e4,',
].join('\n');
const SALES_ROWS = [
  ['name', 'amount', 'when', 'code', 'note'],
  ['widget', '1.5', '2024-03-05', '00004', 'a,b'],
  ['gadget', '-153.375', '1999-12-31', 'K-255', 'say "hi"'],
  ['gizmo', '123456789012345', '2000-01-01', '1e4', ''],
];

function fileDescription(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-file-'));
  try {
    const target = path.join(dir, 'out.xls');
    fs.writeFileSync(target, bytes);
    return execFileSync(requireOracleTool('file'), ['-b', target], { encoding: 'utf-8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('a table converted to .xls', () => {
  oracleTest('is a Compound File whose cells an office suite reads back as the source values', ['soffice', 'python3', 'file'], async () => {
    const converted = await dispatchConversion(Buffer.from(SALES_CSV), 'csv', 'xls', {}, 'sales.csv');
    expect(converted.filename).toBe('sales.xls');
    expect(converted.mimeType).toBe('application/vnd.ms-excel');
    expect(converted.buffer.subarray(0, CFB_SIGNATURE.length)).toEqual(CFB_SIGNATURE);
    expect(fileDescription(converted.buffer)).toContain('Composite Document File V2');
    expect(sheetRowsViaLibreOffice(converted.buffer, 'xls')).toEqual(SALES_ROWS);
  }, LONG_TIMEOUT_MS);

  oracleTest('keeps numbers as number records and text as shared-string records', ['soffice', 'file'], async () => {
    const converted = await dispatchConversion(Buffer.from(SALES_CSV), 'csv', 'xls', {}, 'sales.csv');
    const cells = readXlsCells(converted.buffer);
    expect(cells.get('1,1')).toMatchObject({ kind: 'number', value: 1.5 });
    expect(cells.get('2,1')).toMatchObject({ kind: 'number', value: -153.375 });
    expect(cells.get('3,1')).toMatchObject({ kind: 'number', value: 123456789012345 });
    expect(cells.get('1,0')).toMatchObject({ kind: 'string', record: 0x00fd, value: 'widget' });
    expect(cells.get('1,3')).toMatchObject({ kind: 'string', value: '00004' });
    expect(cells.get('1,4')).toMatchObject({ kind: 'string', value: 'a,b' });
    expect(cells.get('3,3')).toMatchObject({ kind: 'string', value: '1e4' });
    expect(cells.has('3,4')).toBe(false);
  }, LONG_TIMEOUT_MS);

  oracleTest('from JSON keeps a boolean a boolean', ['soffice', 'file'], async () => {
    const json = JSON.stringify([{ id: 7, ok: true, no: false, label: 'x' }]);
    const converted = await dispatchConversion(Buffer.from(json), 'json', 'xls', {}, 'records.json');
    expect(converted.buffer.subarray(0, CFB_SIGNATURE.length)).toEqual(CFB_SIGNATURE);
    const cells = readXlsCells(converted.buffer);
    expect(cells.get('1,0')).toMatchObject({ kind: 'number', value: 7 });
    expect(cells.get('1,1')).toMatchObject({ kind: 'boolean', value: true });
    expect(cells.get('1,2')).toMatchObject({ kind: 'boolean', value: false });
    expect(cells.get('1,3')).toMatchObject({ kind: 'string', value: 'x' });
  }, LONG_TIMEOUT_MS);

  for (const source of ['tsv', 'xlsx', 'ods', 'et', 'parquet', 'pdf'] as const) {
    oracleTest(`from .${source} is a Compound File and not SpreadsheetML`, ['soffice', 'file'], async () => {
      const csv = Buffer.from('a,b\n1,x\n2,y\n');
      const tsv = Buffer.from('a\tb\n1\tx\n2\ty\n');
      const origin = source === 'tsv' ? tsv : (await convertFile(csv, 'csv', source === 'et' ? 'xlsx' : source, {}, 'table.csv')).buffer;
      const converted = await dispatchConversion(origin, source, 'xls', {}, `table.${source}`);
      expect(converted.buffer.subarray(0, CFB_SIGNATURE.length)).toEqual(CFB_SIGNATURE);
      expect(fileDescription(converted.buffer)).toContain('Composite Document File V2');
    }, LONG_TIMEOUT_MS);
  }
});

describe('a table that is not well formed is refused for the .xls target', () => {
  it.each([
    ['csv', 'a,b\n1,"two\n'],
    ['json', '{"a":'],
  ])('answers .%s that stops in the middle with a 400, before any office suite runs', async (source, text) => {
    const failure = await dispatchConversion(Buffer.from(text), source, 'xls', {}, `broken.${source}`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect(classifyJobFailure(failure)).toMatchObject({ code: 'DataParseError', status: 400 });
  });
});

describe('the limits of a BIFF8 sheet', () => {
  it('refuses more than 65,536 rows with a 413 and does not cut the table', async () => {
    const csv = `a\n${'x\n'.repeat(65_536)}`;
    const failure = await dispatchConversion(Buffer.from(csv), 'csv', 'xls', {}, 'tall.csv').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataLimitExceededError);
    expect((failure as DataLimitExceededError).status).toBe(413);
  }, LONG_TIMEOUT_MS);

  it('refuses more than 256 columns with a 413 and does not cut the table', async () => {
    const csv = `${Array.from({ length: 257 }, (_, i) => `c${i}`).join(',')}\n`;
    const failure = await dispatchConversion(Buffer.from(csv), 'csv', 'xls', {}, 'wide.csv').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataLimitExceededError);
    expect((failure as DataLimitExceededError).status).toBe(413);
  });
});

describe('a BIFF8 workbook read back', () => {
  const COMMA_ROWS = [
    ['name', 'note'],
    ['a,b', 'say "hi"'],
    ['multi\nline', 'tail'],
  ];
  const COMMA_CSV = 'name,note\n"a,b","say ""hi"""\n"multi\nline",tail\n';

  oracleTest('keeps a cell with a comma, a quote and a line break whole through xls to csv to xlsx', ['soffice', 'python3'], async () => {
    const workbook = sofficeConvert(Buffer.from(COMMA_CSV), 'csv', 'xls', 'xls');
    const csv = await convertFile(workbook, 'xls', 'csv', {}, 'cells.xls');
    expect(parseCsvWithPython(csv.buffer.toString('utf-8'))).toEqual(COMMA_ROWS);

    const roundTrip = await convertFile(csv.buffer, 'csv', 'xlsx', {}, 'cells.csv');
    expect(sheetRowsViaLibreOffice(roundTrip.buffer, 'xlsx')).toEqual(COMMA_ROWS);
  }, LONG_TIMEOUT_MS);

  oracleTest('keeps the same cell whole when the workbook goes straight to xlsx', ['soffice', 'python3'], async () => {
    const workbook = sofficeConvert(Buffer.from(COMMA_CSV), 'csv', 'xls', 'xls');
    const direct = await convertFile(workbook, 'xls', 'xlsx', {}, 'cells.xls');
    expect(sheetRowsViaLibreOffice(direct.buffer, 'xlsx')).toEqual(COMMA_ROWS);
  }, LONG_TIMEOUT_MS);

  oracleTest('is not offered as a target of itself, and is never returned unchanged', ['soffice'], async () => {
    const workbook = sofficeConvert(Buffer.from(COMMA_CSV), 'csv', 'xls', 'xls');
    expect(FORMAT_REGISTRY.xls.targetFormats).not.toContain('xls');
    const registry = await convertFile(workbook, 'xls', 'xls', {}, 'cells.xls').catch((err: unknown) => err);
    expect(registry).toBeInstanceOf(UnsupportedTargetError);
    expect((registry as Error).message.startsWith('Cannot convert from Excel 97-2003 (XLS) (.xls) to target format .xls. Available targets: ')).toBe(true);
    const routed = await dispatchConversion(workbook, 'xls', 'xls', {}, 'cells.xls').catch((err: unknown) => err);
    expect(routed).toBeInstanceOf(UnsupportedTargetError);
    expect((routed as Error).message).toBe('Unsupported conversion from .xls to .xls: the pair is not offered');
    // The office engine itself, below the registry check, used to answer with the input bytes.
    const engine = await convertOffice(workbook, 'xls', 'xls', {}, 'cells.xls').catch((err: unknown) => err);
    expect(engine).toBeInstanceOf(UnsupportedTargetError);
    expect((engine as Error).message).toBe("Cannot convert XLS documents to '.xls'.");
  }, LONG_TIMEOUT_MS);
});
