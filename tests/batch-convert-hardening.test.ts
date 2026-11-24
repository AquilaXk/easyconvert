import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { create7zArchive, create7zArchiveAsync, createZipArchive, extractZipArchive } from '../src/lib/conversions/archive';
import { sevenZipReadPasswordInput } from '../src/lib/conversions/archive-password';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { syncSlotsInUse } from '../src/lib/queue/concurrency-limit';
import {
  ConversionFailedError,
  CpuTaskAbortedError,
  EncryptedOfficeDocumentError,
  EngineMissingError,
  FileExtensionSpoofError,
  PayloadLimitError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const BASE_URL = 'http://localhost:3000';
const CSV_BODY = 'name,score\nAlice,100\nBob,95\n';
const dispatchMock = vi.mocked(dispatchConversion);

interface CallerAccount {
  id: string;
  key: string;
}

async function createCaller(tier: 'free' | 'paid'): Promise<CallerAccount> {
  const user = await userStore.createUser({
    emailVerified: true,
    email: `batch_harden_${tier}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@easyconvert.local`,
    name: `Batch Hardening ${tier}`,
    tier,
  });
  if (tier === 'paid') {
    await redisKeyStore.creditPackage(user.id, {
      transactionId: `txn_${user.id}`,
      credits: 1000,
      paid: '0',
      at: Date.now(),
    });
  }
  const key = await redisKeyStore.generateApiKey(user.id, 'Batch Hardening Key', {
    scopes: ['convert:write', 'convert:read'],
  });
  return { id: user.id, key: key.secretKey };
}

function makeCsvBatchForm(count: number, onError?: 'fail' | 'continue'): FormData {
  const form = new FormData();
  for (let i = 0; i < count; i++) {
    form.append('files', new Blob([CSV_BODY], { type: 'text/csv' }), `item_${i}.csv`);
  }
  form.append('targetFormats', JSON.stringify({ default: 'json' }));
  if (onError) form.append('onError', onError);
  return form;
}

function makeNamedCsvBatchForm(names: readonly string[], onError: 'fail' | 'continue' = 'continue'): FormData {
  const form = new FormData();
  for (const name of names) {
    form.append('files', new Blob([CSV_BODY], { type: 'text/csv' }), name);
  }
  form.append('targetFormats', JSON.stringify({ default: 'json' }));
  form.append('onError', onError);
  return form;
}

function makeSingleCsvForm(name = 'single.csv'): FormData {
  const form = new FormData();
  form.append('file', new Blob([CSV_BODY], { type: 'text/csv' }), name);
  form.append('targetFormat', 'json');
  return form;
}

function postBatch(body: FormData, key: string): NextRequest {
  return new NextRequest(`${BASE_URL}/api/convert/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body,
  });
}

function postSingle(body: FormData, key: string): NextRequest {
  return new NextRequest(`${BASE_URL}/api/convert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body,
  });
}

beforeEach(async () => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
  const actual = await vi.importActual<typeof import('../src/lib/conversions/dispatch')>('../src/lib/conversions/dispatch');
  dispatchMock.mockImplementation(actual.dispatchConversion);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/api/convert/batch file count limit', () => {
  it('rejects 101 files with HTTP 400 and code too_many_files', async () => {
    const caller = await createCaller('paid');
    const res = await batchPost(postBatch(makeCsvBatchForm(101), caller.key));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('too_many_files');
    expect(body.error).toContain('100');
    expect(body.error).toContain('101');
  });

  it('converts a 100-file batch of valid CSVs into a ZIP archive', async () => {
    const caller = await createCaller('paid');
    const res = await batchPost(postBatch(makeCsvBatchForm(100), caller.key));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zipBuffer = Buffer.from(await res.arrayBuffer());
    const extracted = await extractZipArchive(zipBuffer);
    expect(extracted).toHaveLength(100);
  });
});

