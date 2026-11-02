import crypto from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { fetch as undiciFetch } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { POST as v1JobsRoute } from '../../src/app/api/v1/jobs/route';
import { DELETE as cancelQueueJobRoute } from '../../src/app/api/queue/jobs/[id]/route';
import { DELETE as cancelV1JobRoute } from '../../src/app/api/v1/jobs/[id]/route';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { LINK_IMPORT_METER_BATCH_BYTES, bytesBroughtInToday, dailyBudgetBytes } from '../../src/lib/api-keys/anonymous-upload-budget';
import { webhookDispatcher } from '../../src/lib/api-keys/webhook-dispatcher';
import { anonymousUserId } from '../../src/lib/auth/anonymous-identity';
import { formatBytes } from '../../src/lib/format-bytes';
import { getAnonymousDailyLimit } from '../../src/lib/plan-limits';
import { dispatchEngine } from '../../src/lib/queue/dispatch-engine';
import { Worker } from '../../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, cancelJobAcrossQueues, getJobAcrossQueues, processConversionJob } from '../../src/lib/queue/conversion-queue';
import { graphScheduler, type GraphMetadata, type JobGraph } from '../../src/lib/queue/graph';
import { userStore } from '../../src/lib/auth/user-store';
import { storageProvider } from '../../src/lib/storage';
import { s3Storage } from '../../src/lib/storage/s3-storage';
import { StorageServiceError } from '../../src/lib/storage/adapters/adapter-interface';
import { ConversionFailedError, QueueUnavailableError, type ConversionJobData, type ConversionJobResult } from '../../src/lib/types';
import { SecretSealError, unsealJobSecret } from '../../src/lib/security/job-secret-seal';
import { gzipRemote } from './gzip-remote';
import { spendImportBytes } from './import-budget';

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
/** A sealed password that fails the format check of a sealed blob (no `sealed:v1:` prefix), so it never opens under any key. */
const MALFORMED_SEALED_BLOB = 'not-a-sealed-blob';
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

function csvUpload(name = 'scores.csv', content = CSV) {
  return { op: 'import.upload', storageKey: saveUpload(name, content, 'text/csv') } as const;
}

/** A small picture of one colour, as an upload a thumbnail node reads. */
async function pngUpload(name: string, colour: string) {
  const picture = await sharp({ create: { width: 64, height: 48, channels: 3, background: colour } }).png().toBuffer();
  return { op: 'import.upload', storageKey: saveUpload(name, picture, 'image/png') } as const;
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
  vi.mocked(undiciFetch).mockClear();
  vi.mocked(undiciFetch).mockImplementation(async () => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } }) as never);
}

/** A graph as `/api/v1/jobs` accepts it, where any node may name several inputs; the scheduler stores it as it is. */
interface SubmittedGraph {
  failurePolicy: 'fail_fast' | 'continue';
  nodes: Record<string, Record<string, unknown> & { op: string }>;
}

