import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Redis from 'ioredis';
import { DistributedBullMQAdapter, Queue, createQueueEngine } from '../src/lib/queue/bullmq-engine';
import { QueueUnavailableError, EngineUnavailableError, GraphStateCorruptError } from '../src/lib/types';
import { GRAPH_STATE_CORRUPT_PROBLEM_TYPE, QUEUE_RETRY_AFTER_SECONDS, queueErrorResponse } from '../src/lib/api/queue-error-response';
import type { ConversionJobData } from '../src/lib/types';

/**
 * With Redis configured, the queue must never answer from process memory: a write that cannot reach
 * Redis, or a read that cannot ask it, is a typed QueueUnavailableError (503 + Retry-After at the API).
 * Redis is a real ioredis client pointed at a port nothing listens on, so no server is needed.
 */

const LOCALHOST = '127.0.0.1';
/** The acceptance bound: a closed port must fail the request quickly, not hang it. */
const FAIL_CLOSED_BUDGET_MS = 3000;
const BASE_URL = 'http://localhost:3000';
const RETRY_AFTER_MAX_SECONDS = 300;

/** A port that was free a moment ago: bind to an ephemeral port, then release it. */
async function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, LOCALHOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function jobData(userId?: string): ConversionJobData {
  return {
    jobId: '',
    originalFilename: 'down.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: 8,
    options: {},
    inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
    userId,
  };
}

/** The adapter's in-process stand-in queue; it must stay empty while Redis is configured. */
function memoryEngineOf(adapter: object): Queue<ConversionJobData, unknown> {
  return (adapter as { memoryFallback: Queue<ConversionJobData, unknown> }).memoryFallback;
}

async function timed<T>(operation: () => Promise<T>): Promise<{ elapsedMs: number; error: unknown }> {
  const started = Date.now();
  try {
    await operation();
  } catch (error) {
    return { elapsedMs: Date.now() - started, error };
  }
  return { elapsedMs: Date.now() - started, error: undefined };
}

describe('DistributedBullMQAdapter with an unreachable Redis', () => {
  let closedPort: number;
  let adapter: DistributedBullMQAdapter<ConversionJobData, unknown>;
  const waitingEvents: unknown[] = [];

  beforeAll(async () => {
    closedPort = await reserveClosedPort();
    adapter = new DistributedBullMQAdapter<ConversionJobData, unknown>('down-queue', {
      url: `redis://${LOCALHOST}:${closedPort}`,
    });
    adapter.on('waiting', (job) => waitingEvents.push(job));
  });

  afterAll(async () => {
    await adapter.close();
  });

  const operations: Array<[string, () => Promise<unknown>]> = [
    ['add', () => adapter.add('convert', jobData('user-1'))],
    ['getJob', () => adapter.getJob('job_missing')],
    ['getJobs', () => adapter.getJobs(['waiting', 'active'])],
    ['getJobCounts', () => adapter.getJobCounts()],
    ['getJobsByUser', () => adapter.getJobsByUser('user-1', ['waiting'], 10, 0)],
    ['cancelJob', () => adapter.cancelJob('job_missing')],
    ['clean', () => adapter.clean(0, 10, 'completed')],
    ['getDlqEntries', () => adapter.getDlqEntries()],
    ['purgeDlq', () => adapter.purgeDlq()],
  ];

  it.each(operations)('%s throws QueueUnavailableError within the budget', async (_name, operation) => {
    const { elapsedMs, error } = await timed(operation);
    expect(error).toBeInstanceOf(QueueUnavailableError);
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as QueueUnavailableError).engineName).toBe('queue:down-queue');
    expect(elapsedMs).toBeLessThan(FAIL_CLOSED_BUDGET_MS);
  });

  it('never stores a job in, or emits a waiting event from, the in-memory engine', async () => {
    await timed(() => adapter.add('convert', jobData('user-2')));
    const memory = memoryEngineOf(adapter);
    expect(await memory.getJobCounts()).toEqual({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      cancelled: 0,
    });
    expect(await memory.getJobsByUser('user-2')).toEqual([]);
    expect(waitingEvents).toEqual([]);
  });

  it('reports the queue as down through ping instead of answering ok', async () => {
    const result = await adapter.ping();
    expect(result.ok).toBe(false);
  });

  it('fails closed for an injected real ioredis client that cannot connect', async () => {
    const client = new Redis({
      host: LOCALHOST,
      port: closedPort,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    client.on('error', () => {});
    const injected = new DistributedBullMQAdapter<ConversionJobData, unknown>('down-injected', { redisClient: client });
    try {
      const { elapsedMs, error } = await timed(() => injected.add('convert', jobData('user-3')));
      expect(error).toBeInstanceOf(QueueUnavailableError);
      expect(elapsedMs).toBeLessThan(FAIL_CLOSED_BUDGET_MS);
      expect((await memoryEngineOf(injected).getJobCounts()).waiting).toBe(0);
    } finally {
      await injected.close();
    }
  });
});

