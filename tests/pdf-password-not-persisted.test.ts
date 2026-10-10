import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { openPasswordOption, sealPasswordOption } from '../src/lib/queue/option-secrets';
import { SecretSealError } from '../src/lib/security/job-secret-seal';
import { POST as createJobPost } from '../src/app/api/v1/jobs/route';
import { graphScheduler } from '../src/lib/queue/graph';
import { enqueueGraphNodeJob, graphNodeJobId } from '../src/lib/queue/graph/node-jobs';
import { getQueueForResourceClass } from '../src/lib/queue/conversion-queue';
import { resolveNodeResourceClass } from '../src/lib/queue/resource-class';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { storageProvider } from '../src/lib/storage';
import { AES_256, pdftotext, plainPdf, qpdfCheckPasses, qpdfEncrypt, qpdfEncryptionReport } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * #683 and #571: the password of a protected PDF lives in memory for the job. It is never stored in the queue job
 * record (the form the queue persists), never logged, and never echoed in a response or an error body.
 *
 * The password below is a canary no other fixture or message contains, so a plain substring search over every
 * recorded surface proves the absence.
 */

const CANARY = 'Canary-Pw-7f3a91c2-d4e8';
const WRONG_CANARY = 'Wrong-Canary-5b1e08aa';
const BASE_URL = 'http://localhost:3000';

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext');

let counter = 0;

