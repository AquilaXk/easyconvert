import dns from 'node:dns';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dispatcher } from 'undici';
import { Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, getQueueForResourceClass, processConversionJob } from '../src/lib/queue/conversion-queue';
import { graphScheduler, InMemoryGraphScheduler, type JobGraph } from '../src/lib/queue/graph';
import { graphNodeJobId } from '../src/lib/queue/graph/node-jobs';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { resolveNodeResourceClass } from '../src/lib/queue/resource-class';
import { SEALED_PREFIX, SecretSealError, unsealJobSecret } from '../src/lib/security/job-secret-seal';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import {
  CUSTOMER_ACCESS_KEY as ACCESS_KEY,
  EMPTY_PAYLOAD_SHA256,
  UNSIGNED_PAYLOAD,
  signCustomerRequest,
  startCustomerStorage,
  type CustomerStorage,
} from './helpers/byos-customer-storage';

/**
 * Graph nodes that import from or export to customer storage carry bearer secrets: signed URLs,
 * URL userinfo and request headers. They must reach the worker, but never sit in plaintext in
 * queued job data, scheduler state or logs. The forwarding dispatcher below sends requests for
 * a public-looking host to a real local server; URL validation and the rest of the stack are real.
 */
const connection = vi.hoisted(() => ({ current: null as Dispatcher | null }));
vi.mock('../src/lib/security/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/ssrf')>();
  const { Dispatcher: BaseDispatcher } = await import('undici');
  class ForwardingDispatcher extends BaseDispatcher {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      if (!connection.current) {
        throw new Error('test did not install a dispatcher');
      }
      return connection.current.dispatch(opts, handler);
    }
  }
  return { ...actual, createSsrfSafeAgent: vi.fn(() => new ForwardingDispatcher()) };
});

const PUBLIC_IP = '93.184.215.14';
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const GRAPH_TIMEOUT_MS = 30_000;
const IN_MEMORY_MODE = !process.env.REDIS_URL;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

// Distinct, recognisable secret bytes that must never appear in any stored or printed form.
const SIGNATURE = 'e3f81c5a97d24b60a1c8f0d39b72e45a';
const BEARER = 'bt-5d7e21c0a9f84433';
const API_KEY = 'ak-91b7c3e5d2f0a4b8';
const DAV_PASSWORD = 'dav-pw-7c19e0b2';
const SIGNED_IMPORT_URL = `https://files.example.org/in/data.csv?X-Amz-Signature=${SIGNATURE}&X-Amz-Credential=${ACCESS_KEY}`;
const DAV_EXPORT_URL = `https://deploy:${DAV_PASSWORD}@dav.example.org/out/result.json`;
const PLAINTEXT_SECRETS = [SIGNATURE, BEARER, API_KEY, DAV_PASSWORD, ACCESS_KEY, 'X-Amz-Signature'];

/** Node jobs these tests put on the shared queues; none may be left for a later test's worker. */
const enqueued: { node: object; jobId: string }[] = [];

function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function expectNoPlaintext(label: string, serialized: string, secrets: readonly string[] = PLAINTEXT_SECRETS): void {
  for (const secret of secrets) {
    expect(serialized.includes(secret), `${label} leaks "${secret}"`).toBe(false);
  }
}

function secretGraph(): JobGraph {
  return {
    failurePolicy: 'fail_fast',
    nodes: {
      in: {
        op: 'import.url',
        url: SIGNED_IMPORT_URL,
        headers: { Authorization: `Bearer ${BEARER}`, 'X-Api-Key': API_KEY },
      },
      out: { op: 'export.url', input: 'in', url: DAV_EXPORT_URL, method: 'PUT', headers: { 'X-Api-Key': API_KEY } },
    },
  };
}

async function queuedJob(graphId: string, nodeId: string, node: object) {
  const queue = getQueueForResourceClass(resolveNodeResourceClass(node));
  const job = await queue.getJob(graphNodeJobId(graphId, nodeId));
  if (!job) {
    throw new Error(`job ${graphNodeJobId(graphId, nodeId)} was not queued`);
  }
  return job;
}

