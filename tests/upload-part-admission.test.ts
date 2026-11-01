import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { POST as v1UploadsPost } from '../src/app/api/v1/uploads/[[...id]]/route';
import { PUT as directPartPut } from '../src/app/api/v1/uploads/direct/part/route';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { globalSharedObjects } from '../src/lib/storage/shared-store';
import { localFsStorage } from '../src/lib/storage/local-fs-storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { forgetUploadParts, receivePart, type PartStore } from '../src/lib/storage/part-admission';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PART_BYTES = 5 * MIB;
const OK = 200;
const PAYLOAD_TOO_LARGE = 413;
const SERVICE_UNAVAILABLE = 503;
const NOT_FOUND = 404;
const INTERNAL_SERVER_ERROR = 500;

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

let visitorCount = 0;

function newVisitor(): Record<string, string> {
  visitorCount += 1;
  return { 'x-forwarded-for': `203.0.113.${100 + visitorCount}` };
}

async function openSession(headers: Record<string, string>, totalSize: number): Promise<{ uploadId: string; key: string }> {
  const res = await multipartPost(
    new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ filename: 'a.csv', mimeType: 'text/csv', totalSize, partSize: PART_BYTES }),
    })
  );
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(OK);
  cleanups.push(async () => {
    await s3Storage.abortMultipartUpload(body.uploadId);
    s3Storage.deleteObject(body.key);
  });
  return body;
}

