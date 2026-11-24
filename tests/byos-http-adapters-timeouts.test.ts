import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, Dispatcher } from 'undici';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { exportArtifactToUrl } from '../src/lib/queue/graph/node-executor';
import { importUrlWithinBudget } from '../src/lib/queue/graph/node-url-import';
import { storageProvider } from '../src/lib/storage';
import { AzureBlobStorageAdapter, GcsStorageAdapter, WebDavStorageAdapter } from '../src/lib/storage/adapters';
import { StorageTimeoutError } from '../src/lib/storage/adapters/adapter-interface';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/** The deadlines are shortened so a stalled endpoint is given up in a test; the code under test reads them from this module. */
vi.mock('../src/lib/storage/adapters/http-limits', () => ({
  ADAPTER_BODY_CAP_BYTES: 64 * 1024,
  ADAPTER_RESPONSE_TIMEOUT_MS: 300,
  ADAPTER_HEADERS_TIMEOUT_MS: 300,
}));

const connection = vi.hoisted(() => ({ current: null as Dispatcher | null }));
vi.mock('../src/lib/security/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/ssrf')>();
  const { Dispatcher: BaseDispatcher } = await import('undici');
  class ForwardingDispatcher extends BaseDispatcher {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      if (!connection.current) {
        throw new Error('test did not install a dispatcher');
      }
      return connection.current.dispatch(opts, handler);
    }
  }
  return { ...actual, createSsrfSafeAgent: vi.fn(() => new ForwardingDispatcher()) };
});

/** The shortened deadlines are 300 ms; a call that ends in under this far larger time was given up, not held. */
const STALL_HANG_GUARD_MS = 10_000;
const ACCOUNT_KEY = Buffer.from('azure-test-account-key').toString('base64');

describe('HTTP BYOS adapters against an endpoint that stalls', () => {
  let server: http.Server;
  let origin: string;
  let host: string;
  let port: number;
  let silentRequests = 0;
  const sockets = new Set<Socket>();
  let mode: 'silent' | 'trickle-error' | 'trickle-json' = 'silent';

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    mode = 'silent';
    silentRequests = 0;
    connection.current = null;
    server = http.createServer((req, res) => {
      req.resume();
      if (mode === 'silent') {
        silentRequests++;
        return;
      }
      res.writeHead(mode === 'trickle-error' ? 500 : 200, { 'Content-Type': 'application/json' });
      // one byte every 50 ms: never idle for long, never finished
      const timer = setInterval(() => res.write('1'), 50);
      res.on('close', () => clearInterval(timer));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    host = `127.0.0.1:${port}`;
    origin = `http://${host}`;
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, host);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    connection.current = null;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const adapters = [
    () => new WebDavStorageAdapter({ type: 'webdav', url: origin }),
    () => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: 'devaccount', containerName: 'c', accountKey: ACCOUNT_KEY, customEndpoint: origin }),
    () => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: origin }),
  ];

  it.each(adapters.map((build, index) => [['webdav', 'azure-blob', 'gcs'][index], build] as const))(
    '%s gives up a request that gets no answer',
    async (name, build) => {
      mode = 'silent';
      const adapter = build();
      const started = Date.now();
      await expect(adapter.head('a.bin')).rejects.toThrow(StorageTimeoutError);
      await expect(adapter.delete('a.bin')).rejects.toThrow(StorageTimeoutError);
      await expect(adapter.downloadStream('a.bin')).rejects.toThrow(StorageTimeoutError);
      await expect(adapter.uploadStream('a.bin', Readable.from(['x']), { size: 1 })).rejects.toThrow(StorageTimeoutError);
      if (name === 'webdav') {
        await expect((adapter as WebDavStorageAdapter).listDirectory('', 10)).rejects.toThrow(StorageTimeoutError);
      } else {
        await expect((adapter as AzureBlobStorageAdapter | GcsStorageAdapter).listObjects('', 10)).rejects.toThrow(StorageTimeoutError);
      }
      expect(Date.now() - started).toBeLessThan(STALL_HANG_GUARD_MS);
    },
    2 * STALL_HANG_GUARD_MS
  );

  it.each(adapters.map((build, index) => [['webdav', 'azure-blob', 'gcs'][index], build] as const))(
    '%s gives up an error body that trickles in',
    async (_name, build) => {
      mode = 'trickle-error';
      const started = Date.now();
      const error = await build().downloadStream('a.bin').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/\(500\)/);
      expect(Date.now() - started).toBeLessThan(STALL_HANG_GUARD_MS);
    },
    2 * STALL_HANG_GUARD_MS
  );

  it('GCS gives up a metadata body that trickles in', async () => {
    mode = 'trickle-json';
    const started = Date.now();
    await expect(new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: origin }).head('a.bin')).rejects.toThrow(StorageTimeoutError);
    expect(Date.now() - started).toBeLessThan(STALL_HANG_GUARD_MS);
  });

  it('import.url and export.url abort under AbortSignal.timeout against a silent server', async () => {
    const sourceKey = `intermediate/url-stall/${Date.now()}/0/payload.txt`;
    await storageProvider.saveObject(sourceKey, Buffer.from('payload'), 'text/plain', 'payload.txt');
    mode = 'silent';
    const agent = new Agent({
      connect: ((_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => cb(null, socket));
        socket.once('error', (err) => cb(err));
      }) as never,
    });
    connection.current = agent;

    const makeJob = (signal: AbortSignal) =>
      ({
        id: 'g-stall:in',
        data: {
          jobId: 'g-stall:in',
          graphId: 'g-stall',
          graphNodeId: 'in',
          userId: 'user-url-stall',
          originalFilename: '',
          sourceFormat: '',
          targetFormat: '',
          fileSize: 0,
          options: {},
        },
        opts: { attempts: 1, timeout: 1000 },
        attemptsMade: 1,
        signal,
        log: async () => {},
        updateProgress: async () => {},
      }) as unknown as Job<ConversionJobData, ConversionJobResult>;

    const started = Date.now();
    try {
      await expect(
        importUrlWithinBudget(makeJob(AbortSignal.timeout(300)), storageProvider, 'http://files.example.org/in.csv', undefined)
      ).rejects.toThrow();
      await expect(
        exportArtifactToUrl(storageProvider, sourceKey, 'http://files.example.org/out', 'PUT', undefined, AbortSignal.timeout(300))
      ).rejects.toThrow();
      expect(silentRequests).toBe(2);
      expect(Date.now() - started).toBeLessThan(STALL_HANG_GUARD_MS);
    } finally {
      await agent.close();
      await storageProvider.deleteObject(sourceKey);
    }
  }, 2 * STALL_HANG_GUARD_MS);
});
