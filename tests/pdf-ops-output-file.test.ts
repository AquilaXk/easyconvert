import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deletePdfPages, extractPdfPages, protectPdf, reorderPdfPages, rotatePdfPages } from '../src/lib/conversions/pdf-postprocess';
import { QPDF_OUTPUT_FILE_MIN_BYTES } from '../src/lib/conversions/pdf-postprocess/qpdf-run';
import type { LaunchedExecutionOptions } from '../src/lib/security/sandbox-launcher';
import { qpdfCheckPasses, qpdfEncryptionReport } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * qpdf prints a document on standard output without a buffer: one `write` per token, each into a pipe that wakes its reader (2,511 writes and
 * 2.2 ms for a 445 KB result on the benchmark VM; a file takes 122 writes and 0.4 ms). A document of QPDF_OUTPUT_FILE_MIN_BYTES or more is
 * written to a file of the job directory and read back; a smaller one keeps standard output, which needs no directory. The runs are recorded at
 * the place that starts qpdf, so what is read is what the sandbox is given.
 */

const launched: Array<{ args: string[]; options: LaunchedExecutionOptions }> = [];

vi.mock('../src/lib/conversions/pdf-postprocess/qpdf-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/pdf-postprocess/qpdf-runner')>();
  return {
    ...original,
    launchQpdf: vi.fn(async (binary: string, args: string[], options: LaunchedExecutionOptions) => {
      launched.push({ args, options });
      return original.launchQpdf(binary, args, options);
    }),
  };
});

const toolsMissing = skipWithoutTools('qpdf');
const PAGES = 4;

async function document(paddingBytes: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < PAGES; page++) doc.addPage([100, 100]);
  // Random bytes do not deflate, so the size of the file is the padding's.
  if (paddingBytes > 0) await doc.attach(randomBytes(paddingBytes), 'padding.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await doc.save());
}

const pageCount = async (pdf: Buffer): Promise<number> => (await PDFDocument.load(pdf)).getPageCount();

/** The place a qpdf run was told to write its document: the last argument, or the last line of its argument file. */
function outputOf(run: { args: string[]; options: LaunchedExecutionOptions }): string {
  const argumentFile = run.options.stdin?.toString('utf8');
  const lines = run.args.includes('@-') && argumentFile !== undefined ? argumentFile.split('\n') : run.args;
  return lines[lines.length - 1];
}

/** Whether a directory a run was given, or anything it wrote there, is still on disk. */
const remains = (run: { options: LaunchedExecutionOptions }): boolean => typeof run.options.workDir === 'string' && fs.existsSync(run.options.workDir);

describe.skipIf(toolsMissing)('where qpdf writes the document of a PDF operation', () => {
  afterEach(() => {
    launched.length = 0;
  });

  const large = (): Promise<Buffer> => document(QPDF_OUTPUT_FILE_MIN_BYTES);
  const operations: Array<[string, (pdf: Buffer) => Promise<Buffer>, number]> = [
    ['extract', (pdf) => extractPdfPages(pdf, '2-3'), 2],
    ['delete', (pdf) => deletePdfPages(pdf, '2'), PAGES - 1],
    ['reorder', (pdf) => reorderPdfPages(pdf, { order: '4,1' }), PAGES],
    ['rotate', (pdf) => rotatePdfPages(pdf, { rotation: 90, pages: '2-3' }), PAGES],
  ];

  it.each(operations)('writes the result of %s on a large document to a file of its job directory and returns it intact', async (_name, operate, pages) => {
    const result = await operate(await large());
    const writes = launched.filter((run) => !run.args.includes('--show-npages'));
    expect(writes).toHaveLength(1);
    const output = outputOf(writes[0]);
    expect(output).not.toBe('-');
    expect(path.basename(output)).toMatch(/^output-\d+\.pdf$/);
    expect(path.dirname(output)).toBe(writes[0].options.workDir);
    expect(writes[0].options.maxFileSize).toBeGreaterThan(0);
    expect(await pageCount(result)).toBe(pages);
    expect(qpdfCheckPasses(result)).toBe(true);
    expect(launched.some(remains)).toBe(false);
  });

  it.each(operations)('keeps standard output for the result of %s on a small document', async (_name, operate, pages) => {
    const result = await operate(await document(0));
    const writes = launched.filter((run) => !run.args.includes('--show-npages'));
    expect(writes).toHaveLength(1);
    expect(outputOf(writes[0])).toBe('-');
    expect(await pageCount(result)).toBe(pages);
  });

  it('writes the encrypted document of a large PDF to a file, with the passwords still off the command line and the disk', async () => {
    const result = await protectPdf(await large(), { userPassword: 'user-secret-391', ownerPassword: 'owner-secret-391' });
    const encryption = launched.filter((run) => run.args.includes('@-'));
    expect(encryption).toHaveLength(1);
    expect(path.basename(outputOf(encryption[0]))).toMatch(/^output-\d+\.pdf$/);
    expect(encryption[0].args.join(' ')).not.toContain('secret');
    expect(qpdfEncryptionReport(result, 'user-secret-391')).toMatchObject({ encrypted: true, R: 6, userPasswordMatched: true });
    expect(qpdfEncryptionReport(result, 'owner-secret-391')).toMatchObject({ ownerPasswordMatched: true });
    expect(launched.some(remains)).toBe(false);
  });

  it('leaves no file behind when qpdf refuses the run', async () => {
    await expect(extractPdfPages(await large(), String(PAGES + 1))).rejects.toThrow(/out of range/);
    expect(launched.length).toBeGreaterThan(0);
    expect(launched.some(remains)).toBe(false);
  });
});
