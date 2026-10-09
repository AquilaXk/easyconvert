import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  CPU_POOL_MAX,
  CPU_POOL_QUEUE_MAX,
  CpuPool,
  type CpuPoolOptions,
} from '../src/lib/workers/cpu-pool';
import { CorruptStreamError, CpuPoolOverloadedError, CpuTaskAbortedError, CpuTaskTimeoutError, EngineUnavailableError } from '../src/lib/types';

/**
 * The CPU pool's own behaviour (bounded queue, 503 on overflow, abort and timeout freeing the thread, typed errors
 * across the thread boundary, transferable buffers), exercised against a small plain-JavaScript worker so that no
 * encoder is involved and the timings are the pool's.
 */
const TEST_WORKER = path.resolve(__dirname, 'helpers', 'cpu-pool-test-worker.js');
const ABORT_FREES_THREAD_MS = 1000;
const TEST_TIMEOUT_MS = 30_000;

const pools: CpuPool[] = [];
function makePool(options: CpuPoolOptions = {}): CpuPool {
  const pool = new CpuPool({ entry: { kind: 'compiled', file: TEST_WORKER }, ...options });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe('CpuPool', () => {
  it('sizes the shared pool within its documented bounds', () => {
    expect(CPU_POOL_MAX).toBeGreaterThanOrEqual(1);
    expect(CPU_POOL_QUEUE_MAX).toBeGreaterThanOrEqual(1);
  });

  it('runs a task and returns its result', async () => {
    const pool = makePool({ size: 1 });
    const result = await pool.submit<{ value: number; threadId: number }>('echo', { value: 42 });
    expect(result.value).toBe(42);
    expect(result.threadId).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('runs tasks on separate threads at the same time', async () => {
    const pool = makePool({ size: 2 });
    await Promise.all([pool.submit('echo', { value: 1 }), pool.submit('echo', { value: 2 })]);
    const started = performance.now();
    const [a, b] = await Promise.all([
      pool.submit<{ threadId: number }>('spin', { ms: 300 }),
      pool.submit<{ threadId: number }>('spin', { ms: 300 }),
    ]);
    const elapsed = performance.now() - started;
    expect(a.threadId).not.toBe(b.threadId);
    // Two 300 ms tasks on two threads overlap; run one after the other they would need 600 ms.
    expect(elapsed).toBeLessThan(550);
  }, TEST_TIMEOUT_MS);

  it('hands transferred buffers to the thread and takes a transferred result back', async () => {
    const pool = makePool({ size: 1 });
    const bytes = new Uint8Array(1000).fill(3).buffer;
    const result = await pool.submit<Uint8Array>('sum', { bytes }, { transfer: [bytes] });
    expect(bytes.byteLength, 'the caller\'s buffer is detached by the transfer').toBe(0);
    expect(new DataView(result.buffer, result.byteOffset).getFloat64(0)).toBe(3000);
  }, TEST_TIMEOUT_MS);

  it('answers 503 (a typed error) when the queue is full, and recovers when it drains', async () => {
    const pool = makePool({ size: 1, queueMax: 2 });
    const running = pool.submit('spin', { ms: 400 });
    const queuedA = pool.submit('echo', { value: 'a' });
    const queuedB = pool.submit('echo', { value: 'b' });
    const overflow = await pool.submit('echo', { value: 'c' }).catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(CpuPoolOverloadedError);
    expect(overflow).toBeInstanceOf(EngineUnavailableError);
    expect((overflow as CpuPoolOverloadedError).status).toBe(503);
    await Promise.all([running, queuedA, queuedB]);
    await expect(pool.submit<{ value: string }>('echo', { value: 'd' })).resolves.toMatchObject({ value: 'd' });
  }, TEST_TIMEOUT_MS);

  it('frees the thread within a second when a running task is aborted, and keeps serving', async () => {
    const pool = makePool({ size: 1 });
    await pool.submit('echo', { value: 'warm' });
    const controller = new AbortController();
    const running = pool.submit('spin', { ms: 20_000 }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const queued = pool.submit<{ value: string }>('echo', { value: 'after' });
    const abortedAt = performance.now();
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(CpuTaskAbortedError);
    await expect(queued).resolves.toMatchObject({ value: 'after' });
    expect(performance.now() - abortedAt).toBeLessThan(ABORT_FREES_THREAD_MS);
  }, TEST_TIMEOUT_MS);

  it('never starts a queued task whose signal was aborted, and rejects an already aborted signal at once', async () => {
    const pool = makePool({ size: 1 });
    const running = pool.submit('spin', { ms: 300 });
    const controller = new AbortController();
    const queued = pool.submit('echo', { value: 'never' }, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(CpuTaskAbortedError);
    await running;
    expect(pool.stats.queued).toBe(0);
    const already = AbortSignal.abort();
    await expect(pool.submit('echo', { value: 1 }, { signal: already })).rejects.toBeInstanceOf(CpuTaskAbortedError);
  }, TEST_TIMEOUT_MS);

  it('terminates a task that passes its time limit with a typed error, and the next task still runs', async () => {
    const pool = makePool({ size: 1, taskTimeoutMs: 200 });
    await expect(pool.submit('spin', { ms: 20_000 })).rejects.toBeInstanceOf(CpuTaskTimeoutError);
    await expect(pool.submit<{ value: number }>('echo', { value: 7 })).resolves.toMatchObject({ value: 7 });
    await expect(pool.submit('spin', { ms: 20_000 }, { timeoutMs: 100 })).rejects.toBeInstanceOf(CpuTaskTimeoutError);
  }, TEST_TIMEOUT_MS);

  it('rebuilds a typed error from the thread, keeping its class', async () => {
    const pool = makePool({ size: 1 });
    const error = await pool.submit('typedFailure', { name: 'CorruptStreamError', message: 'bad stream' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toBe('bad stream');
    const unknown = await pool.submit('nope', {}).catch((e: unknown) => e);
    expect((unknown as Error).message).toMatch(/unknown kind nope/);
  }, TEST_TIMEOUT_MS);

  it('fails the task of a thread that dies and starts a new thread for the next task', async () => {
    const pool = makePool({ size: 1 });
    await expect(pool.submit('exit', {})).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(pool.submit<{ value: number }>('echo', { value: 9 })).resolves.toMatchObject({ value: 9 });
  }, TEST_TIMEOUT_MS);

  it('rejects work after shutdown and settles tasks that were still waiting', async () => {
    const pool = makePool({ size: 1 });
    const running = pool.submit('spin', { ms: 5_000 }).catch((error: unknown) => error);
    const queued = pool.submit('echo', { value: 1 }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await pool.shutdown();
    const runningError = (await running) as EngineUnavailableError;
    const queuedError = (await queued) as EngineUnavailableError;
    expect(runningError).toBeInstanceOf(EngineUnavailableError);
    expect(runningError.reason).toBe('the pool is shut down');
    expect(queuedError.reason).toBe('the pool is shut down');
    const late = (await pool.submit('echo', { value: 1 }).catch((error: unknown) => error)) as EngineUnavailableError;
    expect(late.engineName).toBe('cpu-pool');
    expect(late.reason).toBe('the pool is shut down');
  }, TEST_TIMEOUT_MS);

  it('does not start more threads than its size', async () => {
    const pool = makePool({ size: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => pool.submit('echo', { value: i })));
    expect(pool.stats.threads).toBeLessThanOrEqual(2);
  }, TEST_TIMEOUT_MS);
});
