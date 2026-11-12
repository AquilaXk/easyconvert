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
converted = client.convert(b"a,b\\n1,2\\n", "json", filename="a.csv", options={"quality": 80})
queued = client.convert(b"x", "json", respond_async=True, webhook_url="https://hooks.example.test/in", webhook_secret="whsec_test")
job = client.create_job(b"x", "json", filename="a.csv")
done = client.wait_for_job(job.job_id, interval=0.01)
data = client.download(done.result.download_url)
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
    "failure": failure,
}))
`;

const requests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
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
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe.skipIf(python === undefined)('the Python client over a stub server', () => {
  it('converts, queues, polls and downloads through the generated package', async () => {
    const { stdout } = await promisify(execFile)(python!, ['-I', '-B', '-c', SCRIPT, SDK_PYTHON_DIR, baseUrl, API_KEY]);
    expect(JSON.parse(stdout)).toEqual({
      converted: ['f1', 'json'],
      queued: ['job_1', '/api/v1/jobs/job_1'],
      job: ['job_1', 'completed', '/api/storage/file/out-key'],
      download: [...RESULT_BYTES],
      failure: [404, 'No such job.'],
    });
    const [sync, queued] = requests;
    expect(sync.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(sync.body).toContain('name="targetFormat"');
    expect(sync.body).toContain('filename="a.csv"');
    expect(sync.body).toContain('{"quality": 80}');
    expect(queued.headers.prefer).toBe('respond-async');
    expect(queued.body).toContain('whsec_test');
  }, 60_000);
});
