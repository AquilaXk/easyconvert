import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostPacer, LIMITED_HOST_GAP_MS, retryDelayMs } from '../bench/http-retry';
import { DigestMismatchError, ensureCached, findCached } from '../bench/realworld/fetch';
import { fetchBytes, fetchSize } from '../bench/realworld/http';
import type { CorpusFile } from '../bench/realworld/manifest';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const httpDate = (secondsAhead: number): string => new Date(NOW + secondsAhead * 1000).toUTCString();

describe('the pause a host asks for with Retry-After', () => {
  it('reads the HTTP-date forms as the time left until then, as RFC 9110 allows', () => {
    expect(retryDelayMs(0, 429, httpDate(45), NOW)).toBe(45_000);
    expect(retryDelayMs(0, 503, httpDate(10), NOW)).toBe(10_000);
    expect(retryDelayMs(0, 429, 'Monday, 02-Nov-26 10:00:45 GMT', NOW)).toBe(45_000);
    expect(retryDelayMs(0, 429, 'Mon Nov  2 10:00:45 2026', NOW)).toBe(45_000);
    expect(retryDelayMs(0, 429, 'Mon Nov 12 10:00:45 2026', NOW)).toBe(120_000);
  });

  it('bounds a date far ahead, and gives a 503 whose date is past only the ordinary pause', () => {
    expect(retryDelayMs(0, 429, httpDate(86_400), NOW)).toBe(120_000);
    expect(retryDelayMs(0, 503, httpDate(-60), NOW)).toBe(2000);
    expect(retryDelayMs(1, 503, httpDate(-60), NOW)).toBe(4000);
  });

  it('gives a rate limit that names no usable time the default pause: a date already past, zero seconds, and every value that is not seconds or an HTTP date', () => {
    for (const value of [httpDate(-60), '0', '00', '', 'soon', '0.5', '1,5', '3/4', 'retry later 5', '1 Nov', '-5', '5 seconds', 'Mon, 31 Feb 2026 10:00:00 GMT', 'Mon, 02 Nov 2026 25:00:00 GMT']) {
      expect(retryDelayMs(0, 429, value, NOW), JSON.stringify(value)).toBe(30_000);
    }
    expect(retryDelayMs(0, 503, '0.5', NOW)).toBe(2000);
  });
});

/** A clock that moves only when the test says so: sleepers wake in time order, as they would on a real one. */
function virtualClock() {
  let now = NOW;
  const timers: Array<{ at: number; wake: () => void }> = [];
  const clock = {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((wake) => timers.push({ at: now + ms, wake })),
  };
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return {
    clock,
    elapsed: (): number => now - NOW,
    tick(ms: number): void {
      now += ms;
    },
    async run(): Promise<void> {
      await settle();
      while (timers.length > 0) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        now = Math.max(now, next.at);
        next.wake();
        await settle();
      }
    },
  };
}

