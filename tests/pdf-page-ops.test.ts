import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import {
  deletePdfPages,
  extractPdfPages,
  reorderPdfPages,
  rotatePdfPages,
  splitPdfPages,
} from '../src/lib/conversions/pdf-postprocess';
import { graphScheduler } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { InvalidPageRangeError, PdfPermissionDeniedError, PdfPostprocessError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import {
  AES_256,
  containsEncryptKey,
  pdfinfoPages,
  plainPdf,
  qpdfCheckPasses,
  qpdfEncrypt,
  withTempDir,
} from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * PDF page operations (#696). Every expectation is read back by tools that share no code with the product: qpdf
 * --check for structure, pdfinfo for the page count and the rotation of each page, pdftotext for the text of each
 * page (which proves the pages are the right ones and in the right order), and JSZip for the parts of a split.
 */

const PAGE_TEXTS = ['Alpha page one', 'Bravo page two', 'Charlie page three', 'Delta page four', 'Echo page five'] as const;
const USER_PASSWORD = 'user-secret-696';
const OWNER_PASSWORD = 'owner-secret-696';
const FORM_FEED = '\f';

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo');

/** The text of each page of `pdf`, as pdftotext reads it. */
function pageTexts(pdf: Buffer): string[] {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const text = execFileSync(requireOracleTool('pdftotext'), [file, '-'], { encoding: 'utf-8' });
    return text.split(FORM_FEED).slice(0, -1).map((page) => page.trim());
  });
}

/** The rotation of each page, as pdfinfo reports it. */
function pageRotations(pdf: Buffer): number[] {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const count = pdfinfoPages(pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), ['-f', '1', '-l', String(count), file], { encoding: 'utf-8' });
    return [...info.matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
  });
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected, but it resolved');
}

/** The error name and message of a rejection, which the test compares as plain data. */
async function refusal(run: Promise<unknown>): Promise<{ name: string; message: string }> {
  const error = (await rejection(run)) as Error;
  return { name: error.name, message: error.message };
}

