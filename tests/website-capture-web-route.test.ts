import crypto from 'node:crypto';
import dns, { type LookupAddress } from 'node:dns';
import net from 'node:net';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getAccessFallbackHTTPStatus, isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as captureJobsRoute } from '../src/app/api/capture/jobs/route';
import { GET as readQueueJobRoute, DELETE as cancelQueueJobRoute } from '../src/app/api/queue/jobs/[id]/route';
import { GET as storageFileRoute } from '../src/app/api/storage/file/[...key]/route';
import { GET as ogRoute } from '../src/app/api/og/route';
import { resolveOgCardSpec } from '../src/lib/og/resolve-card';
import ConverterPage, { generateMetadata as converterGenerateMetadata } from '../src/app/[locale]/[slug]/page';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import * as apiGuard from '../src/lib/api-keys/guard';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { userStore } from '../src/lib/auth/user-store';
import { processQueuedCaptureJob } from '../src/lib/capture/queued-capture-runner';
import { CaptureFailedError, CaptureTargetBlockedError, CaptureUnavailableError } from '../src/lib/capture/website-capture-errors';
import { finishedData } from '../src/lib/queue/ended-jobs';
import { Worker } from '../src/lib/queue/bullmq-engine';
import * as concurrencyLimit from '../src/lib/queue/concurrency-limit';
import { attachJobLifecycleListeners, conversionQueue, processConversionJob, resourceQueues } from '../src/lib/queue/conversion-queue';
import * as enqueueLib from '../src/lib/queue/enqueue';
import * as workerPresence from '../src/lib/queue/worker-presence';
import { rateLimitKey } from '../src/lib/security/client-ip';
import { SecretSealError } from '../src/lib/security/job-secret-seal';
import * as retentionService from '../src/lib/storage/retention-service';
import { s3Storage } from '../src/lib/storage/s3-storage';
import {
  ConversionFailedError,
  CpuTaskTimeoutError,
  EngineUnavailableError,
  JobTimeoutError,
  PayloadLimitError,
  SandboxUnavailableError,
  WorkerOutputMissingError,
  type ConversionJobData,
  type ConversionJobResult,
} from '../src/lib/types';
import { runWithoutFileConfinement } from './helpers/unconfined-files';
import { skipUnless } from './helpers/strict-skip';

/**
 * Anonymous and authenticated website capture via POST /api/capture/jobs -> memory queue -> worker -> /api/storage/file,
 * plus runtime CAPTURE_WEBSITE_ENABLED=false kill-switch gates on the capture pages and OG card resolver.
 */

runWithoutFileConfinement();

const CAPTURE_SLUGS = ['save-website-as-pdf', 'website-png-screenshot', 'website-jpg-screenshot'] as const;
const WAIT = { timeout: 20_000, interval: 40 };
const PUBLIC = [{ address: '93.184.216.34', family: 4 }] as LookupAddress[];
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find((candidate) => existsSync(candidate));
const STAND_IN = `
import json, sys
request = json.load(open(sys.argv[1]))
if 'blocked.example' in request['url']:
    sys.stdout.write(json.dumps({'ok': False, 'code': 'load_failed'}) + '\\n')
    sys.exit(0)
out = sys.argv[1].rsplit('/', 1)[0] + '/' + request['output']
body = {'pdf': b'%PDF-1.7 captured ', 'png': b'\\x89PNG\\r\\n\\x1a\\n captured ', 'jpg': b'\\xff\\xd8\\xff captured '}[request['format']]
open(out, 'wb').write(body + request['url'].encode())
sys.stdout.write(json.dumps({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': 'Captured', 'blocked': []}) + '\\n')
`;

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  getTranslations: async (arg: string | { locale: 'en' | 'ko'; namespace: string }) => {
    const { locale, namespace } = typeof arg === 'string' ? { locale: 'en' as const, namespace: arg } : arg;
    return (await import('./helpers/intl')).testTranslator(locale, namespace as 'slugPages');
  },
}));

