import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { Validator } from '@seriousme/openapi-schema-validator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSING_WEBHOOK_SECRET_REASON,
  WebhookDispatcher,
  computeRetryDelay,
} from '../src/lib/api-keys/webhook-dispatcher';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { endUploadReservation } from '../src/lib/api-keys/anonymous-upload-budget';
import { userStore } from '../src/lib/auth/user-store';
import { validateJobGraph } from '../src/lib/jobs/graph';
import { GRAPH_OPERATIONS } from '../src/lib/jobs/graph-operations';
import {
  AzureBlobStorageAdapter,
  GcsStorageAdapter,
  StorageInvalidKeyError,
  StorageListingLimitError,
  StorageSsrfError,
  WebDavStorageAdapter,
} from '../src/lib/storage/adapters';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';
import { storageProvider } from '../src/lib/storage';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { graphScheduler } from '../src/lib/queue/graph';
import { middleware } from '../src/middleware';
import { GET as getPublicOpenApiJson } from '../src/app/api/v1/openapi.json/route';
import { GET as getPublicOpenApiAlias } from '../src/app/api/v1/openapi/route';
import { GET as getFullOpenApiJson } from '../src/app/api/openapi.json/route';
import { GET as getQueueStats } from '../src/app/api/queue/stats/route';
import { GET as getJobs, POST as postJobs } from '../src/app/api/v1/jobs/route';
import { GET as getJobById } from '../src/app/api/v1/jobs/[id]/route';
import {
  OPTIONS as optionsV1Uploads,
  PATCH as patchV1Upload,
  POST as postV1Uploads,
} from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as postDirectUpload } from '../src/app/api/v1/uploads/direct/route';
import { PUT as putDirectUploadPart } from '../src/app/api/v1/uploads/direct/part/route';
import { GET as getOcrLanguages } from '../src/app/api/v1/ocr/languages/route';
import { GET as getStorageCredentials } from '../src/app/api/v1/storage/credentials/route';
import { POST as rotateWebhookSecret } from '../src/app/api/v1/webhooks/secrets/rotate/route';
import { POST as inspectArchive } from '../src/app/api/v1/archives/inspect/route';
import { GET as getStoredFile } from '../src/app/api/storage/file/[...key]/route';
import { POST as postConvert } from '../src/app/api/convert/route';
import { POST as postV1Convert } from '../src/app/api/v1/convert/route';
import { POST as postConvertBatch } from '../src/app/api/convert/batch/route';
import { POST as postBundle } from '../src/app/api/storage/bundle/route';
import { toolPost } from '../src/app/api/tools/handler';
import * as qpdfRunner from '../src/lib/conversions/pdf-postprocess/qpdf-runner';
import * as pdfTextHost from '../src/lib/conversions/pdf-text-host';

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface LocalHttpServer {
  origin: string;
  host: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

const openServers: LocalHttpServer[] = [];
const tempDirs: string[] = [];

async function startLocalServer(
  handler: (req: CapturedRequest, res: http.ServerResponse) => void
): Promise<LocalHttpServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const instance: LocalHttpServer = {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  openServers.push(instance);
  return instance;
}

async function createPaidApiKey() {
  const user = await userStore.createUser({
    email: `b2bp0_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@example.test`,
    name: 'B2B P0 User',
    tier: 'paid',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'B2B P0 Key', { scopes: ['*'] });
  return { user, secretKey: key.secretKey, keyId: key.key.id };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (openServers.length > 0) {
    await openServers.pop()!.close();
  }
});

afterAll(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('P0-1: Durable Webhook Retry Queue (svix pattern)', () => {
  const dispatchers: WebhookDispatcher[] = [];

  afterEach(async () => {
    while (dispatchers.length > 0) {
      await dispatchers.pop()!.close();
    }
  });

  function makeLocalDispatcher() {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string; at: number }> = [];
    const responses: Array<{ status: number; headers?: Record<string, string> }> = [];
    const dispatcher = new WebhookDispatcher(undefined, (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      seen.push({
        url,
        headers: { ...(init?.headers ?? {}) },
        body: typeof init?.body === 'string' ? init.body : '',
        at: Date.now(),
      });
      const next = responses.shift() ?? { status: 200 };
      return new Response('', { status: next.status, headers: next.headers });
    }) as never);
    dispatchers.push(dispatcher);
    return { dispatcher, seen, responses };
  }

  it('retries failed deliveries via BullMQ delayed queue while preserving Webhook-Id and Retry-After delay', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const owner = await userStore.createUser({ email: `wh_${Date.now()}@test.local`, name: 'WH', tier: 'paid' });
    const { dispatcher, seen, responses } = makeLocalDispatcher();
    responses.push({ status: 503, headers: { 'Retry-After': '1' } }, { status: 200 });

    const job = await dispatcher.enqueueDelivery(
      'https://hooks.example.com/events',
      'job.completed',
      { jobId: 'job_retry_1' },
      'whsec_retry_secret',
      { ownerUserId: owner.id, deliveryId: 'wh_idempotent_1', maxRetries: 4, retrySchedule: [25, 50] }
    );
    expect(job.id).toMatch(/^job_/);

    await waitUntil(() => seen.length >= 2, 5000);

    expect(seen).toHaveLength(2);
    expect(seen[0].headers['Webhook-Id']).toBe('wh_idempotent_1');
    expect(seen[1].headers['Webhook-Id']).toBe('wh_idempotent_1');
    // Retry-After: 1 must delay attempt 2 by ~1000ms rather than 25ms fallback
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(850);
    expect(await dispatcher.getDlqEntries(owner.id)).toEqual([]);
    expect(computeRetryDelay(1, new Headers({ 'Retry-After': '120' }))).toBe(120_000);
  });

  it('stops permanently on 410 Gone without DLQ entry and routes non-retryable 4xx immediately to DLQ', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const owner = await userStore.createUser({ email: `wh410_${Date.now()}@test.local`, name: 'WH410', tier: 'paid' });

    const gone = makeLocalDispatcher();
    gone.responses.push({ status: 410 });
    await gone.dispatcher.enqueueDelivery(
      'https://hooks.example.com/gone',
      'job.completed',
      { jobId: 'job_410' },
      'whsec_410',
      { ownerUserId: owner.id, deliveryId: 'wh_gone_1', maxRetries: 4, retrySchedule: [20, 40] }
    );
    await waitUntil(() => gone.seen.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gone.seen).toHaveLength(1);
    expect(await gone.dispatcher.getDlqEntries(owner.id)).toEqual([]);

    const badReq = makeLocalDispatcher();
    badReq.responses.push({ status: 400 });
    await badReq.dispatcher.enqueueDelivery(
      'https://hooks.example.com/bad',
      'job.failed',
      { jobId: 'job_400' },
      'whsec_400',
      { ownerUserId: owner.id, deliveryId: 'wh_bad_1', maxRetries: 4, retrySchedule: [20, 40] }
    );
    await waitUntil(async () => (await badReq.dispatcher.getDlqEntries(owner.id)).length === 1);
    expect(badReq.seen).toHaveLength(1);
    const dlq = await badReq.dispatcher.getDlqEntries(owner.id);
    expect(dlq[0].finalStatusCode).toBe(400);
    expect(dlq[0].retryCount).toBe(1);
  });

  it('moves exhausted deliveries to DLQ and handles empty secret fail-closed without infinite retry loop', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const owner = await userStore.createUser({ email: `whdlq_${Date.now()}@test.local`, name: 'WHDLQ', tier: 'paid' });

    const exhausted = makeLocalDispatcher();
    exhausted.responses.push({ status: 502 }, { status: 502 }, { status: 502 });
    await exhausted.dispatcher.enqueueDelivery(
      'https://hooks.example.com/down',
      'graph.completed',
      { jobId: 'graph_down' },
      'whsec_down',
      { ownerUserId: owner.id, deliveryId: 'wh_down_1', maxRetries: 2, retrySchedule: [20, 20] }
    );
    await waitUntil(async () => (await exhausted.dispatcher.getDlqEntries(owner.id)).length === 1);
    expect(exhausted.seen).toHaveLength(2);
    const dlqExhausted = await exhausted.dispatcher.getDlqEntries(owner.id);
    expect(dlqExhausted[0].retryCount).toBe(2);
    expect(dlqExhausted[0].finalStatusCode).toBe(502);

    const noSecret = makeLocalDispatcher();
    await noSecret.dispatcher.enqueueDelivery(
      'https://hooks.example.com/nosecret',
      'key.expiring_soon',
      { keyId: 'k1' },
      '',
      { ownerUserId: owner.id, deliveryId: 'wh_empty_sec_1', maxRetries: 3, retrySchedule: [15, 15] }
    );
    await waitUntil(async () => (await noSecret.dispatcher.getDlqEntries(owner.id)).length === 1);
    expect(noSecret.seen).toHaveLength(0);
    const dlqEmpty = await noSecret.dispatcher.getDlqEntries(owner.id);
    expect(dlqEmpty[0].errorMessage).toBe(MISSING_WEBHOOK_SECRET_REASON);
  });

  it('enqueues key.expiring_soon via enqueueDelivery and closes webhook worker cleanly during drainWorker()', async () => {
    const { webhookDispatcher } = await import('../src/lib/api-keys/webhook-dispatcher');
    const enqueueSpy = vi.spyOn(webhookDispatcher, 'enqueueDelivery').mockResolvedValue({ id: 'job_spy' } as never);
    const owner = await userStore.createUser({ email: `exp_${Date.now()}@test.local`, name: 'EXP', tier: 'paid' });
    const key = await redisKeyStore.generateApiKey(owner.id, 'Expiring', {
      expiresAt: Date.now() + 2 * 86_400_000,
      webhookUrl: 'https://hooks.example.com/expiry',
      webhookSecret: 'whsec_expiry',
    });

    const auth = await validateApiAccess(
      new Request('https://example.test/api/v1/jobs', { headers: { Authorization: `Bearer ${key.secretKey}` } }),
      0
    );
    expect(auth.authorized).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][1]).toBe('key.expiring_soon');

    const { drainWorker, resetWorkerLifecycleState } = await import('../src/worker/index');
    const { libreOfficePool } = await import('../src/worker/engines');
    vi.spyOn(libreOfficePool, 'shutdown').mockResolvedValue(undefined);
    vi.spyOn(qpdfRunner, 'stopQpdfRunner').mockImplementation(() => undefined);
    vi.spyOn(pdfTextHost, 'shutdownPdfTextThreads').mockImplementation(() => undefined);
    const closeSpy = vi.spyOn(webhookDispatcher, 'close').mockResolvedValue(undefined);
    try {
      await drainWorker('SIGTERM', 50);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      resetWorkerLifecycleState();
    }
  });
});