describe.skipIf(toolsMissing)('PDF page operations', () => {
  const source = async (): Promise<Buffer> => plainPdf([...PAGE_TEXTS]);

  describe('extract', () => {
    it('keeps the listed pages, in the order listed', async () => {
      const out = await extractPdfPages(await source(), '4,2-3');
      expect(qpdfCheckPasses(out)).toBe(true);
      expect(pageTexts(out)).toEqual([PAGE_TEXTS[3], PAGE_TEXTS[1], PAGE_TEXTS[2]]);
    });

    it('reads an open range as "to the last page" and a leading hyphen as "the first pages"', async () => {
      expect(pageTexts(await extractPdfPages(await source(), '4-'))).toEqual([PAGE_TEXTS[3], PAGE_TEXTS[4]]);
      expect(pageTexts(await extractPdfPages(await source(), '-2'))).toEqual([PAGE_TEXTS[0], PAGE_TEXTS[1]]);
    });

    it('refuses a page the document does not have, naming it', async () => {
      const error = await rejection(extractPdfPages(await source(), '2,9'));
      expect(error).toBeInstanceOf(InvalidPageRangeError);
      expect((error as Error).message).toMatch(/Page 9 is out of range/);
    });

    it.each(['', '   ', '3-1', '0', 'a-b', '1,,2', '1--2', '12345678901'])('refuses the specification %j', async (spec) => {
      expect(await refusal(extractPdfPages(await source(), spec))).toMatchObject({ name: 'InvalidPageRangeError' });
    });
  });

  describe('delete', () => {
    it('removes the listed pages and keeps the rest in order', async () => {
      const out = await deletePdfPages(await source(), '2-3,5');
      expect(qpdfCheckPasses(out)).toBe(true);
      expect(pageTexts(out)).toEqual([PAGE_TEXTS[0], PAGE_TEXTS[3]]);
    });

    it('refuses to delete every page: a PDF without a page is no result', async () => {
      const error = await rejection(deletePdfPages(await source(), '1-'));
      expect(error).toBeInstanceOf(PdfPostprocessError);
      expect((error as Error).message).toMatch(/every page/);
    });

    it('refuses a page the document does not have', async () => {
      expect(await refusal(deletePdfPages(await source(), '9'))).toMatchObject({ name: 'InvalidPageRangeError' });
    });
  });

  describe('reorder', () => {
    it('puts the pages in the listed order', async () => {
      const out = await reorderPdfPages(await source(), { order: '5,2-4,1' });
      expect(qpdfCheckPasses(out)).toBe(true);
      expect(pageTexts(out)).toEqual([PAGE_TEXTS[4], PAGE_TEXTS[1], PAGE_TEXTS[2], PAGE_TEXTS[3], PAGE_TEXTS[0]]);
    });

    it('puts the pages it lists first and keeps every other page after them, in their original order', async () => {
      const out = await reorderPdfPages(await source(), { order: '4,2' });
      expect(qpdfCheckPasses(out)).toBe(true);
      expect(pageTexts(out)).toEqual([PAGE_TEXTS[3], PAGE_TEXTS[1], PAGE_TEXTS[0], PAGE_TEXTS[2], PAGE_TEXTS[4]]);
      expect(pageTexts(await reorderPdfPages(await source(), { order: '5-' }))).toEqual([PAGE_TEXTS[4], ...PAGE_TEXTS.slice(0, 4)]);
    });

    it('refuses an order that lists a page twice or names a page the document does not have', async () => {
      for (const order of ['1,1', '1-3,3', '2-,4', '-3,2']) {
        expect(await refusal(reorderPdfPages(await source(), { order }))).toMatchObject({ name: 'InvalidPageRangeError' });
      }
      expect(await refusal(reorderPdfPages(await source(), { order: '6' }))).toMatchObject({ name: 'InvalidPageRangeError' });
      expect(await refusal(reorderPdfPages(await source(), { order: '' }))).toMatchObject({ name: 'InvalidPageRangeError' });
    });
  });

  describe('rotate', () => {
    it('turns the listed pages and leaves the others', async () => {
      const out = await rotatePdfPages(await source(), { rotation: 90, pages: '2,4-' });
      expect(qpdfCheckPasses(out)).toBe(true);
      expect(pageRotations(out)).toEqual([0, 90, 0, 90, 90]);
      expect(pageTexts(out)).toEqual([...PAGE_TEXTS]);
    });

    it('turns every page when no pages are given', async () => {
      expect(pageRotations(await rotatePdfPages(await source(), { rotation: 180 }))).toEqual([180, 180, 180, 180, 180]);
    });

    it('adds to the rotation a page already has, and a page in two groups turns by both', async () => {
      const once = await rotatePdfPages(await source(), { rotation: 90, pages: '1' });
      const out = await rotatePdfPages(once, {
        rotations: [
          { rotation: 90, pages: '1-2' },
          { rotation: 180, pages: '2' },
        ],
      });
      expect(pageRotations(out)).toEqual([180, 270, 0, 0, 0]);
    });

    it('adds up groups that name the same pages, whichever way the pages are written', async () => {
      const turned = async (rotations: Array<{ rotation: 90 | 180 | 270; pages?: string }>): Promise<number[]> =>
        pageRotations(await rotatePdfPages(await source(), { rotations }));
      expect(await turned([{ rotation: 90, pages: '2' }, { rotation: 90, pages: '2' }])).toEqual([0, 180, 0, 0, 0]);
      expect(await turned([{ rotation: 90 }, { rotation: 180 }])).toEqual([270, 270, 270, 270, 270]);
      expect(await turned([{ rotation: 90 }, { rotation: 180, pages: '1-' }])).toEqual([270, 270, 270, 270, 270]);
      expect(await turned([{ rotation: 90, pages: '-3' }, { rotation: 90, pages: '1-3' }])).toEqual([180, 180, 180, 0, 0]);
      expect(await turned([{ rotation: 90, pages: '4-' }, { rotation: 270 }])).toEqual([270, 270, 270, 0, 0]);
    });

    it('adds up partly overlapping groups page by page, and a sum of 360 degrees leaves the page as it was', async () => {
      const turned = async (rotations: Array<{ rotation: 90 | 180 | 270; pages?: string }>): Promise<number[]> =>
        pageRotations(await rotatePdfPages(await source(), { rotations }));
      expect(await turned([{ rotation: 90, pages: '1-3' }, { rotation: 180, pages: '2-4' }])).toEqual([90, 270, 270, 180, 0]);
      expect(await turned([{ rotation: 270, pages: '2' }, { rotation: 90, pages: '2' }])).toEqual([0, 0, 0, 0, 0]);
      expect(await turned([{ rotation: 90, pages: '1,3,5' }, { rotation: 180, pages: '3-5' }])).toEqual([90, 0, 270, 180, 270]);
    });

    it.each([0, 45, 360, -90, 91, '90deg', null])('refuses the rotation %j', async (rotation) => {
      expect(await refusal(rotatePdfPages(await source(), { rotation: rotation as never }))).toMatchObject({ name: 'UnsupportedOptionError' });
    });

    it('refuses a request that names no rotation, or both forms', async () => {
      expect(await refusal(rotatePdfPages(await source(), {}))).toMatchObject({ name: 'UnsupportedOptionError' });
      expect(await refusal(rotatePdfPages(await source(), { rotation: 90, rotations: [{ rotation: 90 }] }))).toMatchObject({ name: 'UnsupportedOptionError' });
    });
  });

  describe('split', () => {
    async function parts(zip: Buffer): Promise<Array<{ name: string; pdf: Buffer }>> {
      const archive = await JSZip.loadAsync(zip);
      const names = Object.keys(archive.files).sort();
      return Promise.all(names.map(async (name) => ({ name, pdf: await archive.files[name].async('nodebuffer') })));
    }

    it('writes one PDF per page by default, named in page order', async () => {
      const result = await parts(await splitPdfPages(await source(), {}, {}, 'book'));
      expect(result.map((part) => part.name)).toEqual(['book-part001.pdf', 'book-part002.pdf', 'book-part003.pdf', 'book-part004.pdf', 'book-part005.pdf']);
      for (const [index, part] of result.entries()) {
        expect(qpdfCheckPasses(part.pdf)).toBe(true);
        expect(pageTexts(part.pdf)).toEqual([PAGE_TEXTS[index]]);
      }
    });

    it('writes a part per run of N pages, the last holding the remainder', async () => {
      const result = await parts(await splitPdfPages(await source(), { everyNPages: 2 }));
      expect(result.map((part) => pageTexts(part.pdf))).toEqual([
        [PAGE_TEXTS[0], PAGE_TEXTS[1]],
        [PAGE_TEXTS[2], PAGE_TEXTS[3]],
        [PAGE_TEXTS[4]],
      ]);
    });

    it('writes a part per range, in the order written', async () => {
      const result = await parts(await splitPdfPages(await source(), { ranges: '4-,1-2' }));
      expect(result.map((part) => pageTexts(part.pdf))).toEqual([
        [PAGE_TEXTS[3], PAGE_TEXTS[4]],
        [PAGE_TEXTS[0], PAGE_TEXTS[1]],
      ]);
    });

    it('counts the parts of a split by pages and N before cutting a large document, and refuses more than 1000', async () => {
      const doc = await PDFDocument.create();
      for (let page = 0; page < 1100; page++) doc.addPage([100, 100]);
      // Random bytes do not deflate: the file is large enough for the page count to be read before qpdf cuts anything.
      await doc.attach(randomBytes(300 * 1024), 'padding.bin', { mimeType: 'application/octet-stream' });
      const pdf = Buffer.from(await doc.save());
      const message = (await refusal(splitPdfPages(pdf, { everyNPages: 1 }))).message;
      expect(message).toMatch(/at most 1000.*1100 pages.*1100 parts/s);
      expect(pdfinfoPages(await splitPdfPages(pdf, { everyNPages: 2 }).then(async (zip) => (await JSZip.loadAsync(zip)).files['document-part001.pdf'].async('nodebuffer')))).toBe(2);
    });

    it('stops a small document that would split into more than 1000 parts', async () => {
      const doc = await PDFDocument.create();
      for (let page = 0; page < 1100; page++) doc.addPage([100, 100]);
      const pdf = Buffer.from(await doc.save());
      expect(await refusal(splitPdfPages(pdf, {}))).toMatchObject({ name: 'UnsupportedOptionError', message: expect.stringMatching(/at most 1000 parts/) });
    });

    it('refuses both ranges and everyNPages, a bad N, a range past the end and too many parts', async () => {
      expect(await refusal(splitPdfPages(await source(), { ranges: '1', everyNPages: 2 }))).toMatchObject({ name: 'UnsupportedOptionError' });
      for (const everyNPages of [0, -1, 1.5, '2']) {
        expect(await refusal(splitPdfPages(await source(), { everyNPages: everyNPages as never }))).toMatchObject({ name: 'UnsupportedOptionError' });
      }
      expect(await refusal(splitPdfPages(await source(), { ranges: '1-2,9' }))).toMatchObject({ name: 'InvalidPageRangeError' });
      const tooMany = Array.from({ length: 1001 }, () => '1').join(',');
      expect(await refusal(splitPdfPages(await source(), { ranges: tooMany }))).toMatchObject({ name: 'UnsupportedOptionError' });
    });
  });
});

