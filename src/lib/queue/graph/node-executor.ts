import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
import { ConversionFailedError } from '../../types';

export async function processGraphNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  engine?: ConversionEnginePort,
  storage?: IStorageBackend
): Promise<ConversionJobResult> {
  const startTime = Date.now();
  const attemptSignal = job.signal;
  const graphId = job.data.graphId!;
  const nodeId = job.data.graphNodeId!;
  const node = job.data.graphNode!;
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

          const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '') || 'bin';
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
          const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '') || 'png';
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
          const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '') || 'bin';
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

      case 'watermark':
      case 'pdf.watermark': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const watermarkOpts = (node.options?.watermark || node.options || {}) as any;
        const processedKeys = await Promise.all(
          inputArtifacts.map(async (inputKey) => {
            attemptSignal.throwIfAborted();
            const stored = effectiveStorage.getObject(inputKey);
            if (!stored) {
              throw new Error(`Input artifact "${inputKey}" not found in storage`);
            }
            const watermarkedBuf = await applyPdfWatermark(stored.buffer, watermarkOpts);
            const outFilename = stored.filename || path.basename(inputKey);
            const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
            effectiveStorage.saveObject(outKey, watermarkedBuf, 'application/pdf', outFilename, 24 * 60 * 60 * 1000);
            return outKey;
          })
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
        const processedKeys = await Promise.all(
          inputArtifacts.map(async (inputKey) => {
            attemptSignal.throwIfAborted();
            const stored = effectiveStorage.getObject(inputKey);
            if (!stored) {
              throw new Error(`Input artifact "${inputKey}" not found in storage`);
            }
            const protectedBuf = await protectPdf(stored.buffer, protectOpts);
            const outFilename = stored.filename || path.basename(inputKey);
            const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
            effectiveStorage.saveObject(outKey, protectedBuf, 'application/pdf', outFilename, 24 * 60 * 60 * 1000);
            return outKey;
          })
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" applied protection to ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'archive.create': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`archive.create node "${nodeId}" has no input artifacts to bundle`);
        }

        const targetFmt = (node.targetFormat || 'zip').toLowerCase().replace(/^\./, '');
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
          const zipRes = await createZipArchive(filesToArchive, node.options || {}, `bundle.${targetFmt}`);
          archiveBuf = zipRes.buffer;
          archiveMime = 'application/zip';
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
          const stored = effectiveStorage.getObject(inputKey);
          if (!stored) continue;
          await fetch(node.url, {
            method: node.method || 'PUT',
            body: new Uint8Array(stored.buffer),
            headers: {
              'Content-Type': stored.mimeType || 'application/octet-stream',
            },
            signal: attemptSignal,
          });
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
    const errorMsg = err instanceof Error ? err.message : String(err);
    await graphScheduler.onNodeFailed(graphId, nodeId, errorMsg);
    throw err;
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
