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
import { storageProvider } from '../src/lib/storage';
import { AES_256, plainPdf, qpdfEncrypt } from './helpers/encrypted-pdf-fixtures';
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

function convertForm(file: Buffer, options: Record<string, unknown>): FormData {
  const data = new FormData();
  data.append('file', new Blob([new Uint8Array(file)]), 'locked.pdf');
  data.append('targetFormat', 'txt');
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

describe('sealing of the password option', () => {
  it('replaces the password by a blob only the same job opens', () => {
    const sealed = sealPasswordOption({ password: CANARY, dpi: 150 }, 'job_a');
    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(sealed).toMatchObject({ dpi: 150 });
    expect(openPasswordOption(sealed, 'job_a')).toEqual({ password: CANARY, dpi: 150 });
    expect(() => openPasswordOption(sealed, 'job_b')).toThrow(SecretSealError);
  });

  it('leaves options without a password, and an empty password, untouched', () => {
    expect(sealPasswordOption({ dpi: 150 }, 'job_a')).toEqual({ dpi: 150 });
    expect(sealPasswordOption({ password: '' }, 'job_a')).toEqual({ password: '' });
    expect(sealPasswordOption(undefined, 'job_a')).toBeUndefined();
  });
});
