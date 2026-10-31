import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownRefusal, readKnownRefusals } from '../bench/realworld/report';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireOracleTool } from './helpers/differential-oracle';
import { withTempDir } from './helpers/encrypted-pdf-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Six public PDFs that the nightly real-world run refuses (#783) are fuzzer and bug-report files whose structure is gone: a
 * trailer with no readable /Root, a page tree with no /Kids, an object stream that contains itself, a header and a cross-reference
 * stream cut to a few bytes. None of the readers a conversion could rest on opens them. qpdf cannot reconstruct a trailer from them
 * (`qpdf --check` and a plain rewrite stop with "unable to find trailer dictionary", "unable to find any pages" or "unable to find
 * page tree"), Poppler's pdfinfo exits 1 or 99, pdfium (pypdfium2 156) answers "Data format error" for all six, MuPDF (PyMuPDF 1.28)
 * opens three of them with no pages, one with a single page that holds no text and two not at all, and PDF.js stops with
 * InvalidPDFException or "Illegal character" (measured for the pull request; only qpdf and Poppler run here). The refusal is the
 * answer every reference engine gives, and the nightly gate lists it as explained.
 */

const SAMPLE_TIMEOUT_MS = 60_000;
const NO_HEADER = 'CorruptStreamError: Invalid PDF document: missing %PDF- header';
const INVALID_STRUCTURE = 'PdfTextGeometryError: PDF text geometry could not be read: Invalid PDF structure.';
const INVALID_ROOT = 'PdfTextGeometryError: PDF text geometry could not be read: Invalid Root reference.';
const NO_PAGE_COUNT = 'PdfStructureError: Unable to determine PDF page count: invalid or corrupted PDF structure.';

/** Each file with the targets the nightly run asked for and the refusal each gets. */
const REFUSALS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'qpdf-issue-263.pdf': { docx: NO_HEADER, html: NO_HEADER, md: NO_HEADER },
  'qpdf-issue-101.pdf': { pptx: INVALID_STRUCTURE, azw3: INVALID_STRUCTURE, svg: NO_PAGE_COUNT },
  'pdfjs-bug1020226.pdf': { pdf: INVALID_STRUCTURE, rtf: INVALID_STRUCTURE, txt: INVALID_STRUCTURE },
  'qpdf-issue-99.pdf': { epub: INVALID_STRUCTURE, xlsx: INVALID_STRUCTURE, png: NO_PAGE_COUNT },
  'qpdf-issue-120.pdf': { lrf: INVALID_ROOT, mobi: INVALID_ROOT, oeb: INVALID_ROOT },
  'qpdf-issue-141b.pdf': { pdb: INVALID_ROOT, jpg: NO_PAGE_COUNT, tiff: NO_PAGE_COUNT },
};

/** The e-book writers run in calibre, which a machine without it answers before the text layer is read; the worker image and the nightly run have it. */
const EBOOK_ENGINE_MISSING = /^EngineUnavailableError: Engine 'ebook-convert' is unavailable/;

const toolsMissing = skipWithoutTools('qpdf', 'pdfinfo');

/** Poppler's page count, or null when pdfinfo cannot open the file. */
function popplerPages(pdf: Buffer): number | null {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    try {
      const info = execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      return Number.parseInt(/Pages:\s+(\d+)/.exec(info)?.[1] ?? '0', 10);
    } catch {
      return null;
    }
  });
}

/** The file `qpdf in out` writes, the repair a damaged PDF would need to be read through, or null when it writes none. */
function qpdfRewrite(pdf: Buffer): Buffer | null {
  return withTempDir((dir) => {
    const input = path.join(dir, 'in.pdf');
    const output = path.join(dir, 'out.pdf');
    fs.writeFileSync(input, pdf);
    try {
      execFileSync(requireOracleTool('qpdf'), ['--warning-exit-0', input, output], { stdio: 'ignore' });
      return fs.existsSync(output) ? fs.readFileSync(output) : null;
    } catch {
      return null;
    }
  });
}

/** Whether Poppler reads at least one page from the file. */
const popplerReadsPages = (pdf: Buffer): boolean => (popplerPages(pdf) ?? 0) > 0;

describe.each(Object.entries(REFUSALS))('%s', (id, targets) => {
  it.skipIf(toolsMissing)(
    'holds no page Poppler reads, before or after a qpdf repair',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      // Whether a qpdf release passes its check or writes a repaired file varies by version; what holds on all of them is that no page can be read.
      expect(popplerReadsPages(bytes)).toBe(false);
      const repaired = qpdfRewrite(bytes);
      expect(repaired === null || !popplerReadsPages(repaired)).toBe(true);
    },
    SAMPLE_TIMEOUT_MS
  );

  it(
    'is refused for each target the nightly run asked for with the reason the gate lists as explained',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      for (const [target, expected] of Object.entries(targets)) {
        const refusal = await dispatchConversion(bytes, 'pdf', target, {}, id).then(
          () => 'converted',
          (error: unknown) => `${(error as Error).name}: ${(error as Error).message}`
        );
        if (!EBOOK_ENGINE_MISSING.test(refusal)) expect(refusal, `${id} to ${target}`).toBe(expected);
        const job = { file: id, source: 'pdf', target, verdict: 'refused', ms: 0, detail: expected } as const;
        expect(knownRefusal(job, readKnownRefusals()), `${id} to ${target} has a known refusal`).not.toBeNull();
      }
    },
    SAMPLE_TIMEOUT_MS
  );
});
