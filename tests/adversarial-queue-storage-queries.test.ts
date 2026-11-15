import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STITCH_BUFFER_SIZE, MultiVolumeBufferOverflowError } from '../src/lib/conversions/archive-split';
import { createZipArchive } from '../src/lib/conversions';
import { DistributedBullMQAdapter, Job } from '../src/lib/queue/bullmq-engine';
import { addDeadLetter, purgeDeadLetters } from '../src/lib/queue/dead-letters';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { RedisGraphScheduler } from '../src/lib/queue/graph/redis-scheduler';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { hasXmlOpenTag, readXmlElement } from '../src/lib/storage/adapters/s3';
import {
  FileRetentionLedger,
  getRetentionLedger,
  RedisRetentionLedger,
  setRetentionLedger,
} from '../src/lib/storage/retention-ledger';
import type { RetentionRecord } from '../src/lib/storage/result-retention';
import { extractXmlBlocks, parseListMultipartUploads, parseListObjectsPage } from '../src/lib/storage/s3-list-xml';
import {
  RedisTusSessionStore,
  TusEngine,
  TusOffsetMismatchError,
  serializeTusMetadata,
  setTusSessionStore,
} from '../src/lib/storage/tus-engine';
import { storageProvider } from '../src/lib/storage/selected-storage';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

const REDIS_URL = process.env.REDIS_URL;

describe('F-26a: S3 XML parser namespace-prefix & attribute tolerance', () => {
  it('parses namespace-prefixed and attribute-bearing ListObjectsV2, ListMultipartUploads, ListParts, and CompleteMultipartUpload XML', () => {
    const listObjectsXml = `<?xml version="1.0" encoding="UTF-8"?>
      <s3:ListBucketResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/" encoding-type="url">
        <s3:IsTruncated flag="true">true</s3:IsTruncated>
        <s3:NextContinuationToken version="2">tok_next_42</s3:NextContinuationToken>
        <s3:Contents storage="standard">
          <s3:Key encoding="plain">results/doc &amp; 1.pdf</s3:Key>
          <s3:Size unit="bytes">4096</s3:Size>
          <s3:LastModified tz="UTC">2026-11-15T00:00:00.000Z</s3:LastModified>
          <s3:ETag quoted="true">&quot;etag123&quot;</s3:ETag>
        </s3:Contents>
      </s3:ListBucketResult>`;

    const malformed = (msg: string) => new Error(msg);
    const identityDecode = (raw: string) => raw;

    const page = parseListObjectsPage(listObjectsXml, identityDecode, malformed);
    expect(page.isTruncated).toBe(true);
    expect(page.nextContinuationToken).toBe('tok_next_42');
    expect(page.objects).toEqual([
      {
        key: 'results/doc & 1.pdf',
        size: 4096,
        lastModified: new Date('2026-11-15T00:00:00.000Z'),
        etag: 'etag123',
      },
    ]);
    expect(readXmlElement('<s3:Empty attr="1"/>', 'Empty')).toBe('');

    const multipartXml = `<?xml version="1.0" encoding="UTF-8"?>
      <ns0:ListMultipartUploadsResult xmlns:ns0="http://s3.amazonaws.com/doc/2006-03-01/">
        <ns0:IsTruncated>false</ns0:IsTruncated>
        <ns0:Upload tier="hot">
          <ns0:Key>uploads/part.bin</ns0:Key>
          <ns0:UploadId>up_abc_1</ns0:UploadId>
          <ns0:Initiated>2026-11-15T01:02:03.000Z</ns0:Initiated>
        </ns0:Upload>
      </ns0:ListMultipartUploadsResult>`;

    const mp = parseListMultipartUploads(multipartXml, identityDecode, malformed);
    expect(mp.isTruncated).toBe(false);
    expect(mp.uploads).toEqual([
      {
        key: 'uploads/part.bin',
        uploadId: 'up_abc_1',
      },
    ]);

    const partsXml = `<s3:ListPartsResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">
      <s3:Part index="1"><s3:PartNumber>1</s3:PartNumber><s3:ETag>&quot;p1&quot;</s3:ETag><s3:Size>5242880</s3:Size></s3:Part>
      <s3:Part index="2"><s3:PartNumber>2</s3:PartNumber><s3:ETag>&quot;p2&quot;</s3:ETag><s3:Size>1024</s3:Size></s3:Part>
    </s3:ListPartsResult>`;
    const partBlocks = extractXmlBlocks(partsXml, 'Part', 'ListParts', malformed);
    expect(partBlocks).toHaveLength(2);
    expect(readXmlElement(partBlocks[0], 'PartNumber')).toBe('1');
    expect(readXmlElement(partBlocks[1], 'ETag')).toBe('"p2"');

    const completeXml = `<s3:CompleteMultipartUploadResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/">
      <s3:ETag>&quot;final-etag&quot;</s3:ETag>
    </s3:CompleteMultipartUploadResult>`;
    expect(hasXmlOpenTag(completeXml, 'CompleteMultipartUploadResult')).toBe(true);
    expect(readXmlElement(completeXml, 'ETag')).toBe('"final-etag"');

    // DTD / entity declarations remain rejected fail-closed
    expect(() =>
      parseListObjectsPage(
        '<!DOCTYPE foo [<!ENTITY xxe "bad">]><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
        identityDecode,
        malformed
      )
    ).toThrow(/DTD/i);
  });
});

