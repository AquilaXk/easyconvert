import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialsVault, executeExportTask, executeImportTask, localFsStorage } from '../src/lib/storage';
import { StorageSsrfError } from '../src/lib/storage/adapters/adapter-interface';
import { BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/http-guard';

/**
 * import/url and export/url may fetch from and post to a plain-HTTP URL, but never with a credential attached: a bearer
 * token, a custom header or userinfo in the URL would cross the network in the clear. A local server is reachable only
 * through the server's development allowlist.
 */

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];
const BEARER = 'bt-0c1d2e3f4a5b6c7d';

interface Hit {
  method: string;
  url: string;
  authorization?: string;
  apiKey?: string;
}

describe('BYOS URL operations and credentials over plain HTTP', () => {
  let server: http.Server;
  let origin: string;
  let host: string;
  let hits: Hit[];
  const sockets = new Set<Socket>();
  let sourceKey: string;

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue(PUBLIC_ADDRESS as never);
    hits = [];
    server = http.createServer((req, res) => {
      hits.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
      });
      req.resume();
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('payload'));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    host = `127.0.0.1:${port}`;
    origin = `http://${host}`;
    const stored = await localFsStorage.putBuffer(`url-tls-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`, Buffer.from('payload'), {
      contentType: 'text/plain',
    });
    sourceKey = stored.key;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function allowLocalServer(): void {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, host);
  }

  async function bearerRef(): Promise<string> {
    return credentialsVault.store('tls-user', { type: 'http', bearerToken: BEARER });
  }

  async function headerRef(): Promise<string> {
    return credentialsVault.store('tls-user', { type: 'http', headers: { 'X-Api-Key': 'k-123' } });
  }

  describe('refused', () => {
    it.each([
      ['a bearer token', bearerRef],
      ['a custom header', headerRef],
    ])('import/url over http with %s, before any request', async (_label, makeRef) => {
      const credentialRef = await makeRef();
      const error = await executeImportTask({ operation: 'import/url', url: 'http://files.example.org/in.csv', credentialRef, userId: 'tls-user' }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(StorageSsrfError);
      expect((error as Error).message).toMatch(/TLS is required/);
      expect((error as Error).message).not.toContain(BEARER);
    });

    it.each([
      ['a bearer token', bearerRef],
      ['a custom header', headerRef],
    ])('export/url over http with %s, before the source is opened', async (_label, makeRef) => {
      const credentialRef = await makeRef();
      const error = await executeExportTask({ operation: 'export/url', sourceKey, url: 'http://files.example.org/out', credentialRef, userId: 'tls-user' }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(StorageSsrfError);
      expect((error as Error).message).toMatch(/TLS is required/);
    });

    it('either operation over http with userinfo in the URL', async () => {
      const importError = await executeImportTask({ operation: 'import/url', url: 'http://user:pw-9@files.example.org/in.csv' }).catch((err: unknown) => err);
      expect(importError).toBeInstanceOf(StorageSsrfError);
      expect((importError as Error).message).toMatch(/TLS is required/);
      expect((importError as Error).message).not.toContain('pw-9');
      const exportError = await executeExportTask({ operation: 'export/url', sourceKey, url: 'http://user:pw-9@files.example.org/out' }).catch((err: unknown) => err);
      expect(exportError).toBeInstanceOf(StorageSsrfError);
      expect((exportError as Error).message).toMatch(/TLS is required/);
    });

    it('a local http server that the allowlist does not name, whatever the environment', async () => {
      const credentialRef = await bearerRef();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv(BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST_ENV, host);
      await expect(executeImportTask({ operation: 'import/url', url: `${origin}/in.csv`, credentialRef, userId: 'tls-user' })).rejects.toThrow(StorageSsrfError);
      await expect(executeExportTask({ operation: 'export/url', sourceKey, url: `${origin}/out`, credentialRef, userId: 'tls-user' })).rejects.toThrow(StorageSsrfError);
      expect(hits).toHaveLength(0);
    });
  });

  describe('allowed', () => {
    it('plain http with no credential attached still imports and exports', async () => {
      allowLocalServer();
      const imported = await executeImportTask({ operation: 'import/url', url: `${origin}/in.csv` });
      expect(imported.size).toBe(7);
      const exported = await executeExportTask({ operation: 'export/url', sourceKey, url: `${origin}/out` });
      expect(exported.success).toBe(true);
      expect(hits.map((hit) => hit.method)).toEqual(['GET', 'POST']);
      expect(hits.every((hit) => hit.authorization === undefined && hit.apiKey === undefined)).toBe(true);
    });

    it('a server named in the development allowlist receives the credential over http', async () => {
      allowLocalServer();
      const credentialRef = await bearerRef();
      await executeImportTask({ operation: 'import/url', url: `${origin}/in.csv`, credentialRef, userId: 'tls-user' });
      await executeExportTask({ operation: 'export/url', sourceKey, url: `${origin}/out`, credentialRef, userId: 'tls-user' });
      expect(hits.map((hit) => hit.authorization)).toEqual([`Bearer ${BEARER}`, `Bearer ${BEARER}`]);
    });
  });
});
