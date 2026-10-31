import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertDjvu } from '../src/worker/djvu-render';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { bundleOf, form, includeChunk, maskedPageOf, maskOverChain, pageForm, type BundleFile } from './helpers/djvu-builder';
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
 *
 * The budget of `ddjvu` counts at most 64 pixels for each byte of the file. A long document of smooth colour pages, the most pixels a
 * byte measured (8 pages of a 100 megapixel page, 369 pixels a byte), draws in 16.2 s on the 4 vCPU arm64 test VM against 49.7 s of
 * budget; 100 blank pages declared 9,999 x 9,999 in a file of 3.5 KB, which the program draws in 45.8 s, end with the budget at 15 s
 * instead of holding the worker for that long.
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

/**
 * `SMOOTH_PAGES` copies of a smooth colour page of `SMOOTH_SIDE` x `SMOOTH_SIDE` pixels (low-frequency waves in each channel), encoded by
 * `c44` and bundled by `djvm`: about 370 pixels for each byte of the file.
 */
function smoothColourDocument(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-smooth-'));
  scratch.push(dir);
  const ppm = path.join(dir, 'page.ppm');
  const fd = fs.openSync(ppm, 'w');
  fs.writeSync(fd, `P6\n${SMOOTH_SIDE} ${SMOOTH_SIDE}\n255\n`);
  const row = Buffer.alloc(SMOOTH_SIDE * 3);
  for (let y = 0; y < SMOOTH_SIDE; y++) {
    for (let x = 0; x < SMOOTH_SIDE; x++) {
      row[x * 3] = 128 + 127 * Math.sin(x / 900 + y / 1300);
      row[x * 3 + 1] = 128 + 127 * Math.sin(y / 700 - x / 2100);
      row[x * 3 + 2] = ((x + y) * 255) / (2 * SMOOTH_SIDE);
    }
    fs.writeSync(fd, row);
  }
  fs.closeSync(fd);
  execFileSync(requireOracleTool('c44'), [ppm, path.join(dir, 'page.djvu')]);
  fs.rmSync(ppm);
  const pages = Array.from({ length: SMOOTH_PAGES }, (_, index) => `p${index}.djvu`);
  for (const page of pages) fs.copyFileSync(path.join(dir, 'page.djvu'), path.join(dir, page));
  execFileSync(requireOracleTool('djvm'), ['-c', 'smooth.djvu', ...pages], { cwd: dir });
  return fs.readFileSync(path.join(dir, 'smooth.djvu'));
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