describe('P0-2: BYOS Native GCS, Azure Blob & WebDAV E2E DAG Execution + Security Bounds', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });

  it('registers all 6 operations in GRAPH_OPERATIONS and runs GCS import->convert->export E2E DAG', async () => {
    for (const op of ['import.gcs', 'export.gcs', 'import.azure-blob', 'export.azure-blob', 'import.webdav', 'export.webdav'] as const) {
      expect(GRAPH_OPERATIONS).toContain(op);
    }

    const storedObjects = new Map<string, { body: Buffer; contentType: string }>();
    storedObjects.set('in/sample.csv', { body: Buffer.from('id,name\n1,Ada\n'), contentType: 'text/csv' });

    const gcsServer = await startLocalServer((req, res) => {
      const parsed = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && parsed.pathname === '/storage/v1/b/my-bucket/o' && parsed.searchParams.get('alt') !== 'media') {
        const prefix = parsed.searchParams.get('prefix') ?? '';
        const items = [...storedObjects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([name, val]) => ({ name, size: String(val.body.length) }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items }));
        return;
      }
      const prefix = '/storage/v1/b/my-bucket/o/';
      if (req.method === 'GET' && parsed.pathname.startsWith(prefix)) {
        const key = decodeURIComponent(parsed.pathname.slice(prefix.length));
        const item = storedObjects.get(key);
        if (!item) {
          res.writeHead(404).end();
          return;
        }
        if (parsed.searchParams.get('alt') === 'media') {
          res.writeHead(200, { 'Content-Type': item.contentType, 'Content-Length': String(item.body.length) }).end(item.body);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ size: String(item.body.length), contentType: item.contentType }));
        return;
      }
      if (req.method === 'POST' && parsed.pathname === '/upload/storage/v1/b/my-bucket/o') {
        const name = parsed.searchParams.get('name') ?? '';
        storedObjects.set(name, { body: req.body, contentType: String(req.headers['content-type'] || 'application/octet-stream') });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ size: String(req.body.length), contentType: 'application/json' }));
        return;
      }
      res.writeHead(404).end();
    });
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, gcsServer.host);

    const graph = {
      failurePolicy: 'fail_fast' as const,
      nodes: {
        src: { op: 'import.gcs' as const, prefix: 'in/', credentials: { bucket: 'my-bucket', endpoint: gcsServer.origin } },
        conv: { op: 'convert' as const, input: 'src', targetFormat: 'json' },
        dst: { op: 'export.gcs' as const, input: 'conv', prefix: 'out/', credentials: { bucket: 'my-bucket', endpoint: gcsServer.origin } },
      },
    };
    const validation = validateJobGraph(graph);
    expect(validation.valid).toBe(true);

    const { user, secretKey } = await createPaidApiKey();
    const res = await postJobs(
      new NextRequest('http://localhost/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
        body: JSON.stringify({ sourceFormat: 'csv', graph }),
      })
    );
    expect(res.status).toBe(202);
    const created = await res.json();
    await graphScheduler.cancelGraph(created.jobId, 'cleanup submitted test graph').catch(() => {});

    const graphId = `g_gcs_${Date.now()}`;
    const sealedRun = sealGraph(graphId, graph as never);
    expect((sealedRun.nodes.src as { credentials?: unknown }).credentials).toBeUndefined();
    expect(typeof (sealedRun.nodes.src as { sealed?: unknown }).sealed).toBe('string');
    await graphScheduler.initGraph(graphId, sealedRun, { ownerUserId: user.id });

    const runNode = (nodeId: string, node: unknown, inputArtifacts?: string[]) =>
      processGraphNodeJob(
        {
          id: `${graphId}:${nodeId}`,
          data: { graphId, graphNodeId: nodeId, userId: user.id, graphNode: node, inputArtifacts },
          opts: { attempts: 1, timeout: 60_000 },
          attemptsMade: 1,
          signal: new AbortController().signal,
          log: async () => {},
          updateProgress: async () => {},
        } as never,
        undefined,
        storageProvider
      );

    const srcRes = await runNode('src', sealedRun.nodes.src);
    expect(srcRes.resultKey).toBeTruthy();
    const convRes = await runNode('conv', sealedRun.nodes.conv, [srcRes.resultKey]);
    await runNode('dst', sealedRun.nodes.dst, [convRes.resultKey]);
    await graphScheduler.cancelGraph(graphId, 'cleanup test graph').catch(() => {});

    const exported = [...storedObjects.keys()].find((k) => k.startsWith('out/') && k.endsWith('.json'));
    expect(exported).toMatch(/^out\/.+\.json$/);
    expect(JSON.parse(storedObjects.get(exported!)!.body.toString('utf8'))).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('executes Azure Blob and WebDAV import->convert->export DAG nodes end-to-end', async () => {
    const azureKey = Buffer.from('azure-b2b-test-key').toString('base64');
    const azureBlobs = new Map<string, Buffer>([['docs/data.csv', Buffer.from('k,v\na,1\n')]]);
    const azureServer = await startLocalServer((req, res) => {
      const parsed = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && parsed.pathname === '/ctr' && parsed.searchParams.get('comp') === 'list') {
        expect(String(req.headers.authorization || '')).toMatch(/^SharedKey devacct:/);
        const xml = `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs><Blob><Name>docs/data.csv</Name><Properties><Content-Length>${azureBlobs.get('docs/data.csv')!.length}</Content-Length></Properties></Blob></Blobs></EnumerationResults>`;
        res.writeHead(200, { 'Content-Type': 'application/xml' }).end(xml);
        return;
      }
      const key = decodeURIComponent(parsed.pathname.replace(/^\/ctr\//, ''));
      if (req.method === 'PUT') {
        azureBlobs.set(key, req.body);
        res.writeHead(201, { ETag: '"az-1"' }).end();
        return;
      }
      const found = azureBlobs.get(key);
      if (!found) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(found.length) }).end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(found.length) }).end(found);
    });

    const davFiles = new Map<string, Buffer>([['input/note.csv', Buffer.from('col\nhello\n')]]);
    const davServer = await startLocalServer((req, res) => {
      const parsed = new URL(req.url, 'http://localhost');
      if (req.method === 'PROPFIND') {
        const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/input/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/dav/input/note.csv</D:href><D:propstat><D:prop><D:getcontentlength>${davFiles.get('input/note.csv')!.length}</D:getcontentlength><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end(xml);
        return;
      }
      const rel = decodeURIComponent(parsed.pathname.replace(/^\/dav\//, ''));
      if (req.method === 'PUT') {
        davFiles.set(rel, req.body);
        res.writeHead(201).end();
        return;
      }
      const found = davFiles.get(rel);
      if (!found) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(found.length) }).end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(found.length) }).end(found);
    });
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${azureServer.host},${davServer.host}`);

    const { user: azUser } = await createPaidApiKey();
    const azGraphId = `g_az_${Date.now()}`;
    const azureGraph = sealGraph(azGraphId, {
      failurePolicy: 'fail_fast',
      nodes: {
        imp: { op: 'import.azure-blob', prefix: 'docs/', credentials: { storageAccount: 'devacct', containerName: 'ctr', accountKey: azureKey, customEndpoint: azureServer.origin } },
        conv: { op: 'convert', input: 'imp', targetFormat: 'json' },
        exp: { op: 'export.azure-blob', input: 'conv', prefix: 'res/', credentials: { storageAccount: 'devacct', containerName: 'ctr', accountKey: azureKey, customEndpoint: azureServer.origin } },
      },
    } as never);
    await graphScheduler.initGraph(azGraphId, azureGraph, { ownerUserId: azUser.id });
    const azIn = await processGraphNodeJob({ id: `${azGraphId}:imp`, data: { graphId: azGraphId, graphNodeId: 'imp', userId: azUser.id, graphNode: azureGraph.nodes.imp }, opts: { attempts: 1, timeout: 60_000 }, attemptsMade: 1, signal: new AbortController().signal, log: async () => {}, updateProgress: async () => {} } as never, undefined, storageProvider);
    const azConv = await processGraphNodeJob({ id: `${azGraphId}:conv`, data: { graphId: azGraphId, graphNodeId: 'conv', userId: azUser.id, graphNode: azureGraph.nodes.conv, inputArtifacts: [azIn.resultKey] }, opts: { attempts: 1, timeout: 60_000 }, attemptsMade: 1, signal: new AbortController().signal, log: async () => {}, updateProgress: async () => {} } as never, undefined, storageProvider);
    await processGraphNodeJob({ id: `${azGraphId}:exp`, data: { graphId: azGraphId, graphNodeId: 'exp', userId: azUser.id, graphNode: azureGraph.nodes.exp, inputArtifacts: [azConv.resultKey] }, opts: { attempts: 1, timeout: 60_000 }, attemptsMade: 1, signal: new AbortController().signal, log: async () => {}, updateProgress: async () => {} } as never, undefined, storageProvider);
    expect([...azureBlobs.keys()].some((k) => k.startsWith('res/') && k.endsWith('.json'))).toBe(true);
    await graphScheduler.cancelGraph(azGraphId, 'cleanup').catch(() => {});

    const { user: davUser } = await createPaidApiKey();
    const davGraphId = `g_dav_${Date.now()}`;
    const davGraph = sealGraph(davGraphId, {
      failurePolicy: 'fail_fast',
      nodes: {
        imp: { op: 'import.webdav', directory: 'input', credentials: { url: `${davServer.origin}/dav`, username: 'u', password: 'p' } },
        conv: { op: 'convert', input: 'imp', targetFormat: 'json' },
        exp: { op: 'export.webdav', input: 'conv', directory: 'output', credentials: { url: `${davServer.origin}/dav`, username: 'u', password: 'p' } },
      },
    } as never);
    await graphScheduler.initGraph(davGraphId, davGraph, { ownerUserId: davUser.id });
    const davIn = await processGraphNodeJob({ id: `${davGraphId}:imp`, data: { graphId: davGraphId, graphNodeId: 'imp', userId: davUser.id, graphNode: davGraph.nodes.imp }, opts: { attempts: 1, timeout: 60_000 }, attemptsMade: 1, signal: new AbortController().signal, log: async () => {}, updateProgress: async () => {} } as never, undefined, storageProvider);
    const davConv = await processGraphNodeJob({ id: `${davGraphId}:conv`, data: { graphId: davGraphId, graphNodeId: 'conv', userId: davUser.id, graphNode: davGraph.nodes.conv, inputArtifacts: [davIn.resultKey] }, opts: { attempts: 1, timeout: 60_000 }, attemptsMade: 1, signal: new AbortController().signal, log: async () => {}, updateProgress: async () => {} } as never, undefined, storageProvider);
    await processGraphNodeJob({ id: `${davGraphId}:exp`, data: { graphId: davGraphId, graphNodeId: 'exp', userId: davUser.id, graphNode: davGraph.nodes.exp, inputArtifacts: [davConv.resultKey] }, opts: { attempts: 1, timeout: 60_000 }, attemptsMade: 1, signal: new AbortController().signal, log: async () => {}, updateProgress: async () => {} } as never, undefined, storageProvider);
    expect([...davFiles.keys()].some((k) => k.startsWith('output/') && k.endsWith('.json'))).toBe(true);
    await graphScheduler.cancelGraph(davGraphId, 'cleanup').catch(() => {});
  });

  it('rejects DTD/XXE XML, over-limit listings, path traversal, and SSRF on new BYOS adapters', async () => {
    const xxeServer = await startLocalServer((req, res) => {
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><D:multistatus xmlns:D="DAV:"></D:multistatus>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end('<?xml version="1.0"?><!DOCTYPE foo><EnumerationResults><Blobs/></EnumerationResults>');
    });
    const tooManyServer = await startLocalServer((req, res) => {
      const parsed = new URL(req.url, 'http://localhost');
      if (parsed.pathname.startsWith('/storage/v1/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items: [{ name: 'a.txt', size: '1' }, { name: 'b.txt', size: '1' }, { name: 'c.txt', size: '1' }] }));
        return;
      }
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/a.txt</D:href><D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop></D:propstat></D:response><D:response><D:href>/b.txt</D:href><D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>');
    });
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${xxeServer.host},${tooManyServer.host}`);

    const azXxe = new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: 'devacct', containerName: 'ctr', customEndpoint: xxeServer.origin });
    await expect((azXxe as unknown as { listObjects: (p: string, m: number) => Promise<unknown> }).listObjects('', 10)).rejects.toThrow(/DTD|XML/i);

    const davXxe = new WebDavStorageAdapter({ type: 'webdav', url: xxeServer.origin });
    await expect((davXxe as unknown as { listDirectory: (d: string, m: number) => Promise<unknown> }).listDirectory('', 10)).rejects.toThrow(/DTD|XML/i);

    const gcsOver = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: tooManyServer.origin });
    await expect((gcsOver as unknown as { listObjects: (p: string, m: number) => Promise<unknown> }).listObjects('', 2)).rejects.toThrow(StorageListingLimitError);

    const davOver = new WebDavStorageAdapter({ type: 'webdav', url: tooManyServer.origin });
    await expect((davOver as unknown as { listDirectory: (d: string, m: number) => Promise<unknown> }).listDirectory('', 1)).rejects.toThrow(StorageListingLimitError);

    await expect(new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt' }).head('../escape')).rejects.toThrow(StorageInvalidKeyError);
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
    await expect(new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: 'https://private.example.com' }).head('a.txt')).rejects.toThrow(StorageSsrfError);

    const badGraph = validateJobGraph({
      failurePolicy: 'fail_fast',
      nodes: {
        imp: { op: 'import.webdav', path: '../etc/passwd', credentials: { url: 'http://169.254.169.254/dav' } },
        exp: { op: 'export.webdav', input: 'imp', directory: 'out', credentials: { url: 'http://169.254.169.254/dav' } },
      },
    });
    expect(badGraph.valid).toBe(false);
    expect(badGraph.errors.some((e) => e.code === 'INVALID_STORAGE_PATH' || e.code === 'INVALID_STORAGE_CREDENTIALS')).toBe(true);
  });
});