describe('Queue engine selection without Redis', () => {
  it('keeps the in-memory engine for local development', async () => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    try {
      const engine = createQueueEngine<ConversionJobData, unknown>('local-dev');
      expect(engine).toBeInstanceOf(Queue);
      const job = await engine.add('convert', jobData('local-user'));
      expect((await engine.getJob(job.id))?.id).toBe(job.id);
      expect((await engine.getJobCounts()).waiting).toBe(1);
      expect((await engine.getJobsByUser('local-user')).map((j) => j.id)).toEqual([job.id]);
      await engine.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the in-memory stand-in for a distributed adapter that has no Redis configured', async () => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    try {
      const adapter = new DistributedBullMQAdapter<ConversionJobData, unknown>('zero-config');
      const job = await adapter.add('convert', jobData('zero-user'));
      expect((await adapter.getJob(job.id))?.id).toBe(job.id);
      expect((await adapter.getJobCounts()).waiting).toBe(1);
      await adapter.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('queueErrorResponse', () => {
  it('maps an unavailable queue to 503 with Retry-After and no cause text', async () => {
    const res = queueErrorResponse(
      new QueueUnavailableError('jobs', 'connect ECONNREFUSED 10.0.0.7:6379'),
      '/api/v1/jobs'
    );
    expect(res?.status).toBe(503);
    expect(res?.headers.get('retry-after')).toBe(String(QUEUE_RETRY_AFTER_SECONDS));
    const body = await res?.json();
    expect(body.instance).toBe('/api/v1/jobs');
    expect(JSON.stringify(body)).not.toContain('10.0.0.7');
  });

  it('maps a corrupt graph record to 500 without naming the field or value', async () => {
    const res = queueErrorResponse(new GraphStateCorruptError('Graph g1 has a corrupt scheduler record: field "graph" is missing.'), '/api/v1/jobs/g1');
    expect(res?.status).toBe(500);
    const body = await res?.json();
    expect(body.type).toBe(GRAPH_STATE_CORRUPT_PROBLEM_TYPE);
    expect(JSON.stringify(body)).not.toContain('field "graph"');
  });

  it('leaves every other error to the caller', () => {
    expect(queueErrorResponse(new Error('boom'), '/api/v1/jobs')).toBeUndefined();
  });
});

describe('HTTP routes with an unreachable Redis', () => {
  type RouteModules = {
    queueModule: typeof import('../src/lib/queue/conversion-queue');
    v1Jobs: typeof import('../src/app/api/v1/jobs/route');
    v1JobById: typeof import('../src/app/api/v1/jobs/[id]/route');
    queueJobs: typeof import('../src/app/api/queue/jobs/route');
    queueJobById: typeof import('../src/app/api/queue/jobs/[id]/route');
    queueStats: typeof import('../src/app/api/queue/stats/route');
  };
  let routes: RouteModules;
  let cookie: string;

  beforeAll(async () => {
    vi.resetModules();
    // Sign-in, API keys and quota stay on their in-memory stores so that only the queue sees Redis:
    // these modules are loaded before REDIS_URL is set and stay cached for the routes below.
    const [userModule, sessionModule] = await Promise.all([
      import('../src/lib/auth/user-store'),
      import('../src/lib/auth/session'),
      import('../src/lib/api-keys/redis-key-store'),
      import('../src/lib/api-keys/guard'),
    ]);
    const closedPort = await reserveClosedPort();
    vi.stubEnv('REDIS_URL', `redis://${LOCALHOST}:${closedPort}`);
    const [queueModule, v1Jobs, v1JobById, queueJobs, queueJobById, queueStats] = await Promise.all([
      import('../src/lib/queue/conversion-queue'),
      import('../src/app/api/v1/jobs/route'),
      import('../src/app/api/v1/jobs/[id]/route'),
      import('../src/app/api/queue/jobs/route'),
      import('../src/app/api/queue/jobs/[id]/route'),
      import('../src/app/api/queue/stats/route'),
    ]);
    routes = { queueModule, v1Jobs, v1JobById, queueJobs, queueJobById, queueStats };
    const email = `down_${Date.now()}_${Math.random().toString(36).slice(2)}@queue.test`;
    const user = userModule.userStore.sanitizeUser(
      await userModule.userStore.createUser({ email, name: 'down', tier: 'pro' })
    );
    cookie = `easyconvert_session=${sessionModule.createSessionToken(user)}`;
  });

  afterAll(async () => {
    for (const queue of routes.queueModule.allConversionQueues) {
      await queue.close();
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function request(pathName: string, init: { method?: string; body?: unknown } = {}): NextRequest {
    return new NextRequest(`${BASE_URL}${pathName}`, {
      method: init.method ?? 'GET',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async function expectServiceUnavailable(res: Response, startedAt: number): Promise<void> {
    expect(Date.now() - startedAt).toBeLessThan(FAIL_CLOSED_BUDGET_MS);
    expect(res.status).toBe(503);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RETRY_AFTER_MAX_SECONDS);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.status).toBe(503);
    expect(body.success).toBe(false);
    // The 503 comes from the queue, not from another dependency that happens to be down.
    expect(String(body.detail).toLowerCase()).toContain('queue');
    // The detail never names the Redis endpoint.
    expect(JSON.stringify(body)).not.toContain(LOCALHOST);
  }

  const createBody = {
    filename: 'down.csv',
    targetFormat: 'json',
    inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
    fileSize: 8,
  };

  it('POST /api/v1/jobs answers 503 with Retry-After and enqueues nothing in memory', async () => {
    const started = Date.now();
    const res = await routes.v1Jobs.POST(request('/api/v1/jobs', { method: 'POST', body: createBody }));
    await expectServiceUnavailable(res, started);
    await expectNoMemoryJobs();
  });

  it('POST /api/v1/jobs with a graph answers 503 with Retry-After, not a 500', async () => {
    const started = Date.now();
    const res = await routes.v1Jobs.POST(
      request('/api/v1/jobs', {
        method: 'POST',
        body: {
          targetFormat: 'json',
          graph: {
            nodes: {
              in: { op: 'import.url', url: 'https://files.example.org/in/data.csv' },
              out: { op: 'export.internal', input: 'in' },
            },
          },
        },
      })
    );
    await expectServiceUnavailable(res, started);
    await expectNoMemoryJobs();
  });

  it('POST /api/queue/jobs answers 503 with Retry-After and enqueues nothing in memory', async () => {
    const started = Date.now();
    const res = await routes.queueJobs.POST(
      request('/api/queue/jobs', {
        method: 'POST',
        body: { filename: 'down.csv', targetFormat: 'json', inputBufferBase64: createBody.inputBufferBase64, fileSize: 8 },
      })
    );
    await expectServiceUnavailable(res, started);
    await expectNoMemoryJobs();
  });

  it('GET /api/v1/jobs/{id} answers 503, not 404', async () => {
    const started = Date.now();
    const res = await routes.v1JobById.GET(request('/api/v1/jobs/job_unknown'), {
      params: Promise.resolve({ id: 'job_unknown' }),
    });
    await expectServiceUnavailable(res, started);
  });

  it('DELETE /api/v1/jobs/{id} answers 503, not 404', async () => {
    const started = Date.now();
    const res = await routes.v1JobById.DELETE(request('/api/v1/jobs/job_unknown', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'job_unknown' }),
    });
    await expectServiceUnavailable(res, started);
  });

  it('GET /api/v1/jobs answers 503, not an empty list', async () => {
    const started = Date.now();
    const res = await routes.v1Jobs.GET(request('/api/v1/jobs'));
    await expectServiceUnavailable(res, started);
  });

  it('GET /api/queue/jobs answers 503, not an empty list', async () => {
    const started = Date.now();
    const res = await routes.queueJobs.GET(request('/api/queue/jobs'));
    await expectServiceUnavailable(res, started);
  });

  it('GET and DELETE /api/queue/jobs/{id} answer 503, not 404', async () => {
    const params = { params: Promise.resolve({ id: 'job_unknown' }) };
    const getStarted = Date.now();
    await expectServiceUnavailable(await routes.queueJobById.GET(request('/api/queue/jobs/job_unknown'), params), getStarted);
    const deleteStarted = Date.now();
    await expectServiceUnavailable(
      await routes.queueJobById.DELETE(request('/api/queue/jobs/job_unknown', { method: 'DELETE' }), params),
      deleteStarted
    );
  });

  it('GET /api/queue/stats answers 503, not zero counts', async () => {
    const started = Date.now();
    const res = await routes.queueStats.GET();
    await expectServiceUnavailable(res, started);
  });

  it('does not prove ownership of a job result while the queue is down', async () => {
    const { resolveObjectOwnership } = await import('../src/lib/api-keys/owner-access');
    expect(await resolveObjectOwnership('results/job_1700000000000_abc/out.json')).toEqual({ resolved: false });
    // Namespaces that need no queue lookup are unaffected.
    expect(await resolveObjectOwnership('conversions/user-9/out.json')).toEqual({
      resolved: true,
      ownerUserId: 'user-9',
    });
  });

  async function expectNoMemoryJobs(): Promise<void> {
    for (const queue of routes.queueModule.allConversionQueues) {
      const memory = memoryEngineOf(queue);
      const counts = await memory.getJobCounts();
      expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
    }
  }
});

/** Command names of the RESP arrays in one chunk: an array header, then the bulk string of the name. */
function respCommandNames(text: string): string[] {
  const lines = text.split('\r\n');
  const names: string[] = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i].startsWith('*') && lines[i + 1].startsWith('$')) {
      names.push(lines[i + 2].toUpperCase());
    }
  }
  return names;
}

describe('DistributedBullMQAdapter while its Redis connection is starting', () => {
  /** How long the test server holds the connection handshake before answering it. */
  const HANDSHAKE_DELAY_MS = 300;
  const READY_INFO = '# Server\r\nloading:0\r\n';
  let server: net.Server;
  let port: number;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    // A minimal RESP server (Redis serialization protocol, RESP2): it refuses HELLO so the client
    // stays on RESP2, delays the INFO ready check, answers HGETALL with an empty array and every
    // other command with +OK. One reply per command, since the client pipelines its handshake.
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => {
        for (const command of respCommandNames(chunk.toString('latin1'))) {
          if (command === 'HELLO') {
            socket.write("-ERR unknown command 'hello'\r\n");
          } else if (command === 'INFO') {
            setTimeout(() => socket.write(`$${Buffer.byteLength(READY_INFO)}\r\n${READY_INFO}\r\n`), HANDSHAKE_DELAY_MS);
          } else if (command === 'HGETALL') {
            socket.write('*0\r\n');
          } else {
            socket.write('+OK\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, LOCALHOST, resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('waits for the handshake instead of refusing a request made right after start-up', async () => {
    vi.stubEnv('REDIS_URL', `redis://${LOCALHOST}:${port}`);
    const adapter = new DistributedBullMQAdapter<ConversionJobData, unknown>('starting-queue');
    try {
      const started = Date.now();
      const job = await adapter.getJob('job_absent');
      expect(job).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(HANDSHAKE_DELAY_MS - 50);
      expect((await memoryEngineOf(adapter).getJobCounts()).waiting).toBe(0);
    } finally {
      await adapter.close();
    }
  });
});
