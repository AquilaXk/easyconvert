import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPdfWatermark,
  deletePdfPages,
  extractPdfPages,
  protectPdf,
  reorderPdfPages,
  rotatePdfPages,
  splitPdfPages,
  unlockPdf,
} from '../src/lib/conversions/pdf-postprocess';
import { mergePdfBuffers } from '../src/lib/jobs/artifact-helpers';
import { requireBenchSample } from './helpers/bench-sample';
import { requireOracleTool } from './helpers/differential-oracle';
import { AES_256, containsEncryptKey, pdfinfoPages, pdftotext, plainPdf, qpdfCheckPasses, qpdfEncrypt, qpdfEncryptionReport, withTempDir } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The page operations on a PDF whose page tree reaches one of its own nodes a second time (#783). `qpdf` refuses such a
 * file ("Loop detected in /Pages structure") although its pages are intact; the operations mend the tree and go on. The
 * expected pages are worked out from the structure of each file (a leaf `/Page` object of `qpdf --json`, or the page
 * written into the hand-built document), and the result is read back by `qpdf --check`, `qpdf --show-npages`, Poppler's
 * page count, text and page rotation: tools that share no code with the product.
 */

vi.setConfig({ testTimeout: 60_000 });

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo');
const FORM_FEED = '\f';
const PAGES_LOOP = 'pdf-qpdf-pages-loop.pdf';
const PAGES_TREE_REFS = 'pdf-pdfjs-Pages-tree-refs.pdf';
const PAGE_TEXTS = ['Alpha page one', 'Bravo page two', 'Charlie page three'] as const;

/** Builds a PDF of three pages whose root lists the inner `/Pages` node, which lists the root again. */
function loopingThreePagePdf(): Buffer {
  const contents = PAGE_TEXTS.map((text) => `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 >>',
    '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R 2 0 R] /Count 3 >>',
    ...[4, 5, 6].map(
      (id) => `<< /Type /Page /Parent ${id === 6 ? 2 : 3} 0 R /MediaBox [0 0 612 792] /Contents ${id + 3} 0 R /Resources << /Font << /F1 10 0 R >> >> >>`
    ),
    ...contents.map((content) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  const rows = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const pageTexts = (pdf: Buffer): string[] => pdftotext(pdf).split(FORM_FEED).slice(0, -1).map((page) => page.trim());

/** Pages as `qpdf --show-npages` counts them. */
function qpdfPages(pdf: Buffer): number {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return Number.parseInt(execFileSync(requireOracleTool('qpdf'), ['--show-npages', file], { encoding: 'utf-8' }), 10);
  });
}

/** Leaf `/Page` objects of the file as `qpdf --json` lists them, which does not walk the page tree. */
function leafPages(pdf: Buffer): number {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const json = execFileSync(requireOracleTool('qpdf'), ['--warning-exit-0', '--json=2', '--json-key=qpdf', '--json-stream-data=none', file], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const objects = (JSON.parse(json) as { qpdf: [unknown, Record<string, { value?: Record<string, unknown> }>] }).qpdf[1];
    return Object.values(objects).filter((object) => object.value?.['/Type'] === '/Page').length;
  });
}

function pageRotations(pdf: Buffer): number[] {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), ['-f', '1', '-l', String(pdfinfoPages(pdf)), file], { encoding: 'utf-8' });
    return [...info.matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
  });
}

function expectIntact(pdf: Buffer, pages: number): void {
  expect(qpdfCheckPasses(pdf)).toBe(true);
  expect(qpdfPages(pdf)).toBe(pages);
  expect(pdfinfoPages(pdf)).toBe(pages);
}

describe.skipIf(toolsMissing)('page operations on a hand-built looping page tree of three pages', () => {
  const source = loopingThreePagePdf();

  it('is a damaged file that lists its pages and the text the tree holds', () => {
    expect(qpdfCheckPasses(source)).toBe(false);
    expect(leafPages(source)).toBe(3);
    expect(pageTexts(source)).toEqual([...PAGE_TEXTS]);
  });

  it('extract keeps the listed pages in the order written', async () => {
    const out = await extractPdfPages(source, '3,1');
    expectIntact(out, 2);
    expect(pageTexts(out)).toEqual([PAGE_TEXTS[2], PAGE_TEXTS[0]]);
  });

  it('delete keeps the pages that were not named', async () => {
    const out = await deletePdfPages(source, '2');
    expectIntact(out, 2);
    expect(pageTexts(out)).toEqual([PAGE_TEXTS[0], PAGE_TEXTS[2]]);
  });

  it('reorder puts the listed pages first', async () => {
    const out = await reorderPdfPages(source, { order: '3,1,2' });
    expectIntact(out, 3);
    expect(pageTexts(out)).toEqual([PAGE_TEXTS[2], PAGE_TEXTS[0], PAGE_TEXTS[1]]);
  });

  it('rotate turns the named page and no other', async () => {
    const out = await rotatePdfPages(source, { rotation: 90, pages: '2' });
    expectIntact(out, 3);
    expect(pageRotations(out)).toEqual([0, 90, 0]);
    expect(pageTexts(out)).toEqual([...PAGE_TEXTS]);
  });

  it('split writes one part per range', async () => {
    const zip = await JSZip.loadAsync(await splitPdfPages(source, { ranges: '1-2,3' }));
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(2);
    const parts = await Promise.all(names.map(async (name) => Buffer.from(await zip.files[name].async('uint8array'))));
    expectIntact(parts[0], 2);
    expectIntact(parts[1], 1);
    expect(pageTexts(parts[0])).toEqual([PAGE_TEXTS[0], PAGE_TEXTS[1]]);
    expect(pageTexts(parts[1])).toEqual([PAGE_TEXTS[2]]);
  });

  it('split every page writes three parts', async () => {
    const zip = await JSZip.loadAsync(await splitPdfPages(source, { everyNPages: 1 }));
    expect(Object.keys(zip.files)).toHaveLength(3);
  });
});

describe.skipIf(toolsMissing)('page operations on the public PDFs whose page tree loops', () => {
  for (const id of [PAGES_LOOP, PAGES_TREE_REFS]) {
    describe(id, () => {
      const load = async (ctx: Parameters<typeof requireBenchSample>[0]): Promise<{ source: Buffer; pages: number; text: string }> => {
        const source = await requireBenchSample(ctx, id);
        expect(qpdfCheckPasses(source), 'the sample is the damaged file').toBe(false);
        const pages = leafPages(source);
        expect(pages).toBe(1);
        return { source, pages, text: pageTexts(source)[0] };
      };

      it('extract, reorder and rotate keep the page and its text', async (ctx) => {
        const { source, pages, text } = await load(ctx);
        const extracted = await extractPdfPages(source, '1');
        const reordered = await reorderPdfPages(source, { order: '1' });
        const rotated = await rotatePdfPages(source, { rotation: 180 });
        for (const out of [extracted, reordered, rotated]) {
          expectIntact(out, pages);
          expect(pageTexts(out)).toEqual([text]);
        }
        expect(pageRotations(rotated)).toEqual([(pageRotations(source)[0] + 180) % 360]);
      });

      it('split writes the page as a part that passes the check', async (ctx) => {
        const { source, pages, text } = await load(ctx);
        const zip = await JSZip.loadAsync(await splitPdfPages(source, { everyNPages: 1 }));
        const names = Object.keys(zip.files);
        expect(names).toHaveLength(pages);
        const part = Buffer.from(await zip.files[names[0]].async('uint8array'));
        expectIntact(part, pages);
        expect(pageTexts(part)).toEqual([text]);
      });

      it('delete of the only page is still refused', async (ctx) => {
        const { source } = await load(ctx);
        await expect(deletePdfPages(source, '1')).rejects.toThrow(/every page/);
      });
    });
  }
});

const WATERMARK = 'STAMPED';
const USER_PASSWORD = 'open-sesame-1';
const OWNER_PASSWORD = 'owner-secret-1';
const HEALTHY_TEXTS = ['Delta healthy one', 'Echo healthy two'] as const;

/** `pageTexts` with the open password of the file. */
const pageTextsWith = (pdf: Buffer, password: string): string[] =>
  pdftotext(pdf, password).split(FORM_FEED).slice(0, -1).map((page) => page.trim());

interface LoopingFile {
  source: Buffer;
  pages: number;
  texts: string[];
}

/**
 * The remaining operations on the same three looping files: the document keeps its pages and text, and the result is
 * read by `qpdf --check`, Poppler and `qpdf --json`, tools that share no code with the product.
 */
describe.skipIf(toolsMissing)('watermark, protect, unlock and merge of a looping page tree', () => {
  const sources: Array<{ name: string; load: (ctx: Parameters<typeof requireBenchSample>[0]) => Promise<LoopingFile> }> = [
    {
      name: 'the hand-built file of three pages',
      load: async () => ({ source: loopingThreePagePdf(), pages: 3, texts: [...PAGE_TEXTS] }),
    },
    ...[PAGES_LOOP, PAGES_TREE_REFS].map((id) => ({
      name: id,
      load: async (ctx: Parameters<typeof requireBenchSample>[0]): Promise<LoopingFile> => {
        const source = await requireBenchSample(ctx, id);
        expect(qpdfCheckPasses(source), 'the sample is the damaged file').toBe(false);
        expect(leafPages(source)).toBe(1);
        return { source, pages: 1, texts: [pageTexts(source)[0]] };
      },
    })),
  ];

  for (const { name, load } of sources) {
    describe(name, () => {
      it('watermark draws the text on every page and keeps the page text', async (ctx) => {
        const { source, pages, texts } = await load(ctx);
        const out = await applyPdfWatermark(source, { type: 'text', text: WATERMARK, rotation: 0 });
        expectIntact(out, pages);
        const marked = pageTexts(out);
        expect(marked).toHaveLength(pages);
        marked.forEach((page, index) => {
          expect(page).toContain(WATERMARK);
          expect(page).toContain(texts[index]);
        });
      });

      it('protect writes the encryption that was asked for and keeps the pages', async (ctx) => {
        const { source, pages, texts } = await load(ctx);
        const out = await protectPdf(source, { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 256 });
        const report = qpdfEncryptionReport(out, USER_PASSWORD);
        expect(report).toMatchObject({ encrypted: true, R: 6, V: 5, userPasswordMatched: true });
        expect(qpdfCheckPasses(out, USER_PASSWORD)).toBe(true);
        expect(qpdfCheckPasses(out), 'the open password is needed').toBe(false);
        expect(pdfinfoPages(out, USER_PASSWORD)).toBe(pages);
        expect(pageTextsWith(out, USER_PASSWORD)).toEqual(texts);
      });

      it('unlock writes a plain document that passes the check', async (ctx) => {
        const { source, pages, texts } = await load(ctx);
        const locked = qpdfEncrypt(source, { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
        expect(containsEncryptKey(locked)).toBe(true);
        const out = await unlockPdf(locked, { password: USER_PASSWORD });
        expect(containsEncryptKey(out)).toBe(false);
        expectIntact(out, pages);
        expect(pageTexts(out)).toEqual(texts);
      });

      it('merge keeps every page of the looping file and of a healthy one, in order', async (ctx) => {
        const { source, pages, texts } = await load(ctx);
        const healthy = await plainPdf([...HEALTHY_TEXTS]);
        const loopFirst = await mergePdfBuffers([source, healthy]);
        expectIntact(loopFirst, pages + HEALTHY_TEXTS.length);
        expect(pageTexts(loopFirst)).toEqual([...texts, ...HEALTHY_TEXTS]);
        const loopLast = await mergePdfBuffers([healthy, source]);
        expectIntact(loopLast, pages + HEALTHY_TEXTS.length);
        expect(pageTexts(loopLast)).toEqual([...HEALTHY_TEXTS, ...texts]);
      });
    });
  }

  it('merge of an encrypted looping file keeps its pages, and the result is not encrypted', async () => {
    const locked = qpdfEncrypt(loopingThreePagePdf(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
    const out = await mergePdfBuffers([locked], { passwords: [USER_PASSWORD] });
    expect(containsEncryptKey(out)).toBe(false);
    expectIntact(out, 3);
    expect(pageTexts(out)).toEqual([...PAGE_TEXTS]);
  });
});
