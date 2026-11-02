import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../../src/lib/auth/anonymous-identity';
import { chargingNodeCount } from '../../src/lib/jobs/graph-operations';
import { Worker } from '../../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, processConversionJob } from '../../src/lib/queue/conversion-queue';
import { graphScheduler, type JobGraph } from '../../src/lib/queue/graph';
import { s3Storage } from '../../src/lib/storage/s3-storage';
import { ConversionFailedError, type ConversionJobData, type ConversionJobResult } from '../../src/lib/types';

/**
 * What a queued graph is charged, run through real queue workers with the lifecycle listeners attached, as the worker
 * process runs them. The graph reserves a unit for each node that charges one, as `/api/v1/jobs` does: only the graph
 * scheduler ends that reservation, settling it to the units its nodes charged once the graph completes, or giving it back
 * once the graph fails. Imports and exports charge nothing. The same cases run with the in-memory scheduler and store and
 * on a real Redis server.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const NOT_A_PNG = 'this is plain text, not a PNG picture';
const GRAPH_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
/** The policies under which a node that fails skips what depends on it and the graph runs on; `fail_job` is what the `tasks` pipeline of `/api/v1/jobs` builds. */
const RUN_ON_POLICIES = ['continue', 'fail_job'] as const;
type RunOnPolicy = (typeof RUN_ON_POLICIES)[number];

type SubmittedGraph = Omit<JobGraph, 'failurePolicy'> & { failurePolicy: JobGraph['failurePolicy'] | RunOnPolicy };

function saveUpload(name: string, content: string, mimeType: string): string {
  const key = `uploads/graph-charge-${crypto.randomBytes(6).toString('hex')}/${name}`;
  s3Storage.saveObject(key, Buffer.from(content), mimeType, name, 60 * 60 * 1000);
  return key;
}

function csvUpload() {
  return { op: 'import.upload', storageKey: saveUpload('scores.csv', CSV, 'text/csv') } as const;
}

function notAPngUpload() {
  return { op: 'import.upload', storageKey: saveUpload('picture.png', NOT_A_PNG, 'image/png') } as const;
}

function missingUpload() {
  return { op: 'import.upload', storageKey: `uploads/graph-charge-${crypto.randomBytes(6).toString('hex')}/none.png` } as const;
}

/**
 * Registers the cases; `track` receives each owner, for a suite that removes its keys afterwards, and the graphs that run
 * on past a failed node run under each of `runOnPolicies`.
 */
export function itChargesAGraphOnlyThroughItsScheduler(
  track: (userId: string) => void = () => undefined,
  runOnPolicies: readonly RunOnPolicy[] = RUN_ON_POLICIES
): void {
  let workers: Worker<ConversionJobData, ConversionJobResult>[] = [];

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    workers = [];
  });

  function startWorker(): void {
    const worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processConversionJob, { concurrency: 2 });
    attachJobLifecycleListeners(worker);
    workers.push(worker);
  }

  /** Reserves the graph's units as `/api/v1/jobs` does, runs the graph to its end, and answers the owner's charge after it. */
  async function runGraph(graph: SubmittedGraph, expectedStatus: 'completed' | 'failed', expectedUnits: number): Promise<void> {
    const owner = anonymousUserId(`192.0.2.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
    track(owner);
    const usedToday = async () => (await redisKeyStore.getQuotaUsage(owner)).usedToday;
    const reservedUnits = chargingNodeCount(graph.nodes);
    const unit = await redisKeyStore.reserveQuota(owner, reservedUnits);
    expect(unit.allowed).toBe(true);
    expect(await usedToday()).toBe(reservedUnits);

    startWorker();
    const graphId = `graph_charge_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await graphScheduler.initGraph(graphId, graph as JobGraph, { ownerUserId: owner, reservationId: unit.reservationId, originalFilename: 'input' });

    await vi.waitFor(
      async () => expect(TERMINAL_STATUSES.has((await graphScheduler.getGraphState(graphId))?.status ?? '')).toBe(true),
      { timeout: GRAPH_TIMEOUT_MS, interval: 100 }
    );
    expect((await graphScheduler.getGraphState(graphId))?.status).toBe(expectedStatus);
    await vi.waitFor(async () => expect(await usedToday()).toBe(expectedUnits), { timeout: 5_000, interval: 50 });
  }

  it('charges nothing for a graph whose conversion fails after its import completed', async () => {
    await runGraph({ failurePolicy: 'fail_fast', nodes: { up: notAPngUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'jpg' } } }, 'failed', 0);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges a completed import and conversion one unit', async () => {
    await runGraph({ failurePolicy: 'fail_fast', nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' } } }, 'completed', 1);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges a completed import, conversion and export one unit', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' }, out: { op: 'export.internal', input: 'conv' } },
      },
      'completed',
      1
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('gives the units back when a node fails before it starts its work', async () => {
    const onNodeStarted = graphScheduler.onNodeStarted.bind(graphScheduler);
    const started = vi.spyOn(graphScheduler, 'onNodeStarted').mockImplementation(async (graphId, nodeId) => {
      if (nodeId === 'conv') throw new ConversionFailedError('the scheduler could not mark the node started');
      return onNodeStarted(graphId, nodeId);
    });
    try {
      await runGraph({ failurePolicy: 'fail_fast', nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' } } }, 'failed', 0);
    } finally {
      started.mockRestore();
    }
  }, GRAPH_TIMEOUT_MS + 10_000);

  for (const failurePolicy of runOnPolicies) {
    it(`charges nothing under ${failurePolicy} when no node produces a result`, async () => {
      await runGraph(
        {
          failurePolicy,
          nodes: {
            first: missingUpload(),
            second: missingUpload(),
            convFirst: { op: 'convert', input: 'first', targetFormat: 'json' },
            convSecond: { op: 'convert', input: 'second', targetFormat: 'json' },
          },
        },
        'completed',
        0
      );
    }, GRAPH_TIMEOUT_MS + 10_000);

    it(`charges the one conversion of three that completes under ${failurePolicy}`, async () => {
      await runGraph(
        {
          failurePolicy,
          nodes: {
            good: csvUpload(),
            bad: notAPngUpload(),
            toJson: { op: 'convert', input: 'good', targetFormat: 'json' },
            toJpg: { op: 'convert', input: 'bad', targetFormat: 'jpg' },
            toWebp: { op: 'convert', input: 'bad', targetFormat: 'webp' },
          },
        },
        'completed',
        1
      );
    }, GRAPH_TIMEOUT_MS + 10_000);

    it(`charges the two conversions that complete beside one that fails under ${failurePolicy}`, async () => {
      await runGraph(
        {
          failurePolicy,
          nodes: {
            good: csvUpload(),
            bad: notAPngUpload(),
            toJson: { op: 'convert', input: 'good', targetFormat: 'json' },
            toTsv: { op: 'convert', input: 'good', targetFormat: 'tsv' },
            toJpg: { op: 'convert', input: 'bad', targetFormat: 'jpg' },
          },
        },
        'completed',
        2
      );
    }, GRAPH_TIMEOUT_MS + 10_000);
  }
}