let dir = '';
let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

function nextAnonIp(): string {
  const segA = crypto.randomBytes(2).toString('hex');
  const segB = crypto.randomBytes(2).toString('hex');
  return `2001:db8:${segA}:${segB}::1`;
}

function anonBucketId(ip: string): string {
  return anonymousUserId(rateLimitKey(ip));
}

function anonPost(ip: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/capture/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function standIn(): void {
  const realLookup = dns.lookup;
  vi.spyOn(dns, 'lookup').mockImplementation(((name: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, list: LookupAddress[]) => void) => {
    if (net.isIP(name) !== 0) return (realLookup as (...args: unknown[]) => void)(name, options, callback);
    process.nextTick(() => callback(null, PUBLIC));
  }) as never);
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => PUBLIC) as never);
  vi.stubEnv('CAPTURE_WEBSITE_ENABLED', undefined as unknown as string);
  vi.stubEnv('CAPTURE_PYTHON_PATH', PYTHON as string);
  vi.stubEnv('CAPTURE_DRIVER_PATH', path.join(dir, 'capture.py'));
}

async function pageStatus(call: () => unknown): Promise<number> {
  try {
    await call();
    return 200;
  } catch (error) {
    if (isHTTPAccessFallbackError(error)) return getAccessFallbackHTTPStatus(error);
    throw error;
  }
}

