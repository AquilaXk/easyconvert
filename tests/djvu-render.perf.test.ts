import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertDjvu } from '../src/worker/djvu-render';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { bundleOf, chunk, chunksOfId, form, includeChunk, maskedPageOf, maskOverChain, pageForm, type BundleFile } from './helpers/djvu-builder';
import { requireOracleTool } from './helpers/differential-oracle';
import { DISTRIBUTION_DDJVU, djvuRunsCanStart, patchedDdjvu } from './helpers/djvulibre-build';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The time a DjVu file holds a worker, with the real `ddjvu` and `djvused`, judged in the nightly performance workflow on a quiet
 * machine (`npx vitest run --no-file-parallelism .perf.test.ts`). Entry 135 of docs/policy-decisions.md has the measurements.
 *
 * A chain of shared files that include one another made the unpatched `ddjvu` 3.5.28 start a thread for each file and wait on them
 * forever once a thread could not start, until its budget ended it. The patched build (scripts/install-djvulibre.sh) fails the
 * drawing at once, under the task limit of a run in the production-like container in 0.08 s.
 *
 * The JB2 mask of a page that needs a shape dictionary made the unpatched program search the files the page includes once for each
 * path (8.2 s at 30 shared files that each include the next two, 1.7 times as long for each more); the patched program reports the
 * missing dictionary of the mask of a real page over 40 and 60 such files in 0.02 s, where the distribution's is still searching.
 * It also searched again for every chunk decoded below the page, until the patch let only a shape dictionary wake the search: over 60
 * such files of 600 small chunks each, 2.2 s before and 0.7 s after, the time the chain takes to decode without a mask.
 *
 * A plain chain of 64 shared files that each carry a background is refused at the task limit once the files that started have decoded
 * their backgrounds, in 1.2 s at 2.5 CPUs: the time a run holds its 64 tasks, of which a worker runs two at once.
 *
 * The budget of `ddjvu` counts at most 128 pixels for each byte of the file. A long document of smooth colour pages, the measured
 * document that needs the most time for its bytes (8 pages of a 100 megapixel page, 369 pixels a byte), draws in 15 s alone and in 24.7
 * to 26.5 s four at once on 2.5 CPUs, against 84.4 s of budget; 100 blank pages declared 9,999 x 9,999 in a file of 3.5 KB, which the
 * program draws in 45.8 s, end with the budget at 15.1 s instead of holding the worker for that long.
 */

const toolsMissing = skipWithoutTools('ddjvu', 'djvused', 'c44', 'djvm');
const notLinux = skipUnless('Linux, which enforces the address space and task limits of the sandbox', process.platform === 'linux');
const notPatched = skipUnless('the djvulibre build of scripts/install-djvulibre.sh', patchedDdjvu() !== undefined);
const runsCannotStart = skipUnless('a user namespace of its own and prlimit for each DjVu run (Linux)', djvuRunsCanStart());
const noDistributionBuild = skipUnless(`the distribution's ddjvu at ${DISTRIBUTION_DDJVU}, the reference of the patched build`, fs.existsSync(DISTRIBUTION_DDJVU));
const TEST_TIMEOUT_MS = 300_000;
const CHAIN_LEVELS = 300;
const DECLARED_SIDE = 9_999;
const SMALL_SIDE = 64;
/** The chain ends in 0.05 to 1.2 s (the task limit or, without a user namespace, the address space stops its threads); twice the slower. */
const CHAIN_REFUSED_WITHIN_MS = 2_500;
/** The deadline of the job (the default stage limit), of which the smooth document may take a third. */
const JOB_DEADLINE_MS = 120_000;
/** The floor of the budget of `ddjvu`, at which the blank pages end: their bytes credit them 0.06 s more. */
const DRAW_BUDGET_FLOOR_MS = 15_000;
const BLANK_PAGES = 100;
/** The first page of DOGV and the shared file of the dictionary its JB2 mask needs, as `djvmcvt -i` names them. */
const DOGV = 'wc-dogv-12042005.djvu';
const DOGV_FIRST_PAGE = 'p0001.djvu';
const DOGV_DICTIONARY = 'dict0020.iff';
const MASK_CHAIN_LEVELS = [40, 60];
/** The patched program reports the missing dictionary in 0.02 to 0.06 s, under the bound of the chain refusals. */
const MASK_REFUSED_WITHIN_MS = CHAIN_REFUSED_WITHIN_MS;
/** How long the distribution's program must still be searching the mask over 40 files, of the about 1,000 s it would take. */
const DISTRIBUTION_STILL_SEARCHING_MS = 5_000;
const SMOOTH_PAGES = 8;
const SMOOTH_SIDE = 10_000;
const DATA_CHAIN_LEVELS = 64;
/** The side of the smooth colour background each file of the data-bearing chain carries (about 51 KB of wavelet chunks, 16 megapixels). */
const DATA_SIDE = 4_000;
/** The data-bearing chain ends in 1.2 s at 2.5 CPUs; its tasks are held for less than a third of the floor of the budget. */
const DATA_CHAIN_HELD_WITHIN_MS = DRAW_BUDGET_FLOOR_MS / 3;
const WAKE_CHAIN_LEVELS = 60;
const WAKE_CHAIN_CHUNKS = 600;
/**
 * The mask over the chain of small chunks ends in 0.7 s at 2.5 CPUs, the 0.8 s the chain takes to decode without the mask; searching
 * again for every chunk made it 2.2 s, 2.8 times as long.
 */
