import Redis from 'ioredis';
import JSZip from 'jszip';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, processConversionJob } from '../src/lib/queue/conversion-queue';
import { graphScheduler, RedisGraphScheduler, type JobGraph } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { clusterKeySlot, crc16Xmodem } from './helpers/redis-cluster-slot';

/**
 * Job graphs on a real Redis server, executed by real queue workers. Runs only when REDIS_URL
 * is set (CI `npm run test:redis`); the scheduler, queues, and workers then all use Redis.
 */
const REDIS_URL = process.env.REDIS_URL;
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const EXPECTED_NAMES = ['Alice', 'Bob'];
const GRAPH_TIMEOUT_MS = 30_000;
const FAN_OUT_WIDTH = 8;
/** Per-test timeout: the graph wait plus time to start and stop workers. */
const E2E_TEST_TIMEOUT_MS = GRAPH_TIMEOUT_MS + 10_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function saveCsvUpload(): string {
  const key = `uploads/${uniqueId('graph-e2e')}/input.csv`;
  s3Storage.saveObject(key, Buffer.from(CSV_INPUT), 'text/csv', 'input.csv', 60 * 60 * 1000);
  return key;
}

describe.skipIf(!REDIS_URL)('Job graph execution on a real Redis server', () => {
  let redis: Redis;
  let workers: Worker<ConversionJobData, ConversionJobResult>[] = [];
  /** Node executions counted by the test itself, keyed by `graphId/nodeId`. */
  const executions = new Map<string, number>();
  /** Nodes whose first attempt throws a transient error. */
  const failFirstAttempt = new Set<string>();

  beforeAll(async () => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    await redis.flushdb();
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
  });

  afterAll(async () => {
    await redis.quit();
  });

  function startWorkers(count: number): void {
    const processor = async (job: Job<ConversionJobData, ConversionJobResult>) => {
      const key = `${job.data.graphId}/${job.data.graphNodeId}`;
      const runs = (executions.get(key) ?? 0) + 1;
      executions.set(key, runs);
      if (runs === 1 && failFirstAttempt.has(key)) {
        throw new Error('transient failure injected by test');
      }
      return processConversionJob(job);
    };
    for (let i = 0; i < count; i++) {
      workers.push(new Worker([...allConversionQueues], processor, { concurrency: 2 }));
    }
  }

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

  async function readResultZip(graphId: string): Promise<JSZip> {
    const state = await graphScheduler.getGraphState(graphId);
    const exportNode = Object.values(state!.nodes).find((n) => n.op === 'export.internal');
    expect(exportNode?.outputs).toHaveLength(1);
    const stored = s3Storage.getObject(exportNode!.outputs[0]);
    expect(stored).toBeDefined();
    return JSZip.loadAsync(stored!.buffer);
  }

  function executionsOf(graphId: string): Record<string, number> {
    return Object.fromEntries(
      [...executions].filter(([k]) => k.startsWith(`${graphId}/`)).map(([k, v]) => [k.slice(graphId.length + 1), v])
    );
  }

  it('runs a diamond graph to completion with every node executed exactly once', async () => {
    const graphId = uniqueId('diamond');
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: { op: 'import.upload', storageKey: saveCsvUpload() },
        b: { op: 'convert', input: 'in', targetFormat: 'json' },
        c: { op: 'convert', input: 'in', targetFormat: 'yaml' },
        d: { op: 'archive.create', input: ['b', 'c'], targetFormat: 'zip' },
        out: { op: 'export.internal', input: 'd' },
      },
    };
    startWorkers(2);
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: 'user-graph-e2e' });

    const state = await waitForTerminal(graphId);
    expect(state.status).toBe('completed');
    expect(executionsOf(graphId)).toEqual({ in: 1, b: 1, c: 1, d: 1, out: 1 });
    // The fan-in node starts only after both of its inputs finished.
    expect(state.nodes.d.startedAt).toBeGreaterThanOrEqual(state.nodes.b.finishedAt!);
    expect(state.nodes.d.startedAt).toBeGreaterThanOrEqual(state.nodes.c.finishedAt!);

    const zip = await readResultZip(graphId);
    expect(Object.keys(zip.files).sort()).toEqual(['input.json', 'input.yaml']);
    const rows = JSON.parse(await zip.file('input.json')!.async('string')) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_NAMES);
    const yaml = await zip.file('input.yaml')!.async('string');
    expect(yaml).toMatch(/name:\s*Alice/);
    expect(yaml).toMatch(/name:\s*Bob/);
  }, E2E_TEST_TIMEOUT_MS);

  it('runs a 1-to-8 fan-out and fan-in with every node executed exactly once', async () => {
    const graphId = uniqueId('fanout');
    const nodes: JobGraph['nodes'] = { in: { op: 'import.upload', storageKey: saveCsvUpload() } };
    const branches = Array.from({ length: FAN_OUT_WIDTH }, (_, i) => `branch_${i}`);
    for (const id of branches) nodes[id] = { op: 'convert', input: 'in', targetFormat: 'json' };
    nodes.bundle = { op: 'archive.create', input: branches, targetFormat: 'zip' };
    nodes.out = { op: 'export.internal', input: 'bundle' };
    startWorkers(2);
    await graphScheduler.initGraph(graphId, { failurePolicy: 'fail_fast', nodes }, { ownerUserId: 'user-graph-e2e' });

    const state = await waitForTerminal(graphId);
    expect(state.status).toBe('completed');
    const runs = executionsOf(graphId);
    expect(Object.keys(runs).sort()).toEqual(['bundle', 'in', 'out', ...branches].sort());
    expect(Object.values(runs).every((n) => n === 1)).toBe(true);

    const zip = await readResultZip(graphId);
    const entries = Object.keys(zip.files);
    expect(entries).toHaveLength(FAN_OUT_WIDTH);
    for (const entry of entries) {
      const rows = JSON.parse(await zip.file(entry)!.async('string')) as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(EXPECTED_NAMES);
    }
  }, E2E_TEST_TIMEOUT_MS);

  it('completes a fail_fast graph when a node fails once and succeeds on retry', async () => {
    const graphId = uniqueId('retry');
    failFirstAttempt.add(`${graphId}/b`);
    const graph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        in: { op: 'import.upload', storageKey: saveCsvUpload() },
        b: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.internal', input: 'b' },
      },
    };
    startWorkers(1);
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: 'user-graph-e2e' });

    const state = await waitForTerminal(graphId);
    expect(state.status).toBe('completed');
    expect(state.failedNodes).toBe(0);
    expect(executionsOf(graphId)).toEqual({ in: 1, b: 2, out: 1 });
  }, E2E_TEST_TIMEOUT_MS);

  describe('scheduler state transitions', () => {
    function isolatedScheduler(client: Redis) {
      return new RedisGraphScheduler({
        redisClient: client,
        keyPrefix: `${uniqueId('graph-unit')}:`,
        enqueueNode: async () => {},
        cancelNode: async () => false,
      });
    }

    const chain: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        a: { op: 'import.upload', storageKey: 'uploads/x/in.csv' },
        b: { op: 'convert', input: 'a', targetFormat: 'json' },
        c: { op: 'export.internal', input: 'b' },
      },
    };

    it('ignores a repeated completion of the same node', async () => {
      const scheduler = isolatedScheduler(redis);
      const graphId = uniqueId('dup');
      const keys = scheduler.graphKeys(graphId);
      await scheduler.initGraph(graphId, chain);

      const first = await scheduler.onNodeCompleted(graphId, 'a', ['k1']);
      const second = await scheduler.onNodeCompleted(graphId, 'a', ['k1']);

      expect(first.readyNodeIds).toEqual(['b']);
      expect(second.readyNodeIds).toEqual([]);
      expect(await redis.hget(keys.graph, 'completedNodes')).toBe('1');
      expect(await redis.hget(keys.deps, 'b')).toBe('0');
      expect(await redis.lrange(keys.outbox, 0, -1)).toEqual([]);
    });

    it('ignores a failure reported for a node that already completed', async () => {
      const scheduler = isolatedScheduler(redis);
      const graphId = uniqueId('late-fail');
      await scheduler.initGraph(graphId, chain);
      await scheduler.onNodeCompleted(graphId, 'a', ['k1']);

      const result = await scheduler.onNodeFailed(graphId, 'a', 'late failure');
      const state = await scheduler.getGraphState(graphId);

      expect(result.graphFailed).toBe(false);
      expect(state?.status).toBe('running');
      expect(state?.nodes.a.status).toBe('completed');
      expect(state?.failedNodes).toBe(0);
    });

    it('keeps every key of each graph script in one cluster slot', async () => {
      expect(crc16Xmodem('123456789')).toBe(0x31c3); // CRC-16/XMODEM check value
      const calls: string[][] = [];
      const recording = new Proxy(redis, {
        get(target, prop, receiver) {
          if (prop === 'eval') {
            return (script: string, numKeys: number, ...args: string[]) => {
              calls.push(args.slice(0, numKeys));
              return target.eval(script, numKeys, ...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const scheduler = isolatedScheduler(recording);
      const graphId = uniqueId('slots');
      await scheduler.initGraph(graphId, chain);
      await scheduler.onNodeStarted(graphId, 'a');
      await scheduler.onNodeCompleted(graphId, 'a', ['k1']);
      await scheduler.onNodeFailed(graphId, 'b', 'boom');
      const other = uniqueId('slots-cancel');
      await scheduler.initGraph(other, chain);
      await scheduler.cancelGraph(other);

      expect(calls.length).toBe(6);
      for (const keys of calls) {
        expect(new Set(keys.map(clusterKeySlot)).size).toBe(1);
      }
    });
  });
});
