import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform, pipeline } from 'node:stream';
import JSZip from 'jszip';
import type { Job } from '../bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../../types';
import { storageProvider } from '../../storage';
import { scopeStorageObjects } from '../../storage/scoped-storage';
import type { IStorageBackend } from '../../storage/oci-storage';
import type { ConversionEnginePort } from '../engine-port';
import { dispatchEngine } from '../dispatch-engine';
import { graphScheduler } from './scheduler';
import { isFinalFailure } from '../job-failure';
import { safeFetch } from '../../security/safe-fetch';
import { redactText, redactUrl, scrubError } from '../../security/redact';
import { graphNodeJobId } from './node-jobs';
import { openUrlNodeSecrets } from './sealed-nodes';
import {
  createTarArchive,
  extractTarArchive,
  create7zArchiveAsync,
  extract7zArchive,
  createZipArchive,
  extractZipArchive,
  extractRarArchive,
  validateMultiVolumeSequence,
  stitchMultiVolumeArchive,
  isSplitArchive,
  applyPdfWatermark,
  protectPdf,
  unlockPdf,
} from '../../conversions';
import type { PdfAccess } from '../../conversions/pdf-access';
import { openPasswordOption } from '../option-secrets';
import { gunzipStreamingWithLimits } from '../../conversions/archive';
import {
  ConversionFailedError,
  GraphExportError,
  JobTimeoutError,
  MediaPackagingOptions,
  UnknownArtifactFormatError,
  WorkerOutputMissingError,
} from '../../types';
import { getFormatByExtension } from '../../registry';
import { mergePdfBuffers, extractArtifactMetadata } from '../../jobs';
import {
  ARCHIVE_CREATE_FORMATS,
  MEDIA_PACKAGE_OUTPUT_FORMAT,
  MERGE_FORMATS,
  THUMBNAIL_FORMATS,
  requestedTargetFormat,
} from '../../jobs/graph-operations';
import { pageCappedEngine, pageLimitForOwner } from '../page-cap';
import { deadlineBoundEngine } from '../job-deadline';
import { stripEngineControls } from '../../conversions/job-time';

const INTERMEDIATE_TTL_MS = 24 * 60 * 60 * 1000;
/** A node without any output artifact has no bytes to describe: the generic binary type with size 0. */
const NO_OUTPUT_MIME_TYPE = 'application/octet-stream';
/** Registry ids made of two dot-separated parts (`tar.gz`) are tried before the last extension alone. */
const COMPOUND_EXTENSION_PARTS = 2;

/** The MIME type the format registry (the SSOT of formats) names for a format id; an unknown id fails closed. */
function registryMimeType(formatId: string): string {
  const definition = getFormatByExtension(formatId);
  if (!definition) {
    throw new UnknownArtifactFormatError(formatId);
  }
  return definition.mimeType;
}

/** The registry MIME type of a file name from its extension (compound first), or undefined when none is registered. */
function lookupRegistryMimeTypeOfFilename(filename: string): string | undefined {
  const parts = filename.toLowerCase().split('.');
  const candidates: string[] = [];
  if (parts.length > COMPOUND_EXTENSION_PARTS) {
    candidates.push(parts.slice(-COMPOUND_EXTENSION_PARTS).join('.'));
  }
  if (parts.length > 1) {
    candidates.push(parts[parts.length - 1]);
  }
  for (const candidate of candidates) {
    const definition = getFormatByExtension(candidate);
    if (definition) {
      return definition.mimeType;
    }
  }
  return undefined;
}

/** The registry MIME type of a stored artifact, from its file extension; an unregistered extension fails closed. */
function registryMimeTypeOfFilename(filename: string): string {
  const mimeType = lookupRegistryMimeTypeOfFilename(filename);
  if (mimeType === undefined) {
    throw new UnknownArtifactFormatError(filename);
  }
  return mimeType;
}

/**
 * An extracted entry is the archive's own content, not a conversion output: an entry whose name has no
 * registered format (`LICENSE`, `.gitignore`) is opaque binary data (RFC 2046, section 4.5.1), not an error.
 */
const OPAQUE_ENTRY_MIME_TYPE = 'application/octet-stream';

function archiveEntryMimeType(entryName: string): string {
  return lookupRegistryMimeTypeOfFilename(entryName) ?? OPAQUE_ENTRY_MIME_TYPE;
}

/**
 * What a completed node reports about its primary output: the registry MIME type of its format and the exact
 * byte size of the stored object. An output that is not in storage is a server fault, never a size of 0.
 */
