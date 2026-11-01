import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionQueueItem } from '../src/lib/types';

vi.mock('../src/lib/edge/pipelines/fallback-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/pipelines/fallback-pipeline')>();
  return { ...actual, executeServerlessCloudFallback: vi.fn() };
});

import {
  PART_IN_FLIGHT_WAIT_MS,
  executeResumableCloudConversion,
  type ResumableStage,
  type ResumableTiming,
} from '../src/lib/edge/pipelines/resumable-cloud-pipeline';
import { PART_IN_FLIGHT_PROBLEM_TYPE, PART_IN_FLIGHT_STATUS } from '../src/lib/part-in-flight';
import { NextRequest } from 'next/server';
import { partFailureResponse } from '../src/lib/api/part-response';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { InMemoryIdempotencyStore, getIdempotencyStore, setIdempotencyStore } from '../src/lib/api/idempotency';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { forgetUploadParts, receivePart, type PartStore } from '../src/lib/storage/part-admission';
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_REQUEST_TIMEOUT_MS } from '../src/lib/storage/adapters/s3';
import { executeServerlessCloudFallback } from '../src/lib/edge/pipelines/fallback-pipeline';
import { executeItemConversion } from '../src/lib/client-converter';
import { SINGLE_REQUEST_FILE_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';

const MIB = 1024 * 1024;
const NO_WAIT: ResumableTiming = { pollIntervalMs: 0, retryDelayMs: 0, maxWaitMs: 60_000, partInFlightWaitMs: 5_000 };
const PART_IN_FLIGHT = PART_IN_FLIGHT_PROBLEM_TYPE;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  bodyBytes?: number;
  keepalive?: boolean;
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

/** Moves the faked clock a second at a time, between the real file operations of the routes, until `settled` ends. */
/** The timer of the host, kept before a test fakes the global one, so the routes' real file system work can finish. */
const realSetTimeout = globalThis.setTimeout;

async function runClockUntilSettled(settled: Promise<unknown>): Promise<void> {
  let done = false;
  void settled.then(() => (done = true));
  for (let second = 0; second < 1_000 && !done; second++) {
    await vi.advanceTimersByTimeAsync(1_000);
    // A route's flushed writes take several thread-pool round trips; each fake second waits for them in real time.
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
}

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
      keepalive: init.keepalive,
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
    if (call.url.includes('action=initiate')) return json({ success: true, uploadId: 'up_1', key: 'uploads/up_1_big.csv', partSize: UPLOAD_PART_MAX_BYTES });
    if (call.url.includes('action=chunk')) {
      const partNumber = Number(new URL(call.url, 'http://x').searchParams.get('partNumber'));
      return json({ success: true, partNumber, etag: `"etag${partNumber}"`, size: call.bodyBytes });
    }
    if (call.url.includes('action=complete')) return json({ success: true, key: 'uploads/up_1_big.csv', size: 1 });
    if (call.url.includes('action=abort') || call.url.includes('action=discard')) return json({ success: true });
    if (call.url === '/api/queue/jobs' && call.method === 'POST') return json({ success: true, jobId: 'job_1' });
    if (call.url === '/api/queue/jobs/job_1' && call.method === 'GET') return json({ success: true, ...jobStates[Math.min(polls++, jobStates.length - 1)] });
    if (call.url === '/api/queue/jobs/job_1' && call.method === 'DELETE') return json({ success: true });
    if (call.url.startsWith('/api/storage/file/')) return new Response('converted bytes');
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  };
}

