import type Redis from 'ioredis';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/tools/web-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/tools/web-tools')>();
  return { ...actual, runWebTool: vi.fn(actual.runWebTool) };
});

import { POST as mergeRoute } from '../src/app/api/tools/merge/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { acquireSyncSlot, type ConversionSlot } from '../src/lib/queue/concurrency-limit';
import { ANONYMOUS_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import { runWebTool } from '../src/lib/tools/web-tools';

/** A run that is stopped (a disconnect, a deadline) while its work cannot stop keeps its concurrency slot until the work ends. */

const SLOTS = 5;
const HTTP_CLIENT_CLOSED_REQUEST = 499;

async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 300]);
  return Buffer.from(await doc.save());
}

let redisClients: { keys: Redis | null; users: Redis | null };

beforeEach(() => {
  redisClients = { keys: redisKeyStore.getRedisClient(), users: redisUserStore.getRedisClient() };
  redisKeyStore.setRedisClient(null);
  redisUserStore.setRedisClient(null);
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(ANONYMOUS_DAILY_CONVERSIONS));
  redisKeyStore.resetStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(runWebTool).mockReset();
  redisKeyStore.setRedisClient(redisClients.keys);
  redisUserStore.setRedisClient(redisClients.users);
});

describe('a run stopped before its work ends', () => {
  it('keeps its slot until the work settles, and gives the conversion back at once', async () => {
    const ip = '198.51.100.200';
    const userId = anonymousUserId(ip);
    const before = (await redisKeyStore.getQuotaUsage(userId)).remaining;
    let finish: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(runWebTool).mockImplementationOnce(() => new Promise((resolve) => {
      started();
      finish = () => resolve({ kind: 'file', filename: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') });
    }));
    const held: ConversionSlot[] = [];
    for (let i = 0; i < SLOTS - 1; i++) held.push(await acquireSyncSlot(userId, 'anonymous'));

    const abort = new AbortController();
    const form = new FormData();
    form.append('files', new File([new Uint8Array(await pdf())], 'a.pdf'));
    form.append('files', new File([new Uint8Array(await pdf())], 'b.pdf'));
    const answer = mergeRoute(new NextRequest('http://localhost/api/tools/merge', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: form, signal: abort.signal }));
    await running;
    abort.abort();
    const res = await answer;

    expect(res.status).toBe(HTTP_CLIENT_CLOSED_REQUEST);
    expect((await redisKeyStore.getQuotaUsage(userId)).remaining).toBe(before);
    const blocked = await acquireSyncSlot(userId, 'anonymous');
    expect(blocked.granted).toBe(false);

    finish();
    await vi.waitFor(async () => {
      const freed = await acquireSyncSlot(userId, 'anonymous');
      expect(freed.granted).toBe(true);
      if (freed.granted) freed.release();
    });
    held.forEach((slot) => slot.granted && slot.release());
  });
});