async function describePrimaryOutput(
  storage: IStorageBackend,
  key: string,
  isArchiveEntry: boolean
): Promise<{ mimeType: string; size: number }> {
  const stat = await storage.stat(key);
  if (!stat) {
    throw new WorkerOutputMissingError(path.basename(key));
  }
  const filename = stat.filename || path.basename(key);
  const mimeType = isArchiveEntry ? archiveEntryMimeType(filename) : registryMimeTypeOfFilename(filename);
  return { mimeType, size: stat.size };
}

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
      const stored = await storage.getObject(inputKey);
      if (!stored) {
        throw new Error(`Input artifact "${inputKey}" not found in storage`);
      }
      const transformedBuf = await transformFn(stored.buffer);
      const outFilename = stored.filename || path.basename(inputKey);
      const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
      await storage.saveObject(outKey, transformedBuf, registryMimeType('pdf'), outFilename, INTERMEDIATE_TTL_MS);
      return outKey;
    })
  );
}

const DEFAULT_THUMBNAIL_EDGE_PX = 256;
/** Packaging format of a media.package node that names none. */
const DEFAULT_PACKAGING_FORMAT = 'hls';

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

/** The password and the rights confirmation a PDF node's options carry. */
function pdfAccessOf(options: { password?: string; confirmEditRights?: boolean } | undefined): PdfAccess {
  return { password: options?.password, confirmEditRights: options?.confirmEditRights };
}