describe('P0-3: CORS (Hono pattern), RateLimit Headers, Upload presign & open-bytes, Security Headers', () => {
  it('handles /api/v1/* OPTIONS preflight and runtime CORS without Access-Control-Allow-Credentials, keeping TUS headers on /api/v1/uploads', async () => {
    const preflightJobs = await middleware(
      new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'OPTIONS',
        headers: { Origin: 'https://partner.example', 'Access-Control-Request-Headers': 'Authorization, Idempotency-Key' },
      })
    );
    expect(preflightJobs.status).toBe(204);
    expect(preflightJobs.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflightJobs.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(preflightJobs.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(preflightJobs.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    expect(preflightJobs.headers.get('Access-Control-Allow-Headers')).toContain('Idempotency-Key');
    expect(preflightJobs.headers.get('Access-Control-Expose-Headers')).toContain('RateLimit-Remaining');

    const preflightUploads = await middleware(
      new NextRequest('http://localhost:3000/api/v1/uploads', {
        method: 'OPTIONS',
        headers: { Origin: 'https://partner.example' },
      })
    );
    expect(preflightUploads.status).toBe(204);
    expect(preflightUploads.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflightUploads.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(preflightUploads.headers.get('Tus-Version')).toBe('1.0.0');
    expect(preflightUploads.headers.get('Tus-Extension')).toContain('creation');
    expect(preflightUploads.headers.get('Tus-Max-Size')).toMatch(/^\d+$/);

    const routeUploadsOptions = optionsV1Uploads();
    expect(routeUploadsOptions.status).toBe(204);
    expect(routeUploadsOptions.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(routeUploadsOptions.headers.get('Tus-Version')).toBe('1.0.0');

    const v1Get = await middleware(
      new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'GET',
        headers: { Origin: 'https://partner.example', Authorization: 'Bearer ec_live_dummy' },
      })
    );
    expect(v1Get.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(v1Get.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(v1Get.headers.get('Access-Control-Expose-Headers')).toContain('Idempotency-Replayed');
  });

  it('attaches consistent IETF RateLimit-* headers across /api/v1/{jobs,uploads,storage,ocr,webhooks,archives}', async () => {
    const { secretKey, keyId } = await createPaidApiKey();
    const authHeaders = { Authorization: `Bearer ${secretKey}` };

    const jobsRes = await getJobs(new NextRequest('http://localhost:3000/api/v1/jobs', { headers: authHeaders }));
    expect(jobsRes.status).toBe(200);
    expect(jobsRes.headers.get('RateLimit')).toContain('limit=');
    expect(jobsRes.headers.get('RateLimit-Remaining')).toMatch(/^\d+$/);
    expect(jobsRes.headers.get('RateLimit-Policy')).toContain(';w=');

    const missingJobRes = await getJobById(
      new NextRequest('http://localhost:3000/api/v1/jobs/missing_job', { headers: authHeaders }),
      { params: Promise.resolve({ id: 'missing_job' }) }
    );
    expect(missingJobRes.status).toBe(404);
    expect(missingJobRes.headers.get('RateLimit-Limit')).toMatch(/^\d+$/);

    const ocrRes = await getOcrLanguages(new NextRequest('http://localhost:3000/api/v1/ocr/languages', { headers: authHeaders }));
    expect(ocrRes.status).toBe(200);
    expect(ocrRes.headers.get('RateLimit-Remaining')).toMatch(/^\d+$/);

    const credRes = await getStorageCredentials(new NextRequest('http://localhost:3000/api/v1/storage/credentials', { headers: authHeaders }));
    expect(credRes.status).toBe(200);
    expect(credRes.headers.get('RateLimit-Remaining')).toMatch(/^\d+$/);

    const rotateRes = await rotateWebhookSecret(
      new NextRequest('http://localhost:3000/api/v1/webhooks/secrets/rotate', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeyId: keyId }),
      })
    );
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.headers.get('RateLimit-Remaining')).toMatch(/^\d+$/);

    const directInitRes = await postDirectUpload(
      new NextRequest('http://localhost:3000/api/v1/uploads/direct', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'test.csv', totalSize: 16 }),
      })
    );
    expect(directInitRes.status).toBe(200);
    expect(directInitRes.headers.get('RateLimit-Remaining')).toMatch(/^\d+$/);
    const directBody = await directInitRes.json();
    await endUploadReservation(directBody.uploadId, 'aborted');

    const badArchiveRes = await inspectArchive(
      new NextRequest('http://localhost:3000/api/v1/archives/inspect', {
        method: 'POST',
        headers: authHeaders,
        body: 'not-multipart',
      })
    );
    expect(badArchiveRes.headers.get('RateLimit-Remaining')).toMatch(/^\d+$/);
  });

  it('supports POST /api/v1/uploads?action=presign for partNumber > 100 and renews upload reservations on part/PATCH', async () => {
    const { secretKey } = await createPaidApiKey();
    const initRes = await postV1Uploads(
      new NextRequest('http://localhost:3000/api/v1/uploads?action=initiate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'huge.csv', totalSize: 600 * 1024 * 1024, partSize: 5 * 1024 * 1024 }),
      }),
      { params: Promise.resolve({}) }
    );
    expect(initRes.status).toBe(200);
    const initBody = await initRes.json();
    expect(initBody.presignedUrls).toHaveLength(100);
    expect(initBody.totalParts).toBe(120);

    const presignRes = await postV1Uploads(
      new NextRequest('http://localhost:3000/api/v1/uploads?action=presign', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: initBody.uploadId, key: initBody.key, partNumber: 120 }),
      }),
      { params: Promise.resolve({}) }
    );
    expect(presignRes.status).toBe(200);
    const presignBody = await presignRes.json();
    expect(presignBody.success).toBe(true);
    expect(presignBody.url).toContain('partNumber=120');

    const budgetModule = await import('../src/lib/api-keys/anonymous-upload-budget');
    const resumeSpy = vi.spyOn(budgetModule, 'resumeUploadReservation');
    const signedUrl = new URL(presignBody.url);
    const partPutRes = await putDirectUploadPart(
      new NextRequest(`http://localhost:3000${signedUrl.pathname}${signedUrl.search}`, {
        method: 'PUT',
        headers: { 'Content-Length': '5' },
        body: 'a,b\n1',
      })
    );
    expect(partPutRes.status).toBe(200);
    expect(resumeSpy).toHaveBeenCalledWith(initBody.uploadId);
    await endUploadReservation(initBody.uploadId, 'aborted');

    // TUS PATCH also renews active upload reservation
    const tusCreate = await postV1Uploads(
      new NextRequest('http://localhost:3000/api/v1/uploads', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': '6',
          'Upload-Metadata': `filename ${Buffer.from('tus.csv').toString('base64')}`,
        },
      }),
      { params: Promise.resolve({}) }
    );
    expect(tusCreate.status).toBe(201);
    const tusLocation = tusCreate.headers.get('Location')!;
    const tusId = tusLocation.split('/').pop()!;
    resumeSpy.mockClear();

    const patchRes = await patchV1Upload(
      new NextRequest(`http://localhost:3000${tusLocation}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': '0',
          'Content-Type': 'application/offset+octet-stream',
          'Content-Length': '6',
        },
        body: 'a,b\n1\n',
      }),
      { params: Promise.resolve({ id: [tusId] }) }
    );
    expect(patchRes.status).toBe(204);
    expect(resumeSpy).toHaveBeenCalledWith(tusId);
  });

  it('adds HSTS + Permissions-Policy in next.config.mjs and sandbox CSP headers across all 6 download endpoints', async () => {
    const configMod = await import('../next.config.mjs');
    const cfg = await configMod.default('phase-production-server');
    const headerRules = await cfg.headers?.();
    const headerMap = new Map(headerRules![0].headers.map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(headerMap.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(headerMap.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=(), payment=(self)');

    const { user, secretKey } = await createPaidApiKey();
    const storedKey = `conversions/${user.id}/dl-sec-${Date.now()}.txt`;
    await storageProvider.saveObject(storedKey, Buffer.from('hello'), 'text/plain', 'hello.txt');

    const assertSandboxHeaders = (res: Response) => {
      expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    };

    const fileRes = await getStoredFile(
      new NextRequest(`http://localhost:3000/api/storage/file/${encodeURIComponent(storedKey)}`, { headers: { Authorization: `Bearer ${secretKey}` } }),
      { params: Promise.resolve({ key: [storedKey] }) }
    );
    expect(fileRes.status).toBe(200);
    assertSandboxHeaders(fileRes);

    const bundleRes = await postBundle(
      new NextRequest('http://localhost:3000/api/storage/bundle', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ key: storedKey, name: 'hello.txt' }], archiveName: 'bundle.zip' }),
      })
    );
    expect(bundleRes.status).toBe(200);
    assertSandboxHeaders(bundleRes);

    const v1ConvertForm = new FormData();
    v1ConvertForm.append('file', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'data.csv');
    v1ConvertForm.append('targetFormat', 'json');
    const v1ConvertRes = await postV1Convert(
      new NextRequest('http://localhost:3000/api/v1/convert?raw=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: v1ConvertForm,
      })
    );
    expect(v1ConvertRes.status).toBe(200);
    assertSandboxHeaders(v1ConvertRes);

    const webConvertForm = new FormData();
    webConvertForm.append('file', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'data.csv');
    webConvertForm.append('targetFormat', 'json');
    const webConvertRes = await postConvert(
      new NextRequest('http://localhost:3000/api/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: webConvertForm,
      })
    );
    expect(webConvertRes.status).toBe(200);
    assertSandboxHeaders(webConvertRes);

    const batchForm = new FormData();
    batchForm.append('files', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'data.csv');
    batchForm.append('targetFormat', 'json');
    const batchRes = await postConvertBatch(
      new NextRequest('http://localhost:3000/api/convert/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: batchForm,
      })
    );
    expect(batchRes.status).toBe(200);
    assertSandboxHeaders(batchRes);

    const toolForm = new FormData();
    toolForm.append('files', new Blob(['{"a":1}'], { type: 'application/json' }), 'tool.json');
    const postArchiveTool = toolPost('archive-create');
    const toolRes = await postArchiveTool(
      new NextRequest('http://localhost:3000/api/tools/archive-create', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: toolForm,
      })
    );
    expect(toolRes.status).toBe(200);
    assertSandboxHeaders(toolRes);
  });
});

