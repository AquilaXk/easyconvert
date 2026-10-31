import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { InMemoryIdempotencyStore, setIdempotencyStore } from '../src/lib/api/idempotency';
import { respondOnce } from '../src/lib/api/with-idempotency';

const ROUTE = '/api/storage/multipart';
const IN_FLIGHT_TYPE = 'https://api.easyconvert.io/problems/idempotency-key-in-flight';
const REUSED_TYPE = 'https://api.easyconvert.io/problems/idempotency-key-reused';

let store: InMemoryIdempotencyStore;

beforeEach(() => {
  store = new InMemoryIdempotencyStore();
  setIdempotencyStore(store);
});

afterEach(() => {
  setIdempotencyStore(null);
  vi.restoreAllMocks();
});

function post(key: string | undefined, body: unknown = { uploadId: 'u1' }): NextRequest {
  return new NextRequest(`http://localhost:3000${ROUTE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
}

const created = () => NextResponse.json({ success: true, key: 'uploads/a' });

describe('respondOnce', () => {
  it('runs the handler on every request that has no key', async () => {
    const handler = vi.fn(async () => created());

    await respondOnce(post(undefined), 'u', ROUTE, handler);
    await respondOnce(post(undefined), 'u', ROUTE, handler);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('answers a repeat with the first answer and marks it replayed', async () => {
    const handler = vi.fn(async () => created());

    await respondOnce(post('k1'), 'u', ROUTE, handler);
    const repeat = await respondOnce(post('k1'), 'u', ROUTE, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect((await repeat.json()).key).toBe('uploads/a');
  });

  it('replays a 204 answer, which has no body, without throwing', async () => {
    const handler = vi.fn(async () => new NextResponse(null, { status: 204 }));

    const first = await respondOnce(post('k204'), 'u', ROUTE, handler);
    const repeat = await respondOnce(post('k204'), 'u', ROUTE, handler);

    expect(first.status).toBe(204);
    expect(repeat.status).toBe(204);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('answers a repeat that meets the first one still running with 409 and Retry-After', async () => {
    let finish: (res: Response) => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const first = respondOnce(post('slow'), 'u', ROUTE, () => {
      started();
      return new Promise<Response>((resolve) => (finish = resolve));
    });
    await running;

    const repeat = await respondOnce(post('slow'), 'u', ROUTE, async () => created());

    expect(repeat.status).toBe(409);
    expect(repeat.headers.get('retry-after')).not.toBeNull();
    expect((await repeat.json()).type).toBe(IN_FLIGHT_TYPE);
    finish(created());
    await first;
  });

  it('refuses a key that was used with another request body', async () => {
    await respondOnce(post('k2', { uploadId: 'a' }), 'u', ROUTE, async () => created());

    const other = await respondOnce(post('k2', { uploadId: 'b' }), 'u', ROUTE, async () => created());

    expect(other.status).toBe(422);
    expect((await other.json()).type).toBe(REUSED_TYPE);
  });

  it('keeps nothing of a refusal, so the same request may be sent again', async () => {
    const handler = vi.fn().mockResolvedValueOnce(NextResponse.json({ error: 'busy' }, { status: 429 })).mockResolvedValueOnce(created());

    const refused = await respondOnce(post('k3'), 'u', ROUTE, handler);
    const again = await respondOnce(post('k3'), 'u', ROUTE, handler);

    expect(refused.status).toBe(429);
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBeNull();
  });

  describe('a store that cannot record the answer', () => {
    it('returns the answer of the handler and releases the key, so a repeat is not told the first one still runs', async () => {
      vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = vi.fn(async () => created());

      const first = await respondOnce(post('k4'), 'u', ROUTE, handler);
      const repeat = await respondOnce(post('k4'), 'u', ROUTE, handler);

      expect(first.status).toBe(200);
      expect(repeat.status).not.toBe(409);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(warned.mock.calls.some(([message]) => String(message).includes('idempotency'))).toBe(true);
    });

    it('still returns the answer when the key cannot be released either, and logs both', async () => {
      vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('redis: still down'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const res = await respondOnce(post('k5'), 'u', ROUTE, async () => created());

      expect(res.status).toBe(200);
      expect(warned.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('a handler that throws', () => {
    it('releases the key and rethrows the error of the handler', async () => {
      const failure = new Error('handler failed');
      const handler = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(created());

      await expect(respondOnce(post('k6'), 'u', ROUTE, handler)).rejects.toBe(failure);
      const again = await respondOnce(post('k6'), 'u', ROUTE, handler);

      expect(again.status).toBe(200);
    });

    it('rethrows the error of the handler, not the one of a release that failed', async () => {
      const failure = new Error('handler failed');
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('redis: down'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(respondOnce(post('k7'), 'u', ROUTE, async () => Promise.reject(failure))).rejects.toBe(failure);
    });
  });

  describe('a body the caller already parsed', () => {
    it('fingerprints that body, so a request whose stream was read once still takes a key', async () => {
      const handler = vi.fn(async () => created());
      const request = post('k8', { uploadId: 'a' });
      await request.json();

      const first = await respondOnce(request, 'u', ROUTE, handler, { uploadId: 'a' });
      const second = post('k8', { uploadId: 'a' });
      await second.json();
      const repeat = await respondOnce(second, 'u', ROUTE, handler, { uploadId: 'a' });
      const other = post('k8', { uploadId: 'b' });
      await other.json();
      const reused = await respondOnce(other, 'u', ROUTE, handler, { uploadId: 'b' });

      expect(first.status).toBe(200);
      expect(repeat.headers.get('idempotent-replayed')).toBe('true');
      expect(reused.status).toBe(422);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
