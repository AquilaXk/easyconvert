import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Dispatcher } from 'undici';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { exportArtifactToUrl } from '../src/lib/queue/graph/node-executor';
import { importUrlWithinBudget } from '../src/lib/queue/graph/node-url-import';
import { storageProvider } from '../src/lib/storage';
import { validateStorageCredentials } from '../src/lib/storage/adapters';
import { StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * BYOS http credentials may target plain http:// only without a credential attached (bearer token,
 * custom headers, or URL userinfo), unless the host is in BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST under
 * NODE_ENV=development. URL import and export nodes also drop unread endless HTTP 500 error bodies
 * without hanging.
 */

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

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];
const BEARER = 'bt-0c1d2e3f4a5b6c7d';
/** A call held by the body of an answer it does not read never ends; this is far above the time it takes. */
const UNREAD_BODY_HANG_GUARD_MS = 10_000;

describe('BYOS HTTP credentials TLS checks & URL endless error body cancellation', () => {
  let server: http.Server;
  let origin: string;
  let host: string;
  let port: number;
  const sockets = new Set<Socket>();
  let sourceKey: string;

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue(PUBLIC_ADDRESS as never);
    connection.current = null;
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('payload'));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    host = `127.0.0.1:${port}`;
    origin = `http://${host}`;
    sourceKey = `intermediate/url-tls/${Date.now()}-${Math.random().toString(36).slice(2)}/0/payload.txt`;
    await storageProvider.saveObject(sourceKey, Buffer.from('payload'), 'text/plain', 'payload.txt');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    connection.current = null;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storageProvider.deleteObject(sourceKey);
  });

  function allowLocalServer(): void {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, host);
  }

  describe('validateStorageCredentials for type: http', () => {
    it('refuses plain http:// URLs carrying bearerToken, custom headers, or userinfo', async () => {
      const bearerErr = await validateStorageCredentials({
        type: 'http',
        url: 'http://files.example.org/in.csv',
        bearerToken: BEARER,
      }).catch((err: unknown) => err);
      expect(bearerErr).toBeInstanceOf(StorageSsrfError);
      expect((bearerErr as Error).message).toMatch(/TLS is required/);
      expect((bearerErr as Error).message).not.toContain(BEARER);

      const headerErr = await validateStorageCredentials({
        type: 'http',
        url: 'http://files.example.org/out',
        headers: { 'X-Api-Key': 'k-123' },
      }).catch((err: unknown) => err);
      expect(headerErr).toBeInstanceOf(StorageSsrfError);
      expect((headerErr as Error).message).toMatch(/TLS is required/);
      expect((headerErr as Error).message).not.toContain('k-123');

      const userinfoErr = await validateStorageCredentials({
        type: 'http',
        url: 'http://user:pw-9@files.example.org/in.csv',
      }).catch((err: unknown) => err);
      expect(userinfoErr).toBeInstanceOf(StorageSsrfError);
      expect((userinfoErr as Error).message).toMatch(/TLS is required/);
      expect((userinfoErr as Error).message).not.toContain('pw-9');
    });

    it('refuses a local http server in production even if listed in BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, host);

      await expect(
        validateStorageCredentials({ type: 'http', url: `${origin}/in.csv`, bearerToken: BEARER })
      ).rejects.toThrow(StorageSsrfError);
      await expect(
        validateStorageCredentials({ type: 'http', url: `${origin}/out` })
      ).rejects.toThrow(StorageSsrfError);
    });

    it('allows plain http:// without credentials on a public host, and allows dev-allowlisted endpoints with credentials', async () => {
      await expect(
        validateStorageCredentials({ type: 'http', url: 'http://files.example.org/in.csv' })
      ).resolves.toBeUndefined();

      allowLocalServer();
      await expect(
        validateStorageCredentials({ type: 'http', url: `${origin}/in.csv`, bearerToken: BEARER })
      ).resolves.toBeUndefined();
      await expect(
        validateStorageCredentials({ type: 'http', url: `${origin}/out`, headers: { 'X-Api-Key': 'k-123' } })
      ).resolves.toBeUndefined();
    });
  });

  describe('a failed answer with an endless body', () => {
    function endlessAnswer(status: number): { requests: string[] } {
      const requests: string[] = [];
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        requests.push(`${req.method} ${req.url}`);
        req.resume();
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        const piece = Buffer.alloc(64 * 1024, 0x78);
        const pump = () => {
          while (res.write(piece)) {
            // keep the socket busy until the client hangs up
          }
          res.once('drain', pump);
        };
        res.on('close', () => res.removeAllListeners('drain'));
        pump();
      });
      return { requests };
    }

    it('cancels an endless HTTP 500 body on importUrlWithinBudget and exportArtifactToUrl without hanging', async () => {
      const { requests } = endlessAnswer(500);
      const agent = new Agent({
        connect: ((_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => cb(null, socket));
          socket.once('error', (err) => cb(err));
        }) as never,
      });
      connection.current = agent;

      const job = {
        id: 'g-endless:in',
        data: {
          jobId: 'g-endless:in',
          graphId: 'g-endless',
          graphNodeId: 'in',
          userId: 'user-endless-500',
          originalFilename: '',
          sourceFormat: '',
          targetFormat: '',
          fileSize: 0,
          options: {},
        },
        opts: { attempts: 1, timeout: 5000 },
        attemptsMade: 1,
        signal: new AbortController().signal,
        log: async () => {},
        updateProgress: async () => {},
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      const started = Date.now();
      try {
        await expect(
          importUrlWithinBudget(job, storageProvider, 'http://files.example.org/in.csv', undefined)
        ).rejects.toThrow(/HTTP 500/);
        await expect(
          exportArtifactToUrl(storageProvider, sourceKey, 'http://files.example.org/out', 'POST', undefined, new AbortController().signal)
        ).rejects.toThrow(/HTTP 500/);
        expect(requests).toEqual(['GET /in.csv', 'POST /out']);
        expect(Date.now() - started).toBeLessThan(UNREAD_BODY_HANG_GUARD_MS);
      } finally {
        await agent.close();
      }
    }, 3 * UNREAD_BODY_HANG_GUARD_MS);
  });
});