function partRequest(uploadId: string, partNumber: number, bytes: Buffer, headers: Record<string, string>): NextRequest {
  return new NextRequest(
    `${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(bytes) }
  );
}

async function storedBytes(uploadId: string): Promise<number> {
  return ((await s3Storage.getUploadedParts(uploadId)) ?? []).reduce((sum, part) => sum + part.size, 0);
}

/** The bytes files in the session's directory: the stored parts, and any temporary file a refused part left. */
function sessionFiles(uploadId: string): string[] {
  const dir = path.join(globalSharedObjects.getStorageDir(), '.parts', uploadId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('part-') && !name.endsWith('.meta')).sort() : [];
}

function countOf(statuses: number[], status: number): number {
  return statuses.filter((value) => value === status).length;
}

describe('parts of one upload sent at once are held together to the size it declared', () => {
  it('stores one of six parts that each would fill a session declared at 5 MiB and refuses the others', async () => {
    const visitor = newVisitor();
    const { uploadId } = await openSession(visitor, PART_BYTES);

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => multipartPost(partRequest(uploadId, n, Buffer.alloc(PART_BYTES, 'x'), visitor)))
    );

    const statuses = results.map((res) => res.status);
    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    expect(countOf(statuses, PAYLOAD_TOO_LARGE), String(statuses)).toBe(5);
    expect(await storedBytes(uploadId)).toBe(PART_BYTES);
    expect(sessionFiles(uploadId)).toHaveLength(1);
  });

  it('refuses the parts that declare more than is left, before any byte of them is written', async () => {
    const visitor = newVisitor();
    const { uploadId } = await openSession(visitor, PART_BYTES);
    const declaring = { ...visitor, 'Content-Length': String(PART_BYTES) };

    const results = await Promise.all(
      [1, 2, 3].map((n) => multipartPost(partRequest(uploadId, n, Buffer.alloc(PART_BYTES, 'x'), declaring)))
    );

    const statuses = results.map((res) => res.status);
    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    const refusal = await results[statuses.indexOf(PAYLOAD_TOO_LARGE)].json();
    expect(refusal.detail).toBe(`This part would bring the upload to ${2 * PART_BYTES} bytes, past the ${PART_BYTES} bytes it declared.`);
    expect(await storedBytes(uploadId)).toBe(PART_BYTES);
  });

  it('answers a repeat of a part still on the way with 503 and Retry-After, and keeps the first attempt', async () => {
    const visitor = newVisitor();
    const { uploadId } = await openSession(visitor, PART_BYTES);

    const results = await Promise.all([1, 1].map((n) => multipartPost(partRequest(uploadId, n, Buffer.alloc(PART_BYTES, 'y'), visitor))));

    expect(results.map((res) => res.status).sort()).toEqual([OK, SERVICE_UNAVAILABLE]);
    const repeat = results.find((res) => res.status === SERVICE_UNAVAILABLE)!;
    expect(repeat.headers.get('retry-after')).toBe('5');
    expect((await repeat.json()).type).toBe('https://api.easyconvert.io/problems/part-in-flight');
    expect(await storedBytes(uploadId)).toBe(PART_BYTES);
  });

  /** A session of an account on local disk, and a sender of its parts through the public upload route. */
  async function publicUploadSession(): Promise<(partNumber: number) => Promise<Response>> {
    const email = `ledger_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@ledger.test`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'ledger', tier: 'free' }));
    const session = await localFsStorage.createMultipart(`uploads/ledger-${Date.now()}.csv`, undefined, { ownerUserId: user.id, totalSize: PART_BYTES });
    cleanups.push(() => {
      void localFsStorage.abortMultipart(session.key, session.uploadId);
    });
    return (partNumber) =>
      v1UploadsPost(
        new NextRequest(`${BASE_URL}/api/v1/uploads?action=part&uploadId=${session.uploadId}&partNumber=${partNumber}`, {
          method: 'POST',
          headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
          body: new Uint8Array(Buffer.alloc(PART_BYTES, 'w')),
        }),
        { params: Promise.resolve({ id: undefined }) }
      );
  }

  it('holds the parts of the public upload route to the declared size the same way', async () => {
    const send = await publicUploadSession();

    const statuses = (await Promise.all([1, 2, 3, 4].map(send))).map((res) => res.status);

    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    expect(countOf(statuses, PAYLOAD_TOO_LARGE), String(statuses)).toBe(3);
  });

  it('answers a part of the public upload route that failed without an HTTP status with 503 and a fixed sentence', async () => {
    const send = await publicUploadSession();
    vi.spyOn(localFsStorage, 'savePartStream').mockRejectedValueOnce(new Error('disk went away at /srv/easyconvert/data/part-1'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await send(1);

    expect(res.status).toBe(SERVICE_UNAVAILABLE);
    expect(res.headers.get('retry-after')).toBe('5');
    expect((await res.json()).detail).toBe('A service this upload needs is temporarily unavailable. Retry the request shortly.');
  });

  describe('an error of the operating system on a part', () => {
    const diskError = (code: string) =>
      Object.assign(new Error(`${code}: operation failed, open '/srv/easyconvert/data/part-1.bin'`), { code, syscall: 'open' });

    it('is a missing session when the files of the session are gone (404), on the public upload route', async () => {
      const send = await publicUploadSession();
      vi.spyOn(localFsStorage, 'savePartStream').mockRejectedValueOnce(diskError('ENOENT'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await send(1);

      expect(res.status).toBe(NOT_FOUND);
      expect((await res.json()).detail).toBe('Upload session not found or has expired.');
    });

    it('is a fixed 500 that names no path, whose message goes to the log, on the public upload route', async () => {
      const send = await publicUploadSession();
      vi.spyOn(localFsStorage, 'savePartStream').mockRejectedValueOnce(diskError('EACCES'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await send(1);
      const body = await res.json();

      expect(res.status).toBe(INTERNAL_SERVER_ERROR);
      expect(body.detail).toBe('Upload storage error');
      expect(JSON.stringify(body)).not.toContain('/srv/easyconvert');
      expect(logged.mock.calls.some(([message]) => String(message).includes('EACCES'))).toBe(true);
    });

    it('is answered the same when it comes from the read of the stored parts', async () => {
      const send = await publicUploadSession();
      vi.spyOn(localFsStorage, 'listPartSizes').mockRejectedValueOnce(diskError('ENOENT'));

      const res = await send(1);

      expect(res.status).toBe(NOT_FOUND);
    });

    it('is answered the same on the part action of /api/storage/multipart', async () => {
      const visitor = newVisitor();
      const { uploadId } = await openSession(visitor, PART_BYTES);
      vi.spyOn(s3Storage, 'uploadPartStream').mockRejectedValueOnce(diskError('EACCES'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await multipartPost(partRequest(uploadId, 1, Buffer.alloc(MIB, 'x'), visitor));

      expect(res.status).toBe(INTERNAL_SERVER_ERROR);
      expect(JSON.stringify(await res.json())).not.toContain('/srv/easyconvert');
    });
  });

  describe('a transient error of the operating system', () => {
    const TRANSIENT_CODES = ['EIO', 'EAGAIN', 'EBUSY', 'EINTR', 'EMFILE', 'ENFILE'] as const;
    const UNAVAILABLE_SENTENCE = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';
    const diskError = (code: string) =>
      Object.assign(new Error(`${code}: operation failed, open '/srv/easyconvert/data/part-1.bin'`), { code, syscall: 'open' });

    async function expectRetryable(res: Response): Promise<void> {
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(SERVICE_UNAVAILABLE);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(body.detail).toBe(UNAVAILABLE_SENTENCE);
      expect(JSON.stringify(body)).not.toContain('/srv/easyconvert');
    }

    /** An open session of a visitor holding all its bytes in one part, and the request that completes it. */
    async function sessionToComplete(): Promise<{ complete: () => Promise<Response>; abort: () => Promise<Response> }> {
      const visitor = newVisitor();
      const bytes = Buffer.from('a,b\n1,2\n');
      const { uploadId } = await openSession(visitor, bytes.length);
      const { etag } = await (await multipartPost(partRequest(uploadId, 1, bytes, visitor))).json();
      const action = (name: string, body: unknown) =>
        multipartPost(
          new NextRequest(`${BASE_URL}/api/storage/multipart?action=${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...visitor },
            body: JSON.stringify(body),
          })
        );
      return {
        complete: () => action('complete', { uploadId, parts: [{ partNumber: 1, etag }] }),
        abort: () => action('abort', { uploadId }),
      };
    }

    it('is 503 with Retry-After on the part action of /api/storage/multipart, so the browser sends the part again', async () => {
      const visitor = newVisitor();
      const { uploadId } = await openSession(visitor, PART_BYTES);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const code of TRANSIENT_CODES) {
        vi.spyOn(s3Storage, 'uploadPartStream').mockRejectedValueOnce(diskError(code));
        await expectRetryable(await multipartPost(partRequest(uploadId, 1, Buffer.alloc(MIB, 'x'), visitor)));
      }
    });

    it('is 503 with Retry-After on the public upload route', async () => {
      const send = await publicUploadSession();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const code of TRANSIENT_CODES) {
        vi.spyOn(localFsStorage, 'savePartStream').mockRejectedValueOnce(diskError(code));
        await expectRetryable(await send(1));
      }
    });

    it('is 503 with Retry-After on the signed part route', async () => {
      const init = await s3Storage.initiateMultipartUpload('d.csv', 'text/csv', PART_BYTES, 'user_parts', PART_BYTES);
      cleanups.push(async () => {
        await s3Storage.abortMultipartUpload(init.uploadId);
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const code of TRANSIENT_CODES) {
        vi.spyOn(s3Storage, 'uploadPartStream').mockRejectedValueOnce(diskError(code));
        const res = await directPartPut(
          new NextRequest(s3Storage.generatePresignedUploadUrl(init.key, 1, init.uploadId).url, { method: 'PUT', body: new Uint8Array(Buffer.alloc(MIB, 'z')) })
        );
        await expectRetryable(res);
      }
    });

    it('is 503 with Retry-After on the complete action, and the session stays open for the repeat', async () => {
      const { complete } = await sessionToComplete();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const code of TRANSIENT_CODES) {
        vi.spyOn(s3Storage, 'completeMultipartUpload').mockImplementationOnce(() => {
          throw diskError(code);
        });
        await expectRetryable(await complete());
      }
      expect((await complete()).status).toBe(OK);
    });

    it('is 503 with Retry-After on the abort action', async () => {
      const { abort } = await sessionToComplete();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const code of TRANSIENT_CODES) {
        vi.spyOn(s3Storage, 'abortMultipartUpload').mockImplementationOnce(() => {
          throw diskError(code);
        });
        await expectRetryable(await abort());
      }
    });

    it('is answered on complete and abort of /api/v1/uploads as on a part: 503 when it may pass, 404 for gone files, a fixed 500 otherwise', async () => {
      const email = `ledger_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@ledger.test`;
      const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'ledger', tier: 'free' }));
      const session = await localFsStorage.createMultipart(`uploads/ledger-${Date.now()}.csv`, undefined, { ownerUserId: user.id, totalSize: PART_BYTES });
      cleanups.push(() => {
        void localFsStorage.abortMultipart(session.key, session.uploadId);
      });
      const act = (name: string, body: unknown) =>
        v1UploadsPost(
          new NextRequest(`${BASE_URL}/api/v1/uploads?action=${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: `easyconvert_session=${createSessionToken(user)}` },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ id: undefined }) }
        );
      const complete = () => act('complete', { uploadId: session.uploadId, parts: [{ partNumber: 1, etag: 'e' }] });
      const abort = () => act('abort', { uploadId: session.uploadId });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      for (const code of TRANSIENT_CODES) {
        vi.spyOn(localFsStorage, 'completeMultipart').mockRejectedValueOnce(diskError(code));
        await expectRetryable(await complete());
        vi.spyOn(localFsStorage, 'abortMultipart').mockRejectedValueOnce(diskError(code));
        await expectRetryable(await abort());
      }
      vi.spyOn(localFsStorage, 'completeMultipart').mockRejectedValueOnce(diskError('ENOENT'));
      expect((await complete()).status).toBe(NOT_FOUND);
      vi.spyOn(localFsStorage, 'abortMultipart').mockRejectedValueOnce(diskError('EACCES'));
      expect((await abort()).status).toBe(INTERNAL_SERVER_ERROR);
    });
  });

  it('holds the parts of the signed part route to the declared size the same way', async () => {
    const init = await s3Storage.initiateMultipartUpload('b.csv', 'text/csv', PART_BYTES, 'user_parts', PART_BYTES);
    cleanups.push(async () => {
      await s3Storage.abortMultipartUpload(init.uploadId);
    });
    const send = (n: number) =>
      directPartPut(
        new NextRequest(s3Storage.generatePresignedUploadUrl(init.key, n, init.uploadId).url, {
          method: 'PUT',
          body: new Uint8Array(Buffer.alloc(PART_BYTES, 'z')),
        })
      );

    const statuses = (await Promise.all([1, 2, 3, 4].map(send))).map((res) => res.status);

    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    expect(countOf(statuses, PAYLOAD_TOO_LARGE), String(statuses)).toBe(3);
    expect(await storedBytes(init.uploadId)).toBe(PART_BYTES);
  });
});

describe('the store sums the stored parts again when it commits one', () => {
  it('removes a part that would pass the declared size although it was admitted against an older sum', async () => {
    const init = await s3Storage.initiateMultipartUpload('c.csv', 'text/csv', PART_BYTES, 'user_parts', PART_BYTES);
    cleanups.push(async () => {
      await s3Storage.abortMultipartUpload(init.uploadId);
    });
    await s3Storage.uploadPartStream(init.uploadId, 1, Readable.from([Buffer.alloc(PART_BYTES, 'a')]), PART_BYTES, PART_BYTES, 0);

    const late = s3Storage.uploadPartStream(init.uploadId, 2, Readable.from([Buffer.alloc(MIB, 'b')]), PART_BYTES, PART_BYTES, 0);

    await expect(late).rejects.toMatchObject({ statusCode: PAYLOAD_TOO_LARGE });
    expect(await storedBytes(init.uploadId)).toBe(PART_BYTES);
    expect(sessionFiles(init.uploadId)).toEqual(['part-1.bin']);
  });
});

/** A store whose part writes wait until the test opens their gate, and which counts its part list reads. */
function gatedStore(): { store: PartStore; gates: Array<() => void>; listReads: () => number } {
  const parts = new Map<number, number>();
  const gates: Array<() => void> = [];
  let reads = 0;
  return {
    gates,
    listReads: () => reads,
    store: {
      getUploadedParts: async () => {
        reads += 1;
        return [...parts].map(([partNumber, size]) => ({ partNumber, size }));
      },
      uploadPartStream: async (_uploadId, partNumber, _body, maxBytes) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        parts.set(partNumber, maxBytes ?? 0);
        return { partNumber, size: maxBytes ?? 0, etag: 'e' };
      },
    },
  };
}

const emptyBody = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
const partOf = (uploadId: string, partNumber: number, bytes: number, totalSize: number) => ({
  uploadId,
  partNumber,
  declaredBytes: bytes,
  totalSize,
  maxPartBytes: 64 * MIB,
});

describe('the ledger of parts on the way', () => {
  it('lets one attempt of a part number write at a time and refuses the repeats with 503', async () => {
    const uploadId = 'up_ledger_repeats';
    const { store, gates } = gatedStore();

    const attempts = Array.from({ length: 50 }, () =>
      receivePart(store, partOf(uploadId, 1, 64 * MIB, 64 * MIB), emptyBody()).then(
        () => 'stored',
        (error: { statusCode?: number }) => error.statusCode
      )
    );
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates.forEach((open) => open());
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((outcome) => outcome === 'stored')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === SERVICE_UNAVAILABLE)).toHaveLength(49);
    forgetUploadParts(uploadId);
  });

  it('gives the attempt back when the store throws, so the part is taken again', async () => {
    const uploadId = 'up_ledger_throw';
    const failing: PartStore = {
      getUploadedParts: async () => [],
      uploadPartStream: async () => {
        throw new Error('disk full');
      },
    };
    await expect(receivePart(failing, partOf(uploadId, 1, 5 * MIB, 5 * MIB), emptyBody())).rejects.toThrow('disk full');

    const { store, gates } = gatedStore();
    const retry = receivePart(store, partOf(uploadId, 1, 5 * MIB, 5 * MIB), emptyBody());
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]();
    await expect(retry).resolves.toMatchObject({ partNumber: 1, size: 5 * MIB });
    forgetUploadParts(uploadId);
  });

  it('lets the first callers of a session share one ledger when another session ends during the first part list read', async () => {
    const uploadId = 'up_ledger_shared_first_read';
    const { store, gates, listReads } = gatedStore();
    const slowList: PartStore = {
      ...store,
      getUploadedParts: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return store.getUploadedParts(id);
      },
    };

    const attempts = [1, 2, 3, 4, 5, 6].map((n) =>
      receivePart(slowList, partOf(uploadId, n, 5 * MIB, 5 * MIB), emptyBody()).then(
        () => 'stored',
        (error: { statusCode?: number }) => error.statusCode
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    forgetUploadParts('up_some_other_session');
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(gates).toHaveLength(1);
    expect(listReads()).toBe(1);
    gates.forEach((open) => open());
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((outcome) => outcome === 'stored')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === PAYLOAD_TOO_LARGE)).toHaveLength(5);
    forgetUploadParts(uploadId);
  });

  it('keeps the ledger of a session that a part is waiting on from being swept as idle, so a repeat of its part is still refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sessionX = 'up_ledger_swept_x';
      const sessionY = 'up_ledger_swept_y';
      const { store, gates } = gatedStore();
      const listReleases: Array<() => void> = [];
      const slowList: PartStore = {
        ...store,
        getUploadedParts: async (id) => {
          await new Promise<void>((resolve) => listReleases.push(resolve));
          return store.getUploadedParts(id);
        },
      };
      const outcome = (attempt: Promise<unknown>) =>
        attempt.then(
          () => 'stored',
          (error: { statusCode?: number }) => error.statusCode
        );

      const first = outcome(receivePart(slowList, partOf(sessionX, 1, MIB, 4 * MIB), emptyBody()));
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      const second = outcome(receivePart(slowList, partOf(sessionX, 2, MIB, 4 * MIB), emptyBody()));
      const other = outcome(receivePart(store, partOf(sessionY, 1, MIB, 4 * MIB), emptyBody()));
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates[0]();
      await other;
      const repeat = outcome(receivePart(slowList, partOf(sessionX, 1, MIB, 4 * MIB), emptyBody()));
      listReleases.forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 20));
      gates.forEach((open) => open());

      expect(await Promise.all([first, second, repeat])).toEqual(['stored', 'stored', SERVICE_UNAVAILABLE]);
      expect(listReleases).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      forgetUploadParts('up_ledger_swept_x');
      forgetUploadParts('up_ledger_swept_y');
    }
  });

  it('does not keep a ledger whose part list read failed, so the next part reads the store again', async () => {
    const uploadId = 'up_ledger_failed_read';
    const { store, gates } = gatedStore();
    const failingList: PartStore = { ...store, getUploadedParts: async () => Promise.reject(new Error('list failed')) };
    await expect(receivePart(failingList, partOf(uploadId, 1, MIB, 2 * MIB), emptyBody())).rejects.toThrow('list failed');

    const retry = receivePart(store, partOf(uploadId, 1, MIB, 2 * MIB), emptyBody());
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]();
    await expect(retry).resolves.toMatchObject({ partNumber: 1 });
    forgetUploadParts(uploadId);
  });

  it('does not keep a part list read while the session ended, so the next part reads the store again', async () => {
    const uploadId = 'up_ledger_forgotten';
    const { store, gates, listReads } = gatedStore();
    let releaseList: () => void = () => undefined;
    const slowList: PartStore = {
      ...store,
      getUploadedParts: async (id) => {
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
        return store.getUploadedParts(id);
      },
    };

    const first = receivePart(slowList, partOf(uploadId, 1, MIB, 2 * MIB), emptyBody());
    await vi.waitFor(() => expect(typeof releaseList).toBe('function'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    forgetUploadParts(uploadId);
    releaseList();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]();
    await first;

    const second = receivePart(store, partOf(uploadId, 2, MIB, 2 * MIB), emptyBody());
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]();
    await second;
    expect(listReads()).toBe(2);
    forgetUploadParts(uploadId);
  });
});
