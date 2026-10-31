import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { isEncryptedWordDocument } from '../src/lib/conversions/office/doc-reader';
import { xlsHasFilePass } from '../src/lib/conversions/office';
import { ConversionFailedError, EncryptedOfficeDocumentError } from '../src/lib/types';
import { isEncryptedLegacyOffice } from '../src/worker/office-input-checks';
import { withEncryptedAnswer } from '../src/worker/office-suite-route';
import type { WorkerConversionResult, WorkerVfsPayload } from '../src/worker/worker-types';
import { buildCompoundFile } from './helpers/cfb-craft';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * LibreOffice decrypts an Excel 97-2003 workbook that uses the default password of the format, `VelvetSweatshop`
 * (sc/source/filter/excel/xlroot.cxx `RequestEncryptionData` offers it first, backed by `XclRootData::gaDefPassword` in
 * xlroot.hxx and `DocPasswordHelper::requestAndVerifyDocPassword` in comphelper). It cannot load a workbook or a Word document
 * that needs another password, and reports that like a damaged file. The worker therefore hands every workbook to the suite
 * and answers 422 only for an encrypted file the suite could not load.
 */

const CONVERSION_TIMEOUT_MS = 300_000;
const HTTP_UNPROCESSABLE = 422;
const BOF_RECORD = 0x0809;
const EOF_RECORD = 0x000a;
const FILEPASS_RECORD = 0x002f;
const GLOBALS_SUBSTREAM = 0x0005;
const BIFF8_VERSION = 0x0600;
const RC4_FILEPASS = Buffer.concat([Buffer.from([0x01, 0x00, 0x01, 0x00, 0x01, 0x00]), Buffer.alloc(48, 0xab)]);
const WORD_FIB_WIDENT = 0xa5ec;
const WORD_FIB_FLAGS_OFFSET = 10;
const WORD_FIB_ENCRYPTED = 0x0100;
const WORD_FIB_BYTES = 32;
const NOT_LOADED = 'LibreOffice execution completed without producing expected output file';

