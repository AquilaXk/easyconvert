import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { POST as v1JobsRoute } from '../../src/app/api/v1/jobs/route';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../../src/lib/auth/anonymous-identity';
import { chargingNodeCount } from '../../src/lib/jobs/graph-operations';
import { Worker } from '../../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, processConversionJob } from '../../src/lib/queue/conversion-queue';
import { graphScheduler, type JobGraph } from '../../src/lib/queue/graph';
import { userStore } from '../../src/lib/auth/user-store';
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function saveUpload(name: string, content: string | Buffer, mimeType: string): string {
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

/** A file that passes the route's check of its signature and fails when it is decoded. */
function undecodablePngUpload() {
  return saveUpload('picture.png', Buffer.concat([PNG_SIGNATURE, Buffer.from(NOT_A_PNG)]), 'image/png');
}

function missingUpload() {
  return { op: 'import.upload', storageKey: `uploads/graph-charge-${crypto.randomBytes(6).toString('hex')}/none.png` } as const;
}

/** Registers the cases; `track` receives each owner, for a suite that removes its keys afterwards. */
export function itChargesAGraphOnlyThroughItsScheduler(track: (userId: string) => void = () => undefined): void {
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
  async function runGraph(graph: JobGraph, expectedStatus: 'completed' | 'failed', expectedUnits: number): Promise<void> {
    const owner = anonymousUserId(`192.0.2.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
    track(owner);
    const usedToday = async () => (await redisKeyStore.getQuotaUsage(owner)).usedToday;
    const reservedUnits = chargingNodeCount(graph.nodes);
    const unit = await redisKeyStore.reserveQuota(owner, reservedUnits);
    expect(unit.allowed).toBe(true);
    expect(await usedToday()).toBe(reservedUnits);

    startWorker();
    const graphId = `graph_charge_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: owner, reservationId: unit.reservationId, originalFilename: 'input' });

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

  it('charges nothing under continue when no node produces a result', async () => {
    await runGraph(
      {
        failurePolicy: 'continue',
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

  it('charges the one conversion of three that completes under continue', async () => {
    await runGraph(
      {
        failurePolicy: 'continue',
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

  it('charges the two conversions that complete beside one that fails under continue', async () => {
    await runGraph(
      {
        failurePolicy: 'continue',
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

  it('ends a tasks pipeline of /api/v1/jobs failed, and charges nothing, when a task between its import and export fails', async () => {
    const user = userStore.sanitizeUser(await userStore.createUser({ email: `tasks-fail-${crypto.randomBytes(6).toString('hex')}@quota.test`, name: 'Tasks fail', tier: 'free' }));
    track(user.id);
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'tasks fail key', { scopes: ['convert:write'] });
    startWorker();

    const submitted = await v1JobsRoute(
      new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({ storageKey: undecodablePngUpload(), tasks: [{ name: 'c', operation: 'convert', targetFormat: 'jpg' }] }),
      })
    );
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const { jobId } = (await submitted.json()) as { jobId: string };

    await vi.waitFor(
      async () => expect(TERMINAL_STATUSES.has((await graphScheduler.getGraphState(jobId))?.status ?? '')).toBe(true),
      { timeout: GRAPH_TIMEOUT_MS, interval: 100 }
    );
    expect((await graphScheduler.getGraphState(jobId))?.status).toBe('failed');
    await vi.waitFor(async () => expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(0), { timeout: 5_000, interval: 50 });
  }, GRAPH_TIMEOUT_MS + 10_000);
}
