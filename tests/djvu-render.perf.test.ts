import { describe, expect, it } from 'vitest';
import { convertDjvu } from '../src/worker/djvu-render';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { bundleOf, form, includeChunk, pageForm, type BundleFile } from './helpers/djvu-builder';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * The time a hostile DjVu file holds a worker, with the real `ddjvu` and `djvused`, judged in the nightly performance workflow on a
 * quiet machine (`npx vitest run --no-file-parallelism .perf.test.ts`). `ddjvu` makes a thread for each file of a chain of shared
 * files that include one another and waits on them (entry 134 of docs/policy-decisions.md); under the address space limit of the sandbox
 * (2 GiB, Linux only: macOS does not enforce it) a chain of 300 files holds 252 threads until the budget of `ddjvu` ends it. The file
 * declares its page sizes, which `djvused` accepts, so the budget must not lengthen with them: the pixels it counts are capped by the
 * bytes of the file (16 pixels a byte). Measured on the 4 vCPU arm64 test VM (djvulibre 3.5.28): 15.06 to 15.11 s for the
 * three files below, against 40.07 s and 120.02 s (the deadline of the job) when the declared pixels were counted whole.
 */

const toolsMissing = skipWithoutTools('ddjvu', 'djvused');
const notLinux = skipUnless('Linux, which enforces the address space limit of the sandbox', process.platform === 'linux');
const TEST_TIMEOUT_MS = 180_000;
const CHAIN_LEVELS = 300;
const DECLARED_SIDE = 9_999;
const SMALL_SIDE = 64;
/** The floor of the budget, twice over: the budget is the floor, 16 times the reports (well under a second of them) and the 35 ms the 9 KB of these files credit, so it stays below twice the floor whatever the reports took. */
const FLOOR_MS = 15_000;
const BUDGET_CEILING_MS = 2 * FLOOR_MS;
const LAUNCH_SLACK_MS = 3_000;
const REVISIT = 'a chain of 300 shared files was drawn or ended otherwise than by the budget: if this djvulibre draws the chain, that is the revisit condition of entry 134 of docs/policy-decisions.md, so retire the chain rows there and here';

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

async function outcomeOf(bytes: Buffer): Promise<{ elapsedMs: number; outcome: string }> {
  const started = Date.now();
  const outcome = await convertDjvu({
    input: bytes,
    src: 'djvu',
    tgt: 'pdf',
    options: {},
    originalFilename: 'chain.djvu',
    interpreter: requireOracleTool('ddjvu'),
    convertPdfPages: async () => null,
    countPdfPages: countPagesOfReadablePdf,
  }).then(
    () => 'drawn',
    (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  );
  return { elapsedMs: Date.now() - started, outcome };
}

describe.skipIf(toolsMissing || notLinux)('a chain of 300 shared files that ddjvu cannot finish', () => {
  it.each([
    ['one page of 64 x 64 pixels', 1, SMALL_SIDE],
    ['one page declared 9,999 x 9,999 pixels', 1, DECLARED_SIDE],
    ['six pages declared 9,999 x 9,999 pixels each', 6, DECLARED_SIDE],
  ])('is ended at the floor of the budget, whatever the pages declare: %s', async (_name, pages, side) => {
    const bytes = chainOfPages(pages, side);
    const { elapsedMs, outcome } = await outcomeOf(bytes);
    const given = /ddjvu ran past the (\d+) ms its pages allow/.exec(outcome);
    expect(outcome, REVISIT).toMatch(/^CpuTaskTimeoutError: The \.djvu document took too long to draw/);
    expect(Number(given?.[1])).toBeGreaterThanOrEqual(FLOOR_MS);
    expect(Number(given?.[1])).toBeLessThan(BUDGET_CEILING_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(FLOOR_MS);
    expect(elapsedMs).toBeLessThan(BUDGET_CEILING_MS + LAUNCH_SLACK_MS);
  }, TEST_TIMEOUT_MS);
});
