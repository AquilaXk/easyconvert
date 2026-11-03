import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BusyHostError, HostPacer, hostPacer, retryDelayMs, retryPaced } from '../bench/http-retry';
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
    expect(retryDelayMs(0, 429, 'Mon, 02 Nov 2026 23:59:60 GMT', Date.parse('2026-11-02T23:59:00Z'))).toBe(60_000);
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


const LISTED = 'listed.example';
const SPACING_MS = 3000;
const listedSpacing: ReadonlyMap<string, number> = new Map([[LISTED, SPACING_MS]]);
const fail = (message: string): Error => new Error(message);
const refusal = (status: number, retryAfter: string | null, refusedBy: string): BusyHostError => new BusyHostError(`HTTP ${status}`, status, retryAfter, refusedBy);

/** One request to `host` through the pacer: it resolves with the instant it was released. */
const request = (pacer: HostPacer, clock: { now(): number }, host: string): Promise<number> => pacer.run(host, async () => clock.now() - NOW);

describe('spacing the requests to one host', () => {
  it('spaces only the hosts of the table, the storage host of the newspaper pages at its published 150 requests a minute', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock);
    const sent = [request(pacer, clock, 'tile.loc.gov'), request(pacer, clock, 'tile.loc.gov'), request(pacer, clock, 'digitalcorpora.s3.amazonaws.com'), request(pacer, clock, 'digitalcorpora.s3.amazonaws.com')];
    await run();
    expect(await Promise.all(sent)).toEqual([0, 400, 0, 0]);
  });

  it('spaces a listed host from its first request, so a refusal does not let the next request leave early', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock, listedSpacing);
    const released: Record<string, number> = {};
    const first = pacer.run(LISTED, async () => {
      released.first = clock.now() - NOW;
      await clock.sleep(200);
    });
    const refused = clock.sleep(100).then(() =>
      retryPaced(
        `https://${LISTED}/refused`,
        0,
        async () => {
          released.refused = clock.now() - NOW;
          await clock.sleep(200);
          throw refusal(503, null, LISTED);
        },
        fail,
        { pacer }
      ).catch(() => undefined)
    );
    const third = clock.sleep(350).then(() => request(pacer, clock, LISTED));
    await run();
    await Promise.all([first, refused]);
    released.third = await third;
    expect(released).toEqual({ first: 0, refused: SPACING_MS, third: 2 * SPACING_MS });
  });

  it('holds a host without a published limit only for the time its refusal asked, then lets every waiting request go', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock);
    pacer.pause('a.example', 30_000);
    const sent = [0, 1, 2].map(() => request(pacer, clock, 'a.example'));
    const other = request(pacer, clock, 'b.example');
    await run();
    expect(await Promise.all(sent)).toEqual([30_000, 30_000, 30_000]);
    expect(await other).toBe(0);
  });

  it('keeps the requests already waiting back through a block that is renewed, and keeps the longer of two blocks', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock, listedSpacing);
    pacer.pause(LISTED, 30_000);
    const sent = [0, 1, 2].map(() => request(pacer, clock, LISTED));
    void clock.sleep(10_000).then(() => {
      pacer.pause(LISTED, 60_000);
      pacer.pause(LISTED, 5000);
    });
    await run();
    expect(await Promise.all(sent)).toEqual([70_000, 70_000 + SPACING_MS, 70_000 + 2 * SPACING_MS]);
  });

  it('refuses at once, without sending, every request to a host whose block runs past the bound, the queued ones too', async () => {
    const { clock, run } = virtualClock();
    const pacer = new HostPacer(clock, listedSpacing);
    let sent = 0;
    const send = (): Promise<string> =>
      pacer
        .run(LISTED, async () => {
          sent += 1;
          return 'sent';
        })
        .catch((error: Error) => `${error.name} at ${clock.now() - NOW}`);
    const queued = [send(), send(), send()];
    pacer.pause(LISTED, 3_600_000);
    const later = send();
    await run();
    expect(await Promise.all([...queued, later])).toEqual(['sent', 'RetryAfterTooLongError at 0', 'RetryAfterTooLongError at 0', 'RetryAfterTooLongError at 0']);
    expect(sent).toBe(1);
  });
});

/** `workers` workers that download `files` files from `host` through the retry loop, each request taking `latencyMs`; `answer` decides each response. */
async function downloadAll(options: {
  host: string;
  files: number;
  workers: number;
  latencyMs: number;
  spacing?: ReadonlyMap<string, number>;
  answer: (now: number) => BusyHostError | null;
}): Promise<{ totalMs: number; releases: number[]; failed: number }> {
  const { clock, run, elapsed } = virtualClock();
  const pacer = new HostPacer(clock, options.spacing);
  const releases: number[] = [];
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < options.files) {
      next += 1;
      await retryPaced(
        `https://${options.host}/f${next}`,
        6,
        async () => {
          releases.push(elapsed());
          await clock.sleep(options.latencyMs);
          const refused = options.answer(clock.now());
          if (refused !== null) throw refused;
        },
        fail,
        { pacer }
      ).catch(() => (failed += 1));
    }
  };
  const all = Promise.all(Array.from({ length: options.workers }, worker));
  await run();
  await all;
  return { totalMs: elapsed(), releases, failed };
}

