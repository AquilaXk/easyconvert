import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  AzureBlobStorageAdapter,
  GcsStorageAdapter,
  S3StorageAdapter,
  S3_DEV_ENDPOINT_ALLOWLIST_ENV,
  SftpStorageAdapter,
  WebDavStorageAdapter,
  createStorageAdapter,
  validateStorageCredentials,
} from '../src/lib/storage/adapters';
import { listS3Files } from '../src/lib/storage/s3-customer-listing';
import { assertValidBucketName, SigV4SigningError } from '../src/lib/storage/s3-sigv4';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageListingLimitError,
  StorageServiceError,
  StorageSsrfError,
} from '../src/lib/storage/adapters/adapter-interface';
import * as httpGuard from '../src/lib/storage/adapters/http-guard';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';
import { ConversionFailedError } from '../src/lib/types';
import { StorageEndpointBlockedError, StorageUnavailableError, customerStorageFailure } from '../src/lib/storage/customer-storage-errors';
import { refusalCodeOf } from '../src/lib/refusal-codes';
import { validateJobGraph } from '../src/lib/jobs/graph';
import { exportToCustomerStorage, importFromCustomerStorage } from '../src/lib/queue/graph/node-storage-io';
import { graphNodeJobId, sealGraph } from '../src/lib/queue/graph/node-jobs';
import { storageProvider } from '../src/lib/storage/selected-storage';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';

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
  const hosts = servers.map((s) => s.host).join(',');
  vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, hosts);
  vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, hosts);
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

    it('rejects negative, fractional, non-finite, or unsafe upload sizes with StorageInputError across HTTP and SFTP adapters', async () => {
      const azure = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
      });
      const gcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt' });
      const dav = new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com' });
      const sftp = new SftpStorageAdapter({ type: 'sftp', host: 'sftp.example.com', username: 'u' });

      const badSizes = [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
      for (const adapter of [azure, gcs, dav, sftp]) {
        for (const badSize of badSizes) {
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

    it('maps connect-time ESSRFBLOCKED to StorageSsrfError (storage_endpoint_blocked, retryable=false) across GCS OAuth, GCS, Azure Blob, and WebDAV', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue(PUBLIC_DNS as never);
      const connectLookup = vi.spyOn(dns, 'lookup').mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (err: null, addresses: dns.LookupAddress[]) => void
      ) => {
        process.nextTick(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
      }) as never);

      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

      const gcsOauthAdapter = new GcsStorageAdapter({
        type: 'gcs',
        bucket: 'bkt',
        clientEmail: 'svc@project.iam.gserviceaccount.com',
        privateKey: pem,
      });
      const gcsAdapter = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: 'https://rebind-gcs.example.com' });
      const azAdapter = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
        customEndpoint: 'https://rebind-az.example.com',
      });
      const davAdapter = new WebDavStorageAdapter({ type: 'webdav', url: 'https://rebind-dav.example.com/dav' });

      const ops: Array<() => Promise<unknown>> = [
        () => gcsOauthAdapter.head('a.bin'),
        () => gcsAdapter.head('a.bin'),
        () => gcsAdapter.delete('a.bin'),
        () => gcsAdapter.downloadStream('a.bin'),
        () => gcsAdapter.uploadStream('a.bin', Readable.from(['x']), { size: 1 }),
        () => gcsAdapter.listObjects('', 10),
        () => azAdapter.head('a.bin'),
        () => azAdapter.delete('a.bin'),
        () => azAdapter.downloadStream('a.bin'),
        () => azAdapter.uploadStream('a.bin', Readable.from(['x']), { size: 1 }),
        () => azAdapter.listObjects('', 10),
        () => davAdapter.head('a.bin'),
        () => davAdapter.delete('a.bin'),
        () => davAdapter.downloadStream('a.bin'),
        () => davAdapter.uploadStream('a.bin', Readable.from(['x']), { size: 1 }),
        () => davAdapter.listDirectory('', 10),
      ];

      for (const runOp of ops) {
        const err = await runOp().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StorageSsrfError);
        const mapped = customerStorageFailure(err);
        expect(mapped).toBeInstanceOf(StorageEndpointBlockedError);
        expect(refusalCodeOf(mapped)).toBe('storage_endpoint_blocked');
        expect((mapped as StorageEndpointBlockedError).retryable).toBe(false);
      }
      expect(connectLookup).toHaveBeenCalled();

      // Verify node-storage-io does NOT retry connect-time ESSRFBLOCKED
      const callsBefore = connectLookup.mock.calls.length;
      const user = await userStore.createUser({
        email: `ssrf_noret_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'SsrfNoRetry',
        tier: 'paid',
      });
      const graphId = `g_ssrf_rebind_${Date.now()}`;
      const sealed = sealGraph(graphId, {
        nodes: {
          in: { op: 'import.webdav', path: 'file.txt', credentials: { url: 'https://rebind-dav.example.com/dav' } },
        },
      } as never);
      const nodeErr = await importFromCustomerStorage(
        {
          id: graphNodeJobId(graphId, 'in'),
          data: { graphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        sealed.nodes.in as never,
        graphNodeJobId(graphId, 'in')
      ).catch((e: unknown) => e);
      expect(refusalCodeOf(nodeErr)).toBe('storage_endpoint_blocked');
      expect(connectLookup.mock.calls.length - callsBefore).toBe(1);
    });

    it('maps socket drops to retryable StorageServiceError across all HTTP adapters and retries in node-storage-io', async () => {
      let dropRequests = true;
      const dropServer = await serve((_req, _body, _res) => {
        // Not reached when socket destroyed in connection listener; kept as placeholder
      });
      // Replace request handler with immediate socket destruction on first pass, then normal responses
      const rawServer = await new Promise<TestHttpServer>((resolve) => {
        const hits: CapturedHit[] = [];
        const sockets = new Set<Socket>();
        const srv = http.createServer((req, res) => {
          if (dropRequests) {
            req.socket.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            hits.push({ method: req.method ?? '', rawUrl: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
            if (req.method === 'HEAD') {
              res.writeHead(200, { 'Content-Length': '4' }).end();
            } else if (req.url?.includes('alt=media') || req.url?.startsWith('/dav/')) {
              res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '4' }).end('body');
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"size":"4"}');
            }
          });
        });
        srv.on('connection', (s) => {
          sockets.add(s);
          s.on('close', () => sockets.delete(s));
        });
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address() as AddressInfo;
          resolve({
            origin: `http://127.0.0.1:${port}`,
            host: `127.0.0.1:${port}`,
            hits,
            close: () =>
              new Promise<void>((r) => {
                for (const s of sockets) s.destroy();
                srv.close(() => r());
              }),
          });
        });
      });
      servers.push(rawServer);
      allowDev(dropServer, rawServer);

      const gcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: rawServer.origin });
      const az = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
        customEndpoint: rawServer.origin,
      });
      const dav = new WebDavStorageAdapter({ type: 'webdav', url: `${rawServer.origin}/dav` });

      for (const adapter of [gcs, az, dav]) {
        const listOp = adapter instanceof WebDavStorageAdapter ? () => adapter.listDirectory('', 10) : () => adapter.listObjects('', 10);
        for (const call of [
          () => adapter.head('a.txt'),
          () => adapter.delete('a.txt'),
          () => adapter.downloadStream('a.txt'),
          () => adapter.uploadStream('a.txt', Readable.from([Buffer.from('data')]), { size: 4 }),
          listOp,
        ]) {
          const err = await call().catch((e: unknown) => e);
          expect(err).toBeInstanceOf(StorageServiceError);
          expect((err as StorageServiceError).retryable).toBe(true);
          const mapped = customerStorageFailure(err);
          expect(mapped).toBeInstanceOf(StorageUnavailableError);
          expect((mapped as StorageUnavailableError).retryable).toBe(true);
        }
      }

      // Now verify node-storage-io retries a transport drop once and succeeds on attempt 2
      let headAttempt = 0;
      let getAttempt = 0;
      let retryDavServer: TestHttpServer;
      const srv2 = http.createServer((req, res) => {
        if (req.method === 'HEAD') {
          headAttempt++;
          if (headAttempt === 1) {
            req.socket.destroy();
            return;
          }
          req.resume();
          req.on('end', () => {
            res.writeHead(200, { 'Content-Length': '4' }).end();
          });
          return;
        }
        getAttempt++;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '4' }).end('body');
        });
      });
      const sockets2 = new Set<Socket>();
      srv2.on('connection', (s) => {
        sockets2.add(s);
        s.on('close', () => sockets2.delete(s));
      });
      await new Promise<void>((resolve) => srv2.listen(0, '127.0.0.1', resolve));
      const { port: p2 } = srv2.address() as AddressInfo;
      retryDavServer = {
        origin: `http://127.0.0.1:${p2}`,
        host: `127.0.0.1:${p2}`,
        hits: [],
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets2) s.destroy();
            srv2.close(() => r());
          }),
      };
      servers.push(retryDavServer);
      allowDev(retryDavServer);

      const user = await userStore.createUser({
        email: `drop_retry_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'DropRetry',
        tier: 'paid',
      });
      const graphId = `g_drop_retry_${Date.now()}`;
      const sealed = sealGraph(graphId, {
        nodes: { in: { op: 'import.webdav', path: 'in.txt', credentials: { url: `${retryDavServer.origin}/dav` } } },
      } as never);
      const imported = await importFromCustomerStorage(
        {
          id: graphNodeJobId(graphId, 'in'),
          data: { graphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        sealed.nodes.in as never,
        graphNodeJobId(graphId, 'in')
      );
      expect(imported).toHaveLength(1);
      expect(headAttempt).toBe(2);
      expect(getAttempt).toBe(1);
      await Promise.resolve(storageProvider.deleteObject(imported[0])).catch(() => false);
      dropRequests = false;
    }, 15_000);

    it('maps GCS readJsonBody invalid/oversized 200 responses to non-retryable StorageServiceError across getAccessToken, head, and uploadStream', async () => {
      let jsonMode: 'invalid' | 'oversized' = 'invalid';
      let oauthHits = 0;
      let dataHits = 0;
      const oauthServer = await serve((_req, _body, res) => {
        oauthHits++;
        if (jsonMode === 'invalid') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{not-json');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(`{"access_token":"${'x'.repeat(70_000)}"}`);
      });
      const dataServer = await serve((_req, _body, res) => {
        dataHits++;
        if (jsonMode === 'invalid') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{not-json');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(`{"size":"${'9'.repeat(70_000)}"}`);
      });
      allowDev(oauthServer, dataServer);

      const realGuardedRequest = httpGuard.guardedRequest;
      vi.spyOn(httpGuard, 'guardedRequest').mockImplementation((url, options) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          return realGuardedRequest(`${oauthServer.origin}/token`, { ...options, dispatcher: undefined });
        }
        return realGuardedRequest(url, options);
      });

      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const saJson = JSON.stringify({ client_email: 'svc@project.iam.gserviceaccount.com', private_key: pem });
      const oauthGcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: saJson, endpoint: dataServer.origin });
      const plainGcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: dataServer.origin });

      for (const mode of ['invalid', 'oversized'] as const) {
        jsonMode = mode;
        for (const call of [
          () => oauthGcs.head('a.bin'),
          () => plainGcs.head('a.bin'),
          () => plainGcs.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 }),
        ]) {
          const err = await call().catch((e: unknown) => e);
          expect(err).toBeInstanceOf(StorageServiceError);
          expect((err as StorageServiceError).retryable).toBe(false);
          const mapped = customerStorageFailure(err);
          expect(mapped).toBeInstanceOf(StorageUnavailableError);
          expect((mapped as StorageUnavailableError).retryable).toBe(false);
        }
      }

      // Ensure node-storage-io does NOT retry non-retryable JSON parse errors
      oauthHits = 0;
      dataHits = 0;
      jsonMode = 'invalid';
      const user = await userStore.createUser({
        email: `json_noret_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'JsonNoRetry',
        tier: 'paid',
      });
      const graphId = `g_json_noret_${Date.now()}`;
      const sealed = sealGraph(graphId, {
        nodes: { in: { op: 'import.gcs', key: 'a.txt', credentials: { bucket: 'bkt', serviceAccountKeyJson: saJson, endpoint: dataServer.origin } } },
      } as never);
      const err = await importFromCustomerStorage(
        {
          id: graphNodeJobId(graphId, 'in'),
          data: { graphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        sealed.nodes.in as never,
        graphNodeJobId(graphId, 'in')
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageUnavailableError);
      expect((err as StorageUnavailableError).retryable).toBe(false);
      expect(oauthHits).toBe(1);
      expect(dataHits).toBe(0);
    });

    it('maps GCS 200 non-object/non-array JSON shapes to non-retryable StorageServiceError and avoids NaN/Invalid Date metadata', async () => {
      let jsonBody = 'null';
      let gcsDataHits = 0;
      const gcsServer = await serve((_req, _body, res) => {
        gcsDataHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(jsonBody);
      });
      let metaHeaders: Array<[string, string | string[]]> = [
        ['Content-Length', '99999999999999999'],
        ['Last-Modified', 'not-a-date'],
        ['ETag', ['"a"', '"b"']],
        ['Content-Type', ['text/plain', 'application/octet-stream']],
      ];
      const metaServer = await serve((_req, _body, res) => {
        res.statusCode = 200;
        for (const [k, v] of metaHeaders) {
          res.setHeader(k, v);
        }
        res.end();
      });
      allowDev(gcsServer, metaServer);

      expect(httpGuard.parseNonNegativeInt('not-a-number')).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt('-5')).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt('12abc')).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt('99999999999999999')).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt(NaN)).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt(-1)).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt(1.5)).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt(['10'])).toBeUndefined();
      expect(httpGuard.parseNonNegativeInt('0')).toBe(0);
      expect(httpGuard.parseNonNegativeInt(42)).toBe(42);
      expect(httpGuard.parseValidDate('not-a-date')).toBeUndefined();
      expect(httpGuard.parseValidDate('')).toBeUndefined();
      expect(httpGuard.parseValidDate(['Wed, 21 Oct 2015 07:28:00 GMT'])).toBeUndefined();
      expect(httpGuard.parseValidDate('2026-11-24T00:00:00Z')?.toISOString()).toBe('2026-11-24T00:00:00.000Z');
      expect(httpGuard.readHeaderString(['"a"', '"b"'])).toBe('"a"');
      expect(httpGuard.readHeaderString(undefined)).toBeUndefined();

      const gcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: gcsServer.origin });
      for (const badJson of ['null', '[]', '123', '"str"']) {
        jsonBody = badJson;
        for (const call of [
          () => gcs.head('a.bin'),
          () => gcs.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 }),
          () => gcs.listObjects('', 10),
        ]) {
          const err = await call().catch((e: unknown) => e);
          expect(err, badJson).toBeInstanceOf(StorageServiceError);
          expect((err as StorageServiceError).retryable, badJson).toBe(false);
        }
      }

      jsonBody = JSON.stringify({ items: 'not-an-array' });
      const badItemsErr = await gcs.listObjects('', 10).catch((e: unknown) => e);
      expect(badItemsErr).toBeInstanceOf(StorageServiceError);
      expect((badItemsErr as StorageServiceError).retryable).toBe(false);

      // Verify node-storage-io does NOT retry non-object JSON shapes
      gcsDataHits = 0;
      jsonBody = 'null';
      const user = await userStore.createUser({
        email: `shape_noret_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'ShapeNoRetry',
        tier: 'paid',
      });
      const graphId = `g_shape_${Date.now()}`;
      const sealed = sealGraph(graphId, {
        nodes: { in: { op: 'import.gcs', key: 'a.txt', credentials: { bucket: 'bkt', endpoint: gcsServer.origin } } },
      } as never);
      const nodeErr = await importFromCustomerStorage(
        {
          id: graphNodeJobId(graphId, 'in'),
          data: { graphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        sealed.nodes.in as never,
        graphNodeJobId(graphId, 'in')
      ).catch((e: unknown) => e);
      expect(nodeErr).toBeInstanceOf(StorageUnavailableError);
      expect((nodeErr as StorageUnavailableError).retryable).toBe(false);
      expect(gcsDataHits).toBe(1);

      // Verify malformed size / date fields never emit NaN or Invalid Date
      jsonBody = JSON.stringify({ size: 'bad-size', updated: 'not-a-date', etag: 123, contentType: 456 });
      const gcsHead = await gcs.head('a.bin');
      expect(gcsHead).toEqual({ size: 0, etag: undefined, contentType: undefined, lastModified: undefined });
      const gcsUp = await gcs.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 });
      expect(gcsUp.size).toBe(2);
      expect(Number.isNaN(gcsUp.lastModified?.getTime() ?? Number.NaN)).toBe(false);

      const az = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
        customEndpoint: metaServer.origin,
      });
      const dav = new WebDavStorageAdapter({ type: 'webdav', url: metaServer.origin });
      const azHeadBad = await az.head('a.bin');
      expect(azHeadBad?.size).toBe(0);
      expect(azHeadBad?.etag).toBe('a');
      expect(typeof azHeadBad?.contentType).toBe('string');
      expect(azHeadBad?.lastModified).toBeUndefined();
      const davHeadBad = await dav.head('a.bin');
      expect(davHeadBad?.size).toBe(0);
      expect(davHeadBad?.etag).toBe('a');
      expect(typeof davHeadBad?.contentType).toBe('string');
      expect(davHeadBad?.lastModified).toBeUndefined();

      metaHeaders = [
        ['Last-Modified', 'not-a-date'],
        ['ETag', ['"u1"', '"u2"']],
      ];
      const azUpBad = await az.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 });
      expect(azUpBad.etag).toBe('u1');
      expect(Number.isNaN(azUpBad.lastModified?.getTime() ?? Number.NaN)).toBe(false);
      const davUpBad = await dav.uploadStream('a.bin', Readable.from([Buffer.from('hi')]), { size: 2 });
      expect(davUpBad.etag).toBe('u1');
      expect(Number.isNaN(davUpBad.lastModified?.getTime() ?? Number.NaN)).toBe(false);

      metaHeaders = [
        ['Content-Length', '7'],
        ['Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT'],
      ];
      expect((await az.head('a.bin'))?.size).toBe(7);
    });

    it('retries serviceAccountKeyJson OAuth 429/503 and Azure/WebDAV head 429/503 inside node-storage-io, and maps delete 429/503 to retryable StorageServiceError', async () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const saJson = JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: pem });

      let oauthAttempt = 0;
      const oauthServer = await serve((_req, body, res) => {
        oauthAttempt++;
        const params = new URLSearchParams(body.toString('utf8'));
        const assertion = params.get('assertion') ?? '';
        const [hdr, claims, sig] = assertion.split('.');
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(`${hdr}.${claims}`);
        const validJwt = verifier.verify(publicKey, sig, 'base64url');
        expect(validJwt).toBe(true);
        const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { iss?: string };
        expect(decodedClaims.iss).toBe('sa@proj.iam.gserviceaccount.com');

        if (oauthAttempt === 1) {
          res.writeHead(429).end('rate limited');
          return;
        }
        if (oauthAttempt === 2) {
          res.writeHead(503).end('unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'tok-sa-ok', expires_in: 3600 }));
      });

      const gcsDataServer = await serve((req, _body, res) => {
        expect(req.headers.authorization).toBe('Bearer tok-sa-ok');
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        if (parsed.searchParams.get('alt') === 'media') {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '6' }).end('sa-doc');
          return;
        }
        if (req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"size":"6"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"size":"6"}');
      });

      let azHeadHits = 0;
      const azHeadServer = await serve((req, _body, res) => {
        if (req.method === 'HEAD') {
          azHeadHits++;
          if (azHeadHits === 1) {
            res.writeHead(429).end();
            return;
          }
          if (azHeadHits === 2) {
            res.writeHead(503).end();
            return;
          }
          res.writeHead(200, { 'Content-Length': '3', 'Content-Type': 'text/plain' }).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Length': '3' }).end('abc');
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(429).end('throttled');
          return;
        }
        res.writeHead(404).end();
      });

      let davHeadHits = 0;
      const davHeadServer = await serve((req, _body, res) => {
        if (req.method === 'HEAD') {
          davHeadHits++;
          if (davHeadHits === 1) {
            res.writeHead(503).end();
            return;
          }
          res.writeHead(200, { 'Content-Length': '3' }).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Length': '3' }).end('xyz');
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(503).end('busy');
          return;
        }
        res.writeHead(404).end();
      });

      allowDev(oauthServer, gcsDataServer, azHeadServer, davHeadServer);
      const realGuardedRequest = httpGuard.guardedRequest;
      vi.spyOn(httpGuard, 'guardedRequest').mockImplementation((url, options) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          return realGuardedRequest(`${oauthServer.origin}/token`, { ...options, dispatcher: undefined });
        }
        return realGuardedRequest(url, options);
      });

      const user = await userStore.createUser({
        email: `sa_retry_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'SaRetry',
        tier: 'paid',
      });

      const gcsGraphId = `g_sa_${Date.now()}`;
      const gcsSealed = sealGraph(gcsGraphId, {
        nodes: {
          in: { op: 'import.gcs', key: 'in/sa.txt', credentials: { bucket: 'bkt', serviceAccountKeyJson: saJson, endpoint: gcsDataServer.origin } },
          out: { op: 'export.gcs', input: 'in', prefix: 'out/', credentials: { bucket: 'bkt', serviceAccountKeyJson: saJson, endpoint: gcsDataServer.origin } },
        },
      } as never);
      const gcsImported = await importFromCustomerStorage(
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
      expect(oauthAttempt).toBe(3);
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
        gcsImported,
        graphNodeJobId(gcsGraphId, 'out')
      );
      // Export node instantiates a new adapter and performs one fresh token exchange (3 during import + 1 during export)
      expect(oauthAttempt).toBe(4);

      const azGraphId = `g_az_head_${Date.now()}`;
      const azSealed = sealGraph(azGraphId, {
        nodes: {
          in: { op: 'import.azure-blob', key: 'doc.txt', credentials: { storageAccount: ACCOUNT, containerName: CONTAINER, accountKey: ACCOUNT_KEY, customEndpoint: azHeadServer.origin } },
        },
      } as never);
      const azImported = await importFromCustomerStorage(
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
      );
      expect(azHeadHits).toBe(3);

      const davGraphId = `g_dav_head_${Date.now()}`;
      const davSealed = sealGraph(davGraphId, {
        nodes: {
          in: { op: 'import.webdav', path: 'doc.txt', credentials: { url: `${davHeadServer.origin}/dav` } },
        },
      } as never);
      const davImported = await importFromCustomerStorage(
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
      expect(davHeadHits).toBe(2);

      // Verify delete 429/503 returns retryable StorageServiceError -> StorageUnavailableError(retryable=true)
      const azDelErr = await new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
        customEndpoint: azHeadServer.origin,
      })
        .delete('doc.txt')
        .catch((e: unknown) => e);
      expect(azDelErr).toBeInstanceOf(StorageServiceError);
      expect((azDelErr as StorageServiceError).retryable).toBe(true);
      expect((customerStorageFailure(azDelErr) as StorageUnavailableError).retryable).toBe(true);

      const davDelErr = await new WebDavStorageAdapter({ type: 'webdav', url: `${davHeadServer.origin}/dav` })
        .delete('doc.txt')
        .catch((e: unknown) => e);
      expect(davDelErr).toBeInstanceOf(StorageServiceError);
      expect((davDelErr as StorageServiceError).retryable).toBe(true);
      expect((customerStorageFailure(davDelErr) as StorageUnavailableError).retryable).toBe(true);

      for (const k of [...gcsImported, ...azImported, ...davImported]) {
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
            `<D:response><D:href>/dav/Team%20%231/2026%25data%3Fv%3D1/team@org/caf%c3%a9/sub%20dir/query-slash.csv?token=abc/</D:href><D:propstat><D:prop><D:getcontentlength>9</D:getcontentlength></D:prop></D:propstat></D:response>`,
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
      expect(listed).toEqual([
        { name: 'q1 report#2.csv', size: 17 },
        { name: 'query-slash.csv', size: 9 },
      ]);
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

    it('enforces WebDAV basePath rules on POST /api/v1/storage/credentials (rejects invalid and non-string values with 400)', async () => {
      credentialsVault.clear();
      const user = await userStore.createUser({
        email: `webdav-cred-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'WebDAV Credential Tester',
        tier: 'paid',
      });
      const key = await redisKeyStore.generateApiKey(user.id, 'WebDAV Test Key', {
        scopes: ['convert:write', 'convert:read'],
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.secretKey}`,
      };

      const invalidBasePaths: unknown[] = [
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
        0,
        false,
        123,
        true,
        null,
        { nested: 'path' },
        ['a'],
      ];

      for (const badBasePath of invalidBasePaths) {
        const res = await credentialsPost(
          new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              providerType: 'webdav',
              credentials: {
                type: 'webdav',
                url: 'https://dav.example.com/dav',
                basePath: badBasePath,
              },
            }),
          })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.detail).toMatch(/basePath/i);
      }

      for (const badAuth of [{ username: 123 }, { password: { secret: 'x' } }]) {
        const res = await credentialsPost(
          new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              providerType: 'webdav',
              credentials: {
                type: 'webdav',
                url: 'https://dav.example.com/dav',
                ...badAuth,
              },
            }),
          })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.detail).toMatch(/username or password/i);
      }

      for (const badContainer of ['.', 'bad\nc', 'bad\0c', 'bad\ud800c', 123]) {
        const res = await credentialsPost(
          new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              providerType: 'azure-blob',
              credentials: {
                type: 'azure-blob',
                storageAccount: ACCOUNT,
                containerName: badContainer,
              },
            }),
          })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.detail).toMatch(/containerName/i);
      }
      expect(await credentialsVault.list(user.id)).toEqual([]);

      for (const validBasePath of [undefined, '', '/', '/Team #1/café']) {
        const res = await credentialsPost(
          new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              providerType: 'webdav',
              credentials: {
                type: 'webdav',
                url: 'https://dav.example.com/dav',
                ...(validBasePath !== undefined ? { basePath: validBasePath } : {}),
              },
            }),
          })
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.credentialRef).toMatch(/^cred_[a-f0-9]{32}$/);
      }
    });

    it('rejects invalid maxFiles (NaN, negative, float, Infinity, non-number) before network I/O and bounds maxFiles=0 cleanly', async () => {
      const safeSpy = vi.spyOn(httpGuard, 'assertAdapterUrlSafe');
      const azure = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
      });
      const gcs = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt' });
      const dav = new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com/dav' });
      const sftp = new SftpStorageAdapter({ type: 'sftp', host: 'sftp.example.com', username: 'u' });
      const s3 = new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIAEXAMPLEKEY000001', secretAccessKey: 'secret' });
      const s3XmlSpy = vi.spyOn(s3, 'listObjectsXml');

      const invalidLimits: unknown[] = [Number.NaN, -1, -100, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '10', null, undefined];
      for (const limit of invalidLimits) {
        const azErr = await azure.listObjects('', limit as number).catch((e: unknown) => e);
        expect(azErr).toBeInstanceOf(StorageInputError);

        const gcsErr = await gcs.listObjects('', limit as number).catch((e: unknown) => e);
        expect(gcsErr).toBeInstanceOf(StorageInputError);

        const davErr = await dav.listDirectory('', limit as number).catch((e: unknown) => e);
        expect(davErr).toBeInstanceOf(StorageInputError);

        const sftpErr = await sftp.listDirectory('', limit as number).catch((e: unknown) => e);
        expect(sftpErr).toBeInstanceOf(StorageInputError);

        const s3Err = await listS3Files(s3, '', limit as number).catch((e: unknown) => e);
        expect(s3Err).toBeInstanceOf(StorageInputError);
      }
      expect(safeSpy).not.toHaveBeenCalled();
      expect(dns.promises.lookup).not.toHaveBeenCalled();
      expect(s3XmlSpy).not.toHaveBeenCalled();

      let returnOneItem = false;
      const listServer = await serve((req, _body, res) => {
        if (req.url?.includes('list-type=2')) {
          const items = returnOneItem ? '<Contents><Key>a.txt</Key><Size>1</Size></Contents>' : '';
          res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
          return;
        }
        if (req.url?.includes('comp=list')) {
          const blobs = returnOneItem ? '<Blob><Name>a.txt</Name><Properties><Content-Length>1</Content-Length></Properties></Blob>' : '';
          res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${blobs}</Blobs></EnumerationResults>`);
          return;
        }
        if (req.url?.includes('/storage/v1/b/')) {
          const items = returnOneItem ? [{ name: 'a.txt', size: '1' }] : [];
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items }));
          return;
        }
        const entry = returnOneItem ? '<D:response><D:href>/dav/a.txt</D:href><D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop></D:propstat></D:response>' : '';
        res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entry}</D:multistatus>`);
      });
      allowDev(listServer);

      const azZero = new AzureBlobStorageAdapter({
        type: 'azure-blob',
        storageAccount: ACCOUNT,
        containerName: CONTAINER,
        accountKey: ACCOUNT_KEY,
        customEndpoint: listServer.origin,
      });
      const gcsZero = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: listServer.origin });
      const davZero = new WebDavStorageAdapter({ type: 'webdav', url: `${listServer.origin}/dav` });
      const s3Zero = new S3StorageAdapter({
        type: 's3',
        bucket: 'customer-bucket',
        accessKeyId: 'AKIAEXAMPLEKEY000001',
        secretAccessKey: 'secret',
        endpoint: listServer.origin,
      });

      expect(await azZero.listObjects('', 0)).toEqual([]);
      expect(await gcsZero.listObjects('', 0)).toEqual([]);
      expect(await davZero.listDirectory('', 0)).toEqual([]);
      expect(await listS3Files(s3Zero, '', 0)).toEqual([]);

      returnOneItem = true;
      await expect(azZero.listObjects('', 0)).rejects.toThrow(StorageListingLimitError);
      await expect(gcsZero.listObjects('', 0)).rejects.toThrow(StorageListingLimitError);
      await expect(davZero.listDirectory('', 0)).rejects.toThrow(StorageListingLimitError);
      await expect(listS3Files(s3Zero, '', 0)).rejects.toThrow(StorageListingLimitError);
    });

    it('imports and exports via node-storage-io using WebDAV encoded basePath end-to-end', async () => {
      const basePath = '/Team #1/café';
      const davFiles = new Map<string, Buffer>([
        ['/dav/Team%20%231/caf%C3%A9/in%20dir/note%20%231.txt', Buffer.from('encoded-webdav-e2e')],
      ]);
      const davServer = await serve((req, body, res) => {
        const rawUrl = req.url ?? '/';
        if (req.method === 'PROPFIND') {
          res.writeHead(207, { 'Content-Type': 'application/xml' }).end(
            '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
              '<D:response><D:href>/dav/Team%20%231/caf%C3%A9/in%20dir/note%20%231.txt</D:href>' +
              '<D:propstat><D:prop><D:getcontentlength>18</D:getcontentlength></D:prop></D:propstat></D:response>' +
              '</D:multistatus>'
          );
          return;
        }
        if (req.method === 'GET') {
          const found = davFiles.get(rawUrl);
          if (!found) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(found.length) }).end(found);
          return;
        }
        if (req.method === 'PUT') {
          davFiles.set(rawUrl, body);
          res.writeHead(201, { ETag: '"e2e-ok"' }).end();
          return;
        }
        res.writeHead(404).end();
      });
      allowDev(davServer);

      const user = await userStore.createUser({
        email: `dav_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'DavE2E',
        tier: 'paid',
      });
      const graphId = `g_dav_base_${Date.now()}`;
      const sealed = sealGraph(graphId, {
        nodes: {
          in: { op: 'import.webdav', directory: 'in dir', credentials: { url: `${davServer.origin}/dav`, basePath } },
          out: { op: 'export.webdav', input: 'in', directory: 'out dir', credentials: { url: `${davServer.origin}/dav`, basePath } },
        },
      } as never);

      const imported = await importFromCustomerStorage(
        {
          id: graphNodeJobId(graphId, 'in'),
          data: { graphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        sealed.nodes.in as never,
        graphNodeJobId(graphId, 'in')
      );
      expect(imported).toHaveLength(1);

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
        imported,
        graphNodeJobId(graphId, 'out')
      );

      expect(davFiles.get('/dav/Team%20%231/caf%C3%A9/out%20dir/note%20%231.txt')?.toString('utf8')).toBe('encoded-webdav-e2e');
      expect(davServer.hits.map((h) => [h.method, h.rawUrl])).toEqual([
        ['PROPFIND', '/dav/Team%20%231/caf%C3%A9/in%20dir/'],
        ['GET', '/dav/Team%20%231/caf%C3%A9/in%20dir/note%20%231.txt'],
        ['PUT', '/dav/Team%20%231/caf%C3%A9/out%20dir/note%20%231.txt'],
      ]);
      for (const k of imported) {
        await Promise.resolve(storageProvider.deleteObject(k)).catch(() => false);
      }
    });
  });

  describe('4. Credential field types, trailing ?/# base URLs, bucket validation, and unclassified error masking', () => {
    it('rejects trailing ?, #, and ?# base URLs across parseCleanBaseEndpointUrl, adapters, and POST /api/v1/storage/credentials', async () => {
      credentialsVault.clear();
      const user = await userStore.createUser({
        email: `trail_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'TrailTester',
        tier: 'paid',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Trail Key', { scopes: ['convert:write', 'convert:read'] });
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` };

      for (const badUrl of [
        'https://dav.example.com/dav#',
        'https://dav.example.com/dav?',
        'https://dav.example.com/dav?#',
        'https://blob.example.com?',
        'https://storage.googleapis.com#',
        'https://dav.example.com/dav\r\n',
        'https://dav.example.com/da\nv',
      ]) {
        expect(() => httpGuard.parseCleanBaseEndpointUrl(badUrl, 'webdav')).toThrow(StorageAdapterError);
        expect(() => new WebDavStorageAdapter({ type: 'webdav', url: badUrl })).toThrow(StorageAdapterError);
        expect(() =>
          new AzureBlobStorageAdapter({
            type: 'azure-blob',
            storageAccount: ACCOUNT,
            containerName: CONTAINER,
            customEndpoint: badUrl,
          })
        ).toThrow(StorageAdapterError);
        expect(() => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: badUrl })).toThrow(StorageAdapterError);

        for (const [providerType, creds] of [
          ['webdav', { type: 'webdav', url: badUrl }],
          ['azure-blob', { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: badUrl }],
          ['gcs', { type: 'gcs', bucket: 'bkt', endpoint: badUrl }],
          ['s3', { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIAEXAMPLEKEY000001', secretAccessKey: 'secret', endpoint: badUrl }],
        ] as const) {
          const res = await credentialsPost(
            new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
              method: 'POST',
              headers,
              body: JSON.stringify({ providerType, credentials: creds }),
            })
          );
          expect(res.status, `${providerType} ${badUrl}`).toBe(400);
        }
      }
      expect(await credentialsVault.list(user.id)).toEqual([]);
    });

    it('rejects non-string bucket names in assertValidBucketName with SigV4SigningError instead of TypeError', () => {
      for (const badBucket of [12345, true, false, null, undefined, { name: 'b' }, ['b']]) {
        for (const rules of ['dns', 'oci'] as const) {
          const err = (() => {
            try {
              assertValidBucketName(badBucket as unknown as string, rules);
            } catch (e) {
              return e;
            }
            return undefined;
          })();
          expect(err).toBeInstanceOf(SigV4SigningError);
          expect(err).not.toBeInstanceOf(TypeError);
          expect((err as Error).message).toBe('Invalid bucket name: must be a string.');
        }
      }
    });

    it('rejects non-string/falsy fields, unknown providerType, and masks unclassified validation throws on POST /api/v1/storage/credentials', async () => {
      credentialsVault.clear();
      const user = await userStore.createUser({
        email: `types_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        name: 'TypeTester',
        tier: 'paid',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Type Key', { scopes: ['convert:write', 'convert:read'] });
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` };

      const postCreds = (payload: unknown) =>
        credentialsPost(
          new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          })
        );

      const invalidPayloads: Array<[string, unknown, (() => unknown)?]> = [
        [
          'azure accountKey: 123',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, accountKey: 123 } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, accountKey: 123 as never }),
        ],
        [
          'azure sasToken: 123',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: 123 } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: 123 as never }),
        ],
        [
          'azure connectionString: 123',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, connectionString: 123 } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, connectionString: 123 as never }),
        ],
        [
          'azure customEndpoint: 0',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: 0 } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: 0 as never }),
        ],
        [
          'azure customEndpoint: false',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: false } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: false as never }),
        ],
        [
          'azure customEndpoint: null',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: null } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: null as never }),
        ],
        [
          'azure customEndpoint: empty',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: '' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, customEndpoint: '' }),
        ],
        [
          'gcs endpoint: 0',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', endpoint: 0 } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: 0 as never }),
        ],
        [
          'gcs endpoint: false',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', endpoint: false } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: false as never }),
        ],
        [
          'gcs endpoint: null',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', endpoint: null } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: null as never }),
        ],
        [
          'gcs projectId: 123',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', projectId: 123 } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', projectId: 123 as never }),
        ],
        [
          'gcs clientEmail/privateKey numbers',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', clientEmail: 123, privateKey: 456 } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', clientEmail: 123 as never, privateKey: 456 as never }),
        ],
        [
          'gcs clientEmail: 0, privateKey: false',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', clientEmail: 0, privateKey: false } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', clientEmail: 0 as never, privateKey: false as never }),
        ],
        [
          'gcs serviceAccountKeyJson: 123',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: 123 } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: 123 as never }),
        ],
        [
          'gcs serviceAccountKeyJson: 0',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: 0 } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: 0 as never }),
        ],
        [
          'gcs serviceAccountKeyJson: empty',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: '' } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: '' }),
        ],
        [
          'gcs serviceAccountKeyJson: false',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: false } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: false as never }),
        ],
        [
          'gcs serviceAccountKeyJson: null',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: null } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: null as never }),
        ],
        [
          'gcs bucket: 123',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 123 } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 123 as never }),
        ],
        [
          's3 bucket: 12345',
          { providerType: 's3', credentials: { type: 's3', bucket: 12345, accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X' } },
          () => new S3StorageAdapter({ type: 's3', bucket: 12345 as never, accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X' }),
        ],
        [
          's3 bucket: true',
          { providerType: 's3', credentials: { type: 's3', bucket: true, accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X' } },
          () => new S3StorageAdapter({ type: 's3', bucket: true as never, accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X' }),
        ],
        [
          's3 accessKeyId: 123',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 123, secretAccessKey: 'SECRET_X' } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 123 as never, secretAccessKey: 'SECRET_X' }),
        ],
        [
          's3 secretAccessKey: 123',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 123 } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 123 as never }),
        ],
        [
          's3 region: 123',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: 123 } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: 123 as never }),
        ],
        [
          's3 region: 0',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: 0 } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: 0 as never }),
        ],
        [
          's3 forcePathStyle: yes',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', forcePathStyle: 'yes' } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', forcePathStyle: 'yes' as never }),
        ],
        [
          's3 endpoint: 0',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: 0 } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: 0 as never }),
        ],
        [
          's3 endpoint: false',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: false } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: false as never }),
        ],
        [
          's3 endpoint: null',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: null } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: null as never }),
        ],
        [
          's3 endpoint: empty',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: '' } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', endpoint: '' }),
        ],
        [
          's3 region: empty',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: '' } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: '' }),
        ],
        [
          's3 region: null',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: null } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', region: null as never }),
        ],
        [
          's3 sessionToken: 123',
          { providerType: 's3', credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', sessionToken: 123 } },
          () => new S3StorageAdapter({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', sessionToken: 123 as never }),
        ],
        [
          'webdav url: 123',
          { providerType: 'webdav', credentials: { type: 'webdav', url: 123 } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: 123 as never }),
        ],
        [
          'webdav url: 0',
          { providerType: 'webdav', credentials: { type: 'webdav', url: 0 } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: 0 as never }),
        ],
        [
          'webdav url: false',
          { providerType: 'webdav', credentials: { type: 'webdav', url: false } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: false as never }),
        ],
        [
          'webdav url: null',
          { providerType: 'webdav', credentials: { type: 'webdav', url: null } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: null as never }),
        ],
        [
          'webdav url: empty',
          { providerType: 'webdav', credentials: { type: 'webdav', url: '' } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: '' }),
        ],
        [
          'webdav username: 123',
          { providerType: 'webdav', credentials: { type: 'webdav', url: 'https://dav.example.com/dav', username: 123 } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com/dav', username: 123 as never }),
        ],
        [
          'webdav password: 123',
          { providerType: 'webdav', credentials: { type: 'webdav', url: 'https://dav.example.com/dav', password: 123 } },
          () => new WebDavStorageAdapter({ type: 'webdav', url: 'https://dav.example.com/dav', password: 123 as never }),
        ],
        [
          'sftp host: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 123, username: 'u', password: 'p' } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 123 as never, username: 'u', password: 'p' }),
        ],
        [
          'sftp username: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 123, password: 'p' } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 123 as never, password: 'p' }),
        ],
        [
          'sftp port: 22 string',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', port: '22' } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', port: '22' as never }),
        ],
        [
          'sftp password: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', password: 123 } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', password: 123 as never }),
        ],
        [
          'sftp privateKey: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', privateKey: 123 } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', privateKey: 123 as never }),
        ],
        [
          'sftp passphrase: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', passphrase: 123 } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', passphrase: 123 as never }),
        ],
        [
          'sftp hostKey: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', hostKey: 123 } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', hostKey: 123 as never }),
        ],
        [
          'sftp port: null',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', port: null } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', port: null as never }),
        ],
        [
          'sftp basePath: 123',
          { providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', basePath: 123 } },
          () => new SftpStorageAdapter({ type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', basePath: 123 as never }),
        ],
        [
          'azure accountKey whitespace',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, accountKey: '   ' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, accountKey: '   ' }),
        ],
        [
          'azure sasToken whitespace',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: '   ' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: '   ' }),
        ],
        [
          'azure sasToken bare question mark',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: '?' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: '?' }),
        ],
        [
          'azure sasToken fragment',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: 'sv=2023#frag' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: 'sv=2023#frag' }),
        ],
        [
          'azure sasToken CRLF',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: 'sv=2023\r\n&sig=abc' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, sasToken: 'sv=2023\r\n&sig=abc' }),
        ],
        [
          'azure connectionString fragment SAS',
          { providerType: 'azure-blob', credentials: { type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, connectionString: 'SharedAccessSignature=sv=2023#frag' } },
          () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: ACCOUNT, containerName: CONTAINER, connectionString: 'SharedAccessSignature=sv=2023#frag' }),
        ],
        [
          'gcs serviceAccountKeyJson whitespace values',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: '{"client_email":"   ","private_key":"   "}' } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: '{"client_email":"   ","private_key":"   "}' }),
        ],
        [
          'gcs serviceAccountKeyJson array',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: '[]' } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', serviceAccountKeyJson: '[]' }),
        ],
        [
          'gcs clientEmail whitespace',
          { providerType: 'gcs', credentials: { type: 'gcs', bucket: 'bkt', clientEmail: '   ', privateKey: '   ' } },
          () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', clientEmail: '   ', privateKey: '   ' }),
        ],
        ['http url: 0', { providerType: 'http', credentials: { type: 'http', url: 0 } }],
        ['http bearerToken: 0', { providerType: 'http', credentials: { type: 'http', bearerToken: 0 } }],
        ['http headers: null', { providerType: 'http', credentials: { type: 'http', headers: null } }],
        ['invalid providerType ftp', { providerType: 'ftp', credentials: { type: 'ftp' } }],
        ['invalid providerType toString', { providerType: 'toString', credentials: { type: 'toString' } }],
        ['numeric providerType', { providerType: 123, credentials: { type: 123 } }],
        ['boolean providerType', { providerType: true, credentials: { type: true } }],
        ['string credentials', { providerType: 's3', credentials: 'not-an-object' }],
        ['array credentials', { providerType: 's3', credentials: ['s3'] }],
      ];

      for (const [label, payload, ctor] of invalidPayloads) {
        const res = await postCreds(payload);
        expect(res.status, label).toBe(400);
        if (ctor) {
          expect(ctor, label).toThrow(StorageAdapterError);
        }
        const typeVal = (payload as { credentials?: { type?: unknown } })?.credentials?.type;
        if (typeof typeVal === 'string' && ['s3', 'gcs', 'azure-blob', 'sftp', 'webdav', 'http'].includes(typeVal)) {
          expect(() => createStorageAdapter((payload as { credentials: never }).credentials), label).toThrow(StorageAdapterError);
        }
      }
      for (const nonObj of [null, undefined, 'bad', ['s3']] as const) {
        expect(() => new AzureBlobStorageAdapter(nonObj as never)).toThrow(StorageAdapterError);
        expect(() => new GcsStorageAdapter(nonObj as never)).toThrow(StorageAdapterError);
        expect(() => new WebDavStorageAdapter(nonObj as never)).toThrow(StorageAdapterError);
        expect(() => new S3StorageAdapter(nonObj as never)).toThrow(StorageAdapterError);
        expect(() => new SftpStorageAdapter(nonObj as never)).toThrow(StorageAdapterError);
      }
      expect(await credentialsVault.list(user.id)).toEqual([]);

      // Verify cred_ vault registration -> importFromCustomerStorage -> exportToCustomerStorage roundtrip for WebDAV
      const credServer = await serve((req, body, res) => {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': '6' }).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Length': '6', 'Content-Type': 'text/plain' }).end('credok');
          return;
        }
        if (req.method === 'PUT') {
          res.writeHead(201, { ETag: `"${body.length}"` }).end();
          return;
        }
        res.writeHead(404).end();
      });
      allowDev(credServer);
      const regRes = await postCreds({
        providerType: 'webdav',
        credentials: { type: 'webdav', url: `${credServer.origin}/dav`, basePath: '/Team #1' },
      });
      expect(regRes.status).toBe(201);
      const { credentialRef } = await regRes.json();
      const credGraphId = `g_cred_dav_${Date.now()}`;
      const importedCred = await importFromCustomerStorage(
        {
          id: graphNodeJobId(credGraphId, 'in'),
          data: { graphId: credGraphId, graphNodeId: 'in', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        { op: 'import.webdav', path: 'src.txt', credentialRef } as never,
        graphNodeJobId(credGraphId, 'in')
      );
      expect(importedCred).toHaveLength(1);
      await exportToCustomerStorage(
        {
          id: graphNodeJobId(credGraphId, 'out'),
          data: { graphId: credGraphId, graphNodeId: 'out', userId: user.id },
          opts: { attempts: 1 },
          signal: new AbortController().signal,
          log: async () => {},
        } as never,
        storageProvider,
        { op: 'export.webdav', input: 'in', directory: 'out', credentialRef } as never,
        importedCred,
        graphNodeJobId(credGraphId, 'out')
      );
      expect(credServer.hits.map((h) => [h.method, h.rawUrl])).toEqual([
        ['HEAD', '/dav/Team%20%231/src.txt'],
        ['GET', '/dav/Team%20%231/src.txt'],
        ['PUT', '/dav/Team%20%231/out/src.txt'],
      ]);
      for (const k of importedCred) {
        await Promise.resolve(storageProvider.deleteObject(k)).catch(() => false);
      }
      await credentialsVault.delete(credentialRef, user.id);

      // Backward compatibility: valid password-only SFTP credentials still register with 201
      const validSftpRes = await postCreds({
        providerType: 'sftp',
        credentials: { type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', basePath: '/' },
      });
      expect(validSftpRes.status).toBe(201);

      // Verify unknown providerType throws StorageAdapterError directly in validateStorageCredentials/createStorageAdapter
      await expect(validateStorageCredentials({ type: 'ftp' } as never)).rejects.toThrow(StorageAdapterError);
      expect(() => createStorageAdapter({ type: 'ftp' } as never)).toThrow(StorageAdapterError);

      // Verify non-StorageAdapterError throw in validateStorageCredentials is masked via unclassifiedFailure
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(S3StorageAdapter.prototype, 'verifyEndpoint').mockRejectedValueOnce(new Error('ECONNREFUSED /var/run/internal.sock'));
      const errRes = await postCreds({
        providerType: 's3',
        credentials: { type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X' },
      });
      expect(errRes.status).toBe(500);
      expect(errRes.headers.get('content-type')).toContain('application/problem+json');
      const errBody = await errRes.json();
      expect(errBody.detail).toBe('Failed to register credentials.');
      expect(JSON.stringify(errBody)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(errBody)).not.toContain('/var/run/internal.sock');
      expect(consoleError.mock.calls.some((call) => String(call[1]).includes('ECONNREFUSED'))).toBe(true);
    });
  });
});
