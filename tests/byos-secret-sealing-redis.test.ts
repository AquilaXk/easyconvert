import dns from 'node:dns';
import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, processConversionJob } from '../src/lib/queue/conversion-queue';
import { graphScheduler, type JobGraph } from '../src/lib/queue/graph';
import { SEALED_PREFIX } from '../src/lib/security/job-secret-seal';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import {
  CUSTOMER_ACCESS_KEY,
  EMPTY_PAYLOAD_SHA256,
  UNSIGNED_PAYLOAD,
  signCustomerRequest,
  startCustomerStorage,
  type CustomerStorage,
} from './helpers/byos-customer-storage';

/**
 * The same guarantees as byos-secret-sealing.test.ts, checked on the bytes a real Redis server
 * holds: every key of the database is read back and searched for the secret strings. Runs only
 * when REDIS_URL is set (the queues and the scheduler then use Redis), like the other Redis suites.
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

const REDIS_URL = process.env.REDIS_URL;
const PUBLIC_IP = '93.184.215.14';
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const GRAPH_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const QUERY_TOKEN = 'qt-7f3a91c04be25d68';
const PASSWORD = 'pw-4e8a1c7d93b2';
const BEARER = 'bt-0c4e88a1d7b2f395';

function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Every key of the database with all its stored text, read with the command that fits its type. */
async function dumpKeyspace(redis: Redis): Promise<Map<string, string>> {
  const dump = new Map<string, string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      const type = await redis.type(key);
      switch (type) {
        case 'string':
          dump.set(key, (await redis.get(key)) ?? '');
          break;
        case 'hash':
          dump.set(key, JSON.stringify(await redis.hgetall(key)));
          break;
        case 'list':
          dump.set(key, JSON.stringify(await redis.lrange(key, 0, -1)));
          break;
        case 'set':
          dump.set(key, JSON.stringify(await redis.smembers(key)));
          break;
        case 'zset':
          dump.set(key, JSON.stringify(await redis.zrange(key, '0', '-1', 'WITHSCORES')));
          break;
        case 'none':
          break;
        default:
          throw new Error(`dumpKeyspace cannot read key type "${type}" of ${key}`);
      }
    }
  } while (cursor !== '0');
  return dump;
}

function expectNoSecretsInKeyspace(dump: Map<string, string>, secrets: readonly string[]): void {
  for (const [key, text] of dump) {
    for (const secret of secrets) {
      expect(text.includes(secret), `Redis key ${key} holds "${secret}"`).toBe(false);
    }
  }
}

