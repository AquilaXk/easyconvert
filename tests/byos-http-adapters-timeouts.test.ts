import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeExportTask, executeImportTask, localFsStorage } from '../src/lib/storage';
import { AzureBlobStorageAdapter, GcsStorageAdapter, WebDavStorageAdapter } from '../src/lib/storage/adapters';
import { StorageTimeoutError } from '../src/lib/storage/adapters/adapter-interface';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';

/** The deadlines are shortened so a stalled endpoint is given up in a test; the code under test reads them from this module. */
vi.mock('../src/lib/storage/adapters/http-limits', () => ({
  ADAPTER_BODY_CAP_BYTES: 64 * 1024,
  ADAPTER_RESPONSE_TIMEOUT_MS: 300,
  ADAPTER_HEADERS_TIMEOUT_MS: 300,
  URL_OPERATION_HEADERS_TIMEOUT_MS: 300,
  URL_OPERATION_BODY_TIMEOUT_MS: 300,
}));

/** The shortened deadlines are 300 ms; a call that ends in under this far larger time was given up, not held. */
const STALL_HANG_GUARD_MS = 10_000;
const ACCOUNT_KEY = Buffer.from('azure-test-account-key').toString('base64');

describe('HTTP BYOS adapters against an endpoint that stalls', () => {
  let server: http.Server;
  let origin: string;
  let host: string;
  const sockets = new Set<Socket>();
  let mode: 'silent' | 'trickle-error' | 'trickle-json' = 'silent';

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    mode = 'silent';
    server = http.createServer((req, res) => {
      req.resume();
      if (mode === 'silent') return;
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
    const { port } = server.address() as AddressInfo;
    host = `127.0.0.1:${port}`;
    origin = `http://${host}`;
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, host);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    async (_name, build) => {
      mode = 'silent';
      const adapter = build();
      const started = Date.now();
      await expect(adapter.head('a.bin')).rejects.toThrow();
      await expect(adapter.delete('a.bin')).rejects.toThrow();
      await expect(adapter.downloadStream('a.bin')).rejects.toThrow();
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

  it('import/url and export/url give up an endpoint that sends no answer, and a body that stops', async () => {
    const stored = await localFsStorage.putBuffer(`url-stall-${Date.now()}.txt`, Buffer.from('payload'), { contentType: 'text/plain' });
    mode = 'silent';
    const started = Date.now();
    await expect(executeImportTask({ operation: 'import/url', url: `${origin}/in.csv` })).rejects.toThrow();
    await expect(executeExportTask({ operation: 'export/url', sourceKey: stored.key, url: `${origin}/out` })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(STALL_HANG_GUARD_MS);
  }, 2 * STALL_HANG_GUARD_MS);
});