describe.skipIf(toolsMissing)('PDF page operations on encrypted input', () => {
  const protectedPdf = async (modify?: 'none'): Promise<Buffer> =>
    qpdfEncrypt(await plainPdf([...PAGE_TEXTS]), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify });
  const ownerOnly = async (): Promise<Buffer> =>
    qpdfEncrypt(await plainPdf([...PAGE_TEXTS]), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' });

  const operations: Array<[string, (pdf: Buffer, access: { password?: string; confirmEditRights?: boolean }) => Promise<Buffer>]> = [
    ['extract', (pdf, access) => extractPdfPages(pdf, '1-2', access)],
    ['delete', (pdf, access) => deletePdfPages(pdf, '1', access)],
    ['reorder', (pdf, access) => reorderPdfPages(pdf, { order: '5,4,3,2,1' }, access)],
    ['rotate', (pdf, access) => rotatePdfPages(pdf, { rotation: 90 }, access)],
    ['split', (pdf, access) => splitPdfPages(pdf, { everyNPages: 5 }, access)],
  ];

  it.each(operations)('%s answers PdfPasswordRequiredError without the open password, and for a wrong one', async (_name, run) => {
    expect(await refusal(run(await protectedPdf(), {}))).toMatchObject({ name: 'PdfPasswordRequiredError' });
    expect(await refusal(run(await protectedPdf(), { password: 'wrong-password', confirmEditRights: true }))).toMatchObject({ name: 'PdfPasswordRequiredError' });
  });

  it.each(operations)('%s answers PdfPermissionDeniedError when the owner forbids assembly and nothing confirms the right', async (_name, run) => {
    const error = await rejection(run(await ownerOnly(), {}));
    expect(error).toBeInstanceOf(PdfPermissionDeniedError);
    expect((error as Error).message).toMatch(/confirmEditRights.*owner password/is);
  });

  it.each(operations)('%s works with the confirmation or the owner password, and writes no encryption', async (_name, run) => {
    for (const access of [{ confirmEditRights: true }, { password: OWNER_PASSWORD }]) {
      const out = await run(await ownerOnly(), access);
      const first = _name === 'split' ? (await JSZip.loadAsync(out)).files['document-part001.pdf'] : undefined;
      const pdf = first ? await first.async('nodebuffer') : out;
      expect(containsEncryptKey(pdf)).toBe(false);
      expect(qpdfCheckPasses(pdf)).toBe(true);
    }
  });

  it('works with the user password and keeps the text of the pages it keeps', async () => {
    const out = await extractPdfPages(await protectedPdf(), '2', { password: USER_PASSWORD });
    expect(containsEncryptKey(out)).toBe(false);
    expect(pageTexts(out)).toEqual([PAGE_TEXTS[1]]);
  });
});