function newGraphId(): string {
  return `graph_charge_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** A ZIP of `count` CSV files, as an upload an archive.extract node unpacks. */
async function csvArchiveUpload(count: number) {
  const zip = new JSZip();
  for (let i = 1; i <= count; i++) zip.file(`part-${i}.csv`, CSV);
  return { op: 'import.upload', storageKey: saveUpload('parts.zip', await zip.generateAsync({ type: 'nodebuffer' }), 'application/zip') } as const;
}

/** The seal error `open` throws; fails when it throws none or another error. */
function sealFailureOf(open: () => unknown): SecretSealError {
  try {
    open();
  } catch (error) {
    if (error instanceof SecretSealError) return error;
    throw error;
  }
  throw new Error('the sealed value opened');
}

function anonymousOwner(): string {
  return anonymousUserId(`192.0.2.${crypto.randomInt(1, 255)}-${crypto.randomBytes(4).toString('hex')}`);
}


/** What a suite can do to the quota store besides what every store does. */
interface StoreControls {
  /** Ends the day of `owner`'s daily count, as midnight does: its count expires while a reservation made that day lives on. */
  endDay?: (owner: string) => Promise<void>;
}

/** Registers the cases; `track` receives each owner, for a suite that removes its keys afterwards. */
export function itChargesAGraphOnlyThroughItsScheduler(track: (userId: string) => void = () => undefined, controls: StoreControls = {}): void {
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
   * Queues `graph` for `owner` with one unit more reserved than `expectedUnits` (or `reservedUnits`, as a route reserves
   * them), and answers how to wait for its end, with `expectedUnits` used that day. `startWorkers` is false for a case
   * that acts on the queued node jobs before any worker takes them.
   */
  async function queueGraph(
    graph: SubmittedGraph,
    expectedUnits: number,
    options: { owner?: string; meta?: GraphMetadata; startWorkers?: boolean; graphId?: string; reservedUnits?: number } = {}
  ) {
    const owner = options.owner ?? anonymousOwner();
    track(owner);
    const usedToday = async () => (await redisKeyStore.getQuotaUsage(owner)).usedToday;
    const usedBefore = await usedToday();
    const reservedUnits = options.reservedUnits ?? expectedUnits + 1;
    const unit = await redisKeyStore.reserveQuota(owner, reservedUnits);
    expect(unit.allowed).toBe(true);
    expect(await usedToday()).toBe(usedBefore + reservedUnits);

    if (options.startWorkers !== false) startWorker();
    const graphId = options.graphId ?? newGraphId();
    await graphScheduler.initGraph(graphId, graph as unknown as JobGraph, { ownerUserId: owner, reservationId: unit.reservationId, originalFilename: 'input', ...options.meta });

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

  /**
   * The job of node `nodeId` of graph `graphId` once its queue recorded its failure, which comes after the node reported
   * the failure to the scheduler and so may come after the graph ended.
   */
  async function failedNodeJob(graphId: string, nodeId: string) {
    return vi.waitFor(
      async () => {
        const job = await getJobAcrossQueues(`${graphId}:${nodeId}`);
        expect(job?.state).toBe('failed');
        return job;
      },
      { timeout: 5_000, interval: 20 }
    );
  }

  async function runGraph(graph: SubmittedGraph, expectedStatus: 'completed' | 'failed', expectedUnits: number): Promise<void> {
    const queued = await queueGraph(graph, expectedUnits);
    await queued.ended(expectedStatus);
  }

  const importAndConvert = (): SubmittedGraph => ({ failurePolicy: 'fail_fast', nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' } } });

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

  /**
   * The objects node `nodeId` of graph `graphId` answered with, read once the graph ended: the graph's intermediate files are
   * kept for the read, so each key the node named can be opened.
   */
  async function storedOutputs(graphId: string, nodeId: string) {
    const keys = await graphScheduler.getNodeOutputs(graphId, nodeId);
    return Promise.all(
      [...new Set(keys)].map(async (key) => {
        const stored = await storageProvider.getObject(key);
        if (!stored) throw new Error(`the output ${key} of node ${nodeId} is not in storage`);
        return stored;
      })
    );
  }

  it('stores a thumbnail for each of two pictures and charges a unit for each', async () => {
    vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
    const queued = await queueGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          red: await pngUpload('red.png', '#ff0000'),
          blue: await pngUpload('blue.png', '#0000ff'),
          thumbs: { op: 'thumbnail', input: ['red', 'blue'], targetFormat: 'png' },
        },
      },
      2
    );
    await queued.ended('completed');

    const thumbnails = await storedOutputs(queued.graphId, 'thumbs');
    expect(thumbnails).toHaveLength(2);
    const colours = await Promise.all(thumbnails.map(async ({ buffer }) => (await sharp(buffer).raw().toBuffer()).subarray(0, 3).toString('hex')));
    expect(colours.sort()).toEqual(['0000ff', 'ff0000']);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('stores a result for each of two inputs of the same name, under that name, and charges a unit for each', async () => {
    vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
    const queued = await queueGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          monday: csvUpload('scores.csv', 'name,score\nAlice,100\n'),
          tuesday: csvUpload('scores.csv', 'name,score\nBob,95\n'),
          conv: { op: 'convert', input: ['monday', 'tuesday'], targetFormat: 'json' },
        },
      },
      2
    );
    await queued.ended('completed');

    const results = await storedOutputs(queued.graphId, 'conv');
    expect(results.map((stored) => stored.filename)).toEqual(['scores.json', 'scores.json']);
    expect(results.map((stored) => JSON.parse(stored.buffer.toString('utf-8'))[0].name).sort((x: string, y: string) => x.localeCompare(y))).toEqual(['Alice', 'Bob']);
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

  it('gives the units back when the password of a convert node is malformed, before the node starts its work', async () => {
    const formatCheck = sealFailureOf(() => unsealJobSecret(MALFORMED_SEALED_BLOB, 'any-job'));
    expect(formatCheck.code).toBe('MALFORMED_BLOB');
    const queued = await queueGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json', options: { sealedPassword: MALFORMED_SEALED_BLOB } } },
      },
      0
    );
    await queued.ended('failed');
    expect((await graphScheduler.getGraphState(queued.graphId))?.nodes.conv.error).toBe(formatCheck.message);
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
    await spendImportBytes(owner, 'anonymous', dailyBudgetBytes('anonymous'));

    const queued = await queueGraph({ failurePolicy: 'fail_fast', nodes: { link: { op: 'import.url', url: LINK }, conv: { op: 'convert', input: 'link', targetFormat: 'json' } } }, 0, { owner });
    await queued.ended('failed');
    expect((await failedNodeJob(queued.graphId, 'link'))?.failedRefusalCode).toBe('import_budget_exceeded');
    expect(await bytesBroughtInToday(owner)).toBe(dailyBudgetBytes('anonymous'));
    expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('completes two import.url nodes that read at once and a convert node over both, for a free account with one file of its day left', async () => {
    // Neither remote answers until both imports have fetched, so both are reading before either ends.
    let fetched = 0;
    let answerBoth: () => void = () => undefined;
    const bothFetched = new Promise<void>((resolve) => (answerBoth = resolve));
    vi.mocked(undiciFetch).mockImplementation(async () => {
      fetched += 1;
      if (fetched === 2) answerBoth();
      await bothFetched;
      return new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } }) as never;
    });
    const account = await apiAccount();
    const receivedEarlier = dailyBudgetBytes('free') / 2;
    await spendImportBytes(account.userId, 'free', receivedEarlier);
    const queued = await queueGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          first: { op: 'import.url', url: 'https://files.example.com/first.csv' },
          second: { op: 'import.url', url: 'https://files.example.com/second.csv' },
          conv: { op: 'convert', input: ['first', 'second'], targetFormat: 'json' },
        },
      },
      2,
      { owner: account.userId }
    );
    await queued.ended('completed');
    expect(fetched).toBe(2);
    expect(await bytesBroughtInToday(account.userId)).toBe(receivedEarlier + 2 * Buffer.byteLength(CSV));
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('stops an import.url node once its owner passes the day while it reads, at most one batch past the budget', async () => {
    const mebibyte = new Uint8Array(1024 * 1024);
    let cancelled = false;
    vi.mocked(undiciFetch).mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(mebibyte),
        cancel: () => {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } }) as never;
    });
    const owner = anonymousOwner();
    await spendImportBytes(owner, 'anonymous', dailyBudgetBytes('anonymous') - mebibyte.length);

    const queued = await queueGraph({ failurePolicy: 'fail_fast', nodes: { link: { op: 'import.url', url: LINK }, conv: { op: 'convert', input: 'link', targetFormat: 'json' } } }, 0, { owner });
    await queued.ended('failed');
    expect((await failedNodeJob(queued.graphId, 'link'))?.failedRefusalCode).toBe('import_budget_exceeded');
    expect(cancelled).toBe(true);
    const charged = await bytesBroughtInToday(owner);
    expect(charged).toBeGreaterThan(dailyBudgetBytes('anonymous'));
    expect(charged).toBeLessThanOrEqual(dailyBudgetBytes('anonymous') + LINK_IMPORT_METER_BATCH_BYTES);
  }, GRAPH_TIMEOUT_MS + 10_000);

  const importThenConvert = (): SubmittedGraph => ({
    failurePolicy: 'fail_fast',
    nodes: { link: { op: 'import.url', url: LINK }, conv: { op: 'convert', input: 'link', targetFormat: 'json' } },
  });

  it('imports a gzipped file whose Content-Length is its compressed size whole, and charges the bytes it decoded', async () => {
    vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
    const rows = 2000;
    const csv = `name,score\n${'Alice,100\n'.repeat(rows)}`;
    const remote = await gzipRemote(csv);
    try {
      const queued = await queueGraph(importThenConvert(), 1);
      await queued.ended('completed');

      const [converted] = await storedOutputs(queued.graphId, 'conv');
      expect(JSON.parse(converted.buffer.toString('utf-8'))).toHaveLength(rows);
      expect(remote.compressedBytes).toBeLessThan(Buffer.byteLength(csv));
      expect(await bytesBroughtInToday(queued.owner)).toBe(Buffer.byteLength(csv));
    } finally {
      await remote.close();
    }
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('fails an import.url node with import_budget_exceeded when its owner reaches the day while it reads, through a store that wraps the errors of the stream it saves', async () => {
    remoteCsv();
    const saveObjectFromStream = storageProvider.saveObjectFromStream.bind(storageProvider);
    vi.spyOn(storageProvider, 'saveObjectFromStream').mockImplementation(async (...args) => {
      try {
        return await saveObjectFromStream(...args);
      } catch (err) {
        throw new StorageServiceError('The object store could not take the upload', 's3', { statusCode: 500, retryable: false }, err);
      }
    });
    const owner = anonymousOwner();
    await spendImportBytes(owner, 'anonymous', dailyBudgetBytes('anonymous') - Buffer.byteLength(CSV) + 1);

    const queued = await queueGraph(importThenConvert(), 0, { owner });
    await queued.ended('failed');
    const link = await failedNodeJob(queued.graphId, 'link');
    expect(link?.failedRefusalCode).toBe('import_budget_exceeded');
    expect(link?.attemptsMade).toBe(1);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('keeps the results of two export.internal nodes apart when their outputs share a name', async () => {
    const queued = await queueGraph(
      {
        failurePolicy: 'fail_fast',
        nodes: {
          monday: csvUpload('scores.csv', 'name,score\nAlice,100\n'),
          tuesday: csvUpload('scores.csv', 'name,score\nBob,95\n'),
          mondayJson: { op: 'convert', input: 'monday', targetFormat: 'json' },
          tuesdayJson: { op: 'convert', input: 'tuesday', targetFormat: 'json' },
          mondayResult: { op: 'export.internal', input: 'mondayJson' },
          tuesdayResult: { op: 'export.internal', input: 'tuesdayJson' },
        },
      },
      2
    );
    await queued.ended('completed');

    const exported = async (nodeId: string) =>
      (await storedOutputs(queued.graphId, nodeId)).map((stored) => [stored.filename, JSON.parse(stored.buffer.toString('utf-8'))[0].name]);
    expect(await exported('mondayResult')).toEqual([['scores.json', 'Alice']]);
    expect(await exported('tuesdayResult')).toEqual([['scores.json', 'Bob']]);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('fails an import.url node whose file declares more than its owner has left today, before reading it, and names what is left', async () => {
    const bytesLeft = Buffer.byteLength(CSV) - 1;
    vi.mocked(undiciFetch).mockImplementation(
      async () => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv', 'content-length': String(Buffer.byteLength(CSV)) } }) as never
    );
    const owner = anonymousOwner();
    await spendImportBytes(owner, 'anonymous', dailyBudgetBytes('anonymous') - bytesLeft);

    const queued = await queueGraph(importThenConvert(), 0, { owner });
    await queued.ended('failed');
    const job = await failedNodeJob(queued.graphId, 'link');
    expect(job?.failedRefusalCode).toBe('import_budget_exceeded');
    expect(job?.failedReason).toContain(formatBytes(bytesLeft));
    expect(await bytesBroughtInToday(owner)).toBe(dailyBudgetBytes('anonymous') - bytesLeft);
  }, GRAPH_TIMEOUT_MS + 10_000);

  /** An owner with `left` conversions left today, the rest of the day used by a conversion that was committed. */
  async function ownerWithUnitsLeft(left: number) {
    const owner = anonymousOwner();
    const used = getAnonymousDailyLimit() - left;
    const spent = await redisKeyStore.reserveQuota(owner, used);
    expect(spent.allowed).toBe(true);
    await redisKeyStore.commitQuota(spent.reservationId!);
    return { owner, used };
  }

  /** An archive of five files unpacked into a convert node: it reserves 2 units, one for the unpacking and one for the declared input. */
  async function fiveFilesIntoConvert(): Promise<SubmittedGraph> {
    return {
      failurePolicy: 'fail_fast',
      nodes: { zip: await csvArchiveUpload(5), unzip: { op: 'archive.extract', input: 'zip' }, conv: { op: 'convert', input: 'unzip', targetFormat: 'json' } },
    };
  }

  it('fails a convert node that receives five files with three conversions left, before any work, and charges nothing', async () => {
    const converted = vi.spyOn(dispatchEngine, 'convert');
    const { owner, used } = await ownerWithUnitsLeft(3);
    const queued = await queueGraph(await fiveFilesIntoConvert(), used, { owner, reservedUnits: 2 });
    await queued.ended('failed');
    expect((await failedNodeJob(queued.graphId, 'conv'))?.failedRefusalCode).toBe('quota_exceeded');
    expect(converted).not.toHaveBeenCalled();
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('charges a convert node that receives five files five units, beside the unpacking, with ten conversions left', async () => {
    const converted = vi.spyOn(dispatchEngine, 'convert');
    const { owner, used } = await ownerWithUnitsLeft(10);
    const queued = await queueGraph(await fiveFilesIntoConvert(), used + 1 + 5, { owner, reservedUnits: 2 });
    await queued.ended('completed');
    expect(converted).toHaveBeenCalledTimes(5);
  }, GRAPH_TIMEOUT_MS + 10_000);

  const { endDay } = controls;
  if (endDay) {
    it('runs a convert node over five unpacked files on, without extending, once the day of its reservation ended', async () => {
      const queued = await queueGraph(await fiveFilesIntoConvert(), 0, { reservedUnits: 2, startWorkers: false });
      await endDay(queued.owner);
      startWorker();
      await queued.ended('completed');
    }, GRAPH_TIMEOUT_MS + 10_000);
  }

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

  /** Makes the queues refuse the job of a graph node `times` times, before storing it, as a queue whose Redis is down does. */
  function refuseNodeJobs(times: number): void {
    let refused = 0;
    for (const queue of allConversionQueues) {
      const add = queue.add.bind(queue);
      vi.spyOn(queue, 'add').mockImplementation(async (name, data, opts) => {
        if (data.graphId && refused < times) {
          refused += 1;
          throw new QueueUnavailableError(queue.name, 'the node job could not be stored');
        }
        return add(name, data, opts);
      });
    }
  }

  const importConvertExport = (): SubmittedGraph => ({
    failurePolicy: 'fail_fast',
    nodes: { up: csvUpload(), conv: { op: 'convert', input: 'up', targetFormat: 'json' }, out: { op: 'export.internal', input: 'conv' } },
  });

  async function submitGraph(authorization: string, graph: SubmittedGraph) {
    return v1JobsRoute(
      new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ graph, targetFormat: 'json' }),
      })
    );
  }

  it('answers 202 and runs a graph whose first node could not be queued after its state was stored, once its outbox drains', async () => {
    const account = await apiAccount();
    startWorker();
    refuseNodeJobs(1);

    const submitted = await submitGraph(account.authorization, importConvertExport());
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const { jobId } = (await submitted.json()) as { jobId: string };

    await vi.waitFor(async () => expect((await graphScheduler.getGraphState(jobId))?.status).toBe('completed'), { timeout: GRAPH_TIMEOUT_MS, interval: 100 });
    await vi.waitFor(async () => expect((await redisKeyStore.getQuotaUsage(account.userId)).usedToday).toBe(1), { timeout: 5_000, interval: 50 });
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('answers 503 and charges nothing for a graph whose stored outbox cannot be drained either', async () => {
    const account = await apiAccount();
    refuseNodeJobs(Number.POSITIVE_INFINITY);

    const submitted = await submitGraph(account.authorization, importConvertExport());

    expect(submitted.status, await submitted.clone().text()).toBe(503);
    expect((await redisKeyStore.getQuotaUsage(account.userId)).usedToday).toBe(0);
  }, GRAPH_TIMEOUT_MS + 10_000);
}
