import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { knownRefusal, readKnownRefusals } from '../bench/realworld/report';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { EngineUnavailableError } from '../src/lib/types';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { convertDjvu, type DjvuJob } from '../src/worker/djvu-render';
import { requireOracleTool, type ExternalOracleTool } from './helpers/differential-oracle';
import { bundledDocument, pageForm, singlePage } from './helpers/djvu-builder';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';
import { withMissingBinary } from './helpers/native-tools';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * DjVu documents drawn by `ddjvu` of djvulibre. The oracles are djvulibre's own programs run on the same file and the PDF tools
 * reading the result back: `ddjvu -format=pdf` (the PDF the program writes by itself), `djvused -e n` (the page count the
 * document directory gives), `djvutxt` (the hidden text layer of a page), and `pdfinfo`, `pdftoppm` and `pdftotext` of Poppler.
 * The real files are the DjVu files of the real-world corpus.
 */

const haveTools = !skipWithoutTools('ddjvu', 'djvutxt', 'djvused', 'djvmcvt', 'djvm', 'cjb2', 'pdfinfo', 'pdftoppm', 'pdftotext');
const haveOcr = !skipWithoutTools('tesseract');
const CONVERSION_TIMEOUT_MS = 180_000;
const HANSARD = 'wc-hansard-1963-malaysia-bill-clause-4.djvu';
const DOGV = 'wc-dogv-12042005.djvu';
const TIKA_INDIRECT = 'tika-testdjvu.djvu';
/** The most pages a request renders to images: the limit of the other page chains. */
const IMAGE_PAGE_LIMIT = 500;
const OCR_DPI = 300;
const IMAGE_DPI = 150;
const POINTS_PER_INCH = 72;
/** Words of four letters or more of a text layer that OCR of the page picture must find again. */
const MIN_OCR_WORD_RECALL = 0.8;
const MIN_WORD_LETTERS = 4;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function run(tool: ExternalOracleTool, args: string[]): string {
  return execFileSync(requireOracleTool(tool), args, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

/** What `ddjvu -format=pdf` writes for `djvuPath`, the reference output. */
function referencePdf(djvuPath: string): string {
  const out = path.join(scratchDir('djvu-reference-'), 'reference.pdf');
  run('ddjvu', ['-format=pdf', djvuPath, out]);
  return out;
}

function writeTemp(bytes: Buffer, name: string): string {
  const file = path.join(scratchDir('djvu-file-'), name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** The size in points of every page, as pdfinfo prints it. */
function pageSizes(pdfPath: string, pages: number): string[] {
  const info = run('pdfinfo', ['-f', '1', '-l', String(pages), pdfPath]);
  return [...info.matchAll(/^Page\s+\d+ size:\s+(.+)$/gm)].map((match) => match[1].trim());
}

/** Page `page` of the PDF as 8-bit grey pixels at 36 dpi, the same rasteriser for both files that are compared. */
function rasterOf(pdfPath: string, page: number): Buffer {
  const dir = scratchDir('djvu-raster-');
  run('pdftoppm', ['-r', '36', '-f', String(page), '-l', String(page), '-gray', '-singlefile', pdfPath, path.join(dir, 'page')]);
  return fs.readFileSync(path.join(dir, 'page.pgm'));
}

function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= MIN_WORD_LETTERS);
}

function ocrOfPage(pdfPath: string, page: number): string {
  const dir = scratchDir('djvu-ocr-');
  run('pdftoppm', ['-r', String(OCR_DPI), '-f', String(page), '-l', String(page), '-gray', '-singlefile', pdfPath, path.join(dir, 'page')]);
  return run('tesseract', [path.join(dir, 'page.pgm'), 'stdout', '-l', 'eng', '--psm', '6']);
}

describe.skipIf(!haveTools)('real DjVu files drawn by ddjvu', () => {
  for (const id of [HANSARD, DOGV]) {
    it(
      `${id} becomes the PDF ddjvu writes: its pages, their sizes and their pixels`,
      async (ctx) => {
        const sample = await requireRealworldSample(ctx, id);
        const result = await dispatchConversion(sample.bytes, 'djvu', 'pdf', {}, id);
        expect(result.engineUsed).toBe('native-djvu');
        const ours = writeTemp(result.buffer, 'ours.pdf');
        const reference = referencePdf(sample.path);
        const pages = Number.parseInt(run('djvused', ['-e', 'n', sample.path]).trim(), 10);
        expect(pdfinfoPages(result.buffer)).toBe(pages);
        expect(pdfinfoPages(fs.readFileSync(reference))).toBe(pages);
        expect(pageSizes(ours, pages)).toEqual(pageSizes(reference, pages));
        for (const page of new Set([1, pages])) expect(rasterOf(ours, page).equals(rasterOf(reference, page)), `page ${page}`).toBe(true);
        expect(run('pdftotext', [ours, '-']).trim()).toBe(run('pdftotext', [reference, '-']).trim());
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  it.skipIf(!haveOcr)(
    'draws the page whose text layer djvutxt reads: OCR of the PDF page finds the words of the layer again',
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, DOGV);
      const result = await dispatchConversion(sample.bytes, 'djvu', 'pdf', {}, DOGV);
      const expected = new Set(words(run('djvutxt', ['--page=1', sample.path])));
      expect(expected.size).toBeGreaterThan(20);
      const found = new Set(words(ocrOfPage(writeTemp(result.buffer, 'ours.pdf'), 1)));
      const recall = [...expected].filter((word) => found.has(word)).length / expected.size;
      expect(recall).toBeGreaterThanOrEqual(MIN_OCR_WORD_RECALL);
    },
    CONVERSION_TIMEOUT_MS
  );

  it(
    'draws a page target at the size of the page: the Hansard PNG is the page of the PDF at 150 dpi',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, HANSARD);
      const result = await dispatchConversion(bytes, 'djvu', 'png', {}, HANSARD);
      expect(result.engineUsed).toBe('native-poppler');
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('png');
      expect(Math.abs((meta.width ?? 0) - (612 * IMAGE_DPI) / POINTS_PER_INCH)).toBeLessThanOrEqual(1);
      expect(Math.abs((meta.height ?? 0) - (792 * IMAGE_DPI) / POINTS_PER_INCH)).toBeLessThanOrEqual(1);
    },
    CONVERSION_TIMEOUT_MS
  );

  it(
    'draws the page a request selects out of a document',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, DOGV);
      const result = await dispatchConversion(bytes, 'djvu', 'png', { pages: '3' }, DOGV);
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('png');
      expect(Math.abs((meta.width ?? 0) - (594.96 * IMAGE_DPI) / POINTS_PER_INCH)).toBeLessThanOrEqual(1);
    },
    CONVERSION_TIMEOUT_MS
  );
});

