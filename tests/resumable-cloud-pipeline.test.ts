import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionQueueItem } from '../src/lib/types';

vi.mock('../src/lib/edge/pipelines/fallback-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/pipelines/fallback-pipeline')>();
  return { ...actual, executeServerlessCloudFallback: vi.fn() };
});

import { executeResumableCloudConversion, type ResumableStage, type ResumableTiming } from '../src/lib/edge/pipelines/resumable-cloud-pipeline';
import { executeServerlessCloudFallback } from '../src/lib/edge/pipelines/fallback-pipeline';
import { executeItemConversion } from '../src/lib/client-converter';
import { SINGLE_REQUEST_FILE_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';

const MIB = 1024 * 1024;
const NO_WAIT: ResumableTiming = { pollIntervalMs: 0, retryDelayMs: 0, maxWaitMs: 60_000 };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  bodyBytes?: number;
}

type Handler = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;
/** A change to the answer of the server for one request; undefined leaves it to the server. */
type Override = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response> | undefined;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A file that reports `size` bytes and slices into small blobs that remember their range, since no test can hold 130 MiB. */
function bigFile(name: string, size: number): { file: File; slices: Array<[number, number]> } {
  const file = new File([new Uint8Array(1)], name, { type: 'text/csv' });
  const slices: Array<[number, number]> = [];
  Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'slice', {
    value: (start: number, end: number) => {
      slices.push([start, end]);
      return new Blob([`bytes ${start}-${end}`]);
    },
  });
  return { file, slices };
}

let calls: Call[];

function installFetch(handler: Handler): void {
  calls = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const body = init.body;
    const call: Call = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      json: typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined,
      bodyBytes: body instanceof Blob ? body.size : undefined,
    };
    calls.push(call);
    return handler(call, init.signal ?? undefined);
  });
}

/** The four steps of the server: it takes the upload, hands out a job id and lets the job pass through the given states. */
function happyServer(jobStates: Array<Record<string, unknown>>, override: Override = () => undefined): Handler {
  let polls = 0;
  return (call, signal) => {
    const early = override(call, signal);
    if (early) return early;
    if (call.url.includes('action=initiate')) return json({ success: true, uploadId: 'up_1', key: 'conversions/anon:x/up_1_big.csv', partSize: UPLOAD_PART_MAX_BYTES });
    if (call.url.includes('action=chunk')) {
      const partNumber = Number(new URL(call.url, 'http://x').searchParams.get('partNumber'));
      return json({ success: true, partNumber, etag: `"etag${partNumber}"`, size: call.bodyBytes });
    }
    if (call.url.includes('action=complete')) return json({ success: true, key: 'conversions/anon:x/up_1_big.csv', size: 1 });
    if (call.url.includes('action=abort')) return json({ success: true });
    if (call.url === '/api/queue/jobs' && call.method === 'POST') return json({ success: true, jobId: 'job_1' });
    if (call.url === '/api/queue/jobs/job_1' && call.method === 'GET') return json({ success: true, ...jobStates[Math.min(polls++, jobStates.length - 1)] });
    if (call.url === '/api/queue/jobs/job_1' && call.method === 'DELETE') return json({ success: true });
    if (call.url.startsWith('/api/storage/file/')) return new Response('converted bytes');
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  };
}

const COMPLETED = { id: 'job_1', state: 'completed', progress: 100, returnvalue: { downloadUrl: '/api/storage/file/results%2Fjob_1%2Fbig.json' } };

