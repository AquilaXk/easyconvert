import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { fetch as undiciFetch } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { POST as v1JobsRoute } from '../../src/app/api/v1/jobs/route';
import { DELETE as cancelQueueJobRoute } from '../../src/app/api/queue/jobs/[id]/route';
import { DELETE as cancelV1JobRoute } from '../../src/app/api/v1/jobs/[id]/route';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { bytesBroughtInToday, dailyBudgetBytes, reserveLinkImport } from '../../src/lib/api-keys/anonymous-upload-budget';
import { webhookDispatcher } from '../../src/lib/api-keys/webhook-dispatcher';
import { anonymousUserId } from '../../src/lib/auth/anonymous-identity';
import { Worker } from '../../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, cancelJobAcrossQueues, getJobAcrossQueues, processConversionJob } from '../../src/lib/queue/conversion-queue';
import { graphScheduler, type GraphMetadata, type JobGraph } from '../../src/lib/queue/graph';
import { userStore } from '../../src/lib/auth/user-store';
import { storageProvider } from '../../src/lib/storage';
import { s3Storage } from '../../src/lib/storage/s3-storage';
import { ConversionFailedError, type ConversionJobData, type ConversionJobResult } from '../../src/lib/types';

/**
 * What a queued graph is charged, run through real queue workers with the lifecycle listeners attached, as the worker
 * process runs them. Each case reserves one unit more than the graph is expected to be charged, so a settle that never
 * happens shows as a unit left charged: only the graph scheduler ends that reservation, settling it to the units its
 * nodes charged once the graph completes, or giving it back once the graph fails or is cancelled. Imports and exports
 * charge nothing, and a conversion charges one unit for each output it produced. The same cases run with the in-memory
 * scheduler and store and on a real Redis server. The suites mock `undici`'s fetch and the SSRF checks, so a link node
 * reads what `remoteFile` serves.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';
const NOT_A_PNG = 'this is plain text, not a PNG picture';
const GRAPH_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const HTTP_CONFLICT = 409;
const LINK = 'https://files.example.com/scores.csv';
const WEBHOOK = { webhookUrl: 'https://hooks.example.com/graph', webhookSecret: 'whsec_graph_charge' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function saveUpload(name: string, content: string | Buffer, mimeType: string): string {
  const key = `uploads/graph-charge-${crypto.randomBytes(6).toString('hex')}/${name}`;
  s3Storage.saveObject(key, Buffer.from(content), mimeType, name, 60 * 60 * 1000);
  return key;
}

function csvUpload(name = 'scores.csv') {
  return { op: 'import.upload', storageKey: saveUpload(name, CSV, 'text/csv') } as const;
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

/** Every fetch of a link answers the CSV, a new response each time. */
function remoteCsv(): void {
  vi.mocked(undiciFetch).mockImplementation(async () => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } }) as never);
}

