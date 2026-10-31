import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertDjvu } from '../src/worker/djvu-render';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { bundleOf, form, includeChunk, pageForm, type BundleFile } from './helpers/djvu-builder';
import { requireOracleTool } from './helpers/differential-oracle';
import { patchedDdjvu } from './helpers/djvulibre-build';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The time a DjVu file holds a worker, with the real `ddjvu` and `djvused`, judged in the nightly performance workflow on a quiet
 * machine (`npx vitest run --no-file-parallelism .perf.test.ts`). Entry 135 of docs/policy-decisions.md has the measurements.
 *
 * A chain of shared files that include one another made the unpatched `ddjvu` 3.5.28 start a thread for each file and wait on them
 * forever once a thread could not start, until its budget ended it. The patched build (scripts/install-djvulibre.sh) fails the
 * drawing at once, under the task limit of a run in the production-like container in 0.08 s. The budget of `ddjvu` now counts every
 * pixel the pages declare, so a chain that still waited would hold a worker until the deadline of the job (120 s): the six declared
 * pages below give a budget past it.
 *
 * A long document of smooth colour pages has many pixels for each byte of its file. The budget counted at most 16 pixels a byte
 * before, which cut such a document short where the program would finish (8 pages of a 100 megapixel page, 26.4 s of budget against
 * 34.7 s of drawing); it now draws within a third of the deadline (16.2 s on the 4 vCPU arm64 test VM).
 */

const toolsMissing = skipWithoutTools('ddjvu', 'djvused', 'c44', 'djvm');
const notLinux = skipUnless('Linux, which enforces the address space and task limits of the sandbox', process.platform === 'linux');
const notPatched = skipUnless('the djvulibre build of scripts/install-djvulibre.sh', patchedDdjvu() !== undefined);
const TEST_TIMEOUT_MS = 300_000;
const CHAIN_LEVELS = 300;
const DECLARED_SIDE = 9_999;
const SMALL_SIDE = 64;
/** The chain ends in 0.05 to 1.2 s (the task limit or, without a user namespace, the address space stops its threads); twice the slower. */
const CHAIN_REFUSED_WITHIN_MS = 2_500;
/** The deadline of the job (the default stage limit), of which the smooth document may take a third. */
const JOB_DEADLINE_MS = 120_000;
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

describe.skipIf(toolsMissing || notLinux || notPatched)('a chain of 300 shared files whose threads cannot all start', () => {
  it.each([
    ['one page of 64 x 64 pixels', 1, SMALL_SIDE],
    ['one page declared 9,999 x 9,999 pixels', 1, DECLARED_SIDE],
    ['six pages declared 9,999 x 9,999 pixels each, a budget past the deadline', 6, DECLARED_SIDE],
  ])('is refused by ddjvu at once, whatever the pages declare: %s', async (_name, pages, side) => {
    const { elapsedMs, outcome } = await outcomeOf(chainOfPages(pages, side), 'chain.djvu');
    expect(outcome).toMatch(/^ConversionFailedError: ddjvu (could not draw|exceeded its output or memory limit)/);
    expect(elapsedMs).toBeLessThan(CHAIN_REFUSED_WITHIN_MS);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(toolsMissing || notLinux)('a long document of smooth colour pages', () => {
  it(`draws ${SMOOTH_PAGES} pages of a ${SMOOTH_SIDE} x ${SMOOTH_SIDE} smooth colour page within a third of the deadline of the job`, async () => {
    const { elapsedMs, outcome } = await outcomeOf(smoothColourDocument(), 'smooth.djvu');
    expect(outcome).toBe('drawn');
    expect(elapsedMs).toBeLessThan(JOB_DEADLINE_MS / 3);
  }, TEST_TIMEOUT_MS);
});
