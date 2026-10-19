import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compressPdf, deletePdfPages } from '../src/lib/conversions/pdf-postprocess';
import { getGhostscriptBinaryPath } from '../src/lib/conversions/pdf-postprocess/gs-path';
import { requireBenchSample } from './helpers/bench-sample';
import { requireOracleTool } from './helpers/differential-oracle';
import { pdfinfoPages, pdftotext, qpdfCheckPasses, withTempDir } from './helpers/encrypted-pdf-fixtures';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The damaged public PDFs the pdf-ops benchmark found a gap on (#783), read back by tools that share no code with the
 * product: `qpdf --check`, Poppler's text and page count, and the object graph of `qpdf --json`. The page-tree files
 * come from the qpdf and PDF.js test suites; the page tree of each reaches a page node a second time.
 */

const TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo') || skipUnless('Ghostscript (gs)', getGhostscriptBinaryPath() !== null);

const PAGES_LOOP = 'pdf-qpdf-pages-loop.pdf';
const PAGES_TREE_REFS = 'pdf-pdfjs-Pages-tree-refs.pdf';
const FORM_ERRORS = 'pdf-qpdf-form-errors.pdf';
/** Output of the compact qpdf writer the page operations and the reference both use. */
const COMPACT_OUTPUT = ['--object-streams=generate', '--compress-streams=y'];
/** Bytes by which the output may exceed the same selection written by `qpdf --pages` (object ids and the trailer ID differ by a few bytes). */
const SIZE_ALLOWANCE = 1.01;

type JsonObject = { value?: Record<string, unknown>; stream?: { dict: Record<string, unknown> } };

/** Every indirect object of `pdf` as `qpdf --json` reads it (stream data left out), keyed `obj:N G R`. */
function qpdfObjects(pdf: Buffer): Record<string, JsonObject> {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    const json = execFileSync(requireOracleTool('qpdf'), ['--warning-exit-0', '--json=2', '--json-key=qpdf', '--json-stream-data=none', file], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(json) as { qpdf: [unknown, Record<string, JsonObject>] };
    return parsed.qpdf[1];
  });
}

const dictionaryOf = (object: JsonObject): Record<string, unknown> => object.value ?? object.stream?.dict ?? {};
const objectsWhere = (pdf: Buffer, wanted: (dictionary: Record<string, unknown>) => boolean): number =>
  Object.entries(qpdfObjects(pdf)).filter(([key, object]) => key.startsWith('obj:') && wanted(dictionaryOf(object))).length;
const pageObjects = (pdf: Buffer): number => objectsWhere(pdf, (dictionary) => dictionary['/Type'] === '/Page' && !('/Kids' in dictionary));
const allObjects = (pdf: Buffer): number => objectsWhere(pdf, () => true);
const widgets = (pdf: Buffer): number => objectsWhere(pdf, (dictionary) => dictionary['/Subtype'] === '/Widget');

/** The AcroForm field list of the catalog. */
function acroFormFields(pdf: Buffer): unknown[] {
  const objects = qpdfObjects(pdf);
  const trailer = objects.trailer?.value as { '/Root': string };
  const root = dictionaryOf(objects[`obj:${trailer['/Root']}`]);
  const form = typeof root['/AcroForm'] === 'string' ? dictionaryOf(objects[`obj:${root['/AcroForm']}`]) : (root['/AcroForm'] as Record<string, unknown>);
  return (form['/Fields'] as unknown[]) ?? [];
}

/** Text of each page as Poppler reads it. */
const pageTexts = (pdf: Buffer): string[] => pdftotext(pdf).split('\f').slice(0, -1).map((page) => page.trim());

/** The same selection written by the qpdf command line, which is what the benchmark measures the product against. */
function qpdfSelection(source: Buffer, selection: string): Buffer {
  return withTempDir((dir) => {
    const input = path.join(dir, 'in.pdf');
    const output = path.join(dir, 'out.pdf');
    fs.writeFileSync(input, source);
    execFileSync(requireOracleTool('qpdf'), ['--warning-exit-0', ...COMPACT_OUTPUT, input, '--pages', '.', selection, '--', output], { stdio: ['ignore', 'ignore', 'ignore'] });
    return fs.readFileSync(output);
  });
}

describe.skipIf(toolsMissing)('compressing a PDF whose page tree reaches a page node twice', () => {
  for (const id of [PAGES_LOOP, PAGES_TREE_REFS]) {
    for (const profile of ['web', 'archive'] as const) {
      it(`${id} with the ${profile} profile passes qpdf --check and keeps the page and its text`, async (ctx) => {
        const source = await requireBenchSample(ctx, id);
        expect(qpdfCheckPasses(source), 'the sample is the damaged file').toBe(false);
        const { buffer } = await compressPdf(source, { profile });
        expect(qpdfCheckPasses(buffer)).toBe(true);
        expect(pageObjects(buffer)).toBe(pageObjects(source));
        expect(pageObjects(buffer)).toBe(1);
        expect(pdfinfoPages(buffer)).toBe(1);
        const text = pageTexts(source);
        expect(text).toHaveLength(1);
        expect(text[0]).toMatch(/\p{L}/u);
        expect(pageTexts(buffer)[0]).toBe(text[0]);
      });
    }
  }
});

describe.skipIf(toolsMissing)('deleting a page of a form with a damaged field tree', () => {
  for (const deleted of ['2', '1', '3']) {
    it(`page ${deleted} leaves the document, the form and the text qpdf --pages leaves, in no more bytes`, async (ctx) => {
      const source = await requireBenchSample(ctx, FORM_ERRORS);
      const kept = ['1', '2', '3'].filter((page) => page !== deleted).join(',');
      const reference = qpdfSelection(source, kept);
      const ours = await deletePdfPages(source, deleted);
      expect(pdfinfoPages(ours)).toBe(2);
      expect(pageTexts(ours)).toEqual(pageTexts(reference));
      expect(pageObjects(ours)).toBe(2);
      expect(acroFormFields(ours)).toHaveLength(acroFormFields(reference).length);
      expect(widgets(ours)).toBe(widgets(reference));
      expect(allObjects(ours)).toBe(allObjects(reference));
      expect(ours.length).toBeLessThanOrEqual(Math.ceil(reference.length * SIZE_ALLOWANCE));
    });
  }
});
