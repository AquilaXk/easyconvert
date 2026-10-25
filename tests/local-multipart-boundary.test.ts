import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { NextRequest } from 'next/server';
import type { User } from '../src/lib/auth/types';

/**
 * Local multipart uploads take their session id from the client. The id must name a session this
 * store created and the caller owns, every byte written is bounded by the declared size and the S3
 * part limits, and the assembled object passes the spoof check before it is published.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const GIB = 1024 * 1024 * 1024;

const HOSTILE_UPLOAD_IDS = ['..', '../..', 'up_1_../x', 'up_1_\u0000', 'up_1_aaaaaaaaaaaaaaaaaaaaaaaa/..'];

let baseDir: string;
let storageDir: string;
let absoluteHostileId: string;

function hostileIds(): string[] {
  return [...HOSTILE_UPLOAD_IDS, absoluteHostileId];
}

function sentinelPath(): string {
  return path.join(storageDir, 'sentinel.txt');
}

function expectStorageRootIntact(): void {
  expect(fs.existsSync(storageDir), 'storage root survives').toBe(true);
  expect(fs.existsSync(sentinelPath()), 'files in the storage root survive').toBe(true);
  expect(fs.existsSync(path.join(storageDir, 'part-1.bin')), 'nothing is written into the storage root').toBe(false);
}

function sessionDirFiles(uploadId: string): string[] {
  const dir = path.join(storageDir, '.parts', uploadId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** Polls until the condition holds; the wait is bounded so a missed condition fails instead of hanging. */
