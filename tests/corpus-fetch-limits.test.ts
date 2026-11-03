import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BusyHostError, HostPacer, hostPacer, LIMITED_HOST_GAP_MS, retryDelayMs, retryPaced } from '../bench/http-retry';
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

  it('counts a leap second the same wherever it falls in the day, and refuses a second above it', () => {
    expect(retryDelayMs(0, 429, 'Mon, 02 Nov 2026 10:00:60 GMT', NOW)).toBe(60_000);
    expect(retryDelayMs(0, 429, 'Mon, 02 Nov 2026 23:59:60 GMT', NOW)).toBe(120_000);
    expect(retryDelayMs(0, 429, 'Mon, 02 Nov 2026 10:00:61 GMT', NOW)).toBe(30_000);
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
  const refusal = (retryAfter: string, refusedBy: string = HOST): BusyHostError => new BusyHostError('HTTP 429', 429, retryAfter, refusedBy);

  /** One request to `host` through the pacer: it resolves with the instant it was released, or ends in the refusal it was given. */
  function request(pacer: HostPacer, clock: { now(): number }, host: string, refused?: BusyHostError): Promise<number> {
    return pacer.run(host, async () => {
      if (refused !== undefined) throw refused;
      return clock.now();
    });
  }
  const refuse = (pacer: HostPacer, clock: { now(): number }, retryAfter: string, host: string = HOST): Promise<unknown> => request(pacer, clock, host, refusal(retryAfter)).catch(() => undefined);

  it('does not delay a host that has not refused', async () => {
    const { clock, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    await request(pacer, clock, HOST);
    await request(pacer, clock, HOST);
    expect(elapsed()).toBe(0);
  });

  it('holds a request to a host that refused until the time it asked for has passed', async () => {
    const { clock, run, tick } = virtualClock();
    const pacer = new HostPacer(clock);
    await refuse(pacer, clock, '30');
    tick(5000);
    const sent = request(pacer, clock, HOST).then((at) => at - NOW);
    await run();
    expect(await sent).toBe(30_000);
  });

  it('lets one request go per gap, so requests that wait together do not leave together', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock);
    await refuse(pacer, clock, '30');
    const sent = [0, 1, 2].map(() => request(pacer, clock, HOST).then((at) => at - NOW));
    await run();
    expect(await Promise.all(sent)).toEqual([30_000, 30_000 + LIMITED_HOST_GAP_MS, 30_000 + 2 * LIMITED_HOST_GAP_MS]);
  });

  it('keeps the requests already waiting back through a cooldown that is renewed, because the host restarts its block at every request it gets', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock);
    await refuse(pacer, clock, '60');
    const sent = [0, 1, 2, 3].map((caller) => (caller === 0 ? request(pacer, clock, HOST, refusal('60')).catch(() => clock.now()) : request(pacer, clock, HOST)));
    await run();
    expect((await Promise.all(sent)).map((at) => at - NOW)).toEqual([60_000, 120_000, 120_000 + LIMITED_HOST_GAP_MS, 120_000 + 2 * LIMITED_HOST_GAP_MS]);
  });

  it('forgets a refusal whose wait has passed when nothing was released since, so a host that refused once is not spaced', async () => {
    const { clock, tick, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    await refuse(pacer, clock, '1');
    tick(2001);
    await request(pacer, clock, HOST);
    await request(pacer, clock, HOST);
    expect(elapsed()).toBe(2001);
  });

  it('keeps the gap after the queue has emptied, and drops it only after a quiet period longer than the gap', async () => {
    const { clock, run, tick } = virtualClock();
    const pacer = new HostPacer(clock);
    await refuse(pacer, clock, '30');
    const first = request(pacer, clock, HOST).then((at) => at - NOW);
    await run();
    expect(await first).toBe(30_000);
    tick(1);
    const soon = request(pacer, clock, HOST).then((at) => at - NOW);
    await run();
    expect(await soon).toBe(30_000 + LIMITED_HOST_GAP_MS);
    tick(LIMITED_HOST_GAP_MS + 1);
    const quiet = [await request(pacer, clock, HOST), await request(pacer, clock, HOST)];
    expect(quiet[1] - quiet[0]).toBe(0);
  });

  it('leaves other hosts alone, and keeps the longer of two cooldowns', async () => {
    const { clock, run, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    await Promise.all([refuse(pacer, clock, '20'), refuse(pacer, clock, '5')]);
    await request(pacer, clock, 'b.example');
    expect(elapsed()).toBe(0);
    const sent = request(pacer, clock, HOST).then((at) => at - NOW);
    await run();
    expect(await sent).toBe(20_000);
  });

  it('pauses the host that refused as well as the host the download was addressed to', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock);
    await request(pacer, clock, 'front.example', refusal('30', 'files.example')).catch(() => undefined);
    const sent = ['front.example', 'files.example'].map((host) => request(pacer, clock, host).then((at) => at - NOW));
    await run();
    expect(await Promise.all(sent)).toEqual([30_000, 30_000]);
  });
});