beforeAll(() => {
  skipUnless('a Python 3 interpreter for the stand-in driver', PYTHON !== undefined);
  dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-capture-web-'));
  writeFileSync(path.join(dir, 'capture.py'), STAND_IN);
  chmodSync(path.join(dir, 'capture.py'), 0o755);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  vi.stubEnv('CAPTURE_WEBSITE_ENABLED', undefined as unknown as string);
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('POST /api/capture/jobs validation, sealing, and memory-queue routing', () => {
  it('enqueues anonymous capture requests onto the memory resource queue with the URL sealed under the job id', async () => {
    const ip = nextAnonIp();
    const secretUrl = 'https://news.example/report?token=s3cretToken';
    const res = await captureJobsRoute(
      anonPost(ip, {
        url: secretUrl,
        targetFormat: 'pdf',
        options: { waitUntil: 'idle', pdf: { paper: 'A4', landscape: true, margin: 12, printBackground: true } },
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; jobId: string; status: string; queue: string };
    expect(body.success).toBe(true);
    expect(body.queue).toBe('easyconvert-jobs:memory');

    const inMemoryQueue = await resourceQueues.memory.getJob(body.jobId);
    expect(inMemoryQueue).toBeDefined();
    expect(inMemoryQueue!.data.resourceClass).toBe('memory');
    expect(inMemoryQueue!.data.originalFilename).toBe('capture.pdf');
    expect(inMemoryQueue!.data.targetFormat).toBe('pdf');
    expect(inMemoryQueue!.data.captureJob?.url).toBeUndefined();
    expect(typeof inMemoryQueue!.data.captureJob?.sealedUrl).toBe('string');
    expect(JSON.stringify(inMemoryQueue!.data)).not.toContain('s3cretToken');
    expect(JSON.stringify(inMemoryQueue!.data)).not.toContain('news.example');
    expect(inMemoryQueue!.data.captureJob?.options).toEqual({
      waitUntil: 'idle',
      pdf: { paper: 'A4', landscape: true, margin: 12, printBackground: true },
    });

    // Polling GET /api/queue/jobs/[id] succeeds for anonymous capability holders and never exposes captureJob.
    const poll = await readQueueJobRoute(
      new NextRequest(`http://localhost/api/queue/jobs/${body.jobId}`),
      { params: Promise.resolve({ id: body.jobId }) }
    );
    expect(poll.status).toBe(200);
    const pollJson = await poll.json();
    expect(pollJson.id).toBe(body.jobId);
    expect(pollJson.data).toEqual({ originalFilename: 'capture.pdf', sourceFormat: 'html', targetFormat: 'pdf' });

    await resourceQueues.memory.cancelJob(body.jobId, 'test cleanup');
  });

  it('refuses disabled website capture fail-closed with 422 capture_unavailable before reserving quota', async () => {
    for (const val of ['false', 'FALSE', '0', 'off']) {
      vi.stubEnv('CAPTURE_WEBSITE_ENABLED', val);
      const ip = nextAnonIp();
      const anonId = anonBucketId(ip);
      const res = await captureJobsRoute(
        anonPost(ip, { url: 'https://example.com', targetFormat: 'png' })
      );
      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({ status: 422, code: 'capture_unavailable' });
      expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
    }
  });

  it.each([
    ['empty url', { url: '', targetFormat: 'pdf' }, 422, 'capture_target_blocked'],
    ['ftp scheme', { url: 'ftp://files.example/a', targetFormat: 'pdf' }, 422, 'capture_target_blocked'],
    ['file scheme', { url: 'file:///etc/passwd', targetFormat: 'png' }, 422, 'capture_target_blocked'],
    ['embedded credentials', { url: 'https://user:pass@example.com/', targetFormat: 'jpg' }, 422, 'capture_target_blocked'],
    ['non-web port', { url: 'https://example.com:6379/', targetFormat: 'pdf' }, 422, 'capture_target_blocked'],
    ['too-long url', { url: 'https://example.com/' + 'a'.repeat(8200), targetFormat: 'pdf' }, 422, 'capture_target_blocked'],
    ['unsupported targetFormat', { url: 'https://example.com/', targetFormat: 'gif' }, 400, undefined],
    ['missing targetFormat', { url: 'https://example.com/' }, 400, undefined],
    ['unexpected top-level key', { url: 'https://example.com/', targetFormat: 'pdf', proxySocket: '/tmp/evil' }, 422, undefined],
    ['out-of-range viewport width', { url: 'https://example.com/', targetFormat: 'png', options: { viewport: { width: 10 } } }, 422, undefined],
    ['out-of-range jpg quality', { url: 'https://example.com/', targetFormat: 'jpg', options: { quality: 101 } }, 422, undefined],
    ['newline in userAgent', { url: 'https://example.com/', targetFormat: 'png', options: { userAgent: 'Bad\r\nAgent' } }, 422, undefined],
    ['escape control char in userAgent', { url: 'https://example.com/', targetFormat: 'png', options: { userAgent: 'Bad\x1bAgent' } }, 422, undefined],
    ['unknown capture option key', { url: 'https://example.com/', targetFormat: 'png', options: { proxySocket: '/evil' } }, 422, 'option_not_supported'],
  ])('rejects %s before reserving quota', async (_label, payload, expectedStatus, expectedCode) => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    const res = await captureJobsRoute(anonPost(ip, payload));
    expect(res.status).toBe(expectedStatus);
    if (expectedCode) {
      expect((await res.json()).code).toBe(expectedCode);
    }
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
  });

  it.each([
    ['localhost', 'http://localhost/'],
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['link-local metadata IP', 'http://169.254.169.254/latest/meta-data/?token=s3cret'],
    ['RFC1918 10.0.0.0/8', 'http://10.0.0.1/'],
    ['RFC1918 172.16.0.0/12', 'http://172.16.0.1/'],
    ['CGNAT 100.64.0.0/10', 'http://100.64.0.1/'],
    ['GCP metadata domain', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['AWS IPv6 IMDS', 'http://[fd00:ec2::254]/latest/meta-data/'],
    ['mDNS .local domain', 'http://foo.local/'],
    ['decimal integer IPv4 loopback', 'http://2130706433/'],
    ['octal IPv4 loopback', 'http://0177.0.0.1/'],
    ['hex IPv4 loopback', 'http://0x7f.0.0.1/'],
    ['short IPv4 loopback', 'http://127.1/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['trailing dot localhost', 'http://localhost./'],
    ['RFC1918 192.168.0.0/16', 'http://192.168.1.1/'],
    ['unspecified 0.0.0.0', 'http://0.0.0.0/'],
  ])('synchronously refuses private/loopback/restricted %s with 422 capture_target_blocked before concurrency, quota, or enqueue', async (_label, targetUrl) => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    const countsBefore = await resourceQueues.memory.getJobCounts();
    const mayEnqueueSpy = vi.spyOn(concurrencyLimit, 'mayEnqueue');
    const reserveSpy = vi.spyOn(apiGuard, 'reserveConversionUnit');
    const handOffSpy = vi.spyOn(enqueueLib, 'handOffConversionJob');
    const queueAddSpy = vi.spyOn(resourceQueues.memory, 'add');
    const dnsLookupSpy = vi.spyOn(dns, 'lookup');
    const dnsPromisesSpy = vi.spyOn(dns.promises, 'lookup');

    const res = await captureJobsRoute(anonPost(ip, { url: targetUrl, targetFormat: 'pdf' }));
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as {
      status: number;
      code: string;
      invalidParams?: Array<{ name: string; reason: string }>;
    };
    expect(body).toMatchObject({
      status: 422,
      code: 'capture_target_blocked',
      invalidParams: [{ name: 'url', reason: expect.any(String) }],
    });
    expect(JSON.stringify(body)).not.toContain('s3cret');
    expect(mayEnqueueSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(handOffSpy).not.toHaveBeenCalled();
    expect(queueAddSpy).not.toHaveBeenCalled();
    expect(dnsLookupSpy).not.toHaveBeenCalled();
    expect(dnsPromisesSpy).not.toHaveBeenCalled();
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
    expect(await resourceQueues.memory.getJobsByUser(anonId, ['waiting', 'active', 'delayed'], 100, 0)).toEqual([]);
    expect(await resourceQueues.memory.getJobCounts()).toEqual(countsBefore);
  });

  it('refuses private URLs with 422 before concurrency or quota exhaustion and releases Idempotency-Key locks', async () => {
    const ip = nextAnonIp();
    const idemKey = `blocked_${crypto.randomUUID()}`;
    vi.spyOn(concurrencyLimit, 'mayEnqueue').mockResolvedValue({ allowed: false, limit: 5 });
    const reserveSpy = vi.spyOn(apiGuard, 'reserveConversionUnit');

    const blocked = await captureJobsRoute(
      anonPost(ip, { url: 'http://127.0.0.1/internal', targetFormat: 'png' }, { 'Idempotency-Key': idemKey })
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).code).toBe('capture_target_blocked');
    expect(reserveSpy).not.toHaveBeenCalled();

    // The failed 422 refusal must release the Idempotency-Key lock so reusing the key on a fixed public URL reaches the concurrency gate instead of 422 idempotency-key-reused or 409.
    const retried = await captureJobsRoute(
      anonPost(ip, { url: 'https://example.com/public', targetFormat: 'png' }, { 'Idempotency-Key': idemKey })
    );
    expect(retried.status).toBe(429);
    expect(retried.headers.get('idempotent-replayed')).toBeNull();
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['CaptureUnavailableError', () => new CaptureUnavailableError(), 422, 'capture_unavailable', 'Website capture is not enabled on this server.'],
    ['CaptureFailedError', () => new CaptureFailedError('The browser could not load the page.'), 422, 'capture_failed', 'The browser could not load the page.'],
    ['CaptureTargetBlockedError', () => new CaptureTargetBlockedError('Target host is restricted.'), 422, 'capture_target_blocked', 'Target host is restricted.'],
    ['CpuTaskTimeoutError', () => new CpuTaskTimeoutError('website capture', 15_000), 422, 'timeout', 'The website capture task exceeded its 15000 ms time limit'],
    ['EngineUnavailableError', () => new EngineUnavailableError('capture-website', 'browser missing'), 503, 'engine_unavailable', 'browser missing'],
    ['SandboxUnavailableError', () => new SandboxUnavailableError('unshare denied'), 503, 'engine_unavailable', 'unshare denied'],
    ['ConversionFailedError', () => new ConversionFailedError('Malformed capture stream.'), 400, 'conversion_failed', 'Malformed capture stream.'],
    ['PayloadLimitError', () => new PayloadLimitError('Capture payload exceeded limit.'), 413, 'input_over_limit', 'Capture payload exceeded limit.'],
  ])('maps %s through typedFailureProblem and rolls back reserved quota', async (_label, makeError, expectedStatus, expectedCode, expectedDetail) => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    vi.spyOn(enqueueLib, 'handOffConversionJob').mockRejectedValueOnce(makeError());

    const res = await captureJobsRoute(anonPost(ip, { url: 'https://example.com/error-map', targetFormat: 'png' }));
    expect(res.status).toBe(expectedStatus);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    if (expectedStatus === 503) {
      expect(res.headers.get('retry-after')).toBe('5');
    }
    const body = (await res.json()) as { status: number; code: string; detail: string };
    expect(body).toMatchObject({ status: expectedStatus, code: expectedCode });
    expect(body.detail).toContain(expectedDetail);
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
  });

  it('logs and redacts 500-status ConversionFailedError subclasses and untyped errors in captureErrorResponse', async () => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.spyOn(enqueueLib, 'handOffConversionJob').mockRejectedValueOnce(
      new WorkerOutputMissingError('/secret/worker/tmp/capture.pdf')
    );
    const workerFaultRes = await captureJobsRoute(anonPost(ip, { url: 'https://example.com/fault1', targetFormat: 'pdf' }));
    expect(workerFaultRes.status).toBe(500);
    expect(workerFaultRes.headers.get('content-type')).toContain('application/problem+json');
    const workerFaultText = await workerFaultRes.text();
    expect(workerFaultText).toContain('Internal conversion error');
    expect(workerFaultText).not.toContain('/secret/worker/tmp');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[capture/jobs]', expect.any(WorkerOutputMissingError));

    vi.spyOn(enqueueLib, 'handOffConversionJob').mockRejectedValueOnce(new Error('/secret/db/conn'));
    const genericFaultRes = await captureJobsRoute(anonPost(ip, { url: 'https://example.com/fault2', targetFormat: 'pdf' }));
    expect(genericFaultRes.status).toBe(500);
    const genericFaultText = await genericFaultRes.text();
    expect(genericFaultText).toContain('Website capture enqueue error');
    expect(genericFaultText).not.toContain('/secret/db/conn');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[capture/jobs]', expect.any(Error));
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
  });

  it('names options.* paths in invalidParams and refuses full disk before reserving quota', async () => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);

    const badWidth = await captureJobsRoute(
      anonPost(ip, { url: 'https://example.com/', targetFormat: 'png', options: { viewport: { width: 10 } } })
    );
    expect(badWidth.status).toBe(422);
    const badWidthJson = (await badWidth.json()) as { invalidParams?: Array<{ name: string }> };
    expect(badWidthJson.invalidParams?.map((p) => p.name)).toEqual(['options.viewport.width']);

    const protoRes = await captureJobsRoute(
      anonPost(ip, '{"url":"https://example.com","targetFormat":"png","options":{"__proto__":{"polluted":true}}}')
    );
    expect(protoRes.status).toBe(422);
    const protoJson = (await protoRes.json()) as { invalidParams?: Array<{ name: string; reason: string }> };
    expect(protoJson.invalidParams).toEqual([{ name: 'options.__proto__', reason: 'prototype_key' }]);

    vi.spyOn(retentionService, 'admitsNewFiles').mockResolvedValue(false);
    const diskFull = await captureJobsRoute(anonPost(ip, { url: 'https://example.com/', targetFormat: 'pdf' }));
    expect(diskFull.status).toBe(503);
    expect((await diskFull.json()).type).toContain('storage-full');
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
  });

  it('rejects prototype keys, non-JSON bodies, and queue-only pool outage before reserving quota', async () => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);

    const nonJson = await captureJobsRoute(
      new NextRequest('http://localhost/api/capture/jobs', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-forwarded-for': ip },
        body: '{}',
      })
    );
    expect(nonJson.status).toBe(415);

    const protoPolluted = await captureJobsRoute(
      anonPost(ip, '{"url":"https://example.com","targetFormat":"png","options":{"__proto__":{"polluted":true}}}')
    );
    expect(protoPolluted.status).toBe(422);

    vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
    vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(false);
    const unavailable = await captureJobsRoute(anonPost(ip, { url: 'https://example.com', targetFormat: 'png' }));
    expect(unavailable.status).toBe(503);
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0);
  });

  it('replays Idempotency-Key without reserving a second credit', async () => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    const key = `idem_${crypto.randomUUID()}`;
    const first = await captureJobsRoute(
      anonPost(ip, { url: 'https://example.com/a', targetFormat: 'png' }, { 'Idempotency-Key': key })
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await captureJobsRoute(
      anonPost(ip, { url: 'https://example.com/a', targetFormat: 'png' }, { 'Idempotency-Key': key })
    );
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(1);

    await resourceQueues.memory.cancelJob(firstBody.jobId, 'test cleanup');
  });

  it('cancels an anonymous queued capture job and refunds its quota reservation', async () => {
    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    const res = await captureJobsRoute(anonPost(ip, { url: 'https://example.com/wait', targetFormat: 'jpg' }));
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(1);

    const cancel = await cancelQueueJobRoute(
      new NextRequest(`http://localhost/api/queue/jobs/${jobId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: jobId }) }
    );
    expect(cancel.status).toBe(200);
    await vi.waitFor(async () => expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0), WAIT);
  });

  it('refuses unsealed capture job payloads and expired deadlines inside the worker runner', async () => {
    const fakeJob = {
      id: 'capture-unsealed',
      data: {
        jobId: 'capture-unsealed',
        originalFilename: 'capture.pdf',
        sourceFormat: 'html',
        targetFormat: 'pdf',
        fileSize: 0,
        options: {},
        captureJob: { url: 'https://example.com/plaintext', format: 'pdf' as const },
      },
      signal: new AbortController().signal,
      updateProgress: vi.fn(async () => undefined),
    };
    await expect(processQueuedCaptureJob(fakeJob as never, s3Storage)).rejects.toThrow(SecretSealError);

    const expiredJob = {
      id: 'capture-expired',
      data: {
        jobId: 'capture-expired',
        originalFilename: 'capture.pdf',
        sourceFormat: 'html',
        targetFormat: 'pdf',
        fileSize: 0,
        options: {},
        captureJob: { url: 'https://example.com/expired', format: 'pdf' as const },
      },
      opts: { timeout: 1000, deadlineAt: Date.now() - 100 },
      signal: new AbortController().signal,
      updateProgress: vi.fn(async () => undefined),
    };
    const sealed = (await import('../src/lib/queue/option-secrets')).sealJobDataSecrets(expiredJob.data, expiredJob.id);
    expiredJob.data = sealed as never;
    await expect(processQueuedCaptureJob(expiredJob as never, s3Storage)).rejects.toThrow(JobTimeoutError);
  });
});

describe.skipIf(skipUnless('a Python 3 interpreter for the stand-in driver', PYTHON !== undefined))('memory queue worker capture execution', () => {
  it('processes an anonymous capture job from the memory queue, stores the output, drops sealed data, and serves the download', async () => {
    standIn();
    worker = new Worker<ConversionJobData, ConversionJobResult>([resourceQueues.memory] as never, (job) => processConversionJob(job), { concurrency: 2 });
    attachJobLifecycleListeners(worker);

    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday, 'before route').toBe(0);
    const created = await captureJobsRoute(
      anonPost(ip, { url: 'https://docs.example/guide?token=tok123', targetFormat: 'png', options: { fullPage: true } })
    );
    expect(created.status).toBe(201);
    const { jobId } = (await created.json()) as { jobId: string };
    await vi.waitFor(async () => expect((await conversionQueue.getJob(jobId))?.state).toBe('completed'), WAIT);
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday, 'after completed').toBe(1);

    const poll = await readQueueJobRoute(
      new NextRequest(`http://localhost/api/queue/jobs/${jobId}`),
      { params: Promise.resolve({ id: jobId }) }
    );
    const pollJson = await poll.json();
    expect(pollJson.state).toBe('completed');
    expect(pollJson.returnvalue.filename).toBe('docs.example-guide.png');
    expect(pollJson.returnvalue.downloadUrl).toMatch(/^\/api\/storage\/file\//);

    const encodedKey = pollJson.returnvalue.downloadUrl.slice('/api/storage/file/'.length);
    const download = await storageFileRoute(
      new NextRequest(`http://localhost${pollJson.returnvalue.downloadUrl}`),
      { params: Promise.resolve({ key: decodeURIComponent(encodedKey).split('/') }) }
    );
    expect(download.status).toBe(200);
    const downloadedBytes = Buffer.from(await download.arrayBuffer()).toString('latin1');
    expect(downloadedBytes).toBe('\x89PNG\r\n\x1a\n captured https://docs.example/guide?token=tok123');

    const completedJob = await conversionQueue.getJob(jobId);
    expect(completedJob?.opts.removeDataOnFinish).toContain('captureJob');
    expect(finishedData(completedJob?.data, completedJob?.opts.removeDataOnFinish)?.captureJob).toBeUndefined();
    expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(1);
  }, 30_000);

  it('rolls back quota when a queued capture fails on the worker and records the refusal code', async () => {
    standIn();
    worker = new Worker<ConversionJobData, ConversionJobResult>([resourceQueues.memory] as never, (job) => processConversionJob(job), { concurrency: 1 });
    attachJobLifecycleListeners(worker);

    const ip = nextAnonIp();
    const anonId = anonBucketId(ip);
    const created = await captureJobsRoute(
      anonPost(ip, { url: 'https://blocked.example/fail', targetFormat: 'pdf' })
    );
    expect(created.status).toBe(201);
    const { jobId } = (await created.json()) as { jobId: string };

    await vi.waitFor(async () => expect((await conversionQueue.getJob(jobId))?.state).toBe('failed'), WAIT);
    const poll = await readQueueJobRoute(
      new NextRequest(`http://localhost/api/queue/jobs/${jobId}`),
      { params: Promise.resolve({ id: jobId }) }
    );
    const pollJson = await poll.json();
    expect(pollJson.failedRefusalCode).toBe('capture_failed');
    await vi.waitFor(async () => expect((await redisKeyStore.getQuotaUsage(anonId)).usedToday).toBe(0), WAIT);
  }, 30_000);

  it('prevents cross-user access when a capture job belongs to a signed-in account and lets the owner download', async () => {
    standIn();
    worker = new Worker<ConversionJobData, ConversionJobResult>([resourceQueues.memory] as never, (job) => processConversionJob(job), { concurrency: 1 });
    attachJobLifecycleListeners(worker);

    const owner = userStore.sanitizeUser(await userStore.createUser({ email: `cap-owner-${Date.now()}@test.local`, name: 'Owner', tier: 'paid' }));
    const other = userStore.sanitizeUser(await userStore.createUser({ email: `cap-other-${Date.now()}@test.local`, name: 'Other', tier: 'free' }));
    const { secretKey: ownerKey } = await redisKeyStore.generateApiKey(owner.id, 'owner', { scopes: ['convert:write', 'convert:read', 'storage:download'] });
    const { secretKey: otherKey } = await redisKeyStore.generateApiKey(other.id, 'other', { scopes: ['convert:write', 'convert:read', 'storage:download'] });

    const res = await captureJobsRoute(
      new NextRequest('http://localhost/api/capture/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerKey}` },
        body: JSON.stringify({ url: 'https://example.com/private', targetFormat: 'pdf' }),
      })
    );
    expect(res.status).toBe(201);
    const { jobId } = (await res.json()) as { jobId: string };

    const foreignPoll = await readQueueJobRoute(
      new NextRequest(`http://localhost/api/queue/jobs/${jobId}`, { headers: { authorization: `Bearer ${otherKey}` } }),
      { params: Promise.resolve({ id: jobId }) }
    );
    expect(foreignPoll.status).toBe(404);

    await vi.waitFor(async () => expect((await conversionQueue.getJob(jobId))?.state).toBe('completed'), WAIT);
    const ownerPoll = await readQueueJobRoute(
      new NextRequest(`http://localhost/api/queue/jobs/${jobId}`, { headers: { authorization: `Bearer ${ownerKey}` } }),
      { params: Promise.resolve({ id: jobId }) }
    );
    expect(ownerPoll.status).toBe(200);
    const ownerJson = await ownerPoll.json();
    const dlUrl = ownerJson.returnvalue.downloadUrl as string;
    const encodedKey = dlUrl.slice('/api/storage/file/'.length);

    const foreignDownload = await storageFileRoute(
      new NextRequest(`http://localhost${dlUrl}`, { headers: { authorization: `Bearer ${otherKey}` } }),
      { params: Promise.resolve({ key: decodeURIComponent(encodedKey).split('/') }) }
    );
    expect(foreignDownload.status).toBe(404);

    const ownerDownload = await storageFileRoute(
      new NextRequest(`http://localhost${dlUrl}`, { headers: { authorization: `Bearer ${ownerKey}` } }),
      { params: Promise.resolve({ key: decodeURIComponent(encodedKey).split('/') }) }
    );
    expect(ownerDownload.status).toBe(200);
  }, 30_000);
});

