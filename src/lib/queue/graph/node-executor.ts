import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { Job } from '../bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../../types';
import { convertFile } from '../../conversions';
import { s3Storage } from '../../storage/s3-storage';
import type { IStorageBackend } from '../../storage/oci-storage';
import type { ConversionEnginePort } from '../engine-port';
import { graphScheduler } from './scheduler';
import {
  createTarArchive,
  extractTarArchive,
  create7zArchive,
  extract7zArchive,
  createZipArchive,
  extractZipArchive,
  extractRarArchive,
  validateMultiVolumeSequence,
  stitchMultiVolumeArchive,
  isSplitArchive,
  applyPdfWatermark,
  protectPdf,
} from '../../conversions';
import { ConversionFailedError, GraphExportError } from '../../types';
import { mergePdfBuffers, extractArtifactMetadata } from '../../jobs';
import { ARCHIVE_CREATE_FORMATS, MERGE_FORMATS, THUMBNAIL_FORMATS, requestedTargetFormat } from '../../jobs/graph-operations';

async function processIntermediatePdfArtifacts(
  graphId: string,
  nodeId: string,
  inputKeys: string[],
  storage: IStorageBackend,
  attemptSignal: AbortSignal,
  transformFn: (buf: Buffer) => Promise<Buffer>
): Promise<string[]> {
  return Promise.all(
    inputKeys.map(async (inputKey) => {
      attemptSignal.throwIfAborted();
      const stored = storage.getObject(inputKey);
      if (!stored) {
        throw new Error(`Input artifact "${inputKey}" not found in storage`);
      }
      const transformedBuf = await transformFn(stored.buffer);
      const outFilename = stored.filename || path.basename(inputKey);
      const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
      storage.saveObject(outKey, transformedBuf, 'application/pdf', outFilename, 24 * 60 * 60 * 1000);
      return outKey;
    })
  );
}

const DEFAULT_THUMBNAIL_EDGE_PX = 256;

/** Extension of a stored artifact; artifacts without one cannot be routed to a converter. */
function artifactExtension(filename: string | undefined, key: string): string {
  const ext = path.extname(filename || key).replace(/^\./, '').toLowerCase();
  if (!ext) {
    throw new ConversionFailedError(`Artifact "${key}" has no file extension, so its format is unknown`);
  }
  return ext;
}

/** The node's requested output format. Validation guarantees one; a missing value is a defect. */
function requireTargetFormat(node: { op?: string; targetFormat?: unknown; options?: any }, nodeId: string): string {
  const target = requestedTargetFormat(node);
  if (!target) {
    throw new ConversionFailedError(`Node "${nodeId}" (${node.op}) has no targetFormat`);
  }
  return target;
}

