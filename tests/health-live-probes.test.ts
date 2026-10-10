import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * GET /api/health answers from live probes: Redis PING, storage reachability and the presence of
 * the native CLIs. Oracles are independent of the module under test: the HTTP status, a fake RESP
 * server that records the commands it receives, fake executables in a temporary directory, and the
 * signature-verifying S3 stub server.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;
/** Public deadline of the probe set; the stalled dependency never answers, so any finite slack tells a deadline from a hang. */
const RESPONSE_SLACK_MS = 10_000;
const BUCKET = 'health-objects';
const OCI_ACCESS_KEY = 'AKIAOCIHEALTH000001';
const OCI_SECRET = 'oci/Secret+Key/HEALTHKEY0000000000000000';
const REDIS_PASSWORD = 'redis-password-must-not-leak';

/** Binary env overrides read by the worker, one per required tool (src/worker/engines.ts). */
const BINARY_ENV: Readonly<Record<string, string>> = {
  soffice: 'SOFFICE_PATH',
  ffmpeg: 'FFMPEG_PATH',
  ffprobe: 'FFPROBE_PATH',
  '7z': 'P7ZIP_PATH',
  pdftoppm: 'PDFTOPPM_PATH',
  pdftotext: 'PDFTOTEXT_PATH',
  tesseract: 'TESSERACT_PATH',
  dcraw_emu: 'DCRAW_EMU_PATH',
};
const REQUIRED_COMPONENTS = [...Object.keys(BINARY_ENV), 'redis', 'storage'];

let workDir: string;
let binDir: string;
let storageDir: string;

function installFakeBinary(name: string, mode = 0o755): string {
  const target = path.join(binDir, name);
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode });
  fs.chmodSync(target, mode);
  return target;
}

