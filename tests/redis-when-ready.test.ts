import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import {
  REDIS_READY_WAIT_MS,
  REDIS_UNREACHABLE_HOLD_MS,
  readyGatedRedis,
  whenReady,
} from '../src/lib/redis/when-ready';

const SRC_DIR = path.join(__dirname, '..', 'src');
const UNREACHABLE_CHECK_MARGIN_MS = 1_000;
const HELD_CALL_LIMIT_MS = 250;
const UNREACHABLE_TEST_TIMEOUT_MS = 15_000;

/** A client that reports a status and records the commands it was asked to run. */
class FakeRedis extends EventEmitter {
  status = 'connecting';
  readonly sent: string[] = [];
  connect = vi.fn(async () => undefined);

  get(key: string): Promise<string> {
    if (this.status !== 'ready') return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    this.sent.push(`get ${key}`);
    return Promise.resolve('value');
  }

  becomeReady(): void {
    this.status = 'ready';
    this.emit('ready');
  }
}

function asRedis(client: FakeRedis): Redis {
  return client as unknown as Redis;
}

async function freeClosedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('whenReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves at once for a ready client', async () => {
    const client = new FakeRedis();
    client.status = 'ready';

    await expect(whenReady(asRedis(client))).resolves.toBeUndefined();
    expect(client.listenerCount('ready')).toBe(0);
  });

  it('resolves when the connection becomes ready, with one listener for any number of callers', async () => {
    const client = new FakeRedis();
    const waiting = Array.from({ length: 50 }, () => whenReady(asRedis(client)));
    expect(client.listenerCount('ready')).toBe(1);

    client.becomeReady();
    await Promise.all(waiting);

    expect(client.listenerCount('ready')).toBe(0);
  });

  it('starts a client that was built to connect lazily', async () => {
    const client = new FakeRedis();
    client.status = 'wait';

    const waiting = whenReady(asRedis(client));
    client.becomeReady();
    await waiting;

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('gives up after the wait, then lets calls through for the hold period without waiting again', async () => {
    const client = new FakeRedis();

    const first = whenReady(asRedis(client));
    await vi.advanceTimersByTimeAsync(REDIS_READY_WAIT_MS);
    await first;
    expect(client.listenerCount('ready')).toBe(0);

    await expect(whenReady(asRedis(client))).resolves.toBeUndefined();
    expect(client.listenerCount('ready')).toBe(0);

    await vi.advanceTimersByTimeAsync(REDIS_UNREACHABLE_HOLD_MS);
    const again = whenReady(asRedis(client));
    expect(client.listenerCount('ready')).toBe(1);
    client.becomeReady();
    await again;
  });

  it('does not wait on a closed client', async () => {
    const client = new FakeRedis();
    client.status = 'end';

    await expect(whenReady(asRedis(client))).resolves.toBeUndefined();
    expect(client.listenerCount('ready')).toBe(0);
  });
});

describe('readyGatedRedis', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a command until the connection is ready and then sends it', async () => {
    const client = new FakeRedis();
    const gated = readyGatedRedis(asRedis(client));

    const reply = gated.get('k');
    await vi.advanceTimersByTimeAsync(REDIS_READY_WAIT_MS - 1);
    expect(client.sent).toEqual([]);

    client.becomeReady();

    await expect(reply).resolves.toBe('value');
    expect(client.sent).toEqual(['get k']);
  });

  it('sends the command after the wait when the connection never comes, so it fails by itself', async () => {
    const client = new FakeRedis();
    const gated = readyGatedRedis(asRedis(client));

    const reply = gated.get('k');
    const outcome = expect(reply).rejects.toThrow('enableOfflineQueue');
    await vi.advanceTimersByTimeAsync(REDIS_READY_WAIT_MS);

    await outcome;
  });

  it('keeps a connection error from becoming an unhandled event', () => {
    const client = new FakeRedis();
    readyGatedRedis(asRedis(client));

    expect(client.emit('error', new Error('ECONNREFUSED'))).toBe(true);
    expect(client.listenerCount('error')).toBe(1);
  });

  it('logs each distinct connection error once, so a wrong password is visible without a flood', () => {
    const client = new FakeRedis();
    readyGatedRedis(asRedis(client));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      client.emit('error', new Error('WRONGPASS invalid username-password pair'));
      client.emit('error', new Error('WRONGPASS invalid username-password pair'));
      client.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));

      expect(warn.mock.calls.map((call) => call[1])).toEqual(['WRONGPASS invalid username-password pair', 'connect ECONNREFUSED 127.0.0.1:6379']);
    } finally {
      warn.mockRestore();
    }
  });

  it('ends the hold once the client is ready again, so a later short drop is waited for', async () => {
    const client = new FakeRedis();
    const gated = readyGatedRedis(asRedis(client));
    const first = expect(gated.get('k')).rejects.toThrow('enableOfflineQueue');
    await vi.advanceTimersByTimeAsync(REDIS_READY_WAIT_MS);
    await first;

    client.becomeReady();
    client.status = 'reconnecting';
    const reply = gated.get('k');
    await vi.advanceTimersByTimeAsync(10);
    client.becomeReady();

    await expect(reply).resolves.toBe('value');
  });

  it('leaves event methods and the connection state unwaited', () => {
    const client = new FakeRedis();
    const gated = readyGatedRedis(asRedis(client));
    const seen: string[] = [];

    gated.on('ready', () => seen.push('ready'));
    client.becomeReady();

    expect(seen).toEqual(['ready']);
    expect(gated.status).toBe('ready');
  });
});

describe('a store whose Redis is down', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'still fails within about the wait, and the next calls fail at once',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const port = await freeClosedPort();
      const store = new RedisKeyStore({ redisUrl: `redis://127.0.0.1:${port}`, isolated: true });

      const startedFirst = Date.now();
      const first = await store.checkTokenBucketRateLimit('client');
      const firstMs = Date.now() - startedFirst;

      const startedSecond = Date.now();
      const second = await store.checkTokenBucketRateLimit('client');
      const secondMs = Date.now() - startedSecond;
      await store.close();

      expect(first.serviceUnavailable).toBe(true);
      expect(first.allowed).toBe(false);
      expect(firstMs).toBeLessThan(REDIS_READY_WAIT_MS + UNREACHABLE_CHECK_MARGIN_MS);
      expect(second.serviceUnavailable).toBe(true);
      expect(secondMs).toBeLessThan(HELD_CALL_LIMIT_MS);
    },
    UNREACHABLE_TEST_TIMEOUT_MS
  );
});

describe('Redis clients without an offline queue', () => {
  /** Files that build such a client and wait for the connection on their own. */
  const OWN_CONNECTION_HANDLING = new Map<string, string>([
    ['lib/health/probes.ts', 'connects and awaits the connection before its single ping'],
    ['lib/queue/bullmq-engine.ts', 'waits for its own handshake before an enqueue (waitForRedisReady) and fails closed with QueueUnavailableError'],
  ]);

  it('are built through readyGatedRedis, so no command is sent before the connection is ready', () => {
    const ungated = sourceFiles(SRC_DIR)
      .filter((file) => /enableOfflineQueue:\s*false/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(SRC_DIR, file).split(path.sep).join('/'))
      .filter((file) => !OWN_CONNECTION_HANDLING.has(file))
      .filter((file) => !fs.readFileSync(path.join(SRC_DIR, file), 'utf-8').includes('readyGatedRedis('));

    expect(ungated).toEqual([]);
  });
});
