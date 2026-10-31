import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { bundleOf, chunk, form, includeChunk, pageForm, singlePage, waveletForm, type BundleFile } from './helpers/djvu-builder';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';
import { withMissingBinary } from './helpers/native-tools';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * DjVu documents drawn by `ddjvu` of djvulibre. The oracles are djvulibre's own programs run on the same file and the PDF tools
 * reading the result back: `ddjvu -format=pdf` (the PDF the program writes by itself), `djvused -e n` (the page count the
 * document directory gives), `djvutxt` (the hidden text layer of a page), and `pdfinfo`, `pdftoppm` and `pdftotext` of Poppler.
 * The real files are the DjVu files of the real-world corpus.
 */

const haveTools = !skipWithoutTools('ddjvu', 'djvutxt', 'djvused', 'djvmcvt', 'djvm', 'cjb2', 'c44', 'bzz', 'pdfinfo', 'pdftoppm', 'pdftotext');
const haveOcr = !skipWithoutTools('tesseract');
const CONVERSION_TIMEOUT_MS = 180_000;
/** The refusal of a document of the review takes 7 ms with both programs started (measured); ddjvu takes over a minute on the same file. */
const REFUSAL_EXPECTED_LOCAL_MS = 50;
const HANG_GUARD_MS = 10_000;
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