describe.skipIf(!haveTools)('DjVu files that are refused', () => {
  it(
    'the Tika file, an indirect document, is refused before the program starts, as is the program itself on it',
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, TIKA_INDIRECT);
      const refusal = await dispatchConversion(sample.bytes, 'djvu', 'pdf', {}, TIKA_INDIRECT).then(
        () => 'converted',
        (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      );
      expect(refusal).toContain('indirect');
      const job = { file: TIKA_INDIRECT, source: 'djvu', target: 'pdf', verdict: 'refused', ms: 0, detail: refusal } as const;
      expect(knownRefusal(job, readKnownRefusals()), refusal).not.toBeNull();
      const out = path.join(scratchDir('djvu-indirect-'), 'out.pdf');
      expect(() => run('ddjvu', ['-format=pdf', sample.path, out])).toThrow();
    },
    CONVERSION_TIMEOUT_MS
  );

  for (const fraction of [0.3, 0.9]) {
    it(
      `a Hansard file cut at ${fraction} of its length is refused as truncated, as it is by the program`,
      async (ctx) => {
        const sample = await requireRealworldSample(ctx, HANSARD);
        const cut = sample.bytes.subarray(0, Math.floor(sample.bytes.length * fraction));
        await expect(dispatchConversion(cut, 'djvu', 'pdf', {}, HANSARD)).rejects.toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('truncated') });
        expect(() => run('ddjvu', ['-format=pdf', writeTemp(cut, 'cut.djvu'), path.join(scratchDir('djvu-cut-'), 'out.pdf')])).toThrow();
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  it(
    'a document of 34 pages cut inside its last page is refused, not drawn with 33 pages',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, DOGV);
      const cut = bytes.subarray(0, bytes.length - 100);
      await expect(dispatchConversion(cut, 'djvu', 'pdf', {}, DOGV)).rejects.toMatchObject({ name: 'CorruptStreamError' });
    },
    CONVERSION_TIMEOUT_MS
  );

  it(
    'a page of an indirect document refuses to be converted alone because the program would read the shared data from the directory next to it',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, DOGV);
      const dir = scratchDir('djvu-indirect-pages-');
      run('djvmcvt', ['-i', writeTemp(bytes, 'dogv.djvu'), dir, 'index.djvu']);
      const page = path.join(dir, 'p0001.djvu');
      const withSibling = path.join(scratchDir('djvu-page-out-'), 'with.pdf');
      run('ddjvu', ['-format=pdf', page, withSibling]);
      expect(pdfinfoPages(fs.readFileSync(withSibling))).toBe(1);
      const alone = path.join(scratchDir('djvu-page-alone-'), 'p0001.djvu');
      fs.copyFileSync(page, alone);
      expect(() => run('ddjvu', ['-format=pdf', alone, path.join(scratchDir('djvu-page-out-'), 'alone.pdf')])).toThrow();
      await expect(dispatchConversion(fs.readFileSync(page), 'djvu', 'pdf', {}, 'p0001.djvu')).rejects.toMatchObject({ message: expect.stringContaining('INCL') });
    },
    CONVERSION_TIMEOUT_MS
  );
});

