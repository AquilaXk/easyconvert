import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '../src/lib/config';
import { observeJob, observeRequest } from '../src/lib/metrics/instruments';
import { defaultMetricsPort, startMetricsFromConfig, startMetricsServer, type MetricsServer } from '../src/lib/metrics/server';
import { resetMetrics } from './helpers/metrics-readings';

/** The scrape endpoint: GET /metrics renders the registry, and nothing else on that port answers. */

const LOOPBACK = '127.0.0.1';
let server: MetricsServer | undefined;
let beforeScrape: (() => Promise<void>) | undefined;

const get = (path: string, method = 'GET') => fetch(`http://${LOOPBACK}:${server?.port}${path}`, { method });

beforeEach(async () => {
  resetMetrics();
  beforeScrape = undefined;
  server = await startMetricsServer({ port: 0, host: LOOPBACK, beforeScrape: () => beforeScrape?.() ?? Promise.resolve() });
});

afterEach(async () => {
  await server?.stop();
  vi.unstubAllEnvs();
  resetConfigCache();
  vi.restoreAllMocks();
});

describe('GET /metrics', () => {
  it('renders the text format with the counters and histograms that were recorded', async () => {
    observeRequest('convert', 'document', 'ok', 120);
    observeJob('image', 'failed', 3000);

    const res = await get('/metrics');
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(text).toContain('easyconvert_http_requests_total{route="convert",family="document",outcome="ok"} 1');
    expect(text).toContain('easyconvert_http_request_duration_seconds_bucket{le="0.25",route="convert",family="document",outcome="ok"} 1');
    expect(text).toContain('easyconvert_jobs_total{family="image",outcome="failed"} 1');
    expect(text).toContain('easyconvert_job_duration_seconds_count{family="image",outcome="failed"} 1');
  });

  it('includes the start time of the process, from which a restart is derived', async () => {
    const text = await (await get('/metrics')).text();

    expect(text).toMatch(/^process_start_time_seconds \d+$/m);
  });

  it('reads the values that live elsewhere just before it answers', async () => {
    const calls: string[] = [];
    beforeScrape = async () => {
      calls.push('sample');
    };

    await get('/metrics');
    await get('/metrics');

    expect(calls).toEqual(['sample', 'sample']);
  });

  it('answers 500 with no body when it cannot render, and keeps serving', async () => {
    beforeScrape = () => Promise.reject(new Error('redis://:s3cret@redis:6379 is down'));

    const failed = await get('/metrics');
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('');

    beforeScrape = undefined;
    expect((await get('/metrics')).status).toBe(200);
  });

  it.each(['/', '/api/metrics', '/metrics/extra', '/api/health', '/metricsx'])('serves nothing at %s', async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  it('takes only GET', async () => {
    const res = await get('/metrics', 'POST');

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('the listener', () => {
  it('binds to the address it was given, not to every address', async () => {
    const address = await new Promise<string>((resolve, reject) => {
      http.get(`http://${LOOPBACK}:${server?.port}/metrics`, (res) => resolve(res.socket.remoteAddress ?? '')).on('error', reject);
    });

    expect(address).toBe(LOOPBACK);
  });

  it('warns and gives up, instead of throwing, when its port is taken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const second = await startMetricsServer({ port: server?.port ?? 0, host: LOOPBACK });

    expect(second).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));
  });

  it('has a port apart from the web application and from the other process', () => {
    expect(defaultMetricsPort('web')).toBe(9464);
    expect(defaultMetricsPort('worker')).toBe(9465);
  });

  it('is not started when METRICS_PORT is 0', async () => {
    vi.stubEnv('METRICS_PORT', '0');
    resetConfigCache();

    expect(await startMetricsFromConfig('web')).toBeUndefined();
  });
});
