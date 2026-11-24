import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { allConversionQueues } from '../src/lib/queue/conversion-queue';
import { storageProvider } from '../src/lib/storage';
import type { StoredObject } from '../src/lib/storage/types';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { FREE_DAILY_CREDITS, INLINE_JOB_PAYLOAD_MAX_BYTES, PLAN_MAX_FILE_BYTES } from '../src/lib/plan-limits';

const BASE_URL = 'http://localhost:3000';
const ROUTE_URL = `${BASE_URL}/api/queue/jobs`;
const CSV_BYTES = Buffer.from('name,score\nAlice,100\nBob,95\n', 'utf-8');
const PE_HEADER = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]);
const VALID_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf-8');

interface TestCaller {
  userId: string;
  apiKey: string;
}

const createdKeys: string[] = [];

async function createCaller(exhausted: boolean): Promise<TestCaller> {
  const email = `p107_${exhausted ? 'empty' : 'full'}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@prequota.test`;
  const user = await userStore.createUser({
    email,
    name: exhausted ? 'Exhausted User' : 'Funded User',
    tier: 'free',
    emailVerified: true,
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'P107 Test Key', { scopes: ['convert:write', 'convert:read'] });
  if (exhausted) {
    const deducted = await redisKeyStore.deductQuota(user.id, FREE_DAILY_CREDITS);
    expect(deducted.allowed).toBe(true);
    expect(deducted.remaining).toBe(0);
    expect((await redisKeyStore.getQuotaUsage(user.id)).remaining).toBe(0);
  }
  return { userId: user.id, apiKey: key.secretKey };
}

function jsonReq(apiKey: string, body: unknown): NextRequest {
  return new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function formReq(apiKey: string, build: (form: FormData) => void): NextRequest {
  const form = new FormData();
  build(form);
  return new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
}

function csvFile(name = 'scores.csv', content: Buffer | string = CSV_BYTES): File {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return new File([new Uint8Array(bytes)], name, { type: 'text/csv' });
}

function saveUserCsv(userId: string, name = 'scores.csv', bytes: Buffer = CSV_BYTES, mimeType = 'text/csv'): string {
  const key = `conversions/${userId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${name}`;
  storageProvider.saveObject(key, bytes, mimeType, name, 60_000);
  createdKeys.push(key);
  return key;
}

describe('POST /api/queue/jobs pre-quota validation and stored.release() cleanup', () => {
  let funded: TestCaller;
  let exhausted: TestCaller;

  beforeEach(async () => {
    funded = await createCaller(false);
    exhausted = await createCaller(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of createdKeys.splice(0)) {
      await storageProvider.deleteObject(key);
    }
  });

  function spySideEffects() {
    return {
      reserveQuota: vi.spyOn(redisKeyStore, 'reserveQuota'),
      initiateUpload: vi.spyOn(storageProvider, 'initiateMultipartUpload'),
      saveObject: vi.spyOn(storageProvider, 'saveObject'),
      enqueues: allConversionQueues.map((q) => vi.spyOn(q, 'add')),
    };
  }

  function expectZeroSideEffects(spies: ReturnType<typeof spySideEffects>) {
    expect(spies.reserveQuota).not.toHaveBeenCalled();
    expect(spies.initiateUpload).not.toHaveBeenCalled();
    expect(spies.saveObject).not.toHaveBeenCalled();
    for (const enqueue of spies.enqueues) expect(enqueue).not.toHaveBeenCalled();
  }

  describe('refuses invalid JSON, types, inputs, options, pairs, ownership and spoofs BEFORE quota or storage', () => {
    interface RefusalCase {
      label: string;
      expectedStatus: number;
      expectedCode?: string;
      makeRequest: (caller: TestCaller) => NextRequest;
    }

    const cases: RefusalCase[] = [
      {
        label: 'non-object JSON array',
        expectedStatus: 400,
        makeRequest: (c) => jsonReq(c.apiKey, []),
      },
      {
        label: 'non-string filename',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 123,
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'non-string originalFilename',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            originalFilename: { name: 'scores.csv' },
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'overlong filename (> 1024 chars)',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: `${'a'.repeat(1022)}.csv`,
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'non-string targetFormat',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 42,
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'empty targetFormat',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: '   ',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'non-string storageKey',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            storageKey: 999,
          }),
      },
      {
        label: 'blank storageKey',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            storageKey: '   ',
          }),
      },
      {
        label: 'non-string inputBufferBase64',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            inputBufferBase64: [1, 2, 3],
          }),
      },
      {
        label: 'empty string inputBufferBase64',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            inputBufferBase64: '',
          }),
      },
      {
        label: 'empty decoded inputBufferBase64',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            inputBufferBase64: '====',
          }),
      },
      {
        label: 'negative fileSize',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            fileSize: -5,
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'non-number fileSize',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            fileSize: '128',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'non-string sourceFormat',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            sourceFormat: 100,
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'overlong sourceFormat (> 64 chars)',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            sourceFormat: 'x'.repeat(65),
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'JSON missing both storageKey and inputBufferBase64',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
          }),
      },
      {
        label: 'multipart file sent as string',
        expectedStatus: 400,
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', 'not-a-file');
            form.append('targetFormat', 'json');
          }),
      },
      {
        label: 'multipart options sent as File',
        expectedStatus: 400,
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', csvFile());
            form.append('targetFormat', 'json');
            form.append('options', new File(['{}'], 'options.json', { type: 'application/json' }));
          }),
      },
      {
        label: 'multipart missing both file and storageKey',
        expectedStatus: 400,
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('targetFormat', 'json');
          }),
      },
      {
        label: 'multipart 0-byte file',
        expectedStatus: 400,
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', new File([], 'scores.csv', { type: 'text/csv' }));
            form.append('targetFormat', 'json');
          }),
      },
      {
        label: 'unknown targetFormat (JSON)',
        expectedStatus: 400,
        expectedCode: 'unsupported_pair',
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'notarealformat',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'unsupported format pair scores.csv -> mp3 (JSON)',
        expectedStatus: 400,
        expectedCode: 'unsupported_pair',
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'mp3',
            inputBufferBase64: CSV_BYTES.toString('base64'),
          }),
      },
      {
        label: 'unsupported format pair scores.csv -> mp3 (multipart)',
        expectedStatus: 400,
        expectedCode: 'unsupported_pair',
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', csvFile());
            form.append('targetFormat', 'mp3');
          }),
      },
      {
        label: 'invalid options { quality: 999 } (JSON)',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
            options: { quality: 999 },
          }),
      },
      {
        label: 'invalid options { quality: 999 } (multipart)',
        expectedStatus: 400,
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', csvFile());
            form.append('targetFormat', 'json');
            form.append('options', JSON.stringify({ quality: 999 }));
          }),
      },
      {
        label: 'invalid options.pages "abc" (JSON)',
        expectedStatus: 400,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'doc.pdf',
            targetFormat: 'png',
            inputBufferBase64: VALID_PDF.toString('base64'),
            options: { pages: 'abc' },
          }),
      },
      {
        label: 'invalid options.pages syntax "5-2" (multipart)',
        expectedStatus: 400,
        expectedCode: 'invalid_pages',
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', new File([new Uint8Array(VALID_PDF)], 'doc.pdf', { type: 'application/pdf' }));
            form.append('targetFormat', 'png');
            form.append('options', JSON.stringify({ pages: '5-2' }));
          }),
      },
      {
        label: 'missing storageKey (404)',
        expectedStatus: 404,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            storageKey: `conversions/${c.userId}/missing_object.csv`,
          }),
      },
      {
        label: 'spoofed inline base64 file',
        expectedStatus: 400,
        expectedCode: 'spoofed_file',
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'fake.pdf',
            targetFormat: 'png',
            inputBufferBase64: PE_HEADER.toString('base64'),
          }),
      },
      {
        label: 'spoofed multipart file',
        expectedStatus: 400,
        expectedCode: 'spoofed_file',
        makeRequest: (c) =>
          formReq(c.apiKey, (form) => {
            form.append('file', new File([new Uint8Array(PE_HEADER)], 'fake.pdf', { type: 'application/pdf' }));
            form.append('targetFormat', 'png');
          }),
      },
      {
        label: 'oversize inline base64 payload (> 32 MiB)',
        expectedStatus: 413,
        makeRequest: (c) =>
          jsonReq(c.apiKey, {
            filename: 'scores.csv',
            targetFormat: 'json',
            inputBufferBase64: 'A'.repeat(Math.ceil(((INLINE_JOB_PAYLOAD_MAX_BYTES + 3) * 4) / 3)),
          }),
      },
    ];

    it.each(cases)('returns $expectedStatus before 429 for exhausted caller: $label', async ({ expectedStatus, expectedCode, makeRequest }) => {
      const spies = spySideEffects();
      const res = await queueJobsPost(makeRequest(exhausted));
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(expectedStatus);
      if (expectedCode) expect(body.code).toBe(expectedCode);
      expect(body.success).toBe(false);
      expectZeroSideEffects(spies);
    });

    it.each(cases)('reserves 0 quota and stores 0 uploads for funded caller: $label', async ({ expectedStatus, expectedCode, makeRequest }) => {
      const spies = spySideEffects();
      const res = await queueJobsPost(makeRequest(funded));
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(expectedStatus);
      if (expectedCode) expect(body.code).toBe(expectedCode);
      expect(body.success).toBe(false);
      expectZeroSideEffects(spies);
      expect((await redisKeyStore.getQuotaUsage(funded.userId)).remaining).toBe(FREE_DAILY_CREDITS);
    });

    it('returns 404 before 429 on foreign storageKey and stores/reserves nothing', async () => {
      const foreignKey = saveUserCsv(funded.userId, 'secret.csv');
      const spies = spySideEffects();
      const res = await queueJobsPost(
        jsonReq(exhausted.apiKey, {
          filename: 'secret.csv',
          targetFormat: 'json',
          storageKey: foreignKey,
        })
      );
      expect(res.status).toBe(404);
      expectZeroSideEffects(spies);
    });

    it('returns 400 spoofed_file before 429 on spoofed stored object', async () => {
      const spoofedKey = saveUserCsv(exhausted.userId, 'fake.pdf', PE_HEADER, 'application/pdf');
      const spies = spySideEffects();
      const res = await queueJobsPost(
        jsonReq(exhausted.apiKey, {
          filename: 'fake.pdf',
          targetFormat: 'png',
          storageKey: spoofedKey,
        })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('spoofed_file');
      expectZeroSideEffects(spies);
    });

    it('returns 413 before 429 on stored object exceeding plan file limit', async () => {
      const key = saveUserCsv(exhausted.userId, 'big.csv');
      const real = await storageProvider.stat(key);
      vi.spyOn(storageProvider, 'stat').mockResolvedValue({ ...real!, size: PLAN_MAX_FILE_BYTES.free + 1 });
      const spies = spySideEffects();
      const res = await queueJobsPost(
        jsonReq(exhausted.apiKey, {
          filename: 'big.csv',
          targetFormat: 'json',
          storageKey: key,
        })
      );
      expect(res.status).toBe(413);
      expectZeroSideEffects(spies);
    });
  });

  describe('lazy multipart reading and pre-storage quota check', () => {
    it('does not call file.arrayBuffer() when multipart format pair is unsupported', async () => {
      const file = csvFile('scores.csv');
      const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer');
      const form = new FormData();
      form.append('file', file);
      form.append('targetFormat', 'mp3');
      const req = new NextRequest(ROUTE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${funded.apiKey}`,
          'Content-Type': 'multipart/form-data; boundary=lazy-test',
        },
      });
      Object.defineProperty(req, 'formData', { value: async () => form });

      const spies = spySideEffects();
      const res = await queueJobsPost(req);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('unsupported_pair');
      expect(arrayBufferSpy).not.toHaveBeenCalled();
      expectZeroSideEffects(spies);
    });

    it('reads only bounded ALTO prefix via file.slice() when an XML file has an unsupported target format', async () => {
      const xmlBytes = Buffer.from('<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"><Layout/></alto>', 'utf-8');
      const file = new File([new Uint8Array(xmlBytes)], 'ocr.xml', { type: 'application/xml' });
      const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer');
      const sliceSpy = vi.spyOn(file, 'slice');
      const form = new FormData();
      form.append('file', file);
      form.append('targetFormat', 'mp3');
      const req = new NextRequest(ROUTE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${funded.apiKey}`,
          'Content-Type': 'multipart/form-data; boundary=alto-slice-test',
        },
      });
      Object.defineProperty(req, 'formData', { value: async () => form });

      const spies = spySideEffects();
      const res = await queueJobsPost(req);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('unsupported_pair');
      expect(sliceSpy).toHaveBeenCalledTimes(1);
      expect(arrayBufferSpy).not.toHaveBeenCalled();
      expectZeroSideEffects(spies);
    });

    it('refuses targetFormat, storageKey, and sourceFormat sent as File fields before quota', async () => {
      for (const field of ['targetFormat', 'storageKey', 'sourceFormat'] as const) {
        const spies = spySideEffects();
        const res = await queueJobsPost(
          formReq(exhausted.apiKey, (form) => {
            form.append('file', csvFile());
            if (field !== 'targetFormat') form.append('targetFormat', 'json');
            form.append(field, new File(['json'], `${field}.txt`, { type: 'text/plain' }));
          })
        );
        expect(res.status, field).toBe(400);
        expect((await res.json()).error).toBe(`The "${field}" field must be text, not a file.`);
        expectZeroSideEffects(spies);
      }
    });

    it('normalizes valid options.page before enqueueing and rejects invalid options.page before quota', async () => {
      const spies = spySideEffects();
      const badRes = await queueJobsPost(
        jsonReq(exhausted.apiKey, {
          filename: 'doc.pdf',
          targetFormat: 'png',
          inputBufferBase64: VALID_PDF.toString('base64'),
          options: { page: 0 },
        })
      );
      expect(badRes.status).toBe(400);
      expectZeroSideEffects(spies);

      const okRes = await queueJobsPost(
        jsonReq(funded.apiKey, {
          filename: 'doc.pdf',
          targetFormat: 'png',
          inputBufferBase64: VALID_PDF.toString('base64'),
          options: { page: 2 },
        })
      );
      expect(okRes.status).toBe(200);
    });

    it('returns 429 quota_exceeded for a valid request from exhausted caller without writing to storageProvider', async () => {
      const initiateSpy = vi.spyOn(storageProvider, 'initiateMultipartUpload');
      const saveSpy = vi.spyOn(storageProvider, 'saveObject');

      const multipartRes = await queueJobsPost(
        formReq(exhausted.apiKey, (form) => {
          form.append('file', csvFile());
          form.append('targetFormat', 'json');
        })
      );
      expect(multipartRes.status).toBe(429);
      expect((await multipartRes.json()).type).toContain('quota-exceeded');

      const jsonRes = await queueJobsPost(
        jsonReq(exhausted.apiKey, {
          filename: 'scores.csv',
          targetFormat: 'json',
          inputBufferBase64: CSV_BYTES.toString('base64'),
        })
      );
      expect(jsonRes.status).toBe(429);
      expect((await jsonRes.json()).type).toContain('quota-exceeded');

      expect(initiateSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  describe('localObjectProblem deterministic stored.release() cleanup', () => {
    function spyStoredObject(key: string, mutate: (obj: StoredObject) => StoredObject): ReturnType<typeof vi.fn> {
      const releaseSpy = vi.fn<() => Promise<void>>(async () => undefined);
      const origGetObject = storageProvider.getObject.bind(storageProvider);
      vi.spyOn(storageProvider, 'getObject').mockImplementation(async (requestedKey) => {
        const obj = await origGetObject(requestedKey);
        if (!obj || requestedKey !== key) return obj;
        return mutate({ ...obj, release: releaseSpy });
      });
      return releaseSpy;
    }

    it('calls stored.release() when local stored object is valid (200)', async () => {
      const key = saveUserCsv(funded.userId, 'valid.csv');
      const releaseSpy = spyStoredObject(key, (obj) => obj);

      const res = await queueJobsPost(
        jsonReq(funded.apiKey, {
          filename: 'valid.csv',
          targetFormat: 'json',
          storageKey: key,
        })
      );
      expect(res.status).toBe(200);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('calls stored.release() when local stored object fails spoof check (400)', async () => {
      const key = saveUserCsv(funded.userId, 'fake.pdf', PE_HEADER, 'application/pdf');
      const releaseSpy = spyStoredObject(key, (obj) => obj);

      const res = await queueJobsPost(
        jsonReq(funded.apiKey, {
          filename: 'fake.pdf',
          targetFormat: 'png',
          storageKey: key,
        })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('spoofed_file');
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('calls stored.release() when local stored object buffer and filePath are unavailable (400)', async () => {
      const key = saveUserCsv(funded.userId, 'missing_bytes.csv');
      const releaseSpy = spyStoredObject(key, (obj) => ({
        ...obj,
        filePath: undefined,
        buffer: Buffer.alloc(0),
      }));

      const res = await queueJobsPost(
        jsonReq(funded.apiKey, {
          filename: 'missing_bytes.csv',
          targetFormat: 'json',
          storageKey: key,
        })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Stored object is unavailable.');
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });
  });
});
