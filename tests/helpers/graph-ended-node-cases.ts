import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Job } from '../../src/lib/queue/bullmq-engine';
import { graphScheduler } from '../../src/lib/queue/graph';
import { processGraphNodeJobIfAlive } from '../../src/lib/queue/graph/node-executor';
import { GRAPH_NODE_CANCEL_ATTEMPTS, graphNodeJobId, sealGraph } from '../../src/lib/queue/graph/node-jobs';
import { sealGraphNode } from '../../src/lib/queue/graph/sealed-nodes';
import type { IGraphScheduler } from '../../src/lib/queue/graph/scheduler-types';
import type { GraphNode, JobGraph } from '../../src/lib/queue/graph/types';
import { s3Storage } from '../../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../../src/lib/types';

/**
 * What becomes of the node jobs of a graph whose start failed after some of them were queued (docs/policy-decisions.md, entry 205):
 * the graph is cancelled, each queued job is cancelled again when its cancel throws, and a job whose cancel never lands is not run
 * by the worker that takes it, because the worker asks the scheduler (the store, not this process) whether the node may still run.
 * The same cases run on the scheduler of this process and on a real Redis server.
 */

export interface EndedGraphControls {
  /**
   * A new scheduler of the store; how to make its queue store the node jobs of the next graphs only until `count` of them are stored
   * and refuse the rest; and how to make the cancel of every node job throw its first `failures` tries (Infinity: every try),
   * which returns the tries made so far, by job id.
   */
  scheduler: () => {
    scheduler: IGraphScheduler;
    refuseNodeJobsAfter: (count: number) => void;
    failNodeJobCancels: (failures: number) => () => ReadonlyMap<string, number>;
  };
}

/** Two nodes that are ready at once, and one that waits for the first. */
const GRAPH = {
  failurePolicy: 'fail_fast',
  nodes: {
    a: { op: 'import.upload', storageKey: 'uploads/graph-ended/a.csv' },
    b: { op: 'import.upload', storageKey: 'uploads/graph-ended/b.csv' },
    conv: { op: 'convert', input: 'a', targetFormat: 'json' },
  },
} as unknown as JobGraph;

