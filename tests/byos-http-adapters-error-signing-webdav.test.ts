import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AzureBlobStorageAdapter,
  GcsStorageAdapter,
  WebDavStorageAdapter,
} from '../src/lib/storage/adapters';
import {
  StorageAuthenticationError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageServiceError,
} from '../src/lib/storage/adapters/adapter-interface';
import * as httpGuard from '../src/lib/storage/adapters/http-guard';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';
import { ConversionFailedError } from '../src/lib/types';
import { StorageUnavailableError, customerStorageFailure } from '../src/lib/storage/customer-storage-errors';
import { validateJobGraph } from '../src/lib/jobs/graph';
import { exportToCustomerStorage, importFromCustomerStorage } from '../src/lib/queue/graph/node-storage-io';
import { graphNodeJobId, sealGraph } from '../src/lib/queue/graph/node-jobs';
import { storageProvider } from '../src/lib/storage/selected-storage';
import { userStore } from '../src/lib/auth/user-store';

const ACCOUNT = 'devaccount';
const CONTAINER = 'ctr';
const ACCOUNT_KEY_BYTES = Buffer.from('azure-shared-key-regression-test-32b!');
const ACCOUNT_KEY = ACCOUNT_KEY_BYTES.toString('base64');
const PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }];

interface CapturedHit {
  method: string;
  rawUrl: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface TestHttpServer {
  origin: string;
  host: string;
  hits: CapturedHit[];
  close: () => Promise<void>;
}

async function startTestServer(
  handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void
): Promise<TestHttpServer> {
  const hits: CapturedHit[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      hits.push({
        method: req.method ?? '',
        rawUrl: req.url ?? '',
        headers: req.headers,
        body,
      });
      handler(req, body, res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function allowDev(...servers: TestHttpServer[]): void {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, servers.map((s) => s.host).join(','));
}

function headerStr(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(',');
  return value ?? '';
}

function buildAzureSharedKeyStringToSign(
  method: string,
  rawUrl: string,
  headers: http.IncomingHttpHeaders,
  account: string,
  contentLengthInStringToSign: string
): string {
  const parsed = new URL(rawUrl, 'http://localhost');
  const msHeaders = Object.keys(headers)
    .filter((k) => k.toLowerCase().startsWith('x-ms-'))
    .sort()
    .map((k) => `${k.toLowerCase()}:${headerStr(headers, k)}`)
    .join('\n');

  const queryEntries = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    .map(([k, v]) => `${k.toLowerCase()}:${v}`);

  const canonicalizedResource =
    queryEntries.length > 0 ? `/${account}${parsed.pathname}\n${queryEntries.join('\n')}` : `/${account}${parsed.pathname}`;

  return [
    method.toUpperCase(),
    headerStr(headers, 'content-encoding'),
    headerStr(headers, 'content-language'),
    contentLengthInStringToSign,
    headerStr(headers, 'content-md5'),
    headerStr(headers, 'content-type'),
    '',
    headerStr(headers, 'if-modified-since'),
    headerStr(headers, 'if-match'),
    headerStr(headers, 'if-none-match'),
    headerStr(headers, 'if-unmodified-since'),
    headerStr(headers, 'range'),
    msHeaders,
    canonicalizedResource,
  ].join('\n');
}

function signAzureSharedKey(stringToSign: string, keyBytes: Buffer, account: string): string {
  const sig = crypto.createHmac('sha256', keyBytes).update(stringToSign, 'utf8').digest('base64');
  return `SharedKey ${account}:${sig}`;
}

describe('HTTP BYOS adapters: Azure 0-byte signing, 429/5xx retries, and WebDAV basePath encoding', () => {
  const servers: TestHttpServer[] = [];

  async function serve(
    handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void
  ): Promise<TestHttpServer> {
    const server = await startTestServer(handler);
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue(PUBLIC_DNS as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  describe('1. Azure Blob 0-byte SharedKey signing', () => {
    it('sends Content-Length: 0 on the wire while omitting "0" from StringToSign for 0-byte uploads', async () => {
      const blobs = new Map<string, { body: Buffer; contentType: string }>();
      const azureServer = await serve((req, body, res) => {
        const auth = headerStr(req.headers, 'authorization');
        const wireContentLength = headerStr(req.headers, 'content-length');
        const specContentLength = wireContentLength === '0' ? '' : wireContentLength;
        const expectedStringToSign = buildAzureSharedKeyStringToSign(
          req.method ?? 'GET',
          req.url ?? '/',
          req.headers,
          ACCOUNT,
          specContentLength
        );
        const expectedAuth = signAzureSharedKey(expectedStringToSign, ACCOUNT_KEY_BYTES, ACCOUNT);

        if (
          auth.length !== expectedAuth.length ||
          !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expectedAuth))
        ) {
          res.writeHead(403, { 'Content-Type': 'application/xml' }).end('<Error><Code>AuthenticationFailed</Code></Error>');
          return;
        }

        const parsed = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'PUT') {
          if (wireContentLength === '') {
            res.writeHead(411).end('Content-Length header is required');
            return;
          }
          const key = decodeURIComponent(parsed.pathname.replace(`/${CONTAINER}/`, ''));
          blobs.set(key, { body, contentType: headerStr(req.headers, 'content-type') });
          res.writeHead(201, { ETag: '"etag-0"' }).end();
          return;
        }
        if (req.method === 'HEAD') {
          const key = decodeURIComponent(parsed.pathname.replace(`/${CONTAINER}/`, ''));
          const found = blobs.get(key);
          if (!found) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'Content-Length': String(found.body.length), 'Content-Type': found.contentType }).end();
          return;
        }
        res.writeHead(404).end();
      });
      allowDev(azureServer);

      const adapter = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
        customEndpoint: azureServer.origin,
      });

      const zeroMeta = await adapter.uploadStream('empty/zero.bin', Readable.from([]), {
        size: 0,
        contentType: 'application/octet-stream',
      });
      expect(zeroMeta.size).toBe(0);
      expect(zeroMeta.etag).toBe('etag-0');
      expect(blobs.get('empty/zero.bin')?.body.length).toBe(0);

      const putHit = azureServer.hits[0];
      expect(putHit.headers['content-length']).toBe('0');
      expect(putHit.body.length).toBe(0);

      // Verify the legacy pre-2015-02-21 ("0" in StringToSign) signature would NOT match
      const legacyStringToSign = buildAzureSharedKeyStringToSign('PUT', putHit.rawUrl, putHit.headers, ACCOUNT, '0');
      const legacyAuth = signAzureSharedKey(legacyStringToSign, ACCOUNT_KEY_BYTES, ACCOUNT);
      expect(putHit.headers.authorization).not.toBe(legacyAuth);

      // Verify Web ReadableStream 0-byte upload and non-empty 5-byte upload both pass SharedKey check
      const webZeroStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      const webZeroMeta = await adapter.uploadStream('empty/web-zero.txt', webZeroStream, {
        size: 0,
        contentType: 'text/plain',
      });
      expect(webZeroMeta.size).toBe(0);

      const nonEmptyMeta = await adapter.uploadStream('docs/hello.txt', Readable.from([Buffer.from('hello')]), {
        size: 5,
        contentType: 'text/plain',
      });
      expect(nonEmptyMeta.size).toBe(5);
      expect(blobs.get('docs/hello.txt')?.body.toString('utf8')).toBe('hello');
      expect((await adapter.head('empty/zero.bin'))?.size).toBe(0);
    });

    it('exports a 0-byte local artifact via exportToCustomerStorage (export.azure-blob) with valid SharedKey across 429/503 retries', async () => {
      const uploaded = new Map<string, Buffer>();
      let attempt = 0;
      const azureServer = await serve((req, body, res) => {
        attempt++;
        const wireContentLength = headerStr(req.headers, 'content-length');
        const expectedStringToSign = buildAzureSharedKeyStringToSign(
          req.method ?? 'PUT',
          req.url ?? '/',
          req.headers,
          ACCOUNT,
          wireContentLength === '0' ? '' : wireContentLength
        );
        const expectedAuth = signAzureSharedKey(expectedStringToSign, ACCOUNT_KEY_BYTES, ACCOUNT);
        if (headerStr(req.headers, 'authorization') !== expectedAuth) {
          res.writeHead(403).end();
          return;
        }
        if (attempt === 1) {
          res.writeHead(429).end('throttled');
          return;
        }
        if (attempt === 2) {
          res.writeHead(503).end('unavailable');
          return;
        }
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        const key = decodeURIComponent(parsed.pathname.replace(`/${CONTAINER}/`, ''));
        uploaded.set(key, body);
        res.writeHead(201, { ETag: '"dag-0"' }).end();
      });
      allowDev(azureServer);

      const user = await userStore.createUser({
        email: `az0_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'AzZero',
        tier: 'paid',
      });
      const stored = await storageProvider.saveObject(
        `az-zero-${Date.now()}.txt`,
        Buffer.alloc(0),
        'text/plain',
        'empty.txt',
        60_000
      );
      const graphId = `g_az0_${Date.now()}`;
      const sealed = sealGraph(graphId, {
        nodes: {
          in: { op: 'import.upload' },
          out: {
            op: 'export.azure-blob',
            input: 'in',
            prefix: 'out/',
            credentials: {
              storageAccount: ACCOUNT,
              containerName: CONTAINER,
              accountKey: ACCOUNT_KEY,
              customEndpoint: azureServer.origin,
            },
          },
        },
      } as never);

      await exportToCustomerStorage(
        {
          id: graphNodeJobId(graphId, 'out'),
          data: { graphId, graphNodeId: 'out', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        sealed.nodes.out as never,
        [stored.key],
        graphNodeJobId(graphId, 'out')
      );

      expect(attempt).toBe(3);
      expect(uploaded.get('out/empty.txt')).toEqual(Buffer.alloc(0));
      await Promise.resolve(storageProvider.deleteObject(stored.key)).catch(() => false);
    }, 15_000);

    it('rejects negative, fractional, or NaN upload sizes with StorageInputError across HTTP adapters', async () => {
      const azure = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
      });
      const gcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt' });
      const dav = new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com' });

      for (const adapter of [azure, gcs, dav]) {
        for (const badSize of [-1, Number.NaN, 1.5]) {
          await expect(adapter.uploadStream('file.bin', Readable.from([]), { size: badSize })).rejects.toThrow(
            StorageInputError
          );
        }
      }
      expect(dns.promises.lookup).not.toHaveBeenCalled();
    });
  });

  describe('2. GCS, Azure Blob, and WebDAV 429 and 5xx mapping to retryable StorageServiceError', () => {
    const adapterFactories = [
      {
        provider: 'gcs',
        build: (origin: string) => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: origin }),
        list: (adapter: GcsStorageAdapter) => adapter.listObjects('p/', 10),
      },
      {
        provider: 'azure-blob',
        build: (origin: string) =>
          new AzureBlobStorageAdapter({
            type: 'azure-blob',
            storageAccount: ACCOUNT,
            containerName: CONTAINER,
            accountKey: ACCOUNT_KEY,
            customEndpoint: origin,
          }),
        list: (adapter: AzureBlobStorageAdapter) => adapter.listObjects('p/', 10),
      },
      {
        provider: 'webdav',
        build: (origin: string) =>
          new WebDavStorageAdapter({ type: 'webdav', url: origin, username: 'u', password: 'p' }),
        list: (adapter: WebDavStorageAdapter) => adapter.listDirectory('p/', 10),
      },
    ] as const;

    it.each([429, 500, 502, 503, 504])(
      'maps HTTP %i across downloadStream, uploadStream, head, delete, and list to retryable StorageServiceError',
      async (statusCode) => {
        const server = await serve((req, _body, res) => {
          res.writeHead(statusCode, { 'Content-Type': 'text/plain' }).end(req.method === 'HEAD' ? '' : `status-${statusCode}`);
        });
        allowDev(server);

        for (const entry of adapterFactories) {
          const adapter = entry.build(server.origin);
          const calls: Array<() => Promise<unknown>> = [
            () => adapter.downloadStream('a.bin'),
            () => adapter.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 }),
            () => adapter.head('a.bin'),
            () => adapter.delete('a.bin'),
            () => entry.list(adapter as never),
          ];

          for (const runCall of calls) {
            const err = await runCall().catch((e: unknown) => e);
            expect(err).toBeInstanceOf(StorageServiceError);
            const serviceErr = err as StorageServiceError;
            expect(serviceErr.provider).toBe(entry.provider);
            expect(serviceErr.statusCode).toBe(statusCode);
            expect(serviceErr.retryable).toBe(true);

            const mapped = customerStorageFailure(serviceErr);
            expect(mapped).toBeInstanceOf(StorageUnavailableError);
            expect((mapped as StorageUnavailableError).retryable).toBe(true);
          }
        }
      }
    );

    it('maps non-retryable 400/409 to non-retryable StorageServiceError, 401/403 to StorageAuthenticationError, and keeps 404/302 head/delete null/false', async () => {
      let currentStatus = 400;
      const server = await serve((req, _body, res) => {
        res.writeHead(currentStatus, { 'Content-Type': 'text/plain' }).end(req.method === 'HEAD' ? '' : `err-${currentStatus}`);
      });
      allowDev(server);

      for (const entry of adapterFactories) {
        const adapter = entry.build(server.origin);

        for (const nonRetryable of [400, 409]) {
          currentStatus = nonRetryable;
          for (const runCall of [
            () => adapter.downloadStream('a.bin'),
            () => adapter.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 }),
            () => entry.list(adapter as never),
          ]) {
            const err = await runCall().catch((e: unknown) => e);
            expect(err).toBeInstanceOf(StorageServiceError);
            expect((err as StorageServiceError).statusCode).toBe(nonRetryable);
            expect((err as StorageServiceError).retryable).toBe(false);
            const mapped = customerStorageFailure(err);
            expect(mapped).toBeInstanceOf(StorageUnavailableError);
            expect((mapped as StorageUnavailableError).retryable).toBe(false);
          }
        }

        for (const authStatus of [401, 403]) {
          currentStatus = authStatus;
          for (const runCall of [
            () => adapter.downloadStream('a.bin'),
            () => adapter.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 }),
            () => adapter.head('a.bin'),
            () => adapter.delete('a.bin'),
            () => entry.list(adapter as never),
          ]) {
            await expect(runCall()).rejects.toThrow(StorageAuthenticationError);
          }
        }

        for (const benign of [404, 302]) {
          currentStatus = benign;
          expect(await adapter.head('a.bin')).toBeNull();
          expect(await adapter.delete('a.bin')).toBe(false);
        }
      }
    });

    it('maps GCS OAuth token endpoint 429/5xx and transport drops to retryable StorageServiceError while keeping 401 and bad key as StorageAuthenticationError', async () => {
      let tokenMode: '429' | '503' | '401' | 'drop' | 'empty200' = '429';
      const oauthServer = await serve((req, _body, res) => {
        if (tokenMode === 'drop') {
          req.socket.destroy();
          return;
        }
        if (tokenMode === 'empty200') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
          return;
        }
        const status = Number(tokenMode);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `err_${status}` }));
      });
      const dataServer = await serve((_req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"size":"1"}');
      });
      allowDev(dataServer, oauthServer);

      const realGuardedRequest = httpGuard.guardedRequest;
      vi.spyOn(httpGuard, 'guardedRequest').mockImplementation((url, options) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          return realGuardedRequest(`${oauthServer.origin}/token`, { ...options, dispatcher: undefined });
        }
        return realGuardedRequest(url, options);
      });

      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const adapter = new GcsStorageAdapter({
        type: 'gcs',
        bucket: 'bkt',
        clientEmail: 'svc@project.iam.gserviceaccount.com',
        privateKey: pem,
        endpoint: dataServer.origin,
      });

      tokenMode = '429';
      const err429 = await adapter.head('a.bin').catch((e: unknown) => e);
      expect(err429).toBeInstanceOf(StorageServiceError);
      expect((err429 as StorageServiceError).statusCode).toBe(429);
      expect((err429 as StorageServiceError).retryable).toBe(true);

      tokenMode = '503';
      const err503 = await adapter.downloadStream('a.bin').catch((e: unknown) => e);
      expect(err503).toBeInstanceOf(StorageServiceError);
      expect((err503 as StorageServiceError).statusCode).toBe(503);
      expect((err503 as StorageServiceError).retryable).toBe(true);

      tokenMode = 'drop';
      const errDrop = await adapter.head('a.bin').catch((e: unknown) => e);
      expect(errDrop).toBeInstanceOf(StorageServiceError);
      expect((errDrop as StorageServiceError).retryable).toBe(true);

      tokenMode = 'empty200';
      const errEmpty = await adapter.head('a.bin').catch((e: unknown) => e);
      expect(errEmpty).toBeInstanceOf(StorageServiceError);
      expect((errEmpty as StorageServiceError).retryable).toBe(false);
      expect(dataServer.hits).toHaveLength(0);

      tokenMode = '401';
      await expect(adapter.head('a.bin')).rejects.toThrow(StorageAuthenticationError);

      const badKeyAdapter = new GcsStorageAdapter({
        type: 'gcs',
        bucket: 'bkt',
        clientEmail: 'svc@project.iam.gserviceaccount.com',
        privateKey: 'not-a-valid-pem-key',
        endpoint: dataServer.origin,
      });
      await expect(badKeyAdapter.head('a.bin')).rejects.toThrow(StorageAuthenticationError);
    });

    it('retries transient 429 and 5xx failures end-to-end inside node-storage-io for GCS, Azure Blob, and WebDAV', async () => {
      let gcsHeadHits = 0;
      let gcsGetHits = 0;
      let gcsPutHits = 0;
      const gcsServer = await serve((req, body, res) => {
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && parsed.searchParams.get('alt') === 'media') {
          gcsGetHits++;
          if (gcsGetHits === 1) {
            res.writeHead(502).end('bad gateway');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '5' }).end('hello');
          return;
        }
        if (req.method === 'GET') {
          gcsHeadHits++;
          if (gcsHeadHits <= 2) {
            res.writeHead(gcsHeadHits === 1 ? 429 : 503).end('retry me');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"size":"5"}');
          return;
        }
        if (req.method === 'POST') {
          gcsPutHits++;
          if (gcsPutHits === 1) {
            res.writeHead(429).end('slow down');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ size: String(body.length) }));
          return;
        }
        res.writeHead(404).end();
      });

      let davPropfindHits = 0;
      let davPutHits = 0;
      const davServer = await serve((req, _body, res) => {
        if (req.method === 'PROPFIND') {
          davPropfindHits++;
          if (davPropfindHits === 1) {
            res.writeHead(503).end('unavailable');
            return;
          }
          res.writeHead(207, { 'Content-Type': 'application/xml' }).end(
            '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/in/sample.txt</D:href><D:propstat><D:prop><D:getcontentlength>4</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>'
          );
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '4' }).end('data');
          return;
        }
        if (req.method === 'PUT') {
          davPutHits++;
          if (davPutHits === 1) {
            res.writeHead(500).end('internal');
            return;
          }
          res.writeHead(201, { ETag: '"dav-ok"' }).end();
          return;
        }
        res.writeHead(404).end();
      });

      let azListHits = 0;
      const azServer = await serve((req, _body, res) => {
        if (req.method === 'GET') {
          azListHits++;
          res.writeHead(429).end('throttled');
          return;
        }
        res.writeHead(404).end();
      });

      allowDev(gcsServer, davServer, azServer);

      const user = await userStore.createUser({
        email: `retry_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'RetryTester',
        tier: 'paid',
      });

      const gcsGraphId = `g_retry_gcs_${Date.now()}`;
      const gcsSealed = sealGraph(gcsGraphId, {
        nodes: {
          in: { op: 'import.gcs', key: 'in/hello.txt', credentials: { bucket: 'bkt', endpoint: gcsServer.origin } },
          out: { op: 'export.gcs', input: 'in', prefix: 'out/', credentials: { bucket: 'bkt', endpoint: gcsServer.origin } },
        },
      } as never);

      const importedGcs = await importFromCustomerStorage(
        {
          id: graphNodeJobId(gcsGraphId, 'in'),
          data: { graphId: gcsGraphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        gcsSealed.nodes.in as never,
        graphNodeJobId(gcsGraphId, 'in')
      );
      expect(importedGcs).toHaveLength(1);
      const readGcs = await storageProvider.openReadStream(importedGcs[0]);
      const gcsChunks: Buffer[] = [];
      for await (const c of readGcs!) gcsChunks.push(Buffer.from(c));
      expect(Buffer.concat(gcsChunks).toString('utf8')).toBe('hello');
      expect(gcsHeadHits).toBe(3);
      expect(gcsGetHits).toBe(2);

      await exportToCustomerStorage(
        {
          id: graphNodeJobId(gcsGraphId, 'out'),
          data: { graphId: gcsGraphId, graphNodeId: 'out', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        gcsSealed.nodes.out as never,
        importedGcs,
        graphNodeJobId(gcsGraphId, 'out')
      );
      expect(gcsPutHits).toBe(2);

      const davGraphId = `g_retry_dav_${Date.now()}`;
      const davSealed = sealGraph(davGraphId, {
        nodes: {
          in: { op: 'import.webdav', directory: 'in', credentials: { url: `${davServer.origin}/dav` } },
          out: { op: 'export.webdav', input: 'in', directory: 'out', credentials: { url: `${davServer.origin}/dav` } },
        },
      } as never);
      const importedDav = await importFromCustomerStorage(
        {
          id: graphNodeJobId(davGraphId, 'in'),
          data: { graphId: davGraphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        davSealed.nodes.in as never,
        graphNodeJobId(davGraphId, 'in')
      );
      expect(davPropfindHits).toBe(2);
      await exportToCustomerStorage(
        {
          id: graphNodeJobId(davGraphId, 'out'),
          data: { graphId: davGraphId, graphNodeId: 'out', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        davSealed.nodes.out as never,
        importedDav,
        graphNodeJobId(davGraphId, 'out')
      );
      expect(davPutHits).toBe(2);

      const azGraphId = `g_retry_az_${Date.now()}`;
      const azSealed = sealGraph(azGraphId, {
        nodes: {
          in: {
            op: 'import.azure-blob',
            prefix: 'docs/',
            credentials: {
              storageAccount: ACCOUNT,
              containerName: CONTAINER,
              accountKey: ACCOUNT_KEY,
              customEndpoint: azServer.origin,
            },
          },
        },
      } as never);
      const azErr = await importFromCustomerStorage(
        {
          id: graphNodeJobId(azGraphId, 'in'),
          data: { graphId: azGraphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        azSealed.nodes.in as never,
        graphNodeJobId(azGraphId, 'in')
      ).catch((e: unknown) => e);
      expect(azErr).toBeInstanceOf(StorageUnavailableError);
      expect((azErr as StorageUnavailableError).retryable).toBe(true);
      expect(azListHits).toBe(3);

      for (const k of [...importedGcs, ...importedDav]) {
        await Promise.resolve(storageProvider.deleteObject(k)).catch(() => false);
      }
    }, 15_000);
  });

  describe('3. WebDAV basePath segment encoding and path validation', () => {
    it('percent-encodes spaces, #, ?, %, @, and UTF-8 in basePath segments across all operations and PROPFIND matching', async () => {
      const basePath = '/Team #1/2026%data?v=1/team@org/café';
      const expectedEncodedBase = '/dav/Team%20%231/2026%25data%3Fv%3D1/team%40org/caf%C3%A9';

      const davServer = await serve((req, _body, res) => {
        if (req.method === 'PROPFIND') {
          // Include mixed-case hex (%c3%a9) and RFC 3986 unencoded @ in href, plus entries that must be skipped
          const xml = [
            '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">',
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/q1%20report%232.csv</D:href><D:propstat><D:prop><D:getcontentlength>17</D:getcontentlength></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/nested/skip.csv</D:href><D:propstat><D:prop><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/.hidden</D:href><D:propstat><D:prop><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/sub%20child/?sort=asc</D:href><D:propstat><D:prop><D:getcontentlength>0</D:getcontentlength></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/bad%0Aline.txt</D:href><D:propstat><D:prop><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/bad%2Fslash.csv</D:href><D:propstat><D:prop><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>`,
            `<D:response><D:href>https://evil.example/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/evil.csv</D:href><D:propstat><D:prop><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>`,
            '</D:multistatus>',
          ].join('');
          res.writeHead(207, { 'Content-Type': 'application/xml' }).end(xml);
          return;
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': '5', ETag: '"e1"' }).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Length': '5' }).end('hello');
          return;
        }
        if (req.method === 'PUT') {
          res.writeHead(201, { ETag: '"e2"' }).end();
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(404).end();
      });
      allowDev(davServer);

      const adapter = new WebDavStorageAdapter({
        type: 'webdav',
        url: `${davServer.origin}/dav/`,
        basePath,
        username: 'u',
        password: 'p',
      });

      await adapter.uploadStream('sub dir/doc #1.txt', Readable.from([Buffer.from('hello')]), { size: 5 });
      expect((await adapter.head('sub dir/doc #1.txt'))?.size).toBe(5);
      const stream = await adapter.downloadStream('sub dir/doc #1.txt');
      for await (const _chunk of stream) {
        // drain
      }
      const listed = await adapter.listDirectory('sub dir', 10);
      expect(listed).toEqual([{ name: 'q1 report#2.csv', size: 17 }]);
      expect(await adapter.delete('sub dir/doc #1.txt')).toBe(true);

      expect(davServer.hits.map((h) => [h.method, h.rawUrl])).toEqual([
        ['PUT', `${expectedEncodedBase}/sub%20dir/doc%20%231.txt`],
        ['HEAD', `${expectedEncodedBase}/sub%20dir/doc%20%231.txt`],
        ['GET', `${expectedEncodedBase}/sub%20dir/doc%20%231.txt`],
        ['PROPFIND', `${expectedEncodedBase}/sub%20dir/`],
        ['DELETE', `${expectedEncodedBase}/sub%20dir/doc%20%231.txt`],
      ]);

      // Verify root-only basePath forms omit extra trailing path segments
      for (const rootBase of [undefined, '', '/', '///']) {
        const rootAdapter = new WebDavStorageAdapter({
          type: 'webdav',
          url: `${davServer.origin}/dav/`,
          basePath: rootBase,
        });
        await rootAdapter.head('plain.txt');
        expect(davServer.hits.at(-1)?.rawUrl).toBe('/dav/plain.txt');
      }
    });

    it.each([
      '../escape',
      'a/../b',
      'a/./b',
      '.',
      '..',
      'a//b',
      'a\\b',
      'a\0b',
      'a\nb',
      'a\u2028b',
      'bad\ud800surrogate',
    ])('rejects invalid WebDAV basePath %j at adapter creation and graph validation', (badBasePath) => {
      expect(
        () =>
          new WebDavStorageAdapter({
            type: 'webdav',
            url: 'https://dav.example.com/dav',
            basePath: badBasePath,
          })
      ).toThrow(StorageInputError);

      const validation = validateJobGraph({
        nodes: {
          in: {
            op: 'import.webdav',
            path: 'file.csv',
            credentials: { url: 'https://dav.example.com/dav', basePath: badBasePath },
          },
          conv: { op: 'convert', input: 'in', targetFormat: 'json' },
          out: { op: 'export.internal', input: 'conv' },
        },
      } as never);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.code === 'INVALID_STORAGE_CREDENTIALS')).toBe(true);
    });

    it('accepts encoded-needed WebDAV basePath in graph validation and rejects unpaired surrogates/control chars in remotePath without URIError', async () => {
      const validation = validateJobGraph({
        nodes: {
          in: {
            op: 'import.webdav',
            path: 'in.csv',
            credentials: { url: 'https://dav.example.com/dav', basePath: '/Team #1/café' },
          },
          conv: { op: 'convert', input: 'in', targetFormat: 'json' },
          out: { op: 'export.internal', input: 'conv' },
        },
      } as never);
      expect(validation.valid).toBe(true);

      const dav = new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com/dav' });
      const azure = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
      });

      for (const badPath of ['bad\ud800file.txt', 'line\nbreak.txt', 'null\0byte.txt', 'a//b.txt', 'a/./b.txt']) {
        const davErr = await dav.head(badPath).catch((e: unknown) => e);
        expect(davErr).toBeInstanceOf(StorageInvalidKeyError);
        expect(davErr).not.toBeInstanceOf(URIError);

        const azErr = await azure.head(badPath).catch((e: unknown) => e);
        expect(azErr).toBeInstanceOf(StorageInvalidKeyError);
        expect(azErr).not.toBeInstanceOf(URIError);
      }

      const davNonString = await dav.head(123 as unknown as string).catch((e: unknown) => e);
      expect(davNonString).toBeInstanceOf(StorageInvalidKeyError);
      const azNonString = await azure.head(123 as unknown as string).catch((e: unknown) => e);
      expect(azNonString).toBeInstanceOf(StorageInvalidKeyError);

      for (const badContainer of ['', '../c', 'bad\ud800', 'a/b']) {
        expect(
          () =>
            new AzureBlobStorageAdapter({
              type: 'azure-blob',
              storageAccount: ACCOUNT,
              containerName: badContainer,
              accountKey: ACCOUNT_KEY,
            })
        ).toThrow(StorageInputError);
      }

      const badPercentDav = new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com/%ZZ' });
      const urlErr = await badPercentDav.listDirectory('', 10).catch((e: unknown) => e);
      expect(urlErr).toBeInstanceOf(StorageInputError);
      expect(customerStorageFailure(urlErr)).toBeInstanceOf(ConversionFailedError);

      const acceptedDav = await serve((req, _body, res) => {
        res.writeHead(req.method === 'DELETE' ? 202 : 200).end();
      });
      allowDev(acceptedDav);
      const dav202 = new WebDavStorageAdapter({ type: 'webdav', url: acceptedDav.origin });
      expect(await dav202.delete('async-delete.txt')).toBe(true);
    });
  });
});