const WAKE_CHAIN_SEARCH_FACTOR = 1.5;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** `pages` pages that each include the first of `CHAIN_LEVELS` shared files, which each include the next, and nothing else. */
function chainOfPages(pages: number, side: number): Buffer {
  const files: BundleFile[] = [];
  for (let page = 0; page < pages; page++) files.push({ form: pageForm(side, side, [includeChunk('i0')]), kind: 'page', id: `p${page}.djvu` });
  for (let level = 0; level < CHAIN_LEVELS; level++) {
    const next = level + 1 < CHAIN_LEVELS ? [includeChunk(`i${level + 1}`)] : [];
    files.push({ form: form('DJVI', next), kind: 'include', id: `i${level}` });
  }
  return bundleOf(files);
}

/** A smooth colour page of `side` x `side` pixels (low-frequency waves in each channel) encoded by `c44` into `dir`/page.djvu. */
function smoothColourPage(dir: string, side: number): string {
  const ppm = path.join(dir, 'page.ppm');
  const fd = fs.openSync(ppm, 'w');
  fs.writeSync(fd, `P6\n${side} ${side}\n255\n`);
  const row = Buffer.alloc(side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      row[x * 3] = 128 + 127 * Math.sin(x / 900 + y / 1300);
      row[x * 3 + 1] = 128 + 127 * Math.sin(y / 700 - x / 2100);
      row[x * 3 + 2] = ((x + y) * 255) / (2 * side);
    }
    fs.writeSync(fd, row);
  }
  fs.closeSync(fd);
  const page = path.join(dir, 'page.djvu');
  execFileSync(requireOracleTool('c44'), [ppm, page]);
  fs.rmSync(ppm);
  return page;
}

/**
 * `SMOOTH_PAGES` copies of a smooth colour page of `SMOOTH_SIDE` x `SMOOTH_SIDE` pixels, bundled by `djvm`: about 370 pixels for each byte
 * of the file.
 */
function smoothColourDocument(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-smooth-'));
  scratch.push(dir);
  const encoded = smoothColourPage(dir, SMOOTH_SIDE);
  const pages = Array.from({ length: SMOOTH_PAGES }, (_, index) => `p${index}.djvu`);
  for (const page of pages) fs.copyFileSync(encoded, path.join(dir, page));
  execFileSync(requireOracleTool('djvm'), ['-c', 'smooth.djvu', ...pages], { cwd: dir });
  return fs.readFileSync(path.join(dir, 'smooth.djvu'));
}

/** A page that includes the first of `DATA_CHAIN_LEVELS` shared files, each including the next and carrying a background of `DATA_SIDE`. */
function dataBearingChain(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-data-'));
  scratch.push(dir);
  const background = chunksOfId(fs.readFileSync(smoothColourPage(dir, DATA_SIDE)), 'BG44');
  const files: BundleFile[] = [{ form: pageForm(SMALL_SIDE, SMALL_SIDE, [includeChunk('i0')]), kind: 'page', id: 'p.djvu' }];
  for (let level = 0; level < DATA_CHAIN_LEVELS; level++) {
    const next = level + 1 < DATA_CHAIN_LEVELS ? [includeChunk(`i${level + 1}`)] : [];
    files.push({ form: form('DJVI', [...next, ...background]), kind: 'include', id: `i${level}` });
  }
  return bundleOf(files);
}

