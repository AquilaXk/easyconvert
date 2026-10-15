import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performOcr, recognizePage } from '../src/lib/conversions/ocr';
import { measureUnevenBackground, OCR_UNEVEN_BACKGROUND_RATIO } from '../src/lib/conversions/ocr-preprocess';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { MAGICK_BINARY, requireMagick } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { requireTessdata, requireTesseract } from './helpers/ocr-fixtures';

/**
 * Page preparation must not make a page read worse than the bare engine does. Every page here is read twice: by
 * the project's pipeline and by the tesseract command line on the same pixels (same segmentation and engine
 * mode), and both are scored against the text that was drawn. Nothing expected comes from the code under test;
 * the pages are rendered and degraded by ImageMagick at test time, from prose written for this test, so the set
 * is independent of the pages the preparation steps were tuned on (tests/fixtures/ocr).
 */

const BENCH_SCAN = path.join(__dirname, '..', 'bench', 'corpus', 'scan.png');
const BENCH_SCAN_TRUTH = path.join(__dirname, '..', 'bench', 'corpus', 'scan.gt.txt');
const PAGE_TIMEOUT_MS = 120_000;
const SET_TIMEOUT_MS = 600_000;
const REFERENCE_TIMEOUT_MS = 60_000;
const PAGE_SIZE = '860x300';
const TEXT_ORIGIN = '+40+50';
const LINE_SPACING = '4';
/** The pipeline may differ from the reference by this many percentage points on one page. */
const PAGE_SLACK_PERCENT = 1;
/**
 * Pages allowed to exceed that slack. The 11 pt page with heavy noise is the one both readings fail on (about 28%
 * and 30% error); no preparation reads it reliably.
 */
const MAX_PAGES_OVER_SLACK = 1;
/** An unevenly lit page must be recovered, not merely read as badly as the bare engine reads it. */
const MAX_SHADED_CER_PERCENT = 5;

const PROSE = [
  'Minutes of the quarterly review of the lighthouse maintenance fund.',
  'The committee met on Tuesday and approved the revised paint schedule.',
  'Rust on the lantern gallery rail was reported by two separate keepers.',
  'A grant of nine thousand units will cover the replacement of the lens.',
  'Members asked that the contractor supply written estimates in advance.',
  'The treasurer noted that fuel costs had fallen for the third year.',
  'Volunteers will sweep the access road before the autumn open day.',
  'The next meeting is set for the first week of the new financial year.',
].join('\n');

interface Degradation {
  name: string;
  args: string[];
}

