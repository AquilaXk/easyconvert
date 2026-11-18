import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

const { undiciOverrideRef, ssrfOverrideRef } = vi.hoisted(() => ({
  undiciOverrideRef: { current: undefined as undefined | ((input: unknown, init?: unknown) => Promise<Response>) },
  ssrfOverrideRef: { current: undefined as undefined | ((url: URL) => Promise<boolean>) },
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((input: unknown, init?: unknown) =>
      undiciOverrideRef.current
        ? undiciOverrideRef.current(input, init)
        : actual.fetch(input as never, init as never)) as typeof actual.fetch,
  };
});

vi.mock('../src/lib/security/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/ssrf')>();
  return {
    ...actual,
    validateUrlForSsrf: (url: URL) =>
      ssrfOverrideRef.current ? ssrfOverrideRef.current(url) : actual.validateUrlForSsrf(url),
  };
});

import { DEFAULT_BASE_URL, EasyConvertClient } from '../sdk/typescript/src/client';
import { POST as directUploadPost } from '../src/app/api/v1/uploads/direct/route';
import { PUT as directPartPut } from '../src/app/api/v1/uploads/direct/part/route';
import { POST as directCompletePost } from '../src/app/api/v1/uploads/direct/complete/route';
import { POST as tusPost, PATCH as tusPatch } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as archivesInspectPost } from '../src/app/api/v1/archives/inspect/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as webConvertPost } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as fetchUrlPost } from '../src/app/api/fetch-url/route';
import { POST as bundlePost } from '../src/app/api/storage/bundle/route';
import { POST as splitToolPost } from '../src/app/api/tools/split/route';
import { WebhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import * as enqueueMod from '../src/lib/queue/enqueue';
import * as waitForJobMod from '../src/lib/queue/wait-for-job';
import { conversionQueue, cancelJobAcrossQueues } from '../src/lib/queue/conversion-queue';
import { DistributedBullMQAdapter, Queue, type Job } from '../src/lib/queue/bullmq-engine';
import { SYNC_SLOT_LEASE_MS, acquireSyncSlot } from '../src/lib/queue/concurrency-limit';
import * as concurrencyLimitMod from '../src/lib/queue/concurrency-limit';
import { currentJobDeadlineSettings } from '../src/lib/queue/job-deadline';
import { recordJobCompleted, recordJobFailed } from '../src/lib/metrics/recorders';
import { instruments } from '../src/lib/metrics/instruments';
import {
  InMemoryIdempotencyStore,
  COMPLETE_IDEMPOTENCY_LUA_SCRIPT,
  buildScopedKey,
} from '../src/lib/api/idempotency';
import { acquireIdempotency, respondOnce } from '../src/lib/api/with-idempotency';
import * as multipartBodyMod from '../src/lib/api/multipart-body';
import { storageProvider } from '../src/lib/storage';
import { StorageServiceError } from '../src/lib/storage/adapters/adapter-interface';
import * as retentionMod from '../src/lib/storage/retention-service';
import {
  TusEngine,
  RedisTusSessionStore,
  parseTusMetadata,
  setTusSessionStore,
  tusEngine,
} from '../src/lib/storage/tus-engine';
import { SubscriptionStore } from '../src/lib/billing/subscription-store';
import * as guardMod from '../src/lib/api-keys/guard';

let paidUser: Awaited<ReturnType<typeof userStore.createUser>>;
let paidApiKey: string;
let paidSessionCookie: string;

beforeAll(async () => {
  const created = userStore.sanitizeUser(
    await userStore.createUser({
      email: `sdk_b2b_adv_${Date.now()}@test.io`,
      name: 'SDK B2B Adversarial User',
      tier: 'paid',
      emailVerified: true,
    })
  );
  paidUser = created;
  const generated = await redisKeyStore.generateApiKey(created.id, 'sdk-b2b-adv-key', {
    scopes: ['*'],
  });
  paidApiKey = generated.secretKey;
  paidSessionCookie = `easyconvert_session=${createSessionToken(created)}`;
});

afterEach(() => {
  undiciOverrideRef.current = undefined;
  ssrfOverrideRef.current = undefined;
  setTusSessionStore(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createRouteFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = rawUrl.startsWith('http') ? new URL(rawUrl) : new URL(rawUrl, 'http://localhost');
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const reqInit: ConstructorParameters<typeof NextRequest>[1] = {
      method,
      headers,
      body: init?.body as BodyInit | undefined,
    };
    const nextReq = new NextRequest(url.toString(), reqInit);

    if (url.pathname === '/api/v1/uploads/direct' && method === 'POST') {
      return directUploadPost(nextReq);
    }
    if (url.pathname === '/api/v1/uploads/direct/part' && method === 'PUT') {
      return directPartPut(nextReq);
    }
    if (url.pathname === '/api/v1/uploads/direct/complete' && method === 'POST') {
      return directCompletePost(nextReq);
    }
    if (url.pathname === '/api/v1/uploads' && method === 'POST') {
      return tusPost(nextReq, { params: Promise.resolve({ id: [] }) });
    }
    if (url.pathname.startsWith('/api/v1/uploads/') && method === 'PATCH') {
      const id = url.pathname.slice('/api/v1/uploads/'.length);
      return tusPatch(nextReq, { params: Promise.resolve({ id: [id] }) });
    }
    if (url.pathname === '/api/v1/archives/inspect' && method === 'POST') {
      return archivesInspectPost(nextReq);
    }
    return new Response(JSON.stringify({ error: `Unrouted ${method} ${url.pathname}` }), { status: 404 });
  }) as typeof fetch;
}

describe('P0-2: Official TypeScript & Python SDKs + Hygiene', () => {
  it('uses convert.aquilaxk.site as DEFAULT_BASE_URL in TS SDK and removes scratch paths in generator-requirements.txt', () => {
    expect(DEFAULT_BASE_URL).toBe('https://convert.aquilaxk.site');
    const reqTxt = fs.readFileSync(
      path.resolve(__dirname, '..', 'sdk', 'python', 'generator-requirements.txt'),
      'utf-8'
    );
    expect(reqTxt).not.toContain('/private/tmp/');
    expect(reqTxt).not.toMatch(/# via -r /i);
  });

  it('completes real route-handler round-trips for uploadMultipart, uploadTus (Korean UTF-8 filename), and inspectArchive', async () => {
    const client = new EasyConvertClient({
      apiKey: paidApiKey,
      baseUrl: 'http://localhost',
      fetch: createRouteFetch(),
    });

    // 1. Direct multipart against real Next.js route handlers
    const mpPayload = new Uint8Array(64);
    for (let i = 0; i < mpPayload.length; i++) mpPayload[i] = 65 + (i % 26);
    const mpFile = new Blob([mpPayload], { type: 'text/plain' });
    const mpResult = await client.uploadMultipart(mpFile, { filename: 'direct-roundtrip.txt', mimeType: 'text/plain' });
    expect(mpResult.uploadId.length).toBeGreaterThan(0);
    expect(mpResult.storageKey).toContain(paidUser.id);
    const storedMp = await storageProvider.getObject(mpResult.storageKey);
    expect(storedMp).not.toBeNull();
    expect(Buffer.from(storedMp!.buffer)).toEqual(Buffer.from(mpPayload));

    // 2. TUS upload against real route handlers with Korean UTF-8 filename
    const koreanName = '계약서.pdf';
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([200, 200]);
    const pdfBytes = await pdfDoc.save();
    const tusFile = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    const tusResult = await client.uploadTus(tusFile, {
      filename: koreanName,
      mimeType: 'application/pdf',
      chunkSize: Math.max(128, Math.ceil(pdfBytes.byteLength / 2)),
    });
    expect(tusResult.uploadId.length).toBeGreaterThan(0);
    expect(tusResult.storageKey).toContain(paidUser.id);
    const storedTus = await storageProvider.getObject(tusResult.storageKey!);
    expect(storedTus).not.toBeNull();
    expect(storedTus!.filename).toBe(koreanName);

    // 3. inspectArchive against real POST /api/v1/archives/inspect
    const zip = new JSZip();
    zip.file('hello.txt', 'archive roundtrip ok');
    const zipBytes = await zip.generateAsync({ type: 'uint8array' });
    const inspected = await client.inspectArchive({
      file: new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
    });
    expect(inspected.format).toBe('zip');
    expect(Array.isArray(inspected.entries)).toBe(true);
    expect((inspected.entries as Array<{ path?: string; name?: string }>).some((e) => (e.path || e.name) === 'hello.txt')).toBe(true);
  });

  it('supports downloadStream, Idempotency-Key forwarding, all credential providers, and Standard Webhooks v1,<base64> rotated verification', async () => {
    const calls: Array<{ url: string; headers: Headers; method: string; body: unknown }> = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      calls.push({ url, headers, method, body: init?.body });

      if (url.endsWith('/api/v1/storage/credentials')) {
        return new Response(JSON.stringify({ credentialRef: 'cred_r2_1', providerType: 'r2' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/download-stream-test')) {
        return new Response('streamed-ok-bytes', { status: 200 });
      }
      if (url.endsWith('/api/v1/jobs')) {
        return new Response(JSON.stringify({ jobId: 'j_idem_1', statusUrl: '/api/v1/jobs/j_idem_1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/convert')) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const client = new EasyConvertClient({ apiKey: paidApiKey, baseUrl: 'https://convert.aquilaxk.site', fetch: mockFetch });

    // credential provider union
    for (const providerType of ['s3', 'r2', 'gcs', 'azure-blob', 'webdav', 'sftp'] as const) {
      const cred = await client.createCredential({ providerType, credentials: { token: 'abc' } });
      expect(cred.credentialRef).toBe('cred_r2_1');
    }

    // Idempotency-Key forwarding on convert, createJob, createGraphJob
    await client.convert({ file: new Blob(['hi']), targetFormat: 'pdf', idempotencyKey: 'idem-convert-1' });
    await client.createJob({ file: new Blob(['hi']), targetFormat: 'pdf', idempotencyKey: 'idem-job-1' });
    await client.createGraphJob({ graph: { nodes: { n1: { op: 'convert', targetFormat: 'pdf' } } }, idempotencyKey: 'idem-graph-1' });
    expect(calls.find((c) => c.url.endsWith('/api/v1/convert'))?.headers.get('Idempotency-Key')).toBe('idem-convert-1');
    const jobCalls = calls.filter((c) => c.url.endsWith('/api/v1/jobs'));
    expect(jobCalls.map((c) => c.headers.get('Idempotency-Key'))).toEqual(['idem-job-1', 'idem-graph-1']);

    // downloadStream
    const stream = await client.downloadStream('/download-stream-test');
    const downloadedText = await new Response(stream).text();
    expect(downloadedText).toBe('streamed-ok-bytes');

    // Standard Webhooks rotated v1,<base64> matching WebhookDispatcher.signStandardPayload
    const secret = 'wh_sec_standard_rotation_123';
    const deliveryId = 'wh_msg_abc987';
    const ts = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: deliveryId, event: 'job.completed' });
    const sigNew = WebhookDispatcher.signStandardPayload(deliveryId, ts, payload, secret);
    const sigOld = WebhookDispatcher.signStandardPayload(deliveryId, ts, payload, 'old_secret_prev');
    const rotatedHeader = `${sigOld} ${sigNew}`;

    expect(
      await EasyConvertClient.verifyWebhookSignature(payload, rotatedHeader, ts, secret, { deliveryId })
    ).toBe(true);
    expect(
      await EasyConvertClient.verifyWebhookSignature(payload, rotatedHeader, ts, 'wrong_secret', { deliveryId })
    ).toBe(false);
    expect(
      await EasyConvertClient.verifyWebhookSignature(payload, rotatedHeader, ts, secret, { deliveryId: 'wrong_id' })
    ).toBe(false);
  });

  it('verifies Python SDK DEFAULT_BASE_URL, chunked BinaryIO streaming in upload_tus & upload_multipart, UTF-8 Korean filename, archives/inspect, download_stream, idempotency_key, and Standard Webhooks verification', () => {
    const venvPython = path.resolve(__dirname, '../node_modules/.cache/easyconvert-sdk-python-generator/bin/python');
    expect(fs.existsSync(venvPython)).toBe(true);

    const deliveryId = 'wh_py_delivery_1';
    const ts = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: deliveryId, event: 'conversion.completed' });
    const secret = 'py_wh_secret_123';
    const stdSig = WebhookDispatcher.signStandardPayload(deliveryId, ts, payload, secret);
    const rotatedStdSig = `v1,aW52YWxpZA== ${stdSig}`;
    const legacyHex = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');

    const pyScript = [
      'import base64, io, json, sys, urllib.parse',
      `sys.path.insert(0, ${JSON.stringify(path.resolve(__dirname, '../sdk/python'))})`,
      'import httpx2',
      'from easyconvert.client import DEFAULT_BASE_URL, EasyConvertClient',
      'assert DEFAULT_BASE_URL == "https://convert.aquilaxk.site", f"unexpected base url: {DEFAULT_BASE_URL}"',
      '',
      'class ChunkOnlyStream(io.RawIOBase):',
      '    def __init__(self, data: bytes):',
      '        self._data = data',
      '        self._pos = 0',
      '        self.read_sizes = []',
      '    def readable(self): return True',
      '    def seekable(self): return True',
      '    def seek(self, offset, whence=io.SEEK_SET):',
      '        if whence == io.SEEK_END: self._pos = len(self._data) + offset',
      '        elif whence == io.SEEK_CUR: self._pos += offset',
      '        else: self._pos = offset',
      '        return self._pos',
      '    def tell(self): return self._pos',
      '    def read(self, size=-1):',
      '        if size is None or size < 0:',
      '            raise AssertionError("unbounded read() called instead of chunked read(size)")',
      '        self.read_sizes.append(size)',
      '        chunk = self._data[self._pos:self._pos + size]',
      '        self._pos += len(chunk)',
      '        return chunk',
      '',
      'seen_paths = []',
      'seen_headers = []',
      'def handler(request: httpx2.Request) -> httpx2.Response:',
      '    seen_paths.append((request.method, request.url.path))',
      '    seen_headers.append(dict(request.headers))',
      '    if request.method == "POST" and request.url.path == "/api/v1/uploads":',
      '        meta = request.headers.get("upload-metadata", "")',
      '        parts = dict(item.split(" ", 1) for item in meta.split(",") if " " in item)',
      '        assert base64.b64decode(parts["filename"]).decode("utf-8") == "계약서.pdf"',
      '        return httpx2.Response(201, headers={"Location": "/api/v1/uploads/tus_py_1", "Tus-Resumable": "1.0.0"})',
      '    if request.method == "PATCH" and request.url.path == "/api/v1/uploads/tus_py_1":',
      '        off = int(request.headers["upload-offset"]) + len(request.content)',
      '        hdrs = {"Tus-Resumable": "1.0.0", "Upload-Offset": str(off)}',
      '        if off == 11:',
      '            hdrs["EasyConvert-Storage-Key"] = "uploads/tus_py_1/document.pdf"',
      '        return httpx2.Response(204, headers=hdrs)',
      '    if request.method == "POST" and request.url.path == "/api/v1/uploads/direct":',
      '        return httpx2.Response(200, json={',
      '            "uploadId": "mp_py_1",',
      '            "key": "uploads/mp_py_1/big.bin",',
      '            "partSize": 5,',
      '            "parts": [',
      '                {"partNumber": 1, "uploadUrl": "/api/v1/uploads/direct/part?partNumber=1", "expiresAt": 9999999999},',
      '                {"partNumber": 2, "uploadUrl": "/api/v1/uploads/direct/part?partNumber=2", "expiresAt": 9999999999},',
      '            ],',
      '        })',
      '    if request.method == "PUT" and request.url.path == "/api/v1/uploads/direct/part":',
      '        return httpx2.Response(200, headers={"ETag": f"\\"etag-{len(request.content)}\\""})',
      '    if request.method == "POST" and request.url.path == "/api/v1/uploads/direct/complete":',
      '        return httpx2.Response(200, json={"key": "uploads/mp_py_1/big.bin"})',
      '    if request.method == "POST" and request.url.path == "/api/v1/archives/inspect":',
      '        return httpx2.Response(200, json={"format": "zip", "entries": []})',
      '    if request.method == "GET" and request.url.path == "/stream-dl":',
      '        return httpx2.Response(200, content=b"hello-stream-py")',
      '    if request.method == "POST" and request.url.path in ("/api/v1/convert", "/api/v1/jobs"):',
      '        return httpx2.Response(202 if request.url.path.endswith("/jobs") else 200, json={"jobId": "j1", "statusUrl": "/api/v1/jobs/j1"})',
      '    return httpx2.Response(404)',
      '',
      'client = EasyConvertClient("ec_live_test", base_url="https://convert.aquilaxk.site")',
      'client.generated.set_httpx_client(httpx2.Client(base_url="https://convert.aquilaxk.site", transport=httpx2.MockTransport(handler), headers={"Authorization": "Bearer ec_live_test"}))',
      'tus_stream = ChunkOnlyStream(b"0123456789!")',
      'tus_res = client.upload_tus(tus_stream, filename="계약서.pdf", chunk_size=5)',
      'assert tus_res["storageKey"] == "uploads/tus_py_1/document.pdf"',
      'assert tus_stream.read_sizes == [5, 5, 1] and all(0 < s <= 5 for s in tus_stream.read_sizes)',
      '',
      '# Monkeypatch httpx2.Client inside module temporarily OR use transport for presigned relative uploadUrl via custom Client subclass check',
      'orig_client_cls = httpx2.Client',
      'class PatchedPresignClient(orig_client_cls):',
      '    def __init__(self, *args, **kwargs):',
      '        kwargs.setdefault("transport", httpx2.MockTransport(handler))',
      '        super().__init__(*args, **kwargs)',
      'httpx2.Client = PatchedPresignClient',
      'orig_put = httpx2.put',
      'def patched_put(url, *args, **kwargs):',
      '    with PatchedPresignClient() as c:',
      '        return c.put(url, *args, **kwargs)',
      'httpx2.put = patched_put',
      'try:',
      '    mp_stream = ChunkOnlyStream(b"123456789")',
      '    mp_res = client.upload_multipart(mp_stream, filename="big.bin")',
      '    assert mp_res["storageKey"] == "uploads/mp_py_1/big.bin"',
      '    assert mp_stream.read_sizes == [5, 4] and all(0 < s <= 5 for s in mp_stream.read_sizes)',
      'finally:',
      '    httpx2.Client = orig_client_cls',
      '    httpx2.put = orig_put',
      '',
      'arc = client.inspect_archive(storage_key="uploads/123/a.zip")',
      'assert arc["format"] == "zip"',
      'assert any(p == ("POST", "/api/v1/archives/inspect") for p in seen_paths)',
      'dl_chunks = list(client.download_stream("/stream-dl", chunk_size=4))',
      'assert b"".join(dl_chunks) == b"hello-stream-py"',
      '',
      'client.create_job(source_url="https://example.com/a.txt", target_format="pdf", idempotency_key="py-idem-job")',
      'client.create_graph_job({"nodes": {}}, idempotency_key="py-idem-graph")',
      'client.convert(b"hello", target_format="pdf", filename="a.txt", idempotency_key="py-idem-conv")',
      'idem_vals = [h.get("idempotency-key") for h in seen_headers if "idempotency-key" in h]',
      'assert idem_vals == ["py-idem-job", "py-idem-graph", "py-idem-conv"], f"got {idem_vals}"',
      '',
      `assert EasyConvertClient.verify_webhook_signature(${JSON.stringify(payload)}, ${JSON.stringify(rotatedStdSig)}, ${ts}, ${JSON.stringify(secret)}, delivery_id=${JSON.stringify(deliveryId)}) is True`,
      `assert EasyConvertClient.verify_webhook_signature(${JSON.stringify(payload)}, ${JSON.stringify(rotatedStdSig)}, ${ts}, "wrong", delivery_id=${JSON.stringify(deliveryId)}) is False`,
      `assert EasyConvertClient.verify_webhook_signature(${JSON.stringify(payload)}, "sha256=" + ${JSON.stringify(legacyHex)}, ${ts}, ${JSON.stringify(secret)}) is True`,
    ].join('\n');

    execFileSync(venvPython, ['-c', pyScript], { stdio: 'pipe' });
  });
});

describe('P0-1: Inbound originalFilename Sanitization', () => {
  it('strips directory traversal segments on POST /api/v1/jobs (multipart and JSON)', async () => {
    // Multipart
    const form = new FormData();
    form.append('file', new File(['hello world'], '../../etc/passwd.txt', { type: 'text/plain' }));
    form.append('targetFormat', 'pdf');
    const mpReq = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paidApiKey}` },
      body: form,
    });
    const mpRes = await v1JobsPost(mpReq);
    expect(mpRes.status).toBe(202);
    const mpJson = (await mpRes.json()) as { jobId: string };
    const mpJob = await conversionQueue.getJob(mpJson.jobId);

    // JSON storageKey + traversal filename
    const uploadKey = `uploads/${paidUser.id}/safe_source.txt`;
    await storageProvider.saveObject(uploadKey, Buffer.from('hello world'), 'text/plain', 'safe_source.txt');
    const jsonReq = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paidApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageKey: uploadKey, targetFormat: 'pdf', filename: '..\\..\\secret\\evil.txt' }),
    });
    const jsonRes = await v1JobsPost(jsonReq);
    expect(jsonRes.status).toBe(202);
    const jsonBody = (await jsonRes.json()) as { jobId: string };
    const jsonJob = await conversionQueue.getJob(jsonBody.jobId);

    const enqueuedNames = [mpJob?.data.originalFilename ?? '', jsonJob?.data.originalFilename ?? ''];
    expect(enqueuedNames).toEqual(['passwd.txt', 'evil.txt']);
    for (const name of enqueuedNames) {
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
    }
  });

  it('strips directory traversal segments before dispatch on POST /api/convert and POST /api/v1/convert', async () => {
    const dispatchedNames: string[] = [];
    vi.spyOn(waitForJobMod, 'dispatchSyncRouteConversion').mockImplementation(async (params) => {
      dispatchedNames.push(params.originalFilename);
      return {
        buffer: Buffer.from('%PDF-1.4\n%%EOF'),
        mimeType: 'application/pdf',
        filename: 'out.pdf',
        size: 14,
        engineUsed: 'internal-fallback',
        executionTimeMs: 5,
      };
    });

    for (const [routeFn, url, extraHeaders] of [
      [webConvertPost, 'http://localhost/api/convert', { Cookie: paidSessionCookie }],
      [v1ConvertPost, 'http://localhost/api/v1/convert', { Authorization: `Bearer ${paidApiKey}` }],
    ] as const) {
      const form = new FormData();
      form.append('file', new File(['hello world'], '../../../var/log/report.txt', { type: 'text/plain' }));
      form.append('targetFormat', 'pdf');
      const req = new NextRequest(url, {
        method: 'POST',
        headers: { ...extraHeaders, Accept: 'application/json' },
        body: form,
      });
      const res = await routeFn(req);
      expect(res.status).toBe(200);
    }

    expect(dispatchedNames).toEqual(['report.txt', 'report.txt']);
  });
});

describe('P1-3: /api/fetch-url Cross-Origin Redirect Header Stripping', () => {
  it('strips ALL custom headers (x-api-key, x-amz-security-token, etc.) on cross-origin redirects', async () => {
    ssrfOverrideRef.current = async () => true;
    const forwardedHeaders: Array<{ url: string; headers: Record<string, string> }> = [];

    undiciOverrideRef.current = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      const rawHeaders = ((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      forwardedHeaders.push({ url, headers: { ...rawHeaders } });

      if (url === 'https://origin-a.example/start.txt') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://origin-b.example/target.txt' },
        });
      }
      return new Response('safe-redirected-content', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '23' },
      });
    };

    const req = new NextRequest('https://easyconvert.test/api/fetch-url', {
      method: 'POST',
      headers: { Cookie: paidSessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://origin-a.example/start.txt',
        headers: {
          Authorization: 'Bearer origin-a-secret',
          'X-API-Key': 'api-key-must-strip',
          'X-Amz-Security-Token': 'aws-sts-must-strip',
          'X-Custom-Secret': 'custom-must-strip',
        },
      }),
    });

    const res = await fetchUrlPost(req);
    expect(res.status).toBe(200);
    expect(forwardedHeaders).toHaveLength(2);
    expect(forwardedHeaders[0].headers['x-api-key']).toBe('api-key-must-strip');
    expect(forwardedHeaders[1].url).toBe('https://origin-b.example/target.txt');
    expect(forwardedHeaders[1].headers['authorization'] ?? null).toBeNull();
    expect(forwardedHeaders[1].headers['x-api-key'] ?? null).toBeNull();
    expect(forwardedHeaders[1].headers['x-amz-security-token'] ?? null).toBeNull();
    expect(forwardedHeaders[1].headers['x-custom-secret'] ?? null).toBeNull();
  });
});

describe('P1-4: Idempotency Lease, Heartbeat Renewal, lockToken CAS & Single Multipart Parse', () => {
  it('uses >= syncMaxMs+30s lease for acquireIdempotency and renews TTL periodically until complete', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const store = new InMemoryIdempotencyStore({ clock: () => now });
    const extendSpy = vi.spyOn(store, 'extendLock');

    const req = new NextRequest('http://localhost/api/v1/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: 'https://example.com/a.pdf', targetFormat: 'png' }),
    });

    const first = await acquireIdempotency(req, paidUser.id, 'lease-heartbeat-key', '/api/v1/convert', {
      store,
      parsedBody: { sourceUrl: 'https://example.com/a.pdf', targetFormat: 'png' },
    });
    expect(first.context).toBeTruthy();

    // Advance 125s (< 150s floor) on fake clock without triggering completion: lock must remain in_flight
    now += 125_000;
    const conflictReq = new NextRequest('http://localhost/api/v1/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: 'https://example.com/a.pdf', targetFormat: 'png' }),
    });
    const conflict = await acquireIdempotency(conflictReq, paidUser.id, 'lease-heartbeat-key', '/api/v1/convert', {
      store,
      parsedBody: { sourceUrl: 'https://example.com/a.pdf', targetFormat: 'png' },
    });
    expect(conflict.response?.status).toBe(409);

    // Advance fake timers by 45s to observe 20s periodic heartbeat extendLock calls
    await vi.advanceTimersByTimeAsync(45_000);
    expect(extendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const callsBeforeComplete = extendSpy.mock.calls.length;
    await first.context!.complete(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    // Timer must be cleared on completion
    await vi.advanceTimersByTimeAsync(60_000);
    expect(extendSpy.mock.calls.length).toBe(callsBeforeComplete);

    // RespondOnce preserves 60s lock contract
    let roNow = 2_000_000;
    const roStore = new InMemoryIdempotencyStore({ clock: () => roNow });
    await roStore.acquire('ro-key', 'fp-ro', 60_000, 'tok-1');
    roNow += 61_000;
    const reacquired = await roStore.acquire('ro-key', 'fp-ro', 60_000, 'tok-2');
    expect(reacquired.status).toBe('acquired');
    void respondOnce;
  });

  it('prevents an expired/fenced first attempt lockToken from overwriting a newer lock holder on complete', async () => {
    let now = 5_000_000;
    const store = new InMemoryIdempotencyStore({ clock: () => now });
    const scopedKey = buildScopedKey(paidUser.id, '/api/v1/convert', 'cas-fence-key');
    const fp = 'fingerprint-same';

    expect((await store.acquire(scopedKey, fp, 10_000, 'tok-attempt-1')).status).toBe('acquired');
    now += 15_000; // attempt-1 expires
    expect((await store.acquire(scopedKey, fp, 150_000, 'tok-attempt-2')).status).toBe('acquired');

    // Attempt-1 finishes late and tries to write with its old lockToken
    const wrote = await store.complete(
      scopedKey,
      fp,
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"stale":1}', isBase64: false },
      86_400_000,
      'tok-attempt-1'
    );
    expect(wrote).toBe(false);

    const rec = await store.getRecord(scopedKey);
    expect(rec?.status).toBe('in_flight');
    expect(rec?.lockToken).toBe('tok-attempt-2');

    // Verify COMPLETE_IDEMPOTENCY_LUA_SCRIPT itself encodes lockToken fencing
    expect(COMPLETE_IDEMPOTENCY_LUA_SCRIPT).toContain('ARGV[4]');
    expect(COMPLETE_IDEMPOTENCY_LUA_SCRIPT).toContain('LOCK_LOST');
  });

  it('parses multipart request body only once on POST /api/v1/convert even with Idempotency-Key', async () => {
    vi.spyOn(waitForJobMod, 'dispatchSyncRouteConversion').mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
      mimeType: 'application/pdf',
      filename: 'once.pdf',
      size: 14,
      engineUsed: 'internal-fallback',
      executionTimeMs: 3,
    });
    const form = new FormData();
    form.append('file', new File(['hello single parse'], 'once.txt', { type: 'text/plain' }));
    form.append('targetFormat', 'pdf');

    const req = new NextRequest('http://localhost/api/v1/convert', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${paidApiKey}`,
        'Idempotency-Key': `single-parse-${Date.now()}`,
      },
      body: form,
    });
    const formDataSpy = vi.spyOn(req, 'formData');
    const cloneSpy = vi.spyOn(req, 'clone');
    const readSpy = vi.spyOn(multipartBodyMod, 'readMultipartForm');

    const res = await v1ConvertPost(req);
    expect(res.status).toBe(200);
    expect(formDataSpy.mock.calls.length + cloneSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('P1-5: WebhookDispatcher Circuit Breaker & replayDlq Guard', () => {
  it('opens per-endpoint circuit after 5 consecutive failures, skips dispatch during cooldown, and resets on 2xx', async () => {
    const dispatcher = new WebhookDispatcher();
    const addedJobs: Array<{ data: unknown; opts: { delay?: number } }> = [];
    vi.spyOn(dispatcher, 'getQueue').mockReturnValue({
      add: vi.fn(async (_name, data, opts) => {
        addedJobs.push({ data, opts: opts ?? {} });
        return { id: `retry_${addedJobs.length}`, data } as never;
      }),
      remove: vi.fn(async () => true),
      isDistributed: false,
    } as never);

    let failCount = 0;
    const dispatchSpy = vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (url, event) => {
      failCount += 1;
      if (failCount <= 5) {
        return {
          id: `wh_cb_${failCount}`,
          url,
          event,
          success: false,
          totalAttempts: 1,
          finalStatusCode: 503,
          durationMs: 25,
          attempts: [{ attemptNumber: 1, timestamp: Date.now(), statusCode: 503, error: 'Service Unavailable', durationMs: 25 }],
        };
      }
      return {
        id: `wh_cb_${failCount}`,
        url,
        event,
        success: true,
        totalAttempts: 1,
        finalStatusCode: 200,
        durationMs: 12,
        attempts: [{ attemptNumber: 1, timestamp: Date.now(), statusCode: 200, durationMs: 12 }],
      };
    });

    const targetUrl = `https://flaky-cb-${Date.now()}.example/webhook`;
    const makeJob = (n: number) =>
      ({
        id: `qjob_${n}`,
        data: {
          deliveryId: `deliv_${n}`,
          targetUrl,
          event: 'job.completed',
          data: { jobId: `j_${n}` },
          secret: 'plain-test-secret',
          options: { maxRetries: 6, retrySchedule: [1000, 2000, 4000] },
          attemptNumber: 1,
          attempts: [],
          createdAt: Date.now(),
        },
      }) as unknown as Job<never, never>;

    for (let i = 1; i <= 5; i++) {
      await (dispatcher as unknown as { processQueuedJob: (j: unknown) => Promise<unknown> }).processQueuedJob(makeJob(i));
    }
    expect(dispatchSpy).toHaveBeenCalledTimes(5);

    // 6th job while cooldown is active MUST skip HTTP dispatch and schedule retry delayed >= circuit cooldown
    const callsBeforeSkip = dispatchSpy.mock.calls.length;
    await (dispatcher as unknown as { processQueuedJob: (j: unknown) => Promise<unknown> }).processQueuedJob(makeJob(6));
    expect(dispatchSpy).toHaveBeenCalledTimes(callsBeforeSkip);
    const skippedRetry = addedJobs.at(-1);
    expect(skippedRetry?.opts.delay).toBeGreaterThanOrEqual(55_000);

    // Advance time past 60s cooldown -> half-open probe dispatches and gets 200 -> resets breaker
    vi.useFakeTimers();
    vi.advanceTimersByTime(65_000);
    await (dispatcher as unknown as { processQueuedJob: (j: unknown) => Promise<unknown> }).processQueuedJob(makeJob(7));
    expect(dispatchSpy).toHaveBeenCalledTimes(callsBeforeSkip + 1);
    // Subsequent call after reset also dispatches immediately
    await (dispatcher as unknown as { processQueuedJob: (j: unknown) => Promise<unknown> }).processQueuedJob(makeJob(8));
    expect(dispatchSpy).toHaveBeenCalledTimes(callsBeforeSkip + 2);
  });

  it('guards replayDlq against concurrent double replay, already-replayed entries, and limits manual replay to 1 attempt', async () => {
    const dispatcher = new WebhookDispatcher();
    const entryId = `dlq_guard_${Date.now()}`;
    await dispatcher.saveToDlq({
      id: entryId,
      originalDeliveryId: 'orig_1',
      targetUrl: 'https://hooks.example/dlq',
      event: 'conversion.completed',
      payload: { ok: true },
      secret: 'secret-raw',
      failedAt: Date.now(),
      retryCount: 2,
      status: 'failed',
      ownerUserId: paidUser.id,
      ownerKeyId: 'k1',
    });

    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const dispatchCalls: Array<Record<string, unknown>> = [];
    vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (url, event, _data, _sec, opts) => {
      dispatchCalls.push({ ...(opts ?? {}) });
      if (dispatchCalls.length === 1) {
        await firstInFlight;
      }
      return {
        id: 'orig_1',
        url,
        event,
        success: true,
        totalAttempts: 1,
        finalStatusCode: 200,
        durationMs: 10,
        attempts: [{ attemptNumber: 1, timestamp: Date.now(), statusCode: 200, durationMs: 10 }],
      };
    });

    const p1 = dispatcher.replayDlq(entryId, paidUser.id);
    await Promise.resolve();
    const p2 = dispatcher.replayDlq(entryId, paidUser.id);

    const res2 = await p2;
    expect(res2?.skipped).toBe(true);
    expect(res2?.finalStatusCode).toBe(409);
    expect(res2?.totalAttempts).toBe(0);

    releaseFirst();
    const res1 = await p1;
    expect(res1?.success).toBe(true);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].maxRetries).toBe(1);
    expect(dispatchCalls[0].timeoutMs).toBe(5000);

    // Repeating after status === 'replayed' is refused with 0 dispatches
    const res3 = await dispatcher.replayDlq(entryId, paidUser.id);
    expect(res3?.skipped).toBe(true);
    expect(res3?.finalStatusCode).toBe(409);
    expect(dispatchCalls).toHaveLength(1);
  });
});

