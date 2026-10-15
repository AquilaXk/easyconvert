import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { graphScheduler } from '../src/lib/queue/graph';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { OPTIMIZERS } from '../src/lib/conversions/optimizers';
import { OPTIMIZABLE_FORMATS } from '../src/lib/jobs/optimize-formats';
import { UnsupportedOptionError, JobTimeoutError } from '../src/lib/types';
import { validateJobGraph } from '../src/lib/jobs';
import type { OptimizerFunction } from '../src/lib/conversions/optimizers';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * `optimize` must never report an unchanged file or a default re-encode as optimised. Until a format
 * has a registered optimiser (PDF has one), a graph that optimises it is refused with a 422 problem before any
 * job is enqueued, and the executor refuses the node too if validation was bypassed.
 */
const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function nodeJob(
  inputArtifacts: string[],
  options: Record<string, unknown> = {},
  extra: { signal?: AbortSignal; deadlineAt?: number; logs?: string[] } = {}
) {
  const graphId = `g_opt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode: { op: 'optimize', input: 'src', options },
      inputArtifacts,
    },
    opts: { attempts: 1, deadlineAt: extra.deadlineAt },
    attemptsMade: 1,
    signal: extra.signal ?? new AbortController().signal,
    log: async (line: string) => {
      extra.logs?.push(line);
    },
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

describe('optimize fails closed for formats without an optimiser', () => {
  let authHeaders: Record<string, string>;
  let userId: string;
  let initGraph: MockInstance<typeof graphScheduler.initGraph>;

  beforeEach(async () => {
    const email = `optimize_${Date.now()}_${Math.random().toString(36).slice(2)}@optimize.test`;
    const user = await userStore.createUser({ email, name: 'optimize', tier: 'pro' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'optimize', { scopes: ['convert:read', 'convert:write'] });
    authHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    initGraph = vi.spyOn(graphScheduler, 'initGraph');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function submitOptimize(filename: string, bytes: Buffer, mime: string) {
    const storageKey = `uploads/${userId}/${filename}`;
    s3Storage.saveObject(storageKey, bytes, mime, filename);
    const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          storageKey,
          filename,
          graph: {
            nodes: {
              src: { op: 'import.upload', storageKey },
              opt: { op: 'optimize', input: 'src' },
              out: { op: 'export.internal', input: 'opt' },
            },
          },
        }),
      })
    );
    const json = await res.json();
    const quotaUnchanged = quotaBefore === JSON.stringify(await redisKeyStore.getQuotaUsage(userId));
    return { res, json, quotaUnchanged };
  }

  it.each([
    ['png', 'pic.png', PNG_SIGNATURE, 'image/png'],
    ['jpg', 'pic.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'],
  ])('answers a 422 problem for %s at submission and enqueues nothing', async (format, filename, bytes, mime) => {
    const { res, json, quotaUnchanged } = await submitOptimize(filename, bytes, mime);

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(json.type).toBe('https://api.easyconvert.io/problems/unprocessable-entity');
    expect(json.status).toBe(422);
    expect(json.detail).toContain(`optimize is not available for ${format}`);
    expect(json.detail).toContain('Supported formats: pdf.');
    expect(json.detail).toContain('conversion options');
    expect(json.invalidParams).toEqual([
      { name: 'nodes.opt', reason: expect.stringContaining(`optimize is not available for ${format}`) },
    ]);
    expect(initGraph).not.toHaveBeenCalled();
    expect(quotaUnchanged).toBe(true);
  });

  it('refuses the node in the executor when validation is bypassed and stores no output', async () => {
    const artifactPath = 'intermediate/g_opt_bypass/src.png';
    s3Storage.saveObject(artifactPath, PNG_SIGNATURE, 'image/png', 'src.png', ARTIFACT_TTL_MS);
    const job = nodeJob([artifactPath]);

    const error = await processGraphNodeJob(job, undefined, s3Storage).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as Error).message).toContain('optimize is not available for png');
    expect((error as Error).message).toContain('Supported formats: pdf.');
    const stored = await s3Storage.getObject(artifactPath);
    expect(createHash('sha256').update(stored!.buffer).digest('hex')).toBe(createHash('sha256').update(PNG_SIGNATURE).digest('hex'));
    expect(await s3Storage.getObject(`intermediate/${job.data.graphId}/n1/src.png`)).toBeUndefined();
  });

  it('registers exactly the formats validation accepts', () => {
    expect([...OPTIMIZERS.keys()]).toEqual(['pdf']);
    expect([...OPTIMIZERS.keys()]).toEqual([...OPTIMIZABLE_FORMATS]);
  });

  it.each([
    ['an import.url without an extension', { op: 'import.url', url: 'https://files.example.com/download' }],
    ['an archive.extract', { op: 'archive.extract', input: 'up' }],
  ])('leaves an optimize node fed by %s to the run, whose format is known only then and is checked against the optimisers', (_label, source) => {
    const result = validateJobGraph({
      nodes: {
        up: { op: 'import.upload', storageKey: 'uploads/u/bundle.zip' },
        src: source,
        opt: { op: 'optimize', input: 'src' },
        out: { op: 'export.internal', input: 'opt' },
      },
    } as never);

    expect(result.errors.find((e) => e.path === 'nodes.opt')).toBeUndefined();
  });
});

describe('optimize with a registered optimiser (injected into the executor, never in production)', () => {
  const INPUT = Buffer.alloc(1000, 7);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const registry = (fn: OptimizerFunction) => new Map<string, OptimizerFunction>([['pdf', fn]]);
  let completed: MockInstance<typeof graphScheduler.onNodeCompleted>;

  beforeEach(() => {
    completed = vi.spyOn(graphScheduler, 'onNodeCompleted');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(fn: OptimizerFunction, extra: Parameters<typeof nodeJob>[2] = {}) {
    const key = `intermediate/g_in_${Math.random().toString(36).slice(2)}/src.pdf`;
    s3Storage.saveObject(key, INPUT, 'application/pdf', 'src.pdf', ARTIFACT_TTL_MS);
    const job = nodeJob([key], {}, extra);
    const result = await processGraphNodeJob(job, undefined, s3Storage, registry(fn));
    const out = await s3Storage.getObject(result.resultKey);
    return { result, out: out!, job };
  }

  it.each([
    ['a larger output', async () => ({ buffer: Buffer.alloc(1500, 9), optimized: true })],
    ['an output of the same size', async () => ({ buffer: Buffer.alloc(1000, 9), optimized: true })],
    ['optimized: false', async () => ({ buffer: Buffer.alloc(400, 9), optimized: false })],
  ])('keeps the input, marks it not optimised and charges nothing for %s', async (_label, fn) => {
    const logs: string[] = [];
    const { result, out } = await run(fn, { logs });

    expect(sha(out.buffer)).toBe(sha(INPUT));
    expect(result.size).toBe(1000);
    expect(result.optimizations).toEqual([
      { key: result.resultKey, optimized: false, inputBytes: 1000, outputBytes: expect.any(Number) },
    ]);
    expect(completed).toHaveBeenCalledWith(expect.any(String), 'n1', [result.resultKey], 0);
    expect(logs.join('\n')).toContain('kept "src.pdf" unchanged');
    expect(logs.join('\n')).not.toMatch(/optimized 1 artifact/);
  });

  it('stores the smaller output, reports the sizes and charges one unit', async () => {
    const smaller = Buffer.alloc(300, 3);
    const logs: string[] = [];
    const { result, out } = await run(async () => ({ buffer: smaller, optimized: true }), { logs });

    expect(sha(out.buffer)).toBe(sha(smaller));
    expect(result.optimizations).toEqual([{ key: result.resultKey, optimized: true, inputBytes: 1000, outputBytes: 300 }]);
    expect(completed).toHaveBeenCalledWith(expect.any(String), 'n1', [result.resultKey], 1);
    expect(logs.join('\n')).toContain('1000 to 300 bytes');
  });

  it('hands the optimiser the job signal and the remaining time, and aborts it at the deadline', async () => {
    const controller = new AbortController();
    const deadlineAt = Date.now() + 60_000;
    const seen: { signal?: AbortSignal; remainingMs?: number } = {};
    const fn: OptimizerFunction = (_buffer, _options, run) =>
      new Promise((_resolve, reject) => {
        seen.signal = run.signal;
        seen.remainingMs = run.remainingMs;
        run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true });
        setTimeout(() => controller.abort(new JobTimeoutError(20)), 20);
      });

    const key = 'intermediate/g_dl/src.pdf';
    s3Storage.saveObject(key, INPUT, 'application/pdf', 'src.pdf', ARTIFACT_TTL_MS);
    const job = nodeJob([key], {}, { signal: controller.signal, deadlineAt });
    const error = await processGraphNodeJob(job, undefined, s3Storage, registry(fn)).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(JobTimeoutError);
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.remainingMs).toBeGreaterThan(50_000);
    expect(seen.remainingMs).toBeLessThanOrEqual(60_000);
    expect(completed).not.toHaveBeenCalled();
  });

  it('stops waiting for an optimiser that ignores the signal once the deadline aborts the job', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new JobTimeoutError(20)), 20);
    const deaf: OptimizerFunction = () => new Promise(() => undefined);
    const key = 'intermediate/g_deaf/src.pdf';
    s3Storage.saveObject(key, INPUT, 'application/pdf', 'src.pdf', ARTIFACT_TTL_MS);
    const job = nodeJob([key], {}, { signal: controller.signal });

    const error = await processGraphNodeJob(job, undefined, s3Storage, registry(deaf)).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(JobTimeoutError);
    expect((error as Error).message).toBe('Job timed out after 20ms');
    expect(completed).not.toHaveBeenCalled();
  });
});