describe('/api/convert/batch per-worker concurrency slot charging', () => {
  it('holds 4 sync slots during a 4-file batch and releases all slots upon completion', async () => {
    const caller = await createCaller('free');
    const releaseHolders: Array<() => void> = [];
    let started = 0;

    dispatchMock.mockImplementation(async (_buf, _src, _tgt, _opts, originalFilename) => {
      started += 1;
      await new Promise<void>((resolve) => releaseHolders.push(resolve));
      return {
        buffer: Buffer.from('[{"name":"Alice","score":100}]'),
        size: 30,
        mimeType: 'application/json',
        filename: (originalFilename ?? 'item.csv').replace(/\.csv$/, '.json'),
        engineUsed: 'internal-fallback',
        executionTimeMs: 1,
      };
    });

    expect(syncSlotsInUse()).toBe(0);
    const batchPromise = batchPost(postBatch(makeCsvBatchForm(4), caller.key));

    try {
      const deadline = Date.now() + 5_000;
      while (started < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(started).toBe(4);
      expect(syncSlotsInUse()).toBe(4);
    } finally {
      for (const release of releaseHolders.splice(0)) release();
    }

    const res = await batchPromise;
    expect(res.status).toBe(200);
    expect(syncSlotsInUse()).toBe(0);
  });

  it('caps workerCount to available slots (4 held + 1 batch worker = 5) and returns 429 to a 6th request', async () => {
    const caller = await createCaller('free');
    const waitingByName: Array<{ filename: string; release: () => void }> = [];
    let started = 0;

    dispatchMock.mockImplementation(async (_buf, _src, _tgt, _opts, originalFilename) => {
      started += 1;
      await new Promise<void>((resolve) => waitingByName.push({ filename: originalFilename ?? '', release: resolve }));
      return {
        buffer: Buffer.from('[{"name":"Alice","score":100}]'),
        size: 30,
        mimeType: 'application/json',
        filename: (originalFilename ?? 'item.csv').replace(/\.csv$/, '.json'),
        engineUsed: 'internal-fallback',
        executionTimeMs: 1,
      };
    });

    // Hold 4 of 5 slots via in-flight /api/convert requests.
    const heldSingles = Array.from({ length: 4 }, (_, i) =>
      convertPost(postSingle(makeSingleCsvForm(`held_${i}.csv`), caller.key))
    );
    let batchPromise: Promise<Response> | undefined;
    try {
      const stopSingles = Date.now() + 5_000;
      while (started < 4 && Date.now() < stopSingles) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(started).toBe(4);
      expect(syncSlotsInUse()).toBe(4);

      // Start a 4-file batch: only 1 more slot is free, so workerCount is capped to 1 (total 5).
      batchPromise = batchPost(postBatch(makeCsvBatchForm(4), caller.key));
      const stopBatchFirst = Date.now() + 5_000;
      while (started < 5 && Date.now() < stopBatchFirst) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(started).toBe(5);
      expect(syncSlotsInUse()).toBe(5);

      // A 6th concurrent request for the same caller gets 429.
      const sixth = await convertPost(postSingle(makeSingleCsvForm('sixth.csv'), caller.key));
      expect(sixth.status).toBe(429);

      // Drain batch items sequentially through the single batch worker while the 4 singles stay held.
      for (let step = 0; step < 4; step++) {
        const targetStarted = 5 + step;
        const stopStep = Date.now() + 5_000;
        while (
          !waitingByName.some((entry) => entry.filename.startsWith('item_')) &&
          Date.now() < stopStep
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(started).toBe(targetStarted);
        expect(syncSlotsInUse()).toBe(5);
        const batchEntryIdx = waitingByName.findIndex((entry) => entry.filename.startsWith('item_'));
        expect(batchEntryIdx).toBeGreaterThanOrEqual(0);
        const [batchEntry] = waitingByName.splice(batchEntryIdx, 1);
        batchEntry!.release();
      }

      const batchRes = await batchPromise;
      expect(batchRes.status).toBe(200);
      expect(syncSlotsInUse()).toBe(4);
    } finally {
      for (const entry of waitingByName.splice(0)) entry.release();
      await Promise.allSettled([...heldSingles, ...(batchPromise ? [batchPromise] : [])]);
    }
    expect(syncSlotsInUse()).toBe(0);
  });
});

describe('/api/convert/batch onError continue error masking', () => {
  const SANDBOX_CRASH_PATH = path.join(os.tmpdir(), 'sandbox_77', 'secret.docx');
  const ENGINE_BIN_PATH = '/usr/bin/soffice';

  function installMixedFailuresMock() {
    dispatchMock.mockImplementation(async (buf, src, tgt, opts, originalFilename) => {
      switch (originalFilename) {
        case 'untyped.csv':
          throw new Error(`worker crash at ${SANDBOX_CRASH_PATH}`);
        case 'engine.csv':
          throw new EngineMissingError(`${ENGINE_BIN_PATH} missing`);
        case 'aborted.csv':
          throw new CpuTaskAbortedError('pdf');
        case 'spoof.csv':
          throw new FileExtensionSpoofError(`Spoofed signature in ${SANDBOX_CRASH_PATH}`);
        case 'encrypted.csv':
          throw new EncryptedOfficeDocumentError('The DOCX file is encrypted or password protected.');
        case 'limit.csv':
          throw new PayloadLimitError('Row count exceeds 100000.');
        default: {
          const actual = await vi.importActual<typeof import('../src/lib/conversions/dispatch')>(
            '../src/lib/conversions/dispatch'
          );
          return actual.dispatchConversion(buf, src, tgt, opts, originalFilename);
        }
      }
    });
  }

  function assertMaskedFailures(failures: Array<{ filename: string; error: string }>) {
    const byName = new Map(failures.map((entry) => [entry.filename, entry.error]));
    expect(byName.get('untyped.csv')).toBe('Internal conversion error');
    expect(byName.get('engine.csv')).toBe('Internal conversion error');
    expect(byName.get('aborted.csv')).toBe('Internal conversion error');

    expect(byName.get('spoof.csv')).toContain('Spoofed signature');
    expect(byName.get('spoof.csv')).not.toContain('sandbox_77');
    expect(byName.get('encrypted.csv')).toBe('The DOCX file is encrypted or password protected.');
    expect(byName.get('limit.csv')).toBe('Row count exceeds 100000.');

    const joined = JSON.stringify(failures);
    expect(joined).not.toContain('sandbox_77');
    expect(joined).not.toContain(ENGINE_BIN_PATH);
  }

  it('masks untyped and >= 500 errors in _failures.json on partial success (200) while preserving < 500 refusals', async () => {
    installMixedFailuresMock();
    const caller = await createCaller('paid');
    const res = await batchPost(
      postBatch(
        makeNamedCsvBatchForm([
          'good.csv',
          'untyped.csv',
          'engine.csv',
          'aborted.csv',
          'spoof.csv',
          'encrypted.csv',
          'limit.csv',
        ]),
        caller.key
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Batch-Failed-Count')).toBe('6');
    const zipBuffer = Buffer.from(await res.arrayBuffer());
    const entries = await extractZipArchive(zipBuffer);
    const failuresEntry = entries.find((entry) => entry.filename === '_failures.json');
    expect(failuresEntry).toBeDefined();
    const failures = JSON.parse(failuresEntry!.buffer.toString('utf-8')) as Array<{ filename: string; error: string }>;
    expect(failures).toHaveLength(6);
    assertMaskedFailures(failures);
  });

  it('masks untyped and >= 500 errors in body.failures when all items fail (400)', async () => {
    installMixedFailuresMock();
    const caller = await createCaller('paid');
    const res = await batchPost(
      postBatch(
        makeNamedCsvBatchForm([
          'untyped.csv',
          'engine.csv',
          'aborted.csv',
          'spoof.csv',
          'encrypted.csv',
          'limit.csv',
        ]),
        caller.key
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.failures).toHaveLength(6);
    assertMaskedFailures(body.failures);
  });
});

describe('async encrypted archive creation off the event loop', () => {
  oracleTest(
    'createZipArchive with options.password builds an AES-256 ZIP without blocking event-loop ticks or leaking temp dirs',
    ['7z'],
    async () => {
      const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-hardening-zip-tmp-'));
      vi.stubEnv('TMPDIR', isolatedTmp);
      const sevenZip = requireOracleTool('7z');
      const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-hardening-zip-verify-'));
      const files = Array.from({ length: 120 }, (_, i) => ({
        filename: `nested/file_${i}.txt`,
        buffer: Buffer.from(`secret payload ${i}\n`.repeat(16), 'utf-8'),
      }));
      const password = 'Batch-Zip-Password-9';

      let ticks = 0;
      const mkdtempSpy = vi.spyOn(fs.promises, 'mkdtemp');
      const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');
      const timer = setInterval(() => {
        ticks += 1;
      }, 1);
      try {
        const result = await createZipArchive(files, { password }, 'encrypted_batch.zip');
        clearInterval(timer);

        expect(ticks).toBeGreaterThan(0);
        const mkdtempCall = mkdtempSpy.mock.calls.find(
          ([prefix]) => typeof prefix === 'string' && path.basename(prefix).startsWith('easyconvert-zip-create-')
        );
        expect(path.basename(String(mkdtempCall?.[0] ?? ''))).toMatch(/^easyconvert-zip-create-\d+-$/);
        const stagingCall = mkdirSpy.mock.calls.find(
          ([dir]) =>
            typeof dir === 'string' &&
            path.basename(dir) === 'staging' &&
            path.basename(path.dirname(dir)).startsWith('easyconvert-zip-create-')
        );
        expect(stagingCall?.[1]).toEqual({ recursive: true, mode: 0o700 });
        expect(result.filename).toBe('encrypted_batch.zip');
        expect(result.mimeType).toBe('application/zip');
        expect(result.size).toBe(result.buffer.length);

        const leftover = fs.readdirSync(isolatedTmp).filter((name) => name.startsWith('easyconvert-zip-create-'));
        expect(leftover).toEqual([]);

        const archivePath = path.join(verifyDir, 'out.zip');
        fs.writeFileSync(archivePath, result.buffer);
        const listing = execFileSync(sevenZip, ['l', '-slt', archivePath], {
          input: sevenZipReadPasswordInput(password),
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString('utf-8');
        expect(listing).toMatch(/Encrypted = \+/);
        expect(listing).toMatch(/Method = AES-256/);

        execFileSync(sevenZip, ['t', '-y', archivePath], {
          input: sevenZipReadPasswordInput(password),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        expect(() =>
          execFileSync(sevenZip, ['t', '-y', archivePath], {
            input: sevenZipReadPasswordInput(undefined),
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        ).toThrow();
      } finally {
        clearInterval(timer);
        fs.rmSync(isolatedTmp, { recursive: true, force: true });
        fs.rmSync(verifyDir, { recursive: true, force: true });
      }
    },
    60_000
  );

  oracleTest(
    'create7zArchiveAsync with options.password builds an encrypted 7z archive asynchronously and cleans temp dirs',
    ['7z'],
    async () => {
      const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-hardening-7z-tmp-'));
      vi.stubEnv('TMPDIR', isolatedTmp);
      const sevenZip = requireOracleTool('7z');
      const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-hardening-7z-verify-'));
      const files = Array.from({ length: 40 }, (_, i) => ({
        filename: `entry_${i}.txt`,
        buffer: Buffer.from(`secret 7z payload ${i}\n`.repeat(16), 'utf-8'),
      }));
      const password = 'Batch-7z-Password-9';

      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 1);
      try {
        const result = await create7zArchiveAsync(files, { password }, 'encrypted_batch.7z');
        clearInterval(timer);

        expect(ticks).toBeGreaterThan(0);
        expect(result.filename).toBe('encrypted_batch.7z');
        expect(result.mimeType).toBe('application/x-7z-compressed');

        const leftover = fs.readdirSync(isolatedTmp).filter((name) => name.startsWith('easyconvert-7z-create-'));
        expect(leftover).toEqual([]);

        const archivePath = path.join(verifyDir, 'out.7z');
        fs.writeFileSync(archivePath, result.buffer);
        execFileSync(sevenZip, ['t', '-y', archivePath], {
          input: sevenZipReadPasswordInput(password),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect(() =>
          execFileSync(sevenZip, ['l', '-slt', archivePath], {
            input: sevenZipReadPasswordInput(undefined),
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        ).toThrow();
      } finally {
        clearInterval(timer);
        fs.rmSync(isolatedTmp, { recursive: true, force: true });
        fs.rmSync(verifyDir, { recursive: true, force: true });
      }
    },
    60_000
  );

  it('create7zArchiveAsync does not silently skip falsy non-string passwords', async () => {
    await expect(
      create7zArchiveAsync([{ filename: 'a.txt', buffer: Buffer.from('x') }], { password: 0 as unknown as string }, 'bad.7z')
    ).rejects.toThrow(ConversionFailedError);
  });

  oracleTest('synchronous create7zArchive creates workDir with mode 0o700', ['7z'], () => {
    const mkdtempSyncSpy = vi.spyOn(fs, 'mkdtempSync');
    const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
    const result = create7zArchive(
      [{ filename: 'a.txt', buffer: Buffer.from('secret sync 7z') }],
      { password: 'Sync-7z-Password-9' },
      'sync_encrypted.7z'
    );
    expect(result.filename).toBe('sync_encrypted.7z');
    const mkdtempCall = mkdtempSyncSpy.mock.calls.find(
      ([prefix]) => typeof prefix === 'string' && path.basename(prefix).startsWith('easyconvert-7z-create-')
    );
    expect(path.basename(String(mkdtempCall?.[0] ?? ''))).toMatch(/^easyconvert-7z-create-\d+-$/);
    const stagingCall = mkdirSyncSpy.mock.calls.find(
      ([dir]) =>
        typeof dir === 'string' &&
        path.basename(dir) === 'staging' &&
        path.basename(path.dirname(dir)).startsWith('easyconvert-7z-create-')
    );
    expect(stagingCall?.[1]).toEqual({ recursive: true, mode: 0o700 });
  });
});