function record(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function globals(...records: Buffer[]): Buffer {
  const bof = Buffer.alloc(16);
  bof.writeUInt16LE(BIFF8_VERSION, 0);
  bof.writeUInt16LE(GLOBALS_SUBSTREAM, 2);
  return Buffer.concat([record(BOF_RECORD, bof), ...records, record(EOF_RECORD, Buffer.alloc(0))]);
}

const workbookIn = (stream: Buffer): Buffer => buildCompoundFile([{ name: 'Workbook', data: stream }]);
const encryptedWorkbook = (): Buffer => workbookIn(globals(record(FILEPASS_RECORD, RC4_FILEPASS)));
const plainWorkbook = (): Buffer => workbookIn(globals());

function wordDocument(flags: number): Buffer {
  const fib = Buffer.alloc(WORD_FIB_BYTES);
  fib.writeUInt16LE(WORD_FIB_WIDENT, 0);
  fib.writeUInt16LE(flags, WORD_FIB_FLAGS_OFFSET);
  return buildCompoundFile([{ name: 'WordDocument', data: fib }]);
}

describe('telling an encrypted legacy Office file from a damaged one', () => {
  it('finds the FilePass record of a workbook in a compound file and in a bare BIFF stream', () => {
    expect(xlsHasFilePass(encryptedWorkbook())).toBe(true);
    expect(xlsHasFilePass(globals(record(FILEPASS_RECORD, RC4_FILEPASS)))).toBe(true);
  });

  it('does not take a workbook without a FilePass record, or bytes that are no workbook, for an encrypted one', () => {
    expect(xlsHasFilePass(plainWorkbook())).toBe(false);
    expect(xlsHasFilePass(Buffer.from('not a workbook'))).toBe(false);
  });

  it('reads the encrypted flag of the file information block of a Word document', () => {
    expect(isEncryptedWordDocument(wordDocument(WORD_FIB_ENCRYPTED))).toBe(true);
    expect(isEncryptedWordDocument(wordDocument(0))).toBe(false);
    expect(isEncryptedWordDocument(Buffer.from('not a compound file'))).toBe(false);
  });

  it('judges only the workbook and Word formats, and only an input it can read', () => {
    expect(isEncryptedLegacyOffice(encryptedWorkbook(), 'xlt')).toBe(true);
    expect(isEncryptedLegacyOffice(wordDocument(WORD_FIB_ENCRYPTED), 'dot')).toBe(true);
    expect(isEncryptedLegacyOffice(encryptedWorkbook(), 'ods')).toBe(false);
    expect(isEncryptedLegacyOffice({ inputPath: '/nonexistent/easyconvert/locked.xls', outputPath: '/nonexistent/easyconvert/out' }, 'xls')).toBe(false);
  });
});

describe('the office suite run on a legacy workbook or document it could not load', () => {
  const suiteResult: WorkerConversionResult = { buffer: Buffer.from('PK'), mimeType: 'application/zip', filename: 'out.xlsx', size: 2, engineUsed: 'native-soffice-pool', executionTimeMs: 1 };
  const failingSuite = (failure: Error) => vi.fn(async (_input: Buffer | WorkerVfsPayload) => {
    throw failure;
  });

  it('hands a workbook with a FilePass record to the suite and returns what the suite wrote', async () => {
    const run = vi.fn(async () => suiteResult);
    await expect(withEncryptedAnswer(run)(encryptedWorkbook(), 'xls', 'xlsx')).resolves.toBe(suiteResult);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a workbook with a FilePass record', encryptedWorkbook(), 'xls'],
    ['a workbook template with a FilePass record', encryptedWorkbook(), 'xlt'],
    ['a Word document with the encrypted flag', wordDocument(WORD_FIB_ENCRYPTED), 'doc'],
  ])('answers %s as encrypted (422) when the suite wrote nothing', async (_name, input, src) => {
    const failure = await withEncryptedAnswer(failingSuite(new Error(NOT_LOADED)))(input, src, 'pdf').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EncryptedOfficeDocumentError);
    expect((failure as EncryptedOfficeDocumentError).status).toBe(HTTP_UNPROCESSABLE);
    expect((failure as Error).message).toMatch(/encrypted/i);
  });

  it.each([
    ['a workbook without a FilePass record', plainWorkbook(), 'xls'],
    ['a Word document without the encrypted flag', wordDocument(0), 'doc'],
    ['bytes that are no compound file', Buffer.from('not a compound file'), 'xls'],
  ])('keeps the error of the suite for %s', async (_name, input, src) => {
    const failure = new Error(NOT_LOADED);
    await expect(withEncryptedAnswer(failingSuite(failure))(input, src, 'pdf')).rejects.toBe(failure);
  });

  it('keeps an error that is not "could not load" even for an encrypted workbook', async () => {
    const failure = new Error('the sandbox is gone');
    await expect(withEncryptedAnswer(failingSuite(failure))(encryptedWorkbook(), 'xls', 'pdf')).rejects.toBe(failure);
  });
});