describe('CAPTURE_WEBSITE_ENABLED=false kill-switch gates capture pages and OG previews to 404', () => {
  it.each(['en', 'ko'] as const)('answers 404 for all 3 website capture slugs in %s while keeping normal converter pages live', async (locale) => {
    vi.stubEnv('CAPTURE_WEBSITE_ENABLED', 'false');
    for (const slug of CAPTURE_SLUGS) {
      expect(await pageStatus(() => ConverterPage({ params: Promise.resolve({ locale, slug }) })), `${locale}/${slug}`).toBe(404);
      expect(await pageStatus(() => converterGenerateMetadata({ params: Promise.resolve({ locale, slug }) })), `meta:${locale}/${slug}`).toBe(404);
      expect(await resolveOgCardSpec(locale, `/${slug}`)).toBeNull();
      const ogRes = await ogRoute(new NextRequest(`http://localhost/api/og?locale=${locale}&path=/${slug}`));
      expect(ogRes.status).toBe(404);
    }
    expect(await pageStatus(() => ConverterPage({ params: Promise.resolve({ locale, slug: 'pdf-to-jpg' }) }))).toBe(200);
    expect(await resolveOgCardSpec(locale, '/pdf-to-jpg')).not.toBeNull();
  });

  it('serves website capture pages and OG previews normally when enabled', async () => {
    vi.stubEnv('CAPTURE_WEBSITE_ENABLED', undefined as unknown as string);
    for (const slug of CAPTURE_SLUGS) {
      expect(await pageStatus(() => converterGenerateMetadata({ params: Promise.resolve({ locale: 'en', slug }) })), slug).toBe(200);
      expect(await resolveOgCardSpec('en', `/${slug}`)).not.toBeNull();
    }
  });
});