describe('F-26b: multi-volume archive.extract bounded concurrency and stitch byte cap', () => {
  afterEach(async () => {
    await graphScheduler.deleteGraph('g_mv_ok').catch(() => false);
    await graphScheduler.deleteGraph('g_mv_over').catch(() => false);
  });

  it('bounds concurrent storage reads to <= 4 and fails closed with MultiVolumeBufferOverflowError past MAX_STITCH_BUFFER_SIZE', async () => {
    const zipResult = await createZipArchive([
      { filename: 'hello.txt', buffer: Buffer.from('multi-volume-payload-ok', 'utf8') },
    ]);
    const zipBuf = zipResult.buffer;
    const partSize = Math.ceil(zipBuf.length / 6);
    const splitParts: Array<{ name: string; data: Buffer }> = [];
    for (let i = 0; i < 6; i++) {
      const slice = zipBuf.subarray(i * partSize, Math.min(zipBuf.length, (i + 1) * partSize));
      if (slice.length > 0) {
        splitParts.push({ name: `bundle.zip.${String(i + 1).padStart(3, '0')}`, data: slice });
      }
    }
    expect(splitParts.length).toBeGreaterThanOrEqual(5);

    const objects = new Map<string, { buf: Buffer; filename: string }>();
    const inputKeys: string[] = [];
    for (const part of splitParts) {
      const key = `inputs/${part.name}`;
      objects.set(key, { buf: part.data, filename: part.name });
      inputKeys.push(key);
    }

    let inFlight = 0;
    let peakInFlight = 0;

    const fakeStorage = {
      kind: 'local',
      getObject: async (key: string) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        const entry = objects.get(key);
        if (!entry) return null;
        return {
          key,
          buffer: entry.buf,
          filename: entry.filename,
          mimeType: 'application/octet-stream',
          size: entry.buf.length,
        };
      },
      stat: async (key: string) => {
        const entry = objects.get(key);
        if (!entry) return null;
        return {
          key,
          filename: entry.filename,
          mimeType: 'text/plain',
          size: entry.buf.length,
        };
      },
      saveObject: async (key: string, buf: Buffer, _mimeType: string, filename: string) => {
        objects.set(key, { buf, filename });
        return { key, size: buf.length };
      },
      exists: async (key: string) => objects.has(key),
      deleteObject: async (key: string) => objects.delete(key),
    } as unknown as IStorageBackend;

    const graphDef = sealGraph('g_mv_ok', {
      nodes: {
        imp: { op: 'import.upload', storageKey: inputKeys[0] },
        ext: { op: 'archive.extract', input: 'imp' },
      },
    });
    await graphScheduler.initGraph('g_mv_ok', graphDef);
    await graphScheduler.onNodeCompleted('g_mv_ok', 'imp', inputKeys, 0);

    const emitter = new (await import('node:events')).EventEmitter();
    const jobOk = new Job<ConversionJobData, ConversionJobResult>(
      'g_mv_ok:ext',
      'graph-node',
      {
        sourceFormat: 'zip',
        targetFormat: 'bin',
        originalFilename: splitParts[0].name,
        fileSize: zipBuf.length,
        graphId: 'g_mv_ok',
        graphNodeId: 'ext',
        graphNode: { op: 'archive.extract', input: 'imp' },
        inputArtifacts: inputKeys,
      },
      {},
      emitter
    );

    const res = await processGraphNodeJob(jobOk, undefined, fakeStorage);
    expect(res.status).toBe('completed');
    expect(peakInFlight).toBeLessThanOrEqual(4);
    const extracted = objects.get(res.resultKey);
    expect(extracted?.buf.toString('utf8')).toBe('multi-volume-payload-ok');

    // Now simulate cumulative volume bytes exceeding MAX_STITCH_BUFFER_SIZE -> must reject fail-closed with MultiVolumeBufferOverflowError!
    const hugeStorage = {
      ...fakeStorage,
      getObject: async (key: string) => ({
        key,
        buffer: { length: Math.floor(MAX_STITCH_BUFFER_SIZE / 2) + 1024 } as Buffer,
        filename: path.basename(key),
        mimeType: 'application/octet-stream',
        size: Math.floor(MAX_STITCH_BUFFER_SIZE / 2) + 1024,
      }),
    } as unknown as IStorageBackend;

    const graphOver = sealGraph('g_mv_over', {
      nodes: {
        imp: { op: 'import.upload', storageKey: inputKeys[0] },
        ext: { op: 'archive.extract', input: 'imp' },
      },
    });
    await graphScheduler.initGraph('g_mv_over', graphOver);
    await graphScheduler.onNodeCompleted('g_mv_over', 'imp', inputKeys.slice(0, 2), 0);

    const jobOver = new Job<ConversionJobData, ConversionJobResult>(
      'g_mv_over:ext',
      'graph-node',
      {
        sourceFormat: 'zip',
        targetFormat: 'bin',
        originalFilename: splitParts[0].name,
        fileSize: MAX_STITCH_BUFFER_SIZE + 2048,
        graphId: 'g_mv_over',
        graphNodeId: 'ext',
        graphNode: { op: 'archive.extract', input: 'imp' },
        inputArtifacts: inputKeys.slice(0, 2),
      },
      {},
      emitter
    );

    await expect(processGraphNodeJob(jobOver, undefined, hugeStorage)).rejects.toBeInstanceOf(MultiVolumeBufferOverflowError);
  });
});

