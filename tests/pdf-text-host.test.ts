import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How the worker thread that reads a PDF's text layer fails. Hostile input (a deadline overrun, running out
 * of memory, a document the reader rejects) is the caller's fault and a typed 400; an environment that
 * cannot start the thread, or a thread that dies on its own, is the service's and a typed 503.
 */

const fake = vi.hoisted(() => {
  class FakeWorker {
    readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    terminated = false;
    readonly posted: unknown[] = [];
    constructor(...args: unknown[]) {
      state.calls.push(args);
      state.events.push('worker');
      if (state.construct) state.construct();
      state.instances.push(this);
    }
    once(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      // `once`: a handler runs for the first event only.
      const handlers = this.handlers.get(event) ?? [];
      this.handlers.delete(event);
      for (const handler of handlers) handler(...args);
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    ref(): void {}
    unref(): void {}
    terminate(): Promise<number> {
      this.terminated = true;
      // A stopped thread ends with an `exit` event, a moment later.
      queueMicrotask(() => this.emit('exit', 1));
      return Promise.resolve(0);
    }
  }
  /** What the threads the host started were given, and whether starting one should fail. */
  const state = {
    instances: [] as FakeWorker[],
    construct: null as (() => void) | null,
    calls: [] as unknown[][],
    /** What the host did, in order: the V8 flags it set and the threads it started. */
    events: [] as string[],
  };
  return { FakeWorker, state };
});

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: fake.FakeWorker };
});

vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return { ...actual, setFlagsFromString: (flags: string) => void fake.state.events.push(`flag ${flags}`) };
});

import { convertFile } from '../src/lib/conversions/index';
import { runPdfTextJobInThread, shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { inspectPdfPagesTextDensity } from '../src/lib/conversions/ocr';
import { extractPdfTextLayerPages, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-geometry';
import { EngineUnavailableError } from '../src/lib/types';
import { rawPdf, run } from './helpers/raw-pdf';

const DEADLINE_ENV = 'EASYCONVERT_PDF_TEXT_DEADLINE_MS';
const SHORT_DEADLINE_MS = 50;
const OUT_OF_MEMORY = 'ERR_WORKER_OUT_OF_MEMORY';
const CRASH_EXIT_CODE = 1;
const THREAD_STARTED_POLL_MS = 5;
const THREAD_STARTED_TIMEOUT_MS = 2_000;

const pdf = (): Buffer => rawPdf([{ width: 200, height: 100, content: run('Hello world', 10, 50, 12) }]);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err
  );
}

/** The thread the host started, once it has. */
async function startedThread(): Promise<InstanceType<typeof fake.FakeWorker>> {
  await vi.waitFor(
    () => {
      if (fake.state.instances.length === 0) throw new Error('the thread has not started');
    },
    { timeout: THREAD_STARTED_TIMEOUT_MS, interval: THREAD_STARTED_POLL_MS }
  );
  return fake.state.instances[0];
}

beforeEach(() => {
  fake.state.instances = [];
  fake.state.calls = [];
  fake.state.events = [];
  fake.state.construct = null;
});

afterEach(() => {
  delete process.env[DEADLINE_ENV];
  vi.restoreAllMocks();
  // Threads are kept between jobs; every test starts without any.
  shutdownPdfTextThreads();
});