beforeEach(() => {
  vi.mocked(executeServerlessCloudFallback).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a file over a single request is converted through parts and a job', () => {
  it('opens one upload, sends each part in order, completes it, runs the job and downloads the result', async () => {
    installFetch(happyServer([
      { id: 'job_1', state: 'waiting', progress: 0 },
      { id: 'job_1', state: 'active', progress: 50 },
      COMPLETED,
    ]));
    const { file, slices } = bigFile('big.csv', 2 * UPLOAD_PART_MAX_BYTES + 3 * MIB);
    const progress: number[] = [];
    const stages: ResumableStage[] = [];

    const result = await executeResumableCloudConversion(file, 'json', { quality: 80 }, {
      onProgress: (p) => progress.push(p),
      onStage: (s) => stages.push(s),
    }, NO_WAIT);

    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/storage/multipart?action=initiate' });
    expect(calls[0].json).toEqual({
      filename: 'big.csv',
      mimeType: 'text/csv',
      totalSize: 2 * UPLOAD_PART_MAX_BYTES + 3 * MIB,
      partSize: UPLOAD_PART_MAX_BYTES,
    });
    expect(slices).toEqual([
      [0, UPLOAD_PART_MAX_BYTES],
      [UPLOAD_PART_MAX_BYTES, 2 * UPLOAD_PART_MAX_BYTES],
      [2 * UPLOAD_PART_MAX_BYTES, 3 * UPLOAD_PART_MAX_BYTES],
    ]);
    const parts = calls.filter((c) => c.url.includes('action=chunk'));
    expect(parts.map((c) => c.url)).toEqual([1, 2, 3].map((n) => `/api/storage/multipart?action=chunk&uploadId=up_1&partNumber=${n}`));
    expect(parts.every((c) => c.headers['Content-Type'] === 'application/octet-stream')).toBe(true);
    expect(calls.find((c) => c.url.includes('action=complete'))?.json).toEqual({
      uploadId: 'up_1',
      parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `"etag${n}"` })),
    });
    expect(calls.find((c) => c.url === '/api/queue/jobs' && c.method === 'POST')?.json).toEqual({
      filename: 'big.csv',
      targetFormat: 'json',
      options: { quality: 80 },
      storageKey: 'conversions/anon:x/up_1_big.csv',
      fileSize: 2 * UPLOAD_PART_MAX_BYTES + 3 * MIB,
    });
    expect(calls.filter((c) => c.url === '/api/queue/jobs/job_1' && c.method === 'GET')).toHaveLength(3);
    expect(calls.at(-1)?.url).toBe('/api/storage/file/results%2Fjob_1%2Fbig.json');
    expect(await result.blob.text()).toBe('converted bytes');
    expect(result.size).toBe('converted bytes'.length);
    expect(result.url.startsWith('blob:')).toBe(true);

    expect(stages).toEqual(['uploading', 'converting']);
    expect(progress).toEqual([22, 44, 45, 45, 70, 100]);
  });

  it('shows the progress of the upload part by part and the job between the upload and the download', async () => {
    installFetch(happyServer([{ id: 'job_1', state: 'active', progress: 100 }, COMPLETED]));
    const { file } = bigFile('big.csv', 2 * UPLOAD_PART_MAX_BYTES);
    const progress: number[] = [];

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: (p) => progress.push(p) }, NO_WAIT);

    expect(progress).toEqual([23, 45, 95, 100]);
  });

  it('sends a part again after the rate limit asks for it and a request that failed on the network', async () => {
    let partAttempts = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('partNumber=2')) return undefined;
      partAttempts += 1;
      if (partAttempts === 1) return json({ success: false }, 429, { 'Retry-After': '0' });
      if (partAttempts === 2) throw new TypeError('network down');
      return undefined;
    }));
    const { file } = bigFile('big.csv', 2 * UPLOAD_PART_MAX_BYTES);

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);

    expect(partAttempts).toBe(3);
    expect(calls.filter((c) => c.url.includes('action=complete'))).toHaveLength(1);
  });

  it('does not send the start of the job again after a network error, but does after the rate limit', async () => {
    let starts = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (call.url !== '/api/queue/jobs' || call.method !== 'POST') return undefined;
      starts += 1;
      if (starts === 1) return json({ success: false }, 429, { 'Retry-After': '0' });
      return undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);
    expect(starts).toBe(2);

    installFetch(happyServer([COMPLETED], (call) => {
      if (call.url === '/api/queue/jobs' && call.method === 'POST') throw new TypeError('network down');
      return undefined;
    }));
    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('network down');
    expect(calls.filter((c) => c.url === '/api/queue/jobs' && c.method === 'POST')).toHaveLength(1);
  });

  it('gives up on a part after four attempts and closes the upload', async () => {
    installFetch(happyServer([COMPLETED], (call) =>
      call.url.includes('action=chunk') ? json({ success: false, detail: 'busy' }, 503, { 'Retry-After': '0' }) : undefined
    ));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('busy');

    expect(calls.filter((c) => c.url.includes('action=chunk'))).toHaveLength(4);
    expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } });
  });
});