const DEGRADATIONS: readonly Degradation[] = [
  { name: 'light-noise', args: ['-blur', '0x0.8', '-seed', '3', '-attenuate', '0.5', '+noise', 'Gaussian'] },
  { name: 'heavy-noise', args: ['-blur', '0x1.2', '-seed', '4', '-attenuate', '1.0', '+noise', 'Gaussian'] },
  { name: 'left-to-right-shade', args: ['(', '-size', PAGE_SIZE, 'gradient:gray45-white', '-rotate', '90', ')', '-compose', 'multiply', '-composite', '-blur', '0x0.7'] },
  { name: 'dark-corners', args: ['-vignette', '0x120', '-blur', '0x0.7'] },
  { name: 'skew-and-noise', args: ['-rotate', '1.5', '-blur', '0x0.9', '-seed', '8', '-attenuate', '0.6', '+noise', 'Gaussian'] },
];
const FONT_SIZES: ReadonlyArray<{ font: string; points: number }> = [
  { font: 'DejaVu-Sans', points: 11 },
  { font: 'DejaVu-Sans', points: 13 },
  { font: 'DejaVu-Sans', points: 16 },
  { font: 'DejaVu-Serif', points: 13 },
];

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-selection-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** The reference reading: the CLI on the file, page segmentation 3 and the LSTM engine, as the pipeline uses. */
function referenceText(file: string): string {
  return execFileSync(requireTesseract(), [file, 'stdout', '-l', 'eng', '--tessdata-dir', requireTessdata('eng'), '--psm', '3', '--oem', '1'], {
    encoding: 'utf-8',
    timeout: REFERENCE_TIMEOUT_MS,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function renderPage(name: string, font: string, points: number, degradation: Degradation): string {
  const file = path.join(workDir, `${name}.png`);
  execFileSync(
    requireMagick(),
    [
      '-size', PAGE_SIZE, 'xc:white', '-font', font, '-pointsize', String(points), '-fill', 'black',
      '-interline-spacing', LINE_SPACING, '-annotate', TEXT_ORIGIN, PROSE,
      ...degradation.args,
      '-colorspace', 'Gray', '-depth', '8', '-strip', file,
    ],
    { timeout: REFERENCE_TIMEOUT_MS }
  );
  return file;
}

describe('page preparation against the bare engine', () => {
  oracleTest(
    'reads the benchmark scan no worse than the tesseract command line',
    ['tesseract'],
    async () => {
      const truth = fs.readFileSync(BENCH_SCAN_TRUTH, 'utf-8');
      const ours = characterErrorRatePercent(truth, (await performOcr(fs.readFileSync(BENCH_SCAN), 'eng')).text);
      const reference = characterErrorRatePercent(truth, referenceText(BENCH_SCAN));
      expect(ours).toBeLessThanOrEqual(reference);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    `reads ${FONT_SIZES.length * DEGRADATIONS.length} degraded pages on average no worse than the command line and none far worse`,
    ['tesseract'],
    async () => {
      if (!MAGICK_BINARY) throw new OracleToolMissingError('magick', 'ImageMagick is not installed');
      const rows: Array<{ name: string; ours: number; reference: number }> = [];
      for (const { font, points } of FONT_SIZES) {
        for (const degradation of DEGRADATIONS) {
          const name = `${font}-${points}-${degradation.name}`;
          const file = renderPage(name, font, points, degradation);
          const reference = characterErrorRatePercent(PROSE, referenceText(file));
          const ours = characterErrorRatePercent(PROSE, (await performOcr(fs.readFileSync(file), 'eng')).text);
          rows.push({ name, ours, reference });
        }
      }
      const mean = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
      const over = rows.filter((row) => row.ours > row.reference + PAGE_SLACK_PERCENT);
      const summary = rows.map((row) => `${row.name}: ours ${row.ours.toFixed(2)} reference ${row.reference.toFixed(2)}`).join('\n');
      expect(mean((row) => row.ours), summary).toBeLessThanOrEqual(mean((row) => row.reference));
      expect(over.length, summary).toBeLessThanOrEqual(MAX_PAGES_OVER_SLACK);
      for (const row of rows.filter((candidate) => candidate.name.includes('shade') && !candidate.name.includes('-11-'))) {
        expect(row.ours, `${row.name}\n${summary}`).toBeLessThanOrEqual(MAX_SHADED_CER_PERCENT);
      }
    },
    SET_TIMEOUT_MS
  );
});

describe('when a page is binarized', () => {
  oracleTest(
    'binarizes an unevenly lit page, and leaves a uniformly lit one and one with dark corners as they are',
    ['tesseract'],
    async () => {
      if (!MAGICK_BINARY) throw new OracleToolMissingError('magick', 'ImageMagick is not installed');
      const readOf = async (degradation: Degradation): Promise<Awaited<ReturnType<typeof recognizePage>>> =>
        recognizePage(fs.readFileSync(renderPage(degradation.name, 'DejaVu-Sans', 13, degradation)), 'eng', { detectOrientation: false });
      const byName = (name: string): Degradation => DEGRADATIONS.find((candidate) => candidate.name === name) as Degradation;
      const shaded = await readOf(byName('left-to-right-shade'));
      expect(shaded.preparation?.binarized).toBe(true);
      expect(shaded.preparation?.unevenBackground).toBeGreaterThanOrEqual(OCR_UNEVEN_BACKGROUND_RATIO);
      for (const name of ['light-noise', 'dark-corners']) {
        const read = await readOf(byName(name));
        expect(read.preparation?.binarized, name).toBe(false);
        expect(read.preparation?.unevenBackground, name).toBeLessThan(OCR_UNEVEN_BACKGROUND_RATIO);
      }
    },
    PAGE_TIMEOUT_MS
  );
});

describe('measureUnevenBackground', () => {
  const SIDE = 512;
  const PAPER_LEVEL = 240;
  const INK_LEVEL = 10;
  const DARK_EDGE_LEVEL = 100;

  const BAR_ROWS = 8;
  const BAR_PERIOD_ROWS = 32;

  /** A page of `PAPER_LEVEL` (or a ramp from `DARK_EDGE_LEVEL` to `PAPER_LEVEL` across it) with rows of dark bars as ink (3% of it). */
  function page(ramp: boolean): { data: Buffer; width: number; height: number } {
    const data = Buffer.alloc(SIDE * SIDE);
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        data[y * SIDE + x] = ramp ? Math.round(DARK_EDGE_LEVEL + ((PAPER_LEVEL - DARK_EDGE_LEVEL) * x) / (SIDE - 1)) : PAPER_LEVEL;
      }
    }
    for (let top = 0; top < SIDE; top += BAR_PERIOD_ROWS) {
      for (let y = top; y < top + BAR_ROWS; y++) data.fill(INK_LEVEL, y * SIDE + SIDE / 4, y * SIDE + SIDE / 2);
    }
    return { data, width: SIDE, height: SIDE };
  }

  it('is zero for a flat page and the share of the paper-to-ink contrast a ramp spans', () => {
    expect(measureUnevenBackground(page(false))).toBe(0);
    // Worked by hand: eight columns of 64 px, each cell's background its 90th percentile, 100 + 140 x (64 k + 57.6) / 511
    // for column k. The 5th and 95th percentile cells are columns 0 and 7 (116 and 238), the median cell is column 4
    // (186) and the darkest ink is 10, so the spread is 122 over a contrast of 176: 0.69.
    const ramp = measureUnevenBackground(page(true));
    expect(ramp).toBeGreaterThan(0.65);
    expect(ramp).toBeLessThan(0.75);
  });

  it('is zero for a page with fewer cells than a gradient needs', () => {
    expect(measureUnevenBackground({ data: Buffer.alloc(32 * 32, PAPER_LEVEL), width: 32, height: 32 })).toBe(0);
  });
});