describe('the downloads of a shard, through the retry loop of the fetchers', () => {
  it('costs the object-storage host only the wait of its one 503, not a spacing for every request after it', async () => {
    const shard = { host: 'digitalcorpora.s3.amazonaws.com', files: 840, workers: 8, latencyMs: 80 };
    const free = await downloadAll({ ...shard, answer: () => null });
    let refused = false;
    const once = await downloadAll({
      ...shard,
      answer: () => {
        if (refused) return null;
        refused = true;
        return refusal(503, null, shard.host);
      },
    });
    expect(free.totalMs).toBe((840 / 8) * 80);
    expect(once.failed).toBe(0);
    expect(once.releases).toHaveLength(841);
    expect(once.totalMs).toBeLessThanOrEqual(free.totalMs + retryDelayMs(0, 503, null) + shard.latencyMs);
  });

  it('never sends to a listed host faster than its spacing, from the first request on and with one download under way', async () => {
    const result = await downloadAll({ host: LISTED, files: 30, workers: 1, latencyMs: 200, spacing: listedSpacing, answer: () => null });
    const gaps = result.releases.slice(1).map((at, i) => at - result.releases[i]);
    expect(Math.min(...gaps)).toBe(SPACING_MS);
  });

  it('holds a request that arrives a millisecond after the last release for the rest of the spacing', async () => {
    const { clock, run, tick } = virtualClock();
    const pacer = new HostPacer(clock, listedSpacing);
    await request(pacer, clock, LISTED);
    tick(1);
    const second = request(pacer, clock, LISTED);
    await run();
    expect(await second).toBe(SPACING_MS);
  });

  it('waits on the host it reaches, which a remembered redirect makes another than the one in the address, and pauses both when that host refuses', async () => {
    const { clock, run } = virtualClock();
    const storage = LISTED;
    const pacer = new HostPacer(clock, listedSpacing);
    await request(pacer, clock, storage);
    let reachedAt = -1;
    const viaFront = retryPaced(
      'https://front.example/file',
      0,
      async () => {
        reachedAt = clock.now() - NOW;
        throw refusal(429, '30', storage);
      },
      fail,
      { pacer, contactedHost: () => storage }
    ).catch(() => undefined);
    await run();
    await viaFront;
    expect(reachedAt).toBe(SPACING_MS);
    const after = [request(pacer, clock, 'front.example'), request(pacer, clock, storage)];
    await run();
    expect(await Promise.all(after)).toEqual([SPACING_MS + 30_000, SPACING_MS + 30_000]);
  });

  it('fails every download of a host that asked for longer than a download waits at once, with one request sent in all', async () => {
    const { clock, run, elapsed } = virtualClock();
    const pacer = new HostPacer(clock);
    const sent: number[] = [];
    const outcomes: string[] = [];
    const downloads = (async () => {
      for (let id = 0; id < 6; id++) {
        await retryPaced(
          `https://blocking.example/s${id}`,
          6,
          async () => {
            sent.push(elapsed());
            throw refusal(429, '3600', 'blocking.example');
          },
          fail,
          { pacer }
        ).catch((error: Error) => outcomes.push(error.message));
      }
    })();
    await run();
    await downloads;
    expect(sent).toEqual([0]);
    expect(elapsed()).toBe(0);
    expect(outcomes).toHaveLength(6);
    for (const outcome of outcomes) expect(outcome).toMatch(/blocking\.example asked to be left alone for 3600 s, longer than the 120 s a download waits/);
  });

  describe('eight workers on a host that allows 20 requests a minute and blocks for two minutes, restarting the block at every request made during it', () => {
    function limitedHost(): { answer: (now: number) => BusyHostError | null; refusals: () => number } {
      const arrivals: number[] = [];
      let blockedUntil = 0;
      let refusals = 0;
      return {
        refusals: () => refusals,
        answer(now) {
          arrivals.push(now);
          while (arrivals[0] <= now - 60_000) arrivals.shift();
          if (now >= blockedUntil && arrivals.length <= 20) return null;
          blockedUntil = now + 120_000;
          refusals += 1;
          return refusal(429, '120', LISTED);
        },
      };
    }
    const shard = { host: LISTED, files: 100, workers: 8, latencyMs: 200 };

    it('is never refused when its published limit is in the table, and loses no download', async () => {
      const host = limitedHost();
      const result = await downloadAll({ ...shard, spacing: listedSpacing, answer: host.answer });
      expect(host.refusals()).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.totalMs).toBe(99 * SPACING_MS + shard.latencyMs);
    });

    it('is refused when its limit is not in the table, which is what the table is for', async () => {
      const host = limitedHost();
      await downloadAll({ ...shard, answer: host.answer });
      expect(host.refusals()).toBeGreaterThanOrEqual(1);
    });
  });
});

/** Resolves once the retry loop has taken note of the refusal that ended the first `run` of the shared pacer, so the test does not guess how long the client needs to read it. */
async function refusalNoted(firstRun: Promise<unknown>): Promise<void> {
  await firstRun.catch(() => undefined);
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
