import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { GET as listJobs, POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as readJob } from '../src/app/api/v1/jobs/[id]/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { graphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { processNodeJob } from '../src/lib/queue/node-processor';
import type { ConversionEnginePort } from '../src/lib/queue/engine-port';
import { InMemoryTusSessionStore, setTusSessionStore } from '../src/lib/storage/tus-engine';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { FREE_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import { DataParseError, type ConversionJobData, type ConversionJobResult } from '../src/lib/types';

/**
 * A job made of named tasks, through the jobs API with the in-process scheduler and a worker whose converter is a stub (a
 * conversion to YAML fails, any other makes a file of its format), so each outcome is the scheduler's and not an engine's.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const WAIT = { timeout: 20_000, interval: 50 };
const PROBLEM = 'https://api.easyconvert.io/problems/';
const WEBHOOK_URL = 'https://93.184.215.14/hook';
const WEBHOOK_SECRET = 'whsec_named_tasks_test';

const stubEngine: ConversionEnginePort = {
  name: 'stub',
  async convert(_input, _source, target, _options, filename) {
    if (target === 'yaml') throw new DataParseError('The stub cannot read this file.');
    const buffer = Buffer.from(`${target}:${filename}`);
    return { buffer, size: buffer.length, mimeType: 'application/octet-stream', filename: `${filename.replace(/\.[^.]+$/, '')}.${target}` };
  },
};

let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;
const tusStore = new InMemoryTusSessionStore();

beforeAll(() => setTusSessionStore(tusStore));
afterAll(() => setTusSessionStore(null));
afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
});

function startWorker(): void {
  worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, (job) => processNodeJob(job, stubEngine), { concurrency: 2 });
  attachJobLifecycleListeners(worker);
}

async function caller(tier: 'free' | 'pro' = 'pro') {
  const user = userStore.sanitizeUser(await userStore.createUser({ email: `named-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@named.test`, name: 'Named', tier }));
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'named tasks', { scopes: ['convert:write', 'convert:read'] });
  return { userId: user.id, authorization: `Bearer ${secretKey}`, usedToday: async () => (await redisKeyStore.getQuotaUsage(user.id)).usedToday };
}

/** An id of the shape the resumable upload engine hands out. */
function tusId(): string {
  return `tus_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

async function storedCsv(): Promise<string> {
  const key = `uploads/named-${Date.now()}-${crypto.randomBytes(4).toString('hex')}/scores.csv`;
  await s3Storage.saveObject(key, Buffer.from(CSV), 'text/csv', 'scores.csv', 60 * 60 * 1000);
  return key;
}

function post(authorization: string, body: string | Record<string, unknown>): Promise<Response> {
  return createJob(
    new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

async function get(authorization: string, jobId: string) {
  const res = await readJob(new NextRequest(`http://localhost/api/v1/jobs/${jobId}`, { headers: { authorization } }), { params: Promise.resolve({ id: jobId }) });
  return { status: res.status, body: await res.json() };
}

async function waitForEnd(jobId: string): Promise<void> {
  await vi.waitFor(async () => expect(['completed', 'failed', 'cancelled']).toContain((await graphScheduler.getGraphState(jobId))?.status), WAIT);
}

async function convertedTasks(): Promise<Record<string, unknown>> {
  return {
    up: { operation: 'import/upload', storage_key: await storedCsv() },
    'to-json': { operation: 'convert', input: 'up', output_format: 'json' },
    'to-yaml': { operation: 'convert', input: 'up', output_format: 'yaml' },
    pack: { operation: 'archive/create', input: ['to-json', 'to-yaml'], output_format: 'zip' },
    out: { operation: 'export/url', input: 'pack' },
  };
}

describe('a valid named task graph', () => {
  it('runs as one job, reports each task by name with the download URL of its export, and charges one unit for each conversion', async () => {
    startWorker();
    const who = await caller();
    const dispatch = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const tasks = {
      up: { operation: 'import/upload', storage_key: await storedCsv() },
      'to-json': { operation: 'convert', input: 'up', output_format: 'json', options: { pages: '1' } },
      'to-tsv': { operation: 'convert', input: 'up', output_format: 'tsv' },
      pack: { operation: 'archive/create', input: ['to-json', 'to-tsv'], output_format: 'zip' },
      out: { operation: 'export/url', input: 'pack' },
    };

    const accepted = await post(who.authorization, { tasks, webhookUrl: WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET });
    expect(accepted.status).toBe(202);
    const created = await accepted.json();
    expect(Object.keys(created.tasks)).toEqual(['up', 'to-json', 'to-tsv', 'pack', 'out']);
    expect(created.tasks['to-json']).toMatchObject({ operation: 'convert', status: 'waiting', input: ['up'] });

    await waitForEnd(created.jobId);
    await vi.waitFor(async () => expect(await who.usedToday()).toBe(3), WAIT);

    const { status, body } = await get(who.authorization, created.jobId);
    expect(status).toBe(200);
    expect(body.status).toBe('completed');
    expect(body.failedTask).toBeUndefined();
    expect(Object.fromEntries(Object.entries(body.tasks as Record<string, { status: string }>).map(([name, task]) => [name, task.status]))).toEqual({
      up: 'completed',
      'to-json': 'completed',
      'to-tsv': 'completed',
      pack: 'completed',
      out: 'completed',
    });
    expect(body.tasks['pack']).toMatchObject({ operation: 'archive/create', input: ['to-json', 'to-tsv'] });
    expect(body.tasks.out).toMatchObject({ operation: 'export/url', input: ['pack'] });
    expect(body.tasks['to-json'].result).toBeUndefined();

    const [file] = body.tasks.out.result.files as Array<{ filename: string; downloadUrl: string }>;
    expect(body.tasks.out.result.fileCount).toBe(1);
    expect(file.filename).toMatch(/\.zip$/);
    expect(file.downloadUrl.startsWith('/api/storage/file/')).toBe(true);
    const key = decodeURIComponent(file.downloadUrl.slice('/api/storage/file/'.length));
    expect(key.startsWith(`results/${created.jobId}/out/`)).toBe(true);
    const zip = await JSZip.loadAsync((await s3Storage.getObject(key))!.buffer);
    expect(Object.keys(zip.files).sort()).toEqual(['scores.json', 'scores.tsv']);

    // Each node of the graph is the task of its name, and the options reached the node untouched.
    expect((await graphScheduler.getGraphState(created.jobId))?.graph.nodes['to-json']).toMatchObject({ op: 'convert', targetFormat: 'json', options: { pages: '1' } });

    // The job list and the webhook report the same tasks.
    const listed = await listJobs(new NextRequest('http://localhost/api/v1/jobs', { headers: { authorization: who.authorization } }));
    const entry = (await listed.json()).jobs.find((job: { jobId: string }) => job.jobId === created.jobId);
    expect(entry.tasks.out.result.files).toEqual(body.tasks.out.result.files);
    const completedEvent = dispatch.mock.calls.find((call) => call[1] === 'graph.completed');
    expect(completedEvent?.[2]).toMatchObject({ jobId: created.jobId, status: 'completed', tasks: { out: { status: 'completed', result: { fileCount: 1 } } } });
  }, 40_000);

  it('reads an upload named by upload_id, as a top-level uploadId is', async () => {
    startWorker();
    const who = await caller();
    const key = await storedCsv();
    const uploadId = tusId();
    await tusStore.saveSession({ id: uploadId, uploadLength: CSV.length, uploadOffset: CSV.length, metadata: '', parsedMetadata: {}, key, filename: 'scores.csv', mimeType: 'text/csv', ownerUserId: who.userId, createdAt: Date.now(), expiresAt: Date.now() + 60_000, completed: true });

    const accepted = await post(who.authorization, { tasks: { up: { operation: 'import/upload', upload_id: uploadId }, c: { operation: 'convert', input: 'up', output_format: 'json' }, out: { operation: 'export/url', input: 'c' } } });
    expect(accepted.status).toBe(202);
    const { jobId } = await accepted.json();
    expect((await graphScheduler.getGraphState(jobId))?.graph.nodes.up).toMatchObject({ op: 'import.upload', storageKey: key });
    await waitForEnd(jobId);
    expect((await get(who.authorization, jobId)).body.status).toBe('completed');

    const stranger = await caller();
    const refused = await post(stranger.authorization, { tasks: { up: { operation: 'import/upload', upload_id: uploadId }, c: { operation: 'convert', input: 'up', output_format: 'json' }, out: { operation: 'export/url', input: 'c' } } });
    expect(refused.status).toBe(404);
    const missing = await post(who.authorization, { tasks: { up: { operation: 'import/upload', upload_id: tusId() }, out: { operation: 'export/url', input: 'up' } } });
    expect(missing.status).toBe(404);
  }, 40_000);

  it('is accepted as the JSON `tasks` field of a multipart request', async () => {
    startWorker();
    const who = await caller();
    const form = new FormData();
    form.set('tasks', JSON.stringify({ up: { operation: 'import/upload', storage_key: await storedCsv() }, c: { operation: 'convert', input: 'up', output_format: 'json' }, out: { operation: 'export/url', input: 'c' } }));
    const res = await createJob(new NextRequest('http://localhost/api/v1/jobs', { method: 'POST', headers: { authorization: who.authorization }, body: form }));
    expect(res.status).toBe(202);
    expect(Object.keys((await res.json()).tasks)).toEqual(['up', 'c', 'out']);
  });
});

describe('a named task that fails', () => {
  it('fails the job, reports the failed task with its code and the tasks that read it by name, and charges nothing', async () => {
    startWorker();
    const who = await caller();
    const dispatch = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const tasks = {
      up: { operation: 'import/upload', storage_key: await storedCsv() },
      'to-yaml': { operation: 'convert', input: 'up', output_format: 'yaml' },
      pack: { operation: 'archive/create', input: ['to-yaml'], output_format: 'zip' },
      out: { operation: 'export/url', input: 'pack' },
      'to-json': { operation: 'convert', input: 'up', output_format: 'json' },
    };

    const accepted = await post(who.authorization, { tasks, webhookUrl: WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET });
    expect(accepted.status).toBe(202);
    const { jobId } = await accepted.json();
    await waitForEnd(jobId);

    const { body } = await get(who.authorization, jobId);
    expect(body.status).toBe('failed');
    expect(body.failedTask).toBe('to-yaml');
    expect(body.failedReason).toContain('stub cannot read');
    expect(body.tasks['to-yaml']).toMatchObject({ operation: 'convert', status: 'failed', error: { code: 'malformed_input', message: expect.stringContaining('stub cannot read') } });
    const blocked = { code: 'dependency_failed', task: 'to-yaml', message: 'Task "to-yaml" failed, so this task did not run.' };
    expect(body.tasks.pack).toMatchObject({ status: 'failed', error: blocked });
    expect(body.tasks.out).toMatchObject({ status: 'failed', error: blocked });
    expect(body.tasks.up.status).toBe('completed');
    // The conversion that does not read the failed task is stopped by the failure, or had finished: it is not blamed on it.
    expect(['completed', 'cancelled']).toContain(body.tasks['to-json'].status);
    expect(body.tasks['to-json'].error).toBeUndefined();

    const listed = await listJobs(new NextRequest('http://localhost/api/v1/jobs?status=failed', { headers: { authorization: who.authorization } }));
    const entry = (await listed.json()).jobs.find((job: { jobId: string }) => job.jobId === jobId);
    expect(entry).toMatchObject({ status: 'failed', failedTask: 'to-yaml', tasks: { 'to-yaml': { status: 'failed' } } });
    const failedEvent = dispatch.mock.calls.find((call) => call[1] === 'graph.failed');
    expect(failedEvent?.[2]).toMatchObject({ jobId, status: 'failed', failedTask: 'to-yaml', tasks: { out: { error: blocked } } });
    expect(await who.usedToday()).toBe(0);
  }, 40_000);
});

describe('a named task graph that is refused', () => {
  async function refused(body: string | Record<string, unknown>, tier: 'free' | 'pro' = 'pro') {
    const who = await caller(tier);
    const res = await post(who.authorization, body);
    const problem = await res.json();
    expect(await who.usedToday()).toBe(0);
    return { status: res.status, problem, contentType: res.headers.get('content-type') };
  }

  it('names the task whose input does not exist', async () => {
    const tasks = await convertedTasks();
    const { status, problem, contentType } = await refused({ tasks: { ...tasks, out: { operation: 'export/url', input: 'packed' } } });
    expect(status).toBe(422);
    expect(contentType).toContain('application/problem+json');
    expect(problem.type).toBe(`${PROBLEM}task-input-unknown`);
    expect(problem.invalidParams).toEqual([expect.objectContaining({ name: 'tasks.out.input', reason: expect.stringContaining('"packed"') })]);
  });

  it('refuses tasks that read each other in a loop', async () => {
    const { status, problem } = await refused({
      tasks: {
        up: { operation: 'import/upload', storage_key: await storedCsv() },
        a: { operation: 'convert', input: ['up', 'b'], output_format: 'json' },
        b: { operation: 'convert', input: 'a', output_format: 'json' },
        out: { operation: 'export/url', input: 'b' },
      },
    });
    expect(status).toBe(422);
    expect(problem.type).toBe(`${PROBLEM}task-graph-cycle`);
    expect(problem.detail).toMatch(/a -> b -> a|b -> a -> b/);
  });

  it('refuses a name used by two tasks, which JSON alone would merge into the later one', async () => {
    const key = await storedCsv();
    const text = `{"tasks":{"up":{"operation":"import/upload","storage_key":"${key}"},"c":{"operation":"convert","input":"up","output_format":"json"},"c":{"operation":"convert","input":"up","output_format":"tsv"},"out":{"operation":"export/url","input":"c"}}}`;
    const { status, problem } = await refused(text);
    expect(status).toBe(422);
    expect(problem.type).toBe(`${PROBLEM}task-name-duplicate`);
    expect(problem.invalidParams).toEqual([expect.objectContaining({ name: 'tasks.c' })]);
  });

  it.each(['Convert-1', '1st', 'two words', 'x'.repeat(65)])('refuses the name %j', async (name) => {
    const { status, problem } = await refused({ tasks: { [name]: { operation: 'import/url', url: 'https://files.example.com/a.csv' }, out: { operation: 'export/url', input: name } } });
    expect(status).toBe(422);
    expect(problem.type).toBe(`${PROBLEM}task-name-invalid`);
    expect(problem.invalidParams.map((p: { name: string }) => p.name)).toContain(`tasks.${name}`);
  });

  it('refuses more tasks than the plan allows: 8 on the free plan, which the pro plan takes', async () => {
    const key = await storedCsv();
    const many = (count: number) => ({
      tasks: {
        up: { operation: 'import/upload', storage_key: key },
        ...Object.fromEntries(Array.from({ length: count - 2 }, (_, i) => [`c${i}`, { operation: 'convert', input: 'up', output_format: 'json' }])),
        out: { operation: 'export/url', input: 'c0' },
      },
    });
    const free = await refused(many(9), 'free');
    expect(free.status).toBe(422);
    expect(free.problem.type).toBe(`${PROBLEM}task-count-exceeded`);
    expect(free.problem.detail).toContain('9 tasks');

    const pro = await caller('pro');
    expect((await post(pro.authorization, many(9))).status).toBe(202);
  });

  it('refuses a tasks object that names no conversion before anything is reserved', async () => {
    const { status, problem } = await refused({ tasks: { up: { operation: 'import/upload', storage_key: await storedCsv() }, out: { operation: 'export/url', input: 'up' } } });
    expect(status).toBe(422);
    expect(problem.type).toBe(`${PROBLEM}graph-without-conversion`);
  });

  it('words any other fault of a task by the task, with the generic problem', async () => {
    const tasks = await convertedTasks();
    const { status, problem } = await refused({ tasks: { ...tasks, 'to-json': { operation: 'convert', input: 'up' } } });
    expect(status).toBe(422);
    expect(problem.type).toBe(`${PROBLEM}unprocessable-entity`);
    expect(problem.invalidParams.map((p: { name: string }) => p.name)).toContain('tasks.to-json.targetFormat');
  });

  it.each([
    ['an unknown operation', { operation: 'transmute' }],
    ['a field of the graph form', { operation: 'convert', input: 'up', targetFormat: 'json' }],
    ['a task that is not an object', 'convert'],
  ])('refuses %s with the schema failure naming the task', async (_label, task) => {
    const tasks = await convertedTasks();
    const { status, problem } = await refused({ tasks: { ...tasks, 'to-json': task } });
    expect(status).toBe(422);
    expect(problem.type).toBe(`${PROBLEM}unprocessable-entity`);
    expect(problem.invalidParams.some((p: { name: string }) => p.name.startsWith('tasks.to-json'))).toBe(true);
  });

  it('refuses a request that sends both a graph and named tasks', async () => {
    const tasks = await convertedTasks();
    const { status, problem } = await refused({ tasks, graph: { nodes: { a: { op: 'import.upload', storageKey: await storedCsv() }, b: { op: 'export.internal', input: 'a' } } } });
    expect(status).toBe(422);
    expect(problem.invalidParams).toEqual([{ name: 'tasks', reason: 'cannot be combined with graph' }]);
  });
});

describe('the quota of a named task graph', () => {
  it('refuses up front a graph of three conversions when the caller has two left, charging nothing', async () => {
    const who = await caller('free');
    await redisKeyStore.recordUsage(who.userId, FREE_DAILY_CONVERSIONS - 2);
    const key = await storedCsv();
    const res = await post(who.authorization, {
      tasks: {
        up: { operation: 'import/upload', storage_key: key },
        a: { operation: 'convert', input: 'up', output_format: 'json' },
        b: { operation: 'convert', input: 'up', output_format: 'tsv' },
        c: { operation: 'convert', input: 'up', output_format: 'yaml' },
        out: { operation: 'export/url', input: ['a', 'b', 'c'] },
      },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ type: `${PROBLEM}quota-exceeded`, remaining: 2, requiredUnits: 3 });
    expect(await who.usedToday()).toBe(FREE_DAILY_CONVERSIONS - 2);
  });
});

describe('the request shapes that existed before named tasks', () => {
  it('still takes a tasks array and answers it as its stages, with no task report', async () => {
    startWorker();
    const who = await caller();
    const accepted = await post(who.authorization, { storageKey: await storedCsv(), tasks: [{ name: 'c', operation: 'convert', targetFormat: 'json' }] });
    expect(accepted.status).toBe(202);
    const created = await accepted.json();
    expect(created.tasks).toBeUndefined();
    await waitForEnd(created.jobId);
    const { body } = await get(who.authorization, created.jobId);
    expect(body.status).toBe('completed');
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.failedTask).toBeUndefined();
  }, 40_000);

  it('still takes a graph, answered by its nodes, with the graph job `tasks` unset', async () => {
    startWorker();
    const who = await caller();
    const accepted = await post(who.authorization, {
      graph: { nodes: { up: { op: 'import.upload', storageKey: await storedCsv() }, c: { op: 'convert', input: 'up', targetFormat: 'json' }, out: { op: 'export.internal', input: 'c' } } },
    });
    expect(accepted.status).toBe(202);
    const created = await accepted.json();
    expect(created.tasks).toBeUndefined();
    await waitForEnd(created.jobId);
    const { body } = await get(who.authorization, created.jobId);
    expect(body.tasks).toBeUndefined();
    expect(Object.keys(body.nodes).sort()).toEqual(['c', 'out', 'up']);
  }, 40_000);
});