describe('P0-4: Public OpenAPI Separation, /api/queue/stats Loopback Guard, Nginx Drift Check', () => {
  it('strips x-internal routes from /api/v1/openapi.json and /api/v1/openapi while preserving full spec at /api/openapi.json', async () => {
    const fullSpec = await (await getFullOpenApiJson()).json();
    const publicJson = await (await getPublicOpenApiJson()).json();
    const publicAlias = await (await getPublicOpenApiAlias()).json();

    expect(publicJson).toEqual(publicAlias);
    expect(fullSpec.paths['/api/queue/stats']).toBeTypeOf('object');
    expect(fullSpec.paths['/api/health/conversion']).toBeTypeOf('object');

    expect(publicJson.paths['/api/queue/stats']).toBeUndefined();
    expect(publicJson.paths['/api/health/conversion']).toBeUndefined();
    expect(publicJson.paths['/api/health/live']).toBeUndefined();
    expect(publicJson.paths['/api/og']).toBeUndefined();
    expect(publicJson.paths['/api/v1/convert']).toBeTypeOf('object');
    expect(publicJson.paths['/api/v1/jobs']).toBeTypeOf('object');
    expect(publicJson.paths['/api/v1/uploads']).toBeTypeOf('object');

    for (const [route, pathItem] of Object.entries(publicJson.paths as Record<string, Record<string, { 'x-internal'?: boolean }>>)) {
      for (const [method, op] of Object.entries(pathItem)) {
        expect(op['x-internal'], `${method} ${route}`).not.toBe(true);
      }
    }

    const validator = new Validator();
    const valid = await validator.validate(publicJson);
    expect(valid.valid).toBe(true);
  });

  it('blocks external proxy forwarding headers to GET /api/queue/stats in production with 404', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const externalHeaderCases: Array<Record<string, string>> = [
      { 'x-forwarded-for': '203.0.113.10' },
      { 'cf-connecting-ip': '203.0.113.10' },
      { 'x-real-ip': '203.0.113.10' },
    ];
    for (const headers of externalHeaderCases) {
      const res = await getQueueStats(new NextRequest('http://127.0.0.1:8090/api/queue/stats', { headers }));
      expect(res.status).toBe(404);
    }

    const directLoopback = await getQueueStats(new NextRequest('http://127.0.0.1:8090/api/queue/stats'));
    expect(directLoopback.status).toBe(200);
    const localForwarded = await getQueueStats(
      new NextRequest('http://127.0.0.1:8090/api/queue/stats', { headers: { 'x-real-ip': '127.0.0.1' } })
    );
    expect(localForwarded.status).toBe(200);
  });

  it('warns in deploy.sh guard when /etc/nginx/sites-available/easyconvert differs from repo nginx-easyconvert.conf without blocking', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-nginx-drift-'));
    tempDirs.push(tmp);
    const fakeSite = path.join(tmp, 'nginx-site.conf');
    fs.writeFileSync(fakeSite, 'server { location / { return 200; } }\n');

    const repoConf = path.join(process.cwd(), 'deploy/oci/nginx-easyconvert.conf');
    const drifted = spawnSync(
      'bash',
      ['-c', `SCRIPT_DIR=${JSON.stringify(path.join(process.cwd(), 'deploy/oci'))}; source <(sed '/^case /,$d' deploy/oci/deploy.sh); NGINX_SITE_FILE=${JSON.stringify(fakeSite)} check_nginx_drift`],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(drifted.status).toBe(0);
    expect(drifted.stderr).toContain('WARNING:');
    expect(drifted.stderr).toContain('differs from');

    const matched = spawnSync(
      'bash',
      ['-c', `SCRIPT_DIR=${JSON.stringify(path.join(process.cwd(), 'deploy/oci'))}; source <(sed '/^case /,$d' deploy/oci/deploy.sh); NGINX_SITE_FILE=${JSON.stringify(repoConf)} check_nginx_drift`],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(matched.status).toBe(0);
    expect(matched.stderr).toBe('');
  });
});