describe('worker thread failures', () => {
  it('maps a thread that cannot be started to an unavailable engine', async () => {
    fake.state.construct = () => {
      throw new Error('resource exhausted');
    };
    const err = await failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('pdf-text-thread');
    expect((err as Error).message).toContain('resource exhausted');
  });

  it('maps an error the thread raises on its own to an unavailable engine', async () => {
    const pending = failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    (await startedThread()).emit('error', Object.assign(new Error('segmentation fault'), { code: 'ERR_WORKER_UNSERIALIZABLE_ERROR' }));
    const err = await pending;
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toBe("Engine 'pdf-text-thread' is unavailable: the thread failed: segmentation fault");
  });

  it('maps a thread that exits without a reply to an unavailable engine', async () => {
    const pending = failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    (await startedThread()).emit('exit', CRASH_EXIT_CODE);
    const err = await pending;
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as Error).message).toContain(`code ${CRASH_EXIT_CODE}`);
  });

  it('keeps running out of memory on a document a typed 400', async () => {
    const pending = failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    (await startedThread()).emit('error', Object.assign(new Error('out of memory'), { code: OUT_OF_MEMORY }));
    const err = await pending;
    expect(err).toBeInstanceOf(PdfTextGeometryError);
    expect((err as PdfTextGeometryError).status).toBe(400);
    expect((err as Error).message).toBe('PDF text extraction exceeded its memory limit.');
  });

  it('keeps the deadline a typed 400 and stops the thread', async () => {
    process.env[DEADLINE_ENV] = String(SHORT_DEADLINE_MS);
    const err = await failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    expect(err).toBeInstanceOf(PdfTextGeometryError);
    expect((err as Error).message).toBe(`PDF text extraction exceeded its ${SHORT_DEADLINE_MS} ms limit.`);
    expect((await startedThread()).terminated).toBe(true);
  });

  it('keeps a document the reader rejects a typed 400', async () => {
    const pending = failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    (await startedThread()).emit('message', { ok: false, message: 'PDF page 1 has more than 100000 text items.' });
    const err = await pending;
    expect(err).toBeInstanceOf(PdfTextGeometryError);
    expect((err as Error).message).toBe('PDF page 1 has more than 100000 text items.');
  });
});

describe('without a worker entry', () => {
  it('reports an unavailable engine instead of reading the document without a deadline', async () => {
    const real = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => (String(candidate).includes('pdf-text-worker') ? false : real(candidate)));
    const err = await failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('pdf-text-thread');
    expect((err as Error).message).toContain('npm run build:pdf-text-worker');
    expect(fake.state.instances).toHaveLength(0);
  });
});

describe('the entry of the thread', () => {
  const startedWith = async (existing: (candidate: string) => boolean): Promise<[unknown, { execArgv?: string[] }]> => {
    const real = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => (String(candidate).includes('pdf-text-worker') ? existing(String(candidate)) : real(candidate)));
    void failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    await startedThread();
    const [entry, options] = fake.state.calls[0] as [unknown, { execArgv?: string[] }];
    return [entry, options];
  };

  it('starts the bundle without the execArgv of its parent, so a loader of the parent does not load the bundle', async () => {
    const [entry, options] = await startedWith((candidate) => candidate.endsWith('pdf-text-worker.js'));
    expect(String(entry)).toMatch(/pdf-text-worker\.js$/);
    expect(options.execArgv).toEqual([]);
  });

  it('starts the source through the loader it registers itself, with the execArgv of its parent', async () => {
    const [entry, options] = await startedWith((candidate) => candidate.endsWith('pdf-text-worker.ts'));
    expect(String(entry)).toContain('.register()');
    expect(options).not.toHaveProperty('execArgv');
  });
});

