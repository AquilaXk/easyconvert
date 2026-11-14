import { describe, expect, it } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { InMemoryIdempotencyStore } from '../src/lib/api/idempotency';
import {
  IDEMPOTENCY_MAX_STORED_BODY_BYTES,
  IDEMPOTENCY_RESPONSE_NOT_KEPT_PROBLEM_TYPE,
  acquireIdempotency,
} from '../src/lib/api/with-idempotency';

/**
 * The answer of a request is kept for 24 hours under its `Idempotency-Key`. Redis runs with a memory limit and no eviction, so a record
 * of megabytes makes every write fail, the accounts and billing included: a large answer is kept as a reference, not as a copy.
 */

const URL_OF_ROUTE = 'http://localhost/api/v1/convert';
const LARGE_BYTES = 768 * 1024;

function request(key: string, query = '', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${URL_OF_ROUTE}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
    body: JSON.stringify({ targetFormat: 'json' }),
  });
}

/** Runs a first request whose answer is `answer`, then repeats it; returns the stored record and the answer of the repeat. */
async function answerTwice(answer: NextResponse) {
  const store = new InMemoryIdempotencyStore();
  const first = await acquireIdempotency(request('k1'), 'user-1', 'k1', '/api/v1/convert', { store });
  await first.context!.complete(answer);
  const [scopedKey] = [...(store as unknown as { records: Map<string, unknown> }).records.keys()];
  const record = await store.getRecord!(scopedKey);
  const repeat = await acquireIdempotency(request('k1'), 'user-1', 'k1', '/api/v1/convert', { store });
  return { record, repeat: repeat.response as Response };
}

describe('the answer that is kept under an idempotency key', () => {
  it('keeps a small answer whole', async () => {
    const { record, repeat } = await answerTwice(NextResponse.json({ success: true, fileId: 'f1' }));
    expect(record?.response?.omittedBodyBytes).toBeUndefined();
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ success: true, fileId: 'f1' });
  });

  it('keeps only the size of a raw answer over the limit, and tells a repeat which file to fetch', async () => {
    const bytes = new Uint8Array(LARGE_BYTES).fill(7);
    const { record, repeat } = await answerTwice(
      new NextResponse(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'X-File-Id': 'file-9' } })
    );

    expect(record?.response?.body).toBe('');
    expect(record?.response?.omittedBodyBytes).toBe(LARGE_BYTES);
    expect(repeat.status).toBe(409);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    const problem = await repeat.json();
    expect(problem.type).toBe(IDEMPOTENCY_RESPONSE_NOT_KEPT_PROBLEM_TYPE);
    expect(problem.fileId).toBe('file-9');
    expect(problem.detail).toContain('file-9');
  });

  it('keeps a JSON answer whose inline result is too large without that result, with the reference to the stored file', async () => {
    const body = { success: true, fileId: 'f2', size: LARGE_BYTES, downloadUrl: '/api/storage/file/x', dataUri: `data:text/plain;base64,${'A'.repeat(LARGE_BYTES)}` };
    const { record, repeat } = await answerTwice(NextResponse.json(body));

    expect(Buffer.byteLength(record?.response?.body ?? '')).toBeLessThanOrEqual(IDEMPOTENCY_MAX_STORED_BODY_BYTES);
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    const { dataUri, ...rest } = body;
    expect(dataUri).toBeDefined();
    expect(await repeat.json()).toEqual(rest);
  });

  it('keeps only the size of a text answer over the limit that has no inline result to leave out', async () => {
    const { record, repeat } = await answerTwice(NextResponse.json({ rows: 'x'.repeat(LARGE_BYTES) }));
    expect(record?.response?.omittedBodyBytes).toBeGreaterThan(IDEMPOTENCY_MAX_STORED_BODY_BYTES);
    expect(repeat.status).toBe(409);
  });
});

describe('the fingerprint of a request that asks for the raw bytes', () => {
  it.each([
    ['?raw=true', {}],
    ['', { Accept: 'application/octet-stream' }],
  ])('refuses the key of a JSON request reused for the raw bytes (%j)', async (query, headers) => {
    const store = new InMemoryIdempotencyStore();
    const first = await acquireIdempotency(request('k2'), 'user-1', 'k2', '/api/v1/convert', { store });
    await first.context!.complete(NextResponse.json({ success: true }));

    const reused = await acquireIdempotency(request('k2', query, headers), 'user-1', 'k2', '/api/v1/convert', { store });

    expect(reused.response?.status).toBe(422);
  });

  it('still replays a repeat that asks the same way', async () => {
    const store = new InMemoryIdempotencyStore();
    const first = await acquireIdempotency(request('k3', '?raw=true'), 'user-1', 'k3', '/api/v1/convert', { store });
    await first.context!.complete(new NextResponse(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/pdf' } }));

    const repeat = await acquireIdempotency(request('k3', '?raw=true'), 'user-1', 'k3', '/api/v1/convert', { store });

    expect(repeat.response?.status).toBe(200);
  });
});