async function outcomeOf(bytes: Buffer, name: string): Promise<{ elapsedMs: number; outcome: string }> {
  const started = Date.now();
  const outcome = await convertDjvu({
    input: bytes,
    src: 'djvu',
    tgt: 'pdf',
    options: {},
    originalFilename: name,
    interpreter: requireOracleTool('ddjvu'),
    convertPdfPages: async () => null,
    countPdfPages: countPagesOfReadablePdf,
  }).then(
    () => 'drawn',
    (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  );
  return { elapsedMs: Date.now() - started, outcome };
}

describe.skipIf(toolsMissing || notLinux || notPatched || runsCannotStart)('a chain of 300 shared files whose threads cannot all start', () => {
  it.each([
    ['one page of 64 x 64 pixels', 1, SMALL_SIDE],
    ['one page declared 9,999 x 9,999 pixels', 1, DECLARED_SIDE],
    ['six pages declared 9,999 x 9,999 pixels each', 6, DECLARED_SIDE],
  ])('is refused by ddjvu at once, whatever the pages declare: %s', async (_name, pages, side) => {
    const { elapsedMs, outcome } = await outcomeOf(chainOfPages(pages, side), 'chain.djvu');
    expect(outcome).toMatch(/^ConversionFailedError: ddjvu (could not draw|exceeded its output or memory limit)/);
    expect(elapsedMs).toBeLessThan(CHAIN_REFUSED_WITHIN_MS);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(toolsMissing || notPatched || runsCannotStart)('the JB2 mask of a real page over shared files that each include the next two and none its dictionary', () => {
  it.for(MASK_CHAIN_LEVELS)('is refused by the patched ddjvu at once over %i files', { timeout: TEST_TIMEOUT_MS }, async (levels, ctx) => {
    const page = maskedPageOf((await requireRealworldSample(ctx, DOGV)).path, DOGV_FIRST_PAGE, DOGV_DICTIONARY);
    const { elapsedMs, outcome } = await outcomeOf(maskOverChain(page, levels, false), 'mask.djvu');
    expect(outcome).toMatch(/^ConversionFailedError: ddjvu could not draw the \.djvu file: .*shape dictionary/);
    expect(elapsedMs).toBeLessThan(MASK_REFUSED_WITHIN_MS);
  });

  it.skipIf(noDistributionBuild)(`keeps the distribution's ddjvu searching over ${MASK_CHAIN_LEVELS[0]} files until it is stopped`, async (ctx) => {
    const page = maskedPageOf((await requireRealworldSample(ctx, DOGV)).path, DOGV_FIRST_PAGE, DOGV_DICTIONARY);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-mask-'));
    scratch.push(dir);
    fs.writeFileSync(path.join(dir, 'mask.djvu'), maskOverChain(page, MASK_CHAIN_LEVELS[0], false));
    const run = spawnSync(DISTRIBUTION_DDJVU, ['-format=pdf', path.join(dir, 'mask.djvu'), path.join(dir, 'mask.pdf')], { timeout: DISTRIBUTION_STILL_SEARCHING_MS });
    expect(run.signal).toBe('SIGTERM');
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(toolsMissing || notPatched || runsCannotStart)(`a mask without its dictionary over ${WAKE_CHAIN_LEVELS} shared files of ${WAKE_CHAIN_CHUNKS} small chunks each`, () => {
  it('is refused in about the time the chain takes to decode without the mask, as only a shape dictionary wakes the search', async (ctx) => {
    const page = maskedPageOf((await requireRealworldSample(ctx, DOGV)).path, DOGV_FIRST_PAGE, DOGV_DICTIONARY);
    const filler = Array.from({ length: WAKE_CHAIN_CHUNKS }, () => chunk('NOPE', Buffer.alloc(2)));
    const unmasked = await outcomeOf(maskOverChain({ ...page, mask: chunk('NOPE', Buffer.alloc(2)) }, WAKE_CHAIN_LEVELS, false, filler), 'unmasked.djvu');
    expect(unmasked.outcome).toBe('drawn');
    const { elapsedMs, outcome } = await outcomeOf(maskOverChain(page, WAKE_CHAIN_LEVELS, false, filler), 'wake.djvu');
    expect(outcome).toMatch(/^ConversionFailedError: ddjvu could not draw the \.djvu file: .*shape dictionary/);
    expect(elapsedMs).toBeLessThan(WAKE_CHAIN_SEARCH_FACTOR * unmasked.elapsedMs);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(toolsMissing || notLinux || notPatched || runsCannotStart)(`a plain chain of ${DATA_CHAIN_LEVELS} shared files that each carry a background`, () => {
  it('is refused at the task limit once the started files have decoded, holding its tasks for less than a third of the floor of the budget', async () => {
    const { elapsedMs, outcome } = await outcomeOf(dataBearingChain(), 'data-chain.djvu');
    expect(outcome).toMatch(/^ConversionFailedError: ddjvu (could not draw|exceeded its output or memory limit)/);
    expect(elapsedMs).toBeLessThan(DATA_CHAIN_HELD_WITHIN_MS);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(toolsMissing || notPatched || runsCannotStart)('blank pages declared 9,999 x 9,999 pixels in a file of a few kilobytes', () => {
  it(`end with the floor of the budget for ${BLANK_PAGES} pages, instead of holding the worker for their drawing`, async () => {
    const pages: BundleFile[] = Array.from({ length: BLANK_PAGES }, (_, page) => ({ form: pageForm(DECLARED_SIDE, DECLARED_SIDE), kind: 'page', id: `p${page}.djvu` }));
    const { elapsedMs, outcome } = await outcomeOf(bundleOf(pages), 'blank.djvu');
    expect(outcome).toMatch(/^CpuTaskTimeoutError: The \.djvu document took too long to draw/);
    expect(elapsedMs).toBeLessThan(2 * DRAW_BUDGET_FLOOR_MS);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(toolsMissing || notPatched || runsCannotStart)('a long document of smooth colour pages', () => {
  it(`draws ${SMOOTH_PAGES} pages of a ${SMOOTH_SIDE} x ${SMOOTH_SIDE} smooth colour page within a third of the deadline of the job`, async () => {
    const { elapsedMs, outcome } = await outcomeOf(smoothColourDocument(), 'smooth.djvu');
    expect(outcome).toBe('drawn');
    expect(elapsedMs).toBeLessThan(JOB_DEADLINE_MS / 3);
  }, TEST_TIMEOUT_MS);
});
