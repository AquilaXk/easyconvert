import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StorageServiceError } from '../src/lib/storage/adapters/adapter-interface';
import { localFsStorage } from '../src/lib/storage/local-fs-storage';
import { storageProvider } from '../src/lib/storage/selected-storage';
import {
  MAX_REDIS_STAGED_UPLOAD_BYTES,
  RedisTusSessionStore,
  TUS_REMOTE_PART_BYTES,
  TusEngine,
  TusStagedSizeMismatchError,
  serializeTusMetadata,
  setTusSessionStore,
} from '../src/lib/storage/tus-engine';

interface FakePipelineCall {
  op: 'del' | 'rpush' | 'set' | 'expire';
  args: unknown[];
}

function createFakeRedis(options?: { isCluster?: boolean }) {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const expCalls: Array<{ key: string; ttl: number }> = [];
  const delCalls: string[][] = [];
  const getCalls: string[] = [];
  const rpushCalls: Array<{ key: string; count: number }> = [];
  const pipelineExecs: FakePipelineCall[][] = [];

  const applyDel = (keys: string[]) => {
    delCalls.push(keys);
    let count = 0;
    for (const k of keys) {
      if (strings.delete(k)) count += 1;
      if (lists.delete(k)) count += 1;
    }
    return count;
  };

  const applyRpush = (key: string, values: string[]) => {
    rpushCalls.push({ key, count: values.length });
    const list = lists.get(key) ?? [];
    list.push(...values);
    lists.set(key, list);
    return list.length;
  };

  const applySet = (key: string, value: string) => {
    strings.set(key, value);
    return 'OK';
  };

  const applyExpire = (key: string, ttl: number) => {
    expCalls.push({ key, ttl });
    return strings.has(key) || lists.has(key) ? 1 : 0;
  };

  const client = {
    status: 'ready',
    ...(options?.isCluster ? { isCluster: true } : {}),
    get: vi.fn(async (key: string) => {
      getCalls.push(key);
      return strings.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => applySet(key, value)),
    del: vi.fn(async (...keys: string[]) => applyDel(keys)),
    rpush: vi.fn(async (key: string, ...values: string[]) => applyRpush(key, values)),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop + 1);
    }),
    expire: vi.fn(async (key: string, ttl: number) => applyExpire(key, ttl)),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key) ?? new Set<string>();
      for (const m of members) s.add(m);
      sets.set(key, s);
      return members.length;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) if (s.delete(m)) removed += 1;
      return removed;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, score);
      zsets.set(key, z);
      return 1;
    }),
    zrem: vi.fn(async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0)),
    pipeline: vi.fn(() => {
      const queued: FakePipelineCall[] = [];
      const pipe = {
        del: (...keys: string[]) => {
          queued.push({ op: 'del', args: keys });
          return pipe;
        },
        rpush: (key: string, ...values: string[]) => {
          queued.push({ op: 'rpush', args: [key, ...values] });
          return pipe;
        },
        set: (key: string, value: string, ...rest: unknown[]) => {
          queued.push({ op: 'set', args: [key, value, ...rest] });
          return pipe;
        },
        expire: (key: string, ttl: number) => {
          queued.push({ op: 'expire', args: [key, ttl] });
          return pipe;
        },
        exec: async () => {
          pipelineExecs.push([...queued]);
          const replies: Array<[null, unknown]> = [];
          for (const cmd of queued) {
            if (cmd.op === 'del') replies.push([null, applyDel(cmd.args as string[])]);
            else if (cmd.op === 'rpush') replies.push([null, applyRpush(cmd.args[0] as string, cmd.args.slice(1) as string[])]);
            else if (cmd.op === 'set') replies.push([null, applySet(cmd.args[0] as string, cmd.args[1] as string)]);
            else replies.push([null, applyExpire(cmd.args[0] as string, cmd.args[1] as number)]);
          }
          return replies;
        },
      };
      return pipe;
    }),
  };

  return { client, strings, lists, expCalls, delCalls, getCalls, rpushCalls, pipelineExecs };
}

async function readStreamBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