describe('the heap of a new thread', () => {
  const SET = 'flag --initial-old-space-size=128';
  const RESTORED = 'flag --initial-old-space-size=0';

  it('starts with an old-generation threshold of 128 MB, set before the thread is made, and keeps the heap limit', async () => {
    void failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    await startedThread();
    expect(fake.state.events).toEqual([SET, 'worker']);
    const options = fake.state.calls[0][1] as { resourceLimits: { maxOldGenerationSizeMb: number } };
    expect(options.resourceLimits.maxOldGenerationSizeMb).toBe(1024);
  });

  it('gives the default threshold back once the thread is online, so threads of other modules do not inherit it', async () => {
    void failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    const thread = await startedThread();
    thread.emit('online');
    expect(fake.state.events).toEqual([SET, 'worker', RESTORED]);
    thread.emit('exit', 0);
    expect(fake.state.events).toEqual([SET, 'worker', RESTORED]);
  });

  it('gives it back when the thread fails before it is online, and when it cannot be made', async () => {
    void failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    (await startedThread()).emit('error', Object.assign(new Error('segmentation fault'), { code: 'ERR_WORKER_UNSERIALIZABLE_ERROR' }));
    expect(fake.state.events).toEqual([SET, 'worker', RESTORED]);
    fake.state.events = [];
    fake.state.construct = () => {
      throw new Error('resource exhausted');
    };
    await failure(extractPdfTextLayerPages(pdf(), new Set([1])));
    // The stand-in records the start before it fails, as a real constructor that throws has begun to make the thread.
    expect(fake.state.events).toEqual([SET, 'worker', RESTORED]);
  });

  it('keeps the threshold while any thread is still starting, and gives it back once for the last one', async () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
    const first = runPdfTextJobInThread(pdf(), { geometry: 'none', content: true });
    const second = runPdfTextJobInThread(pdf(), { geometry: 'none', content: true });
    void failure(first);
    void failure(second);
    const [one, two] = fake.state.instances;
    expect(fake.state.events).toEqual([SET, 'worker', 'worker']);
    one.emit('online');
    expect(fake.state.events).toEqual([SET, 'worker', 'worker']);
    two.emit('online');
    expect(fake.state.events).toEqual([SET, 'worker', 'worker', RESTORED]);
  });
});

describe('density analysis', () => {
  it('reads the text density on the worker thread, under the same deadline', async () => {
    const pending = inspectPdfPagesTextDensity(pdf(), 15);
    const thread = await startedThread();
    expect((thread.posted[0] as { job: unknown }).job).toEqual({ densityThreshold: 15, geometry: 'none' });
    const analysis = { pageNumber: 1, width: 200, height: 100, charCount: 10, wordCount: 2, hasTextLayer: false, text: 'Hello world' };
    thread.emit('message', { ok: true, result: { analyses: [analysis], geometry: new Map(), content: [], fonts: [] } });
    await expect(pending).resolves.toEqual([analysis]);
  });

  it('does not hide an unavailable engine behind the best-effort reading of a PDF source', async () => {
    fake.state.construct = () => {
      throw new Error('resource exhausted');
    };
    const err = await failure(convertFile(pdf(), 'pdf', 'txt', {}, 'doc.pdf'));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('pdf-text-thread');
    expect((err as Error).message).toBe("Engine 'pdf-text-thread' is unavailable: the thread could not be started: resource exhausted");
  });

  it('refuses a PDF whose text layer the reader rejects with a typed 400, not a guess', async () => {
    const pending = failure(convertFile(pdf(), 'pdf', 'txt', {}, 'doc.pdf'));
    (await startedThread()).emit('message', { ok: false, message: 'PDF text geometry could not be read: damaged' });
    const err = await pending;
    expect(err).toBeInstanceOf(PdfTextGeometryError);
    expect((err as PdfTextGeometryError).status).toBe(400);
    expect((err as Error).message).toBe('PDF text geometry could not be read: damaged');
  });
});

/**
 * A thread that nears its retirement starts its replacement ahead, so the job after the retirement does not wait for a
 * thread to start (about 200 ms against 5 ms for a document): the old thread is retired when the replacement has said it
 * is ready, and the replacement takes no job before that.
 */