function installAllFakeBinaries(): void {
  for (const [name, envName] of Object.entries(BINARY_ENV)) {
    vi.stubEnv(envName, installFakeBinary(name));
  }
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface FakeRedis {
  port: number;
  commands: string[];
  close: () => Promise<void>;
}

/** Speaks just enough RESP to answer PING with PONG and records every command name it sees. */
async function startFakeRedis(): Promise<FakeRedis> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      const lines = chunk.toString('latin1').split('\r\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('*')) continue;
        const name = (lines[i + 2] ?? '').toUpperCase();
        commands.push(name);
        socket.write(name === 'PING' ? '+PONG\r\n' : '+OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function loadHealth() {
  vi.resetModules();
  const route = await import('../src/app/api/health/route');
  const probes = await import('../src/lib/health/probes');
  const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
  const { userStore } = await import('../src/lib/auth/user-store');
  return { GET: route.GET, probes, redisKeyStore, userStore };
}

function healthRequest(secretKey?: string): NextRequest {
  return new NextRequest(`${BASE_URL}/api/health`, {
    method: 'GET',
    headers: secretKey ? { Authorization: `Bearer ${secretKey}` } : {},
  });
}

/**
 * Creates the key while the key store is still in-memory: a store backed by the Redis under test
 * could not authenticate anyone once that Redis is down. Callers point REDIS_URL at the Redis under
 * test afterwards, since the probe reads the environment on every run.
 */
async function adminKey(
  loaded: Awaited<ReturnType<typeof loadHealth>>,
  scopes: Array<'*' | 'convert:read'>
): Promise<string> {
  const email = `health_${Date.now()}_${Math.random().toString(36).slice(2)}@health.test`;
  const user = loaded.userStore.sanitizeUser(await loaded.userStore.createUser({ email, name: 'Health', tier: 'free' }));
  const { secretKey } = await loaded.redisKeyStore.generateApiKey(user.id, 'health key', { scopes });
  return secretKey;
}

describe('GET /api/health live probes', () => {
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-health-'));
    binDir = path.join(workDir, 'bin');
    storageDir = path.join(workDir, 'storage');
    fs.mkdirSync(binDir);
    fs.mkdirSync(storageDir);
    installAllFakeBinaries();
    vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.stubEnv('REDIS_URL', undefined);
    vi.stubEnv('REDIS_HOST', undefined);
    vi.stubEnv('REDIS_PORT', undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('binaries and local storage', () => {
    it('answers 200 {status: healthy} when every binary is present, storage is writable and Redis is not configured', async () => {
      const { GET } = await loadHealth();
      const res = await GET(healthRequest());
      expect(res.status).toBe(HTTP_OK);
      expect(await res.json()).toEqual({ status: 'healthy' });
    });

    it('leaves no probe file behind in the storage directory', async () => {
      const { GET } = await loadHealth();
      await GET(healthRequest());
      expect(fs.readdirSync(storageDir)).toEqual([]);
    });

    it.each(Object.keys(BINARY_ENV))(
      'stays healthy when %s is missing and the admin view names exactly that advisory component',
      async (tool) => {
        vi.stubEnv(BINARY_ENV[tool], path.join(binDir, 'does-not-exist'));
        const loaded = await loadHealth();
        const key = await adminKey(loaded, ['*']);

        const publicRes = await loaded.GET(healthRequest());
        expect(publicRes.status).toBe(HTTP_OK);
        expect(await publicRes.json()).toEqual({ status: 'healthy' });

        loaded.probes.resetHealthCache();
        const adminRes = await loaded.GET(healthRequest(key));
        expect(adminRes.status).toBe(HTTP_OK);
        const body = await adminRes.json();
        expect(body.status).toBe('healthy');
        const failed = Object.entries(body.components as Record<string, { status: string; reason?: string; required: boolean }>)
          .filter(([, component]) => component.status === 'failed')
          .map(([name, component]) => [name, component.reason, component.required]);
        expect(failed).toEqual([[tool, 'missing', false]]);
        expect(body.components.storage).toMatchObject({ status: 'ok', required: true });
        expect(body.components.redis).toMatchObject({ required: true });
      }
    );

    it('treats a file without the execute bit as a missing binary', async () => {
      vi.stubEnv('TESSERACT_PATH', installFakeBinary('tesseract-noexec', 0o644));
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const res = await loaded.GET(healthRequest(key));
      expect(res.status).toBe(HTTP_OK);
      expect((await res.json()).components.tesseract).toEqual({ status: 'failed', reason: 'missing', required: false });
    });

    it('answers 503 when the storage directory cannot be written', async () => {
      // A directory below a regular file can never be created, even for root.
      const blocker = path.join(workDir, 'blocker');
      fs.writeFileSync(blocker, 'x');
      vi.stubEnv('EASYCONVERT_STORAGE_DIR', path.join(blocker, 'storage'));
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const res = await loaded.GET(healthRequest(key));
      expect(res.status).toBe(HTTP_UNAVAILABLE);
      const body = await res.json();
      expect(body.components.storage).toMatchObject({ status: 'failed', reason: 'not_writable' });
    });
  });

  describe('Redis', () => {
    it('sends PING to a reachable Redis and stays healthy', async () => {
      const redis = await startFakeRedis();
      try {
        const loaded = await loadHealth();
        const key = await adminKey(loaded, ['*']);
        vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${redis.port}`);
        const res = await loaded.GET(healthRequest(key));
        expect(res.status).toBe(HTTP_OK);
        expect((await res.json()).components.redis).toMatchObject({ status: 'ok' });
        expect(redis.commands).toContain('PING');
      } finally {
        await redis.close();
      }
    });

    it('also probes a Redis configured by REDIS_HOST and REDIS_PORT', async () => {
      const redis = await startFakeRedis();
      try {
        vi.stubEnv('REDIS_HOST', '127.0.0.1');
        vi.stubEnv('REDIS_PORT', String(redis.port));
        const { GET } = await loadHealth();
        const res = await GET(healthRequest());
        expect(res.status).toBe(HTTP_OK);
        expect(redis.commands).toContain('PING');
      } finally {
        await redis.close();
      }
    });

    it('answers 503 within the probe deadline when the Redis port is closed, and the admin view names redis', async () => {
      const port = await unusedPort();
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      vi.stubEnv('REDIS_URL', `redis://:${REDIS_PASSWORD}@127.0.0.1:${port}`);

      const started = Date.now();
      const publicRes = await loaded.GET(healthRequest());
      expect(Date.now() - started).toBeLessThan(loaded.probes.HEALTH_PROBE_TIMEOUT_MS + RESPONSE_SLACK_MS);
      expect(publicRes.status).toBe(HTTP_UNAVAILABLE);
      expect(await publicRes.json()).toEqual({ status: 'unhealthy' });

      loaded.probes.resetHealthCache();
      const adminRes = await loaded.GET(healthRequest(key));
      expect(adminRes.status).toBe(HTTP_UNAVAILABLE);
      const body = await adminRes.json();
      const failed = Object.entries(body.components as Record<string, { status: string }>)
        .filter(([, component]) => component.status === 'failed')
        .map(([name]) => name);
      expect(failed).toEqual(['redis']);
    });

    it('gives up on a Redis that accepts connections but never answers, within the probe deadline', async () => {
      const sockets = new Set<net.Socket>();
      const silent = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
      });
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      try {
        const loaded = await loadHealth();
        const key = await adminKey(loaded, ['*']);
        vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${(silent.address() as net.AddressInfo).port}`);
        const started = Date.now();
        const res = await loaded.GET(healthRequest(key));
        expect(Date.now() - started).toBeLessThan(loaded.probes.HEALTH_PROBE_TIMEOUT_MS + RESPONSE_SLACK_MS);
        expect(res.status).toBe(HTTP_UNAVAILABLE);
        expect((await res.json()).components.redis).toMatchObject({ status: 'failed', reason: 'timeout' });
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    });
  });

  describe('public body and admin view', () => {
    it('never puts paths, hostnames or secrets in any response body', async () => {
      const port = await unusedPort();
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      vi.stubEnv('REDIS_URL', `redis://:${REDIS_PASSWORD}@127.0.0.1:${port}`);
      vi.stubEnv('SOFFICE_PATH', path.join(binDir, 'does-not-exist'));

      const publicText = await (await loaded.GET(healthRequest())).text();
      loaded.probes.resetHealthCache();
      const adminText = await (await loaded.GET(healthRequest(key))).text();

      for (const text of [publicText, adminText]) {
        expect(text).not.toContain(workDir);
        expect(text).not.toContain(os.tmpdir());
        expect(text).not.toContain('127.0.0.1');
        expect(text).not.toContain('localhost');
        expect(text).not.toContain(String(port));
        expect(text).not.toContain(REDIS_PASSWORD);
        expect(text).not.toContain(os.hostname());
      }
    });

    it('reports every required component to an admin and nothing but the verdict to anyone else', async () => {
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const adminBody = await (await loaded.GET(healthRequest(key))).json();
      expect(Object.keys(adminBody.components).sort()).toEqual([...REQUIRED_COMPONENTS].sort());
      expect(adminBody.components.redis).toMatchObject({ status: 'not_configured' });
      expect(adminBody.components.storage).toMatchObject({ status: 'ok', driver: 'local' });
      expect(adminBody.status).toBe('healthy');
      expect(typeof adminBody.checkedAt).toBe('string');

      expect(await (await loaded.GET(healthRequest())).json()).toEqual({ status: 'healthy' });
    });

    it('refuses the detailed view to an API key without the wildcard scope', async () => {
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['convert:read']);
      const res = await loaded.GET(healthRequest(key));
      expect(res.status).toBe(HTTP_FORBIDDEN);
      expect(await res.text()).not.toContain('components');
    });

    it('rejects an unknown API key instead of silently answering with the public body', async () => {
      const { GET } = await loadHealth();
      const res = await GET(healthRequest('ec_live_0000000000000000000000000000000000000000'));
      expect(res.status).toBe(HTTP_UNAUTHORIZED);
    });

    it('no longer reports a hard-coded domain count or an all-true feature list', async () => {
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const body = await (await loaded.GET(healthRequest(key))).json();
      expect(body).not.toHaveProperty('domainsCount');
      expect(body).not.toHaveProperty('features');
    });
  });

  describe('OpenAPI contract', () => {
    it('documents the 200 and 503 verdicts, the admin errors and the component names the probes report', async () => {
      const { GET: getSpec } = await import('../src/app/api/openapi.json/route');
      const spec = await (await getSpec()).json();
      const operation = spec.paths['/api/health'].get;
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '403', '503']);
      for (const code of ['200', '503']) {
        const schema = operation.responses[code].content['application/json'].schema;
        expect(schema.properties.status.enum).toEqual(['healthy', 'unhealthy']);
      }

      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const body = await (await loaded.GET(healthRequest(key))).json();
      const componentSchema = operation.responses['200'].content['application/json'].schema.properties.components
        .additionalProperties;
      for (const component of Object.values(body.components) as Array<{ status: string; driver?: string }>) {
        expect(componentSchema.properties.status.enum).toContain(component.status);
        if (component.driver) expect(componentSchema.properties.driver.enum).toContain(component.driver);
      }
    });
  });

  describe('caching', () => {
    it('serves a cached verdict inside the TTL and probes again once it has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
      const loaded = await loadHealth();
      const ttl = loaded.probes.HEALTH_CACHE_TTL_MS;
      expect(ttl).toBeGreaterThan(0);

      expect((await loaded.GET(healthRequest())).status).toBe(HTTP_OK);

      // A required component starts failing: a directory below a regular file can never be created.
      const blocker = path.join(workDir, 'cache-blocker');
      fs.writeFileSync(blocker, 'x');
      vi.stubEnv('EASYCONVERT_STORAGE_DIR', path.join(blocker, 'storage'));
      vi.setSystemTime(Date.now() + ttl - 1);
      expect((await loaded.GET(healthRequest())).status).toBe(HTTP_OK);

      vi.setSystemTime(Date.now() + 1);
      expect((await loaded.GET(healthRequest())).status).toBe(HTTP_UNAVAILABLE);
    });

    it('runs one probe set for concurrent requests', async () => {
      const redis = await startFakeRedis();
      try {
        vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${redis.port}`);
        const { GET } = await loadHealth();
        const responses = await Promise.all(Array.from({ length: 5 }, () => GET(healthRequest())));
        expect(responses.map((r) => r.status)).toEqual(Array(5).fill(HTTP_OK));
        expect(redis.commands.filter((c) => c === 'PING')).toHaveLength(1);
      } finally {
        await redis.close();
      }
    });
  });

  describe('remote object storage', () => {
    let server: S3StubServer;

    beforeAll(async () => {
      server = await startS3StubServer({ bucket: BUCKET, credentials: { [OCI_ACCESS_KEY]: OCI_SECRET } });
    });

    afterAll(async () => {
      await server.close();
    });

    beforeEach(() => {
      server.requests.length = 0;
      server.faults.length = 0;
      vi.stubEnv('STORAGE_DRIVER', 'oci');
      vi.stubEnv('OCI_NAMESPACE', 'axyz123namespace');
      vi.stubEnv('OCI_REGION', 'ap-seoul-1');
      vi.stubEnv('OCI_BUCKET', BUCKET);
      vi.stubEnv('OCI_ACCESS_KEY_ID', OCI_ACCESS_KEY);
      vi.stubEnv('OCI_SECRET_ACCESS_KEY', OCI_SECRET);
      vi.stubEnv('OCI_ENDPOINT', server.url);
      vi.stubEnv('STORAGE_SIGNING_SECRET', 'health-test-signing-secret-0001');
      vi.stubEnv('APP_URL', BASE_URL);
    });

    it('is healthy when a HEAD on the canary key reaches the bucket, even though the key does not exist', async () => {
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const res = await loaded.GET(healthRequest(key));
      expect(res.status).toBe(HTTP_OK);
      expect((await res.json()).components.storage).toMatchObject({ status: 'ok', driver: 'oci' });
      const methods = server.requests.map((r) => r.method);
      expect(methods).toEqual(['HEAD']);
    });

    it('answers 503 when the object store rejects the credentials', async () => {
      server.faults.push({ match: () => true, status: 403, code: 'AccessDenied', times: Infinity });
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const res = await loaded.GET(healthRequest(key));
      expect(res.status).toBe(HTTP_UNAVAILABLE);
      expect((await res.json()).components.storage).toMatchObject({ status: 'failed', reason: 'unreachable' });
    });

    it('answers 503 with reason timeout when the object store stalls past the probe deadline', async () => {
      const loaded = await loadHealth();
      server.faults.push({
        match: () => true,
        status: 200,
        times: Infinity,
        delayMs: loaded.probes.HEALTH_PROBE_TIMEOUT_MS + RESPONSE_SLACK_MS * 2,
      });
      const key = await adminKey(loaded, ['*']);
      const started = Date.now();
      const res = await loaded.GET(healthRequest(key));
      expect(Date.now() - started).toBeLessThan(loaded.probes.HEALTH_PROBE_TIMEOUT_MS + RESPONSE_SLACK_MS);
      expect(res.status).toBe(HTTP_UNAVAILABLE);
      expect((await res.json()).components.storage).toMatchObject({ status: 'failed', reason: 'timeout' });
    }, 15_000);

    it('answers 503 when the object store is gone', async () => {
      const gone = await startS3StubServer({ bucket: BUCKET, credentials: { [OCI_ACCESS_KEY]: OCI_SECRET } });
      vi.stubEnv('OCI_ENDPOINT', gone.url);
      await gone.close();
      const loaded = await loadHealth();
      const key = await adminKey(loaded, ['*']);
      const res = await loaded.GET(healthRequest(key));
      expect(res.status).toBe(HTTP_UNAVAILABLE);
      expect((await res.json()).components.storage).toMatchObject({ status: 'failed' });
    }, 15_000);
  });
});
