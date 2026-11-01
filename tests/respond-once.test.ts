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

const KEEP_LOCK = { afterFailedRecord: 'keep-lock' } as const;
const RELEASE = { afterFailedRecord: 'release' } as const;

describe('respondOnce', () => {
  it('runs the handler on every request that has no key', async () => {
    const handler = vi.fn(async () => created());

    await respondOnce(post(undefined), 'u', ROUTE, handler, KEEP_LOCK);
    await respondOnce(post(undefined), 'u', ROUTE, handler, KEEP_LOCK);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('answers a repeat with the first answer and marks it replayed', async () => {
    const handler = vi.fn(async () => created());

    await respondOnce(post('k1'), 'u', ROUTE, handler, KEEP_LOCK);
    const repeat = await respondOnce(post('k1'), 'u', ROUTE, handler, KEEP_LOCK);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect((await repeat.json()).key).toBe('uploads/a');
  });

  it('replays a 204 answer, which has no body, without throwing', async () => {
    const handler = vi.fn(async () => new NextResponse(null, { status: 204 }));

    const first = await respondOnce(post('k204'), 'u', ROUTE, handler, KEEP_LOCK);
    const repeat = await respondOnce(post('k204'), 'u', ROUTE, handler, KEEP_LOCK);

    expect(first.status).toBe(204);
    expect(repeat.status).toBe(204);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('answers a repeat that meets the first one still running with 409 and Retry-After', async () => {
    let finish: (res: Response) => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const first = respondOnce(
      post('slow'),
      'u',
      ROUTE,
      () => {
        started();
        return new Promise<Response>((resolve) => (finish = resolve));
      },
      KEEP_LOCK
    );
    await running;

    const repeat = await respondOnce(post('slow'), 'u', ROUTE, async () => created(), KEEP_LOCK);

    expect(repeat.status).toBe(409);
    expect(repeat.headers.get('retry-after')).not.toBeNull();
    expect((await repeat.json()).type).toBe(IN_FLIGHT_TYPE);
    finish(created());
    await first;
  });

  it('refuses a key that was used with another request body', async () => {
    await respondOnce(post('k2', { uploadId: 'a' }), 'u', ROUTE, async () => created(), KEEP_LOCK);

    const other = await respondOnce(post('k2', { uploadId: 'b' }), 'u', ROUTE, async () => created(), KEEP_LOCK);

    expect(other.status).toBe(422);
    expect((await other.json()).type).toBe(REUSED_TYPE);
  });

  it('keeps nothing of a refusal, so the same request may be sent again', async () => {
    const handler = vi.fn().mockResolvedValueOnce(NextResponse.json({ error: 'busy' }, { status: 429 })).mockResolvedValueOnce(created());

    const refused = await respondOnce(post('k3'), 'u', ROUTE, handler, KEEP_LOCK);
    const again = await respondOnce(post('k3'), 'u', ROUTE, handler, KEEP_LOCK);

    expect(refused.status).toBe(429);
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBeNull();
  });

  describe('a store that cannot record the answer', () => {
    it('returns the answer of the handler and releases the key when the action is one whose repeat answers from its state', async () => {
      vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis: connection reset'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = vi.fn(async () => created());

      const first = await respondOnce(post('k4'), 'u', ROUTE, handler, RELEASE);
      const repeat = await respondOnce(post('k4'), 'u', ROUTE, handler, RELEASE);

      expect(first.status).toBe(200);
      expect(repeat.status).not.toBe(409);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(warned.mock.calls.some(([message]) => String(message).includes('idempotency'))).toBe(true);
    });

    it('keeps the lock when the action creates something, so a repeat is told 409 and does not run it a second time while the lock lasts', async () => {
      vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis: connection reset'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = vi.fn(async () => created());

      const first = await respondOnce(post('k9'), 'u', ROUTE, handler, KEEP_LOCK);
      const repeat = await respondOnce(post('k9'), 'u', ROUTE, handler, KEEP_LOCK);

      expect(first.status).toBe(200);
      expect(repeat.status).toBe(409);
      expect(repeat.headers.get('retry-after')).not.toBeNull();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lets a lock that was kept end after its minute, as before', async () => {
      let now = 1_000_000;
      store.setClock(() => now);
      vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis: connection reset'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = vi.fn(async () => created());

      await respondOnce(post('k10'), 'u', ROUTE, handler, KEEP_LOCK);
      now += 61_000;
      const repeat = await respondOnce(post('k10'), 'u', ROUTE, handler, KEEP_LOCK);

      expect(repeat.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('leaves a recorded answer in place when only the reply of the store was lost, so the repeat is a replay', async () => {
      const recorded = store.complete.bind(store);
      vi.spyOn(store, 'complete').mockImplementation(async (...args) => {
        await recorded(...args);
        throw new Error('redis: reply lost');
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = vi.fn(async () => created());

      await respondOnce(post('k11'), 'u', ROUTE, handler, RELEASE);
      const repeat = await respondOnce(post('k11'), 'u', ROUTE, handler, RELEASE);

      expect(repeat.headers.get('idempotent-replayed')).toBe('true');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('still returns the answer when the key cannot be released either, and logs both', async () => {
      vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis: connection reset'));
      vi.spyOn(store, 'releaseLock').mockRejectedValueOnce(new Error('redis: still down'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const res = await respondOnce(post('k5'), 'u', ROUTE, async () => created(), RELEASE);

      expect(res.status).toBe(200);
      expect(warned.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('sends the record again before it gives up, so a store that failed once keeps the replay', async () => {
      const recorded = store.complete.bind(store);
      const complete = vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('redis: connection reset')).mockImplementation(recorded);
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = vi.fn(async () => created());

      await respondOnce(post('k12'), 'u', ROUTE, handler, KEEP_LOCK);
      const repeat = await respondOnce(post('k12'), 'u', ROUTE, handler, KEEP_LOCK);

      expect(complete).toHaveBeenCalledTimes(2);
      expect(repeat.headers.get('idempotent-replayed')).toBe('true');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(warned).not.toHaveBeenCalled();
    });

    it('tries to record the answer three times and no more', async () => {
      const complete = vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis: down'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await respondOnce(post('k13'), 'u', ROUTE, async () => created(), RELEASE);

      expect(complete).toHaveBeenCalledTimes(3);
    });

    it('tells a repeat that meets the kept lock to try again in a second, whatever is left of the lock, since a longer wait lands it after the lock ended', async () => {
      let now = 1_000_000;
      store.setClock(() => now);
      vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis: connection reset'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await respondOnce(post('k14'), 'u', ROUTE, async () => created(), KEEP_LOCK);
      now += 20_000;
      const repeat = await respondOnce(post('k14'), 'u', ROUTE, async () => created(), KEEP_LOCK);

      expect(repeat.status).toBe(409);
      expect(repeat.headers.get('retry-after')).toBe('1');
    });

    it('tells a repeat that meets a running request to try again in a second, not when the lock would end', async () => {
      let finish: (res: Response) => void = () => undefined;
      let started: () => void = () => undefined;
      const running = new Promise<void>((resolve) => (started = resolve));
      const first = respondOnce(post('k15'), 'u', ROUTE, () => (started(), new Promise<Response>((resolve) => (finish = resolve))), KEEP_LOCK);
      await running;

      const repeat = await respondOnce(post('k15'), 'u', ROUTE, async () => created(), KEEP_LOCK);

      expect(repeat.headers.get('retry-after')).toBe('1');
      finish(created());
      await first;
    });
  });

  describe('a run that outlived its lock', () => {
    it('does not release the lock of the run that took the key after it', async () => {
      let now = 1_000_000;
      store.setClock(() => now);
      let finishFirst: (res: Response) => void = () => undefined;
      let started: () => void = () => undefined;
      const running = new Promise<void>((resolve) => (started = resolve));
      const first = respondOnce(post('k16'), 'u', ROUTE, () => (started(), new Promise<Response>((resolve) => (finishFirst = resolve))), KEEP_LOCK);
      await running;
      now += 61_000;
      let finishSecond: (res: Response) => void = () => undefined;
      const secondStarted = new Promise<void>((resolve) => {
        void respondOnce(post('k16'), 'u', ROUTE, () => (resolve(), new Promise<Response>((done) => (finishSecond = done))), KEEP_LOCK);
      });
      await secondStarted;

      finishFirst(NextResponse.json({ error: 'busy' }, { status: 429 }));
      await first;
      const third = await respondOnce(post('k16'), 'u', ROUTE, async () => created(), KEEP_LOCK);

      expect(third.status).toBe(409);
      finishSecond(created());
    });
  });

  describe('a handler that throws', () => {
    it('releases the key and rethrows the error of the handler', async () => {
      const failure = new Error('handler failed');
      const handler = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(created());

      await expect(respondOnce(post('k6'), 'u', ROUTE, handler, KEEP_LOCK)).rejects.toBe(failure);
      const again = await respondOnce(post('k6'), 'u', ROUTE, handler, KEEP_LOCK);

      expect(again.status).toBe(200);
    });

    it('rethrows the error of the handler, not the one of a release that failed', async () => {
      const failure = new Error('handler failed');
      vi.spyOn(store, 'releaseLock').mockRejectedValueOnce(new Error('redis: down'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(respondOnce(post('k7'), 'u', ROUTE, async () => Promise.reject(failure), KEEP_LOCK)).rejects.toBe(failure);
    });
  });

  describe('a body the caller already parsed', () => {
    it('fingerprints that body, so a request whose stream was read once still takes a key', async () => {
      const handler = vi.fn(async () => created());
      const request = post('k8', { uploadId: 'a' });
      await request.json();

      const first = await respondOnce(request, 'u', ROUTE, handler, { parsedBody: { uploadId: 'a' }, ...KEEP_LOCK });
      const second = post('k8', { uploadId: 'a' });
      await second.json();
      const repeat = await respondOnce(second, 'u', ROUTE, handler, { parsedBody: { uploadId: 'a' }, ...KEEP_LOCK });
      const other = post('k8', { uploadId: 'b' });
      await other.json();
      const reused = await respondOnce(other, 'u', ROUTE, handler, { parsedBody: { uploadId: 'b' }, ...KEEP_LOCK });

      expect(first.status).toBe(200);
      expect(repeat.headers.get('idempotent-replayed')).toBe('true');
      expect(reused.status).toBe(422);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
