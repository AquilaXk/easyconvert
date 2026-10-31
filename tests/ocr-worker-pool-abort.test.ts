import { describe, expect, it } from 'vitest';
import { OcrWorkerPool, type OcrPooledWorker, type OcrWorkerHealth, type OcrWorkerSpec } from '../src/lib/conversions/ocr-worker-pool';

/**
 * A job given an AbortSignal leaves the pool when the signal fires: a job still queued for a worker never starts, a
 * job already running is interrupted and its worker is terminated (the engine cannot cancel one reading, so the
 * worker is replaced), and a worker that is still starting is not left to run a job nobody waits for.
 */

const SPEC: OcrWorkerSpec = { langs: 'eng', langPath: '/tessdata', gzip: false, engineMode: 1, parameters: { tessedit_pageseg_mode: '3' } };
const SETTLE_MS = 100;
const NO_SETTLE_WAIT_MS = 2_000;

interface FakeWorker extends OcrPooledWorker {
  terminated: boolean;
  recognized: number;
  /** Calls that reached the worker after it was terminated: with the real engine each posts to a null handle. */
  callsAfterTerminate: number;
}

/** Workers whose reading never finishes on its own, so only the signal can end it. */
class HangingPool extends OcrWorkerPool {
  readonly created: FakeWorker[] = [];

  override async createWorker(_spec: OcrWorkerSpec, _health: OcrWorkerHealth): Promise<OcrPooledWorker> {
    const worker: FakeWorker = {
      terminated: false,
      recognized: 0,
      callsAfterTerminate: 0,
      setParameters: async () => {
        worker.callsAfterTerminate += worker.terminated ? 1 : 0;
      },
      recognize: () => {
        worker.callsAfterTerminate += worker.terminated ? 1 : 0;
        worker.recognized++;
        return new Promise<never>(() => undefined);
      },
      terminate: async () => {
        worker.terminated = true;
      },
    };
    this.created.push(worker);
    return worker;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const reasonOf = (message: string): Error => new Error(message);

async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => error
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('still running'), NO_SETTLE_WAIT_MS)),
  ]);
}

describe('a pool job with an AbortSignal', () => {
  it('interrupts a running reading with the signal reason and terminates its worker', async () => {
    const pool = new HangingPool({ maxWorkersTotal: 1, maxWorkersPerKey: 1 });
    const controller = new AbortController();
    const running = pool.run(SPEC, (recognize) => recognize(Buffer.alloc(1) as never, {}, {} as never), controller.signal);
    await settle();
    expect(pool.created[0].recognized).toBe(1);
    const reason = reasonOf('page refused');
    controller.abort(reason);
    expect(await outcomeOf(running)).toBe(reason);
    await settle();
    expect(pool.created[0].terminated).toBe(true);
    await pool.shutdown();
  });

  it('drops a job that is queued for a worker: it never starts and its place in the queue is given up', async () => {
    const pool = new HangingPool({ maxWorkersTotal: 1, maxWorkersPerKey: 1 });
    const holder = new AbortController();
    const holding = pool.run(SPEC, (recognize) => recognize(Buffer.alloc(1) as never, {}, {} as never), holder.signal);
    await settle();
    const queuedSignal = new AbortController();
    let started = false;
    const queued = pool.run(SPEC, async () => {
      started = true;
    }, queuedSignal.signal);
    await settle();
    const reason = reasonOf('document refused');
    queuedSignal.abort(reason);
    expect(await outcomeOf(queued)).toBe(reason);
    holder.abort(reasonOf('done'));
    await outcomeOf(holding);
    await settle();
    expect(started).toBe(false);
    await pool.shutdown();
  });

  it('does not start a job whose signal fired before it asked for a worker', async () => {
    const pool = new HangingPool();
    const controller = new AbortController();
    const reason = reasonOf('already refused');
    controller.abort(reason);
    let started = false;
    expect(await outcomeOf(pool.run(SPEC, async () => { started = true; }, controller.signal))).toBe(reason);
    expect(started).toBe(false);
    expect(pool.created).toHaveLength(0);
  });

  it('runs a job without a signal as before', async () => {
    const pool = new HangingPool();
    const value = await pool.run(SPEC, async () => 'read');
    expect(value).toBe('read');
    await pool.shutdown();
  });

  it('never calls a worker it has terminated: a job that is still running after the abort reads nothing more', async () => {
    // tesseract.js sets its worker handle to null on terminate; a later call posts to null, which surfaces as an unhandled
    // rejection that fails the whole test run (TypeError: Cannot read properties of null (reading 'postMessage')).
    const pool = new HangingPool({ maxWorkersTotal: 1, maxWorkersPerKey: 1 });
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const errors: unknown[] = [];
    const afterTerminate: string[] = [];
    const job = pool.run(
      SPEC,
      async (recognize, recognizeWith, detect) => {
        await gate;
        for (const [name, call] of [
          ['recognize', () => recognize(Buffer.alloc(1) as never, {}, {} as never)],
          ['recognizeWith', () => recognizeWith({ tessedit_pageseg_mode: '6' }, Buffer.alloc(1) as never, {}, {} as never)],
          ['detect', () => detect!(Buffer.alloc(1) as never)],
        ] as const) {
          try {
            void Promise.resolve(call()).catch((error: unknown) => errors.push(error));
          } catch (error) {
            errors.push(error);
          }
          afterTerminate.push(name);
        }
      },
      controller.signal
    );
    await settle();
    const worker = pool.created[0];
    worker.detect = () => {
      worker.callsAfterTerminate += worker.terminated ? 1 : 0;
      return new Promise<never>(() => undefined);
    };
    controller.abort(reasonOf('job deadline'));
    expect(await outcomeOf(job)).toBeInstanceOf(Error);
    await settle();
    expect(worker.terminated).toBe(true);
    release();
    await settle();
    expect(afterTerminate).toEqual(['recognize', 'recognizeWith', 'detect']);
    expect(worker.callsAfterTerminate).toBe(0);
    expect(errors.every((error) => error instanceof Error && /terminated/.test(error.message))).toBe(true);
    await pool.shutdown();
  });
});