describe('spacing the requests to one host', () => {
  const HOST = 'a.example';

  it('does not delay a host that has not refused', async () => {
    const { clock, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    await pacer.beforeRequest(HOST);
    await pacer.beforeRequest(HOST);
    expect(elapsed()).toBe(0);
  });

  it('holds a request to a host that refused until the time it asked for has passed', async () => {
    const { clock, run, tick, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    pacer.noteBusy(HOST, 30_000);
    tick(5000);
    let sentAt = -1;
    const sent = pacer.beforeRequest(HOST).then(() => (sentAt = elapsed()));
    await run();
    await sent;
    expect(sentAt).toBe(30_000);
  });

  it('lets one request go per gap, so requests that wait together do not leave together', async () => {
    const { clock, run, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    pacer.noteBusy(HOST, 1000);
    const sentAt: number[] = [];
    const sent = [0, 1, 2].map(() => pacer.beforeRequest(HOST).then(() => sentAt.push(elapsed())));
    await run();
    await Promise.all(sent);
    expect(sentAt).toEqual([1000, 1000 + LIMITED_HOST_GAP_MS, 1000 + 2 * LIMITED_HOST_GAP_MS]);
  });

  it('keeps the requests already waiting back through a cooldown that is renewed, because the host restarts its block at every request it gets', async () => {
    const { clock, run, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    pacer.noteBusy(HOST, 60_000);
    const sentAt: number[] = [];
    const sent = [0, 1, 2, 3].map((caller) =>
      pacer.beforeRequest(HOST).then(() => {
        sentAt.push(elapsed());
        if (caller === 0) pacer.noteBusy(HOST, 60_000);
      })
    );
    await run();
    await Promise.all(sent);
    expect(sentAt).toEqual([60_000, 120_000, 120_000 + LIMITED_HOST_GAP_MS, 120_000 + 2 * LIMITED_HOST_GAP_MS]);
  });

  it('forgets a refusal once its wait has passed and nobody was waiting, so a host that refused once is not spaced', async () => {
    const { clock, tick, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    pacer.noteBusy(HOST, 1000);
    tick(1001);
    await pacer.beforeRequest(HOST);
    await pacer.beforeRequest(HOST);
    expect(elapsed()).toBe(1001);
  });

  it('leaves other hosts alone, and keeps the longer of two cooldowns', async () => {
    const { clock, run, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    pacer.noteBusy(HOST, 20_000);
    pacer.noteBusy(HOST, 5000);
    await pacer.beforeRequest('b.example');
    expect(elapsed()).toBe(0);
    const sent = pacer.beforeRequest(HOST).then(() => elapsed());
    await run();
    expect(await sent).toBe(20_000);
  });

  it('ignores the success of a request that left before the refusal, since it says nothing about the host afterwards', async () => {
    const { clock, run, tick, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    const earlier = await pacer.beforeRequest(HOST);
    tick(10);
    pacer.noteBusy(HOST, 1000);
    pacer.noteSuccess(HOST, earlier);
    const sentAt: number[] = [];
    const sent = [0, 1].map(() => pacer.beforeRequest(HOST).then(() => sentAt.push(elapsed())));
    await run();
    await Promise.all(sent);
    expect(sentAt[1] - sentAt[0]).toBe(LIMITED_HOST_GAP_MS);
  });

  describe('eight downloads in a row after one refusal', () => {
    const FILES = 840;
    const REQUEST_MS = 200;
    const WORKERS = 8;

    async function download(refusalWaitMs: number | null): Promise<{ total: number; sentAt: number[] }> {
      const { clock, run, elapsed } = virtualClock();
      const pacer = new HostPacer(clock);
      const sentAt: number[] = [];
      let next = 0;
      let refused = refusalWaitMs === null;
      const worker = async (): Promise<void> => {
        while (next < FILES) {
          next += 1;
          for (;;) {
            const startedAt = await pacer.beforeRequest(HOST);
            sentAt.push(elapsed());
            await clock.sleep(REQUEST_MS);
            if (!refused) {
              refused = true;
              pacer.noteBusy(HOST, refusalWaitMs ?? 0);
              continue;
            }
            pacer.noteSuccess(HOST, startedAt);
            break;
          }
        }
      };
      const all = Promise.all(Array.from({ length: WORKERS }, worker));
      await run();
      await all;
      return { total: elapsed(), sentAt };
    }

    it('costs the host its cooldown and a short spacing of the downloads that waited, not the rest of the run', async () => {
      const free = await download(null);
      const refusedOnce = await download(30_000);
      expect(free.total).toBeLessThan(25_000);
      expect(refusedOnce.total).toBeLessThan(30_000 + free.total + 10 * LIMITED_HOST_GAP_MS);
    });

    it('stops spacing: late in the run the requests leave faster than one per gap', async () => {
      const { sentAt } = await download(30_000);
      const late = sentAt.slice(-100);
      const gaps = late.slice(1).map((at, i) => at - late[i]);
      expect(Math.max(...gaps)).toBeLessThan(LIMITED_HOST_GAP_MS);
    });
  });
});

/** The server has sent the refusal when its handler runs; the client reads it a moment later, and only then does the host pause. */
const clientHasHeardTheRefusal = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

describe('a download from a host that limited its rate', () => {
  const servers: http.Server[] = [];
  const listen = async (handler: http.RequestListener): Promise<string> => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('holds a second download of the same host back for the time the first one was told to wait, whichever of them reaches the host first', async () => {
    const arrivals: Array<{ url: string | undefined; at: number }> = [];
    let refusals = 0;
    let refusedAt = 0;
    let seen!: () => void;
    const refusalSeen = new Promise<void>((resolve) => (seen = resolve));
    const base = await listen((request, response) => {
      arrivals.push({ url: request.url, at: Date.now() });
      if (request.url === '/limited' && refusals === 0) {
        refusals += 1;
        refusedAt = Date.now();
        response.writeHead(429, { 'retry-after': '2' }).end();
        seen();
      } else {
        response.writeHead(200, { 'content-length': 4 }).end('body');
      }
    });
    const first = fetchBytes(`${base}/limited`, null, 100);
    await refusalSeen;
    await clientHasHeardTheRefusal();
    const second = await fetchBytes(`${base}/other`, null, 100);
    expect(second.toString()).toBe('body');
    expect((await first).toString()).toBe('body');
    const other = arrivals.find((arrival) => arrival.url === '/other');
    expect(other!.at - refusedAt).toBeGreaterThanOrEqual(1900);
  }, 30_000);

  it('pauses the host that refused, not the one the download was addressed to, when a redirect led from one to the other', async () => {
    const arrivals: Array<{ url: string | undefined; at: number }> = [];
    let refusedAt = 0;
    let seen!: () => void;
    const refusalSeen = new Promise<void>((resolve) => (seen = resolve));
    const refusing = await listen((request, response) => {
      arrivals.push({ url: request.url, at: Date.now() });
      if (request.url === '/file' && refusedAt === 0) {
        refusedAt = Date.now();
        response.writeHead(429, { 'retry-after': '2' }).end();
        seen();
      } else {
        response.writeHead(200, { 'content-length': 4 }).end('body');
      }
    });
    const front = await listen((_request, response) => response.writeHead(302, { location: `${refusing}/file` }).end());
    const viaFront = fetchBytes(`${front}/start`, null, 100);
    await refusalSeen;
    await clientHasHeardTheRefusal();
    const direct = await fetchBytes(`${refusing}/direct`, null, 100);
    expect(direct.toString()).toBe('body');
    expect((await viaFront).toString()).toBe('body');
    const reached = arrivals.find((arrival) => arrival.url === '/direct');
    expect(reached!.at - refusedAt).toBeGreaterThanOrEqual(1900);
  }, 30_000);

  it('reads the Retry-After of a rate limit that answers a size probe, as it does for a body', async () => {
    const arrivals: number[] = [];
    const base = await listen((_request, response) => {
      arrivals.push(Date.now());
      if (arrivals.length === 1) response.writeHead(429, { 'retry-after': '3' }).end();
      else response.writeHead(206, { 'content-range': 'bytes 0-0/1234', 'content-length': 1 }).end('x');
    });
    expect(await fetchSize(`${base}/archive.zip`)).toBe(1234);
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(2900);
  }, 30_000);
});

describe('a corpus file whose bytes are not the pinned ones', () => {
  let server: http.Server;
  let dir: string;
  let url: string;
  const body = Buffer.from('the pinned bytes');
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const file = (sha256: string): CorpusFile => ({ id: 'sample.bin', source: 's', origin: { kind: 'file', url }, format: 'bin', size: body.length, sha256 }) as CorpusFile;

  beforeAll(async () => {
    server = http.createServer((_request, response) => response.writeHead(200, { 'content-length': body.length }).end(body));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sample.bin`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-limits-'));
  });
  afterAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is refused before anything is written, and a stale cached copy is never accepted', async () => {
    const cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, 'sample.bin'), 'stale');
    const wrong = file(digest(Buffer.from('other bytes')));
    await expect(ensureCached(wrong, cacheDir)).rejects.toBeInstanceOf(DigestMismatchError);
    expect(fs.readdirSync(cacheDir).sort()).toEqual(['sample.bin']);
    expect(fs.readFileSync(path.join(cacheDir, 'sample.bin'), 'utf8')).toBe('stale');
    expect(findCached(wrong, cacheDir)).toBeUndefined();
  });

  it('is kept once the bytes match, atomically and without a partial file', async () => {
    const cacheDir = path.join(dir, 'cache-ok');
    const target = await ensureCached(file(digest(body)), cacheDir);
    expect(fs.readFileSync(target)).toEqual(body);
    expect(fs.readdirSync(cacheDir)).toEqual(['sample.bin']);
  });
});