describe.skipIf(!REDIS_URL)('BYOS secrets on a real Redis server', () => {
  let redis: Redis;
  let customer: CustomerStorage;
  let workers: Worker<ConversionJobData, ConversionJobResult>[] = [];

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
    customer = await startCustomerStorage();
    connection.current = customer.agent;
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
    connection.current = null;
    await customer.close();
    vi.restoreAllMocks();
  });

  async function waitForTerminal(graphId: string) {
    await vi.waitFor(
      async () => {
        const state = await graphScheduler.getGraphState(graphId);
        expect(TERMINAL_STATUSES.has(state?.status ?? '')).toBe(true);
      },
      { timeout: GRAPH_TIMEOUT_MS, interval: 100 }
    );
    return (await graphScheduler.getGraphState(graphId))!;
  }

  it('holds only sealed secrets in the graph, queue and task keys, before and after the run', async () => {
    customer.stub.objects.set('in/people.csv', { body: Buffer.from(CSV_INPUT), contentType: 'text/csv', etag: '"x"' });
    const importAuth = signCustomerRequest('GET', 'in/people.csv', EMPTY_PAYLOAD_SHA256);
    const exportAuth = signCustomerRequest('PUT', 'out/people.json', UNSIGNED_PAYLOAD);
    const graphId = uniqueId('byos-redis');
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: {
          op: 'import.url',
          url: importAuth.url,
          headers: { ...importAuth.headers, 'x-extra-credential': `Bearer ${BEARER}` },
        },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.url', input: 'conv', url: exportAuth.url, method: 'PUT', headers: exportAuth.headers },
      },
    };
    const secrets = [
      importAuth.signature,
      exportAuth.signature,
      QUERY_TOKEN,
      BEARER,
      CUSTOMER_ACCESS_KEY,
      'X-Amz-Signature',
    ];
    const tasks = [{ name: 'upload', operation: 'export/url', url: `${exportAuth.url}?token=${QUERY_TOKEN}` }];

    // The display-only task record carries a URL token; the signed headers authenticate the real nodes.
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: 'user-byos-redis', tasks });

    const beforeRun = await dumpKeyspace(redis);
    const graphKeys = [...beforeRun].filter(([key]) => key.includes(graphId));
    expect(graphKeys.length).toBeGreaterThan(0);
    expect(graphKeys.some(([, text]) => text.includes(SEALED_PREFIX))).toBe(true);
    expectNoSecretsInKeyspace(beforeRun, secrets);

    workers.push(new Worker([...allConversionQueues], processConversionJob, { concurrency: 2 }));
    const state = await waitForTerminal(graphId);
    expect(state.status).toBe('completed');
    expect(customer.stub.requests.map((r) => [r.method, r.auth.ok, r.auth.accessKeyId])).toEqual([
      ['GET', true, CUSTOMER_ACCESS_KEY],
      ['PUT', true, CUSTOMER_ACCESS_KEY],
    ]);

    expectNoSecretsInKeyspace(await dumpKeyspace(redis), secrets);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('masks failure reasons, stack traces, logs and dead-letter entries in Redis after a failed run', async () => {
    customer.stub.objects.set('in/people.csv', { body: Buffer.from(CSV_INPUT), contentType: 'text/csv', etag: '"x"' });
    const importAuth = signCustomerRequest('GET', 'in/people.csv', EMPTY_PAYLOAD_SHA256);
    const graphId = uniqueId('byos-redis-fail');
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: { op: 'import.url', url: importAuth.url, headers: importAuth.headers },
        out: { op: 'export.internal', input: 'in' },
      },
    };
    // Storage fails the way an SDK or a remote might: quoting the request it made.
    const leaky = `upstream rejected https://deploy:${PASSWORD}@h.example/obj?X-Amz-Signature=${QUERY_TOKEN} with Authorization: Bearer ${BEARER}`;
    vi.spyOn(s3Storage, 'saveObjectFromStream').mockImplementation(async (_key, stream) => {
      (stream as NodeJS.ReadableStream).resume();
      throw new Error(leaky);
    });
    workers.push(new Worker([...allConversionQueues], processConversionJob, { concurrency: 2 }));
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: 'user-byos-redis' });

    const state = await waitForTerminal(graphId);
    expect(state.status).toBe('failed');

    const masked = 'upstream rejected https://***@h.example/obj?*** with Authorization: ***';
    const dump = await dumpKeyspace(redis);
    expectNoSecretsInKeyspace(dump, [PASSWORD, QUERY_TOKEN, BEARER]);
    // The dead-letter list is shared by every run, so pick this run's entry by its job id.
    const deadLetterEntries = [...dump]
      .filter(([key]) => key.endsWith(':dlq'))
      .flatMap(([, text]) => (JSON.parse(text) as string[]).map((raw) => JSON.parse(raw) as { jobId: string; failedReason: string }));
    expect(deadLetterEntries.filter((entry) => entry.jobId === `${graphId}:in`)).toEqual([
      expect.objectContaining({ jobId: `${graphId}:in`, failedReason: masked }),
    ]);
    const jobKey = [...dump].find(([key]) => key.endsWith(`${graphId}:in`) && key.includes('job'));
    expect(JSON.parse(jobKey![1])).toMatchObject({ state: 'failed', failedReason: masked });
  }, GRAPH_TIMEOUT_MS + 10_000);
});
