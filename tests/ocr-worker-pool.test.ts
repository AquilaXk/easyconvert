import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { performOcr, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import {
  OcrWorkerPool,
  getSharedOcrWorkerPool,
  type OcrPooledWorker,
  type OcrWorkerHealth,
  type OcrWorkerSpec,
  type OcrWorkerPoolOptions,
} from '../src/lib/conversions/ocr-worker-pool';
import { OcrEngineUnavailableError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const GROUND_TRUTH = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol.gt.txt'), 'utf-8');
const MAX_CER_PERCENT = 1;
const PAGE_TIMEOUT_MS = 120_000;
const SHORT_WAIT_MS = 20;
const SETTLE_MS = 150;

const baseSpec: OcrWorkerSpec = {
  langs: 'eng',
  langPath: '/tessdata',
  gzip: false,
  engineMode: 1,
  parameters: { tessedit_pageseg_mode: '3' },
};

interface FakeWorker extends OcrPooledWorker {
  id: number;
  terminated: boolean;
  calls: string[];
  health: OcrWorkerHealth;
}

/** Pool whose workers are in-memory fakes, so cap/eviction/recovery are deterministic. */
class FakePool extends OcrWorkerPool {
  readonly created: FakeWorker[] = [];
  concurrent = 0;
  maxConcurrent = 0;

  override async createWorker(spec: OcrWorkerSpec, health: OcrWorkerHealth): Promise<OcrPooledWorker> {
    const worker: FakeWorker = {
      id: this.created.length,
      terminated: false,
      calls: [],
      health,
      setParameters: async (params) => {
        worker.calls.push(`params:${JSON.stringify(params)}`);
      },
      recognize: async (_image, _options, _output) => {
        worker.calls.push('recognize');
        this.concurrent++;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
        await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
        this.concurrent--;
        return { data: { text: `worker-${worker.id}` } } as never;
      },
      terminate: async () => {
        worker.terminated = true;
      },
    };
    void spec;
    this.created.push(worker);
    return worker;
  }
}

function recognizeOnce(pool: OcrWorkerPool, spec: OcrWorkerSpec = baseSpec) {
  return pool.run(spec, (recognize) => recognize(Buffer.alloc(0), {}, { text: true }));
}

const pools: OcrWorkerPool[] = [];
function makePool(options: OcrWorkerPoolOptions = {}): FakePool {
  const pool = new FakePool(options);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe('OcrWorkerPool', () => {
  it('reuses one worker for sequential jobs', async () => {
    const pool = makePool();
    await recognizeOnce(pool);
    await recognizeOnce(pool);
    expect(pool.created).toHaveLength(1);
    expect(pool.created[0].calls.filter((c) => c === 'recognize')).toHaveLength(2);
  });

  it('caps concurrent workers per language set and queues the rest', async () => {
    const pool = makePool({ maxWorkersPerKey: 2 });
    const results = await Promise.all(Array.from({ length: 5 }, () => recognizeOnce(pool)));
    expect(results).toHaveLength(5);
    expect(pool.created.length).toBeLessThanOrEqual(2);
    expect(pool.maxConcurrent).toBe(2);
  });

  it('gives each language set its own workers', async () => {
    const pool = makePool();
    await recognizeOnce(pool);
    await recognizeOnce(pool, { ...baseSpec, langs: 'deu' });
    await recognizeOnce(pool);
    expect(pool.created).toHaveLength(2);
  });

  it('evicts an idle worker of another language set when the total cap is reached', async () => {
    const pool = makePool({ maxWorkersTotal: 1 });
    await recognizeOnce(pool);
    await recognizeOnce(pool, { ...baseSpec, langs: 'deu' });
    expect(pool.created).toHaveLength(2);
    expect(pool.created[0].terminated).toBe(true);
    expect(pool.created[1].terminated).toBe(false);
    expect(pool.size).toBe(1);
  });

  it('terminates workers that stay idle past the idle timeout', async () => {
    const pool = makePool({ idleTtlMs: SHORT_WAIT_MS });
    await recognizeOnce(pool);
    expect(pool.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(pool.created[0].terminated).toBe(true);
    expect(pool.size).toBe(0);
    await recognizeOnce(pool);
    expect(pool.created).toHaveLength(2);
  });

  it('discards a worker whose job failed and recreates it for the next job', async () => {
    const pool = makePool();
    const failure = new Error('recognizer crashed');
    await expect(pool.run(baseSpec, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(pool.created[0].terminated).toBe(true);
    expect(pool.size).toBe(0);
    const text = await recognizeOnce(pool);
    expect(text.data.text).toBe('worker-1');
    expect(pool.created).toHaveLength(2);
  });

  it('does not reuse a worker that reported a fatal error while idle', async () => {
    const pool = makePool();
    await recognizeOnce(pool);
    pool.created[0].health.failed = true;
    const second = await recognizeOnce(pool);
    expect(second.data.text).toBe('worker-1');
    expect(pool.created[0].terminated).toBe(true);
  });

  it('recycles a worker after its job budget', async () => {
    const pool = makePool({ maxJobsPerWorker: 2 });
    await recognizeOnce(pool);
    await recognizeOnce(pool);
    await recognizeOnce(pool);
    expect(pool.created).toHaveLength(2);
    expect(pool.created[0].terminated).toBe(true);
  });

  it('applies the job parameters before every recognition so nothing leaks between requests', async () => {
    const pool = makePool();
    await recognizeOnce(pool, { ...baseSpec, parameters: { tessedit_pageseg_mode: '3' } });
    await recognizeOnce(pool, { ...baseSpec, parameters: { tessedit_pageseg_mode: '5' } });
    expect(pool.created).toHaveLength(1);
    expect(pool.created[0].calls).toEqual([
      'params:{"tessedit_pageseg_mode":"3"}',
      'recognize',
      'params:{"tessedit_pageseg_mode":"5"}',
      'recognize',
    ]);
  });

  it('rejects with a typed error once the wait queue is full', async () => {
    const pool = makePool({ maxWorkersPerKey: 1, maxWaiters: 1 });
    const running = [recognizeOnce(pool), recognizeOnce(pool)];
    await expect(recognizeOnce(pool)).rejects.toThrow(/OCR is saturated: 1 jobs are already waiting/);
    const finished = await Promise.all(running);
    expect(finished.map((r) => r.data.text)).toEqual(['worker-0', 'worker-0']);
    expect(pool.created).toHaveLength(1);
  });

  it('fails a job that exceeds its time limit and terminates the stuck worker', async () => {
    const pool = makePool({ jobTimeoutMs: SHORT_WAIT_MS });
    const stuck = pool.run(baseSpec, () => new Promise<never>(() => undefined));
    await expect(stuck).rejects.toBeInstanceOf(OcrEngineUnavailableError);
    expect(pool.created[0].terminated).toBe(true);
    expect(pool.size).toBe(0);
  });

  it('terminates idle and busy workers on shutdown and rejects queued jobs', async () => {
    const pool = makePool({ maxWorkersPerKey: 1 });
    await recognizeOnce(pool, { ...baseSpec, langs: 'deu' });
    const busy = pool.run(baseSpec, () => new Promise<never>(() => undefined));
    const queued = pool.run(baseSpec, async (recognize) => recognize(Buffer.alloc(0), {}, { text: true }));
    await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
    await pool.shutdown();
    await expect(busy).rejects.toBeInstanceOf(OcrEngineUnavailableError);
    await expect(queued).rejects.toBeInstanceOf(OcrEngineUnavailableError);
    expect(pool.created.every((w) => w.terminated)).toBe(true);
    expect(pool.size).toBe(0);
    // The pool recovers lazily after a shutdown.
    await recognizeOnce(pool);
    expect(pool.created[pool.created.length - 1].terminated).toBe(false);
  });
});

const hasEnglishData = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
].some((dir) => fs.existsSync(path.join(dir, 'eng.traineddata')) || fs.existsSync(path.join(dir, 'eng.traineddata.gz')));

describe('performOcr worker reuse', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownOcrWorkerPool();
  });

  oracleTest(
    'creates one worker for consecutive pages and keeps CER within bounds',
    ['tesseract'],
    async () => {
      if (!hasEnglishData) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed');
      await shutdownOcrWorkerPool();
      const pool = getSharedOcrWorkerPool();
      const createSpy = vi.spyOn(pool, 'createWorker');
      for (const variant of ['clean300', 'skew3', 'dpi150']) {
        const page = fs.readFileSync(path.join(FIXTURE_DIR, `twocol__${variant}.png`));
        const result = await performOcr(page, 'eng');
        expect(characterErrorRatePercent(GROUND_TRUTH, result.text), variant).toBeLessThanOrEqual(MAX_CER_PERCENT);
      }
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(pool.size).toBe(1);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'serves concurrent pages from a bounded set of workers',
    ['tesseract'],
    async () => {
      if (!hasEnglishData) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed');
      await shutdownOcrWorkerPool();
      const pool = getSharedOcrWorkerPool();
      const createSpy = vi.spyOn(pool, 'createWorker');
      const page = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol__dpi150.png'));
      const results = await Promise.all(Array.from({ length: 6 }, () => performOcr(page, 'eng')));
      for (const result of results) {
        expect(characterErrorRatePercent(GROUND_TRUTH, result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
      }
      expect(createSpy.mock.calls.length).toBeLessThanOrEqual(pool.limits.maxWorkersPerKey);
    },
    PAGE_TIMEOUT_MS
  );
});