const RESULT_URL = '/api/storage/file/results%2Fjob_1%2Fbig.json';
const COMPLETED = { id: 'job_1', state: 'completed', progress: 100, returnvalue: { downloadUrl: RESULT_URL, size: 4321 } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isJobStart(call: Call): boolean {
  return call.url === '/api/queue/jobs' && call.method === 'POST';
}

/** The answer the routes give a part sent again while its earlier attempt is still being written, made by their own code. */
async function refusalOfARepeatedPart(): Promise<Response> {
  const uploadId = 'up_binding';
  let release: () => void = () => undefined;
  const store: PartStore = {
    getUploadedParts: async () => [],
    uploadPartStream: async (_id, partNumber) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { partNumber, size: 1, etag: 'e' };
    },
  };
  const request = { uploadId, partNumber: 1, declaredBytes: 1, totalSize: 4, maxPartBytes: UPLOAD_PART_MAX_BYTES };
  const emptyBody = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const earlier = receivePart(store, request, emptyBody());
  try {
    return await receivePart(store, request, emptyBody()).then(
      () => {
        throw new Error('the repeat of a part on the way was not refused');
      },
      (error: unknown) => partFailureResponse(error, '/api/storage/multipart')
    );
  } finally {
    release();
    await earlier;
    forgetUploadParts(uploadId);
  }
}

/** The answer the route gives a part when the host has no free file descriptor for now (EMFILE), made by its own code. */
function answerOfATransientDiskError(): Response {
  const error = Object.assign(new Error("EMFILE: too many open files, open '/srv/easyconvert/data/part-1.bin'"), { code: 'EMFILE', syscall: 'open' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return partFailureResponse(error, '/api/storage/multipart');
}

/**
 * The answer the route gives a repeat of a completion whose first answer the idempotency store could not keep, made by
 * the route itself on a real one-part upload.
 */
async function repeatedCompletionByTheRoute(): Promise<{ status: number; body: string; key: string }> {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const visitor = { 'x-forwarded-for': '203.0.113.201' };
  const bytes = Buffer.from('a,b\n1,2\n');
  const post = (action: string, body: unknown, headers: Record<string, string>) =>
    multipartPost(
      new NextRequest(`http://localhost:3000/api/storage/multipart?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    );
  const { uploadId } = await (await post('initiate', { filename: 'a.csv', totalSize: bytes.length }, visitor)).json();
  const { etag } = await (
    await multipartPost(
      new NextRequest(`http://localhost:3000/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...visitor },
        body: new Uint8Array(bytes),
      })
    )
  ).json();
  const completion = { uploadId, parts: [{ partNumber: 1, etag }] };
  const headers = { ...visitor, 'Idempotency-Key': `completion-${uploadId}` };
  vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
  const { key } = await (await post('complete', completion, headers)).json();
  const repeat = await post('complete', completion, headers);
  await s3Storage.deleteObject(key);
  return { status: repeat.status, body: await repeat.text(), key };
}