describe.skipIf(!haveTools)('documents built byte by byte, against the pages djvused reports', () => {
  const WIDTH = 64;
  const HEIGHT = 48;
  const SIDE = WIDTH;
  const BIG_SIDE = 1500;
  const PIXEL_LIMIT_ENV = 'EASYCONVERT_MAX_INPUT_PIXELS';
  const LOWERED_PIXEL_LIMIT = 1_000_000;

  /** A `FORM:DJVU` page of a gradient, as `c44` writes it: wavelet chunks, in colour or grey. */
  function encodedPicture(width: number, height: number, colour: boolean): Buffer {
    const dir = scratchDir('djvu-c44-');
    const source = path.join(dir, colour ? 'in.ppm' : 'in.pgm');
    const samples = colour ? 3 : 1;
    const pixels = Buffer.alloc(width * height * samples);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 7 + (index >> 8)) & 0xff;
    fs.writeFileSync(source, Buffer.concat([Buffer.from(`${colour ? 'P6' : 'P5'}\n${width} ${height}\n255\n`, 'latin1'), pixels]));
    const out = path.join(dir, 'out.djvu');
    run('c44', [source, out]);
    return fs.readFileSync(out);
  }

  const colourForm = () => waveletForm('PM44', encodedPicture(WIDTH, HEIGHT, true));
  const greyForm = () => waveletForm('BM44', encodedPicture(WIDTH, HEIGHT, false));
  const djvuPage = () => pageForm(WIDTH + 16, HEIGHT + 8, [chunk('Sjbz', Buffer.alloc(0))]);

  /** The pages `djvused` counts in the document, and what the converter writes for it, against the PDF `ddjvu` writes by itself. */
  async function expectDrawnAsListed(bytes: Buffer, pages: number): Promise<void> {
    const file = writeTemp(bytes, 'built.djvu');
    expect(Number.parseInt(run('djvused', ['-e', 'n', file]).trim(), 10)).toBe(pages);
    const result = await dispatchConversion(bytes, 'djvu', 'pdf', {}, 'built.djvu');
    const ours = writeTemp(result.buffer, 'ours.pdf');
    const reference = referencePdf(file);
    expect(pdfinfoPages(result.buffer)).toBe(pages);
    expect(pageSizes(ours, pages)).toEqual(pageSizes(reference, pages));
    const declared = run('djvused', ['-e', 'size', file]).trim().split('\n').map((line) => [...line.matchAll(/\d+/g)].map((digits) => Number(digits[0])));
    const drawn = pageSizes(ours, pages).map((size) => [...size.matchAll(/[\d.]+/g)].map((number) => Number(number[0])));
    expect(declared).toHaveLength(pages);
    declared.forEach(([width, height], index) => expect(width / height, `page ${index + 1}`).toBeCloseTo(drawn[index][0] / drawn[index][1], 2));
    for (let page = 1; page <= pages; page++) expect(rasterOf(ours, page).equals(rasterOf(reference, page)), `page ${page}`).toBe(true);
  }

  it('draws a bundle of one PM44 page, which a model of FORM:DJVU pages calls a document with no page', async () => {
    await expectDrawnAsListed(bundleOf([{ form: colourForm(), kind: 'page', id: 'p.iw4' }]), 1);
  });

  it('draws a bundle of one BM44 page', async () => {
    await expectDrawnAsListed(bundleOf([{ form: greyForm(), kind: 'page', id: 'p.iw4' }]), 1);
  });

  it('counts the pages by the flags of the directory: a FORM:DJVU flagged as shared data is no page, and a PM44 flagged as a page is', async () => {
    const bytes = bundleOf([
      { form: djvuPage(), kind: 'include', id: 'a.djvu' },
      { form: colourForm(), kind: 'page', id: 'p.iw4' },
    ]);
    await expectDrawnAsListed(bytes, 1);
  });

  it('draws the two pages of a version 0 directory, whose offsets and sizes sit in the clear', async () => {
    const bytes = bundleOf(
      [
        { form: djvuPage(), kind: 'page', id: 'a.djvu' },
        { form: colourForm(), kind: 'page', id: 'b.iw4' },
      ],
      { version: 0 }
    );
    await expectDrawnAsListed(bytes, 2);
  });

  it('draws a document whose directory lists thumbnails after the pages', async () => {
    const bytes = bundleOf([
      { form: djvuPage(), kind: 'page', id: 'a.djvu' },
      { form: form('THUM', [chunk('TH44', Buffer.alloc(8))]), kind: 'thumbnails', id: 'thumbs.iff' },
    ]);
    await expectDrawnAsListed(bytes, 1);
  });

  it('refuses a big picture behind a small page, which a model of FORM:DJVU pages sees as a 64 x 64 document (the review of PR 935, poc_c)', async () => {
    const previous = process.env[PIXEL_LIMIT_ENV];
    process.env[PIXEL_LIMIT_ENV] = String(LOWERED_PIXEL_LIMIT);
    try {
      const bytes = bundleOf([
        { form: djvuPage(), kind: 'include', id: 'a.djvu' },
        { form: waveletForm('BM44', encodedPicture(BIG_SIDE, BIG_SIDE, false)), kind: 'page', id: 'p.iw4' },
      ]);
      await expect(dispatchConversion(bytes, 'djvu', 'pdf', {}, 'hidden.djvu')).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413 });
      const small = bundleOf([{ form: waveletForm('BM44', encodedPicture(WIDTH, HEIGHT, false)), kind: 'page', id: 'p.iw4' }]);
      expect(pdfinfoPages((await dispatchConversion(small, 'djvu', 'pdf', {}, 'small.djvu')).buffer)).toBe(1);
    } finally {
      if (previous === undefined) delete process.env[PIXEL_LIMIT_ENV];
      else process.env[PIXEL_LIMIT_ENV] = previous;
    }
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a page-flagged file that is no picture, which djvused counts as a page and gives no size', async () => {
    const bytes = bundleOf([{ form: form('DJVI', [chunk('Djbz', Buffer.alloc(4))]), kind: 'page', id: 'a.djvu' }]);
    await expect(dispatchConversion(bytes, 'djvu', 'pdf', {}, 'flagged.djvu')).rejects.toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('do not agree') });
  });

  /** The real `djvused` next to a `ddjvu` that leaves a file when it is started, to show that a refusal came before it. */
  function realReportWithMarkedRenderer(): { interpreter: string; started: string } {
    const dir = scratchDir('djvu-marked-');
    const started = path.join(dir, 'started');
    fs.writeFileSync(path.join(dir, 'ddjvu'), `#!/bin/sh\ntouch '${started}'\nexit 10\n`);
    fs.chmodSync(path.join(dir, 'ddjvu'), 0o755);
    fs.symlinkSync(requireOracleTool('djvused'), path.join(dir, 'djvused'));
    return { interpreter: path.join(dir, 'ddjvu'), started };
  }

  async function convertBuilt(program: { interpreter: string }, bytes: Buffer): Promise<unknown> {
    return convertDjvu({
      input: bytes,
      src: 'djvu',
      tgt: 'pdf',
      options: {},
      originalFilename: 'built.djvu',
      interpreter: program.interpreter,
      convertPdfPages: async () => null,
      countPdfPages: countPagesOfReadablePdf,
    });
  }

  it('refuses a chain of shared files that include the next two before ddjvu is started, as the document of the review is (poc_f)', async () => {
    const shared = chunk('Djbz', Buffer.alloc(4));
    const levels = 40;
    const files: BundleFile[] = [{ form: pageForm(SIDE, SIDE, [includeChunk('i0')]), kind: 'page', id: 'page' }];
    for (let index = 0; index < levels; index++) {
      const next = [index + 1, index + 2].filter((target) => target < levels).map((target) => includeChunk(`i${target}`));
      files.push({ form: form('DJVI', [...next, shared]), kind: 'include', id: `i${index}` });
    }
    const program = realReportWithMarkedRenderer();
    const started = Date.now();
    await expect(convertBuilt(program, bundleOf(files))).rejects.toMatchObject({ name: 'DjvuIncludeGraphError', status: 422 });
    expect(fs.existsSync(program.started)).toBe(false);
    expectWithinHangGuard('the refusal of poc_f 40', Date.now() - started, { guardMs: HANG_GUARD_MS, expectedLocalMs: REFUSAL_EXPECTED_LOCAL_MS });
  });

  it('refuses a document of two shared files that include each other before djvused reads its sizes, which crashes it on such a document', async () => {
    const shared = chunk('Djbz', Buffer.alloc(4));
    const files: BundleFile[] = [
      { form: pageForm(SIDE, SIDE, [includeChunk('a')]), kind: 'page', id: 'page' },
      { form: form('DJVI', [includeChunk('b'), shared]), kind: 'include', id: 'a' },
      { form: form('DJVI', [includeChunk('a'), shared]), kind: 'include', id: 'b' },
    ];
    const bytes = bundleOf(files);
    const sizes = spawnSync(requireOracleTool('djvused'), ['-e', 'size', writeTemp(bytes, 'cycle.djvu')]);
    expect(sizes.status).not.toBe(0);
    const program = realReportWithMarkedRenderer();
    await expect(convertBuilt(program, bytes)).rejects.toMatchObject({ name: 'DjvuIncludeGraphError', message: expect.stringContaining('cycle') });
    expect(fs.existsSync(program.started)).toBe(false);
  });
});