describe('the downloads to a host that refused, through the retry loop of the fetchers', () => {
  const HOST = 'limited.example';
  const fail = (message: string): Error => new Error(message);

  it('never sends faster than the gap, however many of its responses were good and even when only one download is under way', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock);
    const releases: number[] = [];
    const downloads = (async () => {
      for (let id = 0; id < 30; id++) {
        await retryPaced(
          `https://${HOST}/f${id}`,
          6,
          async () => {
            releases.push(clock.now());
            await clock.sleep(200);
            if (releases.length === 1) throw new BusyHostError('HTTP 429', 429, '1', HOST);
          },
          fail,
          pacer
        );
      }
    })();
    await run();
    await downloads;
    expect(releases).toHaveLength(31);
    const gaps = releases.slice(1).map((at, i) => at - releases[i]);
    expect(Math.min(...gaps.slice(1))).toBeGreaterThanOrEqual(LIMITED_HOST_GAP_MS);
  });

  it('holds a request that arrives a millisecond after the last release for the rest of the gap', async () => {
    const { clock, run, tick } = virtualClock();
    const pacer = new HostPacer(clock);
    const releases: number[] = [];
    const task = async (): Promise<void> => {
      releases.push(clock.now());
      if (releases.length === 1) throw new BusyHostError('HTTP 429', 429, '1', HOST);
    };
    const first = retryPaced(`https://${HOST}/a`, 6, task, fail, pacer);
    await run();
    await first;
    tick(1);
    const second = retryPaced(`https://${HOST}/b`, 6, task, fail, pacer);
    await run();
    await second;
    expect(releases).toHaveLength(3);
    expect(releases[2] - releases[1]).toBe(LIMITED_HOST_GAP_MS);
  });

  it('fails a download at once when the host asks for longer than a download waits, instead of retrying inside the block', async () => {
    const { clock, run, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    let calls = 0;
    const download = retryPaced(
      `https://${HOST}/file`,
      6,
      async () => {
        calls += 1;
        throw new BusyHostError('HTTP 429', 429, '3600', HOST);
      },
      fail,
      pacer
    );
    const outcome = download.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await run();
    expect(await outcome).toMatch(/3600 s.*120 s/);
    expect(calls).toBe(1);
    expect(elapsed()).toBe(0);
  });

  it('costs eight workers the cooldown and the published spacing of the downloads that follow, not more', async () => {
    const FILES = 100;
    const WORKERS = 8;
    async function download(refuseFirst: boolean): Promise<{ total: number; releases: number[] }> {
      const { clock, run, elapsed } = virtualClock();
      const pacer = new HostPacer(clock);
      const releases: number[] = [];
      let next = 0;
      let refused = !refuseFirst;
      const worker = async (): Promise<void> => {
        while (next < FILES) {
          next += 1;
          await retryPaced(
            `https://${HOST}/f${next}`,
            6,
            async () => {
              releases.push(elapsed());
              await clock.sleep(200);
              if (!refused) {
                refused = true;
                throw new BusyHostError('HTTP 429', 429, '30', HOST);
              }
            },
            fail,
            pacer
          );
        }
      };
      const all = Promise.all(Array.from({ length: WORKERS }, worker));
      await run();
      await all;
      return { total: elapsed(), releases };
    }
    const free = await download(false);
    const refusedOnce = await download(true);
    expect(free.total).toBeLessThan(3000);
    expect(refusedOnce.total).toBeLessThanOrEqual(30_000 + (FILES + WORKERS) * LIMITED_HOST_GAP_MS);
    const afterRefusal = refusedOnce.releases.filter((at) => at > 200);
    expect(Math.min(...afterRefusal.slice(1).map((at, i) => at - afterRefusal[i]))).toBeGreaterThanOrEqual(LIMITED_HOST_GAP_MS);
  });

  describe('eight workers on a host that allows 20 requests a minute and restarts its block at every request made during it', () => {
    async function simulate(limitPerMinute: number, files: number): Promise<{ refusals: number; failed: number; total: number; pacedGaps: number[] }> {
      const { clock, run, elapsed } = virtualClock();
      const pacer = new HostPacer(clock);
      const arrivals: number[] = [];
      const releases: number[] = [];
      let blockedUntil = 0;
      let firstRefusalAt = Number.POSITIVE_INFINITY;
      let refusals = 0;
      let failed = 0;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < files) {
          next += 1;
          try {
            await retryPaced(
              `https://${HOST}/f${next}`,
              6,
              async () => {
                releases.push(clock.now());
                await clock.sleep(200);
                const now = clock.now();
                arrivals.push(now);
                while (arrivals[0] <= now - 60_000) arrivals.shift();
                if (now < blockedUntil || arrivals.length > limitPerMinute) {
                  blockedUntil = now + 120_000;
                  refusals += 1;
                  firstRefusalAt = Math.min(firstRefusalAt, now);
                  throw new BusyHostError('HTTP 429', 429, '120', HOST);
                }
              },
              fail,
              pacer
            );
          } catch {
            failed += 1;
          }
        }
      };
      const all = Promise.all(Array.from({ length: 8 }, worker));
      await run();
      await all;
      const paced = releases.filter((at) => at > firstRefusalAt);
      return { refusals, failed, total: elapsed(), pacedGaps: paced.slice(1).map((at, i) => at - paced[i]) };
    }

    it('sends nothing closer than the published spacing once the host has refused, and loses no download', async () => {
      const { refusals, failed, pacedGaps } = await simulate(20, 100);
      expect(failed).toBe(0);
      expect(refusals).toBeLessThanOrEqual(8);
      expect(Math.min(...pacedGaps)).toBeGreaterThanOrEqual(LIMITED_HOST_GAP_MS);
    });
  });
});

/** Resolves once the shared pacer has taken note of the first refusal of a download, so the test does not guess how long the client needs to read it. */
async function refusalNoted(firstRun: unknown): Promise<void> {
  await (firstRun as Promise<unknown>).catch(() => undefined);
}

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
  afterEach(() => vi.restoreAllMocks());

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
    const runs = vi.spyOn(hostPacer, 'run');
    const first = fetchBytes(`${base}/limited`, null, 100);
    await refusalSeen;
    await refusalNoted(runs.mock.results[0].value);
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
    const runs = vi.spyOn(hostPacer, 'run');
    const viaFront = fetchBytes(`${front}/start`, null, 100);
    await refusalSeen;
    await refusalNoted(runs.mock.results[0].value);
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
