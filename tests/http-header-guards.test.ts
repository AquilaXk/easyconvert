import dns from 'node:dns';
import fs from 'node:fs';
import type { ReadStream } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Agent, Dispatcher } from 'undici';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { POST as fetchUrlPost } from '../src/app/api/fetch-url/route';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { graphScheduler } from '../src/lib/queue/graph';
import { exportArtifactToUrl } from '../src/lib/queue/graph/node-executor';
import { importUrlWithinBudget } from '../src/lib/queue/graph/node-url-import';
import { MAX_SEALED_HEADERS, MAX_SEALED_HEADER_NAME_CHARS, MAX_SEALED_HEADER_VALUE_CHARS, openUrlNodeSecrets } from '../src/lib/queue/graph/sealed-nodes';
import { sealJobSecret, SecretSealError } from '../src/lib/security/job-secret-seal';
import {
  assertSafeCustomHeaders,
  CUSTOM_HEADER_NAME_REGEX,
  CUSTOM_HEADER_VALUE_REGEX,
  FORBIDDEN_CUSTOM_HEADERS,
  FORBIDDEN_CUSTOM_HEADER_PREFIXES,
  InvalidCustomHeaderError,
  isForbiddenCustomHeader,
  sanitizeHeaderNameForReport,
} from '../src/lib/security/http-headers';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { createSessionToken } from '../src/lib/auth/session';
import { localFsStorage, storageProvider } from '../src/lib/storage';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { ConversionFailedError, type ConversionJobData, type ConversionJobResult } from '../src/lib/types';

const connection = vi.hoisted(() => ({ current: null as Dispatcher | null, dispatches: 0 }));
vi.mock('../src/lib/security/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/ssrf')>();
  const { Dispatcher: BaseDispatcher } = await import('undici');
  class ForwardingDispatcher extends BaseDispatcher {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      connection.dispatches++;
      if (!connection.current) {
        throw new Error('no outbound dispatch expected');
      }
      return connection.current.dispatch(opts, handler);
    }
    async close(): Promise<void> {}
    async destroy(): Promise<void> {}
  }
  return { ...actual, createSsrfSafeAgent: vi.fn(() => new ForwardingDispatcher()) };
});

const BASE_URL = 'https://easyconvert.app';
const PUBLIC_IP = '93.184.215.14';
const SECRET_HEADER_VALUE = 'sec-canary-9a7f3e1b4c8d205f';

const ALL_FORBIDDEN_HEADERS = [
  'Host',
  'Connection',
  'Content-Length',
  'Transfer-Encoding',
  'Keep-Alive',
  'TE',
  'Upgrade',
  'Trailer',
  'Proxy-Authorization',
  'Proxy-Authenticate',
  'Cookie',
  'Set-Cookie',
  'Origin',
  'Referer',
  'X-Real-IP',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'Sec-Fetch-Site',
  'Proxy-Custom',
] as const;

const INVALID_HEADER_NAMES = [
  ['Host ', 'headers.Host_'],
  [' x-ok ', 'headers._x-ok_'],
  ['Invalid Name', 'headers.Invalid_Name'],
  ['X-Bad:Colon', 'headers.X-Bad_Colon'],
  ['X-Bad\r\nName', 'headers.X-Bad__Name'],
  ['X-Bad\x00Name', 'headers.X-Bad_Name'],
  ['', 'headers.'],
] as const;

const INVALID_HEADER_VALUES = [
  `${SECRET_HEADER_VALUE}\r\nX-Injected: 1`,
  `${SECRET_HEADER_VALUE}\nX-Injected: 1`,
  `${SECRET_HEADER_VALUE}\rX-Injected: 1`,
  `${SECRET_HEADER_VALUE}\x00tail`,
  `${SECRET_HEADER_VALUE}\x1ftail`,
  `${SECRET_HEADER_VALUE}\x7ftail`,
  `${SECRET_HEADER_VALUE}\u0100tail`,
] as const;

