import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AzureBlobStorageAdapter,
  GcsStorageAdapter,
  WebDavStorageAdapter,
  createStorageAdapter,
  validateStorageCredentials,
} from '../src/lib/storage/adapters';
import {
  StorageAdapterError,
  StorageInvalidKeyError,
  StorageSsrfError,
} from '../src/lib/storage/adapters/adapter-interface';
import { ADAPTER_BODY_CAP_BYTES } from '../src/lib/storage/adapters/http-limits';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, readBoundedBody } from '../src/lib/storage/adapters/http-guard';

/**
 * The HTTP adapters reach the customer's endpoint over TLS only, refuse an endpoint that is not public, read only a
 * bounded error or metadata body, and never follow a redirect. The local servers below are reachable only through the
 * server's development allowlist, which no field of the customer's credentials can set.
 */

const MIB = 1024 * 1024;
/** A call that is held by an answer it does not read never ends; this is far above the time the call takes. */
const UNREAD_BODY_HANG_GUARD_MS = 10_000;
const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];
const ACCOUNT_KEY = Buffer.from('azure-test-account-key').toString('base64');

interface LocalServer {
  origin: string;
  host: string;
  hits: { method: string; url: string; authorization?: string }[];
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startServer(handler: Handler): Promise<LocalServer> {
  const hits: LocalServer['hits'] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
    handler(req, res);
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

function allowDevEndpoints(...servers: LocalServer[]): void {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, servers.map((server) => server.host).join(','));
}

/** An error body of `bytes` bytes sent in pieces until the client hangs up; `sent()` tells how much left the server. */
function floodResponse(res: http.ServerResponse, status: number, bytes: number): () => number {
  let sent = 0;
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  const piece = Buffer.alloc(64 * 1024, 0x78);
  const pump = () => {
    while (sent < bytes) {
      sent += piece.length;
      if (!res.write(piece)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  pump();
  return () => sent;
}

type Case = { name: string; build: (server: string) => WebDavStorageAdapter | AzureBlobStorageAdapter | GcsStorageAdapter };

const adapters: Case[] = [
  { name: 'webdav', build: (url) => new WebDavStorageAdapter({ type: 'webdav', url, username: 'u', password: 'secret-pw' }) },
  {
    name: 'azure-blob',
    build: (url) => new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: 'devaccount', containerName: 'c', accountKey: ACCOUNT_KEY, customEndpoint: url }),
  },
  { name: 'gcs', build: (url) => new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: url }) },
];

