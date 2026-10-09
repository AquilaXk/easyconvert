import { afterEach, describe, expect, it } from 'vitest';
import {
  OcrWorkerPool,
  type OcrPooledWorker,
  type OcrWorkerHealth,
  type OcrWorkerPoolOptions,
  type OcrWorkerSpec,
} from '../src/lib/conversions/ocr-worker-pool';
import { OcrEngineUnavailableError } from '../src/lib/types';

/** Idle-worker accounting and background warm-up of the pool, on in-memory workers. */

const spec: OcrWorkerSpec = { langs: 'eng', langPath: '/tessdata', gzip: false, engineMode: 1, parameters: { tessedit_pageseg_mode: '3' } };
const otherSpec: OcrWorkerSpec = { ...spec, langs: 'deu' };
const JOB_MS = 40;
const START_MS = 10;

class FakePool extends OcrWorkerPool {
  created = 0;
  failStarts = false;

  override async createWorker(_spec: OcrWorkerSpec, _health: OcrWorkerHealth): Promise<OcrPooledWorker> {
    await new Promise((resolve) => setTimeout(resolve, START_MS));
    if (this.failStarts) throw new OcrEngineUnavailableError('start failed');
    this.created++;
    return {
      setParameters: async () => undefined,
      recognize: async () => {
        await new Promise((resolve) => setTimeout(resolve, JOB_MS));
        return { data: { text: 'x' } } as never;
      },
      terminate: async () => undefined,
    };
  }
}

const pools: OcrWorkerPool[] = [];
function makePool(options: OcrWorkerPoolOptions = {}): FakePool {
  const pool = new FakePool(options);
  pools.push(pool);
  return pool;
}
const job = (pool: OcrWorkerPool, forSpec: OcrWorkerSpec = spec) => pool.run(forSpec, (recognize) => recognize(Buffer.alloc(0), {}, { text: true }));
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe('idleWorkers', () => {
  it('counts the idle workers of the language set and not the busy ones', async () => {
    const pool = makePool();
    expect(pool.idleWorkers(spec)).toBe(0);
    await Promise.all([job(pool), job(pool)]);
    expect(pool.idleWorkers(spec)).toBe(2);
    const running = job(pool);
    await settle(START_MS);
    expect(pool.idleWorkers(spec)).toBe(1);
    await running;
    expect(pool.idleWorkers(otherSpec)).toBe(0);
  });

  it('reports none while a job waits for a worker, so a page never takes workers other requests need', async () => {
    const pool = makePool({ maxWorkersPerKey: 1 });
    await job(pool);
    expect(pool.idleWorkers(spec)).toBe(1);
    const first = job(pool);
    const waiting = job(pool);
    await settle(START_MS);
    expect(pool.idleWorkers(spec)).toBe(0);
    await Promise.all([first, waiting]);
  });

  it('reports none while the pool is shutting down', async () => {
    const pool = makePool();
    await job(pool);
    const closing = pool.shutdown();
    expect(pool.idleWorkers(spec)).toBe(0);
    await closing;
  });
});

describe('warm', () => {
  it('starts workers in the background up to the count asked for and leaves them idle', async () => {
    const pool = makePool({ maxWorkersPerKey: 4, maxWorkersTotal: 4 });
    pool.warm(spec, 3);
    expect(pool.size).toBe(3);
    await settle();
    expect(pool.created).toBe(3);
    expect(pool.idleWorkers(spec)).toBe(3);
  });

  it('counts the workers that already exist and keeps to the limits of the set and of the pool', async () => {
    const pool = makePool({ maxWorkersPerKey: 3, maxWorkersTotal: 4 });
    await job(pool);
    pool.warm(spec, 8);
    await settle();
    expect(pool.created).toBe(3);
    pool.warm(otherSpec, 8);
    await settle();
    expect(pool.created).toBe(4);
    expect(pool.size).toBe(4);
  });

  it('starts nothing while jobs are queued', async () => {
    const pool = makePool({ maxWorkersPerKey: 1, maxWorkersTotal: 4 });
    const first = job(pool);
    const waiting = job(pool);
    await settle(START_MS * 2);
    pool.warm(otherSpec, 2);
    await Promise.all([first, waiting]);
    expect(pool.created).toBe(1);
  });

  it('drops a failed start without an unhandled rejection, and the next job starts its own worker', async () => {
    const pool = makePool();
    pool.failStarts = true;
    pool.warm(spec, 2);
    await settle();
    expect(pool.size).toBe(0);
    pool.failStarts = false;
    await expect(job(pool)).resolves.toMatchObject({ data: { text: 'x' } });
    expect(pool.created).toBe(1);
  });
});