describe('replacing a thread that has read many documents', () => {
  type Thread = InstanceType<typeof fake.FakeWorker>;
  const REPLACEMENT_STARTS_AFTER_JOBS = 80;
  const RETIRED_AFTER_JOBS = 100;
  const RETIRED_AT_LATEST_AFTER_JOBS = 200;
  const reply = { ok: true, result: { analyses: [], geometry: new Map(), content: [], fonts: [] } };
  const textJob = { geometry: 'none', content: true } as const;

  /** Reads `count` documents on `thread`, answering each one. */
  async function readDocuments(thread: Thread, count: number): Promise<void> {
    for (let read = 0; read < count; read++) {
      const pending = runPdfTextJobInThread(pdf(), textJob);
      thread.emit('message', reply);
      await pending;
    }
  }

  const warmUpOf = (thread: Thread): unknown => (fake.state.calls[fake.state.instances.indexOf(thread)][1] as { workerData: { warmUp: boolean } }).workerData.warmUp;

  /** The first thread, with the documents it must read before the replacement starts already read. */
  async function oldThreadNearingRetirement(): Promise<Thread> {
    const first = runPdfTextJobInThread(pdf(), textJob);
    const old = await startedThread();
    old.emit('message', reply);
    await first;
    await readDocuments(old, REPLACEMENT_STARTS_AFTER_JOBS - 2);
    expect(fake.state.instances).toHaveLength(1);
    return old;
  }

  it('starts the replacement as a warm-up thread once the old thread has read most of its documents', async () => {
    const old = await oldThreadNearingRetirement();
    await readDocuments(old, 1);
    expect(fake.state.instances).toHaveLength(2);
    expect(warmUpOf(old)).toBe(false);
    expect(warmUpOf(fake.state.instances[1])).toBe(true);
    expect(old.terminated).toBe(false);
  });

  it('gives a replacement that is still warming no document, and keeps the old thread until it is ready', async () => {
    const old = await oldThreadNearingRetirement();
    await readDocuments(old, RETIRED_AFTER_JOBS - REPLACEMENT_STARTS_AFTER_JOBS + 2);
    const replacement = fake.state.instances[1];
    expect(old.terminated).toBe(false);
    expect(replacement.posted).toHaveLength(0);
    await readDocuments(old, 1);
    expect(old.posted).toHaveLength(RETIRED_AFTER_JOBS + 2);
    expect(replacement.posted).toHaveLength(0);
  });

  it('retires the old thread when the replacement is ready, and gives the next document to the replacement', async () => {
    const old = await oldThreadNearingRetirement();
    await readDocuments(old, RETIRED_AFTER_JOBS - REPLACEMENT_STARTS_AFTER_JOBS + 2);
    const replacement = fake.state.instances[1];
    replacement.emit('message', { ready: true });
    await readDocuments(old, 1);
    expect(old.terminated).toBe(true);
    const pending = runPdfTextJobInThread(pdf(), textJob);
    expect(replacement.posted).toHaveLength(1);
    replacement.emit('message', reply);
    await pending;
    expect(fake.state.instances).toHaveLength(2);
  });

  it('retires the old thread at its limit when the replacement never gets ready', async () => {
    const old = await oldThreadNearingRetirement();
    await readDocuments(old, RETIRED_AT_LATEST_AFTER_JOBS - REPLACEMENT_STARTS_AFTER_JOBS + 1);
    expect(old.terminated).toBe(true);
    expect(old.posted).toHaveLength(RETIRED_AT_LATEST_AFTER_JOBS);
  });

  it('retires the old thread after its limit when no replacement could be started', async () => {
    const old = await oldThreadNearingRetirement();
    fake.state.construct = () => {
      throw new Error('resource exhausted');
    };
    await readDocuments(old, RETIRED_AFTER_JOBS - REPLACEMENT_STARTS_AFTER_JOBS + 1);
    expect(old.terminated).toBe(true);
    expect(old.posted).toHaveLength(RETIRED_AFTER_JOBS);
    expect(fake.state.instances).toHaveLength(1);
  });

  it('does not count a warming replacement against the pool, and stops it with the pool', async () => {
    const old = await oldThreadNearingRetirement();
    await readDocuments(old, 1);
    const replacement = fake.state.instances[1];
    shutdownPdfTextThreads();
    expect(replacement.terminated).toBe(true);
    expect(old.terminated).toBe(true);
  });
});