describe('a refusal or a failure is shown as the server worded it and leaves nothing behind', () => {
  it('shows the sentence of a 413 at the start of the upload and opens nothing', async () => {
    installFetch(() =>
      json({ success: false, detail: 'File size 2 GB exceeds the 1 GB limit for anonymous use. Pro allows files up to 5 GB.' }, 413)
    );
    const { file } = bigFile('big.csv', 2 * 1024 * MIB);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow(
      'File size 2 GB exceeds the 1 GB limit for anonymous use. Pro allows files up to 5 GB.'
    );
    expect(calls).toHaveLength(1);
  });

  it('shows the reason a job failed and does not cancel a job that ended', async () => {
    installFetch(happyServer([{ id: 'job_1', state: 'failed', progress: 10, failedReason: 'The file is encrypted.' }]));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow(
      'The file is encrypted.'
    );
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.some((c) => c.url.includes('action=abort'))).toBe(false);
  });

  it('stops waiting for a job that does not end', async () => {
    installFetch(happyServer([{ id: 'job_1', state: 'active', progress: 10 }]));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, { ...NO_WAIT, maxWaitMs: 0 })
    ).rejects.toThrow('did not finish in time');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/queue/jobs/job_1' });
  });
});

describe('cancelling stops the upload and the job', () => {
  it('aborts the request of the part in flight, closes the upload and queues no job', async () => {
    const aborter = new AbortController();
    installFetch(happyServer([COMPLETED], (call, signal) => {
      if (!call.url.includes('partNumber=2')) return undefined;
      const inFlight = new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
      aborter.abort();
      return inFlight;
    }));
    const { file } = bigFile('big.csv', 3 * UPLOAD_PART_MAX_BYTES);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined, signal: aborter.signal }, NO_WAIT)
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls.filter((c) => c.url.includes('action=chunk')).map((c) => c.url.at(-1))).toEqual(['1', '2']);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } });
    expect(calls.some((c) => c.url === '/api/queue/jobs' && c.method === 'POST')).toBe(false);
    expect(calls.some((c) => c.url.includes('action=complete'))).toBe(false);
  });

  it('cancels the job that is queued while the server converts', async () => {
    const aborter = new AbortController();
    installFetch(happyServer([{ id: 'job_1', state: 'active', progress: 20 }], (call) => {
      if (call.url === '/api/queue/jobs/job_1' && call.method === 'GET') aborter.abort();
      return undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined, signal: aborter.signal }, NO_WAIT)
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/queue/jobs/job_1' });
    expect(calls.some((c) => c.url.includes('action=abort'))).toBe(false);
  });

  it('does not start when it is already cancelled', async () => {
    const aborter = new AbortController();
    aborter.abort();
    installFetch((_call, signal) => (signal?.aborted ? Promise.reject(signal.reason) : json({})));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined, signal: aborter.signal }, NO_WAIT)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.filter((c) => !c.url.includes('action=abort'))).toHaveLength(1);
  });
});

describe('the browser picks the way to the server by the size of the file', () => {
  function itemOfSize(size: number): ConversionQueueItem {
    const file = new File([new Uint8Array(1)], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'size', { value: size });
    return {
      id: 'item-1',
      file,
      name: 'big.csv',
      size,
      sourceFormat: 'csv',
      targetFormat: 'json',
      status: 'ready',
      progress: 0,
      options: {},
    };
  }

  function callbacks() {
    return { onProgress: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() };
  }

  it('sends a file of exactly the single request limit in one request', async () => {
    vi.mocked(executeServerlessCloudFallback).mockResolvedValue({ blob: new Blob(['x']), url: 'blob:one', size: 1 });
    const cb = callbacks();
    installFetch(() => {
      throw new Error('no request expected');
    });

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES), cb);

    expect(executeServerlessCloudFallback).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
    expect(cb.onSuccess).toHaveBeenCalledWith('blob:one', 1, false, 'Cloud (Zero-Retention)', undefined);
  });

  it('sends a file one byte over it in parts, reports the stage and names the tier', async () => {
    installFetch(happyServer([COMPLETED]));
    const cb = { ...callbacks(), onStage: vi.fn() };

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES + 1), cb);

    expect(executeServerlessCloudFallback).not.toHaveBeenCalled();
    expect(cb.onStage.mock.calls).toEqual([['uploading'], ['converting']]);
    expect(cb.onSuccess).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 'converted bytes'.length, false, 'Cloud (Upload in parts)', undefined);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('shows the refusal of the server on the item', async () => {
    installFetch(() => json({ detail: 'The server is out of disk space for new files. Retry the request shortly.' }, 503, { 'Retry-After': '0' }));
    const cb = callbacks();

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES + 1), cb);

    expect(cb.onError).toHaveBeenCalledWith('The server is out of disk space for new files. Retry the request shortly.');
  });

  it('reports nothing for a conversion that was cancelled', async () => {
    const aborter = new AbortController();
    installFetch((_call, signal) => {
      aborter.abort();
      return Promise.reject(signal?.reason);
    });
    const cb = callbacks();

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES + 1), cb, aborter.signal);

    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onSuccess).not.toHaveBeenCalled();
  });
});
