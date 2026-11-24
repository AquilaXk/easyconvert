import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionEnginePort, EngineResult, VfsPayload } from '../src/lib/queue/engine-port';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { tsEngine } from '../src/lib/queue/node-processor';
import type { OptimizerRegistry } from '../src/lib/conversions/optimizers';
import { PayloadTooLargeForMemoryError, StoredObjectMissingError } from '../src/lib/storage/errors';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';
import { resultAvailability, saveRetainedResultFromStored, type FileResultStorage } from '../src/lib/storage/retention-service';
import type { IStorageBackend, StoredObject } from '../src/lib/storage/types';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

const LARGE_LIMIT_BYTES = 1024;
const LARGE_PAYLOAD_BYTES = 16_384;
const SMALL_PDF_BYTES = 512;
const ARTIFACT_TTL_MS = 60 * 60 * 1000;

let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

function makeGraphJob(graphId: string, nodeId: string, graphNode: Record<string, unknown>, inputArtifacts: string[], signal?: AbortSignal) {
  return {
    id: `${graphId}:${nodeId}`,
    data: {
      jobId: `${graphId}:${nodeId}`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: nodeId,
      graphNode,
      inputArtifacts,
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: signal ?? new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

async function readAllStreamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('graph executor VFS streaming and stat-based charging', () => {
  let tempDir: string;
  let storage: S3ObjectStorageService;
  const createdKeys: string[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-graph-vfs-test-'));
    storage = new S3ObjectStorageService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const key of createdKeys.splice(0)) {
      storage.deleteObject(key);
    }
    storage.stopGc();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedFileObject(key: string, bytes: Buffer, mimeType: string, filename: string): Promise<StoredObject> {
    const srcPath = path.join(tempDir, `${nextId('seed')}-${filename}`);
    fs.writeFileSync(srcPath, bytes);
    createdKeys.push(key);
    return await storage.saveObjectFromFile(key, srcPath, mimeType, filename, ARTIFACT_TTL_MS);
  }

  describe('1. VfsPayload + saveObjectFromFile past MAX_IN_MEMORY_BYTES', () => {
    it('executes convert -> thumbnail -> export.internal past MAX_IN_MEMORY_BYTES without touching buffer, and fails closed on ts-engine', async () => {
      vi.stubEnv('MAX_IN_MEMORY_BYTES', String(LARGE_LIMIT_BYTES));

      const sourceBytes = crypto.randomBytes(LARGE_PAYLOAD_BYTES);
      const sourceKey = `uploads/${nextId('big')}/report.docx`;
      await seedFileObject(sourceKey, sourceBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx');

      // Verify the local storage backend itself refuses in-memory .buffer access past MAX_IN_MEMORY_BYTES.
      const seeded = storage.getObject(sourceKey);
      if (!seeded) throw new Error('Expected seeded object to exist');
      expect(() => seeded.buffer).toThrow(PayloadTooLargeForMemoryError);

      const seenInputs: Array<{ targetFormat: string; input: Buffer | VfsPayload }> = [];
      const engineTempFiles: string[] = [];
      let lastThumbnailBytes: Buffer = Buffer.alloc(0);

      const nativeVfsEngine: ConversionEnginePort = {
        name: 'native-vfs-engine',
        async convert(input, _sourceFormat, targetFormat, _options, originalFilename): Promise<EngineResult> {
          seenInputs.push({ targetFormat, input });
          if (Buffer.isBuffer(input) || !input.inputPath) {
            throw new Error('Expected VfsPayload with inputPath, never an in-memory Buffer');
          }
          const readBytes = fs.readFileSync(input.inputPath);
          expect(readBytes.length).toBe(LARGE_PAYLOAD_BYTES);

          const outBytes = crypto.randomBytes(LARGE_PAYLOAD_BYTES);
          if (targetFormat === 'webp') {
            lastThumbnailBytes = outBytes;
          }
          const outTempPath = path.join(tempDir, `${nextId('engine-out')}.${targetFormat}`);
          fs.writeFileSync(outTempPath, outBytes);
          engineTempFiles.push(outTempPath);

          const stem = path.basename(originalFilename, path.extname(originalFilename));
          const mimeType =
            targetFormat === 'pdf' ? 'application/pdf' : targetFormat === 'png' ? 'image/png' : 'image/webp';
          const result: EngineResult = {
            get buffer(): Buffer {
              throw new PayloadTooLargeForMemoryError(undefined, { size: outBytes.length, limit: LARGE_LIMIT_BYTES });
            },
            size: outBytes.length,
            mimeType,
            filename: `${stem}.${targetFormat}`,
            filePath: outTempPath,
            engine: 'test-native',
          };
          return result;
        },
      };

      const saveFromFileSpy = vi.spyOn(storage, 'saveObjectFromFile');
      const saveBufferSpy = vi.spyOn(storage, 'saveObject');
      vi.spyOn(graphScheduler, 'onNodeCompleted').mockResolvedValue({ graphCompleted: false } as never);

      const graphId = nextId('g_vfs');

      // Node 1: convert docx -> pdf
      const convertRes = await processGraphNodeJob(
        makeGraphJob(graphId, 'conv', { op: 'convert', targetFormat: 'pdf' }, [sourceKey]),
        nativeVfsEngine,
        storage
      );
      createdKeys.push(convertRes.resultKey);
      expect(convertRes.size).toBe(LARGE_PAYLOAD_BYTES);
      expect(convertRes.mimeType).toBe('application/pdf');

      // Node 2: thumbnail pdf -> webp (exercises 2-step prepare: pdf -> png temp file, then png -> webp)
      const thumbRes = await processGraphNodeJob(
        makeGraphJob(
          graphId,
          'thumb',
          { op: 'thumbnail', targetFormat: 'webp', options: { thumbnail: { width: 128, height: 128 } } },
          [convertRes.resultKey]
        ),
        nativeVfsEngine,
        storage
      );
      createdKeys.push(thumbRes.resultKey);
      expect(thumbRes.filename).toBe('thumbnail.webp');
      expect(thumbRes.size).toBe(LARGE_PAYLOAD_BYTES);

      // Node 3: export.internal promotes thumbnail intermediate to results/
      const exportRes = await processGraphNodeJob(
        makeGraphJob(graphId, 'export', { op: 'export.internal' }, [thumbRes.resultKey]),
        nativeVfsEngine,
        storage
      );
      createdKeys.push(exportRes.resultKey);
      expect(exportRes.resultKey).toMatch(new RegExp(`^results/${graphId}/export/0/thumbnail\\.webp$`));
      expect(exportRes.size).toBe(LARGE_PAYLOAD_BYTES);

      // All conversions received { inputPath }, saveObjectFromFile was used across convert + thumbnail + export, never saveObject.
      expect(seenInputs.map((s) => s.targetFormat)).toEqual(['pdf', 'png', 'webp']);
      for (const entry of seenInputs) {
        expect(Buffer.isBuffer(entry.input)).toBe(false);
        expect((entry.input as VfsPayload).inputPath).toEqual(expect.any(String));
      }
      expect(saveFromFileSpy).toHaveBeenCalledTimes(3);
      expect(saveBufferSpy).not.toHaveBeenCalled();

      // Retention ledger registered the promoted result and bytes match on disk.
      const availability = await resultAvailability(exportRes.resultKey);
      expect(availability?.state).toBe('available');
      expect(typeof availability?.deleteAt).toBe('number');

      const promotedStream = storage.getObjectStream(exportRes.resultKey);
      expect(promotedStream).not.toBeNull();
      const promotedBytes = await readAllStreamBytes(promotedStream!);
      expect(promotedBytes.equals(lastThumbnailBytes)).toBe(true);

      // Intermediate thumbnail backing file must remain intact after export.internal promotion.
      const thumbStored = storage.getObject(thumbRes.resultKey);
      expect(thumbStored?.filePath).toEqual(expect.any(String));
      expect(fs.existsSync(thumbStored!.filePath!)).toBe(true);

      // Every temporary output file produced by the engine was moved or cleaned up.
      expect(engineTempFiles).toHaveLength(3);
      for (const p of engineTempFiles) {
        expect(fs.existsSync(p)).toBe(false);
      }

      // In-process ts-engine must fail closed with PayloadTooLargeForMemoryError on the > 1024 byte input.
      await expect(
        processGraphNodeJob(
          makeGraphJob(nextId('g_ts_fail'), 'conv', { op: 'convert', targetFormat: 'pdf' }, [sourceKey]),
          tsEngine,
          storage
        )
      ).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
    });
  });

  describe('2. nodeCharge uses stat (never extra getObject) and runOptimizeNode enforces bounds and VFS', () => {
    it('bills convert nodes via storage.stat without calling getObject a second time', async () => {
      const dummyOut = Buffer.from('%PDF-1.4\n');
      const stubEngine: ConversionEnginePort = {
        name: 'stub-charge-engine',
        convert: async (_input, _src, targetFormat, _opts, originalFilename) => {
          const stem = path.basename(originalFilename, path.extname(originalFilename));
          const mimeType = targetFormat === 'pdf' ? 'application/pdf' : 'image/webp';
          return { buffer: dummyOut, size: dummyOut.length, mimeType, filename: `${stem}.${targetFormat}` };
        },
      };

      const docxKey = `uploads/${nextId('doc')}/contract.docx`;
      const pngKey = `uploads/${nextId('img')}/photo.png`;
      await seedFileObject(docxKey, Buffer.from('docx-content'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'contract.docx');
      await seedFileObject(pngKey, Buffer.from('png-content'), 'image/png', 'photo.png');

      // Wrap storage so stat() does not re-enter getObject() on the measured interface, mirroring RemoteStorageBackend.
      const statAwareStorage: IStorageBackend = {
        providerName: storage.providerName,
        kind: storage.kind,
        initiateMultipartUpload: storage.initiateMultipartUpload.bind(storage),
        uploadPart: storage.uploadPart.bind(storage),
        completeMultipartUpload: storage.completeMultipartUpload.bind(storage),
        abortMultipartUpload: storage.abortMultipartUpload.bind(storage),
        saveObject: storage.saveObject.bind(storage),
        saveObjectFromFile: storage.saveObjectFromFile.bind(storage),
        saveObjectFromStream: storage.saveObjectFromStream.bind(storage),
        getObject: vi.fn((k: string) => storage.getObject(k)),
        stat: vi.fn((k: string) => storage.stat(k)),
        openReadStream: storage.openReadStream.bind(storage),
        getObjectStream: storage.getObjectStream.bind(storage),
        deleteObject: storage.deleteObject.bind(storage),
        deleteObjectIfUnchanged: storage.deleteObjectIfUnchanged.bind(storage),
        getActiveSessionsCount: storage.getActiveSessionsCount.bind(storage),
        getObjectsCount: storage.getObjectsCount.bind(storage),
      };

      const completedSpy = vi.spyOn(graphScheduler, 'onNodeCompleted').mockResolvedValue({ graphCompleted: false } as never);

      const docRes = await processGraphNodeJob(
        makeGraphJob(nextId('g_charge_doc'), 'conv', { op: 'convert', targetFormat: 'pdf' }, [docxKey]),
        stubEngine,
        statAwareStorage
      );
      createdKeys.push(docRes.resultKey);
      expect(statAwareStorage.getObject).toHaveBeenCalledTimes(1);
      expect(statAwareStorage.getObject).toHaveBeenCalledWith(docxKey);
      expect(statAwareStorage.stat).toHaveBeenCalledWith(docxKey);
      expect(completedSpy).toHaveBeenLastCalledWith(expect.any(String), 'conv', [docRes.resultKey], 2);

      vi.mocked(statAwareStorage.getObject).mockClear();
      vi.mocked(statAwareStorage.stat).mockClear();

      const imgRes = await processGraphNodeJob(
        makeGraphJob(nextId('g_charge_img'), 'conv', { op: 'convert', targetFormat: 'webp' }, [pngKey]),
        stubEngine,
        statAwareStorage
      );
      createdKeys.push(imgRes.resultKey);
      expect(statAwareStorage.getObject).toHaveBeenCalledTimes(1);
      expect(statAwareStorage.getObject).toHaveBeenCalledWith(pngKey);
      expect(statAwareStorage.stat).toHaveBeenCalledWith(pngKey);
      expect(completedSpy).toHaveBeenLastCalledWith(expect.any(String), 'conv', [imgRes.resultKey], 1);
    });

    it('falls back to getObject in nodeCharge when storage.stat is absent', async () => {
      const dummyOut = Buffer.from('%PDF-1.4\n');
      const stubEngine: ConversionEnginePort = {
        name: 'stub-no-stat-engine',
        convert: async () => ({ buffer: dummyOut, size: dummyOut.length, mimeType: 'application/pdf', filename: 'out.pdf' }),
      };

      const docxKey = `uploads/${nextId('nostat')}/memo.docx`;
      await seedFileObject(docxKey, Buffer.from('memo-bytes'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'memo.docx');

      const getObjectMock = vi.fn((k: string) => storage.getObject(k));
      const noStatStorage = {
        providerName: storage.providerName,
        kind: storage.kind,
        saveObject: storage.saveObject.bind(storage),
        saveObjectFromFile: storage.saveObjectFromFile.bind(storage),
        saveObjectFromStream: storage.saveObjectFromStream.bind(storage),
        getObject: getObjectMock,
        openReadStream: storage.openReadStream.bind(storage),
        getObjectStream: storage.getObjectStream.bind(storage),
        deleteObject: storage.deleteObject.bind(storage),
        deleteObjectIfUnchanged: storage.deleteObjectIfUnchanged.bind(storage),
        getActiveSessionsCount: storage.getActiveSessionsCount.bind(storage),
        getObjectsCount: storage.getObjectsCount.bind(storage),
      } as unknown as IStorageBackend;

      const completedSpy = vi.spyOn(graphScheduler, 'onNodeCompleted').mockResolvedValue({ graphCompleted: false } as never);
      const res = await processGraphNodeJob(
        makeGraphJob(nextId('g_nostat'), 'conv', { op: 'convert', targetFormat: 'pdf' }, [docxKey]),
        stubEngine,
        noStatStorage
      );
      createdKeys.push(res.resultKey);
      // Once during conversion and once inside nodeCharge fallback when stat is absent.
      expect(getObjectMock.mock.calls.filter(([k]) => k === docxKey)).toHaveLength(2);
      expect(completedSpy).toHaveBeenCalledWith(expect.any(String), 'conv', [res.resultKey], 2);
    });

    it('fails closed with PayloadTooLargeForMemoryError in runOptimizeNode when input exceeds MAX_IN_MEMORY_BYTES and persists unchanged files via saveObjectFromFile', async () => {
      vi.stubEnv('MAX_IN_MEMORY_BYTES', String(LARGE_LIMIT_BYTES));

      const bigPdfKey = `uploads/${nextId('opt_big')}/huge.pdf`;
      await seedFileObject(bigPdfKey, Buffer.alloc(LARGE_PAYLOAD_BYTES, 0x25), 'application/pdf', 'huge.pdf');

      const optimizerSpy = vi.fn(async (buf: Buffer) => ({ buffer: buf, optimized: false }));
      const testOptimizers: OptimizerRegistry = new Map([['pdf', optimizerSpy]]);

      await expect(
        processGraphNodeJob(
          makeGraphJob(nextId('g_opt_big'), 'opt', { op: 'optimize' }, [bigPdfKey]),
          undefined,
          storage,
          testOptimizers
        )
      ).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
      expect(optimizerSpy).not.toHaveBeenCalled();

      // Verify runOptimizeNode itself rejects on stored.size before reading stored.buffer even on a non-throwing StoredObject.
      const bufferGetterSpy = vi.fn(() => Buffer.alloc(LARGE_PAYLOAD_BYTES, 0x25));
      const nonThrowingStorage = {
        providerName: 'mock-nonthrowing',
        kind: 'remote' as const,
        getObject: vi.fn(async () => ({
          key: bigPdfKey,
          filename: 'huge.pdf',
          mimeType: 'application/pdf',
          get buffer(): Buffer {
            return bufferGetterSpy();
          },
          size: LARGE_PAYLOAD_BYTES,
          etag: '"huge-etag"',
          uploadedAt: Date.now(),
          expiresAt: Date.now() + ARTIFACT_TTL_MS,
        })),
        saveObject: vi.fn(),
        deleteObject: vi.fn(async () => true),
      } as unknown as IStorageBackend;

      await expect(
        processGraphNodeJob(
          makeGraphJob(nextId('g_opt_precheck'), 'opt', { op: 'optimize' }, [bigPdfKey]),
          undefined,
          nonThrowingStorage,
          testOptimizers
        )
      ).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
      expect(bufferGetterSpy).not.toHaveBeenCalled();
      expect(optimizerSpy).not.toHaveBeenCalled();

      // Unchanged smaller file with filePath uses saveObjectFromFile and leaves input intact.
      const smallBytes = Buffer.alloc(SMALL_PDF_BYTES, 0x41);
      const smallPdfKey = `uploads/${nextId('opt_small')}/small.pdf`;
      const smallStored = await seedFileObject(smallPdfKey, smallBytes, 'application/pdf', 'small.pdf');

      const unchangedOptimizers: OptimizerRegistry = new Map([
        ['pdf', async () => ({ buffer: Buffer.alloc(SMALL_PDF_BYTES + 64, 0x42), optimized: false })],
      ]);

      const saveFromFileSpy = vi.spyOn(storage, 'saveObjectFromFile');
      const saveBufferSpy = vi.spyOn(storage, 'saveObject');
      vi.spyOn(graphScheduler, 'onNodeCompleted').mockResolvedValue({ graphCompleted: false } as never);

      const optRes = await processGraphNodeJob(
        makeGraphJob(nextId('g_opt_small'), 'opt', { op: 'optimize' }, [smallPdfKey]),
        undefined,
        storage,
        unchangedOptimizers
      );
      createdKeys.push(optRes.resultKey);

      expect(saveFromFileSpy).toHaveBeenCalledTimes(1);
      expect(saveBufferSpy).not.toHaveBeenCalled();
      expect(optRes.optimizations).toEqual([
        { key: optRes.resultKey, optimized: false, inputBytes: SMALL_PDF_BYTES, outputBytes: SMALL_PDF_BYTES + 64 },
      ]);
      expect(fs.existsSync(smallStored.filePath!)).toBe(true);
      const persisted = storage.getObject(optRes.resultKey);
      expect(persisted?.filePath).toEqual(expect.any(String));
      expect(fs.readFileSync(persisted!.filePath!).equals(smallBytes)).toBe(true);
    });
  });

  describe('3. saveRetainedResultFromStored branches', () => {
    it('uses saveObjectFromFile for filePath inputs and cleans up via deleteObjectIfUnchanged when aborted', async () => {
      const sourceFile = path.join(tempDir, 'source-artifact.bin');
      const payload = crypto.randomBytes(2048);
      fs.writeFileSync(sourceFile, payload);

      const controller = new AbortController();
      const targetKey = `results/${nextId('ret_file')}/artifact.bin`;
      const writtenRecord: StoredObject = {
        key: targetKey,
        filename: 'artifact.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(0),
        size: payload.length,
        etag: '"etag-abort-1"',
        uploadedAt: Date.now(),
        expiresAt: Date.now() + ARTIFACT_TTL_MS,
      };

      const saveObjectFromFile = vi.fn(async () => {
        controller.abort(new Error('aborted during promote'));
        return writtenRecord;
      });
      const deleteObjectIfUnchanged = vi.fn(async () => true);
      const mockStorage: FileResultStorage = {
        saveObject: vi.fn(),
        deleteObject: vi.fn(async () => true),
        saveObjectFromFile,
        deleteObjectIfUnchanged,
      };

      const stored: StoredObject = {
        key: 'intermediate/g1/n1/0/artifact.bin',
        filename: 'artifact.bin',
        mimeType: 'application/octet-stream',
        get buffer(): Buffer {
          throw new PayloadTooLargeForMemoryError();
        },
        size: payload.length,
        etag: '"src-etag"',
        uploadedAt: Date.now(),
        expiresAt: Date.now() + ARTIFACT_TTL_MS,
        filePath: sourceFile,
      };

      await expect(
        saveRetainedResultFromStored(mockStorage, stored.key, stored, targetKey, 'artifact.bin', controller.signal)
      ).rejects.toThrow('aborted during promote');

      expect(saveObjectFromFile).toHaveBeenCalledWith(
        targetKey,
        sourceFile,
        'application/octet-stream',
        'artifact.bin',
        expect.any(Number),
        controller.signal
      );
      expect(deleteObjectIfUnchanged).toHaveBeenCalledWith(targetKey, writtenRecord);
      expect(await resultAvailability(targetKey)).toBeUndefined();
    });

    it('streams remote objects exceeding MAX_IN_MEMORY_BYTES via getObjectStream -> saveObjectFromStream', async () => {
      vi.stubEnv('MAX_IN_MEMORY_BYTES', String(LARGE_LIMIT_BYTES));

      const sourceKey = `intermediate/${nextId('remote')}/streamed.bin`;
      const targetKey = `results/${nextId('ret_stream')}/streamed.bin`;
      const payload = crypto.randomBytes(4096);
      let savedMeta: { filename: string; mimeType: string; size?: number } | undefined;
      let savedBytes: Buffer = Buffer.alloc(0);

      const mockStorage: FileResultStorage = {
        saveObject: vi.fn(),
        deleteObject: vi.fn(async () => true),
        getObjectStream: vi.fn(async (key: string) => (key === sourceKey ? Readable.from([payload]) : null)),
        saveObjectFromStream: vi.fn(async (key, stream, meta, ttlMs) => {
          savedMeta = meta;
          savedBytes = await readAllStreamBytes(stream);
          return {
            key,
            filename: meta.filename,
            mimeType: meta.mimeType,
            buffer: Buffer.alloc(0),
            size: savedBytes.length,
            etag: '"stream-etag"',
            uploadedAt: Date.now(),
            expiresAt: Date.now() + (ttlMs ?? ARTIFACT_TTL_MS),
          };
        }),
      };

      const stored: StoredObject = {
        key: sourceKey,
        filename: 'streamed.bin',
        mimeType: 'application/octet-stream',
        get buffer(): Buffer {
          throw new PayloadTooLargeForMemoryError(undefined, { size: payload.length, limit: LARGE_LIMIT_BYTES });
        },
        size: payload.length,
        etag: '"remote-etag"',
        uploadedAt: Date.now(),
        expiresAt: Date.now() + ARTIFACT_TTL_MS,
      };

      await saveRetainedResultFromStored(mockStorage, sourceKey, stored, targetKey, 'streamed.bin');

      expect(mockStorage.getObjectStream).toHaveBeenCalledWith(sourceKey);
      expect(mockStorage.saveObjectFromStream).toHaveBeenCalledTimes(1);
      expect(savedMeta).toEqual({ filename: 'streamed.bin', mimeType: 'application/octet-stream', size: payload.length });
      expect(savedBytes.equals(payload)).toBe(true);
      expect(mockStorage.saveObject).not.toHaveBeenCalled();
      expect((await resultAvailability(targetKey))?.state).toBe('available');

      // Missing stream must fail closed with StoredObjectMissingError.
      await expect(
        saveRetainedResultFromStored(mockStorage, 'intermediate/missing.bin', stored, `results/${nextId('ret_missing')}/x.bin`, 'x.bin')
      ).rejects.toBeInstanceOf(StoredObjectMissingError);
    });

    it('falls back to saveRetainedResult for small in-memory buffers without filePath', async () => {
      const targetKey = `results/${nextId('ret_buf')}/note.txt`;
      const payload = Buffer.from('small retained text', 'utf-8');

      const mockStorage: FileResultStorage = {
        saveObject: vi.fn(async (key, buffer, mimeType, filename, ttlMs) => ({
          key,
          filename,
          mimeType,
          buffer,
          size: buffer.length,
          etag: '"mem-etag"',
          uploadedAt: Date.now(),
          expiresAt: Date.now() + (ttlMs ?? ARTIFACT_TTL_MS),
        })),
        deleteObject: vi.fn(async () => true),
      };

      const stored: StoredObject = {
        key: 'intermediate/g1/n1/0/note.txt',
        filename: 'note.txt',
        mimeType: 'text/plain',
        buffer: payload,
        size: payload.length,
        etag: '"mem-src-etag"',
        uploadedAt: Date.now(),
        expiresAt: Date.now() + ARTIFACT_TTL_MS,
      };

      await saveRetainedResultFromStored(mockStorage, stored.key, stored, targetKey, 'note.txt');

      expect(mockStorage.saveObject).toHaveBeenCalledWith(targetKey, payload, 'text/plain', 'note.txt', expect.any(Number));
      expect((await resultAvailability(targetKey))?.state).toBe('available');
    });
  });
});
