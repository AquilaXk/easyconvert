import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostPacer, LIMITED_HOST_GAP_MS, retryDelayMs } from '../bench/http-retry';
import { DigestMismatchError, ensureCached, findCached } from '../bench/realworld/fetch';
import { fetchBytes } from '../bench/realworld/http';
import type { CorpusFile } from '../bench/realworld/manifest';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const httpDate = (secondsAhead: number): string => new Date(NOW + secondsAhead * 1000).toUTCString();

describe('the pause a host asks for with Retry-After', () => {
  it('reads the HTTP-date form as the time left until then, as RFC 9110 allows', () => {
    expect(retryDelayMs(0, 429, httpDate(45), NOW)).toBe(45_000);
    expect(retryDelayMs(0, 503, httpDate(10), NOW)).toBe(10_000);
  });

  it('bounds a date far ahead, and treats a date already past as no extra wait', () => {
    expect(retryDelayMs(0, 429, httpDate(86_400), NOW)).toBe(120_000);
    expect(retryDelayMs(0, 503, httpDate(-60), NOW)).toBe(2000);
    expect(retryDelayMs(1, 503, httpDate(-60), NOW)).toBe(4000);
  });

  it('gives a rate limit whose Retry-After is neither seconds nor a date the default pause', () => {
    expect(retryDelayMs(0, 429, 'soon', NOW)).toBe(30_000);
    expect(retryDelayMs(0, 429, '', NOW)).toBe(30_000);
  });
});

describe('spacing the requests to one host', () => {
  const clock = (): { pacer: HostPacer; waits: number[]; advance: (ms: number) => void } => {
    let now = NOW;
    const waits: number[] = [];
    const pacer = new HostPacer({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    return { pacer, waits, advance: (ms) => (now += ms) };
  };

  it('does not delay a host that has not refused', async () => {
    const { pacer, waits } = clock();
    await pacer.beforeRequest('a.example');
    await pacer.beforeRequest('a.example');
    expect(waits).toEqual([]);
  });

  it('holds every request to a host that refused until the time it asked for has passed', async () => {
    const { pacer, waits, advance } = clock();
    pacer.noteBusy('a.example', 30_000);
    advance(5000);
    await pacer.beforeRequest('a.example');
    expect(waits).toEqual([25_000]);
  });

  it('then lets one request go per gap, so requests that wait together do not leave together', async () => {
    const { pacer, waits } = clock();
    pacer.noteBusy('a.example', 1000);
    await Promise.all([pacer.beforeRequest('a.example'), pacer.beforeRequest('a.example'), pacer.beforeRequest('a.example')]);
    expect(waits).toEqual([1000, 1000 + LIMITED_HOST_GAP_MS, 1000 + 2 * LIMITED_HOST_GAP_MS]);
  });

  it('forgets a refusal once its wait has passed, so a host that refused once is not spaced for the rest of the run', async () => {
    const { pacer, waits, advance } = clock();
    pacer.noteBusy('a.example', 1000);
    advance(1001);
    await pacer.beforeRequest('a.example');
    await pacer.beforeRequest('a.example');
    expect(waits).toEqual([]);
  });

  it('leaves other hosts alone, and keeps the longer of two cooldowns', async () => {
    const { pacer, waits } = clock();
    pacer.noteBusy('a.example', 20_000);
    pacer.noteBusy('a.example', 5000);
    await pacer.beforeRequest('b.example');
    expect(waits).toEqual([]);
    await pacer.beforeRequest('a.example');
    expect(waits).toEqual([20_000]);
  });
});

describe('a download from a host that limited its rate', () => {
  let server: http.Server;
  let base: string;
  const arrivals: Array<{ url: string | undefined; at: number }> = [];
  let limitedAt = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      arrivals.push({ url: request.url, at: Date.now() });
      if (request.url === '/limited' && arrivals.length === 1) {
        limitedAt = Date.now();
        response.writeHead(429, { 'retry-after': '2' }).end();
      } else {
        response.writeHead(200, { 'content-length': 4 }).end('body');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('holds a second download of the same host back for the time the first one was told to wait', async () => {
    const first = fetchBytes(`${base}/limited`, null, 100);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await fetchBytes(`${base}/other`, null, 100);
    expect(second.toString()).toBe('body');
    expect((await first).toString()).toBe('body');
    expect(arrivals).toHaveLength(3);
    const other = arrivals.find((arrival) => arrival.url === '/other');
    expect(other!.at - limitedAt).toBeGreaterThanOrEqual(1900);
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
