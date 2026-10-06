import fs from 'node:fs';
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
    constructor(...args: unknown[]) {
      state.calls.push(args);
      if (state.construct) state.construct();
      state.instances.push(this);
    }
    once(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    terminate(): Promise<number> {
      this.terminated = true;
      return Promise.resolve(0);
    }
  }
  /** What the threads the host started were given, and whether starting one should fail. */
  const state = {
    instances: [] as FakeWorker[],
    construct: null as (() => void) | null,
    calls: [] as unknown[][],
  };
  return { FakeWorker, state };
});

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: fake.FakeWorker };
});

import { convertFile } from '../src/lib/conversions/index';
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
  fake.state.construct = null;
});

afterEach(() => {
  delete process.env[DEADLINE_ENV];
  vi.restoreAllMocks();
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

describe('density analysis', () => {
  it('reads the text density on the worker thread, under the same deadline', async () => {
    const pending = inspectPdfPagesTextDensity(pdf(), 15);
    const thread = await startedThread();
    const [, options] = fake.state.calls[0] as [unknown, { workerData: { job: unknown } }];
    expect(options.workerData.job).toEqual({ densityThreshold: 15, geometry: 'none' });
    const analysis = { pageNumber: 1, width: 200, height: 100, charCount: 10, wordCount: 2, hasTextLayer: false, text: 'Hello world' };
    thread.emit('message', { ok: true, result: { analyses: [analysis], geometry: new Map() } });
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

  it('still converts a PDF whose text layer the reader rejects, as a scanned document', async () => {
    const pending = convertFile(pdf(), 'pdf', 'txt', {}, 'doc.pdf');
    (await startedThread()).emit('message', { ok: false, message: 'PDF text geometry could not be read: damaged' });
    const converted = await pending;
    expect(converted.filename).toBe('doc.txt');
  });
});