describe.skipIf(!haveTools)('the page limits', () => {
  /** A document of `count` pages of 8 x 8 pixels, written by the djvulibre encoders. */
  function tinyDocument(count: number): Buffer {
    const dir = scratchDir('djvu-tiny-');
    const bitmap = path.join(dir, 'page.pbm');
    fs.writeFileSync(bitmap, Buffer.concat([Buffer.from('P4\n8 8\n', 'latin1'), Buffer.from([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55])]));
    const page = path.join(dir, 'page.djvu');
    run('cjb2', [bitmap, page]);
    const document = path.join(dir, 'document.djvu');
    run('djvm', ['-c', document, ...Array.from({ length: count }, () => page)]);
    return fs.readFileSync(document);
  }

  it(
    `writes a PDF of ${IMAGE_PAGE_LIMIT + 1} pages and refuses their images, as the other page chains do`,
    async () => {
      const bytes = tinyDocument(IMAGE_PAGE_LIMIT + 1);
      const pdf = await dispatchConversion(bytes, 'djvu', 'pdf', {}, 'many.djvu');
      expect(pdfinfoPages(pdf.buffer)).toBe(IMAGE_PAGE_LIMIT + 1);
      await expect(dispatchConversion(bytes, 'djvu', 'png', {}, 'many.djvu')).rejects.toMatchObject({ name: 'PayloadLimitError', status: 413 });
      const some = await dispatchConversion(bytes, 'djvu', 'png', { pages: '1' }, 'many.djvu');
      expect((await sharp(some.buffer).metadata()).format).toBe('png');
    },
    CONVERSION_TIMEOUT_MS
  );
});