beforeEach(() => {
  vi.mocked(executeServerlessCloudFallback).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a file over a single request is converted through parts and a job', () => {
  it('opens one upload, sends each part in order, completes it, runs the job and hands over the URL of the result', async () => {
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
      storageKey: 'uploads/up_1_big.csv',
      fileSize: 2 * UPLOAD_PART_MAX_BYTES + 3 * MIB,
    });
    expect(calls.filter((c) => c.url === '/api/queue/jobs/job_1' && c.method === 'GET')).toHaveLength(3);
    expect(calls.some((c) => c.url.startsWith('/api/storage/file/'))).toBe(false);
    expect(result).toEqual({ url: RESULT_URL, size: 4321 });

    const opening = calls[0].headers['Idempotency-Key'];
    const starting = calls.find(isJobStart)?.headers['Idempotency-Key'];
    expect(opening).toMatch(UUID);
    expect(starting).toMatch(UUID);
    expect(starting).not.toBe(opening);

    expect(stages).toEqual(['uploading', 'converting']);
    expect(progress).toEqual([22, 44, 45, 45, 73, 100]);
  });

  it('shows the progress of the upload part by part and the job between the upload and the download', async () => {
    installFetch(happyServer([{ id: 'job_1', state: 'active', progress: 100 }, COMPLETED]));
    const { file } = bigFile('big.csv', 2 * UPLOAD_PART_MAX_BYTES);
    const progress: number[] = [];

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: (p) => progress.push(p) }, NO_WAIT);

    expect(progress).toEqual([23, 45, 100, 100]);
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

  it('sends the start of the job again with the same idempotency key after the rate limit and after a network error', async () => {
    let starts = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!isJobStart(call)) return undefined;
      starts += 1;
      if (starts === 1) return json({ success: false }, 429, { 'Retry-After': '0' });
      if (starts === 2) throw new TypeError('network down');
      return undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);

    const keys = calls.filter(isJobStart).map((c) => c.headers['Idempotency-Key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('waits for the first start of the job when a repeat meets it still running', async () => {
    let starts = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!isJobStart(call)) return undefined;
      starts += 1;
      return starts === 1 ? json({ detail: 'in flight' }, 409, { 'Retry-After': '0' }) : undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).resolves.toEqual({ url: RESULT_URL, size: 4321 });
    expect(starts).toBe(2);
  });

  it('sends the completion again with its idempotency key, and asks with it which file a completion whose answer was lost stored', async () => {
    let completions = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=complete')) return undefined;
      completions += 1;
      return completions <= 4 ? Promise.reject(new TypeError('network down')) : undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('network down');

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=discard', json: { key: 'uploads/up_1_big.csv' } }));
    const asked = calls.filter((c) => c.url.includes('action=complete'));
    expect(asked).toHaveLength(5);
    expect(asked[0].headers['Idempotency-Key']).toMatch(UUID);
    expect(new Set(asked.map((c) => c.headers['Idempotency-Key'])).size).toBe(1);
    expect(calls.some((c) => c.url.includes('action=abort'))).toBe(false);
  });

  it('sends a part again after the answer the route gives a transient error of the disk, and finishes the upload', async () => {
    const transient = answerOfATransientDiskError();
    expect(transient.status).toBe(503);
    expect(Number(transient.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await transient.text();
    let refused = 2;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=chunk') || refused-- <= 0) return undefined;
      return new Response(body, { status: transient.status, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '0' } });
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).resolves.toEqual({ url: RESULT_URL, size: 4321 });

    expect(calls.filter((c) => c.url.includes('action=chunk') && c.url.includes('partNumber=1'))).toHaveLength(3);
    expect(calls.filter((c) => c.url.includes('action=complete'))).toHaveLength(1);
  });

  it('finishes the upload from the answer the route gives the repeat of a completion whose first answer was lost', async () => {
    const repeat = await repeatedCompletionByTheRoute();
    expect(repeat.status).toBe(200);
    let completions = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=complete')) return undefined;
      completions += 1;
      return completions === 1 ? Promise.reject(new TypeError('network down')) : new Response(repeat.body, { status: repeat.status, headers: { 'Content-Type': 'application/json' } });
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).resolves.toEqual({ url: RESULT_URL, size: 4321 });

    const asked = calls.filter((c) => c.url.includes('action=complete'));
    expect(asked).toHaveLength(2);
    expect(new Set(asked.map((c) => c.headers['Idempotency-Key'])).size).toBe(1);
    expect(calls.find(isJobStart)?.json).toMatchObject({ storageKey: repeat.key });
    expect(calls.some((c) => c.url.includes('action=abort') || c.url.includes('action=discard'))).toBe(false);
  });

  it('aborts the upload when the completion whose answer was lost stored nothing', async () => {
    let completions = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=complete')) return undefined;
      completions += 1;
      return completions <= 4 ? Promise.reject(new TypeError('network down')) : json({ detail: 'Storage object not found.' }, 404);
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('network down');

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } }));
  });

  it('shows at once that uploads without an account are off on this server', async () => {
    installFetch(() => json({ type: 'https://api.easyconvert.io/problems/client-ip-trust-unconfigured', detail: 'Uploads without an account are off.' }, 503));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('are off');
    expect(calls).toHaveLength(1);
  });

  it('shows a refusal that lasts until tomorrow at once instead of sending again', async () => {
    installFetch(() => json({ type: 'https://api.easyconvert.io/problems/upload-budget-exceeded', detail: 'Without an account, uploads may total 2 GiB a day.' }, 429));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    const conversion = executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);
    await expect(conversion).rejects.toThrow('2 GiB a day');
    await expect(conversion).rejects.toMatchObject({
      failure: { code: 'server', problem: { type: 'https://api.easyconvert.io/problems/upload-budget-exceeded', status: 429 } },
    });
    expect(calls).toHaveLength(1);
  });

  it('waits behind an earlier attempt of the same part without spending its attempts', async () => {
    let behind = 6;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=chunk') || behind-- <= 0) return undefined;
      return json({ type: PART_IN_FLIGHT, detail: 'This part is still being received from an earlier request.' }, 503, { 'Retry-After': '0' });
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);

    expect(calls.filter((c) => c.url.includes('action=chunk') && c.url.includes('partNumber=1'))).toHaveLength(7);
    expect(calls.filter((c) => c.url.includes('action=complete'))).toHaveLength(1);
  });

  it('waits behind the refusal the routes themselves give a repeated part, without spending an attempt', async () => {
    const refusal = await refusalOfARepeatedPart();
    expect(refusal.status).toBe(PART_IN_FLIGHT_STATUS);
    expect(Number(refusal.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await refusal.text();
    let behind = 6;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=chunk') || behind-- <= 0) return undefined;
      return new Response(body, { status: refusal.status, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '0' } });
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);

    expect(calls.filter((c) => c.url.includes('action=chunk') && c.url.includes('partNumber=1'))).toHaveLength(7);
  });

  it('does not wait behind that refusal for a request that is not a part, which keeps its four attempts', async () => {
    installFetch(() => json({ type: PART_IN_FLIGHT, detail: 'still on the way' }, PART_IN_FLIGHT_STATUS, { 'Retry-After': '0' }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('still on the way');

    expect(calls).toHaveLength(4);
  });

  it('waits behind an earlier attempt for longer than the object store lets that attempt run', () => {
    expect(PART_IN_FLIGHT_WAIT_MS).toBeGreaterThan(DEFAULT_MAX_ATTEMPTS * DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('gives up on a part still on the way once the wait for it is over, and closes the upload', async () => {
    installFetch(happyServer([COMPLETED], (call) =>
      call.url.includes('action=chunk') ? json({ type: PART_IN_FLIGHT, detail: 'still on the way' }, 503, { 'Retry-After': '0' }) : undefined
    ));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, { ...NO_WAIT, partInFlightWaitMs: 30 })
    ).rejects.toThrow('still on the way');

    expect(calls.filter((c) => c.url.includes('action=chunk')).length).toBeGreaterThan(4);
    expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } });
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
      json({ success: false, detail: 'File size 2 GiB exceeds the 1 GiB limit for anonymous use.' }, 413)
    );
    const { file } = bigFile('big.csv', 2 * 1024 * MIB);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow(
      'File size 2 GiB exceeds the 1 GiB limit for anonymous use.'
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

  it('deletes the stored upload when the job is refused after the upload completed', async () => {
    installFetch(happyServer([COMPLETED], (call) =>
      isJobStart(call) ? json({ success: false, error: 'This account already has 5 conversions in progress.' }, 400) : undefined
    ));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('5 conversions');
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=discard', json: { key: 'uploads/up_1_big.csv' } }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('asks again with the idempotency key what an opening whose answer was lost made, and closes it', async () => {
    let openings = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=initiate')) return undefined;
      openings += 1;
      return openings <= 4 ? Promise.reject(new TypeError('network down')) : undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('network down');

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } }));
    const asked = calls.filter((c) => c.url.includes('action=initiate'));
    expect(asked).toHaveLength(5);
    expect(new Set(asked.map((c) => c.headers['Idempotency-Key'])).size).toBe(1);
  });

  it('opens one upload when the answer to the opening was lost and the store could not record it, since a repeat meets the kept lock and waits inside it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setIdempotencyStore(new InMemoryIdempotencyStore());
    try {
      vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValue(new Error('redis: connection reset'));
      const visitor = { 'x-forwarded-for': '203.0.113.202' };
      const opened: string[] = [];
      let openings = 0;
      const openByTheRoute = async (call: Call): Promise<Response> => {
        openings += 1;
        const res = await multipartPost(
          new NextRequest(`http://localhost:3000${call.url}`, {
            method: 'POST',
            headers: { ...call.headers, ...visitor },
            body: JSON.stringify(call.json),
          })
        );
        if (res.ok) opened.push((await res.clone().json()).uploadId);
        if (openings === 1) throw new TypeError('network down');
        return res;
      };
      installFetch(happyServer([COMPLETED], (call) => (call.url.includes('action=initiate') ? openByTheRoute(call) : undefined)));
      const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

      const ended = executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT).then(
        () => undefined,
        (error: Error) => error
      );
      await runClockUntilSettled(ended);

      expect(opened).toHaveLength(1);
      expect(openings).toBeGreaterThan(1);
      expect(await ended).toBeInstanceOf(Error);
      vi.useRealTimers();
      await multipartPost(
        new NextRequest('http://localhost:3000/api/storage/multipart?action=abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...visitor },
          body: JSON.stringify({ uploadId: opened[0] }),
        })
      );
    } finally {
      vi.useRealTimers();
      setIdempotencyStore(null);
    }
  });

  it('asks again what an opening that failed with a server error made, since it may have opened the upload first', async () => {
    let openings = 0;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=initiate')) return undefined;
      openings += 1;
      return openings === 1 ? json({ detail: 'Storage operation error' }, 500) : undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('Storage operation error');

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } }));
    const asked = calls.filter((c) => c.url.includes('action=initiate'));
    expect(asked).toHaveLength(2);
    expect(asked[1].headers['Idempotency-Key']).toBe(asked[0].headers['Idempotency-Key']);
  });

  it('asks nothing again after the server refused the opening, since it opened nothing', async () => {
    installFetch(() => json({ detail: 'Up to 2 uploads may be open at once without an account.' }, 400));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('Up to 2 uploads');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
  });

  it('stops waiting for a job that does not end', async () => {
    installFetch(happyServer([{ id: 'job_1', state: 'active', progress: 10 }]));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    const conversion = executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, { ...NO_WAIT, maxWaitMs: 0 });
    await expect(conversion).rejects.toThrow('did not finish in time');
    await expect(conversion).rejects.toMatchObject({ failure: { code: 'jobTimedOut' } });
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
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/storage/multipart?action=abort', json: { uploadId: 'up_1' } }));
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

  it('lets the completion finish when cancelled meanwhile, then gives up the stored upload', async () => {
    const aborter = new AbortController();
    installFetch(happyServer([COMPLETED], (call, signal) => {
      if (!call.url.includes('action=complete')) return undefined;
      expect(signal).toBeUndefined();
      aborter.abort();
      return undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined, signal: aborter.signal }, NO_WAIT)
    ).rejects.toMatchObject({ name: 'AbortError' });

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/storage/multipart?action=discard', json: { key: 'uploads/up_1_big.csv' } }));
    expect(calls.some(isJobStart)).toBe(false);
  });

  it('lets the start of the job finish when cancelled meanwhile, then cancels the job', async () => {
    const aborter = new AbortController();
    installFetch(happyServer([COMPLETED], (call) => {
      if (isJobStart(call)) aborter.abort();
      return undefined;
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined, signal: aborter.signal }, NO_WAIT)
    ).rejects.toMatchObject({ name: 'AbortError' });

    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/queue/jobs/job_1' }));
    expect(calls.some((c) => c.url === '/api/queue/jobs/job_1' && c.method === 'GET')).toBe(false);
  });

  it('aborts the upload with a request that outlives the page when the page is left mid-upload', async () => {
    const page = new EventTarget();
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
    vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
    let release: () => void = () => undefined;
    installFetch(happyServer([COMPLETED], (call) => {
      if (!call.url.includes('action=chunk')) return undefined;
      page.dispatchEvent(new Event('pagehide'));
      return new Promise<Response>((resolve) => {
        release = () => resolve(json({ detail: 'gone' }, 404));
      });
    }));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    const conversion = executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('action=abort'))).toBe(true));
    release();
    await expect(conversion).rejects.toThrow('gone');

    const abort = calls.find((c) => c.url.includes('action=abort'));
    expect(abort?.json).toEqual({ uploadId: 'up_1' });
    expect(abort?.keepalive).toBe(true);
  });

  describe('when the page is left', () => {
    let page: EventTarget;
    const leave = (persisted: boolean) => page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));

    beforeEach(() => {
      page = new EventTarget();
      vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
      vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
    });

    it('sends the abort once, though the call then fails and closes what it left too', async () => {
      installFetch(happyServer([COMPLETED], (call) => {
        if (!call.url.includes('action=chunk')) return undefined;
        leave(false);
        return json({ detail: 'gone' }, 404);
      }));
      const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

      await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).rejects.toThrow('gone');

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls.filter((c) => c.url.includes('action=abort'))).toHaveLength(1);
    });

    it('closes nothing when the page is kept for the back button, since the call goes on when the page comes back', async () => {
      let parts = 0;
      installFetch(happyServer([COMPLETED], (call) => {
        if (call.url.includes('action=chunk') && parts++ === 0) leave(true);
        return undefined;
      }));
      const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

      await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).resolves.toMatchObject({ url: RESULT_URL });
      expect(calls.some((c) => c.url.includes('action=abort'))).toBe(false);
    });

    it('sends only requests that need no answer: a completion on the way is left to the call', async () => {
      installFetch(happyServer([COMPLETED], (call) => {
        if (call.url.includes('action=complete') && !call.keepalive) leave(false);
        return undefined;
      }));
      const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

      await expect(executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined }, NO_WAIT)).resolves.toMatchObject({ url: RESULT_URL });
      expect(calls.filter((c) => c.url.includes('action=complete'))).toHaveLength(1);
      expect(calls.some((c) => c.url.includes('action=abort') || c.url.includes('action=discard'))).toBe(false);
    });
  });

  it('does not start when it is already cancelled', async () => {
    const aborter = new AbortController();
    aborter.abort();
    installFetch(() => json({}));
    const { file } = bigFile('big.csv', UPLOAD_PART_MAX_BYTES + 1);

    await expect(
      executeResumableCloudConversion(file, 'json', {}, { onProgress: () => undefined, signal: aborter.signal }, NO_WAIT)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
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

    const aborter = new AbortController();

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES), cb, aborter.signal);

    expect(executeServerlessCloudFallback).toHaveBeenCalledOnce();
    expect(vi.mocked(executeServerlessCloudFallback).mock.calls[0][4]).toBe(aborter.signal);
    expect(calls).toHaveLength(0);
    expect(cb.onSuccess).toHaveBeenCalledWith('blob:one', 1, false, 'Cloud (Zero-Retention)', undefined);
  });

  it('sends a file one byte over it in parts, reports the stage and names the tier', async () => {
    installFetch(happyServer([COMPLETED]));
    const cb = { ...callbacks(), onStage: vi.fn() };

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES + 1), cb);

    expect(executeServerlessCloudFallback).not.toHaveBeenCalled();
    expect(cb.onStage.mock.calls).toEqual([['uploading'], ['converting']]);
    expect(cb.onSuccess).toHaveBeenCalledWith(RESULT_URL, 4321, false, 'Cloud (Upload in parts)', undefined);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('shows the refusal of the server on the item', async () => {
    installFetch(() => json({ detail: 'The server is out of disk space for new files. Retry the request shortly.' }, 503, { 'Retry-After': '0' }));
    const cb = callbacks();

    await executeItemConversion(itemOfSize(SINGLE_REQUEST_FILE_MAX_BYTES + 1), cb);

    expect(cb.onError).toHaveBeenCalledWith({
      code: 'server',
      problem: { detail: 'The server is out of disk space for new files. Retry the request shortly.', status: 503 },
    });
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