/** The text of the first shared string of an XLSX workbook. */
async function sharedStrings(workbook: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(workbook);
  return (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
}

describe('Excel 97-2003 workbooks with the default password (real files of Apache POI)', () => {
  const SIGNATURES: Record<string, string> = { xlsx: 'PK', ods: 'PK', pdf: '%PDF' };

  oracleTest('office-spreadsheet-50833.xls (RC4 with VelvetSweatshop) converts to the cell it holds in every route', ['soffice'], async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'office-spreadsheet-50833.xls');
    const convert = (target: string) => dispatchConversion(bytes, 'xls', target, {}, 'office-spreadsheet-50833.xls');
    expect((await convert('csv')).buffer.toString('utf-8')).toBe('### Sheet: Sheet1\ntest cell value\n\n### Sheet: Sheet2\n\n\n### Sheet: Sheet3\n');
    for (const target of ['json', 'html']) expect((await convert(target)).buffer.toString('utf-8'), target).toMatch(/test cell value/);
    for (const [target, signature] of Object.entries(SIGNATURES)) {
      expect((await convert(target)).buffer.subarray(0, signature.length).toString('latin1'), target).toBe(signature);
    }
    expect(await sharedStrings((await convert('xlsx')).buffer)).toMatch(/test cell value/);
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('office-spreadsheet-60284.xls (XOR obfuscation with VelvetSweatshop) converts to the text of its sheet', ['soffice'], async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'office-spreadsheet-60284.xls');
    const csv = await dispatchConversion(bytes, 'xls', 'csv', {}, 'office-spreadsheet-60284.xls');
    expect(csv.buffer.toString('utf-8')).toContain('PI PAD Attenuator (ver 3.2)');
    const ods = await dispatchConversion(bytes, 'xls', 'ods', {}, 'office-spreadsheet-60284.xls');
    expect(ods.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('a fuzzer file with the default password converts as the suite converts it', ['soffice'], async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'office-spreadsheet-clusterfuzz-testcase-minimized-poihssffuzzer-4651309315719168.xls');
    const ods = await dispatchConversion(bytes, 'xls', 'ods', {}, 'fuzz.xls');
    expect(ods.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  }, CONVERSION_TIMEOUT_MS);

  describe.each(['office-spreadsheet-password.xls', 'office-spreadsheet-xor-encryption-abc.xls', 'office-spreadsheet-51832.xls'])('%s needs a real password', (id) => {
      oracleTest('is refused as encrypted (422) for a route of the suite and for a route of the in-process reader', ['soffice'], async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      for (const target of ['ods', 'csv']) {
        const failure = await dispatchConversion(bytes, 'xls', target, {}, id).catch((err: unknown) => err);
        expect(failure, target).toBeInstanceOf(EncryptedOfficeDocumentError);
        expect((failure as EncryptedOfficeDocumentError).status, target).toBe(HTTP_UNPROCESSABLE);
      }
    }, CONVERSION_TIMEOUT_MS);
  });
});

describe.each(['office-document-password_password_cryptoapi.doc', 'office-document-password_tika_binaryrc4.doc'])('%s (a Word document that needs a password)', (id) => {
  oracleTest('is refused as encrypted (422), not as damaged (400)', ['soffice'], async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, id);
    for (const target of ['docx', 'pdf']) {
      const failure = await dispatchConversion(bytes, 'doc', target, {}, id).catch((err: unknown) => err);
      expect(failure, target).toBeInstanceOf(EncryptedOfficeDocumentError);
      expect((failure as EncryptedOfficeDocumentError).status, target).toBe(HTTP_UNPROCESSABLE);
    }
  }, CONVERSION_TIMEOUT_MS);
});

describe('files that LibreOffice cannot read stay refused as damaged', () => {
  oracleTest('a truncated .docx package is refused (400) and is not taken for an encrypted one', ['soffice'], async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'office-document-truncated62886.docx');
    const failure = await dispatchConversion(bytes, 'docx', 'pdf', {}, 'truncated.docx').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(EncryptedOfficeDocumentError);
    expect((failure as Error).message).toMatch(/could not read the \.docx file|not a valid ZIP package/);
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('a compound file with a workbook stream of random bytes is refused as damaged and not as encrypted', ['soffice'], async () => {
    const damaged = workbookIn(Buffer.alloc(2048, 0x5a));
    const failure = await dispatchConversion(damaged, 'xls', 'pdf', {}, 'damaged.xls').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(EncryptedOfficeDocumentError);
    expect((failure as Error).message).toMatch(/could not read the \.xls file/);
  }, CONVERSION_TIMEOUT_MS);
});