describe('the program and its limits', () => {
  /** A stand-in for `ddjvu` that runs `body` with the input, the output and the directory of the job as `$in`, `$out` and `$dir`. */
  function standIn(body: string): string {
    const dir = scratchDir('djvu-stand-in-');
    const script = path.join(dir, 'ddjvu');
    fs.writeFileSync(script, `#!/bin/sh\nin="$2"\nout="$3"\ndir="$(dirname "$out")"\n${body}\n`);
    fs.chmodSync(script, 0o755);
    return script;
  }

  async function convertWith(interpreter: string, tgt: string, options: DjvuJob['options'] = {}, input: Buffer = singlePage(64, 64)): Promise<Awaited<ReturnType<typeof convertDjvu>>> {
    const job: DjvuJob = {
      input,
      src: 'djvu',
      tgt,
      options,
      originalFilename: 'stand-in.djvu',
      interpreter,
      convertPdfPages: async () => null,
      countPdfPages: countPagesOfReadablePdf,
    };
    return convertDjvu(job);
  }

  const refusalOf = async (conversion: Promise<unknown>): Promise<Error> => {
    const outcome = await conversion.then(
      () => null,
      (error: unknown) => error
    );
    if (!(outcome instanceof Error)) throw new Error('the conversion was not refused');
    return outcome;
  };

  it('starts the program on a directory that holds the one file and nothing else, with the arguments of the reference service', async () => {
    const error = await refusalOf(convertWith(standIn('echo "args: $1 $(basename "$in") $(basename "$out")" >&2\nls -A "$dir" | tr "\\n" " " >&2\nexit 10'), 'pdf'));
    expect(error.message).toContain('args: -format=pdf document.djvu rendered.pdf');
    expect(error.message.split('\n').at(-1)).toBe('document.djvu');
  });

  it('names what the program printed when it fails, with the job directory hidden', async () => {
    const error = await refusalOf(convertWith(standIn('echo "ddjvu: Cannot decode page 2. $dir" >&2\nexit 10'), 'pdf'));
    expect(error).toMatchObject({ name: 'ConversionFailedError' });
    expect(error.message).toContain('Cannot decode page 2.');
    expect(error.message).toContain('<tmp>');
  });

  it('refuses a PDF with fewer pages than the document lists, which is what a program that skipped a page writes', async () => {
    const dir = scratchDir('djvu-one-page-');
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    fs.writeFileSync(path.join(dir, 'one.pdf'), await document.save());
    const error = await refusalOf(convertWith(standIn(`cp '${path.join(dir, 'one.pdf')}' "$out"`), 'pdf', {}, bundledDocument([pageForm(64, 64), pageForm(64, 64)])));
    expect(error).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('drew 1 of the 2 pages') });
  });

  it('refuses output that is empty', async () => {
    const error = await refusalOf(convertWith(standIn(': > "$out"'), 'pdf'));
    expect(error).toMatchObject({ name: 'ConversionFailedError', message: 'ddjvu drew no page from the .djvu file.' });
  });

  it('stops a program that runs past the time limit', async () => {
    const error = await refusalOf(convertWith(standIn('sleep 30'), 'pdf', { timeoutMs: 1_500 }));
    expect(error.name).toBe('SandboxedTimeoutError');
  }, 20_000);

  it('refuses a PDF too large for the page tools before it is read for an image target', async () => {
    const error = await refusalOf(convertWith(standIn('dd if=/dev/null of="$out" bs=1048576 seek=200 count=0 2>/dev/null'), 'png'));
    expect(error).toMatchObject({ name: 'PayloadLimitError', status: 413 });
  });

  it('reports the missing program as an unavailable engine named ddjvu, not as a bad document', async () => {
    const error = await withMissingBinary('DDJVU_PATH', () => refusalOf(dispatchConversion(singlePage(64, 64), 'djvu', 'pdf', {}, 'a.djvu')));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error).toMatchObject({ engineName: 'ddjvu' });
  });
});