describe('P1-6: Scale-Out Fixes (Queue, Metrics, Wait-For-Job Telemetry, TUS, Billing Cluster)', () => {
  it('excludes transientSyncWait jobs from user job lists/counts and metrics, and sizes syncSlotLeaseMs dynamically', async () => {
    const dynamicLease = (concurrencyLimitMod as { getSyncSlotLeaseMs?: () => number }).getSyncSlotLeaseMs?.();
    expect(dynamicLease).toBe(Math.max(120_000, currentJobDeadlineSettings().syncMaxMs + 15_000));
    expect(SYNC_SLOT_LEASE_MS).toBeGreaterThanOrEqual(120_000);

    const q = new Queue<{ userId?: string; transientSyncWait?: boolean; sourceFormat?: string }>('test-sync-filter');
    const syncUser = `sync_u_${Date.now()}`;
    await q.add('convert', { userId: syncUser, transientSyncWait: true, sourceFormat: 'txt' }, { jobId: 'sync_1' });
    await q.add('convert', { userId: syncUser, sourceFormat: 'txt' }, { jobId: 'async_1' });

    const listed = await q.getJobsByUser(syncUser);
    expect(listed.map((j) => j.id)).toEqual(['async_1']);
    expect(await q.countJobsByUser(syncUser)).toBe(1);

    // Metrics skip transientSyncWait
    const readDocMetricTotal = async (outcome: string): Promise<number> => {
      const m = await instruments().jobs.get();
      return m.values
        .filter((v) => {
          const labels = v.labels as Record<string, unknown>;
          return labels.family === 'document' && labels.outcome === outcome;
        })
        .reduce((acc, v) => acc + v.value, 0);
    };
    const beforeOk = await readDocMetricTotal('ok');
    const beforeFail = await readDocMetricTotal('failed');

    recordJobCompleted({ data: { sourceFormat: 'txt', transientSyncWait: true }, processedOn: 100, finishedOn: 150 });
    recordJobFailed({ data: { sourceFormat: 'txt', transientSyncWait: true }, processedOn: 100, finishedOn: 150 }, new Error('boom'));
    expect(await readDocMetricTotal('ok')).toBe(beforeOk);
    expect(await readDocMetricTotal('failed')).toBe(beforeFail);

    // Real async job increments
    recordJobCompleted({ data: { sourceFormat: 'txt' }, processedOn: 100, finishedOn: 150 });
    expect(await readDocMetricTotal('ok')).toBe(beforeOk + 1);
  });

  it('DistributedBullMQAdapter excludes transientSyncWait from Redis user_jobs index when adding', async () => {
    const evalCalls: Array<{ args: unknown[] }> = [];
    const mockRedis = {
      status: 'ready',
      eval: vi.fn(async (...args: unknown[]) => {
        evalCalls.push({ args });
        return [1];
      }),
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
      on: vi.fn(),
    };
    const adapter = new DistributedBullMQAdapter<{ userId?: string; transientSyncWait?: boolean }>('sync-filter-redis', {
      redisClient: mockRedis as never,
    });
    await adapter.add('convert', { userId: 'u_redis_sync', transientSyncWait: true }, { jobId: 'sync_r_1' });
    const addCall = evalCalls[0].args;
    // KEYS[4] userJobsKey (index 4 after script, 4) and ARGV[6] userId (index 11) must not index u_redis_sync
    expect(String(addCall[5])).toContain('user_jobs:none');
    expect(addCall[11]).toBe('');
  });

  it('settles waitForQueuedJobResult immediately upon telemetry cancelled event from another replica', async () => {
    const prevMode = process.env.WEB_EXECUTION_MODE;
    process.env.WEB_EXECUTION_MODE = 'queue-only';
    try {
      const { conversionQueue: cq, getQueueForJob } = await import('../src/lib/queue/conversion-queue');
      const targetQueue = getQueueForJob({ sourceFormat: 'txt', targetFormat: 'pdf', fileSize: 3, options: {} });
      await targetQueue
        .add(
          '__worker-ping__',
          { jobId: '__ping_worker_skip__', originalFilename: 'ping.txt', sourceFormat: 'txt', targetFormat: 'pdf', fileSize: 0, options: {} },
          { jobId: '__ping_worker_skip__' }
        )
        .catch(() => undefined);
      const waitModWorker = await import('../src/lib/queue/worker-presence');
      vi.spyOn(waitModWorker, 'hasLiveQueueWorker').mockResolvedValue(true);
      vi.spyOn(storageProvider, 'saveObject').mockResolvedValue({ key: 'k', size: 3 } as never);
      vi.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);

      let capturedJobId = '';
      const onNewListener = (eventName: string | symbol) => {
        if (capturedJobId && eventName === `telemetry:${capturedJobId}`) {
          targetQueue.off('newListener', onNewListener);
          queueMicrotask(() => {
            targetQueue.emit(`telemetry:${capturedJobId}`, {
              event: 'cancelled',
              data: { jobId: capturedJobId, state: 'cancelled', error: 'Cancelled on sibling replica' },
            });
          });
        }
      };
      targetQueue.on('newListener', onNewListener);
      const origAdd = targetQueue.add.bind(targetQueue);
      vi.spyOn(targetQueue, 'add').mockImplementation(async (name, data, opts) => {
        const res = await origAdd(name, data, opts);
        capturedJobId = res.id;
        return res;
      });
      void cancelJobAcrossQueues;
      void cq;

      await expect(
        waitForJobMod.dispatchSyncRouteConversion({
          inputBuffer: Buffer.from('abc'),
          sourceFormat: 'txt',
          targetFormat: 'pdf',
          options: {},
          originalFilename: 'a.txt',
          userId: paidUser.id,
          tier: 'paid',
        })
      ).rejects.toThrow('Cancelled on sibling replica');
      expect(targetQueue.listenerCount(`telemetry:${capturedJobId}`)).toBe(0);
    } finally {
      if (prevMode === undefined) delete process.env.WEB_EXECUTION_MODE;
      else process.env.WEB_EXECUTION_MODE = prevMode;
    }
  });

  it('TUS >128MiB fails closed when binPath is missing on disk, tracks/aborts expired remote multipart sessions, and saves completed session before deleting staged bytes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-scale-'));
    try {
      const tusId = `0123456789abcdef0123456789abcdef`;
      const bigOffset = 130 * 1024 * 1024;
      const missingBin = path.join(tmpDir, `${tusId}.bin`);
      const mockRedis = {
        get: vi.fn(async () => '0'),
        lrange: vi.fn(async () => []),
        set: vi.fn(async () => 'OK'),
        del: vi.fn(async () => 1),
        sadd: vi.fn(async () => 1),
        srem: vi.fn(async () => 1),
        expire: vi.fn(async () => 1),
        zadd: vi.fn(async () => 1),
        zrem: vi.fn(async () => 1),
        zrangebyscore: vi.fn(async () => []),
        pipeline: vi.fn(),
        scan: vi.fn(async () => ['0', []]),
        status: 'ready',
      };
      const store = new RedisTusSessionStore(mockRedis as never);

      // Missing binPath with >128 MiB offset throws clear StorageServiceError
      await expect(store.hydrateStagedFile(tusId, missingBin, bigOffset)).rejects.toBeInstanceOf(StorageServiceError);

      // Shared local filesystem where binPath IS on disk with matching size returns size
      const handle = await fs.promises.open(missingBin, 'w');
      await handle.truncate(bigOffset);
      await handle.close();
      expect(await store.hydrateStagedFile(tusId, missingBin, bigOffset)).toBe(bigOffset);

      // Remote multipart session tracking + sweep abort even when session expired
      const setMap = new Map<string, string>();
      const zsetMap = new Map<string, number>();
      const trackingRedis = {
        set: vi.fn(async (k: string, v: string) => {
          setMap.set(k, v);
          return 'OK';
        }),
        get: vi.fn(async (k: string) => setMap.get(k) ?? null),
        del: vi.fn(async (...ks: string[]) => {
          let c = 0;
          for (const k of ks) if (setMap.delete(k)) c += 1;
          return c;
        }),
        sadd: vi.fn(async () => 1),
        srem: vi.fn(async () => 1),
        expire: vi.fn(async () => 1),
        zadd: vi.fn(async (_key: string, score: number, member: string) => {
          zsetMap.set(member, score);
          return 1;
        }),
        zrem: vi.fn(async (_key: string, member: string) => (zsetMap.delete(member) ? 1 : 0)),
        zrangebyscore: vi.fn(async (_key: string, _min: string | number, max: number) =>
          [...zsetMap.entries()].filter(([, sc]) => sc <= max).map(([m]) => m)
        ),
        scan: vi.fn(async () => ['0', []]),
        status: 'ready',
      };
      const remoteStore = new RedisTusSessionStore(trackingRedis as never);
      const pastExpiry = Date.now() - 10_000;
      const remoteSess = {
        id: 'fedcba9876543210fedcba9876543210',
        key: 'uploads/u1/remote.pdf',
        filename: 'remote.pdf',
        mimeType: 'application/pdf',
        uploadLength: 50_000_000,
        uploadOffset: 0,
        metadata: '',
        parsedMetadata: {},
        createdAt: pastExpiry - 86_400_000,
        expiresAt: pastExpiry + 120_000,
        completed: false,
        remoteUploadId: 's3_mpu_orphan_999',
      };
      await remoteStore.saveSession(remoteSess, 60);
      expect(setMap.has(`tus:remote:${remoteSess.id}`)).toBe(true);
      expect(zsetMap.has(remoteSess.id)).toBe(true);

      const abortSpy = vi.spyOn(storageProvider, 'abortMultipartUpload').mockResolvedValue(true);
      setTusSessionStore(remoteStore);
      const eng = new TusEngine({ tusDir: tmpDir });
      // Even if tus:session:* key was evicted by Redis TTL, tus:remote:* + ZSET lets sweep abort orphan
      setMap.delete(`tus:session:${remoteSess.id}`);
      const swept = await eng.sweepExpired(pastExpiry + 200_000);
      expect(swept).toBeGreaterThanOrEqual(1);
      expect(abortSpy).toHaveBeenCalledWith('s3_mpu_orphan_999');
      expect(setMap.has(`tus:remote:${remoteSess.id}`)).toBe(false);
      expect(zsetMap.has(remoteSess.id)).toBe(false);

      // completeLocalStagedTus: saveSession failure MUST preserve binPath & staged bytes
      setTusSessionStore(null);
      const localEngine = new TusEngine({ tusDir: tmpDir });
      const sess = await localEngine.createSession({
        uploadLength: 5,
        metadataHeader: 'filename aGVsbG8udHh0',
        ownerUserId: paidUser.id,
      });
      const sessBin = path.join(tmpDir, `${sess.id}.bin`);
      const saveSpy = vi.spyOn(tusEngine.sessionStore, 'saveSession');
      void saveSpy;
      vi.spyOn(localEngine.sessionStore, 'saveSession').mockRejectedValueOnce(new Error('Redis save transient failure'));
      const delStagedSpy = vi.fn(async () => undefined);
      (localEngine.sessionStore as { deleteStagedBytes?: () => Promise<void> }).deleteStagedBytes = delStagedSpy;

      await expect(
        localEngine.appendChunk(sess.id, 0, Readable.from([Buffer.from('hello')]) as NodeJS.ReadableStream)
      ).rejects.toThrow('Redis save transient failure');
      expect(fs.existsSync(sessBin)).toBe(true);
      expect(delStagedSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses scanClusterSafe + per-key get in SubscriptionStore.listRecords across Redis Cluster nodes without CROSSSLOT', async () => {
    const shard1Data = new Map<string, string>([
      ['ec:billing:sub:u1', JSON.stringify({ userId: 'u1', tier: 'paid', status: 'active' })],
    ]);
    const shard2Data = new Map<string, string>([
      ['ec:billing:sub:u2', JSON.stringify({ userId: 'u2', tier: 'paid', status: 'active' })],
    ]);
    const makeNode = (map: Map<string, string>) => ({
      scan: vi.fn(async (_c: string) => ['0', [...map.keys()]]),
      get: vi.fn(async (k: string) => map.get(k) ?? null),
    });
    const node1 = makeNode(shard1Data);
    const node2 = makeNode(shard2Data);
    const clusterClient = {
      isCluster: true,
      status: 'ready',
      once: vi.fn(),
      off: vi.fn(),
      nodes: vi.fn(() => [node1, node2]),
      scan: vi.fn(async () => ['0', [...shard1Data.keys()]]),
      get: vi.fn(async (k: string) => shard1Data.get(k) ?? shard2Data.get(k) ?? null),
      mget: vi.fn(async () => {
        throw new Error('CROSSSLOT Keys in request dont hash to the same slot');
      }),
    };

    const subStore = new SubscriptionStore({
      getKeyPrefix: () => 'ec:',
      getRedisClient: () => clusterClient as never,
    } as never);

    const records = await subStore.listRecords();
    expect(records.map((r) => r.userId).sort()).toEqual(['u1', 'u2']);
    expect(clusterClient.mget).not.toHaveBeenCalled();
  });
});