function anonymousOwner(): string {
  return anonymousUserId(`192.0.2.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
}

/** Registers the cases; `track` receives each owner, for a suite that removes its keys afterwards. */
export function itChargesAGraphOnlyThroughItsScheduler(track: (userId: string) => void = () => undefined): void {
  let workers: Worker<ConversionJobData, ConversionJobResult>[] = [];

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    workers = [];
    vi.restoreAllMocks();
  });

  function startWorker(processor: typeof processConversionJob = processConversionJob): void {
    const worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processor, { concurrency: 2 });
    attachJobLifecycleListeners(worker);
    workers.push(worker);
  }

  async function apiAccount() {
    const user = userStore.sanitizeUser(await userStore.createUser({ email: `graph-charge-${crypto.randomBytes(6).toString('hex')}@quota.test`, name: 'Graph charge', tier: 'free' }));
    track(user.id);
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'graph charge key', { scopes: ['convert:write'] });
    return { userId: user.id, authorization: `Bearer ${secretKey}` };
  }

  /**
   * Queues `graph` for `owner` with one unit more reserved than `expectedUnits`, and answers how to wait for its end.
   * `startWorkers` is false for a case that acts on the queued node jobs before any worker takes them.
   */
  async function queueGraph(graph: JobGraph, expectedUnits: number, options: { owner?: string; meta?: GraphMetadata; startWorkers?: boolean } = {}) {
    const owner = options.owner ?? anonymousOwner();
    track(owner);
    const usedToday = async () => (await redisKeyStore.getQuotaUsage(owner)).usedToday;
    const reservedUnits = expectedUnits + 1;
    const unit = await redisKeyStore.reserveQuota(owner, reservedUnits);
    expect(unit.allowed).toBe(true);
    expect(await usedToday()).toBe(reservedUnits);

    if (options.startWorkers !== false) startWorker();
    const graphId = `graph_charge_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await graphScheduler.initGraph(graphId, graph, { ownerUserId: owner, reservationId: unit.reservationId, originalFilename: 'input', ...options.meta });

    /** Waits for the graph to end with `expectedStatus` and its owner to be charged `expectedUnits`. */
    async function ended(expectedStatus: 'completed' | 'failed'): Promise<void> {
      await vi.waitFor(
        async () => expect(TERMINAL_STATUSES.has((await graphScheduler.getGraphState(graphId))?.status ?? '')).toBe(true),
        { timeout: GRAPH_TIMEOUT_MS, interval: 100 }
      );
      expect((await graphScheduler.getGraphState(graphId))?.status).toBe(expectedStatus);
      await vi.waitFor(async () => expect(await usedToday()).toBe(expectedUnits), { timeout: 5_000, interval: 50 });
    }
    return { graphId, owner, ended };
  }

  async function runGraph(graph: JobGraph, expectedStatus: 'completed' | 'failed', expectedUnits: number): Promise<void> {
    const queued = await queueGraph(graph, expectedUnits);
    await queued.ended(expectedStatus);
  }

  const importAndConvert = (): JobGraph => ({ failurePolicy: 'fail_fast', nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' } } });

  it('charges nothing for a graph whose conversion fails after its import completed', async () => {
    await runGraph({ failurePolicy: 'fail_fast', nodes: { up: notAPngUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'jpg' } } }, 'failed', 0);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges an import.upload node and a convert node one unit', async () => {
    await runGraph(importAndConvert(), 'completed', 1);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges an import.upload node, a convert node and an export.internal node one unit', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' }, out: { op: 'export.internal', input: 'conv' } },
      },
      'completed',
      1
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges a convert node of two uploads two units, one for each output', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: { first: csvUpload('first.csv'), second: csvUpload('second.csv'), conv: { op: 'convert', input: ['first', 'second'], targetFormat: 'json' } },
      },
      'completed',
      2
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges nothing for an optimize node that received no input, beside a convert node that charges one unit', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' }, opt: { op: 'optimize' } },
      },
      'completed',
      1
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('gives the units back when a node fails while it marks itself started', async () => {
    const onNodeStarted = graphScheduler.onNodeStarted.bind(graphScheduler);
    vi.spyOn(graphScheduler, 'onNodeStarted').mockImplementation(async (graphId, nodeId) => {
      if (nodeId === 'conv') throw new ConversionFailedError('the scheduler could not mark the node started');
      return onNodeStarted(graphId, nodeId);
    });
    await runGraph(importAndConvert(), 'failed', 0);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('gives the units back when the password of a convert node cannot be opened, before the node starts its work', async () => {
    await runGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json', options: { sealedPassword: 'not-a-sealed-blob' } } },
      },
      'failed',
      0
    );
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('gives the units back when the worker fails a node job without running the node', async () => {
    const queued = await queueGraph(importAndConvert(), 0, { startWorkers: false });
    startWorker(async () => {
      throw new ConversionFailedError('the worker lost the node job');
    });
    await queued.ended('failed');
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('gives the units back when a node job is cancelled on its queue', async () => {
    const queued = await queueGraph(importAndConvert(), 0, { startWorkers: false });
    expect(await cancelJobAcrossQueues(`${queued.graphId}:up`, 'Cancelled by an operator')).toBe(true);
    await queued.ended('failed');
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('refuses to cancel one node job by its id on either job route, so the graph runs on and is charged its conversion', async () => {
    const account = await apiAccount();
    const queued = await queueGraph(importAndConvert(), 1, { owner: account.userId, startWorkers: false });
    const nodeJobId = `${queued.graphId}:up`;
    const request = (path: string) => new NextRequest(`http://localhost${path}`, { method: 'DELETE', headers: { authorization: account.authorization } });
    const context = { params: Promise.resolve({ id: nodeJobId }) };

    const viaQueue = await cancelQueueJobRoute(request(`/api/queue/jobs/${nodeJobId}`), context);
    const viaV1 = await cancelV1JobRoute(request(`/api/v1/jobs/${nodeJobId}`), context);

    expect(viaQueue.status).toBe(HTTP_CONFLICT);
    expect(await viaQueue.json()).toMatchObject({ graphId: queued.graphId });
    expect(viaV1.status).toBe(HTTP_CONFLICT);
    expect(await viaV1.json()).toMatchObject({ graphId: queued.graphId });
    expect((await getJobAcrossQueues(nodeJobId))?.state).toBe('waiting');

    startWorker();
    await queued.ended('completed');
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('settles the reservation and sends the webhook once when removing the intermediates fails', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(undefined as never);
    vi.spyOn(storageProvider, 'deleteByPrefix').mockRejectedValue(new Error('the object store refused the delete'));
    const queued = await queueGraph(importAndConvert(), 1, { meta: WEBHOOK });
    await queued.ended('completed');
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    expect(dispatched.mock.calls[0][1]).toBe('graph.completed');
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('sends graph.completed once, with every node, when the last node to end fails under continue', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(undefined as never);
    const queued = await queueGraph(
      {
        failurePolicy: 'continue',
        nodes: {
          good: csvUpload(),
          bad: notAPngUpload(),
          toJson: { op: 'convert', input: 'good', targetFormat: 'json' },
          toJpg: { op: 'convert', input: ['bad', 'toJson'], targetFormat: 'jpg' },
        },
      },
      1,
      { meta: WEBHOOK }
    );
    await queued.ended('completed');

    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    const [url, event, payload, secret] = dispatched.mock.calls[0];
    expect([url, event, secret]).toEqual([WEBHOOK.webhookUrl, 'graph.completed', WEBHOOK.webhookSecret]);
    expect(payload).toMatchObject({
      jobId: queued.graphId,
      graphId: queued.graphId,
      status: 'completed',
      nodes: { good: { status: 'completed' }, bad: { status: 'completed' }, toJson: { status: 'completed' }, toJpg: { status: 'failed' } },
    });
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges the bytes an import.url node brings in to the day of the graph owner, and the conversion one unit', async () => {
    remoteCsv();
    const queued = await queueGraph({ failurePolicy: 'fail_fast', nodes: { link: { op: 'import.url', url: LINK }, conv: { op: 'convert', input: 'link', targetFormat: 'json' } } }, 1);
    await queued.ended('completed');
    expect(await bytesBroughtInToday(queued.owner)).toBe(Buffer.byteLength(CSV));
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('fails an import.url node with import_budget_exceeded, and charges no unit, once the day of the graph owner is spent', async () => {
    remoteCsv();
    const owner = anonymousOwner();
    const spent = await reserveLinkImport(owner, 'anonymous', GRAPH_TIMEOUT_MS);
    if ('refusal' in spent) throw new Error('a fresh owner has its whole day');
    await spent.reservation.settle(dailyBudgetBytes('anonymous'));

    const queued = await queueGraph({ failurePolicy: 'fail_fast', nodes: { link: { op: 'import.url', url: LINK }, conv: { op: 'convert', input: 'link', targetFormat: 'json' } } }, 0, { owner });
    await queued.ended('failed');
    expect((await getJobAcrossQueues(`${queued.graphId}:link`))?.failedRefusalCode).toBe('import_budget_exceeded');
    expect(await bytesBroughtInToday(owner)).toBe(dailyBudgetBytes('anonymous'));
    expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
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

  it('charges the one convert node of three that completes under continue', async () => {
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

  it('charges the two convert nodes that complete beside one that fails under continue', async () => {
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

  it('ends a tasks pipeline of /api/v1/jobs failed, and charges nothing, when its convert task fails', async () => {
    const account = await apiAccount();
    startWorker();

    const submitted = await v1JobsRoute(
      new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: account.authorization },
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
    await vi.waitFor(async () => expect((await redisKeyStore.getQuotaUsage(account.userId)).usedToday).toBe(0), { timeout: 5_000, interval: 50 });
  }, GRAPH_TIMEOUT_MS + 10_000);
}