describe('P0-01: TUS local storage Redis staging suppression and 8 MiB pipelined cap', () => {
  let suiteStorageDir: string;
  let prevStorageDir: string | undefined;
  const tempDirs: string[] = [];
  const storedKeys: string[] = [];

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  beforeAll(() => {
    prevStorageDir = process.env.EASYCONVERT_STORAGE_DIR;
    suiteStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-suite-'));
    process.env.EASYCONVERT_STORAGE_DIR = suiteStorageDir;
  });

  afterAll(() => {
    if (prevStorageDir === undefined) delete process.env.EASYCONVERT_STORAGE_DIR;
    else process.env.EASYCONVERT_STORAGE_DIR = prevStorageDir;
    fs.rmSync(suiteStorageDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setTusSessionStore(null);
    while (storedKeys.length > 0) {
      const key = storedKeys.pop()!;
      await localFsStorage.delete(key).catch(() => false);
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('exports MAX_REDIS_STAGED_UPLOAD_BYTES equal to TUS_REMOTE_PART_BYTES (8 MiB)', () => {
    expect(MAX_REDIS_STAGED_UPLOAD_BYTES).toBe(TUS_REMOTE_PART_BYTES);
    expect(MAX_REDIS_STAGED_UPLOAD_BYTES).toBe(8 * 1024 * 1024);
  });

  it('skips syncStagedBytes and hydrateStagedFile on default local TusEngine across 6 MiB and 12 MiB multi-chunk uploads', async () => {
    expect(storageProvider.kind).toBe('local');

    const fakeRedis = createFakeRedis();
    const store = new RedisTusSessionStore(fakeRedis.client as never);
    const syncSpy = vi.spyOn(store, 'syncStagedBytes');
    const hydrateSpy = vi.spyOn(store, 'hydrateStagedFile');
    setTusSessionStore(store);

    const engineA = new TusEngine();
    const engineB = new TusEngine();

    for (const totalBytes of [6 * 1024 * 1024, 12 * 1024 * 1024]) {
      const payload = crypto.randomBytes(totalBytes);
      const c1 = payload.subarray(0, Math.floor(totalBytes / 3));
      const c2 = payload.subarray(c1.length, Math.floor((totalBytes * 2) / 3));
      const c3 = payload.subarray(c1.length + c2.length);

      const session = await engineA.createSession({
        uploadLength: totalBytes,
        metadataHeader: serializeTusMetadata({ filename: `local-${totalBytes}.bin`, filetype: 'application/octet-stream' }),
      });
      storedKeys.push(session.key);

      // Chunk 1 on replica A: zero Redis byte staging
      const res1 = await engineA.appendChunk(session.id, 0, Readable.from([c1]));
      expect(res1.isComplete).toBe(false);
      expect(res1.newOffset).toBe(c1.length);

      // Chunk 2 on replica B (empty localTailMarkers, shared disk): zero hydration & zero Redis staging
      const res2 = await engineB.appendChunk(session.id, c1.length, Readable.from([c2]));
      expect(res2.isComplete).toBe(false);
      expect(res2.newOffset).toBe(c1.length + c2.length);

      // Clear replica B marker to simulate restart before final chunk
      (engineB as unknown as { localTailMarkers: Map<string, string> }).localTailMarkers.clear();

      // Chunk 3 completes and verifies exact stored bytes
      const res3 = await engineB.appendChunk(session.id, c1.length + c2.length, Readable.from([c3]));
      expect(res3.isComplete).toBe(true);
      expect(res3.newOffset).toBe(totalBytes);

      const stored = await localFsStorage.getStream(session.key);
      expect(stored).not.toBeNull();
      const roundTrip = await readStreamBuffer(stored!.stream);
      expect(roundTrip.equals(payload)).toBe(true);
    }

    expect(syncSpy).toHaveBeenCalledTimes(0);
    expect(hydrateSpy).toHaveBeenCalledTimes(0);
    expect(fakeRedis.rpushCalls).toHaveLength(0);
    expect(fakeRedis.pipelineExecs).toHaveLength(0);
    expect(fakeRedis.lists.size).toBe(0);
  });

  it('batches slice writes in one pipeline and immediately deletes stage keys when crossing MAX_REDIS_STAGED_UPLOAD_BYTES', async () => {
    const tmpDir = makeTempDir('ec-tus-pipe-');
    const id = 'tus_1700000000000_0123456789abcdef';
    const binPath = path.join(tmpDir, `${id}.bin`);
    const fakeRedis = createFakeRedis();
    const store = new RedisTusSessionStore(fakeRedis.client as never);

    const firstSize = 3.5 * 1024 * 1024;
    const crossedSize = 8.5 * 1024 * 1024;
    const fullBytes = crypto.randomBytes(crossedSize);
    fs.writeFileSync(binPath, fullBytes.subarray(0, firstSize));

    await store.syncStagedBytes(id, binPath, 0, firstSize, 3600);

    // 4 slices (1M, 1M, 1M, 0.5M) batched in a single pipeline exec, with initial del when previousOffset === 0
    expect(fakeRedis.pipelineExecs).toHaveLength(1);
    expect(fakeRedis.client.rpush).not.toHaveBeenCalled();
    expect(fakeRedis.pipelineExecs[0].map((c) => c.op)).toEqual(['del', 'rpush', 'set', 'expire']);
    expect(fakeRedis.pipelineExecs[0][1].args).toHaveLength(5); // chunksKey + 4 slices

    const chunksKey = `tus:stage:{${id}}:chunks`;
    const lenKey = `tus:stage:{${id}}:len`;
    expect(fakeRedis.lists.get(chunksKey)).toHaveLength(4);
    expect(fakeRedis.strings.get(lenKey)).toBe(String(firstSize));

    // When previousOffset !== currentLen, pipeline resets keys via del in the same batch
    await store.syncStagedBytes(id, binPath, 1024, firstSize, 3600);
    expect(fakeRedis.pipelineExecs).toHaveLength(2);
    expect(fakeRedis.pipelineExecs[1].map((c) => c.op)).toEqual(['del', 'rpush', 'set', 'expire']);
    expect(fakeRedis.lists.get(chunksKey)).toHaveLength(4);

    // Next chunk crosses 8 MiB -> immediately deletes staged chunks + len keys without writing slices
    fs.writeFileSync(binPath, fullBytes);
    await store.syncStagedBytes(id, binPath, firstSize, crossedSize, 3600);

    expect(fakeRedis.lists.has(chunksKey)).toBe(false);
    expect(fakeRedis.strings.has(lenKey)).toBe(false);
    expect(fakeRedis.delCalls.at(-1)).toEqual([chunksKey, lenKey]);
    expect(fakeRedis.pipelineExecs).toHaveLength(2);
  });

  it('uses sequential del/rpush/set/expire fallback when Redis is a Cluster client and clears partial RPUSH residue on offset 0 retry', async () => {
    const tmpDir = makeTempDir('ec-tus-cluster-');
    const id = 'tus_1700000000001_fedcba9876543210';
    const binPath = path.join(tmpDir, `${id}.bin`);
    const fakeRedis = createFakeRedis({ isCluster: true });
    const store = new RedisTusSessionStore(fakeRedis.client as never);

    const chunksKey = `tus:stage:{${id}}:chunks`;
    const lenKey = `tus:stage:{${id}}:len`;
    // Simulate a failed prior attempt at offset 0 that pushed partial slices before SET len ran
    fakeRedis.lists.set(chunksKey, ['stale-slice-1', 'stale-slice-2']);

    const payloadSize = 2.5 * 1024 * 1024;
    fs.writeFileSync(binPath, crypto.randomBytes(payloadSize));

    await store.syncStagedBytes(id, binPath, 0, payloadSize, 1800);

    expect(fakeRedis.client.pipeline).not.toHaveBeenCalled();
    expect(fakeRedis.delCalls[0]).toEqual([chunksKey, lenKey]);
    expect(fakeRedis.client.rpush).toHaveBeenCalledTimes(3);
    expect(fakeRedis.lists.get(chunksKey)).toHaveLength(3);
    expect(fakeRedis.lists.get(chunksKey)).not.toContain('stale-slice-1');
    expect(fakeRedis.strings.get(lenKey)).toBe(String(payloadSize));
  });

  it('still stages and hydrates <= 8 MiB partial uploads for explicit tusDir or stageLocalInRedis', async () => {
    // Case 1: explicit { tusDir } across unshared replica directories
    const dirA = makeTempDir('ec-tus-unshared-a-');
    const dirB = makeTempDir('ec-tus-unshared-b-');
    const fakeRedisA = createFakeRedis();
    setTusSessionStore(new RedisTusSessionStore(fakeRedisA.client as never));

    const payloadA = crypto.randomBytes(5 * 1024 * 1024);
    const replicaA = new TusEngine({ tusDir: dirA });
    const replicaB = new TusEngine({ tusDir: dirB });
    const sessA = await replicaA.createSession({
      uploadLength: payloadA.length,
      metadataHeader: serializeTusMetadata({ filename: 'unshared-tusdir.bin', filetype: 'application/octet-stream' }),
    });
    storedKeys.push(sessA.key);

    await replicaA.appendChunk(sessA.id, 0, Readable.from([payloadA.subarray(0, 3 * 1024 * 1024)]));
    expect(fakeRedisA.strings.get(`tus:stage:{${sessA.id}}:len`)).toBe(String(3 * 1024 * 1024));

    const doneA = await replicaB.appendChunk(sessA.id, 3 * 1024 * 1024, Readable.from([payloadA.subarray(3 * 1024 * 1024)]));
    expect(doneA.isComplete).toBe(true);
    const storedA = await localFsStorage.getStream(sessA.key);
    expect((await readStreamBuffer(storedA!.stream)).equals(payloadA)).toBe(true);

    // Case 2: explicit { stageLocalInRedis: true }
    const fakeRedisB = createFakeRedis();
    setTusSessionStore(new RedisTusSessionStore(fakeRedisB.client as never));
    const optInA = new TusEngine({ stageLocalInRedis: true });
    const optInB = new TusEngine({ stageLocalInRedis: true });
    const payloadB = crypto.randomBytes(3 * 1024 * 1024);
    const sessB = await optInA.createSession({
      uploadLength: payloadB.length,
      metadataHeader: serializeTusMetadata({ filename: 'opt-in.bin', filetype: 'application/octet-stream' }),
    });
    storedKeys.push(sessB.key);

    await optInA.appendChunk(sessB.id, 0, Readable.from([payloadB.subarray(0, 2 * 1024 * 1024)]));
    expect(fakeRedisB.strings.get(`tus:stage:{${sessB.id}}:len`)).toBe(String(2 * 1024 * 1024));

    // Delete local .bin to prove optInB hydrates from Redis
    fs.rmSync(path.join(suiteStorageDir, 'tus', `${sessB.id}.bin`), { force: true });
    const doneB = await optInB.appendChunk(sessB.id, 2 * 1024 * 1024, Readable.from([payloadB.subarray(2 * 1024 * 1024)]));
    expect(doneB.isComplete).toBe(true);
    const storedB = await localFsStorage.getStream(sessB.key);
    expect((await readStreamBuffer(storedB!.stream)).equals(payloadB)).toBe(true);
  });

  it('hydrateStagedFile throws StorageServiceError for missing > 8 MiB binPath without Redis reads and prioritizes Redis for <= 8 MiB tails', async () => {
    const tmpDir = makeTempDir('ec-tus-hydrate-');
    const id = 'tus_1700000000002_abcdef0123456789';
    const binPath = path.join(tmpDir, `${id}.bin`);
    const fakeRedis = createFakeRedis();
    const store = new RedisTusSessionStore(fakeRedis.client as never);

    // Missing binPath > 8 MiB throws StorageServiceError without touching Redis
    await expect(store.hydrateStagedFile(id, binPath, MAX_REDIS_STAGED_UPLOAD_BYTES + 1)).rejects.toBeInstanceOf(
      StorageServiceError
    );
    expect(fakeRedis.getCalls).toHaveLength(0);
    expect(fakeRedis.client.lrange).not.toHaveBeenCalled();

    // Existing binPath > 8 MiB with matching size returns local size directly without touching Redis
    const matchingBigSize = MAX_REDIS_STAGED_UPLOAD_BYTES + 4096;
    const handle = await fs.promises.open(binPath, 'w');
    await handle.truncate(matchingBigSize);
    await handle.close();
    expect(await store.hydrateStagedFile(id, binPath, matchingBigSize)).toBe(matchingBigSize);
    expect(fakeRedis.getCalls).toHaveLength(0);

    // For <= 8 MiB remote tails, Redis staged bytes take precedence over stale local file of identical length
    const tailLen = 2 * 1024 * 1024;
    const authoritativeTail = crypto.randomBytes(tailLen);
    fs.writeFileSync(binPath, Buffer.alloc(tailLen, 0x00));
    fakeRedis.strings.set(`tus:stage:{${id}}:len`, String(tailLen));
    fakeRedis.lists.set(`tus:stage:{${id}}:chunks`, [
      authoritativeTail.subarray(0, 1024 * 1024).toString('base64'),
      authoritativeTail.subarray(1024 * 1024).toString('base64'),
    ]);

    expect(await store.hydrateStagedFile(id, binPath, tailLen)).toBe(tailLen);
    expect(fakeRedis.getCalls).toHaveLength(1);
    expect(fs.readFileSync(binPath).equals(authoritativeTail)).toBe(true);
  });

  it('trims crash-leftover tail bytes and fails closed on missing or short shared local .bin without mutating session.uploadOffset', async () => {
    const fakeRedis = createFakeRedis();
    const store = new RedisTusSessionStore(fakeRedis.client as never);
    const hydrateSpy = vi.spyOn(store, 'hydrateStagedFile');
    setTusSessionStore(store);

    const engine = new TusEngine();

    // Case 1: uncommitted trailing bytes (> expectedLocalTailOffset) are trimmed on both <= 8 MiB and > 8 MiB shared uploads
    for (const [firstLen, secondLen] of [
      [1 * 1024 * 1024, 1 * 1024 * 1024],
      [9 * 1024 * 1024, 1 * 1024 * 1024],
    ]) {
      const c1 = crypto.randomBytes(firstLen);
      const c2 = crypto.randomBytes(secondLen);
      const sess = await engine.createSession({
        uploadLength: firstLen + secondLen,
        metadataHeader: serializeTusMetadata({ filename: `trim-${firstLen}.bin`, filetype: 'application/octet-stream' }),
      });
      storedKeys.push(sess.key);

      await engine.appendChunk(sess.id, 0, Readable.from([c1]));
      const binPath = path.join(suiteStorageDir, 'tus', `${sess.id}.bin`);
      fs.appendFileSync(binPath, Buffer.alloc(64 * 1024, 0xff));

      const done = await engine.appendChunk(sess.id, firstLen, Readable.from([c2]));
      expect(done.isComplete).toBe(true);
      const stored = await localFsStorage.getStream(sess.key);
      expect((await readStreamBuffer(stored!.stream)).equals(Buffer.concat([c1, c2]))).toBe(true);
    }

    // Case 2: non-ENOENT stat failure throws retryable StorageServiceError without mutating uploadOffset,
    // while truncated or missing (ENOENT) .bin rewinds uploadOffset to actual bytes and throws TusStagedSizeMismatchError (400)
    const fullBytes = crypto.randomBytes(4 * 1024 * 1024);
    const chunk1 = fullBytes.subarray(0, 2 * 1024 * 1024);
    const chunk2 = fullBytes.subarray(2 * 1024 * 1024);
    const shortSess = await engine.createSession({
      uploadLength: fullBytes.length,
      metadataHeader: serializeTusMetadata({ filename: 'short-local.bin', filetype: 'application/octet-stream' }),
    });
    storedKeys.push(shortSess.key);
    await engine.appendChunk(shortSess.id, 0, Readable.from([chunk1]));

    const shortBinPath = path.join(suiteStorageDir, 'tus', `${shortSess.id}.bin`);
    const origStat = fs.promises.stat.bind(fs.promises);
    const ioSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (targetPath, ...args) => {
      if (String(targetPath) === shortBinPath) {
        throw Object.assign(new Error('EIO: temporary disk failure'), { code: 'EIO' });
      }
      return origStat(targetPath, ...args);
    });
    const ioErr = await engine
      .appendChunk(shortSess.id, chunk1.length, Readable.from([chunk2]))
      .catch((err: unknown) => err);
    ioSpy.mockRestore();
    expect(ioErr).toBeInstanceOf(StorageServiceError);
    expect((ioErr as StorageServiceError).retryable).toBe(true);
    expect((await store.getSession(shortSess.id))?.uploadOffset).toBe(chunk1.length);

    fs.truncateSync(shortBinPath, 1024 * 1024);
    const shortErr = await engine
      .appendChunk(shortSess.id, chunk1.length, Readable.from([chunk2]))
      .catch((err: unknown) => err);
    expect(shortErr).toBeInstanceOf(TusStagedSizeMismatchError);
    expect((shortErr as TusStagedSizeMismatchError).stagedBytes).toBe(1024 * 1024);
    expect((await store.getSession(shortSess.id))?.uploadOffset).toBe(1024 * 1024);

    fs.rmSync(shortBinPath, { force: true });
    const missingErr = await engine
      .appendChunk(shortSess.id, 1024 * 1024, Readable.from([chunk2]))
      .catch((err: unknown) => err);
    expect(missingErr).toBeInstanceOf(TusStagedSizeMismatchError);
    expect((missingErr as TusStagedSizeMismatchError).stagedBytes).toBe(0);
    expect((await store.getSession(shortSess.id))?.uploadOffset).toBe(0);
    expect(hydrateSpy).toHaveBeenCalledTimes(0);

    // Client can immediately resume cleanly from the rewound offset 0
    const recovered = await engine.appendChunk(shortSess.id, 0, Readable.from([fullBytes]));
    expect(recovered.isComplete).toBe(true);
    const storedRecovered = await localFsStorage.getStream(shortSess.key);
    expect((await readStreamBuffer(storedRecovered!.stream)).equals(fullBytes)).toBe(true);
  });

  it('preserves <= 8 MiB Redis staged keys and rolls back local .bin when saveSession fails past 8 MiB, then deletes keys once retry succeeds', async () => {
    const dirA = makeTempDir('ec-tus-failover-a-');
    const dirB = makeTempDir('ec-tus-failover-b-');
    const fakeRedis = createFakeRedis();
    const store = new RedisTusSessionStore(fakeRedis.client as never);
    setTusSessionStore(store);

    const replicaA = new TusEngine({ tusDir: dirA });
    const replicaB = new TusEngine({ tusDir: dirB });

    const payload = crypto.randomBytes(12 * 1024 * 1024);
    const c1 = payload.subarray(0, 6 * 1024 * 1024); // <= 8 MiB -> staged in Redis
    const c2 = payload.subarray(6 * 1024 * 1024, 9 * 1024 * 1024); // crosses 8 MiB
    const c3 = payload.subarray(9 * 1024 * 1024);

    const sess = await replicaA.createSession({
      uploadLength: payload.length,
      metadataHeader: serializeTusMetadata({ filename: 'retry-cross-8mib.bin', filetype: 'application/octet-stream' }),
    });
    storedKeys.push(sess.key);

    await replicaA.appendChunk(sess.id, 0, Readable.from([c1]));
    const chunksKey = `tus:stage:{${sess.id}}:chunks`;
    const lenKey = `tus:stage:{${sess.id}}:len`;
    expect(fakeRedis.strings.get(lenKey)).toBe(String(c1.length));
    expect(fakeRedis.lists.get(chunksKey)).toHaveLength(6);

    // Simulate Redis saveSession failure on chunk 2 crossing 8 MiB
    vi.spyOn(store, 'saveSession').mockRejectedValueOnce(new Error('transient saveSession error'));
    await expect(replicaA.appendChunk(sess.id, c1.length, Readable.from([c2]))).rejects.toThrow(
      'transient saveSession error'
    );

    // Prior <= 8 MiB staged bytes and session.uploadOffset stay intact in Redis, and replicaA .bin rolled back to c1.length
    expect(fakeRedis.strings.get(lenKey)).toBe(String(c1.length));
    expect(fakeRedis.lists.get(chunksKey)).toHaveLength(6);
    expect((await store.getSession(sess.id))?.uploadOffset).toBe(c1.length);
    expect(fs.statSync(path.join(dirA, `${sess.id}.bin`)).size).toBe(c1.length);

    // Retry chunk 2 on replicaB (empty dirB hydrates preserved 6 MiB from Redis) -> saveSession succeeds and deletes stage keys
    const r2 = await replicaB.appendChunk(sess.id, c1.length, Readable.from([c2]));
    expect(r2.isComplete).toBe(false);
    expect(r2.newOffset).toBe(c1.length + c2.length);
    expect(fakeRedis.strings.has(lenKey)).toBe(false);
    expect(fakeRedis.lists.has(chunksKey)).toBe(false);

    // Complete chunk 3 on replicaB
    const r3 = await replicaB.appendChunk(sess.id, c1.length + c2.length, Readable.from([c3]));
    expect(r3.isComplete).toBe(true);
    const stored = await localFsStorage.getStream(sess.key);
    expect((await readStreamBuffer(stored!.stream)).equals(payload)).toBe(true);
  });
});