/** Initialises the graph in a fresh scheduler and completes its first node so every node job is queued. */
async function enqueueAllNodes(graphId: string, graph: JobGraph, tasks?: unknown[]) {
  const scheduler = new InMemoryGraphScheduler();
  const initial = await scheduler.initGraph(graphId, graph, { ownerUserId: 'user-seal', tasks });
  await scheduler.onNodeCompleted(graphId, 'in', ['intermediate/key.csv']);
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    enqueued.push({ node, jobId: graphNodeJobId(graphId, nodeId) });
  }
  return { scheduler, initial };
}

/** A job as a worker sees it, carrying `graphNode` in place of the queued one. */
function workerJob(
  queued: Job<ConversionJobData, ConversionJobResult>,
  graphNode: object
): Job<ConversionJobData, ConversionJobResult> {
  return {
    id: queued.id,
    data: { ...queued.data, graphNode },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

function serializedJob(job: Job<ConversionJobData, ConversionJobResult>): string {
  return JSON.stringify({ name: job.name, data: job.data, opts: job.opts, logs: job.logs, failedReason: job.failedReason });
}

beforeEach(() => {
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  connection.current = null;
  for (const { node, jobId } of enqueued.splice(0)) {
    await getQueueForResourceClass(resolveNodeResourceClass(node)).cancelJob(jobId, 'test cleanup');
  }
});

// Redis keeps jobs between test files, and a worker would run another file's leftovers: this file
// covers the in-memory queue, and byos-secret-sealing-redis.test.ts covers Redis.
describe.skipIf(!IN_MEMORY_MODE)('sealing of BYOS secrets in queued job data', () => {
  it('keeps signed URLs, userinfo and headers out of job data and scheduler state', async () => {
    const graphId = uniqueId('seal');
    const graph = secretGraph();
    const tasks = [{ name: 'upload', operation: 'export/url', url: DAV_EXPORT_URL }];

    const { scheduler, initial } = await enqueueAllNodes(graphId, graph, tasks);

    expectNoPlaintext('returned state', JSON.stringify(initial));
    expectNoPlaintext('scheduler state', JSON.stringify(await scheduler.getGraphState(graphId)));
    for (const nodeId of ['in', 'out']) {
      const job = await queuedJob(graphId, nodeId, graph.nodes[nodeId]);
      expectNoPlaintext(`queued job ${nodeId}`, serializedJob(job));
      expect((job.data.graphNode as { sealed?: string }).sealed?.startsWith(SEALED_PREFIX)).toBe(true);
    }
    // The caller's graph is not rewritten behind its back.
    expect((graph.nodes.in as { url?: string }).url).toBe(SIGNED_IMPORT_URL);
  });

  it('seals every secret field of a node under that node\'s job id', async () => {
    const graphId = uniqueId('seal-id');
    const graph = secretGraph();
    await enqueueAllNodes(graphId, graph);
    const job = await queuedJob(graphId, 'in', graph.nodes.in);
    const sealed = (job.data.graphNode as { sealed: string }).sealed;

    expect(JSON.parse(unsealJobSecret(sealed, graphNodeJobId(graphId, 'in')))).toEqual({
      url: SIGNED_IMPORT_URL,
      headers: { Authorization: `Bearer ${BEARER}`, 'X-Api-Key': API_KEY },
    });
    expect(() => unsealJobSecret(sealed, graphNodeJobId(graphId, 'out'))).toThrow(SecretSealError);
  });

  it('keeps display-only task records free of plaintext URL secrets', async () => {
    const graphId = uniqueId('seal-tasks');
    const { scheduler } = await enqueueAllNodes(graphId, secretGraph(), [
      { name: 'upload', operation: 'export/url', url: DAV_EXPORT_URL },
    ]);
    const state = await scheduler.getGraphState(graphId);
    expect(state?.tasks).toEqual([{ name: 'upload', operation: 'export/url', url: 'https://***@dav.example.org/out/result.json' }]);
  });
});

describe.skipIf(!IN_MEMORY_MODE)('unsealing in the worker', () => {
  function recordingStorage(): IStorageBackend {
    return {
      providerName: 'test-recording',
      saveObjectFromStream: async () => {
        throw new Error('the worker must not store anything for a refused node');
      },
    } as unknown as IStorageBackend;
  }

  async function dispatchesFor(run: () => Promise<unknown>): Promise<{ error: unknown; dispatches: number }> {
    let dispatches = 0;
    connection.current = new (class extends Dispatcher {
      dispatch(): boolean {
        dispatches++;
        throw new Error('no outbound request may be made');
      }
    })();
    let error: unknown;
    try {
      await run();
    } catch (err) {
      error = err;
    }
    return { error, dispatches };
  }

  it('fails the job with a typed error, before any request, when a sealed blob is replayed into another job', async () => {
    const graphId = uniqueId('replay');
    const graph = secretGraph();
    await enqueueAllNodes(graphId, graph);
    const importJob = await queuedJob(graphId, 'in', graph.nodes.in);
    const exportSealed = unsealSource(await queuedJob(graphId, 'out', graph.nodes.out));
    const replayed = workerJob(importJob, { op: 'import.url', sealed: exportSealed });

    const { error, dispatches } = await dispatchesFor(() => processGraphNodeJob(replayed, undefined, recordingStorage()));
    expect(error).toBeInstanceOf(SecretSealError);
    expect((error as SecretSealError).code).toBe('AUTHENTICATION_FAILED');
    expect(dispatches).toBe(0);
  });

  function unsealSource(job: Job<ConversionJobData, ConversionJobResult>): string {
    return (job.data.graphNode as { sealed: string }).sealed;
  }

  it('fails the job with a typed error, before any request, when the sealed blob was tampered with', async () => {
    const graphId = uniqueId('tamper');
    const graph = secretGraph();
    await enqueueAllNodes(graphId, graph);
    const job = await queuedJob(graphId, 'in', graph.nodes.in);
    const [, , nonce, tag, ciphertext] = unsealSource(job).split(':');
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] ^= 0x01;
    const tampered = `${SEALED_PREFIX}${nonce}:${tag}:${flipped.toString('base64')}`;
    const forged = workerJob(job, { op: 'import.url', sealed: tampered });

    const { error, dispatches } = await dispatchesFor(() => processGraphNodeJob(forged, undefined, recordingStorage()));
    expect(error).toBeInstanceOf(SecretSealError);
    expect((error as SecretSealError).code).toBe('AUTHENTICATION_FAILED');
    expect(dispatches).toBe(0);
  });

  it('refuses a node that still carries plaintext secrets instead of using them', async () => {
    const graphId = uniqueId('plain');
    const graph = secretGraph();
    await enqueueAllNodes(graphId, graph);
    const job = await queuedJob(graphId, 'in', graph.nodes.in);
    const plain = workerJob(job, { op: 'import.url', url: SIGNED_IMPORT_URL });

    const { error, dispatches } = await dispatchesFor(() => processGraphNodeJob(plain, undefined, recordingStorage()));
    expect(error).toBeInstanceOf(SecretSealError);
    expect((error as SecretSealError).code).toBe('UNSEALED_SECRET');
    expect((error as Error).message).not.toContain(SIGNATURE);
    expect(dispatches).toBe(0);
  });
});

describe.skipIf(!IN_MEMORY_MODE)('import -> convert -> export against customer storage', () => {
  let customer: CustomerStorage;
  let stub: CustomerStorage['stub'];
  let workers: Worker<ConversionJobData, ConversionJobResult>[] = [];
  const consoleOutput: string[] = [];

  beforeEach(async () => {
    consoleOutput.length = 0;
    for (const method of CONSOLE_METHODS) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
      });
    }
    customer = await startCustomerStorage();
    connection.current = customer.agent;
    stub = customer.stub;
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
    await customer.close();
  });

  async function waitForTerminal(graphId: string) {
    await vi.waitFor(
      async () => {
        const state = await graphScheduler.getGraphState(graphId);
        expect(TERMINAL_STATUSES.has(state?.status ?? '')).toBe(true);
      },
      { timeout: GRAPH_TIMEOUT_MS, interval: 50 }
    );
    return (await graphScheduler.getGraphState(graphId))!;
  }

  it('imports and exports with the customer credentials while no plaintext is stored or logged', async () => {
    stub.objects.set('in/people.csv', { body: Buffer.from(CSV_INPUT), contentType: 'text/csv', etag: '"x"' });
    const importAuth = signCustomerRequest('GET', 'in/people.csv', EMPTY_PAYLOAD_SHA256);
    const exportAuth = signCustomerRequest('PUT', 'out/people.json', UNSIGNED_PAYLOAD);
    const graphId = uniqueId('byos-e2e');
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: { op: 'import.url', url: importAuth.url, headers: importAuth.headers },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.url', input: 'conv', url: exportAuth.url, method: 'PUT', headers: exportAuth.headers },
      },
    };
    // Intermediate artifacts are deleted when the graph completes, so keep the converted bytes as they are written.
    const convertedBytes: Buffer[] = [];
    const saveObject = s3Storage.saveObject.bind(s3Storage);
    vi.spyOn(s3Storage, 'saveObject').mockImplementation((key, buffer, ...rest) => {
      if (key.startsWith(`intermediate/${graphId}/conv/`)) {
        convertedBytes.push(Buffer.from(buffer));
      }
      return saveObject(key, buffer, ...rest);
    });
    workers.push(new Worker([...allConversionQueues], processConversionJob, { concurrency: 2 }));
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: 'user-byos-e2e' });

    const state = await waitForTerminal(graphId);
    expect(state.status).toBe('completed');

    // The stub verified both SigV4 signatures independently; the worker used the customer's key.
    expect(stub.requests.map((r) => [r.method, r.key, r.auth.ok, r.auth.accessKeyId])).toEqual([
      ['GET', 'in/people.csv', true, ACCESS_KEY],
      ['PUT', 'out/people.json', true, ACCESS_KEY],
    ]);

    const uploaded = stub.objects.get('out/people.json');
    expect(uploaded).toBeDefined();
    const rows = JSON.parse(uploaded!.body.toString('utf8')) as { name: string; score: unknown }[];
    expect(rows.map((r) => [r.name, String(r.score)])).toEqual([
      ['Alice', '100'],
      ['Bob', '95'],
    ]);
    expect(convertedBytes).toHaveLength(1);
    expect(sha256(uploaded!.body)).toBe(sha256(convertedBytes[0]));

    const secrets = [importAuth.signature, exportAuth.signature, ...PLAINTEXT_SECRETS.filter((s) => s !== ACCESS_KEY)];
    expectNoPlaintext('final state', JSON.stringify(state), [...secrets, ACCESS_KEY]);
    for (const nodeId of ['in', 'conv', 'out']) {
      const job = await queuedJob(graphId, nodeId, graph.nodes[nodeId]);
      expectNoPlaintext(`job ${nodeId}`, serializedJob(job), [...secrets, ACCESS_KEY]);
    }
    expectNoPlaintext('console output', consoleOutput.join('\n'), [...secrets, ACCESS_KEY]);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('fails the node with the remote status, naming no secret, when the customer credentials are wrong', async () => {
    stub.objects.set('in/people.csv', { body: Buffer.from(CSV_INPUT), contentType: 'text/csv', etag: '"x"' });
    const importAuth = signCustomerRequest('GET', 'in/people.csv', EMPTY_PAYLOAD_SHA256);
    const forged = importAuth.headers.authorization.replace(/Signature=[0-9a-f]{64}/, `Signature=${'0'.repeat(64)}`);
    const graphId = uniqueId('byos-bad-credentials');
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: { op: 'import.url', url: importAuth.url, headers: { ...importAuth.headers, authorization: forged } },
        out: { op: 'export.internal', input: 'in' },
      },
    };
    await enqueueAllNodes(graphId, graph);
    const job = await queuedJob(graphId, 'in', graph.nodes.in);
    const storage = { providerName: 'test-recording', saveObjectFromStream: async () => ({}) } as unknown as IStorageBackend;

    let failure: unknown;
    try {
      await processGraphNodeJob(workerJob(job, job.data.graphNode as object), undefined, storage);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/HTTP 403/);
    expectNoPlaintext('error', `${(failure as Error).message}\n${(failure as Error).stack}`, [importAuth.signature, forged]);
    expect(stub.requests.map((r) => [r.method, r.auth.ok])).toEqual([['GET', false]]);
  });
});
