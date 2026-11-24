import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';
import { compactTailFromFile, readHandleSlice, uploadFileSlicesInParts, writeTextFileAtomic } from '../src/lib/storage/tus-fd-io';
import type { TusSession, TusSessionStore } from '../src/lib/storage/tus-engine';

const BUCKET = 'tus-stream-bucket';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIATUSTESTKEY000001';
const SECRET = 'tus/Secret+Key/STREAMTEST000000000000001';
const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PART_BYTES = 8 * MIB;
const NON_MAGIC_PREFIX = Buffer.from('EC_TUS_STREAM_OCTET\x00', 'ascii');

function makeOctetPayload(size: number, fillByte?: number): Buffer {
  const buf = fillByte === undefined ? crypto.randomBytes(size) : Buffer.alloc(size, fillByte);
  NON_MAGIC_PREFIX.copy(buf, 0, 0, Math.min(NON_MAGIC_PREFIX.length, buf.length));
  return buf;
}

function makeFakePngPayload(size: number): Buffer {
  const buf = Buffer.alloc(size, 0x33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return buf;
}

function injectAtomicInfoWriteFailure(infoPath: string, needle: string, error: Error) {
  const origOpen = fs.promises.open.bind(fs.promises);
  return vi.spyOn(fs.promises, 'open').mockImplementation(async (targetPath, ...args) => {
    const opened = await origOpen(targetPath, ...args);
    const targetStr = String(targetPath);
    if (targetStr.startsWith(`${infoPath}.`) && targetStr.endsWith('.tmp')) {
      const origWrite = opened.write.bind(opened);
      vi.spyOn(opened, 'write').mockImplementation((async (...writeArgs: unknown[]) => {
        const buf = writeArgs[0];
        if (Buffer.isBuffer(buf)) {
          const offset = typeof writeArgs[1] === 'number' ? writeArgs[1] : 0;
          const length = typeof writeArgs[2] === 'number' ? writeArgs[2] : buf.length - offset;
          if (buf.subarray(offset, offset + length).toString('utf-8').includes(needle)) {
            throw error;
          }
        }
        return (origWrite as (...a: unknown[]) => unknown)(...writeArgs);
      }) as unknown as typeof opened.write);
    }
    return opened;
  });
}

class SharedMemoryTusStore implements TusSessionStore {
  readonly sessions = new Map<string, TusSession>();
  readonly tails = new Map<string, Buffer>();

  async saveSession(session: TusSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(id: string): Promise<TusSession | null> {
    const found = this.sessions.get(id);
    if (!found) return null;
    if (Date.now() > found.expiresAt) {
      this.sessions.delete(id);
      return null;
    }
    return structuredClone(found);
  }

  async peekSession(id: string): Promise<TusSession | null> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : null;
  }

  async deleteSession(id: string): Promise<boolean> {
    this.tails.delete(id);
    return this.sessions.delete(id);
  }

  async syncStagedBytes(id: string, binPath: string, _prev: number, newOffset: number): Promise<void> {
    const handle = await fs.promises.open(binPath, 'r');
    try {
      const slice = await readHandleSlice(handle, 0, newOffset);
      this.tails.set(id, Buffer.from(slice));
    } finally {
      await handle.close();
    }
  }

  async replaceStagedTailBytes(id: string, tail: Buffer): Promise<void> {
    if (tail.length === 0) {
      this.tails.delete(id);
      return;
    }
    this.tails.set(id, Buffer.from(tail));
  }

  async hydrateStagedFile(id: string, binPath: string, expectedOffset: number): Promise<number> {
    if (expectedOffset <= 0) {
      await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
      await fs.promises.writeFile(binPath, Buffer.alloc(0));
      return 0;
    }
    const tail = this.tails.get(id);
    if (!tail || tail.length < expectedOffset) return tail?.length ?? 0;
    await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
    const slice = tail.subarray(0, expectedOffset);
    await fs.promises.writeFile(binPath, slice);
    return slice.length;
  }

  async deleteStagedBytes(id: string): Promise<void> {
    this.tails.delete(id);
  }

  stagedByteCount(id: string): number {
    return this.tails.get(id)?.length ?? 0;
  }
}

describe('TUS fd-streaming multipart flushes and incremental part persistence', () => {
  let server: S3StubServer;
  let storageDir: string;
  let replicaDirB: string;

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    server.requests.length = 0;
    server.faults.length = 0;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-fd-a-'));
    replicaDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-fd-b-'));
    vi.stubEnv('STORAGE_DRIVER', 'oci');
    vi.stubEnv('OCI_NAMESPACE', 'axyz123namespace');
    vi.stubEnv('OCI_REGION', REGION);
    vi.stubEnv('OCI_BUCKET', BUCKET);
    vi.stubEnv('OCI_ACCESS_KEY_ID', ACCESS_KEY);
    vi.stubEnv('OCI_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('OCI_ENDPOINT', server.url);
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'tus-fd-stream-test-signing-secret-01');
    vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
    vi.stubEnv('APP_URL', BASE_URL);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(replicaDirB, { recursive: true, force: true });
  });

  async function initHttpTusContext(store?: TusSessionStore) {
    const tusMod = await import('../src/lib/storage/tus-engine');
    if (store) tusMod.setTusSessionStore(store);
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const route = await import('../src/app/api/v1/uploads/[[...id]]/route');
    const user = userStore.sanitizeUser(
      await userStore.createUser({
        email: `tus_fd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@tus-fd.local`,
        name: 'tus-fd',
        tier: 'paid',
      })
    );
    const headers = { 'Tus-Resumable': '1.0.0', Cookie: `easyconvert_session=${createSessionToken(user)}` };
    const start = async (uploadLength: number, filename = 'large.bin', filetype = 'application/octet-stream') => {
      const metadata = `filename ${Buffer.from(filename).toString('base64')},filetype ${Buffer.from(filetype).toString('base64')}`;
      const res = await route.POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
          method: 'POST',
          headers: { ...headers, 'Upload-Length': String(uploadLength), 'Upload-Metadata': metadata },
        }),
        { params: Promise.resolve({}) }
      );
      expect(res.status).toBe(201);
      const id = res.headers.get('Location')!.split('/').pop()!;
      return id;
    };
    const patch = (id: string, offset: number, body: Buffer) =>
      route.PATCH(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
          body: new ReadableStream({
            start(controller) {
              const step = 256 * 1024;
              for (let pos = 0; pos < body.length; pos += step) {
                controller.enqueue(body.subarray(pos, Math.min(body.length, pos + step)));
              }
              controller.close();
            },
          }),
          duplex: 'half',
        } as never),
        { params: Promise.resolve({ id: [id] }) }
      );
    const headOffset = async (id: string) => {
      const res = await route.HEAD(
        new NextRequest(`${BASE_URL}/api/v1/uploads/tus/${id}`, { method: 'HEAD', headers }),
        { params: Promise.resolve({ id: [id] }) }
      );
      expect(res.status).toBe(200);
      return Number(res.headers.get('Upload-Offset'));
    };
    return { tusMod, start, patch, headOffset, user };
  }

  it('readHandleSlice, uploadFileSlicesInParts, and compactTailFromFile handle short reads, bounds, and fd cleanup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-fd-unit-'));
    try {
      const sample = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      const binPath = path.join(tmpDir, 'unit.bin');
      fs.writeFileSync(binPath, sample);

      // Short POSIX reads (3 bytes at a time)
      const handle = await fs.promises.open(binPath, 'r');
      try {
        const origRead = handle.read.bind(handle);
        const shortReadSpy = vi.spyOn(handle, 'read').mockImplementation(((
          buf: NodeJS.ArrayBufferView,
          offset?: number | null,
          length?: number | null,
          position?: number | null
        ) => {
          const capped = Math.min(3, length ?? 0);
          return origRead(buf, offset ?? 0, capped, position ?? null);
        }) as unknown as typeof handle.read);
        const sliced = await readHandleSlice(handle, 5, 11);
        expect(sliced.toString('ascii')).toBe('56789ABCDEF');
        expect(shortReadSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
        await expect(readHandleSlice(handle, -1, 4)).rejects.toBeInstanceOf(RangeError);
        expect((await readHandleSlice(handle, 0, 0)).length).toBe(0);
      } finally {
        await handle.close();
      }

      // uploadFileSlicesInParts validates minSliceBytes and closes fd on uploadPart error
      const closeSpies: Array<ReturnType<typeof vi.spyOn>> = [];
      const origOpen = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const opened = await origOpen(...args);
        closeSpies.push(vi.spyOn(opened, 'close'));
        return opened;
      });
      await expect(
        uploadFileSlicesInParts({
          binPath,
          partSize: 10,
          maxCursor: sample.length,
          minSliceBytes: 0,
          initialParts: [],
          uploadPart: async (partNumber, slice) => ({ partNumber, etag: `"e${partNumber}"`, size: slice.length }),
          onShortRead: (n) => new Error(`short:${n}`),
        })
      ).rejects.toBeInstanceOf(RangeError);

      await expect(
        uploadFileSlicesInParts({
          binPath,
          partSize: 10,
          maxCursor: sample.length,
          minSliceBytes: 10,
          initialParts: [],
          uploadPart: async (partNumber, slice) => {
            if (partNumber === 2) throw new Error('part 2 failed');
            return { partNumber, etag: `"e${partNumber}"`, size: slice.length };
          },
          onShortRead: (n) => new Error(`short:${n}`),
        })
      ).rejects.toThrow('part 2 failed');
      expect(closeSpies.length).toBe(1);
      expect(closeSpies[0]).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();

      // compactTailFromFile copies [10, 31) in 7-byte slices and leaves zero .tail temps
      await compactTailFromFile(binPath, 10, 21, 7);
      expect(fs.readFileSync(binPath, 'ascii')).toBe('ABCDEFGHIJKLMNOPQRSTU');
      expect(fs.readdirSync(tmpDir)).toEqual(['unit.bin']);

      await compactTailFromFile(binPath, 0, 0, 7);
      expect(fs.statSync(binPath).size).toBe(0);

      // Invalid bounds fail closed instead of hanging or silently reading empty buffers
      fs.writeFileSync(binPath, sample);
      await expect(compactTailFromFile(binPath, 0, 10, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(compactTailFromFile(binPath, -1, 10, 7)).rejects.toBeInstanceOf(RangeError);
      await expect(
        uploadFileSlicesInParts({
          binPath,
          partSize: 0,
          maxCursor: sample.length,
          minSliceBytes: 1,
          initialParts: [],
          uploadPart: async (partNumber, slice) => ({ partNumber, etag: `"e${partNumber}"`, size: slice.length }),
          onShortRead: (n) => new Error(`short:${n}`),
        })
      ).rejects.toBeInstanceOf(RangeError);

      const boundHandle = await fs.promises.open(binPath, 'r');
      try {
        await expect(readHandleSlice(boundHandle, 0, -1)).rejects.toBeInstanceOf(RangeError);
        await expect(readHandleSlice(boundHandle, 0, Number.NaN)).rejects.toBeInstanceOf(RangeError);
        const eofShort = await readHandleSlice(boundHandle, sample.length - 4, 1024 * 1024);
        expect(eofShort.toString('ascii')).toBe('WXYZ');
        expect(eofShort.buffer.byteLength).toBeLessThan(1024 * 1024);
      } finally {
        await boundHandle.close();
      }

      // If dst.close() fails during compactTailFromFile, src fd is still closed and .tail temp is deleted
      const openedHandles: Array<{ path: string; closeSpy: ReturnType<typeof vi.spyOn> }> = [];
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const opened = await origOpen(...args);
        const filePathStr = String(args[0]);
        const closeSpy = vi.spyOn(opened, 'close');
        if (filePathStr.endsWith('.tail')) {
          closeSpy.mockRejectedValueOnce(new Error('dst close EIO'));
        }
        openedHandles.push({ path: filePathStr, closeSpy });
        return opened;
      });
      await expect(compactTailFromFile(binPath, 2, 8, 4)).rejects.toThrow('dst close EIO');
      expect(openedHandles).toHaveLength(2);
      expect(openedHandles[0].closeSpy).toHaveBeenCalledTimes(1);
      expect(openedHandles[1].closeSpy).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(tmpDir)).toEqual(['unit.bin']);
      vi.restoreAllMocks();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streams 27 MiB remote multipart flushes from file descriptors without calling readFile on .bin', async () => {
    const store = new SharedMemoryTusStore();
    const { start, patch } = await initHttpTusContext(store);
    const payload = makeOctetPayload(27 * MIB);
    const id = await start(payload.length, 'stream-27m.bin');
    const binPath = path.join(storageDir, 'tus', `${id}.bin`);

    const origReadFile = fs.promises.readFile.bind(fs.promises);
    const readFileBinCalls: string[] = [];
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (targetPath, ...args) => {
      const targetStr = String(targetPath);
      if (targetStr.endsWith('.bin')) readFileBinCalls.push(targetStr);
      return origReadFile(targetPath, ...args);
    });

    // Chunk 1: 18 MiB -> flushes Part 1 (8 MiB) + Part 2 (8 MiB), keeps 2 MiB tail
    const res1 = await patch(id, 0, payload.subarray(0, 18 * MIB));
    expect(res1.status).toBe(204);
    expect(Number(res1.headers.get('Upload-Offset'))).toBe(18 * MIB);
    expect(fs.statSync(binPath).size).toBe(2 * MIB);
    expect(store.stagedByteCount(id)).toBe(2 * MIB);

    // Chunk 2: 9 MiB -> flushes Part 3 (8 MiB) + Part 4 (3 MiB), completes upload
    const res2 = await patch(id, 18 * MIB, payload.subarray(18 * MIB));
    expect(res2.status).toBe(204);
    const storageKey = res2.headers.get('X-Storage-Key')!;
    expect(server.objects.get(storageKey)?.body.equals(payload)).toBe(true);
    expect(readFileBinCalls).toEqual([]);
    expect(fs.existsSync(binPath)).toBe(false);
    expect(store.stagedByteCount(id)).toBe(0);

    const putPartSizes = server.requests
      .filter((r) => r.method === 'PUT' && r.query.has('partNumber'))
      .map((r) => [Number(r.query.get('partNumber')), r.bodyLength]);
    expect(putPartSizes).toEqual([
      [1, PART_BYTES],
      [2, PART_BYTES],
      [3, PART_BYTES],
      [4, 3 * MIB],
    ]);
  });

  it('persists incremental remoteParts progress on intermediate flush failure and resumes across replicas without re-uploading flushed parts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { tusMod, start, patch, headOffset } = await initHttpTusContext(store);
    const payload = makeOctetPayload(30 * MIB);
    const id = await start(payload.length, 'resume-mid-flush.bin');
    const binPathA = path.join(storageDir, 'tus', `${id}.bin`);
    const infoPathA = path.join(storageDir, 'tus', `${id}.info`);

    // Inject permanent fault for Part 3 on the first attempt
    server.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '3',
      status: 400,
      code: 'InjectedPart3Failure',
      times: 1,
    });

    // PATCH 1 sends 25 MiB (< 30 MiB): Parts 1 & 2 succeed (16 MiB), Part 3 fails
    const failedRes = await patch(id, 0, payload.subarray(0, 25 * MIB));
    expect(failedRes.status).toBe(500);

    const savedInStore = await store.getSession(id);
    expect(savedInStore?.uploadOffset).toBe(16 * MIB);
    expect(savedInStore?.remoteFlushedBytes).toBe(16 * MIB);
    expect(savedInStore?.remoteParts?.map((p) => [p.partNumber, p.size])).toEqual([
      [1, PART_BYTES],
      [2, PART_BYTES],
    ]);
    expect(savedInStore?.completed).toBe(false);
    expect(typeof savedInStore?.headerProbeBase64).toBe('string');
    const infoOnDisk = JSON.parse(fs.readFileSync(infoPathA, 'utf8')) as TusSession;
    expect(infoOnDisk.uploadOffset).toBe(16 * MIB);
    expect(infoOnDisk.remoteFlushedBytes).toBe(16 * MIB);
    expect(infoOnDisk.remoteParts).toHaveLength(2);
    expect(fs.statSync(binPathA).size).toBe(0);
    expect(store.stagedByteCount(id)).toBe(0);
    expect(await headOffset(id)).toBe(16 * MIB);

    // Resume remaining 14 MiB on independent Replica B
    const replicaB = new tusMod.TusEngine({ tusDir: replicaDirB });
    const resumed = await replicaB.appendChunk(id, 16 * MIB, Readable.from([payload.subarray(16 * MIB)]));
    expect(resumed.isComplete).toBe(true);
    expect(resumed.newOffset).toBe(30 * MIB);
    expect(server.objects.get(resumed.session.key)?.body.equals(payload)).toBe(true);

    // Parts 1 and 2 were uploaded only once; Part 3 was retried once
    const partNumbersSent = server.requests
      .filter((r) => r.method === 'PUT' && r.query.has('partNumber'))
      .map((r) => Number(r.query.get('partNumber')));
    expect(partNumbersSent).toEqual([1, 2, 3, 3, 4]);
  });

  it('persists incremental remoteParts progress when final completeRemoteMultipartTus fails mid-loop and resumes cleanly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { start, patch, headOffset } = await initHttpTusContext(store);
    const payload = makeFakePngPayload(27 * MIB);
    const id = await start(payload.length, 'resume-complete-fail.png', 'image/png');
    const binPath = path.join(storageDir, 'tus', `${id}.bin`);

    server.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '3',
      status: 400,
      code: 'InjectedFinalLoopFailure',
      times: 1,
    });

    const failRes = await patch(id, 0, payload);
    expect(failRes.status).toBe(500);
    expect(server.objects.size).toBe(0);

    const persisted = await store.getSession(id);
    expect(persisted?.completed).toBe(false);
    expect(persisted?.uploadOffset).toBe(16 * MIB);
    expect(persisted?.remoteFlushedBytes).toBe(16 * MIB);
    expect(persisted?.remoteParts?.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(fs.statSync(binPath).size).toBe(0);
    expect(await headOffset(id)).toBe(16 * MIB);

    // Resume from 16 MiB (remaining 11 MiB) -> spoof check still passes via persisted headerProbeBase64
    const okRes = await patch(id, 16 * MIB, payload.subarray(16 * MIB));
    expect(okRes.status).toBe(204);
    const key = okRes.headers.get('X-Storage-Key')!;
    expect(server.objects.get(key)?.body.equals(payload)).toBe(true);
  });

  it('handles prior < 8 MiB tail across both Part 2 flush failure and Part 1 rollback without corrupting tail bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { tusMod, start, patch, headOffset } = await initHttpTusContext(store);

    // Case A: 3 MiB staged tail + 18 MiB PATCH -> Part 1 (8 MiB) persists, Part 2 fails
    const payloadA = makeOctetPayload(22 * MIB);
    const idA = await start(payloadA.length, 'tail-part2-fail.bin');
    expect((await patch(idA, 0, payloadA.subarray(0, 3 * MIB))).status).toBe(204);
    expect(store.stagedByteCount(idA)).toBe(3 * MIB);

    server.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '2',
      status: 400,
      code: 'InjectedPart2Fault',
      times: 1,
    });
    expect((await patch(idA, 3 * MIB, payloadA.subarray(3 * MIB, 21 * MIB))).status).toBe(500);
    expect(await headOffset(idA)).toBe(8 * MIB);
    expect(store.stagedByteCount(idA)).toBe(0);
    expect(fs.statSync(path.join(storageDir, 'tus', `${idA}.bin`)).size).toBe(0);

    const replicaB = new tusMod.TusEngine({ tusDir: replicaDirB });
    const doneA = await replicaB.appendChunk(idA, 8 * MIB, Readable.from([payloadA.subarray(8 * MIB)]));
    expect(doneA.isComplete).toBe(true);
    expect(server.objects.get(doneA.session.key)?.body.equals(payloadA)).toBe(true);

    // Case B: 3 MiB staged tail + 10 MiB PATCH -> Part 1 fails (cursor === 0) -> rolls back to 3 MiB
    const payloadB = makeOctetPayload(22 * MIB);
    const idB = await start(payloadB.length, 'tail-part1-fail.bin');
    expect((await patch(idB, 0, payloadB.subarray(0, 3 * MIB))).status).toBe(204);

    server.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '1',
      status: 400,
      code: 'InjectedPart1Fault',
      times: 1,
    });
    expect((await patch(idB, 3 * MIB, payloadB.subarray(3 * MIB, 13 * MIB))).status).toBe(500);
    expect(await headOffset(idB)).toBe(3 * MIB);
    expect(store.stagedByteCount(idB)).toBe(3 * MIB);
    const binB = path.join(storageDir, 'tus', `${idB}.bin`);
    expect(fs.readFileSync(binB).equals(payloadB.subarray(0, 3 * MIB))).toBe(true);

    const doneB = await replicaB.appendChunk(idB, 3 * MIB, Readable.from([payloadB.subarray(3 * MIB)]));
    expect(doneB.isComplete).toBe(true);
    expect(server.objects.get(doneB.session.key)?.body.equals(payloadB)).toBe(true);
  });

  it('recovers cleanly when replaceStagedTailBytes or final persistIncompleteChunk fails after intermediate flush', async () => {
    const store = new SharedMemoryTusStore();
    const { start, patch, headOffset } = await initHttpTusContext(store);

    // Case A: replaceStagedTailBytes throws after flushing 16 MiB and writing 1 MiB leftover
    const payloadA = makeOctetPayload(20 * MIB);
    const idA = await start(payloadA.length, 'tail-sync-fail.bin');
    vi.spyOn(store, 'replaceStagedTailBytes').mockRejectedValueOnce(new Error('redis tail failure'));
    const failA = await patch(idA, 0, payloadA.subarray(0, 17 * MIB));
    expect(failA.status).toBe(400);
    expect(await headOffset(idA)).toBe(16 * MIB);
    expect(fs.statSync(path.join(storageDir, 'tus', `${idA}.bin`)).size).toBe(0);
    expect(store.stagedByteCount(idA)).toBe(0);
    const resA = await patch(idA, 16 * MIB, payloadA.subarray(16 * MIB));
    expect(resA.status).toBe(204);
    expect(server.objects.get(resA.headers.get('X-Storage-Key')!)?.body.equals(payloadA)).toBe(true);

    // Case B: saveSession throws on the final 17 MiB uploadOffset save after 16 MiB parts checkpointed
    const payloadB = makeOctetPayload(20 * MIB);
    const idB = await start(payloadB.length, 'persist-incomplete-fail.bin');
    const origSave = store.saveSession.bind(store);
    const saveSpy = vi.spyOn(store, 'saveSession').mockImplementation(async (session) => {
      if (session.id === idB && session.uploadOffset === 17 * MIB) {
        throw new Error('redis final offset failure');
      }
      return origSave(session);
    });
    const failB = await patch(idB, 0, payloadB.subarray(0, 17 * MIB));
    expect(failB.status).toBe(400);
    saveSpy.mockRestore();
    expect(await headOffset(idB)).toBe(16 * MIB);
    expect(fs.statSync(path.join(storageDir, 'tus', `${idB}.bin`)).size).toBe(0);
    expect(store.stagedByteCount(idB)).toBe(0);
    const resB = await patch(idB, 16 * MIB, payloadB.subarray(16 * MIB));
    expect(resB.status).toBe(204);
    expect(server.objects.get(resB.headers.get('X-Storage-Key')!)?.body.equals(payloadB)).toBe(true);
  });

  it('avoids duplicate saveSession on 8 MiB-aligned intermediate flush and refuses spoofed > 8 MiB uploads without uploading parts', async () => {
    const store = new SharedMemoryTusStore();
    const { start, patch } = await initHttpTusContext(store);

    // Exact 16 MiB aligned flush out of 20 MiB
    const payload = makeOctetPayload(20 * MIB);
    const id = await start(payload.length, 'aligned-16m.bin');
    const saveSpy = vi.spyOn(store, 'saveSession');
    expect((await patch(id, 0, payload.subarray(0, 16 * MIB))).status).toBe(204);
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(fs.statSync(path.join(storageDir, 'tus', `${id}.bin`)).size).toBe(0);
    expect((await patch(id, 16 * MIB, payload.subarray(16 * MIB))).status).toBe(204);

    // Spoofed 10 MiB .png is rejected before any UploadPart hits S3
    const reqCountBefore = server.requests.length;
    const spoofed = Buffer.alloc(10 * MIB, 0x41);
    const spoofId = await start(spoofed.length, 'fake.png', 'image/png');
    const spoofRes = await patch(spoofId, 0, spoofed);
    expect(spoofRes.status).toBe(400);
    const partUploadsDuringSpoof = server.requests
      .slice(reqCountBefore)
      .filter((r) => r.method === 'PUT' && r.query.has('partNumber'));
    expect(partUploadsDuringSpoof).toHaveLength(0);
  });

  it('reverts sessionStore checkpoint on .info write failure and reads <= 64 KiB prefix via fd when headerProbeBase64 is absent', async () => {
    const store = new SharedMemoryTusStore();
    const { tusMod, start, patch, headOffset } = await initHttpTusContext(store);

    // Case A: fail atomic info write on Part 2 checkpoint (16 MiB) -> reverts sessionStore back to Part 1 (8 MiB) without leaving .tmp files
    const payload = makeOctetPayload(22 * MIB);
    const id = await start(payload.length, 'info-write-fail.bin');
    const infoPath = path.join(storageDir, 'tus', `${id}.info`);
    const writeSpy = injectAtomicInfoWriteFailure(
      infoPath,
      '"remoteFlushedBytes": 16777216',
      Object.assign(new Error('ENOSPC writing .info'), { code: 'ENOSPC' })
    );
    const failedRes = await patch(id, 0, payload.subarray(0, 18 * MIB));
    expect(failedRes.status).toBe(400);
    writeSpy.mockRestore();
    expect(fs.readdirSync(path.join(storageDir, 'tus')).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const revertedStore = await store.getSession(id);
    expect(revertedStore?.uploadOffset).toBe(8 * MIB);
    expect(revertedStore?.remoteFlushedBytes).toBe(8 * MIB);
    expect(revertedStore?.remoteParts?.map((p) => p.partNumber)).toEqual([1]);
    expect(await headOffset(id)).toBe(8 * MIB);
    expect(fs.statSync(path.join(storageDir, 'tus', `${id}.bin`)).size).toBe(0);

    const resumed = await patch(id, 8 * MIB, payload.subarray(8 * MIB));
    expect(resumed.status).toBe(204);
    expect(server.objects.get(resumed.headers.get('X-Storage-Key')!)?.body.equals(payload)).toBe(true);

    // Case B: session missing headerProbeBase64 probes only <= 64 KiB prefix via fd (zero readFile on .bin)
    const probePayload = makeFakePngPayload(10 * MIB);
    const idB = await start(probePayload.length, 'probe-fallback.png', 'image/png');
    const binPathB = path.join(storageDir, 'tus', `${idB}.bin`);
    expect((await patch(idB, 0, probePayload.subarray(0, 5 * MIB))).status).toBe(204);
    const storedSess = await store.getSession(idB);
    expect(storedSess?.headerProbeBase64).toBeTruthy();
    delete storedSess!.headerProbeBase64;
    await store.saveSession(storedSess!);

    const origReadFile = fs.promises.readFile.bind(fs.promises);
    const binReadFileCalls: string[] = [];
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (targetPath, ...args) => {
      if (String(targetPath) === binPathB) binReadFileCalls.push(String(targetPath));
      return origReadFile(targetPath, ...args);
    });
    const finalB = await tusMod.tusEngine.appendChunk(idB, 5 * MIB, Readable.from([probePayload.subarray(5 * MIB)]));
    expect(finalB.isComplete).toBe(true);
    expect(binReadFileCalls).toEqual([]);
    expect(server.objects.get(finalB.session.key)?.body.equals(probePayload)).toBe(true);
  });

  it('restores headerProbeBase64 when 0 < clientOffset < 64 KiB fails spoof check, info write, or syncStagedBytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { start, patch, headOffset } = await initHttpTusContext(store);

    // Case A: spoofed completion chunk at offset 4 restores 4-byte probe so valid PNG retry passes
    const validPng = makeFakePngPayload(9 * MIB);
    const idA = await start(validPng.length, 'retry-probe-complete.png', 'image/png');
    expect((await patch(idA, 0, validPng.subarray(0, 4))).status).toBe(204);

    const badRest = Buffer.alloc(validPng.length - 4, 0x00);
    const spoofRes = await patch(idA, 4, badRest);
    expect(spoofRes.status).toBe(400);
    expect(await headOffset(idA)).toBe(4);
    expect(Buffer.from((await store.getSession(idA))!.headerProbeBase64!, 'base64')).toEqual(validPng.subarray(0, 4));

    const validResA = await patch(idA, 4, validPng.subarray(4));
    expect(validResA.status).toBe(204);
    expect(server.objects.get(validResA.headers.get('X-Storage-Key')!)?.body.equals(validPng)).toBe(true);

    // Case B: incomplete .info failure after saveSession at offset 4 reverts Redis headerProbeBase64 and tail
    const validPngB = makeFakePngPayload(10 * MIB);
    const idB = await start(validPngB.length, 'retry-probe-incomplete.png', 'image/png');
    expect((await patch(idB, 0, validPngB.subarray(0, 4))).status).toBe(204);

    const infoPathB = path.join(storageDir, 'tus', `${idB}.info`);
    const writeSpy = injectAtomicInfoWriteFailure(
      infoPathB,
      `"uploadOffset": ${MIB + 4}`,
      Object.assign(new Error('ENOSPC writing .info'), { code: 'ENOSPC' })
    );
    const badIncomplete = Buffer.alloc(MIB, 0x00);
    const failInfo = await patch(idB, 4, badIncomplete);
    expect(failInfo.status).toBe(400);
    writeSpy.mockRestore();
    expect(fs.readdirSync(path.join(storageDir, 'tus')).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    expect(await headOffset(idB)).toBe(4);
    expect(store.stagedByteCount(idB)).toBe(4);
    expect(fs.statSync(path.join(storageDir, 'tus', `${idB}.bin`)).size).toBe(4);
    expect(Buffer.from((await store.getSession(idB))!.headerProbeBase64!, 'base64')).toEqual(validPngB.subarray(0, 4));

    // Case C: syncStagedBytes failure at offset 4 rolls back .bin, marker, and headerProbeBase64
    vi.spyOn(store, 'syncStagedBytes').mockRejectedValueOnce(new Error('transient sync error'));
    const failSync = await patch(idB, 4, badIncomplete);
    expect(failSync.status).toBe(400);
    expect(fs.statSync(path.join(storageDir, 'tus', `${idB}.bin`)).size).toBe(4);

    const validResB = await patch(idB, 4, validPngB.subarray(4));
    expect(validResB.status).toBe(204);
    expect(server.objects.get(validResB.headers.get('X-Storage-Key')!)?.body.equals(validPngB)).toBe(true);
  });

  it('reopens fresh multipart upload when recordTusUpload returns 503 after mid-completion checkpoint with savedFlushed=0, and resumes on CompleteMultipartUpload 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { start, patch, headOffset } = await initHttpTusContext(store);
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-fd-ledger-'));
    try {
      const { FileRetentionLedger, setRetentionLedger } = await import('../src/lib/storage/retention-ledger');
      const realLedger = new FileRetentionLedger(ledgerDir);
      let failRecordOnce = true;
      setRetentionLedger({
        get: realLedger.get.bind(realLedger),
        forget: realLedger.forget.bind(realLedger),
        collectDue: realLedger.collectDue.bind(realLedger),
        liveRecords: realLedger.liveRecords.bind(realLedger),
        update: (async (...args: Parameters<typeof realLedger.update>) => {
          if (failRecordOnce) {
            failRecordOnce = false;
            throw new Error('transient ledger outage');
          }
          return realLedger.update(...args);
        }) as typeof realLedger.update,
      });

      // Case A: savedFlushed=0, 4 MiB already staged, final 14 MiB PATCH checkpoints Part 1 (8 MiB), completes S3, then recordTusUpload fails -> 503 reopen to 4 MiB
      const payloadA = makeOctetPayload(18 * MIB);
      const idA = await start(payloadA.length, 'record-503-after-ckpt.bin');
      expect((await patch(idA, 0, payloadA.subarray(0, 4 * MIB))).status).toBe(204);
      const origUploadId = (await store.getSession(idA))!.remoteUploadId!;

      const res503 = await patch(idA, 4 * MIB, payloadA.subarray(4 * MIB));
      expect(res503.status).toBe(503);
      expect(server.objects.size).toBe(0);
      expect(await headOffset(idA)).toBe(4 * MIB);
      const reopened = await store.getSession(idA);
      expect(reopened?.remoteUploadId).toBeTruthy();
      expect(reopened?.remoteUploadId).not.toBe(origUploadId);
      expect(reopened?.remoteFlushedBytes).toBe(0);
      expect(reopened?.remoteParts).toEqual([]);
      expect(fs.statSync(path.join(storageDir, 'tus', `${idA}.bin`)).size).toBe(4 * MIB);

      const retriedA = await patch(idA, 4 * MIB, payloadA.subarray(4 * MIB));
      expect(retriedA.status).toBe(204);
      expect(server.objects.get(retriedA.headers.get('X-Storage-Key')!)?.body.equals(payloadA)).toBe(true);

      // Case B: completeMultipartUpload returns 500 after Parts 1 & 2 checkpointed -> HEAD returns 16 MiB, retry sends only final 3 MiB
      const payloadB = makeOctetPayload(19 * MIB);
      const idB = await start(payloadB.length, 'complete-500-after-ckpt.bin');
      server.faults.push({
        match: (r) => r.method === 'POST' && r.query.has('uploadId'),
        status: 500,
        code: 'InjectedCompleteFailure',
        times: Infinity,
      });
      const reqBeforeB = server.requests.length;
      const failComplete = await patch(idB, 0, payloadB);
      expect(failComplete.status).toBe(503);
      server.faults.length = 0;
      expect(await headOffset(idB)).toBe(16 * MIB);
      expect(fs.statSync(path.join(storageDir, 'tus', `${idB}.bin`)).size).toBe(0);

      const okComplete = await patch(idB, 16 * MIB, payloadB.subarray(16 * MIB));
      expect(okComplete.status).toBe(204);
      expect(server.objects.get(okComplete.headers.get('X-Storage-Key')!)?.body.equals(payloadB)).toBe(true);
      const partsSentB = server.requests
        .slice(reqBeforeB)
        .filter((r) => r.method === 'PUT' && r.query.has('partNumber'))
        .map((r) => Number(r.query.get('partNumber')));
      expect(partsSentB).toEqual([1, 2, 3, 3]);
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('truncates .bin in place under ENOSPC recovery and works with InMemoryTusSessionStore and pipelined RedisTusSessionStore', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Case A: ENOSPC during writeTailFileAtomic on Part 2 failure still truncates .bin in place and clears staged tail
    const memStore = new SharedMemoryTusStore();
    const ctxA = await initHttpTusContext(memStore);
    const payloadA = makeOctetPayload(22 * MIB);
    const idA = await ctxA.start(payloadA.length, 'enospc-recovery.bin');
    const origWriteFile = fs.promises.writeFile.bind(fs.promises);
    const enospcSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (targetPath, data, ...rest) => {
      if (String(targetPath).includes(`${idA}.bin.`) && String(targetPath).endsWith('.tail')) {
        throw Object.assign(new Error('ENOSPC creating .tail'), { code: 'ENOSPC' });
      }
      return origWriteFile(targetPath, data, ...rest);
    });
    const failA = await ctxA.patch(idA, 0, payloadA.subarray(0, 18 * MIB));
    expect(failA.status).toBe(400);
    enospcSpy.mockRestore();
    expect(await ctxA.headOffset(idA)).toBe(16 * MIB);
    expect(fs.statSync(path.join(storageDir, 'tus', `${idA}.bin`)).size).toBe(0);
    expect(memStore.stagedByteCount(idA)).toBe(0);
    const doneA = await ctxA.patch(idA, 16 * MIB, payloadA.subarray(16 * MIB));
    expect(doneA.status).toBe(204);
    expect(server.objects.get(doneA.headers.get('X-Storage-Key')!)?.body.equals(payloadA)).toBe(true);

    // Case B: InMemoryTusSessionStore (default non-Redis mode) multi-chunk flush & mid-flush failure recovery
    const { InMemoryTusSessionStore } = await import('../src/lib/storage/tus-engine');
    const ctxB = await initHttpTusContext(new InMemoryTusSessionStore());
    const payloadB = makeOctetPayload(19 * MIB);
    const idB = await ctxB.start(payloadB.length, 'inmemory-remote.bin');
    server.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '2',
      status: 400,
      code: 'InjectedInMemoryPart2Fail',
      times: 1,
    });
    expect((await ctxB.patch(idB, 0, payloadB.subarray(0, 17 * MIB))).status).toBe(500);
    expect(await ctxB.headOffset(idB)).toBe(8 * MIB);
    const doneB = await ctxB.patch(idB, 8 * MIB, payloadB.subarray(8 * MIB));
    expect(doneB.status).toBe(204);
    expect(server.objects.get(doneB.headers.get('X-Storage-Key')!)?.body.equals(payloadB)).toBe(true);

    // Case C: RedisTusSessionStore pipelined replaceStagedTailBytes + cross-replica resume
    const strings = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const zsets = new Map<string, Map<string, number>>();
    const sets = new Map<string, Set<string>>();
    const pipeOps: string[][] = [];
    const fakeRedis = {
      status: 'ready',
      get: vi.fn(async (k: string) => strings.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        strings.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        let n = 0;
        for (const k of keys) {
          if (strings.delete(k)) n++;
          if (lists.delete(k)) n++;
        }
        return n;
      }),
      rpush: vi.fn(async (k: string, ...vals: string[]) => {
        const list = lists.get(k) ?? [];
        list.push(...vals);
        lists.set(k, list);
        return list.length;
      }),
      lrange: vi.fn(async (k: string, start: number, stop: number) => (lists.get(k) ?? []).slice(start, stop + 1)),
      expire: vi.fn(async () => 1),
      sadd: vi.fn(async (k: string, ...m: string[]) => {
        const s = sets.get(k) ?? new Set<string>();
        m.forEach((v) => s.add(v));
        sets.set(k, s);
        return m.length;
      }),
      zadd: vi.fn(async (k: string, score: number, m: string) => {
        const z = zsets.get(k) ?? new Map<string, number>();
        z.set(m, score);
        zsets.set(k, z);
        return 1;
      }),
      zrem: vi.fn(async (k: string, m: string) => (zsets.get(k)?.delete(m) ? 1 : 0)),
      eval: vi.fn(async () => 1),
      pipeline: vi.fn(() => {
        const queued: Array<{ op: string; args: unknown[] }> = [];
        const pipe = {
          del: (...args: unknown[]) => (queued.push({ op: 'del', args }), pipe),
          rpush: (...args: unknown[]) => (queued.push({ op: 'rpush', args }), pipe),
          set: (...args: unknown[]) => (queued.push({ op: 'set', args }), pipe),
          expire: (...args: unknown[]) => (queued.push({ op: 'expire', args }), pipe),
          exec: async () => {
            pipeOps.push(queued.map((q) => q.op));
            const out: Array<[null, unknown]> = [];
            for (const q of queued) {
              if (q.op === 'del') out.push([null, await fakeRedis.del(...(q.args as string[]))]);
              else if (q.op === 'rpush') out.push([null, await fakeRedis.rpush(q.args[0] as string, ...(q.args.slice(1) as string[]))]);
              else if (q.op === 'set') out.push([null, await fakeRedis.set(q.args[0] as string, q.args[1] as string)]);
              else out.push([null, 1]);
            }
            return out;
          },
        };
        return pipe;
      }),
    };
    const { RedisTusSessionStore, TusEngine } = await import('../src/lib/storage/tus-engine');
    const redisStore = new RedisTusSessionStore(fakeRedis as never);
    const ctxC = await initHttpTusContext(redisStore);
    const payloadC = makeOctetPayload(19 * MIB);
    const idC = await ctxC.start(payloadC.length, 'redis-pipelined.bin');

    // 10 MiB PATCH -> flushes 8 MiB, pipelines 2 MiB leftover into Redis via replaceStagedTailBytes
    expect((await ctxC.patch(idC, 0, payloadC.subarray(0, 10 * MIB))).status).toBe(204);
    expect(pipeOps).toEqual([['del', 'rpush', 'set', 'expire']]);
    expect(strings.get(`tus:stage:{${idC}}:len`)).toBe(String(2 * MIB));

    // Replica B (empty replicaDirB) hydrates 2 MiB from Redis and completes remaining 9 MiB
    const replicaB = new TusEngine({ tusDir: replicaDirB });
    const doneC = await replicaB.appendChunk(idC, 10 * MIB, Readable.from([payloadC.subarray(10 * MIB)]));
    expect(doneC.isComplete).toBe(true);
    expect(server.objects.get(doneC.session.key)?.body.equals(payloadC)).toBe(true);
    expect(strings.has(`tus:stage:{${idC}}:len`)).toBe(false);
    expect(lists.has(`tus:stage:{${idC}}:chunks`)).toBe(false);
  });

  it('clears and truncates tail and headerProbeBase64 on assertStagedSize short-tail failure in completeRemoteMultipartUpload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { start, patch, headOffset } = await initHttpTusContext(store);

    // Case A: initialFlushed === 0 && clientOffset === 0 short-tail failure clears probe and truncates .bin
    const validPng = makeFakePngPayload(9 * MIB);
    const spoofed = Buffer.alloc(validPng.length, 0x41);
    const idA = await start(validPng.length, 'assert-size-zero.png', 'image/png');
    const binPathA = path.join(storageDir, 'tus', `${idA}.bin`);

    const origStat = fs.promises.stat.bind(fs.promises);
    let injectZeroOnce = true;
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (targetPath, ...args) => {
      const real = await origStat(targetPath, ...args);
      if (injectZeroOnce && String(targetPath) === binPathA && real.size === validPng.length) {
        injectZeroOnce = false;
        return { ...real, size: 0 } as fs.Stats;
      }
      return real;
    });

    const failA = await patch(idA, 0, validPng);
    expect(failA.status).toBe(400);
    statSpy.mockRestore();

    expect(fs.statSync(binPathA).size).toBe(0);
    expect(await headOffset(idA)).toBe(0);
    const sessA = await store.getSession(idA);
    expect(sessA?.completed).toBe(false);
    expect(sessA?.uploadOffset).toBe(0);
    expect(sessA?.headerProbeBase64).toBeUndefined();
    const infoOnDiskA = JSON.parse(fs.readFileSync(path.join(storageDir, 'tus', `${idA}.info`), 'utf-8')) as TusSession;
    expect(infoOnDiskA.completed).toBe(false);
    expect(infoOnDiskA.uploadOffset).toBe(0);
    expect(infoOnDiskA.headerProbeBase64).toBeUndefined();

    // Retry with spoofed payload at offset 0 is rejected before uploading any part
    const reqBeforeSpoof = server.requests.length;
    const spoofRetry = await patch(idA, 0, spoofed);
    expect(spoofRetry.status).toBe(400);
    expect(server.requests.slice(reqBeforeSpoof).filter((r) => r.method === 'PUT' && r.query.has('partNumber'))).toHaveLength(0);
    expect((await store.getSession(idA))?.headerProbeBase64).toBeUndefined();

    // Retry with valid payload succeeds
    const okA = await patch(idA, 0, validPng);
    expect(okA.status).toBe(204);
    expect(server.objects.get(okA.headers.get('X-Storage-Key')!)?.body.equals(validPng)).toBe(true);

    // Case B: 0 < clientOffset < 64 KiB short-tail failure slices savedHeaderProbe to revertedTail and truncates .bin
    const validPngB = makeFakePngPayload(9 * MIB);
    const idB = await start(validPngB.length, 'assert-size-partial.png', 'image/png');
    const binPathB = path.join(storageDir, 'tus', `${idB}.bin`);
    expect((await patch(idB, 0, validPngB.subarray(0, 8))).status).toBe(204);

    let injectFourOnce = true;
    const statSpyB = vi.spyOn(fs.promises, 'stat').mockImplementation(async (targetPath, ...args) => {
      const real = await origStat(targetPath, ...args);
      if (injectFourOnce && String(targetPath) === binPathB && real.size === validPngB.length) {
        injectFourOnce = false;
        return { ...real, size: 4 } as fs.Stats;
      }
      return real;
    });
    const failB = await patch(idB, 8, validPngB.subarray(8));
    expect(failB.status).toBe(400);
    statSpyB.mockRestore();

    expect(fs.statSync(binPathB).size).toBe(4);
    expect(await headOffset(idB)).toBe(4);
    const sessB = await store.getSession(idB);
    expect(sessB?.headerProbeBase64).toBe(validPngB.subarray(0, 4).toString('base64'));

    // Spoofing bytes 4..7 on retry is still caught (stale 8-byte/64 KiB probe did not survive)
    const spoofTailB = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.alloc(validPngB.length - 8, 0x33)]);
    expect((await patch(idB, 4, spoofTailB)).status).toBe(400);

    const okB = await patch(idB, 4, validPngB.subarray(4));
    expect(okB.status).toBe(204);
    expect(server.objects.get(okB.headers.get('X-Storage-Key')!)?.body.equals(validPngB)).toBe(true);

    // Case C: actualTail > expectedLocalTailOffset clamps revertedTail to clientOffset and preserves savedHeaderProbe
    const validPngC = makeFakePngPayload(9 * MIB);
    const idC = await start(validPngC.length, 'assert-size-overshoot.png', 'image/png');
    const binPathC = path.join(storageDir, 'tus', `${idC}.bin`);
    expect((await patch(idC, 0, validPngC.subarray(0, 8))).status).toBe(204);

    let injectHundredOnce = true;
    const statSpyC = vi.spyOn(fs.promises, 'stat').mockImplementation(async (targetPath, ...args) => {
      const real = await origStat(targetPath, ...args);
      if (injectHundredOnce && String(targetPath) === binPathC && real.size === validPngC.length) {
        injectHundredOnce = false;
        return { ...real, size: 100 } as fs.Stats;
      }
      return real;
    });
    const failC = await patch(idC, 8, validPngC.subarray(8));
    expect(failC.status).toBe(400);
    statSpyC.mockRestore();

    expect(fs.statSync(binPathC).size).toBe(8);
    expect(await headOffset(idC)).toBe(8);
    expect((await store.getSession(idC))?.headerProbeBase64).toBe(validPngC.subarray(0, 8).toString('base64'));
    const okC = await patch(idC, 8, validPngC.subarray(8));
    expect(okC.status).toBe(204);
    expect(server.objects.get(okC.headers.get('X-Storage-Key')!)?.body.equals(validPngC)).toBe(true);
  });

  it('preserves streamed headerProbeBase64 across transient Part 1 saveSession failure and Part 2 checkpoint in 20 MiB completion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new SharedMemoryTusStore();
    const { start, patch, headOffset } = await initHttpTusContext(store);
    const payload = makeFakePngPayload(20 * MIB);
    const id = await start(payload.length, 'transient-p1-probe.png', 'image/png');
    const binPath = path.join(storageDir, 'tus', `${id}.bin`);

    // Part 1 saveSession throws transiently (8 MiB), Part 2 saveSession succeeds (16 MiB)
    const origSave = store.saveSession.bind(store);
    let failPart1Once = true;
    const saveSpy = vi.spyOn(store, 'saveSession').mockImplementation(async (session) => {
      if (failPart1Once && session.id === id && session.remoteFlushedBytes === 8 * MIB) {
        failPart1Once = false;
        throw new Error('transient Part 1 checkpoint failure');
      }
      return origSave(session);
    });

    // Part 3 uploadPart fails -> truncates .bin to 0 and keeps Part 2 checkpoint
    server.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '3',
      status: 400,
      code: 'InjectedPart3Failure',
      times: 1,
    });

    const failRes = await patch(id, 0, payload);
    expect(failRes.status).toBe(500);
    saveSpy.mockRestore();

    expect(await headOffset(id)).toBe(16 * MIB);
    expect(fs.statSync(binPath).size).toBe(0);
    const saved = await store.getSession(id);
    expect(saved?.remoteFlushedBytes).toBe(16 * MIB);
    expect(saved?.remoteParts?.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(typeof saved?.headerProbeBase64).toBe('string');
    expect(Buffer.from(saved!.headerProbeBase64!, 'base64').subarray(0, 8).equals(payload.subarray(0, 8))).toBe(true);

    // Resuming remaining 4 MiB completes cleanly with 204 (no false 400 spoof rejection)
    const okRes = await patch(id, 16 * MIB, payload.subarray(16 * MIB));
    expect(okRes.status).toBe(204);
    const key = okRes.headers.get('X-Storage-Key')!;
    expect(server.objects.get(key)?.body.equals(payload)).toBe(true);
  });

  it('cleans up remoteUploadId and files on createSession failure, and sweeps/terminates orphaned .tail/.hydrate/.tmp files', async () => {
    const store = new SharedMemoryTusStore();
    const { tusMod } = await initHttpTusContext(store);
    const tusDir = path.join(storageDir, 'tus');
    const engine = new tusMod.TusEngine({ tusDir, defaultTtlSeconds: 3600 });

    // 1. createSession failure (saveSession throws) aborts remoteUploadId, clears partial store keys, and removes .info/.bin
    vi.spyOn(store, 'saveSession').mockRejectedValueOnce(new Error('session store unavailable on create'));
    await expect(
      engine.createSession({
        uploadLength: 10 * MIB,
        metadataHeader: 'filename Y3JlYXRlLWZhaWwuYmlu,filetype YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt',
      })
    ).rejects.toThrow('session store unavailable on create');
    expect(server.uploads.size).toBe(0);
    expect(server.requests.some((r) => r.method === 'DELETE' && r.query.has('uploadId'))).toBe(true);
    expect(fs.readdirSync(tusDir)).toEqual([]);

    const partialStrings = new Map<string, string>();
    const partialZsets = new Map<string, Map<string, number>>();
    const partialRedis = {
      status: 'ready',
      get: vi.fn(async (k: string) => partialStrings.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        partialStrings.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        let count = 0;
        for (const k of keys) if (partialStrings.delete(k)) count += 1;
        return count;
      }),
      zadd: vi.fn(async (k: string, score: number, member: string) => {
        const z = partialZsets.get(k) ?? new Map<string, number>();
        z.set(member, score);
        partialZsets.set(k, z);
        return 1;
      }),
      zrem: vi.fn(async (k: string, member: string) => (partialZsets.get(k)?.delete(member) ? 1 : 0)),
      sadd: vi.fn(async () => {
        throw new Error('owner index sadd failed');
      }),
    };
    tusMod.setTusSessionStore(new tusMod.RedisTusSessionStore(partialRedis as never));
    try {
      await expect(
        engine.createSession({
          uploadLength: 10 * MIB,
          ownerUserId: 'partial-create-user',
          metadataHeader: 'filename cGFydGlhbC1mYWlsLmJpbg==,filetype YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt',
        })
      ).rejects.toThrow('owner index sadd failed');
      expect(partialStrings.size).toBe(0);
      expect(partialZsets.get('tus:remote_expiry')?.size ?? 0).toBe(0);
      expect(server.uploads.size).toBe(0);
      expect(fs.readdirSync(tusDir)).toEqual([]);
    } finally {
      tusMod.setTusSessionStore(store);
    }

    // 2. terminateSession & terminateSessionsOfOwner unlink .tail, .hydrate, and .tmp files for that session only
    const sessOwner = await engine.createSession({
      uploadLength: 1024,
      ownerUserId: 'erasure-user-1',
    });
    const sessOther = await engine.createSession({
      uploadLength: 1024,
      ownerUserId: 'erasure-user-2',
    });
    const ownerTemps = [
      `${sessOwner.id}.bin.a1b2c3d4e5f6.tail`,
      `${sessOwner.id}.bin.b2c3d4e5f6a1.hydrate`,
      `${sessOwner.id}.info.c3d4e5f6a1b2.tmp`,
    ];
    for (const file of ownerTemps) fs.writeFileSync(path.join(tusDir, file), 'remnant');
    const otherTemp = `${sessOther.id}.bin.112233445566.tail`;
    fs.writeFileSync(path.join(tusDir, otherTemp), 'keep-other');

    const terminatedIds = await engine.terminateSessionsOfOwner('erasure-user-1');
    expect(terminatedIds).toEqual([sessOwner.id]);
    for (const file of ownerTemps) expect(fs.existsSync(path.join(tusDir, file))).toBe(false);
    expect(fs.existsSync(path.join(tusDir, `${sessOwner.id}.info`))).toBe(false);
    expect(fs.existsSync(path.join(tusDir, `${sessOwner.id}.bin`))).toBe(false);
    expect(fs.existsSync(path.join(tusDir, otherTemp))).toBe(true);

    // terminateSession also returns true and removes stray temp files when .info/.bin/store entry are already absent
    const orphanOnlyId = `tus_${Date.now()}_0011223344556677`;
    const orphanOnlyTail = `${orphanOnlyId}.bin.abcdef012345.tail`;
    fs.writeFileSync(path.join(tusDir, orphanOnlyTail), 'orphan');
    expect(await engine.terminateSession(orphanOnlyId)).toBe(true);
    expect(fs.existsSync(path.join(tusDir, orphanOnlyTail))).toBe(false);

    // 3. sweepExpired unlinks orphaned temp files by old ID and by stale mtime while sparing fresh live temps
    const oldId = `tus_${Date.now() - 3 * 86_400_000}_fedcba9876543210`;
    const staleByIdFiles = [
      `${oldId}.bin.111111111111.tail`,
      `${oldId}.bin.222222222222.hydrate`,
      `${oldId}.info.333333333333.tmp`,
    ];
    for (const file of staleByIdFiles) fs.writeFileSync(path.join(tusDir, file), 'old-id-temp');

    const staleByMtimeFiles = [
      `${sessOther.id}.bin.444444444444.tail`,
      `${sessOther.id}.bin.555555555555.hydrate`,
      `${sessOther.id}.info.666666666666.tmp`,
    ];
    const staleDate = new Date(Date.now() - 3_700_000);
    for (const file of staleByMtimeFiles) {
      const full = path.join(tusDir, file);
      fs.writeFileSync(full, 'stale-mtime-temp');
      fs.utimesSync(full, staleDate, staleDate);
    }

    const swept = await engine.sweepExpired();
    expect(swept).toBe(0);
    for (const file of [...staleByIdFiles, ...staleByMtimeFiles]) {
      expect(fs.existsSync(path.join(tusDir, file))).toBe(false);
    }
    // Live session and its fresh temp file remain intact
    expect(fs.existsSync(path.join(tusDir, otherTemp))).toBe(true);
    expect(fs.existsSync(path.join(tusDir, `${sessOther.id}.info`))).toBe(true);
  });

  it('handles writeTextFileAtomic cleanup, hydrateStagedFile short writes, Cluster partial-write cleanup, and local short-tail rollback', async () => {
    // 1. writeTextFileAtomic creates parent dir, loops short writes, and deletes .tmp on write or rename failure
    const atomicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-atomic-'));
    try {
      const nestedInfo = path.join(atomicDir, 'nested', 'test.info');
      await writeTextFileAtomic(nestedInfo, '{"v":1}');
      expect(fs.readFileSync(nestedInfo, 'utf-8')).toBe('{"v":1}');

      const origAtomicOpen = fs.promises.open.bind(fs.promises);
      let shortAtomicWrites = 0;
      const shortOpenSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (targetPath, ...args) => {
        const opened = await origAtomicOpen(targetPath, ...args);
        if (String(targetPath).endsWith('.tmp')) {
          const origWrite = opened.write.bind(opened);
          vi.spyOn(opened, 'write').mockImplementation((async (
            buf: NodeJS.ArrayBufferView,
            offset?: number | null,
            length?: number | null,
            position?: number | null
          ) => {
            shortAtomicWrites += 1;
            return origWrite(buf, offset ?? 0, Math.min(3, length ?? 0), position ?? null);
          }) as unknown as typeof opened.write);
        }
        return opened;
      });
      await writeTextFileAtomic(nestedInfo, '{"v":"short-write"}');
      shortOpenSpy.mockRestore();
      expect(shortAtomicWrites).toBeGreaterThanOrEqual(5);
      expect(fs.readFileSync(nestedInfo, 'utf-8')).toBe('{"v":"short-write"}');

      const writeErrSpy = injectAtomicInfoWriteFailure(nestedInfo, '"v":3', new Error('ENOSPC mid-write'));
      await expect(writeTextFileAtomic(nestedInfo, '{"v":3}')).rejects.toThrow('ENOSPC mid-write');
      writeErrSpy.mockRestore();
      expect(fs.readFileSync(nestedInfo, 'utf-8')).toBe('{"v":"short-write"}');
      expect(fs.readdirSync(path.dirname(nestedInfo))).toEqual(['test.info']);

      const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EXDEV rename failed'));
      await expect(writeTextFileAtomic(nestedInfo, '{"v":2}')).rejects.toThrow('EXDEV rename failed');
      renameSpy.mockRestore();
      expect(fs.readFileSync(nestedInfo, 'utf-8')).toBe('{"v":"short-write"}');
      expect(fs.readdirSync(path.dirname(nestedInfo))).toEqual(['test.info']);
    } finally {
      fs.rmSync(atomicDir, { recursive: true, force: true });
    }

    // 2. RedisTusSessionStore.hydrateStagedFile loops across short POSIX handle.write calls and cleans up .hydrate on error
    const { RedisTusSessionStore } = await import('../src/lib/storage/tus-engine');
    const strings = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const delCalls: string[][] = [];
    let failClusterOp: 'rpush' | 'set' | null = null;
    const clusterRedis = {
      status: 'ready',
      isCluster: true,
      get: vi.fn(async (k: string) => strings.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        if (failClusterOp === 'set') throw new Error('cluster set error');
        strings.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        delCalls.push(keys);
        let n = 0;
        for (const k of keys) {
          if (strings.delete(k)) n++;
          if (lists.delete(k)) n++;
        }
        return n;
      }),
      rpush: vi.fn(async (k: string, ...vals: string[]) => {
        if (failClusterOp === 'rpush' && (lists.get(k)?.length ?? 0) >= 1) {
          throw new Error('cluster rpush mid-loop error');
        }
        const list = lists.get(k) ?? [];
        list.push(...vals);
        lists.set(k, list);
        return list.length;
      }),
      lrange: vi.fn(async (k: string, start: number, stop: number) => (lists.get(k) ?? []).slice(start, stop + 1)),
      expire: vi.fn(async () => 1),
    };
    const redisStore = new RedisTusSessionStore(clusterRedis as never);
    const hydrateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-hydrate-short-'));
    try {
      const id = 'tus_1700000000099_1122334455667788';
      const binPath = path.join(hydrateDir, `${id}.bin`);
      const chunksKey = `tus:stage:{${id}}:chunks`;
      const lenKey = `tus:stage:{${id}}:len`;

      // Cluster fallback mid-sequence failure cleans up chunksKey + lenKey
      const bigTail = makeOctetPayload(2 * MIB + 512);
      fs.writeFileSync(binPath, bigTail);
      failClusterOp = 'rpush';
      await expect(redisStore.syncStagedBytes(id, binPath, 0, bigTail.length, 1800)).rejects.toThrow(
        'cluster rpush mid-loop error'
      );
      expect(lists.has(chunksKey)).toBe(false);
      expect(strings.has(lenKey)).toBe(false);
      expect(delCalls.at(-1)).toEqual([chunksKey, lenKey]);

      failClusterOp = 'set';
      await expect(redisStore.replaceStagedTailBytes(id, bigTail, 1800)).rejects.toThrow('cluster set error');
      expect(lists.has(chunksKey)).toBe(false);
      expect(strings.has(lenKey)).toBe(false);
      failClusterOp = null;

      // hydrateStagedFile succeeds across 3-byte short POSIX writes
      const shortPayload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      lists.set(chunksKey, [
        shortPayload.subarray(0, 16).toString('base64'),
        shortPayload.subarray(16).toString('base64'),
      ]);
      strings.set(lenKey, String(shortPayload.length));
      fs.rmSync(binPath, { force: true });

      const origOpen = fs.promises.open.bind(fs.promises);
      let shortWriteCalls = 0;
      const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (targetPath, ...args) => {
        const opened = await origOpen(targetPath, ...args);
        if (String(targetPath).endsWith('.hydrate')) {
          const origWrite = opened.write.bind(opened);
          vi.spyOn(opened, 'write').mockImplementation((async (
            buf: NodeJS.ArrayBufferView,
            offset?: number | null,
            length?: number | null,
            position?: number | null
          ) => {
            shortWriteCalls += 1;
            const capped = Math.min(3, length ?? 0);
            return origWrite(buf, offset ?? 0, capped, position ?? null);
          }) as unknown as typeof opened.write);
        }
        return opened;
      });
      const hydrated = await redisStore.hydrateStagedFile(id, binPath, shortPayload.length);
      openSpy.mockRestore();
      expect(hydrated).toBe(shortPayload.length);
      expect(shortWriteCalls).toBeGreaterThanOrEqual(12);
      expect(fs.readFileSync(binPath).equals(shortPayload)).toBe(true);
      expect(fs.readdirSync(hydrateDir)).toEqual([`${id}.bin`]);

      // Zero-byte short write throws and cleans up .hydrate temp file without corrupting binPath
      const zeroOpenSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (targetPath, ...args) => {
        const opened = await origOpen(targetPath, ...args);
        if (String(targetPath).endsWith('.hydrate')) {
          vi.spyOn(opened, 'write').mockResolvedValueOnce({ bytesWritten: 0, buffer: Buffer.alloc(0) } as never);
        }
        return opened;
      });
      await expect(redisStore.hydrateStagedFile(id, binPath, shortPayload.length)).rejects.toThrow('Short write (0 bytes)');
      zeroOpenSpy.mockRestore();
      expect(fs.readFileSync(binPath).equals(shortPayload)).toBe(true);
      expect(fs.readdirSync(hydrateDir)).toEqual([`${id}.bin`]);
    } finally {
      fs.rmSync(hydrateDir, { recursive: true, force: true });
    }

    // 3. completeLocalStagedTus short-tail failure rolls back .bin, localTailMarkers, and uploadOffset
    vi.stubEnv('STORAGE_DRIVER', 'local');
    vi.resetModules();
    const localTusMod = await import('../src/lib/storage/tus-engine');
    const localMemStore = new localTusMod.InMemoryTusSessionStore();
    localTusMod.setTusSessionStore(localMemStore);
    const localTusDir = path.join(storageDir, 'tus-local-short');
    const localEngine = new localTusMod.TusEngine({ tusDir: localTusDir });
    const localPayload = Buffer.from('LOCAL_TUS_PAYLOAD_0123456789');
    const localSess = await localEngine.createSession({
      uploadLength: localPayload.length,
      metadataHeader: localTusMod.serializeTusMetadata({ filename: 'local-short.txt', filetype: 'text/plain' }),
    });
    await localEngine.appendChunk(localSess.id, 0, Readable.from([localPayload.subarray(0, 10)]));

    const localBinPath = path.join(localTusDir, `${localSess.id}.bin`);
    const origLocalStat = fs.promises.stat.bind(fs.promises);
    let injectLocalShortOnce = true;
    const localStatSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (targetPath, ...args) => {
      const real = await origLocalStat(targetPath, ...args);
      if (injectLocalShortOnce && String(targetPath) === localBinPath && real.size === localPayload.length) {
        injectLocalShortOnce = false;
        return { ...real, size: 6 } as fs.Stats;
      }
      return real;
    });
    await expect(
      localEngine.appendChunk(localSess.id, 10, Readable.from([localPayload.subarray(10)]))
    ).rejects.toBeInstanceOf(localTusMod.TusStagedSizeMismatchError);
    localStatSpy.mockRestore();

    expect(fs.statSync(localBinPath).size).toBe(6);
    expect((await localMemStore.getSession(localSess.id))?.uploadOffset).toBe(6);
    expect(
      (localEngine as unknown as { localTailMarkers: Map<string, string> }).localTailMarkers.get(localSess.id)
    ).toBe('0:6');
    const localDone = await localEngine.appendChunk(localSess.id, 6, Readable.from([localPayload.subarray(6)]));
    expect(localDone.isComplete).toBe(true);
    expect(localDone.newOffset).toBe(localPayload.length);
    const { localFsStorage } = await import('../src/lib/storage/local-fs-storage');
    const storedLocal = await localFsStorage.getBuffer(localDone.session.key);
    expect(storedLocal?.equals(localPayload)).toBe(true);
    await localFsStorage.delete(localDone.session.key).catch(() => false);
    localTusMod.setTusSessionStore(null);
  });
});