describe('P1-7: Hardening /api/storage/bundle & /api/tools/handler', () => {
  it('bundle route enforces 2 GiB cap (413), authenticates once upfront, acquires/releases sync slot, destroys streams on cancel, and records served only on completed entries', async () => {
    const key1 = `conversions/${paidUser.id}/b1.txt`;
    const key2 = `conversions/${paidUser.id}/b2.txt`;
    const body1 = Buffer.from('first bundle entry');
    const body2 = Buffer.from('second bundle entry');

    const streams: PassThrough[] = [];
    vi.spyOn(storageProvider, 'stat').mockImplementation(async (k) => {
      if (k === key1) return { key: k, size: body1.length, mimeType: 'text/plain', filename: 'b1.txt', createdAt: new Date(), etag: 'e1' };
      if (k === key2) return { key: k, size: body2.length, mimeType: 'text/plain', filename: 'b2.txt', createdAt: new Date(), etag: 'e2' };
      if (k.endsWith('huge.bin')) return { key: k, size: 1.5 * 1024 * 1024 * 1024, mimeType: 'application/octet-stream', filename: 'huge.bin', createdAt: new Date(), etag: 'eh' };
      return null;
    });
    vi.spyOn(retentionMod, 'resultAvailability').mockResolvedValue({ state: 'available' } as never);
    const recordServedSpy = vi.spyOn(retentionMod, 'recordServed').mockResolvedValue();
    const authSpy = vi.spyOn(guardMod, 'validateApiAccess');
    const releaseSpy = vi.fn();
    const slotSpy = vi.spyOn(concurrencyLimitMod, 'acquireSyncSlot').mockResolvedValue({ granted: true, release: releaseSpy });

    vi.spyOn(storageProvider, 'openReadStream').mockImplementation(async (k) => {
      const pt = new PassThrough();
      streams.push(pt);
      if (k === key1) pt.end(body1);
      else pt.end(body2);
      return pt as never;
    });

    // 1. Over 2 GiB total -> 413
    const hugeReq = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paidApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { key: `conversions/${paidUser.id}/huge.bin`, name: 'h1.bin' },
          { key: `conversions/${paidUser.id}/huge.bin`, name: 'h2.bin' },
        ],
      }),
    });
    const hugeRes = await bundlePost(hugeReq);
    expect(hugeRes.status).toBe(413);
    expect(releaseSpy).toHaveBeenCalled();

    // 2. Normal 2-file bundle: auth called ONCE upfront, recordServed called for both
    authSpy.mockClear();
    slotSpy.mockClear();
    releaseSpy.mockClear();
    recordServedSpy.mockClear();

    const okReq = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paidApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { key: key1, name: 'b1.txt' },
          { key: key2, name: 'b2.txt' },
        ],
      }),
    });
    const okRes = await bundlePost(okReq);
    expect(okRes.status).toBe(200);
    const zipBytes = Buffer.from(await okRes.arrayBuffer());
    const zip = await JSZip.loadAsync(zipBytes);
    expect(await zip.file('b1.txt')?.async('string')).toBe('first bundle entry');
    expect(await zip.file('b2.txt')?.async('string')).toBe('second bundle entry');
    expect(authSpy).toHaveBeenCalledTimes(1);
    expect(slotSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(recordServedSpy).toHaveBeenCalledWith(key1, { first: 0, last: body1.length - 1, size: body1.length });
    expect(recordServedSpy).toHaveBeenCalledWith(key2, { first: 0, last: body2.length - 1, size: body2.length });

    // 3. Stream cancel mid-transfer destroys open nodeStream and releases sync slot without calling recordServed on cancelled entry
    recordServedSpy.mockClear();
    releaseSpy.mockClear();
    let destroyedOnCancel = false;
    vi.spyOn(storageProvider, 'openReadStream').mockImplementation(async () => {
      const pt = new PassThrough();
      const origDestroy = pt.destroy.bind(pt);
      pt.destroy = ((...args: unknown[]) => {
        destroyedOnCancel = true;
        return origDestroy(...(args as [Error?]));
      }) as typeof pt.destroy;
      pt.write(Buffer.from('partial-chunk'));
      return pt as never;
    });
    const cancelReq = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paidApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ key: key1, name: 'b1.txt' }] }),
    });
    const cancelRes = await bundlePost(cancelReq);
    expect(cancelRes.status).toBe(200);
    const reader = cancelRes.body!.getReader();
    await reader.read();
    await reader.cancel('client aborted');
    expect(destroyedOnCancel).toBe(true);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(recordServedSpy).not.toHaveBeenCalled();

    void acquireSyncSlot;
  });

  it('tools handler fails closed with 503/507 when saveRetainedResult fails instead of falling back to inline base64', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.addPage([200, 200]);
    const pdfBytes = await doc.save();

    vi.spyOn(waitForJobMod, 'dispatchSyncWebTool').mockResolvedValue({
      kind: 'entries',
      entries: [
        { name: 'page_1.pdf', buffer: Buffer.from('%PDF-1.4\n1'), mimeType: 'application/pdf', size: 10 },
        { name: 'page_2.pdf', buffer: Buffer.from('%PDF-1.4\n2'), mimeType: 'application/pdf', size: 10 },
      ],
    });

    const makeSplitReq = () => {
      const form = new FormData();
      form.append('files', new File([new Uint8Array(pdfBytes)], 'two.pdf', { type: 'application/pdf' }));
      form.append('options', JSON.stringify({ ranges: '1,2' }));
      return new NextRequest('http://localhost/api/tools/split', {
        method: 'POST',
        headers: { Authorization: `Bearer ${paidApiKey}` },
        body: form,
      });
    };

    // 503 on StorageServiceError (retryable: true) after first entry saved -> cleans up first entry and leaks zero base64
    const deleteSpy = vi.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);
    vi.spyOn(retentionMod, 'saveRetainedResult')
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new StorageServiceError('S3 outage', 's3', { retryable: true }));
    const res503 = await splitToolPost(makeSplitReq());
    expect(res503.status).toBe(503);
    const json503 = await res503.json();
    expect(JSON.stringify(json503)).not.toContain('data');
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    // 507 on ENOSPC
    const enospc = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    vi.spyOn(retentionMod, 'saveRetainedResult').mockRejectedValueOnce(enospc);
    const res507 = await splitToolPost(makeSplitReq());
    expect(res507.status).toBe(507);
  });
});