async function waitFor(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(condition(), 'the awaited condition became true').toBe(true);
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-local-multipart-'));
  storageDir = path.join(baseDir, 'a', 'b', 'storage');
  absoluteHostileId = path.join(baseDir, 'a');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(sentinelPath(), 'keep');
  vi.stubEnv('STORAGE_DRIVER', 'local');
  vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
  vi.stubEnv('APP_URL', BASE_URL);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

async function newStorage() {
  const { LocalFsStorage } = await import('../src/lib/storage/local-fs-storage');
  return new LocalFsStorage({ storageDir, signingSecret: 'local-multipart-boundary-secret-0001' });
}

describe('LocalFsStorage multipart boundary', () => {
  it('refuses every upload id it did not generate, in every method, and leaves the storage root intact', async () => {
    const storage = await newStorage();
    try {
      for (const uploadId of hostileIds()) {
        await expect(storage.abortMultipart('k', uploadId), `abort ${JSON.stringify(uploadId)}`).rejects.toMatchObject({
          code: 'NoSuchUpload',
        });
        await expect(
          storage.savePartStream(uploadId, 1, Readable.from(Buffer.from('x'))),
          `part ${JSON.stringify(uploadId)}`
        ).rejects.toMatchObject({ code: 'NoSuchUpload' });
        await expect(
          storage.completeMultipart('k', uploadId, [{ partNumber: 1, etag: 'e' }]),
          `complete ${JSON.stringify(uploadId)}`
        ).rejects.toMatchObject({ code: 'NoSuchUpload' });
        await expect(storage.presignPart('k', uploadId, 1, 60), `presign ${JSON.stringify(uploadId)}`).rejects.toMatchObject({
          code: 'NoSuchUpload',
        });
        expect(await storage.getMultipartSession(uploadId), `session ${JSON.stringify(uploadId)}`).toBeUndefined();
        const expiresAt = Math.floor(Date.now() / 1000) + 60;
        const signature = crypto
          .createHmac('sha256', 'local-multipart-boundary-secret-0001')
          .update(`PUT\nk\n${uploadId}\n1\n${expiresAt}`)
          .digest('hex');
        expect(storage.verifyPresignedSignature('PUT', 'k', expiresAt, signature, uploadId, 1), `verify ${JSON.stringify(uploadId)}`).toBe(
          false
        );
        expectStorageRootIntact();
      }
    } finally {
      storage.stopGc();
    }
  });

  it('refuses part numbers outside 1 to 10,000 and writes nothing for them', async () => {
    const storage = await newStorage();
    try {
      const session = await storage.createMultipart('uploads/n.txt', { filename: 'n.txt' }, { ownerUserId: 'u1', totalSize: 4 });
      for (const partNumber of [0, 10_001, 1.5]) {
        await expect(storage.savePartStream(session.uploadId, partNumber, Readable.from(Buffer.from('ab'))), `part ${partNumber}`).rejects.toThrow(
          /part number/i
        );
      }
      expect(sessionDirFiles(session.uploadId)).toEqual(['session.json']);
    } finally {
      storage.stopGc();
    }
  });

  it('stops a part at the declared total and removes what it wrote', async () => {
    const storage = await newStorage();
    try {
      const session = await storage.createMultipart('uploads/t.txt', { filename: 't.txt' }, { ownerUserId: 'u1', totalSize: 10 });
      await expect(storage.savePartStream(session.uploadId, 1, Readable.from(Buffer.alloc(11, 0x61)))).rejects.toMatchObject({
        code: 'EntityTooLarge',
      });
      expect(sessionDirFiles(session.uploadId), 'an over-size part leaves nothing behind').toEqual(['session.json']);

      await storage.savePartStream(session.uploadId, 1, Readable.from(Buffer.alloc(6, 0x61)));
      await expect(storage.savePartStream(session.uploadId, 2, Readable.from(Buffer.alloc(6, 0x62)))).rejects.toMatchObject({
        code: 'EntityTooLarge',
      });
      expect(sessionDirFiles(session.uploadId), 'parts over the total leave nothing behind').toEqual(['part-1.bin', 'session.json']);
    } finally {
      storage.stopGc();
    }
  });

  it('caps one part at the S3 maximum of 5 GiB even when the declared total is larger', async () => {
    const { multipartPartByteLimit } = await import('../src/lib/storage/local-fs-storage');
    expect(multipartPartByteLimit(10 * GIB, 0)).toBe(5 * GIB);
    expect(multipartPartByteLimit(10 * GIB, 7 * GIB)).toBe(3 * GIB);
    expect(multipartPartByteLimit(4, 6)).toBe(0);
  });

  it('refuses to publish an assembled object whose bytes do not match its declared format', async () => {
    const storage = await newStorage();
    try {
      const key = 'uploads/spoofed.png';
      const body = Buffer.from('this is plain text, not a PNG image');
      const session = await storage.createMultipart(
        key,
        { filename: 'spoofed.png', contentType: 'image/png' },
        { ownerUserId: 'u1', totalSize: body.length }
      );
      const part = await storage.savePartStream(session.uploadId, 1, Readable.from(body));
      await expect(storage.completeMultipart(key, session.uploadId, [part], body.length)).rejects.toThrow(/spoof/i);
      expect(await storage.head(key), 'the spoofed object is not published').toBeNull();
      expect(
        fs.readdirSync(storageDir).filter((name) => name.includes('.comb.')),
        'the assembled file is deleted'
      ).toEqual([]);
    } finally {
      storage.stopGc();
    }
  });
});

describe('POST /api/v1/uploads multipart actions on local storage', () => {
  async function loadRoute() {
    const route = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const { localFsStorage } = await import('../src/lib/storage');
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');

    async function createUser(tag: string): Promise<{ user: User; headers: Record<string, string> }> {
      const email = `${tag}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@local-multipart.local`;
      const user = userStore.sanitizeUser(await userStore.createUser({ email, name: tag, tier: 'pro' }));
      return { user, headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
    }

    async function postJson(action: string, headers: Record<string, string>, body: unknown): Promise<Response> {
      const req = new NextRequest(`${BASE_URL}/api/v1/uploads?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return route.POST(req, { params: Promise.resolve({}) });
    }

    async function postPartBody(
      headers: Record<string, string>,
      uploadId: string,
      partNumber: number | string,
      body: ReadableStream<Uint8Array>
    ): Promise<Response> {
      const query = `action=part&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
      const req = new NextRequest(`${BASE_URL}/api/v1/uploads?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body,
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]);
      return route.POST(req, { params: Promise.resolve({}) });
    }

    async function postPart(headers: Record<string, string>, uploadId: string, partNumber: number | string, bytes: Buffer): Promise<Response> {
      return postPartBody(
        headers,
        uploadId,
        partNumber,
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        })
      );
    }

    async function initiate(headers: Record<string, string>, filename: string, mimeType: string, totalSize: number) {
      const res = await postJson('initiate', headers, { filename, mimeType, totalSize });
      expect(res.status).toBe(HTTP_OK);
      return (await res.json()) as { uploadId: string; key: string };
    }

    return { localFsStorage, createUser, postJson, postPart, postPartBody, initiate };
  }

  it('answers 404 to hostile upload ids on part, complete and abort, and keeps the storage root', async () => {
    const { createUser, postJson, postPart } = await loadRoute();
    const { headers } = await createUser('hostile');
    for (const uploadId of hostileIds()) {
      const part = await postPart(headers, uploadId, 1, Buffer.from('x'));
      expect(part.status, `part ${JSON.stringify(uploadId)}`).toBe(HTTP_NOT_FOUND);
      const complete = await postJson('complete', headers, { uploadId, key: 'k', parts: [{ partNumber: 1, etag: 'e' }] });
      expect(complete.status, `complete ${JSON.stringify(uploadId)}`).toBe(HTTP_NOT_FOUND);
      const abort = await postJson('abort', headers, { uploadId, key: 'k' });
      expect(abort.status, `abort ${JSON.stringify(uploadId)}`).toBe(HTTP_NOT_FOUND);
      expectStorageRootIntact();
    }
  });

  it("answers 404 to a stranger's part, complete and abort and leaves the owner's session working", async () => {
    const { createUser, postJson, postPart, initiate, localFsStorage } = await loadRoute();
    const owner = await createUser('owner');
    const stranger = await createUser('stranger');
    const body = Buffer.from('owner text body');
    const { uploadId, key } = await initiate(owner.headers, 'owner.txt', 'text/plain', body.length);

    expect((await postPart(stranger.headers, uploadId, 1, Buffer.from('intruder bytes'))).status, 'stranger part').toBe(HTTP_NOT_FOUND);
    expect(sessionDirFiles(uploadId), 'the stranger wrote no part').toEqual(['session.json']);

    const ownerPart = await postPart(owner.headers, uploadId, 1, body);
    expect(ownerPart.status).toBe(HTTP_OK);
    const { part } = await ownerPart.json();

    const strangerComplete = await postJson('complete', stranger.headers, { uploadId, key, parts: [part] });
    expect(strangerComplete.status, 'stranger complete').toBe(HTTP_NOT_FOUND);
    const strangerAbort = await postJson('abort', stranger.headers, { uploadId, key });
    expect(strangerAbort.status, 'stranger abort').toBe(HTTP_NOT_FOUND);
    expect(sessionDirFiles(uploadId), 'the session survives the stranger').toEqual(['part-1.bin', 'session.json']);

    const ownerComplete = await postJson('complete', owner.headers, { uploadId, key, parts: [part] });
    expect(ownerComplete.status).toBe(HTTP_OK);
    expect((await localFsStorage.getBuffer(key))?.toString()).toBe(body.toString());
  });

  it('refuses an over-size part and parts over the declared total, leaving no partial part', async () => {
    const { createUser, postPart, initiate } = await loadRoute();
    const { headers } = await createUser('oversize');
    const { uploadId } = await initiate(headers, 'size.txt', 'text/plain', 10);

    expect((await postPart(headers, uploadId, 1, Buffer.alloc(11, 0x61))).status, 'part larger than the declared total').toBe(
      HTTP_BAD_REQUEST
    );
    expect(sessionDirFiles(uploadId)).toEqual(['session.json']);

    expect((await postPart(headers, uploadId, 1, Buffer.alloc(6, 0x61))).status).toBe(HTTP_OK);
    expect((await postPart(headers, uploadId, 2, Buffer.alloc(6, 0x62))).status, 'parts adding up past the total').toBe(HTTP_BAD_REQUEST);
    expect(sessionDirFiles(uploadId)).toEqual(['part-1.bin', 'session.json']);
  });

  it('refuses part numbers 0 and 10,001', async () => {
    const { createUser, postPart, initiate } = await loadRoute();
    const { headers } = await createUser('partnumber');
    const { uploadId } = await initiate(headers, 'n.txt', 'text/plain', 4);
    for (const partNumber of [0, 10_001]) {
      expect((await postPart(headers, uploadId, partNumber, Buffer.from('ab'))).status, `part ${partNumber}`).toBe(HTTP_BAD_REQUEST);
    }
    expect(sessionDirFiles(uploadId)).toEqual(['session.json']);
  });

  it('refuses to publish a spoofed assembled file', async () => {
    const { createUser, postJson, postPart, initiate, localFsStorage } = await loadRoute();
    const { headers } = await createUser('spoof');
    const body = Buffer.from('plain text pretending to be a PNG');
    const { uploadId, key } = await initiate(headers, 'picture.png', 'image/png', body.length);
    const { part } = await (await postPart(headers, uploadId, 1, body)).json();

    const res = await postJson('complete', headers, { uploadId, key, parts: [part] });
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(await localFsStorage.head(key), 'nothing is published under the session key').toBeNull();
  });

  it("ignores a client key that points at another user's object and publishes under the session key", async () => {
    const { createUser, postJson, postPart, initiate, localFsStorage } = await loadRoute();
    const victim = await createUser('victim');
    const attacker = await createUser('attacker');

    const victimUpload = await initiate(victim.headers, 'victim.txt', 'text/plain', 11);
    const { part: victimPart } = await (await postPart(victim.headers, victimUpload.uploadId, 1, Buffer.from('victim text'))).json();
    expect((await postJson('complete', victim.headers, { uploadId: victimUpload.uploadId, parts: [victimPart] })).status).toBe(HTTP_OK);

    const attackerBody = Buffer.from('attacker text');
    const attackerUpload = await initiate(attacker.headers, 'attacker.txt', 'text/plain', attackerBody.length);
    const { part } = await (await postPart(attacker.headers, attackerUpload.uploadId, 1, attackerBody)).json();
    const res = await postJson('complete', attacker.headers, {
      uploadId: attackerUpload.uploadId,
      key: victimUpload.key,
      parts: [part],
    });
    expect(res.status).toBe(HTTP_OK);
    expect((await res.json()).key, 'the object lands at the session key').toBe(attackerUpload.key);
    expect((await localFsStorage.getBuffer(victimUpload.key))?.toString(), "the victim's object is untouched").toBe('victim text');
    expect((await localFsStorage.getBuffer(attackerUpload.key))?.toString()).toBe('attacker text');
  });
});

describe('POST /api/v1/uploads multipart errors on local storage', () => {
  async function loadRoute() {
    const route = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const { localFsStorage } = await import('../src/lib/storage');
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `errors_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@local-multipart.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'errors', tier: 'pro' }));
    const headers = { Cookie: `easyconvert_session=${createSessionToken(user)}` };

    async function postJson(action: string, body: unknown): Promise<Response> {
      const req = new NextRequest(`${BASE_URL}/api/v1/uploads?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return route.POST(req, { params: Promise.resolve({}) });
    }

    function postPart(uploadId: string, body: ReadableStream<Uint8Array>): Promise<Response> {
      const req = new NextRequest(`${BASE_URL}/api/v1/uploads?action=part&uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body,
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]);
      return route.POST(req, { params: Promise.resolve({}) });
    }

    const init = await postJson('initiate', { filename: 'race.txt', mimeType: 'text/plain', totalSize: 8 });
    expect(init.status).toBe(HTTP_OK);
    const { uploadId, key } = (await init.json()) as { uploadId: string; key: string };
    return { localFsStorage, postJson, postPart, uploadId, key };
  }

  it('answers 404 without any path when an abort removes the session while a part is still arriving', async () => {
    const { postJson, postPart, uploadId, key } = await loadRoute();
    let finishBody!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('abcd'));
        finishBody = () => controller.close();
      },
    });
    const pending = postPart(uploadId, body);
    await waitFor(() => sessionDirFiles(uploadId).some((name) => name.includes('.tmp.')));

    expect((await postJson('abort', { uploadId, key })).status).toBe(HTTP_OK);
    finishBody();
    const res = await pending;

    expect(res.status).toBe(HTTP_NOT_FOUND);
    const text = await res.text();
    expect(text, 'the body names no path').not.toContain(baseDir);
    expect(text).not.toMatch(/ENOENT|\.parts|part-1/);
  });

  it('answers 500 with a generic message, and logs the detail, for any other system error', async () => {
    const { localFsStorage, postPart, uploadId } = await loadRoute();
    const detail = `EIO: i/o error, write '${path.join(storageDir, '.parts', uploadId, 'part-1.bin.tmp.1')}'`;
    vi.spyOn(localFsStorage, 'savePartStream').mockRejectedValue(Object.assign(new Error(detail), { code: 'EIO', syscall: 'write' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postPart(uploadId, new ReadableStream({ start: (controller) => controller.close() }));

    expect(res.status).toBe(500);
    expect(await res.text(), 'the body names no path').not.toContain(baseDir);
    expect(logged.mock.calls.flat().join(' '), 'the detail goes to the server log').toContain(detail);
  });
});

describe('POST /api/storage/multipart?action=presign on local storage', () => {
  async function openSession() {
    const route = await import('../src/app/api/storage/multipart/route');
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `presign_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@local-multipart.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'presign', tier: 'pro' }));
    const headers = { 'Content-Type': 'application/json', Cookie: `easyconvert_session=${createSessionToken(user)}` };

    async function call(action: string, body: unknown): Promise<Response> {
      const req = new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return route.POST(req);
    }

    const init = await call('initiate', { filename: 'mine.txt', mimeType: 'text/plain', totalSize: 4 });
    expect(init.status).toBe(HTTP_OK);
    const { uploadId, key } = await init.json();
    return { call, uploadId, key };
  }

  it('refuses to sign an upload part URL for a key other than the session key', async () => {
    const { call, uploadId, key } = await openSession();

    const foreign = await call('presign', { type: 'upload', uploadId, partNumber: 1, key: 'conversions/someone-else/victim.pdf' });
    expect(foreign.status).toBe(HTTP_BAD_REQUEST);
    expect((await foreign.json()).detail).toBe('Key does not belong to this multipart upload session.');

    const own = await call('presign', { type: 'upload', uploadId, partNumber: 1, key });
    expect(own.status).toBe(HTTP_OK);
    expect(new URL((await own.json()).url).searchParams.get('key')).toBe(key);
  });

  it('refuses to sign an upload part URL for a part number that is not a whole number from 1 to 10,000', async () => {
    const { call, uploadId, key } = await openSession();
    for (const partNumber of [0, 10_001, 1.5, -1]) {
      const res = await call('presign', { type: 'upload', uploadId, partNumber, key });
      expect(res.status, `part number ${partNumber}`).toBe(HTTP_BAD_REQUEST);
    }
    const last = await call('presign', { type: 'upload', uploadId, partNumber: 10_000, key });
    expect(last.status, 'part number 10,000 is the last one allowed').toBe(HTTP_OK);
  });
});

describe('LocalFsStorage multipart assembly', () => {
  const savedPart = (storage: Awaited<ReturnType<typeof newStorage>>, uploadId: string, partNumber: number, size: number) =>
    storage.savePartStream(uploadId, partNumber, Readable.from(Buffer.alloc(size, 0x61)));

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('requires the listed parts to add up to the declared total before it copies a byte', async () => {
    const storage = await newStorage();
    try {
      const key = 'uploads/sum.txt';
      const session = await storage.createMultipart(key, { filename: 'sum.txt' }, { ownerUserId: 'u1', totalSize: 10 });
      const part1 = await savedPart(storage, session.uploadId, 1, 6);
      fs.writeFileSync(path.join(storageDir, '.parts', session.uploadId, 'part-2.bin'), Buffer.alloc(8, 0x62));
      const part2 = { partNumber: 2, etag: '"e"' };
      const opened = vi.spyOn(fs, 'createWriteStream');

      await expect(storage.completeMultipart(key, session.uploadId, [part1, part2]), 'parts add up past the total').rejects.toThrow(
        /does not match the declared size/
      );
      await expect(storage.completeMultipart(key, session.uploadId, [part1]), 'parts add up short of the total').rejects.toThrow(
        /does not match the declared size/
      );
      expect(opened, 'no assembled file was opened').not.toHaveBeenCalled();
      expect(await storage.head(key)).toBeNull();
    } finally {
      storage.stopGc();
    }
  });

  it('removes a part that lands after the other parts have already used up the declared total', async () => {
    const storage = await newStorage();
    try {
      const session = await storage.createMultipart('uploads/late.txt', { filename: 'late.txt' }, { ownerUserId: 'u1', totalSize: 10 });
      const slow = new Readable({ read() {} });
      slow.push(Buffer.alloc(3, 0x62));
      const slowPart = storage.savePartStream(session.uploadId, 2, slow);
      const slowOutcome = slowPart.then(
        () => undefined,
        (err: unknown) => err
      );
      await waitFor(() => sessionDirFiles(session.uploadId).some((name) => name.includes('.tmp.')));

      await savedPart(storage, session.uploadId, 1, 6);
      slow.push(Buffer.alloc(3, 0x62));
      slow.push(null);

      expect(await slowOutcome).toMatchObject({ code: 'EntityTooLarge' });
      expect(sessionDirFiles(session.uploadId), 'the part that overflowed the total is deleted').toEqual(['part-1.bin', 'session.json']);
    } finally {
      storage.stopGc();
    }
  });

  it('gives every assembly and every part upload a temp file of its own, created exclusively', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const storage = await newStorage();
    const real = fs.createWriteStream;
    const opened: Array<{ target: string; flags: unknown }> = [];
    vi.spyOn(fs, 'createWriteStream').mockImplementation(((target: fs.PathLike, options?: { flags?: string }) => {
      opened.push({ target: String(target), flags: options?.flags });
      return real(target, options as Parameters<typeof real>[1]);
    }) as typeof fs.createWriteStream);
    try {
      const key = 'uploads/race.txt';
      const session = await storage.createMultipart(key, { filename: 'race.txt' }, { ownerUserId: 'u1', totalSize: 6 });
      const part = await savedPart(storage, session.uploadId, 1, 6);
      const results = await Promise.allSettled([
        storage.completeMultipart(key, session.uploadId, [part]),
        storage.completeMultipart(key, session.uploadId, [part]),
      ]);
      expect(results.some((result) => result.status === 'fulfilled'), 'one assembly publishes the object').toBe(true);
      expect((await storage.getBuffer(key))?.toString()).toBe('aaaaaa');

      const second = await storage.createMultipart('uploads/two.txt', { filename: 'two.txt' }, { ownerUserId: 'u1', totalSize: 12 });
      await Promise.all([savedPart(storage, second.uploadId, 1, 6), savedPart(storage, second.uploadId, 1, 6)]);

      for (const infix of ['.comb.', '.tmp.']) {
        const temps = opened.filter((entry) => entry.target.includes(infix));
        expect(temps.length, `concurrent writers opened ${infix} files`).toBeGreaterThanOrEqual(2);
        expect(new Set(temps.map((entry) => entry.target)).size, `${infix} names are distinct`).toBe(temps.length);
        expect(temps.map((entry) => entry.flags), `${infix} files are created exclusively`).toEqual(temps.map(() => 'wx'));
      }
      expect(fs.readdirSync(storageDir).filter((name) => name.includes('.comb.')), 'no assembled temp file is left').toEqual([]);
    } finally {
      storage.stopGc();
    }
  });

  it('rejects instead of hanging when the assembled file cannot be written', async () => {
    const storage = await newStorage();
    try {
      const key = 'uploads/full.txt';
      const session = await storage.createMultipart(key, { filename: 'full.txt' }, { ownerUserId: 'u1', totalSize: 6 });
      const part = await savedPart(storage, session.uploadId, 1, 6);
      const real = fs.createWriteStream;
      vi.spyOn(fs, 'createWriteStream').mockImplementation(((target: fs.PathLike, options?: Parameters<typeof real>[1]) =>
        String(target).includes('.comb.')
          ? new Writable({
              write(_chunk, _encoding, done) {
                done(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
              },
            })
          : real(target, options)) as typeof fs.createWriteStream);

      const hung = Symbol('hung');
      const outcome = await Promise.race([
        storage.completeMultipart(key, session.uploadId, [part]).then(
          () => 'resolved',
          (err: unknown) => err
        ),
        new Promise((resolve) => setTimeout(() => resolve(hung), 3000)),
      ]);
      expect(outcome, 'the assembly settles').not.toBe(hung);
      expect(outcome).toMatchObject({ code: 'ENOSPC' });
      expect(await storage.head(key)).toBeNull();
    } finally {
      storage.stopGc();
    }
  });
});

describe('resumable upload ids', () => {
  it('answers 404 to an id that is not a generated TUS id, and deletes nothing outside the TUS directory', async () => {
    const route = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const { tusEngine } = await import('../src/lib/storage/tus-engine');
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `tus_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@local-multipart.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'tus', tier: 'pro' }));

    const now = Date.now();
    const hostileId = '../victim';
    fs.writeFileSync(
      path.join(storageDir, 'victim.info'),
      JSON.stringify({
        id: hostileId,
        uploadLength: 4,
        uploadOffset: 4,
        metadata: '',
        parsedMetadata: {},
        key: 'uploads/victim.txt',
        filename: 'victim.txt',
        mimeType: 'text/plain',
        ownerUserId: user.id,
        createdAt: now,
        expiresAt: now + 3_600_000,
        completed: false,
      })
    );
    fs.writeFileSync(path.join(storageDir, 'victim.bin'), 'keep');

    expect(await tusEngine.getSession(hostileId), 'the engine does not read a session outside its directory').toBeNull();
    expect(await tusEngine.terminateSession(hostileId)).toBe(false);

    const req = new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
      method: 'DELETE',
      headers: { 'Tus-Resumable': '1.0.0', Cookie: `easyconvert_session=${createSessionToken(user)}` },
    });
    const res = await route.DELETE(req, { params: Promise.resolve({ id: [hostileId] }) });

    expect(res.status).toBe(HTTP_NOT_FOUND);
    expect(fs.existsSync(path.join(storageDir, 'victim.info')), 'the info file survives').toBe(true);
    expect(fs.readFileSync(path.join(storageDir, 'victim.bin'), 'utf-8'), 'the data file survives').toBe('keep');
  });
});