describe('F-09: FileRetentionLedger inode/mtime stat cache & RedisRetentionLedger pipelined MGET', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-ledger-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reuses cached parsed JSON across repeated sweeps while invalidating immediately on cross-process atomic rename', async () => {
    const ledgerWriter = new FileRetentionLedger(tmpDir);
    const ledgerReader = new FileRetentionLedger(tmpDir);
    const rec: RetentionRecord = {
      key: 'results/a.pdf',
      kind: 'result',
      createdAt: 1_000,
      deleteAt: 9_000_000_000_000,
      size: 128,
      received: [],
    };
    await ledgerWriter.update('results/a.pdf', () => rec);

    const readSpy = vi.spyOn(fs.promises, 'readFile');
    // Cold sweep populates cache -> 1 readFile
    expect(await ledgerReader.liveRecords()).toHaveLength(1);
    expect(readSpy.mock.calls.length).toBe(1);

    // Second sweep hits (ino, mtimeMs, size) cache -> zero additional readFile syscalls
    expect(await ledgerReader.liveRecords()).toHaveLength(1);
    expect(readSpy.mock.calls.length).toBe(1);

    // Separate process (ledgerWriter) atomically replaces file via rename -> new inode -> ledgerReader invalidates cache
    await ledgerWriter.update('results/a.pdf', (cur) => (cur ? { ...cur, goneAt: 3_000 } : undefined));
    const afterUpdateReads = readSpy.mock.calls.length;
    expect(await ledgerReader.liveRecords()).toHaveLength(0);
    expect(readSpy.mock.calls.length).toBe(afterUpdateReads + 1);
    expect((await ledgerReader.get('results/a.pdf'))?.goneAt).toBe(3_000);
  });

  it('pipelines multi-batch MGETs into a single round-trip in RedisRetentionLedger.getMany', async () => {
    let execCalls = 0;
    let mgetBatches = 0;
    const fakeRedis = {
      pipeline: () => {
        const cmds: string[][] = [];
        const pipe = {
          mget: (keys: string[]) => {
            mgetBatches += 1;
            cmds.push(keys);
            return pipe;
          },
          exec: async () => {
            execCalls += 1;
            return cmds.map((keys) => [
              null,
              keys.map((k) =>
                k.endsWith(':k_0')
                  ? JSON.stringify({
                      key: 'k_0',
                      kind: 'result',
                      createdAt: 1,
                      deleteAt: 999999,
                      size: 10,
                      received: [],
                    } satisfies RetentionRecord)
                  : null
              ),
            ]);
          },
        };
        return pipe;
      },
    } as unknown as Redis;

    const ledger = new RedisRetentionLedger(fakeRedis);
    const keys = Array.from({ length: 1_250 }, (_, i) => `k_${i}`);
    const records = await ledger.getMany(keys);

    expect(mgetBatches).toBe(13); // 12 * 100 + 50
    expect(execCalls).toBe(1);    // 1 single pipelined RTT!
    expect(records).toHaveLength(1_250);
    expect(records.filter(Boolean)).toHaveLength(1);
    expect(records[0]?.size).toBe(10);
  });
});

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('F-05, F-06, F-07, F-08: Real Redis distributed TUS, :by_time ZSET, :logs LIST & summaryOnly queries', () => {
  let admin: Redis;
  let prefix: string;
  let tmpDirs: string[] = [];
  const clients: Redis[] = [];
  const adapters: DistributedBullMQAdapter<any, any>[] = [];

  beforeEach(() => {
    prefix = `adv-q-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    tmpDirs = [];
  });

  afterEach(async () => {
    setTusSessionStore(null);
    setRetentionLedger(undefined);
    while (adapters.length > 0) await adapters.pop()!.close().catch(() => undefined);
    while (clients.length > 0) {
      const c = clients.pop()!;
      if (c.status !== 'end' && c.status !== 'close') {
        await c.quit().catch(() => c.disconnect());
      }
    }
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    const tusKeys = await admin.keys('tus:*');
    for (const k of tusKeys) {
      if (k.includes('tus_')) await admin.del(k);
    }
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await admin.quit();
  });

  function connectClient(): Redis {
    const c = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients.push(c);
    return c;
  }

  function makeTmpDir(label: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `ec-${label}-`));
    tmpDirs.push(d);
    return d;
  }

  it('F-05: coordinates cross-replica TUS chunk uploads and serializes concurrent PATCH contention via Redis lock', async () => {
    const store = new RedisTusSessionStore(connectClient());
    setTusSessionStore(store);
    setRetentionLedger(new RedisRetentionLedger(connectClient()));

    const replicaA = new TusEngine({ tusDir: makeTmpDir('tus-a') });
    const replicaB = new TusEngine({ tusDir: makeTmpDir('tus-b') });

    const payload = crypto.randomBytes(1500 * 1024); // 1.5 MiB across 2 chunks (exercises 1 MiB Redis stage chunking)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(payload, 0);
    const part1 = payload.subarray(0, 900 * 1024);
    const part2 = payload.subarray(900 * 1024);

    const session = await replicaA.createSession({
      uploadLength: payload.length,
      metadataHeader: serializeTusMetadata({ filename: 'sample.png', filetype: 'image/png' }),
    });

    try {
      // Two concurrent PATCHes at offset 0 across two replicas: exactly one wins, the other gets TusOffsetMismatchError (409)
      const outcomes = await Promise.allSettled([
        replicaA.appendChunk(session.id, 0, Readable.from([part1])),
        replicaB.appendChunk(session.id, 0, Readable.from([part1])),
      ]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(TusOffsetMismatchError);

      // Finalize on the OTHER replica (hydrates part1 from Redis into its empty local tusDir)
      const otherReplica =
        (fulfilled[0] as PromiseFulfilledResult<{ newOffset: number }>).value &&
        fs.existsSync(path.join((replicaA as unknown as { tusDir: string }).tusDir, `${session.id}.bin`))
          ? replicaB
          : replicaA;

      const done = await otherReplica.appendChunk(session.id, part1.length, Readable.from([part2]));
      expect(done.isComplete).toBe(true);
      expect(done.newOffset).toBe(payload.length);

      // Assembled object bytes match payload byte-for-byte
      const storedObj = await storageProvider.getObject(session.key);
      expect(storedObj?.buffer).toEqual(payload);

      // Staged Redis bytes and distributed lock must be completely removed after finalization
      expect(await admin.exists(`tus:stage:${session.id}`)).toBe(0);
      expect(await admin.exists(`tus:stage:len:${session.id}`)).toBe(0);
      expect(await admin.exists(`tus:lock:${session.id}`)).toBe(0);
    } finally {
      await getRetentionLedger().forget(session.key).catch(() => undefined);
      await Promise.resolve(storageProvider.deleteObject(session.key)).catch(() => false);
      await replicaA.terminateSession(session.id).catch(() => undefined);
    }
  });

  it('F-06 & F-07: maintains :by_time ZSET & :logs LIST with 0 SMEMBERS/SSCAN on retention and 0 orphan keys on delete', async () => {
    const client = connectClient();
    const adapter = new DistributedBullMQAdapter<{ userId: string; payload: string }, string>('q-opt', {
      redisClient: client,
      keyPrefix: prefix,
    });
    adapters.push(adapter);

    const names: string[] = [];
    const origSend = (Redis.prototype as unknown as { sendCommand: (...a: unknown[]) => unknown }).sendCommand;
    const spy = vi
      .spyOn(Redis.prototype as unknown as { sendCommand: (...a: unknown[]) => unknown }, 'sendCommand')
      .mockImplementation(function (this: unknown, cmd: unknown, ...rest: unknown[]) {
        if (this === client) {
          names.push((cmd as { name: string }).name);
        }
        return origSend.call(this, cmd, ...rest);
      });

    // Add 6 jobs, run them with logs + progress, keepNewestEnded(3)
    const completedIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const j = await adapter.add('convert', { userId: 'u_ret', payload: 'x'.repeat(4096) }, { removeOnComplete: 3 });
      const popped = await adapter._popNextWaiting();
      expect(popped?.id).toBe(j.id);
      await popped!.log(`step 1 of ${i}`);
      await popped!.updateProgress(50);
      await popped!.log(`step 2 of ${i}`);
      popped!.finishedOn = 10_000 + i * 1_000;
      expect(await adapter._onJobCompleted(popped!, `ok_${i}`)).toBe(true);
      completedIds.push(j.id);
    }

    // Zero SMEMBERS and zero SSCAN during keepNewestEnded!
    expect(names.filter((n) => n === 'smembers')).toEqual([]);
    expect(names.filter((n) => n === 'sscan')).toEqual([]);

    // Oldest 3 jobs (0, 1, 2) must be gone along with their :logs keys; newest 3 (3, 4, 5) remain with intact logs
    for (let i = 0; i < 3; i++) {
      expect(await adapter.getJob(completedIds[i])).toBeUndefined();
      expect(await admin.exists(`${prefix}{q-opt}:job:${completedIds[i]}:logs`)).toBe(0);
    }
    for (let i = 3; i < 6; i++) {
      const kept = await adapter.getJob(completedIds[i]);
      expect(kept?.logs).toHaveLength(2);
      expect(kept?.logs[0]).toContain(`step 1 of ${i}`);
      expect(kept?.logs[1]).toContain(`step 2 of ${i}`);
      // Hash 'logs' stayed '[]' (no O(L^2) hash rewrite)
      expect(await admin.hget(`${prefix}{q-opt}:job:${completedIds[i]}`, 'logs')).toBe('[]');
    }

    // Age-based clean via :by_time ZSET also uses 0 SMEMBERS and 0 SSCAN
    names.length = 0;
    const cleaned = await adapter.clean(Date.now() - 13_500, 10, 'completed');
    expect(cleaned).toEqual([completedIds[3]]);
    expect(names.filter((n) => n === 'smembers')).toEqual([]);
    expect(names.filter((n) => n === 'sscan')).toEqual([]);
    spy.mockRestore();

    // Batched DLQ purge across >1000 entries leaves zero keys
    const dlqKey = `${prefix}{q-opt}:dlq`;
    for (let i = 0; i < 1_150; i++) {
      await addDeadLetter(client, dlqKey, {
        jobId: `dlq_${i}`,
        name: 'convert',
        data: { userId: 'u_ret' },
        failedReason: 'err',
        attemptsMade: 1,
        timestamp: i + 1,
        stacktrace: [],
      });
    }
    expect(await purgeDeadLetters(client, dlqKey)).toBe(1_150);
    expect(await admin.keys(`${dlqKey}*`)).toEqual([]);

    // Removing remaining jobs leaves zero job/:logs/:by_time keys
    for (const id of [completedIds[4], completedIds[5]]) {
      expect(await adapter.remove(id)).toBe(true);
    }
    expect(await admin.keys(`${prefix}{q-opt}:job:*`)).toEqual([]);
    expect(await admin.exists(`${prefix}{q-opt}:completed:by_time`)).toBe(0);
  });

  it('F-08: summaryOnly job & graph listing skips inline payload/logs/webhookSecret while preserving API summary fields', async () => {
    const client = connectClient();
    const adapter = new DistributedBullMQAdapter<ConversionJobData, ConversionJobResult>('q-sum', {
      redisClient: client,
      keyPrefix: prefix,
    });
    adapters.push(adapter);

    const inline64k = Buffer.alloc(48 * 1024, 0x61).toString('base64');
    const added = await adapter.add('convert', {
      userId: 'u_list',
      sourceFormat: 'png',
      targetFormat: 'webp',
      originalFilename: 'hero.png',
      fileSize: 49152,
      inputBufferBase64: inline64k,
    });
    const popped = await adapter._popNextWaiting();
    for (let l = 0; l < 25; l++) await popped!.log(`verbose worker log line ${l}`);
    await adapter._onJobCompleted(popped!, {
      jobId: added.id,
      status: 'completed',
      resultKey: 'results/hero.webp',
      downloadUrl: '/api/v1/download/hero.webp',
      filename: 'hero.webp',
      mimeType: 'image/webp',
      size: 1234,
      durationMs: 42,
    });

    const summaryJobs = await adapter.getJobsByUser('u_list', ['completed'], 10, 0, {
      excludeGraphNodes: true,
      summaryOnly: true,
    });
    expect(summaryJobs).toHaveLength(1);
    expect(summaryJobs[0].id).toBe(added.id);
    expect(summaryJobs[0].state).toBe('completed');
    expect(summaryJobs[0].data.sourceFormat).toBe('png');
    expect(summaryJobs[0].data.targetFormat).toBe('webp');
    expect(summaryJobs[0].data.originalFilename).toBe('hero.png');
    expect(summaryJobs[0].data.fileSize).toBe(49152);
    // Inline 64 KiB payload and 25 log lines were NOT transferred or hydrated in summaryOnly mode!
    expect(summaryJobs[0].data.inputBufferBase64).toBeUndefined();
    expect(summaryJobs[0].logs).toEqual([]);

    // Graph summary listing uses windowed ZREVRANGE + HMGET (no HGETALL on graph hash unless namedTasks)
    const schedClient = connectClient();
    const scheduler = new RedisGraphScheduler({
      redisClient: schedClient,
      keyPrefix: prefix,
      enqueueNode: async () => undefined as never,
      cancelNode: async () => false,
    });
    const gDef = sealGraph('g_sum_1', {
      nodes: {
        imp: { op: 'import.upload', storageKey: 'inputs/doc.pdf' },
        conv: { op: 'convert', input: 'imp', targetFormat: 'png' },
      },
    });
    await scheduler.initGraph('g_sum_1', gDef, {
      ownerUserId: 'u_list',
      originalFilename: 'doc.pdf',
      sourceFormat: 'pdf',
      targetFormat: 'png',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'whsec_test_secret_123456',
    });

    const graphCmds: string[] = [];
    const origSend = (Redis.prototype as unknown as { sendCommand: (...a: unknown[]) => unknown }).sendCommand;
    const spy = vi
      .spyOn(Redis.prototype as unknown as { sendCommand: (...a: unknown[]) => unknown }, 'sendCommand')
      .mockImplementation(function (this: unknown, cmd: unknown, ...rest: unknown[]) {
        if (this === schedClient) {
          graphCmds.push(`${(cmd as { name: string }).name}:${String((cmd as { args: unknown[] }).args[0] ?? '')}`);
        }
        return origSend.call(this, cmd, ...rest);
      });

    const summaries = await scheduler.listGraphSummariesOfUser('u_list', 10, ['running']);
    spy.mockRestore();

    expect(summaries).toHaveLength(1);
    expect(summaries[0].graphId).toBe('g_sum_1');
    expect(summaries[0].originalFilename).toBe('doc.pdf');
    expect(summaries[0].sourceFormat).toBe('pdf');
    expect(summaries[0].targetFormat).toBe('png');
    expect(summaries[0].webhookSecret).toBeUndefined();
    expect(summaries[0].graph).toEqual({ nodes: {} });
    // HGETALL was called ONLY on :nodes, NEVER on the main graph hash!
    expect(graphCmds.filter((c) => c.startsWith('hgetall:') && !c.endsWith(':nodes'))).toEqual([]);
  });
});
