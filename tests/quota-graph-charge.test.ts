import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { itChargesAGraphOnlyThroughItsScheduler } from './helpers/graph-charge-cases';
import { itRecoversAGraphStart } from './helpers/graph-start-recovery-cases';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { QueueUnavailableError } from '../src/lib/types';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { finishGraph } from '../src/lib/queue/graph/graph-end';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { allConversionQueues } from '../src/lib/queue/conversion-queue';
import { storageProvider } from '../src/lib/storage';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { holdResultForJob } from '../src/lib/storage/retention-service';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import type { GraphExecutionState } from '../src/lib/queue/graph/scheduler-types';

// The scheduler, the queues and the quota store pick Redis or this process when they are first imported.
vi.hoisted(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('@/lib/security/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/ssrf')>()),
  validateUrlForSsrf: vi.fn(async () => true),
  createSsrfSafeAgent: () => ({ close: async () => undefined }),
}));

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('what a queued graph is charged, with the in-memory scheduler and store', () => {
  itChargesAGraphOnlyThroughItsScheduler();
});

describe('the start of a graph that failed, with the in-memory scheduler and store', () => {
  let owner = '';
  beforeEach(() => {
    owner = anonymousUserId(`192.0.2.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
  });
  itRecoversAGraphStart({
    scheduler: () => {
      let refusing = false;
      for (const queue of allConversionQueues) {
        const add = queue.add.bind(queue);
        vi.spyOn(queue, 'add').mockImplementation(async (name, data, opts) => {
          if (refusing && data.graphId) throw new QueueUnavailableError(queue.name, 'the node job could not be stored');
          return add(name, data, opts);
        });
      }
      return { scheduler: new InMemoryGraphScheduler(), refuseNodeJobs: (refuse) => (refusing = refuse) };
    },
    owner: () => owner,
    neverStored: 'not-started',
  });
});

describe('the in-memory graph scheduler', () => {
  it('completes a graph once when two of its nodes fail at the same time under continue', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(undefined as never);
    try {
      const scheduler = new InMemoryGraphScheduler();
      const graphId = `graph_twice_${Date.now()}`;
      await scheduler.initGraph(
        graphId,
        {
          failurePolicy: 'continue',
          nodes: {
            left: { op: 'import.upload', storageKey: 'uploads/graph-twice/left.csv' },
            right: { op: 'import.upload', storageKey: 'uploads/graph-twice/right.csv' },
            leftJson: { op: 'convert', input: 'left', targetFormat: 'json' },
            rightJson: { op: 'convert', input: 'right', targetFormat: 'json' },
          },
        },
        { webhookUrl: 'https://hooks.example.com/graph', webhookSecret: 'whsec_twice' }
      );

      await Promise.all([scheduler.onNodeFailed(graphId, 'left', 'left failed'), scheduler.onNodeFailed(graphId, 'right', 'right failed')]);

      expect((await scheduler.getGraphState(graphId))?.status).toBe('completed');
      expect(dispatched.mock.calls.map((call) => call[1])).toEqual(['graph.completed']);
    } finally {
      dispatched.mockRestore();
    }
  });
});

describe('the end of a graph, in this process', () => {
  const WEBHOOK = { webhookUrl: 'https://hooks.example.com/graph', webhookSecret: 'whsec_end' };
  const uploads = (graphId: string) => ({
    failurePolicy: 'fail_fast' as const,
    nodes: {
      left: { op: 'import.upload' as const, storageKey: `uploads/${graphId}/left.csv` },
      right: { op: 'import.upload' as const, storageKey: `uploads/${graphId}/right.csv` },
      leftJson: { op: 'convert' as const, input: 'left', targetFormat: 'json' },
      rightJson: { op: 'convert' as const, input: 'right', targetFormat: 'json' },
    },
  });

  it('announces the end once and removes the files when the first read of the state fails, and answers what the step between returned', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const removed = vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
    try {
      const scheduler = new InMemoryGraphScheduler();
      const graphId = `graph_end_read_${Date.now()}`;
      const state = await scheduler.initGraph(graphId, uploads(graphId), WEBHOOK);
      let reads = 0;
      const readState = async () => {
        reads += 1;
        if (reads === 1) throw new Error('the connection dropped');
        return state;
      };

      const between = await finishGraph({ graphId, reservationId: undefined, inputKeys: [], readState }, { outcome: { status: 'completed' }, reservation: { kind: 'rollback' } }, async () => 'drained');

      expect(between).toBe('drained');
      expect(dispatched.mock.calls.map((call) => call[1])).toEqual(['graph.completed']);
      expect(removed).toHaveBeenCalledWith(`intermediate/${graphId}/`);
    } finally {
      dispatched.mockRestore();
      removed.mockRestore();
    }
  });

  it('ends the holds on its inputs and removes its files, telling no webhook, when its state cannot be read twice', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const removed = vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const graphId = `graph_end_unread_${Date.now()}`;
      const input = `uploads/${graphId}/left.csv`;
      s3Storage.saveObject(input, Buffer.from('a,b\n1,2\n'), 'text/csv', 'left.csv', 60_000);
      expect(await holdResultForJob(input, graphId)).toBe(true);
      const readState = vi.fn(async (): Promise<GraphExecutionState | undefined> => {
        throw new Error('the connection dropped');
      });
      const between = vi.fn(async (state: GraphExecutionState | undefined) => state);

      await finishGraph({ graphId, reservationId: undefined, inputKeys: [input], readState }, { outcome: { status: 'failed', error: 'left failed' }, reservation: { kind: 'rollback' } }, between);

      expect(readState).toHaveBeenCalledTimes(2);
      expect(between).toHaveBeenCalledWith(undefined);
      expect(dispatched).not.toHaveBeenCalled();
      expect(removed).toHaveBeenCalledWith(`intermediate/${graphId}/`);
      expect((await getRetentionLedger().get(input))?.holds ?? {}).not.toHaveProperty(graphId);
    } finally {
      dispatched.mockRestore();
      removed.mockRestore();
      logged.mockRestore();
    }
  });

  it('logs a state that is gone once, without reading it again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const removed = vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
    try {
      const graphId = `graph_end_gone_${Date.now()}`;
      const readState = vi.fn(async (): Promise<GraphExecutionState | undefined> => undefined);

      await finishGraph({ graphId, reservationId: undefined, inputKeys: [], readState }, { outcome: { status: 'cancelled' }, reservation: { kind: 'rollback' } });

      expect(readState).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls.filter(([line]) => String(line).includes(graphId))).toHaveLength(1);
    } finally {
      logged.mockRestore();
      removed.mockRestore();
    }
  });

  it('cancels every other node job of a failed graph when cancelling one of them fails', async () => {
    const cancelled: string[] = [];
    const spies = allConversionQueues.map((queue) =>
      vi.spyOn(queue, 'cancelJob').mockImplementation(async (jobId: string) => {
        cancelled.push(jobId);
        if (cancelled.length === 1) throw new Error('the queue refused the cancel');
        return true;
      })
    );
    try {
      const scheduler = new InMemoryGraphScheduler();
      const graphId = `graph_end_cancel_${Date.now()}`;
      await scheduler.initGraph(graphId, uploads(graphId));

      const failure = await scheduler.onNodeFailed(graphId, 'left', 'left failed');

      const [refused, ...carriedOut] = cancelled;
      expect([...cancelled].sort()).toEqual([`${graphId}:leftJson`, `${graphId}:right`, `${graphId}:rightJson`]);
      expect(failure.cancelledJobIds).not.toContain(refused);
      expect([...failure.cancelledJobIds].sort()).toEqual(carriedOut.sort());
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

/** A key store of this process whose count of a day can be ended, as the count of a day expires in Redis at midnight. */
class DayEndingKeyStore extends RedisKeyStore {
  endDayOf(userId: string): void {
    for (const key of [...this.dailyUsage.keys()]) if (key.startsWith(`${userId}:`)) this.dailyUsage.delete(key);
  }
}

describe('a reservation extended in this process', () => {
  it('is reported gone once the count of its day is gone, and writes no count', async () => {
    const store = new DayEndingKeyStore({ isolated: true });
    const userId = `user_extend_${Date.now()}`;
    const unit = await store.reserveQuota(userId, 2);
    expect(unit.allowed).toBe(true);
    store.endDayOf(userId);

    expect(await store.extendQuota(unit.reservationId as string, 'conv', 3)).toEqual({ status: 'no-reservation' });
    expect((await store.getQuotaUsage(userId)).usedToday).toBe(0);
  });

  it('holds the units of an extension while the count of its day lives', async () => {
    const store = new DayEndingKeyStore({ isolated: true });
    const userId = `user_extend_live_${Date.now()}`;
    const unit = await store.reserveQuota(userId, 2);

    expect(await store.extendQuota(unit.reservationId as string, 'conv', 3)).toEqual({ status: 'extended' });
    expect((await store.getQuotaUsage(userId)).usedToday).toBe(5);
  });
});