function nodeJobOf(graphId: string, nodeId: string, node: GraphNode) {
  const jobId = graphNodeJobId(graphId, nodeId);
  const logs: string[] = [];
  const job = {
    id: jobId,
    data: {
      jobId,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: nodeId,
      graphNode: sealGraphNode(node, jobId),
      inputArtifacts: [],
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async (line: string) => void logs.push(line),
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
  return { job, logs };
}

export function itLeavesTheNodeJobsOfAnEndedGraphAlone(controls: EndedGraphControls): void {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The worker side of a scheduler: the executor asks the process-wide scheduler, which here is the one under test. */
  function workersAsk(scheduler: IGraphScheduler) {
    vi.spyOn(graphScheduler, 'onNodeStarted').mockImplementation((graphId, nodeId) => scheduler.onNodeStarted(graphId, nodeId));
    return {
      completed: vi.spyOn(graphScheduler, 'onNodeCompleted').mockImplementation((...args) => scheduler.onNodeCompleted(...args)),
      failed: vi.spyOn(graphScheduler, 'onNodeFailed').mockImplementation((...args) => scheduler.onNodeFailed(...args)),
    };
  }

  /** A graph whose start failed after the job of node `a` was queued: node `b` was refused. */
  async function startFailedAfterOneNodeJob() {
    const made = controls.scheduler();
    const graphId = `graph_ended_${crypto.randomBytes(6).toString('hex')}`;
    made.refuseNodeJobsAfter(1);
    await expect(made.scheduler.initGraph(graphId, sealGraph(graphId, GRAPH), { ownerUserId: 'user-graph-ended' })).rejects.toThrow();
    return { ...made, graphId };
  }

  it('cancels every queued node job of the failed start again when a cancel throws on its first try', async () => {
    const { scheduler, graphId, failNodeJobCancels } = await startFailedAfterOneNodeJob();
    const triesOf = failNodeJobCancels(1);

    expect(await scheduler.recoverStart(graphId)).toEqual({ status: 'not-started' });

    expect((await scheduler.getGraphState(graphId))?.status).toBe('cancelled');
    const tries = triesOf();
    expect([...tries.keys()].sort()).toEqual([`${graphId}:a`, `${graphId}:b`, `${graphId}:conv`]);
    for (const count of tries.values()) expect(count).toBe(2);
  });

  it('gives up on a node job after GRAPH_NODE_CANCEL_ATTEMPTS tries and still ends the graph', async () => {
    const { scheduler, graphId, failNodeJobCancels } = await startFailedAfterOneNodeJob();
    const triesOf = failNodeJobCancels(Number.POSITIVE_INFINITY);

    expect(await scheduler.recoverStart(graphId)).toEqual({ status: 'not-started' });

    expect((await scheduler.getGraphState(graphId))?.status).toBe('cancelled');
    for (const count of triesOf().values()) expect(count).toBe(GRAPH_NODE_CANCEL_ATTEMPTS);
  });

  it('does not run a node job whose cancel never landed: the worker that takes it finds the graph ended', async () => {
    const { scheduler, graphId, failNodeJobCancels } = await startFailedAfterOneNodeJob();
    failNodeJobCancels(Number.POSITIVE_INFINITY);
    expect(await scheduler.recoverStart(graphId)).toEqual({ status: 'not-started' });
    const ran = workersAsk(scheduler);
    const read = vi.spyOn(s3Storage, 'getObject');
    const { job, logs } = nodeJobOf(graphId, 'a', GRAPH.nodes.a);

    const result = await processGraphNodeJobIfAlive(job, undefined, s3Storage);

    expect(result).toMatchObject({ jobId: job.id, status: 'completed', resultKey: '', size: 0 });
    expect(logs.join('\n')).toContain('was not run');
    expect(read).not.toHaveBeenCalled();
    expect(ran.completed).not.toHaveBeenCalled();
    expect(ran.failed).not.toHaveBeenCalled();
    expect((await scheduler.getGraphState(graphId))?.nodes.a.status).toBe('cancelled');
  });

  it('answers a worker only for a node that can still run', async () => {
    const { scheduler } = controls.scheduler();
    const graphId = `graph_alive_${crypto.randomBytes(6).toString('hex')}`;
    await scheduler.initGraph(graphId, sealGraph(graphId, GRAPH), { ownerUserId: 'user-graph-ended' });

    expect(await scheduler.onNodeStarted(graphId, 'a')).toBe(true);
    // A retry of the same node job after a failed attempt finds it active.
    expect(await scheduler.onNodeStarted(graphId, 'a')).toBe(true);
    expect(await scheduler.onNodeStarted(graphId, 'no-such-node')).toBe(false);

    await scheduler.onNodeCompleted(graphId, 'a', ['intermediate/a.json']);
    // The job of a node that completed, delivered again, does not run twice.
    expect(await scheduler.onNodeStarted(graphId, 'a')).toBe(false);

    await scheduler.cancelGraph(graphId, 'Cancelled by its owner');
    expect(await scheduler.onNodeStarted(graphId, 'b')).toBe(false);
    expect(await scheduler.onNodeStarted(graphId, 'conv')).toBe(false);
  });

  it('answers a worker that a graph no store holds has no node to run', async () => {
    const { scheduler } = controls.scheduler();

    expect(await scheduler.onNodeStarted(`graph_never_${crypto.randomBytes(6).toString('hex')}`, 'a')).toBe(false);
  });

  it('answers a worker that the node of a failed graph may not run', async () => {
    const { scheduler } = controls.scheduler();
    const graphId = `graph_failed_${crypto.randomBytes(6).toString('hex')}`;
    await scheduler.initGraph(graphId, sealGraph(graphId, GRAPH), { ownerUserId: 'user-graph-ended' });
    await scheduler.onNodeStarted(graphId, 'a');

    await scheduler.onNodeFailed(graphId, 'a', 'the upload is gone');

    expect((await scheduler.getGraphState(graphId))?.status).toBe('failed');
    expect(await scheduler.onNodeStarted(graphId, 'b')).toBe(false);
  });
}
