import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../../src/lib/api-keys/webhook-dispatcher';
import { GRAPH_START_CANCEL_ATTEMPTS } from '../../src/lib/queue/graph/node-jobs';
import type { IGraphScheduler } from '../../src/lib/queue/graph/scheduler-types';
import type { JobGraph } from '../../src/lib/queue/graph/types';

/**
 * How a graph whose start failed is recovered (docs/policy-decisions.md, entry 15): the stored graph is started by queueing
 * its ready nodes, or cancelled, which gives its reservation back. The same cases run on the scheduler of this process and on
 * a real Redis server.
 */

export interface GraphRecoveryControls {
  /** A new scheduler, and how to make its queue refuse every node job until told otherwise. */
  scheduler: () => { scheduler: IGraphScheduler; refuseNodeJobs: (refuse: boolean) => void };
  owner: () => string;
  /** What a lookup answers for a graph whose state was never written: certainly nothing in this process, unknown in Redis. */
  neverStored: 'not-started' | 'unknown';
}

const GRAPH = {
  failurePolicy: 'fail_fast',
  nodes: { up: { op: 'import.upload', storageKey: 'uploads/graph-recovery/a.csv' }, conv: { op: 'convert', input: 'up', targetFormat: 'json' } },
} as unknown as JobGraph;

export function itRecoversAGraphStart(controls: GraphRecoveryControls): void {
  const used = async () => (await redisKeyStore.getQuotaUsage(controls.owner())).usedToday;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A graph whose state was stored while its first node job was refused, so its start threw; its reservation holds a unit. */
  async function storedButNotQueued() {
    vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const { scheduler, refuseNodeJobs } = controls.scheduler();
    const unit = await redisKeyStore.reserveQuota(controls.owner(), 1);
    expect(unit.allowed).toBe(true);
    const graphId = `graph_recovery_${crypto.randomBytes(6).toString('hex')}`;
    refuseNodeJobs(true);
    await expect(scheduler.initGraph(graphId, GRAPH, { ownerUserId: controls.owner(), reservationId: unit.reservationId })).rejects.toThrow();
    expect(await used()).toBe(1);
    return { scheduler, graphId };
  }

  it('answers a graph that ended before its cancel as started, with the state read after the cancel', async () => {
    const { scheduler, graphId } = await storedButNotQueued();
    const cancel = scheduler.cancelGraph.bind(scheduler);
    vi.spyOn(scheduler, 'cancelGraph').mockImplementation(async (id, reason) => {
      await scheduler.onNodeFailed(graphId, 'up', 'the upload is gone');
      return cancel(id, reason);
    });

    const recovery = await scheduler.recoverStart(graphId);

    expect(recovery).toMatchObject({ status: 'started', work: { graphId, status: 'failed' } });
    expect(await used()).toBe(0);
  });

  it('cancels the graph and gives its unit back when a cancel that threw lands on a later try', async () => {
    const { scheduler, graphId } = await storedButNotQueued();
    const cancel = scheduler.cancelGraph.bind(scheduler);
    const tries = vi.spyOn(scheduler, 'cancelGraph').mockRejectedValueOnce(new Error('the connection dropped')).mockImplementation(cancel);

    expect(await scheduler.recoverStart(graphId)).toEqual({ status: 'not-started' });

    expect(tries).toHaveBeenCalledTimes(2);
    expect((await scheduler.getGraphState(graphId))?.status).toBe('cancelled');
    expect(await used()).toBe(0);
  });

  it('answers unknown and leaves the unit to the graph when every try of the cancel throws', async () => {
    const { scheduler, graphId } = await storedButNotQueued();
    const tries = vi.spyOn(scheduler, 'cancelGraph').mockRejectedValue(new Error('the connection dropped'));

    expect(await scheduler.recoverStart(graphId)).toEqual({ status: 'unknown' });

    expect(tries).toHaveBeenCalledTimes(GRAPH_START_CANCEL_ATTEMPTS);
    expect((await scheduler.getGraphState(graphId))?.status).toBe('running');
    expect(await used()).toBe(1);
  });

  it('answers a graph whose state was never written as the store can tell', async () => {
    const { scheduler } = controls.scheduler();

    expect(await scheduler.recoverStart(`graph_never_${crypto.randomBytes(6).toString('hex')}`)).toEqual({ status: controls.neverStored });
  });
}
