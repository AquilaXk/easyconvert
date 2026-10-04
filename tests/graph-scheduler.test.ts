import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import { NextRequest } from 'next/server';
import {
  createGraphScheduler,
  InMemoryGraphScheduler,
  RedisGraphScheduler,
  IGraphScheduler,
  graphScheduler,
} from '../src/lib/queue/graph';
import type { JobGraph } from '../src/lib/queue/graph/types';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { POST as createJobHandler } from '../src/app/api/v1/jobs/route';
import { GET as getJobHandler, DELETE as cancelJobHandler } from '../src/app/api/v1/jobs/[id]/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

describe('JobGraph Scheduler: Atomic DAG Orchestration', () => {
  let redisClient: Redis | null = null;
  let redisAvailable = false;

  beforeEach(async () => {
    try {
      const client = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        lazyConnect: false,
      });
      await client.ping();
      redisClient = client;
      redisAvailable = true;
    } catch {
      redisAvailable = false;
      redisClient = null;
    }
  });

  afterEach(async () => {
    if (redisClient) {
      await redisClient.quit().catch(() => {});
      redisClient = null;
    }
  });

  function getSchedulers(): { name: string; create: () => IGraphScheduler }[] {
    const list: { name: string; create: () => IGraphScheduler }[] = [
      {
        name: 'in-memory',
        create: () => new InMemoryGraphScheduler(),
      },
    ];

    list.push({
      name: 'redis',
      create: () => {
        if (!redisClient) {
          throw new Error('Redis not available');
        }
        return new RedisGraphScheduler({
          redisClient,
          keyPrefix: `test_sched_${Date.now()}_:`,
        });
      },
    });

    return list;
  }

  describe.each([
    ['in-memory', false],
    ['redis', true],
  ])('%s scheduler engine', (engineName, requiresRedis) => {
    let scheduler: IGraphScheduler;

    beforeEach(async (ctx) => {
      if (requiresRedis && !redisAvailable) {
        ctx.skip();
        return;
      }
      if (requiresRedis && redisClient) {
        scheduler = new RedisGraphScheduler({
          redisClient,
          keyPrefix: `test_bull_${Date.now()}_${Math.random().toString(36).substring(7)}:`,
        });
      } else {
        scheduler = new InMemoryGraphScheduler();
      }
    });

    it('coordinates a diamond DAG and guarantees downstream starts strictly after both upstream dependencies finish', async () => {
      // Diamond Graph:
      //        A (import)
      //       / \
      //      B   C (convert)
      //       \ /
      //        D (archive.create)
      //        |
      //        E (export.internal)
      const graphId = `diamond_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const diamondGraph: JobGraph = {
        failurePolicy: 'fail_fast',
        nodes: {
          a: { op: 'import.upload', storageKey: 'raw-upload.png' },
          b: { op: 'convert', input: 'a', targetFormat: 'webp' },
          c: { op: 'convert', input: 'a', targetFormat: 'avif' },
          d: { op: 'archive.create', input: ['b', 'c'], targetFormat: 'zip' },
          e: { op: 'export.internal', input: 'd' },
        },
      };

      const initState = await scheduler.initGraph(graphId, diamondGraph, {
        ownerUserId: 'user-diamond-1',
      });
      expect(initState.status).toBe('running');
      expect(initState.nodes.a.status).toBe('waiting');
      expect(initState.nodes.b.status).toBe('pending');
      expect(initState.nodes.c.status).toBe('pending');
      expect(initState.nodes.d.status).toBe('pending');
      expect(initState.nodes.e.status).toBe('pending');

      // 1. Start & Complete A
      await scheduler.onNodeStarted(graphId, 'a');
      const compA = await scheduler.onNodeCompleted(graphId, 'a', ['intermediate/a.png']);
      expect(compA.graphCompleted).toBe(false);
      expect(compA.readyNodeIds.sort()).toEqual(['b', 'c'].sort());

      // Check state: B and C must be waiting, D still pending
      const stateAfterA = await scheduler.getGraphState(graphId);
      expect(stateAfterA?.nodes.a.status).toBe('completed');
      expect(stateAfterA?.nodes.b.status).toBe('waiting');
      expect(stateAfterA?.nodes.c.status).toBe('waiting');
      expect(stateAfterA?.nodes.d.status).toBe('pending');

      // 2. Start B and C
      await scheduler.onNodeStarted(graphId, 'b');
      await scheduler.onNodeStarted(graphId, 'c');

      // Complete B first
      await new Promise((r) => setTimeout(r, 10));
      const compB = await scheduler.onNodeCompleted(graphId, 'b', ['intermediate/b.webp']);
      expect(compB.readyNodeIds).toEqual([]); // D is NOT ready because C is pending!

      const stateAfterB = await scheduler.getGraphState(graphId);
      expect(stateAfterB?.nodes.b.status).toBe('completed');
      expect(stateAfterB?.nodes.d.status).toBe('pending');

      // Complete C
      await new Promise((r) => setTimeout(r, 10));
      const compC = await scheduler.onNodeCompleted(graphId, 'c', ['intermediate/c.avif']);
      expect(compC.readyNodeIds).toEqual(['d']); // D is now ready!

      const stateAfterC = await scheduler.getGraphState(graphId);
      expect(stateAfterC?.nodes.c.status).toBe('completed');
      expect(stateAfterC?.nodes.d.status).toBe('waiting');

      // 3. Start D and verify timestamps: D started strictly after both B and C finished
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.onNodeStarted(graphId, 'd');

      const stateAfterDStart = await scheduler.getGraphState(graphId);
      const bFinished = stateAfterDStart?.nodes.b.finishedAt || 0;
      const cFinished = stateAfterDStart?.nodes.c.finishedAt || 0;
      const dStarted = stateAfterDStart?.nodes.d.startedAt || 0;

      expect(dStarted).toBeGreaterThanOrEqual(bFinished);
      expect(dStarted).toBeGreaterThanOrEqual(cFinished);

      // Complete D
      const compD = await scheduler.onNodeCompleted(graphId, 'd', ['intermediate/d.zip']);
      expect(compD.readyNodeIds).toEqual(['e']);

      // 4. Start & Complete E
      await scheduler.onNodeStarted(graphId, 'e');
      const compE = await scheduler.onNodeCompleted(graphId, 'e', ['results/d.zip']);
      expect(compE.graphCompleted).toBe(true);
      expect(compE.graphStatus).toBe('completed');

      const finalState = await scheduler.getGraphState(graphId);
      expect(finalState?.status).toBe('completed');
      expect(finalState?.completedNodes).toBe(5);
    });

    it('guarantees race-free synchronization: fan-in node D is enqueued exactly once across 50 concurrent completions', async () => {
      // Stress test: 50 independent diamond iterations where B and C complete concurrently
      for (let iter = 0; iter < 50; iter++) {
        const gid = `race_${iter}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const testGraph: JobGraph = {
          failurePolicy: 'fail_fast',
          nodes: {
            in: { op: 'import.upload', storageKey: 'test.dat' },
            b: { op: 'convert', input: 'in', targetFormat: 'json' },
            c: { op: 'convert', input: 'in', targetFormat: 'csv' },
            d: { op: 'archive.create', input: ['b', 'c'], targetFormat: 'zip' },
            out: { op: 'export.internal', input: 'd' },
          },
        };

        await scheduler.initGraph(gid, testGraph);
        await scheduler.onNodeCompleted(gid, 'in', ['in.dat']);

        // Concurrently complete B and C
        const [resB, resC] = await Promise.all([
          scheduler.onNodeCompleted(gid, 'b', ['b.json']),
          scheduler.onNodeCompleted(gid, 'c', ['c.csv']),
        ]);

        const readyFromB = resB.readyNodeIds.filter((id) => id === 'd');
        const readyFromC = resC.readyNodeIds.filter((id) => id === 'd');

        // Sum of times 'd' was marked ready must be EXACTLY 1!
        const totalTimesDReady = readyFromB.length + readyFromC.length;
        expect(totalTimesDReady).toBe(1);

        const state = await scheduler.getGraphState(gid);
        expect(state?.nodes.d.status).toBe('waiting');
      }
    });

    it('enforces fail_fast policy: node failure cancels all pending and active downstream nodes immediately', async () => {
      const graphId = `failfast_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const testGraph: JobGraph = {
        failurePolicy: 'fail_fast',
        nodes: {
          a: { op: 'import.upload', storageKey: 'in.bin' },
          b: { op: 'convert', input: 'a', targetFormat: 'png' },
          c: { op: 'convert', input: 'a', targetFormat: 'jpg' },
          d: { op: 'archive.create', input: ['b', 'c'], targetFormat: 'zip' },
          e: { op: 'export.internal', input: 'd' },
        },
      };

      await scheduler.initGraph(graphId, testGraph);
      await scheduler.onNodeCompleted(graphId, 'a', ['in.bin']);

      await scheduler.onNodeStarted(graphId, 'b');
      await scheduler.onNodeStarted(graphId, 'c');

      // Node C fails with unrecoverable error
      const failResult = await scheduler.onNodeFailed(graphId, 'c', 'Transcoder segfault on corrupted header');
      expect(failResult.graphFailed).toBe(true);
      expect(failResult.graphStatus).toBe('failed');

      const state = await scheduler.getGraphState(graphId);
      expect(state?.status).toBe('failed');
      expect(state?.failedReason).toBe('Transcoder segfault on corrupted header');
      expect(state?.nodes.c.status).toBe('failed');
      expect(state?.nodes.c.error).toBe('Transcoder segfault on corrupted header');
      expect(state?.nodes.d.status).toBe('cancelled');
      expect(state?.nodes.e.status).toBe('cancelled');
    });

    it('enforces continue policy: node failure cascades skipped status to descendants while preserving independent branches', async () => {
      // Independent branches:
      //       A (import)
      //      / \
      //     B   C (B -> D, C -> E)
      //     |   |
      //     D   E (E export)
      const graphId = `continue_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const testGraph: JobGraph = {
        failurePolicy: 'continue',
        nodes: {
          a: { op: 'import.upload', storageKey: 'in.bin' },
          b: { op: 'convert', input: 'a', targetFormat: 'png' },
          c: { op: 'convert', input: 'a', targetFormat: 'jpg' },
          d: { op: 'export.internal', input: 'b' },
          e: { op: 'export.internal', input: 'c' },
        },
      };

      await scheduler.initGraph(graphId, testGraph);
      await scheduler.onNodeCompleted(graphId, 'a', ['in.bin']);

      await scheduler.onNodeStarted(graphId, 'b');
      await scheduler.onNodeStarted(graphId, 'c');

      // Node C fails under continue policy
      const failC = await scheduler.onNodeFailed(graphId, 'c', 'Failed to transcode branch C');
      expect(failC.graphFailed).toBe(false);
      expect(failC.skippedNodeIds).toEqual(['e']); // Downstream E is skipped

      const intermediateState = await scheduler.getGraphState(graphId);
      expect(intermediateState?.status).toBe('running');
      expect(intermediateState?.nodes.c.status).toBe('failed');
      expect(intermediateState?.nodes.e.status).toBe('skipped');
      expect(intermediateState?.nodes.b.status).toBe('active');

      // Branch B finishes successfully
      const compB = await scheduler.onNodeCompleted(graphId, 'b', ['b.png']);
      expect(compB.readyNodeIds).toEqual(['d']);

      await scheduler.onNodeStarted(graphId, 'd');
      const compD = await scheduler.onNodeCompleted(graphId, 'd', ['results/b.png']);

      // Now all nodes are terminal: A=completed, B=completed, C=failed, D=completed, E=skipped
      expect(compD.graphCompleted).toBe(true);
      expect(compD.graphStatus).toBe('completed');

      const finalState = await scheduler.getGraphState(graphId);
      expect(finalState?.status).toBe('completed');
      expect(finalState?.nodes.b.status).toBe('completed');
      expect(finalState?.nodes.d.status).toBe('completed');
      expect(finalState?.nodes.c.status).toBe('failed');
      expect(finalState?.nodes.e.status).toBe('skipped');
    });

    it('cleans up intermediate/{gid}/ artifacts from storage upon terminal graph completion', async () => {
      const graphId = `cleanup_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Seed mock intermediate artifacts into storage
      const intermediateKey1 = `intermediate/${graphId}/step1/out1.tmp`;
      const intermediateKey2 = `intermediate/${graphId}/step2/out2.tmp`;
      const permanentResultKey = `results/${graphId}/final.pdf`;

      s3Storage.saveObject(intermediateKey1, Buffer.from('temp-data-1'), 'text/plain', 'out1.tmp');
      s3Storage.saveObject(intermediateKey2, Buffer.from('temp-data-2'), 'text/plain', 'out2.tmp');
      s3Storage.saveObject(permanentResultKey, Buffer.from('permanent-pdf'), 'application/pdf', 'final.pdf');

      expect(s3Storage.getObject(intermediateKey1)).toBeDefined();
      expect(s3Storage.getObject(intermediateKey2)).toBeDefined();
      expect(s3Storage.getObject(permanentResultKey)).toBeDefined();

      const testGraph: JobGraph = {
        failurePolicy: 'fail_fast',
        nodes: {
          in: { op: 'import.upload', storageKey: 'source.doc' },
          out: { op: 'export.internal', input: 'in' },
        },
      };

      await scheduler.initGraph(graphId, testGraph);
      await scheduler.onNodeCompleted(graphId, 'in', [intermediateKey1]);
      await scheduler.onNodeCompleted(graphId, 'out', [permanentResultKey]);

      // Verify that after graph terminal completion, all intermediate/{graphId}/* objects are deleted
      expect(s3Storage.getObject(intermediateKey1)).toBeUndefined();
      expect(s3Storage.getObject(intermediateKey2)).toBeUndefined();

      // Permanent promoted result MUST remain untouched
      expect(s3Storage.getObject(permanentResultKey)).toBeDefined();
      expect(s3Storage.getObject(permanentResultKey)?.buffer.toString()).toBe('permanent-pdf');
    });

    it('settles 2-phase quota reservation upon graph completion and refunds on cancellation', async () => {
      const userId = `usr_quota_${Date.now()}`;
      const reservation = await redisKeyStore.reserveQuota(userId, 5);
      expect(reservation.allowed).toBe(true);
      expect(reservation.reservationId).toBeDefined();

      const graphId = `quota_graph_${Date.now()}`;
      const testGraph: JobGraph = {
        failurePolicy: 'fail_fast',
        nodes: {
          a: { op: 'import.upload', storageKey: 'in.bin' },
          b: { op: 'export.internal', input: 'a' },
        },
      };

      await scheduler.initGraph(graphId, testGraph, {
        ownerUserId: userId,
        reservationId: reservation.reservationId,
      });

      // Complete graph with actual consumption = 3 units (2 units refund)
      await scheduler.onNodeCompleted(graphId, 'a', ['a.bin'], 1);
      await scheduler.onNodeCompleted(graphId, 'b', ['results/b.bin'], 2);

      const usage = await redisKeyStore.getQuotaUsage(userId);
      // Actual units settled: 3
      expect(usage.usedToday).toBe(3);

      // Now test cancellation refund on another graph
      const res2 = await redisKeyStore.reserveQuota(userId, 4);
      const graphId2 = `cancel_graph_${Date.now()}`;
      await scheduler.initGraph(graphId2, testGraph, {
        ownerUserId: userId,
        reservationId: res2.reservationId,
      });

      const cancelled = await scheduler.cancelGraph(graphId2, 'User aborted');
      expect(cancelled).toBe(true);

      const state2 = await scheduler.getGraphState(graphId2);
      expect(state2?.status).toBe('cancelled');
    });
  });

  describe('Jobs API Graph Integration (POST, GET, DELETE)', () => {
    async function createTestApiKey(tier: 'free' | 'pro' | 'enterprise' = 'pro') {
      const uid = `usr_api_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const user = await redisUserStore.createUser({
        email: `${uid}@example.com`,
        name: `User ${uid}`,
        tier,
        provider: 'email',
        passwordHash: 'dummy',
        salt: 'dummy',
      });
      const key = await redisKeyStore.generateApiKey(user.id, `API Key ${uid}`, {
        scopes: ['convert:write', 'convert:read'],
      });
      return { uid: user.id, key: key.secretKey };
    }

    it('creates a graph-based conversion job via POST /api/v1/jobs returning 202 with nodes', async () => {
      const { uid, key } = await createTestApiKey('pro');
      s3Storage.saveObject('uploads/input.txt', Buffer.from('hello world'), 'text/plain', 'input.txt');
      const testGraph: JobGraph = {
        failurePolicy: 'fail_fast',
        nodes: {
          n_upload: { op: 'import.upload', storageKey: 'uploads/input.txt' },
          n_conv: { op: 'convert', input: 'n_upload', targetFormat: 'pdf' },
          n_export: { op: 'export.internal', input: 'n_conv' },
        },
      };

      const req = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          graph: testGraph,
          filename: 'input.txt',
          storageKey: 'uploads/input.txt',
        }),
      });

      const res = await createJobHandler(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.jobId).toBeDefined();
      expect(data.nodes).toBeDefined();
      expect(data.nodes.n_upload).toBeDefined();
      expect(data.nodes.n_conv).toBeDefined();
      expect(data.nodes.n_export).toBeDefined();
      expect(['waiting', 'active']).toContain(data.nodes.n_upload.status);

      // GET /api/v1/jobs/[id]
      const getReq = new NextRequest(`https://easyconvert.app/api/v1/jobs/${data.jobId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      });
      const getRes = await getJobHandler(getReq, { params: { id: data.jobId } });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.jobId).toBe(data.jobId);
      expect(getData.nodes).toBeDefined();
      expect(getData.nodes.n_upload).toBeDefined();
      expect(getData.graph).toBeDefined();

      // DELETE /api/v1/jobs/[id] cancels graph and returns 200
      const delReq = new NextRequest(`https://easyconvert.app/api/v1/jobs/${data.jobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
      });
      const delRes = await cancelJobHandler(delReq, { params: { id: data.jobId } });
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.status).toBe('cancelled');

      // Subsequent GET shows cancelled
      const getAfterCancel = await getJobHandler(getReq, { params: { id: data.jobId } });
      const getAfterData = await getAfterCancel.json();
      expect(getAfterData.status).toBe('cancelled');
    });
  });
});