describe.skipIf(toolsMissing)('PDF page operation graph nodes', () => {
  let counter = 0;

  function seed(buffer: Buffer): string {
    counter += 1;
    const key = `tests/pdf-page-ops/${Date.now()}_${counter}.pdf`;
    s3Storage.saveObject(key, buffer, 'application/pdf', 'book.pdf', 60 * 60 * 1000);
    return key;
  }

  async function runNode(graphNode: Record<string, unknown>, input: string): Promise<{ buffer: Buffer; filename: string }> {
    const { processGraphNodeJob } = await import('../src/lib/queue/graph/node-executor');
    counter += 1;
    const graphId = `g_pageops_${Date.now()}_${counter}`;
    vi.spyOn(graphScheduler, 'getNodeOutputs').mockResolvedValue([]);
    try {
      const result = await processGraphNodeJob(
        {
          id: `${graphId}:n1`,
          data: { jobId: `${graphId}:n1`, sourceFormat: 'bin', targetFormat: 'pdf', fileSize: 0, options: {}, graphId, graphNodeId: 'n1', graphNode, inputArtifacts: [input] },
          opts: { attempts: 1 },
          attemptsMade: 1,
          signal: new AbortController().signal,
          log: async () => {},
          updateProgress: async () => {},
        } as never,
        undefined,
        s3Storage
      );
      const stored = s3Storage.getObject(result.resultKey);
      return { buffer: stored?.buffer as Buffer, filename: stored?.filename as string };
    } finally {
      vi.restoreAllMocks();
    }
  }

  it('pdf.extract-pages and pdf.delete-pages select pages from options.pages', async () => {
    const key = seed(await plainPdf([...PAGE_TEXTS]));
    const extracted = await runNode({ op: 'pdf.extract-pages', options: { pages: '5,1' } }, key);
    expect(pageTexts(extracted.buffer)).toEqual([PAGE_TEXTS[4], PAGE_TEXTS[0]]);
    expect(extracted.filename).toBe('book.pdf');
    const deleted = await runNode({ op: 'pdf.delete-pages', options: { pages: '1-4' } }, key);
    expect(pageTexts(deleted.buffer)).toEqual([PAGE_TEXTS[4]]);
  });

  it('pdf.reorder-pages and pdf.rotate-pages take their nested options', async () => {
    const key = seed(await plainPdf([...PAGE_TEXTS]));
    const reordered = await runNode({ op: 'pdf.reorder-pages', options: { reorder: { order: '2,1,3-5' } } }, key);
    expect(pageTexts(reordered.buffer).slice(0, 2)).toEqual([PAGE_TEXTS[1], PAGE_TEXTS[0]]);
    const rotated = await runNode({ op: 'pdf.rotate-pages', options: { rotate: { rotation: 270, pages: '3' } } }, key);
    expect(pageRotations(rotated.buffer)).toEqual([0, 0, 270, 0, 0]);
  });

  it('pdf.split-pages stores one ZIP of PDFs named after the input', async () => {
    const key = seed(await plainPdf([...PAGE_TEXTS]));
    const split = await runNode({ op: 'pdf.split-pages', options: { split: { everyNPages: 3 } } }, key);
    expect(split.filename).toBe('book-split.zip');
    const archive = await JSZip.loadAsync(split.buffer);
    expect(Object.keys(archive.files).sort()).toEqual(['book-part001.pdf', 'book-part002.pdf']);
    expect(pdfinfoPages(await archive.files['book-part002.pdf'].async('nodebuffer'))).toBe(2);
  });

  it('a page-selecting node without options.pages fails with a message that names the option', async () => {
    const key = seed(await plainPdf([...PAGE_TEXTS]));
    vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue(undefined as never);
    try {
      await expect(runNode({ op: 'pdf.extract-pages', options: {} }, key)).rejects.toThrow(/options\.pages/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
