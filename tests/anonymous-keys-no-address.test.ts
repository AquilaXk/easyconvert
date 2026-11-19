import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as archiveExtractRoute } from '../src/app/api/tools/archive-extract/route';
import { POST as toolJobRoute } from '../src/app/api/tools/jobs/route';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { startConversionWorker, stopConversionWorker } from '../src/lib/queue/conversion-queue';
import { dispatchSyncRouteConversion, dispatchSyncWebTool } from '../src/lib/queue/wait-for-job';
import { resetLocalLiveWorkersForTests } from '../src/lib/queue/worker-presence';
import { storageProvider } from '../src/lib/storage';
import { resultKey, stagedInputKey } from '../src/lib/storage/key-namespace';
import { getToolJob } from '../src/lib/tools/tool-job-store';
import { storeQueuedToolOutput } from '../src/lib/tools/queued-tool-runner';
import { fileOutput } from '../src/lib/tools/web-tools';

/**
 * No storage key and no download URL names the address of an anonymous caller (docs/policy-decisions.md, entry 137): the address
 * can change between two requests of one visitor, and a key is shown to the visitor and logged. An anonymous caller's retained result
 * is under `conversions/anon:result/` (reachable by its random name, as every anonymous result is), and the input a route stages
 * for a worker is in the ownerless `uploads/` namespace, as every upload of an anonymous caller is.
 */
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let nextClient = 1;

function visitorAddress(): string {
  return `203.0.113.${100 + nextClient++}`;
}

async function pdfWith(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 300]);
  return Buffer.from(await doc.save());
}

function savedKeys(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the key of what an anonymous caller stores', () => {
  it('keeps an account under its own prefix and an anonymous caller under a constant owner', () => {
    expect(resultKey('user_1', 'a.pdf')).toBe('conversions/user_1/a.pdf');
    expect(resultKey(anonymousUserId('203.0.113.9'), 'a.pdf')).toBe('conversions/anon:result/a.pdf');
    expect(stagedInputKey('user_1', 'sync_a.pdf')).toBe('uploads/user_1/sync_a.pdf');
    expect(stagedInputKey(anonymousUserId('203.0.113.9'), 'sync_a.pdf')).toBe('uploads/sync_a.pdf');
  });

  it('answers a synchronous tool run with keys and URLs that do not name the address', async () => {
    const address = visitorAddress();
    const zip = new JSZip();
    zip.file('one.txt', 'one');
    zip.file('two.txt', 'two');
    const form = new FormData();
    form.append('files', new File([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))], 'two.zip'));
    const response = await archiveExtractRoute(new NextRequest('http://localhost/api/tools/archive-extract', { method: 'POST', headers: { 'x-forwarded-for': address }, body: form }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: { key: string; url: string }[] };
    expect(body.entries).toHaveLength(2);
    for (const { key, url } of body.entries) {
      expect(key + url).not.toContain(address);
      expect(key).toMatch(/^conversions\/anon:result\//);
      expect(await storageProvider.stat(key)).toBeTruthy();
    }
  });

  it('answers an asynchronous tool job with a result key that does not name the address', async () => {
    const address = visitorAddress();
    const form = new FormData();
    form.append('tool', 'merge');
    for (const name of ['a.pdf', 'b.pdf']) form.append('files', new File([new Uint8Array(await pdfWith(1))], name));
    const created = await toolJobRoute(new NextRequest('http://localhost/api/tools/jobs', { method: 'POST', headers: { 'x-forwarded-for': address }, body: form }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    let job = await getToolJob(id);
    for (let attempt = 0; attempt < 200 && job?.status !== 'completed'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = await getToolJob(id);
    }
    expect(job?.status).toBe('completed');
    const result = job?.result;
    expect(result?.kind).toBe('file');
    const file = (result as { kind: 'file'; file: { key: string; url: string } }).file;
    expect(file.key + file.url).not.toContain(address);
    expect(file.key).toMatch(/^conversions\/anon:result\//);
  });

  it('stores the output of a queued tool run of an anonymous caller without the address', async () => {
    const address = visitorAddress();
    const stored = await storeQueuedToolOutput(storageProvider, fileOutput('out.pdf', 'application/pdf', await pdfWith(1)), anonymousUserId(address));
    const { key, url } = (stored as { kind: 'file'; file: { key: string; url: string } }).file;
    expect(key + url).not.toContain(address);
    expect(key).toMatch(/^conversions\/anon:result\//);
  });
});

describe('the key of what a web route stages for a queue worker (queue-only)', () => {
  beforeEach(() => {
    resetLocalLiveWorkersForTests();
    vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
    startConversionWorker({ concurrency: 2 });
  });
  afterEach(async () => {
    await stopConversionWorker();
    resetLocalLiveWorkersForTests();
  });

  it('stages the input of a synchronous conversion of an anonymous caller in the ownerless namespace', async () => {
    const address = visitorAddress();
    const save = vi.spyOn(storageProvider, 'saveObject');
    const converted = await dispatchSyncRouteConversion({
      inputBuffer: PIXEL_PNG,
      sourceFormat: 'png',
      targetFormat: 'bmp',
      options: {},
      originalFilename: 'pixel.png',
      userId: anonymousUserId(address),
      tier: 'free',
    });
    expect(converted.buffer.subarray(0, 2).toString('latin1')).toBe('BM');
    const keys = savedKeys(save);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).not.toContain(address);
    expect(keys[0]).toMatch(/^uploads\/sync_/);
  });

  it('stages the inputs of a synchronous tool run of an anonymous caller in the ownerless namespace', async () => {
    const address = visitorAddress();
    const save = vi.spyOn(storageProvider, 'saveObject');
    const output = await dispatchSyncWebTool({
      tool: 'merge',
      files: [
        { name: 'a.pdf', buffer: await pdfWith(1) },
        { name: 'b.pdf', buffer: await pdfWith(1) },
      ],
      options: {},
      userId: anonymousUserId(address),
      tier: 'free',
    });
    expect(output.kind).toBe('file');
    const keys = savedKeys(save);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).not.toContain(address);
  });
});