export async function processGraphNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  engine?: ConversionEnginePort,
  storage?: IStorageBackend
): Promise<ConversionJobResult> {
  const startTime = Date.now();
  const attemptSignal = job.signal;
  const graphId = job.data.graphId!;
  const nodeId = job.data.graphNodeId!;
  const node = job.data.graphNode as any;
  const effectiveStorage: IStorageBackend = storage || s3Storage;
  const effectiveEngine: ConversionEnginePort = engine || {
    name: 'ts-engine',
    async convert(input, src, tgt, options, filename) {
      let buf: Buffer;
      if (Buffer.isBuffer(input)) {
        buf = input;
      } else if (input && input.inputBuffer) {
        buf = input.inputBuffer;
      } else if (input && input.inputPath) {
        buf = fs.readFileSync(input.inputPath);
      } else {
        throw new Error('Invalid input payload');
      }
      const res = await convertFile(buf, src, tgt, options, filename);
      return {
        buffer: res.buffer,
        size: res.size,
        mimeType: res.mimeType,
        filename: res.filename,
        engineUsed: 'ts-engine',
      };
    },
  };

  await job.log(`Executing graph node "${nodeId}" (op: ${node.op}) in graph ${graphId}`);
  await job.updateProgress(10);
  await graphScheduler.onNodeStarted(graphId, nodeId);

  let outputKeys: string[] = [];

  try {
    attemptSignal.throwIfAborted();

    switch (node.op) {
      case 'import.upload': {
        outputKeys = [node.storageKey];
        await job.log(`Node "${nodeId}" imported uploaded key: ${node.storageKey}`);
        break;
      }

      case 'import.url': {
        const response = await fetch(node.url, {
          headers: node.headers,
          signal: attemptSignal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch URL ${node.url}: HTTP ${response.status} ${response.statusText}`);
        }
        const arrayBuf = await response.arrayBuffer();
        const buf = Buffer.from(arrayBuf);

        let urlFilename = path.basename(new URL(node.url).pathname);
        if (!urlFilename || urlFilename === '/') {
          urlFilename = `${nodeId}.bin`;
        }
        const key = `intermediate/${graphId}/${nodeId}/${urlFilename}`;
        const mimeType = response.headers.get('content-type') || 'application/octet-stream';
        effectiveStorage.saveObject(key, buf, mimeType, urlFilename, 24 * 60 * 60 * 1000);
        outputKeys = [key];
        await job.log(`Node "${nodeId}" imported from URL: ${key}`);
        break;
      }

      case 'convert': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }

        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }

          const srcExt = artifactExtension(stored.filename, inputKey);
          const convRes = await effectiveEngine.convert(
            stored.buffer,
            srcExt,
            node.targetFormat,
            node.options || {},
            stored.filename
          );

          const outKey = `intermediate/${graphId}/${nodeId}/${convRes.filename}`;
          effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        await job.log(`Node "${nodeId}" converted ${inputArtifacts.length} artifact(s) to ${node.targetFormat}`);
        break;
      }

      case 'ocr': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = artifactExtension(stored.filename, inputKey);
          const convRes = await effectiveEngine.convert(
            stored.buffer,
            srcExt,
            'pdf',
            { ...(node.options || {}), ocrEnabled: true },
            stored.filename
          );
          const outKey = `intermediate/${graphId}/${nodeId}/${convRes.filename}`;
          effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'optimize': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = artifactExtension(stored.filename, inputKey);
          const convRes = await effectiveEngine.convert(
            stored.buffer,
            srcExt,
            srcExt,
            node.options || {},
            stored.filename
          );
          const outKey = `intermediate/${graphId}/${nodeId}/${convRes.filename}`;
          effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'thumbnail': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = artifactExtension(stored.filename, inputKey);
          const targetFormat = requireTargetFormat(node, nodeId);
          if (!THUMBNAIL_FORMATS.has(targetFormat)) {
            throw new ConversionFailedError(`Thumbnail node "${nodeId}" cannot produce "${targetFormat}"`);
          }
          const width = node.options?.thumbnail?.width ?? DEFAULT_THUMBNAIL_EDGE_PX;
          const height = node.options?.thumbnail?.height ?? DEFAULT_THUMBNAIL_EDGE_PX;
          const convRes = await effectiveEngine.convert(
            stored.buffer,
            srcExt,
            targetFormat,
            {
              ...((node as any).options || {}),
              thumbnail: undefined,
              width,
              height,
              fit: 'inside',
            },
            stored.filename
          );
          const outFilename = `thumbnail.${targetFormat}`;
          const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
          effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, outFilename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'watermark':
      case 'pdf.watermark': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const watermarkOpts = (node.options?.watermark || node.options || {}) as any;
        const processedKeys = await processIntermediatePdfArtifacts(
          graphId,
          nodeId,
          inputArtifacts,
          effectiveStorage,
          attemptSignal,
          (buf) => applyPdfWatermark(buf, watermarkOpts)
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" applied watermark to ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'pdf.protect': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const protectOpts = (node.options?.protect || node.options || {}) as any;
        const processedKeys = await processIntermediatePdfArtifacts(
          graphId,
          nodeId,
          inputArtifacts,
          effectiveStorage,
          attemptSignal,
          (buf) => protectPdf(buf, protectOpts)
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" applied protection to ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'merge': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const targetFmt = requireTargetFormat(node, nodeId);
        if (!MERGE_FORMATS.has(targetFmt)) {
          throw new ConversionFailedError(`Merge node "${nodeId}" cannot produce "${targetFmt}"`);
        }
        // Every input must exist and already be in the merged format; nothing is skipped.
        const inputs = inputArtifacts.map((inputKey) => {
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const inputExt = artifactExtension(stored.filename, inputKey);
          if (inputExt !== targetFmt) {
            throw new ConversionFailedError(`Merge node "${nodeId}" received a "${inputExt}" input; expected "${targetFmt}"`);
          }
          if (stored.buffer.length === 0) {
            throw new ConversionFailedError(`Merge node "${nodeId}" input "${inputKey}" is empty`);
          }
          return stored;
        });
        if (targetFmt === 'pdf') {
          const pdfBuffers = inputs.map((stored) => stored.buffer);
          const mergedBuf = await mergePdfBuffers(pdfBuffers);
          const outFilename = 'merged.pdf';
          const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
          effectiveStorage.saveObject(outKey, mergedBuf, 'application/pdf', outFilename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        } else {
          const mergedBuf = Buffer.from(inputs.map((stored) => stored.buffer.toString('utf-8')).join('\n\n'), 'utf-8');
          const outFilename = `merged.${targetFmt}`;
          const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
          effectiveStorage.saveObject(outKey, mergedBuf, 'text/plain', outFilename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'metadata': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const inputKey = inputArtifacts[0];
        const stored = effectiveStorage.getObject(inputKey);
        if (!stored) {
          throw new Error(`Input artifact "${inputKey}" not found in storage`);
        }
        const meta = await extractArtifactMetadata(
          stored.buffer,
          stored.filename || path.basename(inputKey),
          inputKey
        );
        const jsonBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf-8');
        const outFilename = 'metadata.json';
        const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
        effectiveStorage.saveObject(outKey, jsonBuf, 'application/json', outFilename, 24 * 60 * 60 * 1000);
        outputKeys.push(outKey);
        break;
      }

      case 'archive.create': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`archive.create node "${nodeId}" has no input artifacts to bundle`);
        }

        const targetFmt = requireTargetFormat(node, nodeId);
        if (targetFmt === 'rar') {
          throw new ConversionFailedError(
            "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
          );
        }

        const filesToArchive: { filename: string; buffer: Buffer }[] = [];
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Artifact "${inputKey}" not found in storage`);
          }
          filesToArchive.push({
            filename: stored.filename || path.basename(inputKey),
            buffer: stored.buffer,
          });
        }

        let archiveBuf: Buffer;
        let archiveMime: string;

        if (targetFmt === 'zip') {
          const zipRes = await createZipArchive(filesToArchive, node.options || {}, `bundle.zip`);
          archiveBuf = zipRes.buffer;
          archiveMime = 'application/zip';
        } else if (targetFmt === 'tar' || targetFmt === 'tar.gz') {
          const tarRes = createTarArchive(filesToArchive, node.options || {}, `bundle.tar`);
          archiveBuf = targetFmt === 'tar.gz' ? zlib.gzipSync(tarRes.buffer) : tarRes.buffer;
          archiveMime = targetFmt === 'tar.gz' ? 'application/gzip' : 'application/x-tar';
        } else if (targetFmt === '7z') {
          const sevenZipRes = create7zArchive(filesToArchive, node.options || {}, `bundle.7z`);
          archiveBuf = sevenZipRes.buffer;
          archiveMime = 'application/x-7z-compressed';
        } else {
          throw new ConversionFailedError(
            `archive.create node "${nodeId}" cannot produce "${targetFmt}"; supported: ${[...ARCHIVE_CREATE_FORMATS].join(', ')}`
          );
        }

        const outKey = `intermediate/${graphId}/${nodeId}/bundle.${targetFmt}`;
        effectiveStorage.saveObject(outKey, archiveBuf, archiveMime, `bundle.${targetFmt}`, 24 * 60 * 60 * 1000);
        outputKeys = [outKey];
        await job.log(`Created archive with ${filesToArchive.length} file(s): ${outKey}`);
        break;
      }

      case 'archive.extract': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`archive.extract node "${nodeId}" has no input artifact`);
        }

        let archiveBuffer: Buffer;
        let effectiveFilename: string;

        if (inputArtifacts.length > 1) {
          const parts = inputArtifacts.map((k) => {
            const st = effectiveStorage.getObject(k);
            if (!st) throw new Error(`Archive artifact "${k}" not found`);
            return { filename: st.filename || path.basename(k), buffer: st.buffer };
          });
          validateMultiVolumeSequence(parts.map((p) => p.filename));
          const stitched = stitchMultiVolumeArchive(parts);
          archiveBuffer = stitched.buffer;
          effectiveFilename = stitched.baseFilename;
        } else {
          const archiveKey = inputArtifacts[0];
          const stored = effectiveStorage.getObject(archiveKey);
          if (!stored) {
            throw new Error(`Archive artifact "${archiveKey}" not found`);
          }
          effectiveFilename = stored.filename || archiveKey;
          if (isSplitArchive(effectiveFilename)) {
            validateMultiVolumeSequence([effectiveFilename]);
          }
          archiveBuffer = stored.buffer;
        }

        const ext = path.extname(effectiveFilename).toLowerCase().replace(/^\./, '');
        let extracted: { filename: string; buffer: Buffer }[] = [];

        if (ext === 'tar' || ext === 'tar.gz' || ext === 'tgz') {
          const uncompressed = (ext === 'tar.gz' || ext === 'tgz') ? zlib.gunzipSync(archiveBuffer) : archiveBuffer;
          extracted = extractTarArchive(uncompressed, { entries: node.entries });
        } else if (ext === '7z') {
          extracted = extract7zArchive(archiveBuffer, { entries: node.entries });
        } else if (ext === 'rar') {
          extracted = extractRarArchive(archiveBuffer, { entries: node.entries });
        } else {
          extracted = await extractZipArchive(archiveBuffer, { entries: node.entries });
        }

        for (const f of extracted) {
          const outKey = `intermediate/${graphId}/${nodeId}/${path.basename(f.filename)}`;
          effectiveStorage.saveObject(outKey, f.buffer, 'application/octet-stream', path.basename(f.filename), 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }

        await job.log(`Extracted ${outputKeys.length} artifact(s) from archive`);
        break;
      }

      case 'export.url': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          await exportArtifactToUrl(effectiveStorage, inputKey, node.url, node.method || 'PUT', attemptSignal);
        }
        outputKeys = inputArtifacts;
        break;
      }

      case 'export.internal': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) continue;

          const promotedKey = `results/${graphId}/${stored.filename || path.basename(inputKey)}`;
          effectiveStorage.saveObject(
            promotedKey,
            stored.buffer,
            stored.mimeType,
            stored.filename || path.basename(inputKey),
            60 * 60 * 1000
          );
          outputKeys.push(promotedKey);
        }
        await job.log(`Promoted ${outputKeys.length} result(s) to permanent storage`);
        break;
      }

      default: {
        throw new Error(`Unsupported graph node operation: ${(node as any).op}`);
      }
    }

    const durationMs = Date.now() - startTime;
    await job.updateProgress(100);

    await graphScheduler.onNodeCompleted(graphId, nodeId, outputKeys, 1);

    const primaryKey = outputKeys[0] || '';
    return {
      jobId: job.id,
      status: 'completed',
      resultKey: primaryKey,
      downloadUrl: primaryKey ? `/api/storage/file/${encodeURIComponent(primaryKey)}` : '',
      filename: path.basename(primaryKey),
      mimeType: 'application/octet-stream',
      size: 0,
      durationMs,
    };
  } catch (err: any) {
    // A retry may still succeed, and a cancelled attempt is not a failure: only the last
    // failed attempt fails the node (and, under fail_fast, the graph).
    if (!attemptSignal.aborted && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await graphScheduler.onNodeFailed(graphId, nodeId, errorMsg);
    }
    throw err;
  }
}

