import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../../src/lib/auth/anonymous-identity';
import { Worker } from '../../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, processConversionJob } from '../../src/lib/queue/conversion-queue';
import { graphScheduler, type JobGraph } from '../../src/lib/queue/graph';
import { s3Storage } from '../../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../../src/lib/types';

/**
 * What a queued graph is charged, run through real queue workers with the lifecycle listeners attached, as the worker
 * process runs them. The graph holds one reservation for all its nodes: only the graph scheduler ends it, settling it to
 * the units its nodes charged once the graph completes, or giving it back once the graph fails. The same cases run with
 * the in-memory scheduler and store and on a real Redis server.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const NOT_A_PNG = 'this is plain text, not a PNG picture';
const GRAPH_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function saveUpload(name: string, content: string, mimeType: string): string {
  const key = `uploads/graph-charge-${crypto.randomBytes(6).toString('hex')}/${name}`;
  s3Storage.saveObject(key, Buffer.from(content), mimeType, name, 60 * 60 * 1000);
  return key;
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

  /** Reserves the graph's unit as `/api/v1/jobs` does, runs the graph to its end, and answers the owner's charge after it. */
  async function runGraph(graph: JobGraph, expectedStatus: 'completed' | 'failed', expectedUnits: number): Promise<void> {
    const owner = anonymousUserId(`192.0.2.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
    track(owner);
    const usedToday = async () => (await redisKeyStore.getQuotaUsage(owner)).usedToday;
    const unit = await redisKeyStore.reserveQuota(owner, 1);
    expect(unit.allowed).toBe(true);
    expect(await usedToday()).toBe(1);

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

  it('charges nothing for a graph whose second node fails after its first completed', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          up: { op: 'import.upload', storageKey: saveUpload('picture.png', NOT_A_PNG, 'image/png') },
          conv: { op: 'convert', input: 'up', targetFormat: 'jpg' },
        },
      },
      'failed',
      0
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges a completed two-node graph the units its nodes charged', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          up: { op: 'import.upload', storageKey: saveUpload('scores.csv', CSV, 'text/csv') },
          conv: { op: 'convert', input: 'up', targetFormat: 'json' },
        },
      },
      'completed',
      2
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges a completed graph of three charging nodes three units', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          up: { op: 'import.upload', storageKey: saveUpload('scores.csv', CSV, 'text/csv') },
          conv: { op: 'convert', input: 'up', targetFormat: 'json' },
          out: { op: 'export.internal', input: 'conv' },
        },
      },
      'completed',
      3
    );
  }, GRAPH_TIMEOUT_MS + 10_000);
}