async function apiKeyHeaders(): Promise<Record<string, string>> {
  counter += 1;
  const user = await userStore.createUser({
    name: 'Password Canary Tester',
    email: `canary_${Date.now()}_${counter}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Canary key', { scopes: ['convert:write', 'convert:read'] });
  return { Authorization: `Bearer ${key.secretKey}` };
}

function convertForm(file: Buffer, options: Record<string, unknown>, filename = 'locked.pdf', target = 'txt'): FormData {
  const data = new FormData();
  data.append('file', new Blob([new Uint8Array(file)]), filename);
  data.append('targetFormat', target);
  data.append('options', JSON.stringify(options));
  return data;
}

/** Everything written to the console or to the standard streams while `run` executes. */
async function captureOutput<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
  };
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(record));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    record(String(chunk));
    return true;
  }) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    record(String(chunk));
    return true;
  }) as never);
  try {
    return { result: await run(), output: lines.join('\n') };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const POLL_MS = 20;
const SETTLE_TIMEOUT_MS = 20_000;

/** Runs a worker on the conversion queue until the job `jobId` is completed or failed. */
async function runWorkerUntilSettled(jobId: string): Promise<void> {
  const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
  try {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const state = (await conversionQueue.getJob(jobId))?.state;
      if (state === 'completed' || state === 'failed') return;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} did not settle, last state ${state}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await worker.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(toolsMissing)('the PDF password never reaches logs, job records or response bodies', () => {
  async function lockedPdf(): Promise<Buffer> {
    return qpdfEncrypt(await plainPdf(['Canary body text']), { variant: AES_256, userPassword: CANARY, ownerPassword: 'owner-secret-1' });
  }

  it('keeps the password out of the synchronous route output and logs', async () => {
    const headers = await apiKeyHeaders();
    const pdf = await lockedPdf();
    const { result, output } = await captureOutput(async () => {
      const ok = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: convertForm(pdf, { password: CANARY }) }));
      const wrong = await v1ConvertPost(
        new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: convertForm(pdf, { password: WRONG_CANARY }) })
      );
      return { ok, wrong };
    });

    expect(result.ok.status).toBe(200);
    expect(result.wrong.status).toBe(422);
    const bodies = JSON.stringify(await result.ok.json()) + JSON.stringify(await result.wrong.json());
    for (const secret of [CANARY, WRONG_CANARY]) {
      expect(bodies).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
  });

  it('seals the password in the queued job record and still converts with it in the worker', async () => {
    const headers = await apiKeyHeaders();
    const pdf = await lockedPdf();
    const accepted = await v1ConvertPost(
      new NextRequest(`${BASE_URL}/api/v1/convert`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'respond-async' },
        body: convertForm(pdf, { password: CANARY }),
      })
    );
    expect(accepted.status).toBe(202);
    const { jobId } = (await accepted.json()) as { jobId: string };

    const queued = await conversionQueue.getJob(jobId);
    expect(queued).toBeDefined();
    // The persisted record is the job data and its options as the queue serialises them.
    const persisted = JSON.stringify({ data: queued?.data, opts: queued?.opts });
    expect(persisted).not.toContain(CANARY);
    expect(queued?.data.options).not.toHaveProperty('password');
    expect(queued?.data.options).toHaveProperty('sealedPassword');

    const { output } = await captureOutput(() => runWorkerUntilSettled(jobId));

    const status = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers }), { params: { id: jobId } });
    const body = await status.json();
    expect(body).toMatchObject({ status: 'completed' });
    const finished = await conversionQueue.getJob(jobId);
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(JSON.stringify(finished?.logs ?? [])).not.toContain(CANARY);
    expect(JSON.stringify({ data: finished?.data, returnvalue: finished?.returnvalue })).not.toContain(CANARY);
    expect(output).not.toContain(CANARY);

    const resultKey = finished?.returnvalue?.resultKey as string;
    const stored = await storageProvider.getObject(resultKey);
    expect(stored?.buffer.toString('utf-8')).toContain('Canary body text');
  });

  it('reports a wrong password on a queued job as a 422 failure that does not echo it', async () => {
    const headers = await apiKeyHeaders();
    const pdf = await lockedPdf();
    const accepted = await v1ConvertPost(
      new NextRequest(`${BASE_URL}/api/v1/convert`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'respond-async' },
        body: convertForm(pdf, { password: WRONG_CANARY }),
      })
    );
    const { jobId } = (await accepted.json()) as { jobId: string };

    await runWorkerUntilSettled(jobId);

    const status = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers }), { params: { id: jobId } });
    const body = await status.json();
    expect(body).toMatchObject({ status: 'failed', failedStatus: 422, failedCode: 'PdfPasswordRequiredError', attemptsMade: 1 });
    const failed = await conversionQueue.getJob(jobId);
    expect(JSON.stringify(body)).not.toContain(WRONG_CANARY);
    expect(JSON.stringify({ data: failed?.data, logs: failed?.logs, failedReason: failed?.failedReason })).not.toContain(WRONG_CANARY);
  });
});

const USER_PROTECT_CANARY = 'Protect-User-Canary-4d81e6b0';
const OWNER_PROTECT_CANARY = 'Protect-Owner-Canary-c3a7f925';
const PROTECT_SECRETS = [USER_PROTECT_CANARY, OWNER_PROTECT_CANARY];

describe.skipIf(toolsMissing)('the passwords a PDF is protected with are never stored or logged', () => {
  const protectOptions = { protect: { userPassword: USER_PROTECT_CANARY, ownerPassword: OWNER_PROTECT_CANARY, keyLength: 256 } };
  const source = Buffer.from('Protected body text\n', 'utf-8');

  function protectedOutput(buffer: Buffer): void {
    expect(qpdfEncryptionReport(buffer, USER_PROTECT_CANARY)).toMatchObject({ encrypted: true, userPasswordMatched: true });
    expect(qpdfEncryptionReport(buffer, OWNER_PROTECT_CANARY).ownerPasswordMatched).toBe(true);
    expect(qpdfCheckPasses(buffer, USER_PROTECT_CANARY)).toBe(true);
  }

  it('keeps them out of the synchronous route output and logs while still protecting the file', async () => {
    const headers = await apiKeyHeaders();
    const { result, output } = await captureOutput(() =>
      v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: convertForm(source, protectOptions, 'note.txt', 'pdf') }))
    );
    expect(result.status).toBe(200);
    const body = (await result.json()) as { dataUri: string };
    const pdf = Buffer.from(body.dataUri.split(',')[1], 'base64');
    protectedOutput(pdf);
    for (const secret of PROTECT_SECRETS) {
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
  });

  it('seals them in the queued job record, and the worker still protects the output', async () => {
    const headers = await apiKeyHeaders();
    const accepted = await v1ConvertPost(
      new NextRequest(`${BASE_URL}/api/v1/convert`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'respond-async' },
        body: convertForm(source, protectOptions, 'note.txt', 'pdf'),
      })
    );
    expect(accepted.status).toBe(202);
    const { jobId } = (await accepted.json()) as { jobId: string };
    const queued = await conversionQueue.getJob(jobId);
    const persisted = JSON.stringify({ data: queued?.data, opts: queued?.opts });
    for (const secret of PROTECT_SECRETS) expect(persisted).not.toContain(secret);
    expect(queued?.data.options.protect).toMatchObject({ keyLength: 256 });
    expect(queued?.data.options.protect).toHaveProperty('sealedPasswords');

    const { output } = await captureOutput(() => runWorkerUntilSettled(jobId));
    const finished = await conversionQueue.getJob(jobId);
    expect(finished?.state).toBe('completed');
    const status = JSON.stringify(await (await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers }), { params: { id: jobId } })).json());
    const surfaces = [status, output, JSON.stringify(finished?.logs ?? []), JSON.stringify({ data: finished?.data, returnvalue: finished?.returnvalue })];
    for (const secret of PROTECT_SECRETS) for (const surface of surfaces) expect(surface).not.toContain(secret);

    const stored = await storageProvider.getObject(finished?.returnvalue?.resultKey as string);
    protectedOutput(stored?.buffer as Buffer);
    expect(pdftotext(stored?.buffer as Buffer, USER_PROTECT_CANARY)).toContain('Protected body text');
  });

  it('seals them in the stored graph and the queued node job, in the nested and the flat form of a pdf.protect node', async () => {
    const headers = await apiKeyHeaders();
    s3Storage.saveObject('uploads/protect-graph.pdf', Buffer.from('%PDF-1.4'), 'application/pdf', 'protect-graph.pdf');
    const graph = {
      nodes: {
        src: { op: 'import.upload', storageKey: 'uploads/protect-graph.pdf' },
        nested: { op: 'pdf.protect', input: 'src', options: protectOptions },
        flat: { op: 'pdf.protect', input: 'src', options: { userPassword: USER_PROTECT_CANARY, ownerPassword: OWNER_PROTECT_CANARY } },
        out: { op: 'export.internal', input: ['nested', 'flat'] },
      },
    };
    const res = await createJobPost(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'protect-graph.pdf', targetFormat: 'pdf', storageKey: 'uploads/protect-graph.pdf', graph }),
      })
    );
    const created = await res.clone().text();
    expect(res.status, created).toBe(202);
    const { jobId } = JSON.parse(created) as { jobId: string };

    const state = await graphScheduler.getGraphState(jobId);
    const stored = JSON.stringify(state);
    for (const secret of PROTECT_SECRETS) expect(stored).not.toContain(secret);
    expect(stored).toContain('sealedProtectPasswords');
    expect(stored).toContain('sealedPasswords');

    const nodes = (state as unknown as { graph: { nodes: Record<string, never> } }).graph.nodes;
    for (const nodeId of ['nested', 'flat']) {
      await enqueueGraphNodeJob(jobId, nodeId, nodes[nodeId], { ownerUserId: 'protect-canary-owner' }, []);
      const queued = await getQueueForResourceClass(resolveNodeResourceClass(nodes[nodeId])).getJob(graphNodeJobId(jobId, nodeId));
      const persisted = JSON.stringify({ data: queued?.data, opts: queued?.opts });
      for (const secret of PROTECT_SECRETS) expect(persisted).not.toContain(secret);
    }
    const status = JSON.stringify(await (await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers }), { params: { id: jobId } })).json());
    for (const secret of PROTECT_SECRETS) expect(status).not.toContain(secret);
  });
});

describe('the password of a graph node is sealed in the stored graph and in the queued node job', () => {
  const NODE_CANARY = 'Node-Canary-Pw-0b6e44d1';
  const MERGE_CANARY = 'Merge-Canary-Pw-9a2f17c3';

  it('keeps node passwords out of graph state, node job data and the status response', async () => {
    const headers = await apiKeyHeaders();
    s3Storage.saveObject('uploads/canary-graph.pdf', Buffer.from('%PDF-1.4'), 'application/pdf', 'canary-graph.pdf');
    const graph = {
      nodes: {
        src: { op: 'import.upload', storageKey: 'uploads/canary-graph.pdf' },
        src2: { op: 'import.upload', storageKey: 'uploads/canary-graph.pdf' },
        mark: { op: 'pdf.watermark', input: 'src', options: { password: NODE_CANARY, confirmEditRights: true, watermark: { text: 'X' } } },
        joined: { op: 'merge', input: ['mark', 'src2'], targetFormat: 'pdf', options: { passwords: [null, MERGE_CANARY] } },
        out: { op: 'export.internal', input: 'joined' },
      },
    };
    const res = await createJobPost(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'canary-graph.pdf', targetFormat: 'pdf', storageKey: 'uploads/canary-graph.pdf', graph }),
      })
    );
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    const state = await graphScheduler.getGraphState(jobId);
    const stored = JSON.stringify(state);
    for (const secret of [NODE_CANARY, MERGE_CANARY]) expect(stored).not.toContain(secret);
    expect(stored).toContain('sealedPassword');

    // The scheduler enqueues a node once its inputs are done; enqueue the two password-bearing nodes the same way.
    const nodes = (state as unknown as { graph: { nodes: Record<string, never> } }).graph.nodes;
    for (const nodeId of ['mark', 'joined']) {
      await enqueueGraphNodeJob(jobId, nodeId, nodes[nodeId], { ownerUserId: 'canary-owner' }, []);
      const queued = await getQueueForResourceClass(resolveNodeResourceClass(nodes[nodeId])).getJob(graphNodeJobId(jobId, nodeId));
      expect(JSON.stringify({ data: queued?.data, opts: queued?.opts })).not.toContain(NODE_CANARY);
      expect(JSON.stringify({ data: queued?.data, opts: queued?.opts })).not.toContain(MERGE_CANARY);
    }

    const status = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers }), { params: { id: jobId } });
    const body = JSON.stringify(await status.json());
    for (const secret of [NODE_CANARY, MERGE_CANARY]) expect(body).not.toContain(secret);
  });
});

describe('sealing of the password option', () => {
  it('replaces the password by a blob only the same job opens', () => {
    const sealed = sealPasswordOption({ password: CANARY, dpi: 150 }, 'job_a');
    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(sealed).toMatchObject({ dpi: 150 });
    expect(openPasswordOption(sealed, 'job_a')).toEqual({ password: CANARY, dpi: 150 });
    expect(() => openPasswordOption(sealed, 'job_b')).toThrow(SecretSealError);
  });

  it('seals the per-input passwords of a merge node and opens them for the same job only', () => {
    const sealed = sealPasswordOption({ passwords: [CANARY, null, ''], confirmEditRights: true }, 'job_a');
    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(sealed).not.toHaveProperty('passwords');
    expect(openPasswordOption(sealed, 'job_a')).toEqual({ passwords: [CANARY, null, ''], confirmEditRights: true });
    expect(() => openPasswordOption(sealed, 'job_b')).toThrow(SecretSealError);
  });

  it('seals the protect passwords, nested and flat, and opens them for the same job only', () => {
    const nested = sealPasswordOption({ protect: { userPassword: CANARY, ownerPassword: 'o-' + CANARY, keyLength: 256 } }, 'job_a');
    expect(JSON.stringify(nested)).not.toContain(CANARY);
    expect(nested).toMatchObject({ protect: { keyLength: 256 } });
    expect(openPasswordOption(nested, 'job_a')).toEqual({ protect: { userPassword: CANARY, ownerPassword: 'o-' + CANARY, keyLength: 256 } });
    expect(() => openPasswordOption(nested, 'job_b')).toThrow(SecretSealError);

    const flat = sealPasswordOption({ userPassword: CANARY, keyLength: 128 }, 'job_a');
    expect(JSON.stringify(flat)).not.toContain(CANARY);
    expect(openPasswordOption(flat, 'job_a')).toEqual({ userPassword: CANARY, keyLength: 128 });
    expect(() => openPasswordOption(flat, 'job_b')).toThrow(SecretSealError);
  });

  it('leaves options without a password, and an empty password, untouched', () => {
    expect(sealPasswordOption({ dpi: 150 }, 'job_a')).toEqual({ dpi: 150 });
    expect(sealPasswordOption({ password: '' }, 'job_a')).toEqual({ password: '' });
    expect(sealPasswordOption(undefined, 'job_a')).toBeUndefined();
  });
});