describe('the programs and their limits', () => {
  const DIRECTORY = (pages: number) => `printf '${pages}\\n'; i=1; while [ $i -le ${pages} ]; do printf '%4d P %8d  p%d.djvu\\n' $i 100 $i; i=$((i+1)); done`;
  const SIZES = (pages: number, side = 64) => `i=1; while [ $i -le ${pages} ]; do echo 'width=${side} height=${side}'; i=$((i+1)); done`;

  interface StandIn {
    readonly interpreter: string;
    /** The file the `ddjvu` stand-in writes the arguments and the directory listing to; absent when the program was never started. */
    readonly started: string;
  }

  /**
   * A directory with a stand-in for `ddjvu` that runs `body` with the input, the output and the directory of the job as `$in`,
   * `$out` and `$dir`, and a stand-in for `djvused` next to it that prints the directory or the sizes of a document of `pages`
   * pages of `side` pixels (or runs `reporter` when given).
   */
  function standIn(body: string, options: { pages?: number; side?: number; reporter?: string; djvused?: boolean } = {}): StandIn {
    const { pages = 1, side = 64, reporter, djvused = true } = options;
    const dir = scratchDir('djvu-stand-in-');
    const started = path.join(dir, 'started');
    fs.writeFileSync(
      path.join(dir, 'ddjvu'),
      `#!/bin/sh\ntouch '${started}'\nfor a in "$@"; do in="$out"; out="$a"; done\ndir="$(dirname "$out")"\necho "$*" > '${started}'\n${body}\n`
    );
    fs.chmodSync(path.join(dir, 'ddjvu'), 0o755);
    if (djvused) {
      fs.writeFileSync(path.join(dir, 'djvused'), `#!/bin/sh\n${reporter ?? `case "$2" in n*) ${DIRECTORY(pages)};; size) ${SIZES(pages, side)};; esac`}\n`);
      fs.chmodSync(path.join(dir, 'djvused'), 0o755);
    }
    return { interpreter: path.join(dir, 'ddjvu'), started };
  }

  const NO_RESULT = 'the conversion of the pages was not asked';

  async function convertWith(program: StandIn, tgt: string, options: DjvuJob['options'] = {}, input: Buffer = singlePage(64, 64), captured: { options?: DjvuJob['options'] } = {}): Promise<Awaited<ReturnType<typeof convertDjvu>>> {
    const job: DjvuJob = {
      input,
      src: 'djvu',
      tgt,
      options,
      originalFilename: 'stand-in.djvu',
      interpreter: program.interpreter,
      convertPdfPages: async (_pdf, _tgt, pageOptions) => {
        captured.options = pageOptions;
        return { buffer: Buffer.from(NO_RESULT), mimeType: 'image/png', filename: 'x.png', size: NO_RESULT.length, engineUsed: 'native-poppler', executionTimeMs: 0 };
      },
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

  /** A PDF of `pages` blank pages in the scratch directory, for a stand-in to copy to its output. */
  async function pdfOfPages(pages: number): Promise<string> {
    const dir = scratchDir('djvu-pdf-');
    const document = await PDFDocument.create();
    for (let page = 0; page < pages; page++) document.addPage([612, 792]);
    fs.writeFileSync(path.join(dir, 'pages.pdf'), await document.save());
    return path.join(dir, 'pages.pdf');
  }

  it('starts the program on a directory that holds the one file and nothing else, with the arguments of the reference service', async () => {
    const program = standIn('echo "args: $* $(basename "$in") $(basename "$out")" >&2\nls -A "$dir" | tr "\\n" " " >&2\nexit 10');
    const error = await refusalOf(convertWith(program, 'pdf'));
    expect(error.message).toContain('args: -format=pdf');
    expect(error.message).toContain('document.djvu rendered.pdf');
    expect(error.message.split('\n').at(-1)).toBe('document.djvu');
  });

  it('names what the program printed when it fails, with the job directory hidden', async () => {
    const error = await refusalOf(convertWith(standIn('echo "ddjvu: Cannot decode page 2. $dir" >&2\nexit 10'), 'pdf'));
    expect(error).toMatchObject({ name: 'ConversionFailedError' });
    expect(error.message).toContain('Cannot decode page 2.');
    expect(error.message).toContain('<tmp>');
  });

  it('refuses a PDF with fewer pages than the document lists, which is what a program that skipped a page writes', async () => {
    const program = standIn(`cp '${await pdfOfPages(1)}' "$out"`, { pages: 2 });
    const error = await refusalOf(convertWith(program, 'pdf'));
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

  it('reports a djvused that is not next to ddjvu as an unavailable engine named djvused, before anything is drawn', async () => {
    const program = standIn('exit 0', { djvused: false });
    const error = await refusalOf(convertWith(program, 'pdf'));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect(error).toMatchObject({ engineName: 'djvused' });
    expect(fs.existsSync(program.started)).toBe(false);
  });

  describe('what djvused reports decides before ddjvu starts', () => {
    it.each([
      ['more pages than the limit', { pages: 10_001 }, 'PayloadLimitError', 413],
      ['a page over the pixel limit', { side: 12_000 }, 'InputPixelLimitError', 413],
      ['a page of no size', { side: 0 }, 'CorruptStreamError', 400],
    ])('refuses %s', async (_name, options, name, status) => {
      const program = standIn('exit 0', options);
      const error = await refusalOf(convertWith(program, 'pdf'));
      expect(error).toMatchObject({ name, status });
      expect(fs.existsSync(program.started)).toBe(false);
    });

    it('refuses a report that is not what the program prints, and a program that fails', async () => {
      const garbled = standIn('exit 0', { reporter: 'echo "42 pages, probably"' });
      expect(await refusalOf(convertWith(garbled, 'pdf'))).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('does not read') });
      const failing = standIn('exit 0', { reporter: 'echo "*** Failed to open document $3" >&2; exit 10' });
      const error = await refusalOf(convertWith(failing, 'pdf'));
      expect(error).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('djvused could not read the .djvu file') });
      expect(fs.existsSync(failing.started)).toBe(false);
    });
  });

  describe('the page selection of an image target', () => {
    const IMAGES = 'png';
    /** The arguments `ddjvu` was started with, the input and the output paths of the job replaced by their roles. */
    const argumentsOf = (program: StandIn): string => fs.readFileSync(program.started, 'utf-8').trim().replace(/\S+document\.djvu \S+rendered\.pdf$/, '<input> <output>');
    const WHOLE_DOCUMENT = '-format=pdf <input> <output>';

    it('draws only the selected pages, passes them to the program as one list, and asks the page tools for the pages of that PDF', async () => {
      const captured: { options?: DjvuJob['options'] } = {};
      const program = standIn(`cp '${await pdfOfPages(4)}' "$out"`, { pages: 9 });
      await convertWith(program, IMAGES, { pages: '2-4,7' }, singlePage(64, 64), captured);
      expect(argumentsOf(program)).toBe('-format=pdf -page=2-4,7 <input> <output>');
      expect(captured.options).toMatchObject({ maxRenderedPages: IMAGE_PAGE_LIMIT });
      expect(captured.options?.pages).toBeUndefined();
      expect(captured.options?.page).toBeUndefined();
    });

    it('draws the one page of a "page" option, and the first page only when a single page is wanted', async () => {
      const onePage = await pdfOfPages(1);
      const single = standIn(`cp '${onePage}' "$out"`, { pages: 9 });
      await convertWith(single, IMAGES, { page: 5 });
      expect(argumentsOf(single)).toBe('-format=pdf -page=5 <input> <output>');
      const first = standIn(`cp '${onePage}' "$out"`, { pages: 9 });
      await convertWith(first, IMAGES, { multiPageOutput: 'first' });
      expect(argumentsOf(first)).toBe('-format=pdf -page=1 <input> <output>');
    });

    it('passes no page list when the whole document is wanted, and for a PDF target whatever the request selects', async () => {
      const all = standIn(`cp '${await pdfOfPages(3)}' "$out"`, { pages: 3 });
      await convertWith(all, IMAGES);
      expect(argumentsOf(all)).toBe(WHOLE_DOCUMENT);
      const pdf = standIn(`cp '${await pdfOfPages(3)}' "$out"`, { pages: 3 });
      await convertWith(pdf, 'pdf', { pages: '2' });
      expect(argumentsOf(pdf)).toBe(WHOLE_DOCUMENT);
    });

    it(`counts the ${IMAGE_PAGE_LIMIT} page bound on the selected pages: ${IMAGE_PAGE_LIMIT + 1} are refused before anything is drawn, three of ${IMAGE_PAGE_LIMIT + 1} are drawn`, async () => {
      const refused = standIn('exit 0', { pages: IMAGE_PAGE_LIMIT + 1 });
      expect(await refusalOf(convertWith(refused, IMAGES, { pages: `1-${IMAGE_PAGE_LIMIT + 1}` }))).toMatchObject({ name: 'PayloadLimitError', status: 413 });
      expect(await refusalOf(convertWith(refused, IMAGES))).toMatchObject({ name: 'PayloadLimitError', status: 413 });
      expect(fs.existsSync(refused.started)).toBe(false);
      const drawn = standIn(`cp '${await pdfOfPages(3)}' "$out"`, { pages: IMAGE_PAGE_LIMIT + 1 });
      await convertWith(drawn, IMAGES, { pages: '10-12' });
      expect(argumentsOf(drawn)).toBe('-format=pdf -page=10-12 <input> <output>');
    });

    it('refuses a page the document does not have, before anything is drawn', async () => {
      const program = standIn('exit 0', { pages: 3 });
      expect(await refusalOf(convertWith(program, IMAGES, { page: 4 }))).toMatchObject({ name: 'InvalidPageRangeError' });
      expect(await refusalOf(convertWith(program, IMAGES, { pages: '2-9' }))).toMatchObject({ name: 'InvalidPageRangeError' });
      expect(fs.existsSync(program.started)).toBe(false);
    });

    it('checks the PDF against the number of selected pages, not against the document', async () => {
      const program = standIn(`cp '${await pdfOfPages(3)}' "$out"`, { pages: 9 });
      const error = await refusalOf(convertWith(program, IMAGES, { pages: '2-3' }));
      expect(error).toMatchObject({ name: 'ConversionFailedError', message: expect.stringContaining('drew 3 of the 2 pages') });
    });
  });
});