/** Streams one stored artifact to the destination URL and fails unless it answers 2xx. */
async function exportArtifactToUrl(
  storage: IStorageBackend,
  inputKey: string,
  url: string,
  method: string,
  signal: AbortSignal
): Promise<void> {
  const stat = storage.stat(inputKey);
  const stream = stat ? storage.openReadStream(inputKey) : null;
  if (!stat || !stream) {
    throw new GraphExportError(`Input artifact "${inputKey}" not found in storage`);
  }
  const response = await fetch(url, {
    method,
    body: Readable.toWeb(Readable.from(stream)) as ReadableStream,
    duplex: 'half',
    headers: {
      'Content-Type': stat.mimeType || 'application/octet-stream',
      'Content-Length': String(stat.size),
    },
    signal,
  } as RequestInit);
  // Drain the body so the connection can be reused; the payload itself is not needed.
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) {
    throw new GraphExportError(
      `Export of "${inputKey}" failed: destination answered HTTP ${response.status}`,
      response.status
    );
  }
}

async function resolveInputArtifacts(
  graphId: string,
  inputRef?: string | string[],
  providedArtifacts?: string[]
): Promise<string[]> {
  if (providedArtifacts && providedArtifacts.length > 0) {
    return providedArtifacts;
  }
  if (!inputRef) return [];
  return graphScheduler.getNodeOutputs(graphId, inputRef);
}