describe('HTTP header security guards', () => {
  let user: User;
  let apiHeaders: Record<string, string>;
  let sessionHeaders: Record<string, string>;
  let storageKey: string;
  let initGraph: MockInstance<typeof graphScheduler.initGraph>;

  beforeEach(async () => {
    connection.current = null;
    connection.dispatches = 0;
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
    const email = `hdr_guard_${Date.now()}_${Math.random().toString(36).slice(2)}@guard.test`;
    user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'header-guard', tier: 'paid', emailVerified: true }));
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'guard', { scopes: ['convert:read', 'convert:write'] });
    apiHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    sessionHeaders = { Cookie: `easyconvert_session=${createSessionToken(user)}`, 'Content-Type': 'application/json' };
    storageKey = `uploads/${user.id}/guard.csv`;
    s3Storage.saveObject(storageKey, Buffer.from('a,b\n1,2\n'), 'text/csv', 'guard.csv');
    initGraph = vi.spyOn(graphScheduler, 'initGraph');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    connection.current = null;
  });

  describe('shared pure helper (src/lib/security/http-headers.ts)', () => {
    it('exports expected forbidden sets, RFC 9110 regexes, and sanitizer', () => {
      expect(FORBIDDEN_CUSTOM_HEADERS.size).toBe(15);
      expect(FORBIDDEN_CUSTOM_HEADER_PREFIXES).toEqual(['proxy-', 'sec-', 'x-forwarded-']);
      expect(CUSTOM_HEADER_NAME_REGEX.test('X-Api-Key')).toBe(true);
      expect(CUSTOM_HEADER_NAME_REGEX.test('Host ')).toBe(false);
      expect(CUSTOM_HEADER_VALUE_REGEX.test('Bearer tok\t1\xE9')).toBe(true);
      expect(CUSTOM_HEADER_VALUE_REGEX.test('a\r\nb')).toBe(false);

      for (const name of ALL_FORBIDDEN_HEADERS) {
        expect(isForbiddenCustomHeader(name)).toBe(true);
        expect(isForbiddenCustomHeader(`  ${name.toUpperCase()}  `)).toBe(true);
      }
      expect(isForbiddenCustomHeader('Content-Type')).toBe(false);
      expect(isForbiddenCustomHeader('Authorization')).toBe(false);
      expect(isForbiddenCustomHeader('X-Api-Key')).toBe(false);

      expect(sanitizeHeaderNameForReport('X-Evil\r\nHeader: 1')).toBe('X-Evil__Header__1');
      expect(sanitizeHeaderNameForReport('a'.repeat(80), 12)).toBe('a'.repeat(12));
    });

    it('throws InvalidCustomHeaderError without echoing secret values', () => {
      expect(() => assertSafeCustomHeaders(undefined)).not.toThrow();
      expect(() => assertSafeCustomHeaders({ Authorization: `Bearer ${SECRET_HEADER_VALUE}`, 'X-Note': 'ok\t\xE9' })).not.toThrow();

      for (const name of ALL_FORBIDDEN_HEADERS) {
        let caught: unknown;
        try {
          assertSafeCustomHeaders({ [name]: SECRET_HEADER_VALUE });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(InvalidCustomHeaderError);
        expect(caught).toBeInstanceOf(ConversionFailedError);
        expect((caught as Error).message).not.toContain(SECRET_HEADER_VALUE);
      }

      for (const value of INVALID_HEADER_VALUES) {
        let caught: unknown;
        try {
          assertSafeCustomHeaders({ 'X-Custom': value });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(InvalidCustomHeaderError);
        expect((caught as Error).message).not.toContain(SECRET_HEADER_VALUE);
      }
    });
  });

  describe('POST /api/v1/jobs graph, named tasks, and linear tasks', () => {
    async function postJobs(body: Record<string, unknown>) {
      const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(user.id));
      const res = await createJob(
        new NextRequest(`${BASE_URL}/api/v1/jobs`, {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify(body),
        })
      );
      const text = await res.text();
      const quotaAfter = JSON.stringify(await redisKeyStore.getQuotaUsage(user.id));
      return { status: res.status, text, json: JSON.parse(text), quotaUnchanged: quotaBefore === quotaAfter };
    }

    it.each(ALL_FORBIDDEN_HEADERS)('refuses %s on graph import.url and export.url without charging or creating a graph', async (headerName) => {
      const importRes = await postJobs({
        graph: {
          nodes: {
            in: { op: 'import.url', url: 'https://files.example.org/data.csv', headers: { [headerName]: SECRET_HEADER_VALUE } },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: { op: 'export.internal', input: 'conv' },
          },
        },
        filename: 'data.csv',
      });
      expect(importRes.status, importRes.text).toBe(400);
      expect(importRes.json.invalidParams).toEqual([
        { name: `graph.nodes.in.headers.${headerName}`, reason: 'header is not permitted' },
      ]);
      expect(importRes.text).not.toContain(SECRET_HEADER_VALUE);
      expect(importRes.quotaUnchanged).toBe(true);
      expect(initGraph).not.toHaveBeenCalled();

      const exportRes = await postJobs({
        graph: {
          nodes: {
            in: { op: 'import.upload', storageKey },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: { op: 'export.url', input: 'conv', url: 'https://files.example.org/out.json', method: 'PUT', headers: { [headerName]: SECRET_HEADER_VALUE } },
          },
        },
        storageKey,
        filename: 'guard.csv',
      });
      expect(exportRes.status, exportRes.text).toBe(400);
      expect(exportRes.json.invalidParams).toEqual([
        { name: `graph.nodes.out.headers.${headerName}`, reason: 'header is not permitted' },
      ]);
      expect(exportRes.text).not.toContain(SECRET_HEADER_VALUE);
      expect(exportRes.quotaUnchanged).toBe(true);
      expect(initGraph).not.toHaveBeenCalled();
    });

    it('refuses forbidden headers on named tasks and linear tasks', async () => {
      const namedImport = await postJobs({
        tasks: {
          in: { operation: 'import/url', url: 'https://files.example.org/data.csv', headers: { 'X-Forwarded-For': '127.0.0.1' } },
          conv: { operation: 'convert', input: 'in', output_format: 'json' },
          out: { operation: 'export/url', input: 'conv', url: 'https://files.example.org/out.json' },
        },
      });
      expect(namedImport.status, namedImport.text).toBe(400);
      expect(namedImport.json.invalidParams).toEqual([
        { name: 'graph.nodes.in.headers.X-Forwarded-For', reason: 'header is not permitted' },
      ]);

      const linearExport = await postJobs({
        tasks: [
          { name: 'conv', operation: 'convert', targetFormat: 'json' },
          { name: 'out', operation: 'export/url', url: 'https://files.example.org/out.json', headers: { Host: 'evil.example' } },
        ],
        storageKey,
        filename: 'guard.csv',
      });
      expect(linearExport.status, linearExport.text).toBe(400);
      expect(linearExport.json.invalidParams).toEqual([
        { name: 'tasks.1.headers.Host', reason: 'header is not permitted' },
      ]);
    });

    it.each(INVALID_HEADER_NAMES)('refuses invalid header name %j and sanitizes reported path', async (badName, expectedSubPath) => {
      const res = await postJobs({
        graph: {
          nodes: {
            in: { op: 'import.url', url: 'https://files.example.org/data.csv', headers: { [badName]: SECRET_HEADER_VALUE } },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: { op: 'export.internal', input: 'conv' },
          },
        },
        filename: 'data.csv',
      });
      expect(res.status, res.text).toBe(400);
      expect(res.json.invalidParams).toEqual([
        { name: `graph.nodes.in.${expectedSubPath}`, reason: 'invalid header name' },
      ]);
      expect(res.text).not.toContain(SECRET_HEADER_VALUE);
      expect(res.text).not.toMatch(/[\r\n\x00]/);
    });

    it.each(INVALID_HEADER_VALUES)('refuses CRLF/NUL/CTL header values without echoing secrets', async (badValue) => {
      const res = await postJobs({
        graph: {
          nodes: {
            in: { op: 'import.upload', storageKey },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: { op: 'export.url', input: 'conv', url: 'https://files.example.org/out.json', headers: { 'X-Custom': badValue } },
          },
        },
        storageKey,
        filename: 'guard.csv',
      });
      expect(res.status, res.text).toBe(400);
      expect(res.json.invalidParams).toEqual([
        { name: 'graph.nodes.out.headers.X-Custom', reason: 'invalid header value' },
      ]);
      expect(res.text).not.toContain(SECRET_HEADER_VALUE);
    });

    it('rejects header names exceeding 256 characters', async () => {
      const longName = 'x'.repeat(MAX_SEALED_HEADER_NAME_CHARS + 1);
      const res = await postJobs({
        graph: {
          nodes: {
            in: { op: 'import.url', url: 'https://files.example.org/data.csv', headers: { [longName]: 'v' } },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: { op: 'export.internal', input: 'conv' },
          },
        },
        filename: 'data.csv',
      });
      expect(res.status, res.text).toBe(400);
      expect(res.json.invalidParams[0].reason).toContain(`longer than ${MAX_SEALED_HEADER_NAME_CHARS}`);
    });

    it('accepts Content-Type on export.url at submission', async () => {
      const res = await postJobs({
        graph: {
          nodes: {
            in: { op: 'import.upload', storageKey },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: {
              op: 'export.url',
              input: 'conv',
              url: 'https://files.example.org/out.json',
              method: 'PUT',
              headers: { 'Content-Type': 'application/custom-ignored', 'X-Api-Key': 'k-ok' },
            },
          },
        },
        storageKey,
        filename: 'guard.csv',
      });
      expect(res.status, res.text).toBe(202);
      await graphScheduler.cancelGraph(res.json.jobId, 'test cleanup');
    });
  });

  describe('worker sealing and runtime egress guards', () => {
    it('refuses sealed payloads containing forbidden or injected headers in openUrlNodeSecrets', () => {
      const jobId = 'g1:in';
      for (const badHeaders of [
        { Host: 'evil.example' },
        { 'X-Forwarded-For': '127.0.0.1' },
        { 'Host ': 'evil.example' },
        { 'X-Test': 'a\r\nb' },
        { 'X-Test': 123 },
        Object.fromEntries(Array.from({ length: MAX_SEALED_HEADERS + 1 }, (_, i) => [`X-H-${i}`, 'v'])),
      ]) {
        const sealed = sealJobSecret(JSON.stringify({ url: 'https://files.example.org/in.csv', headers: badHeaders }), jobId);
        let caught: unknown;
        try {
          openUrlNodeSecrets({ op: 'import.url', sealed }, jobId);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SecretSealError);
        expect((caught as SecretSealError).code).toBe('MALFORMED_BLOB');
      }
    });

    it('importUrlWithinBudget refuses forbidden or injected headers before any network dispatch', async () => {
      const job = {
        id: 'g-imp:in',
        data: {
          jobId: 'g-imp:in',
          graphId: 'g-imp',
          graphNodeId: 'in',
          userId: user.id,
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

      await expect(
        importUrlWithinBudget(job, storageProvider, 'https://files.example.org/in.csv', { Cookie: SECRET_HEADER_VALUE })
      ).rejects.toThrow(InvalidCustomHeaderError);
      await expect(
        importUrlWithinBudget(job, storageProvider, 'https://files.example.org/in.csv', { 'X-Bad': `${SECRET_HEADER_VALUE}\r\n` })
      ).rejects.toThrow(InvalidCustomHeaderError);
      expect(connection.dispatches).toBe(0);
    });

    it('exportArtifactToUrl refuses forbidden or injected headers before opening source FD or dispatching', async () => {
      const sourceKeyLocal = `intermediate/hdr-export/${Date.now()}-${Math.random().toString(36).slice(2)}/0/payload.txt`;
      await storageProvider.saveObject(sourceKeyLocal, Buffer.from('payload'), 'text/plain', 'payload.txt');
      const sourcePath = localFsStorage.getPathsForKey(sourceKeyLocal).binPath;
      const opened: ReadStream[] = [];
      const realCreateReadStream = fs.createReadStream;
      vi.spyOn(fs, 'createReadStream').mockImplementation(((...args: Parameters<typeof fs.createReadStream>) => {
        const stream = realCreateReadStream(...args);
        if (String(args[0]) === sourcePath) opened.push(stream);
        return stream;
      }) as typeof fs.createReadStream);

      try {
        const err = await exportArtifactToUrl(
          storageProvider,
          sourceKeyLocal,
          'https://files.example.org/out.txt',
          'PUT',
          { 'Proxy-Authorization': SECRET_HEADER_VALUE },
          new AbortController().signal
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidCustomHeaderError);
        expect((err as Error).message).not.toContain(SECRET_HEADER_VALUE);
        expect(opened).toHaveLength(0);
        expect(connection.dispatches).toBe(0);
      } finally {
        await storageProvider.deleteObject(sourceKeyLocal);
      }
    });

    it('exportArtifactToUrl allows Content-Type from caller input and strips framing headers on egress', async () => {
      const sourceKeyLocal = `intermediate/hdr-egress/${Date.now()}-${Math.random().toString(36).slice(2)}/0/payload.txt`;
      const payload = Buffer.from('hello-export');
      await storageProvider.saveObject(sourceKeyLocal, payload, 'text/plain', 'payload.txt');

      let capturedHeaders: http.IncomingHttpHeaders | undefined;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          capturedHeaders = req.headers;
          res.writeHead(200).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      connection.current = new Agent({
        connect: ((_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => cb(null, socket));
          socket.once('error', (err) => cb(err));
        }) as never,
      });

      try {
        await exportArtifactToUrl(
          storageProvider,
          sourceKeyLocal,
          'https://files.example.org/out.txt',
          'PUT',
          { 'Content-Type': 'application/custom-ignored', 'X-Api-Key': 'k-secret' },
          new AbortController().signal
        );
        expect(capturedHeaders?.['content-type']).toBe('text/plain');
        expect(capturedHeaders?.['content-length']).toBe(String(payload.length));
        expect(capturedHeaders?.['x-api-key']).toBe('k-secret');
      } finally {
        await connection.current.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await storageProvider.deleteObject(sourceKeyLocal);
      }
    });
  });

  describe('POST /api/v1/storage/credentials (http credentials)', () => {
    const INVALID_ENDPOINT_TYPE = 'https://convert.aquilaxk.site/api-docs/errors#byos-invalid-endpoint';

    async function postCreds(credentials: Record<string, unknown>) {
      const res = await credentialsPost(
        new NextRequest(`${BASE_URL}/api/v1/storage/credentials`, {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify({ providerType: 'http', credentials: { type: 'http', ...credentials } }),
        })
      );
      const text = await res.text();
      return { status: res.status, text, json: JSON.parse(text) };
    }

    it.each(ALL_FORBIDDEN_HEADERS)('refuses forbidden header %s in http credentials with 400', async (headerName) => {
      const res = await postCreds({ url: 'https://files.example.org/out', headers: { [headerName]: SECRET_HEADER_VALUE } });
      expect(res.status, res.text).toBe(400);
      expect(res.json.type).toBe(INVALID_ENDPOINT_TYPE);
      expect(res.text).not.toContain(SECRET_HEADER_VALUE);
    });

    it('refuses invalid header names, CRLF/CTL values, oversized maps, and malformed bearerToken', async () => {
      for (const [badName] of INVALID_HEADER_NAMES) {
        const res = await postCreds({ headers: { [badName]: SECRET_HEADER_VALUE } });
        expect(res.status, res.text).toBe(400);
        expect(res.json.type).toBe(INVALID_ENDPOINT_TYPE);
        expect(res.text).not.toContain(SECRET_HEADER_VALUE);
      }
      for (const badVal of INVALID_HEADER_VALUES) {
        const res = await postCreds({ headers: { 'X-Api-Key': badVal } });
        expect(res.status, res.text).toBe(400);
        expect(res.json.type).toBe(INVALID_ENDPOINT_TYPE);
        expect(res.text).not.toContain(SECRET_HEADER_VALUE);
      }
      const tooMany = Object.fromEntries(Array.from({ length: MAX_SEALED_HEADERS + 1 }, (_, i) => [`X-H-${i}`, 'v']));
      const tooManyRes = await postCreds({ headers: tooMany });
      expect(tooManyRes.status).toBe(400);
      expect(tooManyRes.json.type).toBe(INVALID_ENDPOINT_TYPE);

      const nonObjRes = await postCreds({ headers: ['not-an-object'] as unknown as Record<string, string> });
      expect(nonObjRes.status).toBe(400);
      expect(nonObjRes.json.type).toBe(INVALID_ENDPOINT_TYPE);

      for (const badToken of ['', '   ', `${SECRET_HEADER_VALUE}\r\nX-Evil: 1`, `${SECRET_HEADER_VALUE}\x00`, 't'.repeat(MAX_SEALED_HEADER_VALUE_CHARS + 1)]) {
        const res = await postCreds({ bearerToken: badToken });
        expect(res.status, res.text).toBe(400);
        expect(res.json.type).toBe(INVALID_ENDPOINT_TYPE);
        expect(res.text).not.toContain(SECRET_HEADER_VALUE);
      }

      const loopbackRes = await postCreds({ url: 'http://127.0.0.1/out' });
      expect(loopbackRes.status).toBe(400);
      expect(loopbackRes.json.type).toBe(INVALID_ENDPOINT_TYPE);

      const plainTlsRes = await postCreds({ url: 'http://files.example.org/out', bearerToken: SECRET_HEADER_VALUE });
      expect(plainTlsRes.status).toBe(400);
      expect(plainTlsRes.json.type).toBe(INVALID_ENDPOINT_TYPE);

      const emptyUrlRes = await postCreds({ url: '' });
      expect(emptyUrlRes.status).toBe(400);
      expect(emptyUrlRes.json.type).toBe(INVALID_ENDPOINT_TYPE);

      vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
      const dnsBlockedRes = await postCreds({ url: 'https://internal-rebind.example.org/out' });
      expect(dnsBlockedRes.status).toBe(400);
      expect(dnsBlockedRes.json.type).toBe(INVALID_ENDPOINT_TYPE);
    });

    it('accepts valid http credentials with 201', async () => {
      const res = await postCreds({
        url: 'https://files.example.org/out',
        bearerToken: 'bt-valid-token',
        headers: { 'X-Api-Key': 'k-valid', 'Content-Type': 'application/octet-stream' },
      });
      expect(res.status, res.text).toBe(201);
      expect(res.json.credentialRef).toMatch(/^cred_[a-f0-9]{32}$/);
    });
  });

  describe('POST /api/fetch-url header validation', () => {
    it.each(ALL_FORBIDDEN_HEADERS)('refuses forbidden header %s with 400 invalid_headers', async (headerName) => {
      const res = await fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: sessionHeaders,
          body: JSON.stringify({ url: 'https://example.com/file.pdf', headers: { [headerName]: SECRET_HEADER_VALUE } }),
        })
      );
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.code).toBe('invalid_headers');
      expect(data.error).toContain('is not permitted');
    });

    it.each(INVALID_HEADER_VALUES)('refuses CRLF/NUL/CTL header value with 400 invalid_headers', async (badValue) => {
      const res = await fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: sessionHeaders,
          body: JSON.stringify({ url: 'https://example.com/file.pdf', headers: { 'X-Api-Key': badValue } }),
        })
      );
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.code).toBe('invalid_headers');
      expect(JSON.stringify(data)).not.toContain(SECRET_HEADER_VALUE);
    });

    it('refuses header names over 64 chars and values over 2048 chars with 400 invalid_headers', async () => {
      const longNameRes = await fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: sessionHeaders,
          body: JSON.stringify({ url: 'https://example.com/file.pdf', headers: { ['x'.repeat(65)]: 'ok' } }),
        })
      );
      expect(longNameRes.status).toBe(400);
      expect((await longNameRes.json()).code).toBe('invalid_headers');

      const longValRes = await fetchUrlPost(
        new NextRequest(`${BASE_URL}/api/fetch-url`, {
          method: 'POST',
          headers: sessionHeaders,
          body: JSON.stringify({ url: 'https://example.com/file.pdf', headers: { 'X-Api-Key': 'v'.repeat(2049) } }),
        })
      );
      expect(longValRes.status).toBe(400);
      expect((await longValRes.json()).code).toBe('invalid_headers');
    });
  });
});