describe('HTTP BYOS adapters', () => {
  const servers: LocalServer[] = [];

  async function serve(handler: Handler): Promise<LocalServer> {
    const server = await startServer(handler);
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue(PUBLIC_ADDRESS as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  describe('TLS only', () => {
    const plain: [string, string][] = [
      ['webdav', 'http://dav.example.com/files'],
      ['azure-blob', 'http://blob.example.com'],
      ['gcs', 'http://storage.example.com'],
    ];

    it.each(plain)('%s refuses every operation on %s before any lookup or connection', async (name, url) => {
      const adapter = adapters.find((entry) => entry.name === name)!.build(url);
      for (const call of [
        () => adapter.downloadStream('a.bin'),
        () => adapter.uploadStream('a.bin', Readable.from(['x']), { size: 1 }),
        () => adapter.head('a.bin'),
        () => adapter.delete('a.bin'),
      ]) {
        await expect(call()).rejects.toThrow(StorageSsrfError);
        await expect(call()).rejects.toThrow(/TLS is required/);
      }
      expect(dns.promises.lookup).not.toHaveBeenCalled();
    });

    it('does not put a credential on the wire to a plain-HTTP endpoint, even one named in an allowlist that is not honoured', async () => {
      const server = await serve((_req, res) => res.writeHead(200).end());
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, server.host);
      for (const { build } of adapters) {
        await expect(build(server.origin).head('a.bin')).rejects.toThrow(StorageSsrfError);
      }
      expect(server.hits).toHaveLength(0);
    });

    it('refuses a plain-HTTP endpoint when credentials are registered or an adapter is created', async () => {
      const credentials = [
        { type: 'webdav', url: 'http://dav.example.com/files' },
        { type: 'azure-blob', storageAccount: 'acc', containerName: 'c', customEndpoint: 'http://blob.example.com' },
        { type: 'gcs', bucket: 'bkt', endpoint: 'http://storage.example.com' },
      ] as const;
      for (const entry of credentials) {
        // a WebDAV adapter is created and refuses at its first request, as before; azure and gcs refuse at creation
        if (entry.type !== 'webdav') expect(() => createStorageAdapter(entry)).toThrow(StorageSsrfError);
        await expect(validateStorageCredentials(entry)).rejects.toThrow(StorageSsrfError);
      }
    });

    it('does not echo the userinfo or the query of an endpoint that is not a URL', () => {
      const raw = 'https://user:PW-SECRET@exa mple.com/?sv=SAS-SECRET';
      for (const entry of [
        { type: 'gcs', bucket: 'bkt', endpoint: raw },
        { type: 'azure-blob', storageAccount: 'acc', containerName: 'c', customEndpoint: raw },
        { type: 'webdav', url: raw },
      ] as const) {
        const error = (() => {
          try {
            createStorageAdapter(entry);
          } catch (err) {
            return err as Error;
          }
          return undefined;
        })();
        expect(error).toBeInstanceOf(StorageAdapterError);
        expect(error?.message).not.toMatch(/PW-SECRET|SAS-SECRET/);
        expect(JSON.stringify({ message: error?.message, cause: (error as StorageAdapterError).cause })).not.toMatch(/PW-SECRET|SAS-SECRET/);
      }
    });

    it('accepts a TLS endpoint', () => {
      expect(createStorageAdapter({ type: 'webdav', url: 'https://dav.example.com/files' }).providerName).toBe('webdav');
      expect(createStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: 'https://storage.example.com' }).providerName).toBe('gcs');
      expect(
        createStorageAdapter({ type: 'azure-blob', storageAccount: 'acc', containerName: 'c', customEndpoint: 'https://blob.example.com' }).providerName
      ).toBe('azure-blob');
    });

    it.each(adapters)('$name reaches a local HTTP server only when the development allowlist names it', async ({ build }) => {
      const server = await serve((_req, res) => res.writeHead(200, { ETag: '"e"' }).end('{}'));
      const other = await serve((_req, res) => res.writeHead(200).end());
      allowDevEndpoints(server);
      await expect(build(server.origin).head('a.bin')).resolves.toBeTruthy();
      expect(server.hits).toHaveLength(1);
      await expect(build(other.origin).head('a.bin')).rejects.toThrow(StorageSsrfError);
      expect(other.hits).toHaveLength(0);
    });
  });

  describe('a name that resolves to a private address', () => {
    it.each(adapters)('$name refuses it', async ({ build }) => {
      vi.mocked(dns.promises.lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
      const adapter = build('https://files.customer.example.com');
      await expect(adapter.head('a.bin')).rejects.toThrow(StorageSsrfError);
      await expect(adapter.downloadStream('a.bin')).rejects.toThrow(StorageSsrfError);
      await expect(adapter.delete('a.bin')).rejects.toThrow(StorageSsrfError);
    });
  });

  describe('Azure storage account names', () => {
    const hostile = [
      'attacker.example#@x',
      'attacker.example/x',
      'evil.com',
      'acc:443',
      'acc?x=1',
      'ACCOUNT',
      'ab',
      'a'.repeat(25),
      'acc-name',
      'acc ount',
      '',
    ];

    it.each(hostile)('refuses %j when the adapter is built, registered and created', async (storageAccount) => {
      const credentials = { type: 'azure-blob' as const, storageAccount, containerName: 'c', accountKey: ACCOUNT_KEY };
      expect(() => new AzureBlobStorageAdapter(credentials)).toThrow(StorageAdapterError);
      expect(() => createStorageAdapter(credentials)).toThrow(StorageAdapterError);
      await expect(validateStorageCredentials(credentials)).rejects.toThrow(StorageAdapterError);
    });

    it('does not let the account name change the host of the default endpoint', async () => {
      const lookup = vi.mocked(dns.promises.lookup);
      lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
      await expect(
        new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount: 'goodaccount1', containerName: 'c' }).head('a.bin')
      ).rejects.toThrow(StorageSsrfError);
      expect(lookup).toHaveBeenCalledWith('goodaccount1.blob.core.windows.net', { all: true });
    });

    it('accepts the bounds of the rule', () => {
      for (const storageAccount of ['abc', 'a1b2c3', 'a'.repeat(24)]) {
        expect(new AzureBlobStorageAdapter({ type: 'azure-blob', storageAccount, containerName: 'c' }).providerName).toBe('azure-blob');
      }
    });
  });

  describe('GCS object names', () => {
    const hostile = ['../x', 'a/../b', './a', 'a/./b', '/../etc', '//..//x', '..', 'a/..'];

    it.each(hostile)('refuses %j in every operation before any request', async (remotePath) => {
      const adapter = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt' });
      await expect(adapter.downloadStream(remotePath)).rejects.toThrow(StorageInvalidKeyError);
      await expect(adapter.uploadStream(remotePath, Readable.from(['x']), { size: 1 })).rejects.toThrow(StorageInvalidKeyError);
      await expect(adapter.head(remotePath)).rejects.toThrow(StorageInvalidKeyError);
      await expect(adapter.delete(remotePath)).rejects.toThrow(StorageInvalidKeyError);
      expect(dns.promises.lookup).not.toHaveBeenCalled();
    });

    it('sends a plain name, a nested name and a name with dots inside a segment', async () => {
      const server = await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"size":"3"}'));
      allowDevEndpoints(server);
      const adapter = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: server.origin });
      for (const name of ['a.bin', '/dir/a.bin', 'v1..2/a..b']) {
        await expect(adapter.head(name)).resolves.toMatchObject({ size: 3 });
      }
      expect(server.hits.map((hit) => hit.url)).toEqual([
        '/storage/v1/b/bkt/o/a.bin',
        '/storage/v1/b/bkt/o/dir%2Fa.bin',
        '/storage/v1/b/bkt/o/v1..2%2Fa..b',
      ]);
    });
  });

  describe('a hostile answer', () => {
    it.each(adapters)('$name reads at most the cap of an error body and drops the rest', async ({ build }) => {
      let sent = (): number => 0;
      const server = await serve((_req, res) => {
        sent = floodResponse(res, 500, 64 * MIB);
      });
      allowDevEndpoints(server);
      const error = await build(server.origin).downloadStream('a.bin').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/\(500\)/);
      expect((error as Error).message.length).toBeLessThanOrEqual(ADAPTER_BODY_CAP_BYTES + 200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sent()).toBeLessThan(16 * MIB);
    });

    it.each(adapters)('$name stops reading an upload answer that is an error body of any size', async ({ build }) => {
      const server = await serve((req, res) => {
        req.resume();
        req.on('end', () => floodResponse(res, 500, 64 * MIB));
      });
      allowDevEndpoints(server);
      const error = await build(server.origin)
        .uploadStream('a.bin', Readable.from([Buffer.from('payload')]), { size: 7 })
        .catch((err: unknown) => err);
      expect((error as Error).message.length).toBeLessThanOrEqual(ADAPTER_BODY_CAP_BYTES + 200);
    });

    it('GCS refuses a metadata document past the cap instead of parsing a part of it', async () => {
      const server = await serve((_req, res) => {
        floodResponse(res, 200, 64 * MIB);
      });
      allowDevEndpoints(server);
      const adapter = new GcsStorageAdapter({ type: 'gcs', bucket: 'bkt', endpoint: server.origin });
      await expect(adapter.head('a.bin')).rejects.toThrow(/longer than 65536 bytes/);
      await expect(adapter.uploadStream('a.bin', Readable.from(['x']), { size: 1 })).rejects.toThrow(/longer than 65536 bytes/);
    });

    it.each(adapters)('$name is not held by the body of an answer it does not read (head, delete)', async ({ build }) => {
      const server = await serve((req, res) => {
        req.resume();
        floodResponse(res, req.method === 'DELETE' ? 204 : 200, 1024 * MIB);
      });
      allowDevEndpoints(server);
      const adapter = build(server.origin);
      const started = Date.now();
      await adapter.head('a.bin').catch(() => undefined);
      await adapter.delete('a.bin').catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(UNREAD_BODY_HANG_GUARD_MS);
    }, 2 * UNREAD_BODY_HANG_GUARD_MS);

    it.each(adapters)('$name does not follow a redirect and sends no credential to its target', async ({ build }) => {
      const target = await serve((_req, res) => res.writeHead(200, { 'Content-Length': '1' }).end('x'));
      const server = await serve((_req, res) => res.writeHead(302, { Location: `${target.origin}/stolen` }).end());
      allowDevEndpoints(server, target);
      const adapter = build(server.origin);
      await expect(adapter.downloadStream('a.bin')).rejects.toThrow(/302/);
      expect(await adapter.head('a.bin')).toBeNull();
      expect(await adapter.delete('a.bin')).toBe(false);
      expect(target.hits).toHaveLength(0);
    });
  });

  describe('readBoundedBody', () => {
    it('cuts a body at the cap and destroys it', async () => {
      const body = Readable.from([Buffer.alloc(40, 0x61), Buffer.alloc(40, 0x62), Buffer.alloc(40, 0x63)]);
      const result = await readBoundedBody(body, 'webdav', 100, 1_000);
      expect(result.truncated).toBe(true);
      expect(result.text).toBe('a'.repeat(40) + 'b'.repeat(40) + 'c'.repeat(20));
      expect(body.destroyed).toBe(true);
    });

    it('answers StorageTimeoutError for a body that does not finish and destroys it', async () => {
      const body = new Readable({ read() {} });
      body.push('partial');
      await expect(readBoundedBody(body, 'webdav', 1_000, 50)).rejects.toThrow(/timed out after 50 ms/);
      expect(body.destroyed).toBe(true);
    });
  });
});
