import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { enqueueGraphNodeJob } from '../src/lib/queue/graph/node-jobs';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { userStore } from '../src/lib/auth/user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * Every conversion job is queued with a deadline. The check is made twice: the source tree has exactly one way to
 * put a conversion job on a queue (`enqueueConversionJob`, which cannot be called without a deadline), and each
 * route that enqueues leaves a job whose `opts.timeout` is the tier's deadline for that input.
 */

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const CSV_BYTES = Buffer.byteLength(CSV_INPUT);
/** Free: 60 s base + 2 s for the first started MiB. Pro: 120 s base + 2 s. */
const FREE_CSV_DEADLINE_MS = 62_000;
const PRO_CSV_DEADLINE_MS = 122_000;
const FREE_MAX_MS = 600_000;
const PRO_MAX_MS = 1_800_000;

const SRC_DIR = path.resolve(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(SRC_DIR, file).split(path.sep).join('/');
}

describe('no conversion job is queued without a deadline', () => {
  /** Files that may call the engine's `add`: the engine itself and the one wrapper that sets the timeout. */
  const ENGINE_FILES = new Set(['lib/queue/bullmq-engine.ts', 'lib/queue/enqueue.ts']);

  it('calls `.add(` on a conversion queue only through enqueueConversionJob', () => {
    const offenders: string[] = [];
    const direct = [
      /\bconversionQueue\.add\(/,
      /\bresourceQueues(?:\[[^\]]*\]|\.\w+)\.add\(/,
      /\bgetQueueForResourceClass\([^)]*\)\.add\(/,
      /\bgetQueueForJob\([^)]*\)\.add\(/,
    ];
    for (const file of sourceFiles(SRC_DIR)) {
      const name = relative(file);
      if (ENGINE_FILES.has(name)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of direct) {
        if (pattern.test(text)) offenders.push(`${name}: ${pattern}`);
      }
      // A queue held in a variable: the variable is assigned from a conversion queue lookup in the same file.
      const holders = [...text.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:conversionQueue|resourceQueues\b|getQueueForResourceClass\(|getQueueForJob\()/g)].map(
        (match) => match[1]
      );
      for (const holder of holders) {
        if (new RegExp(`\\b${holder}\\.add\\(`).test(text)) offenders.push(`${name}: ${holder}.add(`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the routes and the graph enqueue on the wrapper', () => {
    const callers = sourceFiles(SRC_DIR)
      .filter((file) => /\benqueueConversionJob\(/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((name) => name !== 'lib/queue/enqueue.ts')
      .sort();
    expect(callers).toEqual([
      'app/api/queue/jobs/route.ts',
      'app/api/v1/convert/route.ts',
      'app/api/v1/jobs/route.ts',
      'lib/queue/graph/node-jobs.ts',
    ]);
  });

  it('sets the timeout in the wrapper itself, and the options type has no timeout to supply', () => {
    const wrapper = fs.readFileSync(path.join(SRC_DIR, 'lib/queue/enqueue.ts'), 'utf8');
    expect(wrapper).toMatch(/Omit<JobOptions,\s*'timeout'>/);
    expect(wrapper).toMatch(/\.\.\.opts,\s*timeout,/);
  });

  it('puts the computed deadline on the job and refuses a timeout passed through the options', async () => {
    const queue = new Queue<ConversionJobData, ConversionJobResult>('deadline-wrapper');
    const data: ConversionJobData = {
      jobId: '',
      originalFilename: 'a.csv',
      sourceFormat: 'csv',
      targetFormat: 'json',
      fileSize: CSV_BYTES,
      options: {},
      inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
    };
    const job = await enqueueConversionJob(queue, 'convert', data, { attempts: 2 }, { tier: 'free', inputBytes: 3 * MIB });
    expect(job.opts.timeout).toBe(60_000 + 3 * 2_000);
    expect(job.opts.attempts).toBe(2);
    // A caller that sneaks a timeout in through a cast does not get it: the deadline is computed, not supplied.
    const sneaky = await enqueueConversionJob(
      queue,
      'convert',
      data,
      { timeout: 1 } as never,
      { tier: 'free', inputBytes: 3 * MIB }
    );
    expect(sneaky.opts.timeout).toBe(60_000 + 3 * 2_000);
    await queue.close();
  });
});

describe('each route leaves a job with its tier deadline', () => {
  let apiKeys: Record<string, string>;
  let users: Record<string, string>;

  async function makeKey(tier: 'free' | 'pro'): Promise<void> {
    const email = `deadline_${tier}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@deadline.test`;
    const user = await userStore.createUser({ email, name: `Deadline ${tier}`, tier });
    users[tier] = user.id;
    apiKeys[tier] = (await redisKeyStore.generateApiKey(user.id, 'Deadline Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
  }

  beforeEach(async () => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    apiKeys = {};
    users = {};
    await makeKey('free');
    await makeKey('pro');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function jsonRequest(url: string, tier: string, body: unknown): NextRequest {
    return new NextRequest(`${BASE_URL}${url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKeys[tier]}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function multipart(url: string, tier: string, form: FormData, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`${BASE_URL}${url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKeys[tier]}`, ...headers },
      body: form,
    });
  }

  function csvForm(): FormData {
    const form = new FormData();
    form.append('file', new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
    form.append('targetFormat', 'json');
    return form;
  }

  it.each([
    ['free', FREE_CSV_DEADLINE_MS],
    ['pro', PRO_CSV_DEADLINE_MS],
  ])('POST /api/queue/jobs (%s, JSON body with inline input)', async (tier, expected) => {
    const res = await queueJobsRoute(
      jsonRequest('/api/queue/jobs', tier, {
        filename: 'scores.csv',
        targetFormat: 'json',
        inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
        fileSize: 0,
      })
    );
    expect(res.status).toBe(200);
    const job = await conversionQueue.getJob((await res.json()).jobId);
    expect(job?.opts.timeout).toBe(expected);
  });

  it('POST /api/queue/jobs sizes a stored input from the stored object, not from the client-declared fileSize', async () => {
    const storageKey = `uploads/${users.free}/big.csv`;
    s3Storage.saveObject(storageKey, Buffer.alloc(5 * MIB, 0x61), 'text/csv', 'big.csv');
    const res = await queueJobsRoute(
      jsonRequest('/api/queue/jobs', 'free', { filename: 'big.csv', targetFormat: 'json', storageKey, fileSize: 1 })
    );
    expect(res.status).toBe(200);
    const job = await conversionQueue.getJob((await res.json()).jobId);
    expect(job?.opts.timeout).toBe(60_000 + 5 * 2_000);
  });

  it('POST /api/queue/jobs (multipart upload) uses the size of the uploaded file', async () => {
    const res = await queueJobsRoute(multipart('/api/queue/jobs', 'free', csvForm()));
    expect(res.status).toBe(200);
    const job = await conversionQueue.getJob((await res.json()).jobId);
    expect(job?.opts.timeout).toBe(FREE_CSV_DEADLINE_MS);
  });

  it.each([
    ['free', FREE_CSV_DEADLINE_MS],
    ['pro', PRO_CSV_DEADLINE_MS],
  ])('POST /api/v1/convert with Prefer: respond-async (%s)', async (tier, expected) => {
    const res = await v1ConvertRoute(multipart('/api/v1/convert', tier, csvForm(), { Prefer: 'respond-async' }));
    expect(res.status).toBe(202);
    const job = await conversionQueue.getJob((await res.json()).jobId);
    expect(job?.opts.timeout).toBe(expected);
  });

  it.each([
    ['free', FREE_CSV_DEADLINE_MS],
    ['pro', PRO_CSV_DEADLINE_MS],
  ])('POST /api/v1/jobs single conversion (%s)', async (tier, expected) => {
    const res = await v1JobsRoute(
      jsonRequest('/api/v1/jobs', tier, {
        filename: 'scores.csv',
        targetFormat: 'json',
        inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
      })
    );
    expect(res.status).toBe(202);
    const job = await conversionQueue.getJob((await res.json()).jobId);
    expect(job?.opts.timeout).toBe(expected);
  });

  it('POST /api/v1/jobs gives each node of a graph the maximum of the owner tier: its input size is not known yet', async () => {
    const storageKey = `uploads/${users.pro}/graph.csv`;
    s3Storage.saveObject(storageKey, Buffer.from(CSV_INPUT), 'text/csv', 'graph.csv');
    const res = await v1JobsRoute(
      jsonRequest('/api/v1/jobs', 'pro', {
        graph: {
          nodes: {
            up: { op: 'import.upload', storageKey },
            conv: { op: 'convert', input: 'up', targetFormat: 'json' },
            out: { op: 'export.internal', input: 'conv' },
          },
        },
        storageKey,
        filename: 'graph.csv',
      })
    );
    expect(res.status).toBe(202);
    const graphId = (await res.json()).jobId as string;
    const node = await conversionQueue.getJob(`${graphId}:up`);
    expect(node?.opts.timeout).toBe(PRO_MAX_MS);
  });

  it.each([
    ['POST /api/queue/jobs', '/api/queue/jobs', queueJobsRoute, { filename: 'scores.csv', targetFormat: 'json' }],
    ['POST /api/v1/jobs', '/api/v1/jobs', v1JobsRoute, { filename: 'scores.csv', targetFormat: 'json' }],
  ])('%s answers a generic 500 for an invalid deadline setting, without the setting name', async (_label, url, route, body) => {
    vi.stubEnv('JOB_DEADLINE_PER_MIB_MS', 'abc');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await route(
      jsonRequest(url, 'free', { ...body, inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64') })
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('JOB_DEADLINE');
    expect(text).not.toContain('RangeError');
  });

  it.each([
    ['POST /api/queue/jobs', '/api/queue/jobs', queueJobsRoute, 200],
    ['POST /api/v1/jobs', '/api/v1/jobs', v1JobsRoute, 202],
  ])('%s stores no signal, timeout or deadline from the request options', async (_label, url, route, status) => {
    const res = await route(
      jsonRequest(url, 'free', {
        filename: 'scores.csv',
        targetFormat: 'json',
        inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
        options: { timeoutMs: 999_999_999, signal: {}, deadlineAt: 1, quality: 80 },
      })
    );
    expect(res.status).toBe(status);
    const job = await conversionQueue.getJob((await res.json()).jobId);
    expect(job?.data.options).toEqual({ quality: 80 });
  });

  it('a graph node of an unknown or anonymous owner gets the free maximum', async () => {
    const queue = conversionQueue;
    const base = { op: 'convert', input: 'up', targetFormat: 'json' } as never;
    await enqueueGraphNodeJob('graph_anon', 'a', base, { ownerUserId: 'anon:127.0.0.1' }, []);
    await enqueueGraphNodeJob('graph_nobody', 'a', base, { ownerUserId: 'user_that_does_not_exist' }, []);
    await enqueueGraphNodeJob('graph_noowner', 'a', base, {}, []);
    for (const id of ['graph_anon:a', 'graph_nobody:a', 'graph_noowner:a']) {
      expect((await queue.getJob(id))?.opts.timeout, id).toBe(FREE_MAX_MS);
    }
  });

  it('a graph node of a known pro owner gets the pro maximum', async () => {
    const owner = await redisUserStore.findById(users.pro);
    expect(owner?.tier).toBe('pro');
    await enqueueGraphNodeJob('graph_pro', 'a', { op: 'convert', input: 'up', targetFormat: 'json' } as never, { ownerUserId: users.pro }, []);
    expect((await conversionQueue.getJob('graph_pro:a'))?.opts.timeout).toBe(PRO_MAX_MS);
  });
});
