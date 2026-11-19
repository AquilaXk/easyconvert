import { execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Python SDK (sdk/python/easyconvert: the generated package plus the hand-written client) against a stub server, run by a real
 * interpreter with `-I`. The package needs httpx2 and attrs, which the virtual environment of `npm run sdk:generate` has; CI sets
 * EASYCONVERT_SDK_PYTHON_REQUIRED so a missing interpreter fails the test instead of skipping it.
 */

const ROOT = path.resolve(__dirname, '..');
const SDK_PYTHON_DIR = path.join(ROOT, 'sdk', 'python');
const GENERATOR_PYTHON = path.join(ROOT, 'node_modules', '.cache', 'easyconvert-sdk-python-generator', 'bin', 'python');
const API_KEY = 'ec_live_test_dummy_key_1234567890';
const RESULT_BYTES = Buffer.from([1, 2, 3]);

function usablePython(): string | undefined {
  for (const python of [GENERATOR_PYTHON, 'python3']) {
    try {
      execFileSync(python, ['-I', '-c', 'import httpx2, attrs'], { stdio: 'pipe' });
      return python;
    } catch {
      continue;
    }
  }
  return undefined;
}

// skip-ok: mode selection. The shards have no virtual environment of the SDK generator; the SDK step of the checks job installs it and sets EASYCONVERT_SDK_PYTHON_REQUIRED.
const python = usablePython();
if (python === undefined && process.env.EASYCONVERT_SDK_PYTHON_REQUIRED) throw new Error('No Python with httpx2 and attrs for the SDK test');

const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from easyconvert import EasyConvertApiError, EasyConvertClient

client = EasyConvertClient(api_key=sys.argv[3], base_url=sys.argv[2])
other_origin = sys.argv[4]
converted = client.convert(b"a,b\\n1,2\\n", "json", filename="a.csv", options={"quality": 80})
queued = client.convert(b"x", "json", respond_async=True, webhook_url="https://hooks.example.test/in", webhook_secret="whsec_test")
job = client.create_job(b"x", "json", filename="a.csv")
done = client.wait_for_job(job.job_id, interval=0.01)
data = client.download(done.result.download_url)
foreign = client.download(other_origin + "/api/storage/file/out-key")
try:
    client.get_job("missing")
    failure = None
except EasyConvertApiError as error:
    failure = [error.status_code, error.problem.detail]
print(json.dumps({
    "converted": [converted.file_id, converted.target_format],
    "queued": [queued.job_id, queued.status_url],
    "job": [job.job_id, done.status.value, done.result.download_url],
    "download": list(data),
    "foreign_download": list(foreign),
    "failure": failure,
}))
`;

const requests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
/** The requests that reached a second server: another port is another origin, however alike the address. */
const foreignRequests: http.IncomingHttpHeaders[] = [];
let otherServer: http.Server;
let otherOrigin: string;
let jobPolls = 0;
let server: http.Server;
let baseUrl: string;

function reply(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const { pathname } = new URL(req.url ?? '/', 'http://stub');
  if (pathname === '/api/v1/convert' && req.headers.prefer === 'respond-async') {
    return reply(res, 202, { success: true, status: 'accepted', jobId: 'job_1', statusUrl: '/api/v1/jobs/job_1' });
  }
  if (pathname === '/api/v1/convert') return reply(res, 200, { success: true, fileId: 'f1', targetFormat: 'json' });
  if (pathname === '/api/v1/jobs') return reply(res, 202, { success: true, jobId: 'job_1', status: 'waiting', statusUrl: '/api/v1/jobs/job_1' });
  if (pathname === '/api/v1/jobs/job_1') {
    jobPolls += 1;
    const result = { downloadUrl: '/api/storage/file/out-key' };
    return reply(res, 200, jobPolls < 2 ? { jobId: 'job_1', status: 'active' } : { jobId: 'job_1', status: 'completed', result });
  }
  if (pathname === '/api/storage/file/out-key') return reply(res, 200, RESULT_BYTES, 'application/octet-stream');
  return reply(res, 404, { type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such job.', instance: '/api/v1/jobs/missing' }, 'application/problem+json');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
      route(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  otherServer = http.createServer((req, res) => {
    foreignRequests.push(req.headers);
    reply(res, 200, RESULT_BYTES, 'application/octet-stream');
  });
  await new Promise<void>((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  otherOrigin = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => otherServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(python === undefined)('the Python client over a stub server', () => {
  it('converts, queues, polls and downloads through the generated package', async () => {
    const { stdout } = await promisify(execFile)(python!, ['-I', '-B', '-c', SCRIPT, SDK_PYTHON_DIR, baseUrl, API_KEY, otherOrigin]);
    expect(JSON.parse(stdout)).toEqual({
      converted: ['f1', 'json'],
      queued: ['job_1', '/api/v1/jobs/job_1'],
      job: ['job_1', 'completed', '/api/storage/file/out-key'],
      download: [...RESULT_BYTES],
      foreign_download: [...RESULT_BYTES],
      failure: [404, 'No such job.'],
    });
    const [sync, queued] = requests;
    expect(sync.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(sync.body).toContain('name="targetFormat"');
    expect(sync.body).toContain('filename="a.csv"');
    expect(sync.body).toContain('{"quality": 80}');
    expect(queued.headers.prefer).toBe('respond-async');
    expect(queued.body).toContain('whsec_test');
    expect(requests.find((request) => request.url === '/api/storage/file/out-key')?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(foreignRequests).toHaveLength(1);
    expect(foreignRequests[0]).not.toHaveProperty('authorization');
  }, 60_000);

  it('streams TUS and multipart uploads in chunks, inspects archives, streams downloads, and verifies Standard Webhooks', async () => {
    const helperScript = `
import base64, hashlib, hmac, io, json, sys, time
sys.path.insert(0, sys.argv[1])
import httpx2
from easyconvert.client import DEFAULT_BASE_URL, EasyConvertClient

assert DEFAULT_BASE_URL == "https://convert.aquilaxk.site"

class BoundedStream(io.RawIOBase):
    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0
        self.reads = []
    def readable(self): return True
    def seekable(self): return True
    def seek(self, off, whence=io.SEEK_SET):
        if whence == io.SEEK_END: self._pos = len(self._data) + off
        elif whence == io.SEEK_CUR: self._pos += off
        else: self._pos = off
        return self._pos
    def tell(self): return self._pos
    def read(self, size=-1):
        assert size is not None and size > 0
        self.reads.append(size)
        out = self._data[self._pos:self._pos + size]
        self._pos += len(out)
        return out

def handler(req: httpx2.Request) -> httpx2.Response:
    if req.method == "POST" and req.url.path == "/api/v1/uploads":
        return httpx2.Response(201, headers={"Location": "/api/v1/uploads/tus_1", "Tus-Resumable": "1.0.0"})
    if req.method == "PATCH" and req.url.path == "/api/v1/uploads/tus_1":
        off = int(req.headers["upload-offset"]) + len(req.content)
        hdrs = {"Tus-Resumable": "1.0.0", "Upload-Offset": str(off)}
        if off == 9: hdrs["EasyConvert-Storage-Key"] = "uploads/tus_1/doc.pdf"
        return httpx2.Response(204, headers=hdrs)
    if req.method == "POST" and req.url.path == "/api/v1/archives/inspect":
        return httpx2.Response(200, json={"format": "zip", "entries": []})
    if req.method == "GET" and req.url.path == "/dl":
        return httpx2.Response(200, content=b"stream-bytes")
    return httpx2.Response(404)

client = EasyConvertClient(api_key="ec_live_test", base_url="https://convert.aquilaxk.site")
client.generated.set_httpx_client(httpx2.Client(base_url="https://convert.aquilaxk.site", transport=httpx2.MockTransport(handler)))
s = BoundedStream(b"123456789")
tus = client.upload_tus(s, filename="한글.pdf", chunk_size=4)
arc = client.inspect_archive(storage_key="uploads/tus_1/doc.pdf")
dl = b"".join(client.download_stream("/dl", chunk_size=4))
secret = "wh_sec_1"
payload = '{"ok":true}'
ts = int(time.time())
msg_id = "msg_1"
sig = "v1," + base64.b64encode(hmac.new(secret.encode(), f"{msg_id}.{ts}.{payload}".encode(), hashlib.sha256).digest()).decode()
ok = EasyConvertClient.verify_webhook_signature(payload, f"v1,bad {sig}", ts, secret, delivery_id=msg_id)
print(json.dumps({"tus": tus["storageKey"], "reads": s.reads, "arc": arc["format"], "dl": dl.decode(), "ok": ok}))
`;
    const { stdout } = await promisify(execFile)(python!, ['-I', '-B', '-c', helperScript, SDK_PYTHON_DIR]);
    expect(JSON.parse(stdout)).toEqual({
      tus: 'uploads/tus_1/doc.pdf',
      reads: [4, 4, 1],
      arc: 'zip',
      dl: 'stream-bytes',
      ok: true,
    });
  }, 60_000);
});