describe('direct part uploads on local storage', () => {
  async function loadDirect() {
    const direct = await import('../src/app/api/v1/uploads/direct/route');
    const part = await import('../src/app/api/v1/uploads/direct/part/route');
    const complete = await import('../src/app/api/v1/uploads/direct/complete/route');
    const { s3Storage } = await import('../src/lib/storage/s3-storage');
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `direct_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@local-multipart.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'direct', tier: 'pro' }));
    const headers = { 'Content-Type': 'application/json', Cookie: `easyconvert_session=${createSessionToken(user)}` };

    async function initiate(totalSize: number) {
      const res = await direct.POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ filename: 'direct.txt', mimeType: 'text/plain', totalSize }),
        })
      );
      expect(res.status).toBe(HTTP_OK);
      return (await res.json()) as { uploadId: string; key: string };
    }

    async function putPart(upload: { uploadId: string; key: string }, partNumber: number, bytes: Buffer): Promise<Response> {
      const { url } = s3Storage.generatePresignedHmacPartUrl(upload.key, upload.uploadId, partNumber, 900);
      return part.PUT(
        new NextRequest(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          duplex: 'half',
        } as ConstructorParameters<typeof NextRequest>[1])
      );
    }

    function completeUpload(uploadId: string, parts: unknown[]): Promise<Response> {
      return complete.POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ uploadId, parts }),
        })
      );
    }

    return { s3Storage, initiate, putPart, completeUpload };
  }

  it('stops a part at the declared total and at what the other parts leave of it', async () => {
    const { s3Storage, initiate, putPart } = await loadDirect();
    const upload = await initiate(10);

    expect((await putPart(upload, 1, Buffer.alloc(11, 0x61))).status, 'part larger than the declared total').toBe(HTTP_TOO_LARGE);
    expect(await s3Storage.getUploadedParts(upload.uploadId), 'the over-size part is not kept').toEqual([]);

    expect((await putPart(upload, 1, Buffer.alloc(6, 0x61))).status).toBe(HTTP_OK);
    expect((await putPart(upload, 2, Buffer.alloc(6, 0x62))).status, 'parts adding up past the total').toBe(HTTP_TOO_LARGE);
    expect((await s3Storage.getUploadedParts(upload.uploadId))?.map((stored) => stored.partNumber)).toEqual([1]);
  });

  it('refuses to publish an assembled object whose size is not the declared total', async () => {
    const { s3Storage, initiate, putPart, completeUpload } = await loadDirect();
    const upload = await initiate(10);
    const stored = await putPart(upload, 1, Buffer.alloc(6, 0x61));
    expect(stored.status).toBe(HTTP_OK);
    const { partNumber, etag } = await stored.json();

    const res = await completeUpload(upload.uploadId, [{ partNumber, etag }]);

    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(s3Storage.getObjectStream(upload.key), 'nothing is published under the session key').toBeNull();
  });
});