export async function processGraphNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  engine?: ConversionEnginePort,
  storage?: IStorageBackend
): Promise<ConversionJobResult> {
  // Scratch files a remote backend stages for this node's inputs are removed when the node ends.
  const scope = scopeStorageObjects(storage || storageProvider);
  const startTime = Date.now();
  const attemptSignal = job.signal;
  const graphId = job.data.graphId!;
  const nodeId = job.data.graphNodeId!;
  const submittedNode = job.data.graphNode as any;
  // Node options come from the request body: they cannot carry the signal, a timeout or a deadline into an engine.
  // Passwords sealed for the queue are opened here, in memory, and never stored back anywhere.
  const node = submittedNode?.options && typeof submittedNode.options === 'object'
    ? { ...submittedNode, options: openPasswordOption(stripEngineControls(submittedNode.options), graphNodeJobId(graphId, nodeId)) }
    : submittedNode;
  const effectiveStorage: IStorageBackend = scope.storage;
  const effectiveEngine: ConversionEnginePort = deadlineBoundEngine(
    pageCappedEngine(engine || dispatchEngine, await pageLimitForOwner(job.data.userId)),
    job
  );

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
        // Secrets are opened here, at the point of use, and never stored back anywhere.
        const { url, headers } = openUrlNodeSecrets(node, graphNodeJobId(graphId, nodeId));
        outputKeys = [await importUrlArtifact(effectiveStorage, graphId, nodeId, url, headers, attemptSignal)];
        await job.log(`Node "${nodeId}" imported from URL: ${outputKeys[0]}`);
        break;
      }

      case 'convert': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }

        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = await effectiveStorage.getObject(inputKey);
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
          await effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }
        await job.log(`Node "${nodeId}" converted ${inputArtifacts.length} artifact(s) to ${node.targetFormat}`);
        break;
      }

      case 'ocr': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = await effectiveStorage.getObject(inputKey);
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
          await effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'optimize': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = await effectiveStorage.getObject(inputKey);
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
          await effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, convRes.filename, INTERMEDIATE_TTL_MS);
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
          const stored = await effectiveStorage.getObject(inputKey);
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
          await effectiveStorage.saveObject(outKey, convRes.buffer, convRes.mimeType, outFilename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'media.package': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const packaging: MediaPackagingOptions = node.options?.packaging ?? { format: DEFAULT_PACKAGING_FORMAT };
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = await effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = artifactExtension(stored.filename, inputKey);
          // The engine packages for the format it is asked to produce and answers one ZIP.
          const packaged = await effectiveEngine.convert(
            stored.buffer,
            srcExt,
            packaging.format,
            { ...(node.options || {}), packaging },
            stored.filename
          );
          const outKey = `intermediate/${graphId}/${nodeId}/${packaged.filename}`;
          await effectiveStorage.saveObject(outKey, packaged.buffer, registryMimeType(MEDIA_PACKAGE_OUTPUT_FORMAT), packaged.filename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }
        await job.log(`Node "${nodeId}" packaged ${inputArtifacts.length} artifact(s) as ${packaging.format}`);
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
          (buf) => applyPdfWatermark(buf, watermarkOpts, pdfAccessOf(node.options))
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

      case 'pdf.unlock': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const processedKeys = await processIntermediatePdfArtifacts(
          graphId,
          nodeId,
          inputArtifacts,
          effectiveStorage,
          attemptSignal,
          (buf) => unlockPdf(buf, pdfAccessOf(node.options))
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" unlocked ${inputArtifacts.length} artifact(s)`);
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
        const inputs = await Promise.all(inputArtifacts.map(async (inputKey) => {
          const stored = await effectiveStorage.getObject(inputKey);
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
        }));
        if (targetFmt === 'pdf') {
          const pdfBuffers = inputs.map((stored) => stored.buffer);
          const mergedBuf = await mergePdfBuffers(pdfBuffers, {
            passwords: node.options?.passwords,
            confirmEditRights: node.options?.confirmEditRights,
          });
          const outFilename = 'merged.pdf';
          const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
          await effectiveStorage.saveObject(outKey, mergedBuf, registryMimeType('pdf'), outFilename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        } else {
          const mergedBuf = Buffer.from(inputs.map((stored) => stored.buffer.toString('utf-8')).join('\n\n'), 'utf-8');
          const outFilename = `merged.${targetFmt}`;
          const outKey = `intermediate/${graphId}/${nodeId}/${outFilename}`;
          await effectiveStorage.saveObject(outKey, mergedBuf, registryMimeType(targetFmt), outFilename, INTERMEDIATE_TTL_MS);
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
        const stored = await effectiveStorage.getObject(inputKey);
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
        await effectiveStorage.saveObject(outKey, jsonBuf, registryMimeType('json'), outFilename, INTERMEDIATE_TTL_MS);
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
          const stored = await effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Artifact "${inputKey}" not found in storage`);
          }
          filesToArchive.push({
            filename: stored.filename || path.basename(inputKey),
            buffer: stored.buffer,
          });
        }

        let archiveBuf: Buffer;

        if (targetFmt === 'zip') {
          const zipRes = await createZipArchive(filesToArchive, node.options || {}, `bundle.zip`);
          archiveBuf = zipRes.buffer;
        } else if (targetFmt === 'tar' || targetFmt === 'tar.gz') {
          const tarRes = createTarArchive(filesToArchive, node.options || {}, `bundle.tar`);
          archiveBuf = targetFmt === 'tar.gz' ? zlib.gzipSync(tarRes.buffer) : tarRes.buffer;
        } else if (targetFmt === '7z') {
          const sevenZipRes = await create7zArchiveAsync(filesToArchive, node.options || {}, `bundle.7z`);
          archiveBuf = sevenZipRes.buffer;
        } else {
          throw new ConversionFailedError(
            `archive.create node "${nodeId}" cannot produce "${targetFmt}"; supported: ${[...ARCHIVE_CREATE_FORMATS].join(', ')}`
          );
        }

        const outKey = `intermediate/${graphId}/${nodeId}/bundle.${targetFmt}`;
        await effectiveStorage.saveObject(outKey, archiveBuf, registryMimeType(targetFmt), `bundle.${targetFmt}`, INTERMEDIATE_TTL_MS);
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
          const parts = await Promise.all(inputArtifacts.map(async (k) => {
            const st = await effectiveStorage.getObject(k);
            if (!st) throw new Error(`Archive artifact "${k}" not found`);
            return { filename: st.filename || path.basename(k), buffer: st.buffer };
          }));
          validateMultiVolumeSequence(parts.map((p) => p.filename));
          const stitched = stitchMultiVolumeArchive(parts);
          archiveBuffer = stitched.buffer;
          effectiveFilename = stitched.baseFilename;
        } else {
          const archiveKey = inputArtifacts[0];
          const stored = await effectiveStorage.getObject(archiveKey);
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
          const uncompressed = (ext === 'tar.gz' || ext === 'tgz') ? await gunzipStreamingWithLimits(archiveBuffer) : archiveBuffer;
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
          const entryName = path.basename(f.filename);
          await effectiveStorage.saveObject(outKey, f.buffer, archiveEntryMimeType(entryName), entryName, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }

        await job.log(`Extracted ${outputKeys.length} artifact(s) from archive`);
        break;
      }

      case 'export.url': {
        const destination = openUrlNodeSecrets(node, graphNodeJobId(graphId, nodeId));
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          await exportArtifactToUrl(
            effectiveStorage,
            inputKey,
            destination.url,
            node.method || 'PUT',
            destination.headers,
            attemptSignal
          );
        }
        outputKeys = inputArtifacts;
        break;
      }

      case 'export.internal': {
        const inputArtifacts = await resolveInputArtifacts(graphId, node.input, job.data.inputArtifacts);
        for (const inputKey of inputArtifacts) {
          attemptSignal.throwIfAborted();
          const stored = await effectiveStorage.getObject(inputKey);
          if (!stored) continue;

          const promotedKey = `results/${graphId}/${stored.filename || path.basename(inputKey)}`;
          await effectiveStorage.saveObject(
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

    // Described before the node is marked completed: an output that cannot be described fails the node.
    const primaryKey = outputKeys[0] || '';
    const primaryOutput = primaryKey
      ? await describePrimaryOutput(effectiveStorage, primaryKey, node.op === 'archive.extract')
      : { mimeType: NO_OUTPUT_MIME_TYPE, size: 0 };

    // An engine that ignored the abort and returned late has no say: the queue already failed this attempt (deadline,
    // cancel or takeover), so the node is never recorded as completed.
    attemptSignal.throwIfAborted();
    await graphScheduler.onNodeCompleted(graphId, nodeId, outputKeys, 1);

    return {
      jobId: job.id,
      status: 'completed',
      resultKey: primaryKey,
      downloadUrl: primaryKey ? `/api/storage/file/${encodeURIComponent(primaryKey)}` : '',
      filename: path.basename(primaryKey),
      mimeType: primaryOutput.mimeType,
      size: primaryOutput.size,
      durationMs,
    };
  } catch (err: any) {
    // Whatever an SDK or a remote quoted into the error, it leaves this node run masked.
    scrubError(err);
    // A retry may still succeed, and a cancelled attempt is not a failure: only the last
    // failed attempt fails the node (and, under fail_fast, the graph). A failure that cannot be
    // retried is the last one.
    // A deadline aborts the signal too, but it is a failure of the node: the graph must settle (fail_fast fails it,
    // continue skips what depends on the node). Only a cancel or a takeover leaves the node to its own path.
    const pastDeadline = attemptSignal.reason instanceof JobTimeoutError;
    const failure: unknown = pastDeadline ? attemptSignal.reason : err;
    if ((!attemptSignal.aborted || pastDeadline) && isFinalFailure({ attemptsMade: job.attemptsMade, opts: { attempts: job.opts?.attempts ?? 1 } }, failure)) {
      const errorMsg = redactText(failure instanceof Error ? failure.message : String(failure));
      await graphScheduler.onNodeFailed(graphId, nodeId, errorMsg);
    }
    throw failure;
  } finally {
    await scope.releaseAll();
  }
}

/** Largest body an import.url node accepts; override with GRAPH_URL_IMPORT_MAX_BYTES. */
const DEFAULT_URL_IMPORT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function urlImportMaxBytes(): number {
  const configured = Number(process.env.GRAPH_URL_IMPORT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_URL_IMPORT_MAX_BYTES;
}

/** Streams a public URL into intermediate storage, refusing internal targets and oversized bodies. */
async function importUrlArtifact(
  storage: IStorageBackend,
  graphId: string,
  nodeId: string,
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal
): Promise<string> {
  const response = await safeFetch(url, { headers, signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ConversionFailedError(`Failed to fetch URL ${redactUrl(url)}: HTTP ${response.status}`);
  }
  const maxBytes = urlImportMaxBytes();
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw new ConversionFailedError(`Remote file at ${redactUrl(url)} is ${declared} bytes, above the ${maxBytes}-byte import limit`);
  }

  let received = 0;
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (received > maxBytes) {
        done(new ConversionFailedError(`Remote file at ${redactUrl(url)} exceeds the ${maxBytes}-byte import limit`));
        return;
      }
      done(null, chunk);
    },
  });
  // pipeline forwards a source error (remote reset, abort) to the limiter that storage consumes,
  // and destroys the source, cancelling the download, when the limiter fails. Storage observes
  // every failure through the limiter's 'error' event, so the callback has nothing left to do.
  const limited = pipeline(source, limiter, () => undefined);

  const urlName = path.basename(new URL(url).pathname);
  const filename = urlName && urlName !== '/' ? urlName : `${nodeId}.bin`;
  const key = `intermediate/${graphId}/${nodeId}/${filename}`;
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  await storage.saveObjectFromStream(key, limited, { filename, mimeType }, INTERMEDIATE_TTL_MS);
  return key;
}

/** Headers the worker sets itself from the stored artifact; a customer-supplied copy would misdescribe the body. */
const EXPORT_FRAMING_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-length']);

function withoutFramingHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !EXPORT_FRAMING_HEADERS.has(name.toLowerCase())));
}

/** Streams one stored artifact to the destination URL and fails unless it answers 2xx. */
async function exportArtifactToUrl(
  storage: IStorageBackend,
  inputKey: string,
  url: string,
  method: string,
  customerHeaders: Record<string, string> | undefined,
  signal: AbortSignal
): Promise<void> {
  const stat = await storage.stat(inputKey);
  const stream = stat ? await storage.openReadStream(inputKey) : null;
  if (!stat || !stream) {
    throw new GraphExportError(`Input artifact "${inputKey}" not found in storage`);
  }
  const response = await safeFetch(url, {
    method,
    body: Readable.from(stream),
    duplex: 'half',
    headers: {
      ...withoutFramingHeaders(customerHeaders),
      'Content-Type': stat.mimeType || 'application/octet-stream',
      'Content-Length': String(stat.size),
    },
    signal,
  });
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
