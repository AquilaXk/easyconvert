import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  OCR_CLI_LOGGED_STDERR_CHARS,
  OCR_CLI_MAX_CONCURRENCY,
  OCR_CLI_MAX_TSV_ROWS,
  CliSemaphore,
  parseTesseractTsv,
  recognizeWithCli,
} from '../src/lib/conversions/ocr-cli';
import { OcrEngineUnavailableError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const GROUND_TRUTH = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol.gt.txt'), 'utf-8');
const MAX_CER_PERCENT = 1;
/** Left margin the golden generator draws the first column at (generate_golden.py MARGIN). */
const GOLDEN_LEFT_MARGIN_PX = 300;
const GOLDEN_BBOX_TOLERANCE_PX = 15;
const GOLDEN_PAGE_WIDTH_PX = 2550;
const GOLDEN_PAGE_HEIGHT_PX = 2000;
const MAX_EVENT_LOOP_STALL_MS = 50;
const NS_PER_MS = 1e6;
/** The histogram records whole timer intervals, so the sampling resolution is not a stall. */
const HISTOGRAM_RESOLUTION_MS = 10;
const TEST_TIMEOUT_MS = 120_000;
const SHORT_CLI_TIMEOUT_MS = 400;
const PROCESS_REAP_WAIT_MS = 200;
const CONCURRENT_RUNS_PER_CPU = 3;
const LOG_PREFIX_ALLOWANCE = 100;
const PROC_STAT_PROBE = '/proc/self/stat';
const MEMORY_HOG_BYTES = 300_000_000;
const SMALL_MEMORY_LIMIT_MB = 100;

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function findTessdata(): string {
  const dir = TESSDATA_DIRS.find((d) => fs.existsSync(path.join(d, 'eng.traineddata')));
  if (!dir) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed');
  return dir;
}

function requireCli(): string {
  const cli = getOracleToolPath('tesseract');
  if (!cli) throw new OracleToolMissingError('tesseract');
  return cli;
}

const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

/** Hand-written TSV in the format Tesseract documents: two blocks, one two-line paragraph. */
const HANDWRITTEN_TSV = [
  TSV_HEADER,
  '1\t1\t0\t0\t0\t0\t0\t0\t1000\t800\t-1\t',
  '2\t1\t1\t0\t0\t0\t100\t100\t300\t120\t-1\t',
  '3\t1\t1\t1\t0\t0\t100\t100\t300\t120\t-1\t',
  '4\t1\t1\t1\t1\t0\t100\t100\t300\t40\t-1\t',
  '5\t1\t1\t1\t1\t1\t100\t100\t120\t40\t90.5\tHello',
  '5\t1\t1\t1\t1\t2\t240\t100\t160\t40\t80.5\tworld',
  '4\t1\t1\t1\t2\t0\t100\t180\t200\t40\t-1\t',
  '5\t1\t1\t1\t2\t1\t100\t180\t200\t40\t70\tsecond',
  '2\t1\t2\t0\t0\t0\t600\t100\t200\t40\t-1\t',
  '3\t1\t2\t1\t0\t0\t600\t100\t200\t40\t-1\t',
  '4\t1\t2\t1\t1\t0\t600\t100\t200\t40\t-1\t',
  '5\t1\t2\t1\t1\t1\t600\t100\t200\t40\t60\tright',
  '',
].join('\n');

describe('parseTesseractTsv', () => {
  it('rebuilds text, word boxes and mean confidence from TSV rows', () => {
    const result = parseTesseractTsv(HANDWRITTEN_TSV);
    expect(result.imageWidth).toBe(1000);
    expect(result.imageHeight).toBe(800);
    expect(result.text).toBe('Hello world\nsecond\n\nright');
    expect(result.wordCount).toBe(4);
    // (90.5 + 80.5 + 70 + 60) / 4 / 100
    expect(result.confidence).toBeCloseTo(0.7525, 10);
    const first = (result.lineBlocks ?? []).find((b) => b.text === 'Hello world');
    expect(first?.bbox).toMatchObject({ x: 100, y: 100, width: 300, height: 40 });
    expect(first?.words.map((w) => [w.text, w.bbox.x, w.bbox.width, w.confidence])).toEqual([
      ['Hello', 100, 120, 90.5],
      ['world', 240, 160, 80.5],
    ]);
    expect(result.lines.sort()).toEqual(['Hello world', 'right', 'second']);
  });

  it('returns an empty result for a page without words', () => {
    const result = parseTesseractTsv(`${TSV_HEADER}\n1\t1\t0\t0\t0\t0\t0\t0\t50\t40\t-1\t\n`);
    expect(result).toMatchObject({ text: '', wordCount: 0, confidence: null, lines: [], lineBlocks: [] });
    expect([result.imageWidth, result.imageHeight]).toEqual([50, 40]);
  });

  /** Malformed CLI output is an engine fault (503), never a client error (400). */
  function malformedFailure(tsv: string): Error {
    try {
      parseTesseractTsv(tsv);
    } catch (err) {
      return err as Error;
    }
    throw new Error('parseTesseractTsv accepted malformed output');
  }

  it('rejects output without the TSV header as an engine fault', () => {
    const failure = malformedFailure('Hello world\n');
    expect(failure.name).toBe('OcrEngineUnavailableError');
    expect(failure.message).toBe('Malformed Tesseract TSV output: the header row is missing.');
  });

  it('rejects rows with missing or non-numeric geometry', () => {
    const bad = `${TSV_HEADER}\n1\t1\t0\t0\t0\t0\t0\t0\t50\t40\t-1\t\n5\t1\t1\t1\t1\t1\tleft\t0\t5\t5\t90\tword\n`;
    expect(malformedFailure(bad).message).toBe(
      "Malformed Tesseract TSV output: row 2 has a non-integer left 'left'."
    );
    const short = `${TSV_HEADER}\n5\t1\t1\n`;
    expect(malformedFailure(short).message).toBe(
      'Malformed Tesseract TSV output: row 1 has 3 columns, expected 12.'
    );
    expect(malformedFailure(short)).toBeInstanceOf(OcrEngineUnavailableError);
  });

  it('bounds the number of rows it will parse', () => {
    const row = '5\t1\t1\t1\t1\t1\t0\t0\t5\t5\t90\tw';
    const oversized = `${TSV_HEADER}\n${Array(OCR_CLI_MAX_TSV_ROWS + 1).fill(row).join('\n')}\n`;
    const failure = malformedFailure(oversized);
    expect(failure).toBeInstanceOf(OcrEngineUnavailableError);
    expect(failure.message).toBe(`Malformed Tesseract TSV output: more than ${OCR_CLI_MAX_TSV_ROWS} rows.`);
  });

  it('accepts exactly the maximum number of rows', () => {
    const row = '5\t1\t1\t1\t1\t1\t0\t0\t5\t5\t90\tw';
    const page = '1\t1\t0\t0\t0\t0\t0\t0\t50\t40\t-1\t';
    const rows = [page, ...Array(OCR_CLI_MAX_TSV_ROWS - 1).fill(row)];
    const result = parseTesseractTsv(`${TSV_HEADER}\n${rows.join('\n')}\n`);
    expect(result.wordCount).toBe(OCR_CLI_MAX_TSV_ROWS - 1);
  });
});

describe('recognizeWithCli', () => {
  oracleTest(
    'reads a two-column page from TSV output with word boxes at the rendered positions',
    ['tesseract'],
    async () => {
      const cliPath = requireCli();
      const tessdataDir = findTessdata();
      const image = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol__clean300.png'));
      const result = await recognizeWithCli({ cliPath, tessdataDir, tesseractLang: 'eng', image });

      expect(characterErrorRatePercent(GROUND_TRUTH, result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
      expect([result.imageWidth, result.imageHeight]).toEqual([GOLDEN_PAGE_WIDTH_PX, GOLDEN_PAGE_HEIGHT_PX]);
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.wordCount).toBe(GROUND_TRUTH.split(/\s+/).filter(Boolean).length);

      const lineBlocks = result.lineBlocks ?? [];
      expect(lineBlocks.length).toBeGreaterThan(0);
      const firstLine = lineBlocks.find((b) => b.text.startsWith('The committee'));
      expect(firstLine).toBeDefined();
      expect(Math.abs(firstLine!.bbox.x - GOLDEN_LEFT_MARGIN_PX)).toBeLessThanOrEqual(GOLDEN_BBOX_TOLERANCE_PX);
      for (const block of lineBlocks) {
        expect(block.bbox.x + block.bbox.width).toBeLessThanOrEqual(GOLDEN_PAGE_WIDTH_PX);
        expect(block.bbox.y + block.bbox.height).toBeLessThanOrEqual(GOLDEN_PAGE_HEIGHT_PX);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'agrees with the reference CLI on the recognized words',
    ['tesseract'],
    async () => {
      const cliPath = requireCli();
      const tessdataDir = findTessdata();
      const file = path.join(FIXTURE_DIR, 'twocol__skew3.png');
      const reference = execFileSync(
        cliPath,
        [file, 'stdout', '-l', 'eng', '--tessdata-dir', tessdataDir, '--psm', '3', '--oem', '1'],
        { encoding: 'utf-8', timeout: TEST_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }
      );
      const result = await recognizeWithCli({
        cliPath,
        tessdataDir,
        tesseractLang: 'eng',
        image: fs.readFileSync(file),
      });
      expect(characterErrorRatePercent(reference, result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'does not stall the event loop while the CLI recognizes a page',
    ['tesseract'],
    async () => {
      const cliPath = requireCli();
      const tessdataDir = findTessdata();
      const image = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol__noise.png'));
      const histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
      histogram.enable();
      // Let the sampling timer tick once so a blocked turn is recorded.
      await new Promise((resolve) => setTimeout(resolve, HISTOGRAM_RESOLUTION_MS * 3));
      const startedAt = performance.now();
      try {
        await recognizeWithCli({ cliPath, tessdataDir, tesseractLang: 'eng', image });
      } finally {
        histogram.disable();
      }
      const elapsedMs = performance.now() - startedAt;
      // The call must really have taken long enough for a blocking implementation to show.
      expect(elapsedMs).toBeGreaterThan(MAX_EVENT_LOOP_STALL_MS);
      expect(histogram.max / NS_PER_MS - HISTOGRAM_RESOLUTION_MS).toBeLessThan(MAX_EVENT_LOOP_STALL_MS);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'finishes many concurrent runs instead of oversubscribing the CPUs with OpenMP threads',
    ['tesseract'],
    async () => {
      const cliPath = requireCli();
      const tessdataDir = findTessdata();
      const image = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol__dpi150.png'));
      const runs = os.availableParallelism() * CONCURRENT_RUNS_PER_CPU;
      const results = await Promise.all(
        Array.from({ length: runs }, () => recognizeWithCli({ cliPath, tessdataDir, tesseractLang: 'eng', image }))
      );
      expect(results).toHaveLength(runs);
      for (const result of results) {
        expect(characterErrorRatePercent(GROUND_TRUTH, result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
      }
    },
    TEST_TIMEOUT_MS
  );

  describe('process control (stand-in executables)', () => {
    function writeScript(body: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cli-test-'));
      const file = path.join(dir, 'fake-tesseract.sh');
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    }

    /** A killed process whose parent is gone may linger as a zombie until init reaps it. */
    function isRunning(pid: number): boolean {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch {
        return false;
      }
    }

    const image = Buffer.from('not-an-image');
    const common = { tessdataDir: '/tessdata', tesseractLang: 'eng', image };

    // Zombie detection reads /proc, which only Linux provides.
    it.skipIf(!fs.existsSync(PROC_STAT_PROBE))('kills the whole process group when the timeout expires', async () => {
      const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cli-pid-')), 'child.pid');
      const cliPath = writeScript(`sleep 300 &\necho $! > "${pidFile}"\nwait`);
      const started = performance.now();
      await expect(
        recognizeWithCli({ ...common, cliPath, timeoutMs: SHORT_CLI_TIMEOUT_MS })
      ).rejects.toThrow(OcrEngineUnavailableError);
      expect(performance.now() - started).toBeLessThan(SHORT_CLI_TIMEOUT_MS * 10);
      const grandchild = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      expect(Number.isInteger(grandchild)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, PROCESS_REAP_WAIT_MS));
      expect(isRunning(grandchild)).toBe(false);
    });

    it('reports a failing exit status without echoing CLI diagnostics to the client', async () => {
      const cliPath = writeScript(
        'echo "Error opening data file /srv/secret/tessdata/eng.traineddata" >&2\nexit 1'
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const failure = await recognizeWithCli({ ...common, cliPath }).then(
          () => null,
          (err: unknown) => err as Error
        );
        expect(failure).toBeInstanceOf(OcrEngineUnavailableError);
        expect(failure?.message).toBe('Tesseract CLI failed with exit code 1.');
        expect(failure?.message).not.toContain('/srv/secret');
        // The diagnostics stay in the server log.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('Error opening data file /srv/secret/tessdata');
      } finally {
        warn.mockRestore();
      }
    });

    it('truncates and strips control characters from logged diagnostics', async () => {
      const cliPath = writeScript(`printf 'bad\\033[31m%s' "$(head -c 5000 /dev/zero | tr '\\0' 'x')" >&2\nexit 2`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(recognizeWithCli({ ...common, cliPath })).rejects.toThrow(
          'Tesseract CLI failed with exit code 2.'
        );
        const logged = String(warn.mock.calls[0][0]);
        expect(logged).not.toContain('\u001b');
        expect(logged.length).toBeLessThan(OCR_CLI_LOGGED_STDERR_CHARS + LOG_PREFIX_ALLOWANCE);
        expect(logged).toContain('bad[31mxxx');
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects output beyond the size limit with a fixed message', async () => {
      const cliPath = writeScript('yes "5 1 1 1 1 1 0 0 1 1 90 w"');
      await expect(recognizeWithCli({ ...common, cliPath, maxOutputBytes: 4096 })).rejects.toThrow(
        new OcrEngineUnavailableError('Tesseract CLI produced more output than the allowed limit.')
      );
    });

    it('kills a run that exceeds its memory limit', async () => {
      const cliPath = writeScript(
        `x=$(head -c ${MEMORY_HOG_BYTES} /dev/zero | tr '\\0' 'a')\nsleep 30`
      );
      await expect(recognizeWithCli({ ...common, cliPath, memoryLimitMb: SMALL_MEMORY_LIMIT_MB })).rejects.toThrow(
        new OcrEngineUnavailableError(`Tesseract CLI exceeded its ${SMALL_MEMORY_LIMIT_MB} MB memory limit.`)
      );
    });

    it('rejects output that is not TSV as an engine fault', async () => {
      const cliPath = writeScript('echo "plain text, not tsv"');
      const failure = await recognizeWithCli({ ...common, cliPath }).then(
        () => null,
        (err: unknown) => err as Error
      );
      expect(failure).toBeInstanceOf(OcrEngineUnavailableError);
      expect(failure?.message).toBe('Malformed Tesseract TSV output: the header row is missing.');
    });

    it('never runs more processes at once than the concurrency limit', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cli-conc-'));
      // The stand-in prints one word, so the empty-result single-block retry does not run twice.
      const cliPath = writeScript(
        `touch "${dir}/$$"\nls "${dir}" | wc -l >> "${dir}.log"\nsleep 0.3\nrm "${dir}/$$"\n` +
          `printf '${TSV_HEADER.replace(/\t/g, '\\t')}\\n1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t5\\t5\\t-1\\t\\n5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t5\\t5\\t90\\tw\\n'`
      );
      const runs = OCR_CLI_MAX_CONCURRENCY * 3;
      const results = await Promise.all(Array.from({ length: runs }, () => recognizeWithCli({ ...common, cliPath })));
      expect(results).toHaveLength(runs);
      const observed = fs
        .readFileSync(`${dir}.log`, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((n) => Number.parseInt(n.trim(), 10));
      expect(observed).toHaveLength(runs);
      expect(Math.max(...observed)).toBe(OCR_CLI_MAX_CONCURRENCY);
    });
  });
});

describe('CliSemaphore', () => {
  it('runs at most `limit` tasks at once and releases waiting tasks in order', async () => {
    const semaphore = new CliSemaphore(2, 10);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const task = (id: number) =>
      semaphore.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      });
    await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects with the engine-unavailable error when too many tasks are queued', async () => {
    const semaphore = new CliSemaphore(1, 1);
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const first = semaphore.run(() => gate);
    const second = semaphore.run(() => gate);
    await expect(semaphore.run(() => gate)).rejects.toThrow(
      new OcrEngineUnavailableError('OCR is saturated: 1 native runs are already waiting.')
    );
    await Promise.all([first, second]);
  });

  it('frees its slot when a task fails', async () => {
    const semaphore = new CliSemaphore(1, 1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'next')).resolves.toBe('next');
  });
});
