import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import type { Job } from '../bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../../types';
import { convertFile } from '../../conversions';
import { s3Storage } from '../../storage/s3-storage';
import { graphScheduler } from './scheduler';
import { createTarArchive, extractTarArchive, create7zArchive, extract7zArchive } from '../../conversions/archive';

export async function processGraphNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>
): Promise<ConversionJobResult> {
  const startTime = Date.now();
  const attemptSignal = job.signal;
  const graphId = job.data.graphId!;
  const nodeId = job.data.graphNodeId!;
  const node = job.data.graphNode!;

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
        s3Storage.saveObject(key, buf, mimeType, urlFilename, 24 * 60 * 60 * 1000);
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
          const stored = s3Storage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }

          const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '') || 'bin';
          const convRes = await convertFile(
            stored.buffer,
            srcExt,
            node.targetFormat,
            node.options || {},
            stored.filename
          );

          const outKey = `intermediate/${graphId}/${nodeId}/${convRes.filename}`;
          s3Storage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        await job.log(`Node "${nodeId}" converted ${inputArtifacts.length} artifact(s) to ${node.targetFormat}`);
        break;
      }

      case 'ocr': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = s3Storage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '') || 'png';
          const convRes = await convertFile(
            stored.buffer,
            srcExt,
            'pdf',
            { ...(node.options || {}), ocrEnabled: true },
            stored.filename
          );
          const outKey = `intermediate/${graphId}/${nodeId}/${convRes.filename}`;
          s3Storage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'optimize': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = s3Storage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = path.extname(stored.filename || inputKey).replace(/^\./, '') || 'bin';
          const convRes = await convertFile(
            stored.buffer,
            srcExt,
            srcExt,
            node.options || {},
            stored.filename
          );
          const outKey = `intermediate/${graphId}/${nodeId}/${convRes.filename}`;
          s3Storage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'archive.create': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`archive.create node "${nodeId}" has no input artifacts to bundle`);
        }

        const filesToArchive: { filename: string; buffer: Buffer }[] = [];
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = s3Storage.getObject(inputKey);
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
        const targetFmt = node.targetFormat || 'zip';

        if (targetFmt === 'zip') {
          const zip = new JSZip();
          for (const f of filesToArchive) {
            zip.file(f.filename, f.buffer);
          }
          archiveBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          archiveMime = 'application/zip';
        } else if (targetFmt === 'tar' || targetFmt === 'tar.gz') {
          const tarRes = createTarArchive(filesToArchive, {});
          archiveBuf = targetFmt === 'tar.gz' ? zlib.gzipSync(tarRes.buffer) : tarRes.buffer;
          archiveMime = targetFmt === 'tar.gz' ? 'application/gzip' : 'application/x-tar';
        } else if (targetFmt === '7z') {
          const sevenZipRes = create7zArchive(filesToArchive);
          archiveBuf = sevenZipRes.buffer;
          archiveMime = 'application/x-7z-compressed';
        } else {
          const zip = new JSZip();
          for (const f of filesToArchive) {
            zip.file(f.filename, f.buffer);
          }
          archiveBuf = await zip.generateAsync({ type: 'nodebuffer' });
          archiveMime = 'application/zip';
        }

        const outKey = `intermediate/${graphId}/${nodeId}/bundle.${targetFmt}`;
        s3Storage.saveObject(outKey, archiveBuf, archiveMime, `bundle.${targetFmt}`, 24 * 60 * 60 * 1000);
        outputKeys = [outKey];
        await job.log(`Created archive with ${filesToArchive.length} file(s): ${outKey}`);
        break;
      }

      case 'archive.extract': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`archive.extract node "${nodeId}" has no input artifact`);
        }

        const archiveKey = inputArtifacts[0];
        const stored = s3Storage.getObject(archiveKey);
        if (!stored) {
          throw new Error(`Archive artifact "${archiveKey}" not found`);
        }

        const ext = path.extname(stored.filename || archiveKey).toLowerCase().replace(/^\./, '');
        let extracted: { filename: string; buffer: Buffer }[] = [];

        if (ext === 'tar' || ext === 'tar.gz' || ext === 'tgz') {
          extracted = extractTarArchive(stored.buffer);
        } else if (ext === '7z') {
          extracted = extract7zArchive(stored.buffer);
        } else {
          const zip = await JSZip.loadAsync(stored.buffer);
          for (const [entryName, entryFile] of Object.entries(zip.files)) {
            if (!entryFile.dir) {
              const fileBuf = await entryFile.async('nodebuffer');
              extracted.push({ filename: entryName, buffer: fileBuf });
            }
          }
        }

        if (node.entries && node.entries.length > 0) {
          const allowed = new Set(node.entries);
          extracted = extracted.filter((e) => allowed.has(e.filename) || allowed.has(path.basename(e.filename)));
        }

        for (const f of extracted) {
          const outKey = `intermediate/${graphId}/${nodeId}/${path.basename(f.filename)}`;
          s3Storage.saveObject(outKey, f.buffer, 'application/octet-stream', path.basename(f.filename), 24 * 60 * 60 * 1000);
          outputKeys.push(outKey);
        }

        await job.log(`Extracted ${outputKeys.length} artifact(s) from archive`);
        break;
      }

      case 'export.url': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = s3Storage.getObject(inputKey);
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
          const stored = s3Storage.getObject(inputKey);
          if (!stored) continue;

          const promotedKey = `results/${graphId}/${stored.filename || path.basename(inputKey)}`;
          s3Storage.saveObject(
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
