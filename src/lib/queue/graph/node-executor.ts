import path from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { Job } from '../bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../../types';
import { storageProvider } from '../../storage';
import { scopeStorageObjects } from '../../storage/scoped-storage';
import type { IStorageBackend } from '../../storage/oci-storage';
import type { ConversionEnginePort, EngineResult } from '../engine-port';
import { dispatchEngine } from '../dispatch-engine';
import { graphScheduler } from './scheduler';
import { isFinalFailure } from '../job-failure';
import { assertPublicOutboundUrl, safeFetch } from '../../security/safe-fetch';
import { maskFailure } from '../../security/server-paths';
import { refusalCodeList } from '../../refusal-codes';
import { graphNodeJobId, nodeOutputKey, sanitizeNodeOutputFilename } from './node-jobs';
import { openUrlNodeSecrets } from './sealed-nodes';
import { exportToCustomerStorage, importFromCustomerStorage } from './node-storage-io';
import {
  createTarArchive,
  extractTarArchive,
  create7zArchiveAsync,
  createZipArchive,
  extractZipArchive,
  extractRarArchive,
  validateMultiVolumeSequence,
  stitchMultiVolumeArchive,
  isSplitArchive,
  applyPdfWatermark,
  protectPdf,
  unlockPdf,
  splitPdfPages,
  extractPdfPages,
  deletePdfPages,
  reorderPdfPages,
  rotatePdfPages,
} from '../../conversions';
import type { PdfAccess } from '../../conversions/pdf-access';
import {
  type ArchiveExtractionLimits,
  exceedsArchiveRatio,
} from '../../conversions/archive-extraction-safety';
import { isWrapperSource, unpackWrapperSource } from '../../conversions/archive-wrapper-sources';
import { decompressZstdNative } from '../../conversions/zstd-native';
import { openPasswordOption } from '../option-secrets';
import { OPTIMIZERS, getOptimizer, type OptimizerRegistry } from '../../conversions/optimizers';
import {
  ARCHIVE_SECURITY_LIMITS,
  decompressXz,
  extract7zArchiveAsync,
  gunzipStreamingWithLimits,
} from '../../conversions/archive';
import { resolveArchiveCompressionLevel } from '../../conversions/archive-compression-level';
import { gzipInBlocks } from '../../conversions/deflate-blocks';
import {
  ConversionFailedError,
  DecompressionLimitError,
  GraphExportError,
  InvalidPageRangeError,
  JobTimeoutError,
  MediaPackagingOptions,
  PdfPasswordListError,
  UnknownArtifactFormatError,
  WorkerOutputMissingError,
} from '../../types';
import { getFormatByExtension } from '../../registry';
import { mergePdfBuffers, extractArtifactMetadata } from '../../jobs';
import {
  ARCHIVE_CREATE_FORMATS,
  MEDIA_PACKAGE_OUTPUT_FORMAT,
  MERGE_FORMATS,
  PDF_SPLIT_OUTPUT_FORMAT,
  THUMBNAIL_FORMATS,
  graphNodeCharge,
  requestedTargetFormat,
} from '../../jobs/graph-operations';
import { importUrlWithinBudget } from './node-url-import';
import { holdUnitsForInputs } from './node-reservation';
import type { ExportUrlNode, GraphNode } from './types';
import { saveRetainedResult } from '../../storage/retention-service';
import { heldGraphInput } from './input-cleanup';
import { deadlineBoundEngine, jobDeadlineAt } from '../job-deadline';
import { JOB_DEADLINE_AT, remainingJobMs, stripEngineControls } from '../../conversions/job-time';

const INTERMEDIATE_TTL_MS = 24 * 60 * 60 * 1000;

/** A tar written as .tar.gz at the compression level of the node's options, without holding the event loop; stopped if the attempt ended. */
async function gzipArchive(tar: Buffer, compressionLevel: unknown, attemptSignal: AbortSignal): Promise<Buffer> {
  const gzipped = await gzipInBlocks(tar, resolveArchiveCompressionLevel(compressionLevel));
  attemptSignal.throwIfAborted();
  return gzipped;
}
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
    inputKeys.map(async (inputKey, index) => {
      attemptSignal.throwIfAborted();
      const stored = await storage.getObject(inputKey);
      if (!stored) {
        throw new Error(`Input artifact "${inputKey}" not found in storage`);
      }
      const transformedBuf = await transformFn(stored.buffer);
      return saveIntermediateNodeOutput(
        storage,
        { graphId, nodeId, index },
        {
          buffer: transformedBuf,
          mimeType: registryMimeType('pdf'),
          filename: stored.filename || path.basename(inputKey),
          fallbackFilename: 'output.pdf',
        }
      );
    })
  );
}

/** A PDF node's result when it is not the input's document under the input's name (a split returns a ZIP). */
interface PdfNodeOutput {
  buffer: Buffer;
  filename: string;
  formatId: string;
}

async function saveIntermediateNodeOutput(
  storage: IStorageBackend,
  location: { graphId: string; nodeId: string; index: number },
  artifact: { buffer: Buffer; mimeType: string; filename: string; fallbackFilename: string }
): Promise<string> {
  const safeName = sanitizeNodeOutputFilename(artifact.filename, artifact.fallbackFilename);
  const outKey = nodeOutputKey('intermediate', location.graphId, location.nodeId, location.index, safeName);
  await storage.saveObject(outKey, artifact.buffer, artifact.mimeType, safeName, INTERMEDIATE_TTL_MS);
  return outKey;
}

async function convertGraphNodeInputs(
  context: {
    graphId: string;
    nodeId: string;
    inputArtifacts: string[];
    storage: IStorageBackend;
    engine: ConversionEnginePort;
    attemptSignal: AbortSignal;
  },
  spec: {
    targetFormat: string;
    options: Parameters<ConversionEnginePort['convert']>[3];
    fallbackFilename: string;
    outputFilenameOverride?: string;
    mimeTypeOverride?: string;
  }
): Promise<string[]> {
  const keys: string[] = [];
  for (const [index, inputKey] of context.inputArtifacts.entries()) {
    context.attemptSignal.throwIfAborted();
    const stored = await context.storage.getObject(inputKey);
    if (!stored) {
      throw new Error(`Input artifact "${inputKey}" not found in storage`);
    }
    const srcExt = artifactExtension(stored.filename, inputKey);
    const safeInputName = sanitizeNodeOutputFilename(stored.filename || path.basename(inputKey), `input.${srcExt}`);
    const convRes = await context.engine.convert(stored.buffer, srcExt, spec.targetFormat, spec.options, safeInputName);
    keys.push(
      await saveIntermediateNodeOutput(
        context.storage,
        { graphId: context.graphId, nodeId: context.nodeId, index },
        {
          buffer: convRes.buffer,
          mimeType: spec.mimeTypeOverride ?? convRes.mimeType,
          filename: spec.outputFilenameOverride ?? convRes.filename,
          fallbackFilename: spec.fallbackFilename,
        }
      )
    );
  }
  return keys;
}

/** Like processIntermediatePdfArtifacts for a node that names its own output file. */
async function processIntermediatePdfParts(
  graphId: string,
  nodeId: string,
  inputKeys: string[],
  storage: IStorageBackend,
  attemptSignal: AbortSignal,
  transformFn: (buf: Buffer, inputFilename: string) => Promise<PdfNodeOutput>
): Promise<string[]> {
  return Promise.all(
    inputKeys.map(async (inputKey, index) => {
      attemptSignal.throwIfAborted();
      const stored = await storage.getObject(inputKey);
      if (!stored) {
        throw new Error(`Input artifact "${inputKey}" not found in storage`);
      }
      const safeInputName = sanitizeNodeOutputFilename(stored.filename || path.basename(inputKey), 'document.pdf');
      const output = await transformFn(stored.buffer, safeInputName);
      return saveIntermediateNodeOutput(
        storage,
        { graphId, nodeId, index },
        {
          buffer: output.buffer,
          mimeType: registryMimeType(output.formatId),
          filename: output.filename,
          fallbackFilename: `output.${output.formatId}`,
        }
      );
    })
  );
}

/** The `pages` a page-selecting PDF node needs; a node without them has nothing to select. */
function requiredPagesOption(options: { pages?: unknown } | undefined, nodeId: string, op: string): string {
  if (typeof options?.pages !== 'string' || options.pages.trim() === '') {
    throw new InvalidPageRangeError(`Node "${nodeId}" (${op}) needs "options.pages", for example "1-3,5".`);
  }
  return options.pages;
}

const DEFAULT_THUMBNAIL_EDGE_PX = 256;
/** Packaging format of a media.package node that names none. */
const DEFAULT_PACKAGING_FORMAT = 'hls';

const COMPOUND_ARCHIVE_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.bz', '.tar.7z', '.tar.lzo'] as const;

/** Extension of a stored artifact; artifacts without one cannot be routed to a converter. */
function artifactExtension(filename: string | undefined, key: string): string {
  const candidate = (filename || key).toLowerCase();
  for (const compound of COMPOUND_ARCHIVE_EXTENSIONS) {
    if (candidate.endsWith(compound)) {
      return compound.slice(1);
    }
  }
  const ext = path.extname(candidate).replace(/^\./, '');
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

/**
 * The password of each merged artifact. `options.passwords` lists one entry per input node of the merge, in the order
 * of `input`; every artifact an input node produced takes that node's entry.
 *
 * @throws PdfPasswordListError (422) when the list does not have one entry per input node, or an artifact belongs to none.
 */
async function mergePasswordsFor(
  graphId: string,
  node: { input?: string | string[]; options?: { passwords?: unknown } },
  artifacts: string[]
): Promise<Array<string | null> | undefined> {
  const passwords = node.options?.passwords;
  if (passwords === undefined) return undefined;
  let inputs: string[] = [];
  if (Array.isArray(node.input)) inputs = node.input;
  else if (node.input) inputs = [node.input];
  if (!Array.isArray(passwords) || passwords.length !== inputs.length) {
    throw new PdfPasswordListError(
      `The merge node lists ${Array.isArray(passwords) ? passwords.length : 'no list of'} passwords for ${inputs.length} input node(s); give one entry per input, in input order, with null for an input that has none.`
    );
  }
  const produced = await Promise.all(inputs.map((inputId) => graphScheduler.getNodeOutputs(graphId, inputId)));
  const ownerByKey = new Map<string, number>();
  for (let i = 0; i < produced.length; i++) {
    for (const outputKey of produced[i]) {
      if (!ownerByKey.has(outputKey)) {
        ownerByKey.set(outputKey, i);
      }
    }
  }
  return artifacts.map((key) => {
    const owner = ownerByKey.get(key);
    if (owner === undefined) throw new PdfPasswordListError('A merged PDF is not an output of any input node, so its password cannot be matched.');
    return passwords[owner] as string | null;
  });
}

/** The password and the rights confirmation a PDF node's options carry. */
function pdfAccessOf(options: { password?: string; confirmEditRights?: boolean } | undefined, signal: AbortSignal): PdfAccess {
  return { password: options?.password, confirmEditRights: options?.confirmEditRights, signal };
}

/** An engine that keeps what each conversion of the node returned, so the node can name the engine it ran on. */
function recordingConversions(engine: ConversionEnginePort): ConversionEnginePort & { conversions: EngineResult[] } {
  const conversions: EngineResult[] = [];
  return {
    name: engine.name,
    conversions,
    convert: async (...args) => {
      const result = await engine.convert(...args);
      conversions.push(result);
      return result;
    },
  };
}

/**
 * What a node's result adds to the common fields: the engine and version the node ran on, when every conversion of it ran on the same (a node
 * over inputs of different formats can use several, and then names none), and what its optimisers did.
 */
function nodeResultExtras(
  conversions: readonly EngineResult[],
  optimizations: NonNullable<ConversionJobResult['optimizations']>
): Pick<ConversionJobResult, 'engine' | 'engineVersion' | 'optimizations'> {
  const first = conversions[0];
  const uniform = first?.engine !== undefined && conversions.every((c) => c.engine === first.engine && c.engineVersion === first.engineVersion);
  return {
    ...(uniform ? { engine: first.engine, ...(first.engineVersion === undefined ? {} : { engineVersion: first.engineVersion }) } : {}),
    ...(optimizations.length > 0 ? { optimizations } : {}),
  };
}

/**
 * The node a job carries, ready to run. Its options come from the request body, so they cannot carry the signal, a
 * timeout or a deadline into an engine; passwords sealed for the queue are opened here, in memory, and never stored back.
 */
function openedNode(submitted: GraphNode, jobId: string): GraphNode {
  if (!('options' in submitted) || !submitted.options) return submitted;
  return { ...submitted, options: openPasswordOption(stripEngineControls(submitted.options), jobId) } as GraphNode;
}

/**
 * Runs the job of a graph node unless the scheduler says the node may not run: a job whose graph has ended or whose node has ended
 * (its cancel never reached the queue, the process that would have sent it died, or it was delivered again after the node
 * completed) does nothing. No input is read, no unit held and no output written for a graph nobody waits for. The answer is the
 * store's, so it holds in a process that did not cancel the job and after one that crashed. Otherwise the node is active in the
 * scheduler, and a retry of the job finds it so. The queue's processor calls this and not `processGraphNodeJob`, which runs the
 * node without asking.
 */
export async function processGraphNodeJobIfAlive(
  job: Job<ConversionJobData, ConversionJobResult>,
  engine?: ConversionEnginePort,
  storage?: IStorageBackend
): Promise<ConversionJobResult> {
  const { graphId, graphNodeId: nodeId } = job.data;
  if (!(await graphScheduler.onNodeStarted(graphId!, nodeId!))) {
    await job.log(`Graph node "${nodeId}" of graph ${graphId} was not run: the graph or the node has already ended`);
    return { jobId: job.id, status: 'completed', resultKey: '', downloadUrl: '', filename: '', mimeType: '', size: 0, durationMs: 0 };
  }
  return processGraphNodeJob(job, engine, storage);
}

export async function processGraphNodeJob(
  job: Job<ConversionJobData, ConversionJobResult>,
  engine?: ConversionEnginePort,
  storage?: IStorageBackend,
  optimizers: OptimizerRegistry = OPTIMIZERS
): Promise<ConversionJobResult> {
  const startTime = Date.now();
  const attemptSignal = job.signal;
  const graphId = job.data.graphId!;
  const nodeId = job.data.graphNodeId!;
  let scope: ReturnType<typeof scopeStorageObjects> | undefined;

  // Everything the node does, from opening its options on, runs inside this try, so whatever ends the attempt reaches the
  // scheduler through the catch; the job listeners report the ends that never reach it (a stalled or cancelled job).
  try {
    // Scratch files a remote backend stages for this node's inputs are removed when the node ends.
    scope = scopeStorageObjects(storage || storageProvider);
    const node = openedNode(job.data.graphNode as GraphNode, graphNodeJobId(graphId, nodeId));
    const effectiveStorage: IStorageBackend = scope.storage;
    let outputKeys: string[] = [];
    const optimizations: NonNullable<ConversionJobResult['optimizations']> = [];
    const effectiveEngine = recordingConversions(deadlineBoundEngine(engine || dispatchEngine, job));
    await job.log(`Executing graph node "${nodeId}" (op: ${node.op}) in graph ${graphId}`);
    await job.updateProgress(10);
    attemptSignal.throwIfAborted();
    const inputArtifacts = await resolveInputArtifacts(graphId, node, job.data.inputArtifacts);
    await holdUnitsForInputs(graphId, nodeId, node, inputArtifacts.length);

    switch (node.op) {
      case 'import.upload': {
        outputKeys = [await heldGraphInput(graphId, node.storageKey)];
        await job.log(`Node "${nodeId}" imported uploaded key: ${node.storageKey}`);
        break;
      }

      case 'import.url': {
        // Secrets are opened here, at the point of use, and never stored back anywhere.
        const { url, headers } = openUrlNodeSecrets(node, graphNodeJobId(graphId, nodeId));
        outputKeys = [await importUrlWithinBudget(job, effectiveStorage, url, headers)];
        await job.log(`Node "${nodeId}" imported from URL: ${outputKeys[0]}`);
        break;
      }

      case 'import.s3':
      case 'import.sftp': {
        outputKeys = await importFromCustomerStorage(job, effectiveStorage, node, graphNodeJobId(graphId, nodeId));
        break;
      }

      case 'convert': {
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }

        outputKeys.push(
          ...(await convertGraphNodeInputs(
            { graphId, nodeId, inputArtifacts, storage: effectiveStorage, engine: effectiveEngine, attemptSignal },
            { targetFormat: node.targetFormat, options: node.options || {}, fallbackFilename: `output.${node.targetFormat}` }
          ))
        );
        await job.log(`Node "${nodeId}" converted ${inputArtifacts.length} artifact(s) to ${node.targetFormat}`);
        break;
      }

      case 'ocr': {
        outputKeys.push(
          ...(await convertGraphNodeInputs(
            { graphId, nodeId, inputArtifacts, storage: effectiveStorage, engine: effectiveEngine, attemptSignal },
            { targetFormat: 'pdf', options: { ...(node.options || {}), ocrEnabled: true }, fallbackFilename: 'ocr.pdf' }
          ))
        );
        break;
      }

      case 'optimize': {
        for (const [index, inputKey] of inputArtifacts.entries()) {
          attemptSignal.throwIfAborted();
          const stored = await effectiveStorage.getObject(inputKey);
          if (!stored) {
            throw new Error(`Input artifact "${inputKey}" not found in storage`);
          }
          const srcExt = artifactExtension(stored.filename, inputKey);
          const optimizer = getOptimizer(srcExt, optimizers);
          const deadlineAt = jobDeadlineAt(job);
          const optRes = await raceAbort(
            optimizer(stored.buffer, node.options || {}, {
              signal: attemptSignal,
              remainingMs: remainingJobMs({ [JOB_DEADLINE_AT]: deadlineAt }),
            }),
            attemptSignal
          ); // NOSONAR S9382 sequential: one artifact in memory at a time
          // An output that is not smaller is not an optimisation: the input is kept and said to be unchanged.
          const gained = optRes.optimized && optRes.buffer.length < stored.buffer.length;
          const outBuffer = gained ? optRes.buffer : stored.buffer;
          const outFilename = sanitizeNodeOutputFilename(stored.filename || path.basename(inputKey), `optimized.${srcExt}`);
          const outKey = nodeOutputKey('intermediate', graphId, nodeId, index, outFilename);
          await effectiveStorage.saveObject(outKey, outBuffer, stored.mimeType, outFilename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
          optimizations.push({ key: outKey, optimized: gained, inputBytes: stored.buffer.length, outputBytes: optRes.buffer.length });
          await job.log(
            gained
              ? `Node "${nodeId}" optimized "${outFilename}" from ${stored.buffer.length} to ${optRes.buffer.length} bytes`
              : `Node "${nodeId}" kept "${outFilename}" unchanged: the optimiser produced ${optRes.buffer.length} bytes from ${stored.buffer.length} and did not make it smaller`
          );
        }
        break;
      }

      case 'thumbnail': {
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const targetFormat = requireTargetFormat(node, nodeId);
        if (!THUMBNAIL_FORMATS.has(targetFormat)) {
          throw new ConversionFailedError(`Thumbnail node "${nodeId}" cannot produce "${targetFormat}"`);
        }
        const width = node.options?.thumbnail?.width ?? DEFAULT_THUMBNAIL_EDGE_PX;
        const height = node.options?.thumbnail?.height ?? DEFAULT_THUMBNAIL_EDGE_PX;
        outputKeys.push(
          ...(await convertGraphNodeInputs(
            { graphId, nodeId, inputArtifacts, storage: effectiveStorage, engine: effectiveEngine, attemptSignal },
            {
              targetFormat,
              options: {
                ...(node.options || {}),
                thumbnail: undefined,
                width,
                height,
                fit: 'inside',
              },
              outputFilenameOverride: `thumbnail.${targetFormat}`,
              fallbackFilename: `thumbnail.${targetFormat}`,
            }
          ))
        );
        break;
      }

      case 'media.package': {
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const packaging: MediaPackagingOptions = node.options?.packaging ?? { format: DEFAULT_PACKAGING_FORMAT };
        outputKeys.push(
          ...(await convertGraphNodeInputs(
            { graphId, nodeId, inputArtifacts, storage: effectiveStorage, engine: effectiveEngine, attemptSignal },
            {
              targetFormat: packaging.format,
              options: { ...(node.options || {}), packaging },
              fallbackFilename: `package.${MEDIA_PACKAGE_OUTPUT_FORMAT}`,
              mimeTypeOverride: registryMimeType(MEDIA_PACKAGE_OUTPUT_FORMAT),
            }
          ))
        );
        await job.log(`Node "${nodeId}" packaged ${inputArtifacts.length} artifact(s) as ${packaging.format}`);
        break;
      }

      case 'watermark':
      case 'pdf.watermark': {
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
          (buf) => applyPdfWatermark(buf, watermarkOpts, pdfAccessOf(node.options, attemptSignal))
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" applied watermark to ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'pdf.protect': {
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
          (buf) => protectPdf(buf, protectOpts, pdfAccessOf(node.options, attemptSignal))
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" applied protection to ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'pdf.unlock': {
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const processedKeys = await processIntermediatePdfArtifacts(
          graphId,
          nodeId,
          inputArtifacts,
          effectiveStorage,
          attemptSignal,
          (buf) => unlockPdf(buf, pdfAccessOf(node.options, attemptSignal))
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" unlocked ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'pdf.split-pages': {
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const processedKeys = await processIntermediatePdfParts(
          graphId,
          nodeId,
          inputArtifacts,
          effectiveStorage,
          attemptSignal,
          async (buf, inputFilename) => {
            const baseName = path.basename(inputFilename, path.extname(inputFilename));
            return {
              buffer: await splitPdfPages(buf, node.options?.split, pdfAccessOf(node.options, attemptSignal), baseName),
              filename: `${baseName}-split.${PDF_SPLIT_OUTPUT_FORMAT}`,
              formatId: PDF_SPLIT_OUTPUT_FORMAT,
            };
          }
        );
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" split ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'pdf.extract-pages':
      case 'pdf.delete-pages':
      case 'pdf.reorder-pages':
      case 'pdf.rotate-pages': {
        if (inputArtifacts.length === 0) {
          throw new Error(`Node "${nodeId}" has no input artifacts from upstream`);
        }
        const access = pdfAccessOf(node.options, attemptSignal);
        const options = node.options;
        const edit = (buf: Buffer): Promise<Buffer> => {
          switch (node.op) {
            case 'pdf.extract-pages':
              return extractPdfPages(buf, requiredPagesOption(options, nodeId, node.op), access);
            case 'pdf.delete-pages':
              return deletePdfPages(buf, requiredPagesOption(options, nodeId, node.op), access);
            case 'pdf.reorder-pages':
              return reorderPdfPages(buf, options?.reorder as never, access);
            default:
              return rotatePdfPages(buf, options?.rotate as never, access);
          }
        };
        const processedKeys = await processIntermediatePdfArtifacts(graphId, nodeId, inputArtifacts, effectiveStorage, attemptSignal, edit);
        outputKeys.push(...processedKeys);
        await job.log(`Node "${nodeId}" applied ${node.op} to ${inputArtifacts.length} artifact(s)`);
        break;
      }

      case 'merge': {
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
            passwords: await mergePasswordsFor(graphId, node, inputArtifacts),
            confirmEditRights: node.options?.confirmEditRights, signal: attemptSignal,
          });
          const outFilename = 'merged.pdf';
          const outKey = nodeOutputKey('intermediate', graphId, nodeId, 0, outFilename);
          await effectiveStorage.saveObject(outKey, mergedBuf, registryMimeType('pdf'), outFilename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        } else {
          const mergedBuf = Buffer.from(inputs.map((stored) => stored.buffer.toString('utf-8')).join('\n\n'), 'utf-8');
          const outFilename = `merged.${targetFmt}`;
          const outKey = nodeOutputKey('intermediate', graphId, nodeId, 0, outFilename);
          await effectiveStorage.saveObject(outKey, mergedBuf, registryMimeType(targetFmt), outFilename, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }
        break;
      }

      case 'metadata': {
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
        const outKey = nodeOutputKey('intermediate', graphId, nodeId, 0, outFilename);
        await effectiveStorage.saveObject(outKey, jsonBuf, registryMimeType('json'), outFilename, INTERMEDIATE_TTL_MS);
        outputKeys.push(outKey);
        break;
      }

      case 'archive.create': {
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
          archiveBuf = targetFmt === 'tar.gz' ? await gzipArchive(tarRes.buffer, node.options?.compressionLevel, attemptSignal) : tarRes.buffer;
        } else if (targetFmt === '7z') {
          const sevenZipRes = await create7zArchiveAsync(filesToArchive, node.options || {}, `bundle.7z`, { signal: attemptSignal });
          archiveBuf = sevenZipRes.buffer;
        } else {
          throw new ConversionFailedError(
            `archive.create node "${nodeId}" cannot produce "${targetFmt}"; supported: ${[...ARCHIVE_CREATE_FORMATS].join(', ')}`
          );
        }

        const outKey = nodeOutputKey('intermediate', graphId, nodeId, 0, `bundle.${targetFmt}`);
        await effectiveStorage.saveObject(outKey, archiveBuf, registryMimeType(targetFmt), `bundle.${targetFmt}`, INTERMEDIATE_TTL_MS);
        outputKeys = [outKey];
        await job.log(`Created archive with ${filesToArchive.length} file(s): ${outKey}`);
        break;
      }

      case 'archive.extract': {
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

        const extracted = await extractGraphArchiveEntries(effectiveFilename, archiveBuffer, node.entries, undefined, archiveExtractOptionsOf(node, attemptSignal));

        for (const [index, f] of extracted.entries()) {
          const entryName = sanitizeNodeOutputFilename(f.filename, `extracted_${index}.bin`);
          const outKey = nodeOutputKey('intermediate', graphId, nodeId, index, entryName);
          await effectiveStorage.saveObject(outKey, f.buffer, archiveEntryMimeType(entryName), entryName, INTERMEDIATE_TTL_MS);
          outputKeys.push(outKey);
        }

        await job.log(`Extracted ${outputKeys.length} artifact(s) from archive`);
        break;
      }

      case 'export.url': {
        outputKeys = await exportNodeToUrl(effectiveStorage, node, { graphId, nodeId, inputArtifacts, signal: attemptSignal });
        break;
      }

      case 'export.s3':
      case 'export.sftp': {
        outputKeys = await exportToCustomerStorage(job, effectiveStorage, node, inputArtifacts, graphNodeJobId(graphId, nodeId));
        break;
      }

      case 'export.internal': {
        outputKeys = await promoteResults(effectiveStorage, { graphId, nodeId, inputArtifacts, signal: attemptSignal });
        await job.log(`Promoted ${outputKeys.length} result(s) for download`);
        break;
      }

      default: {
        throw new Error(`Unsupported graph node operation: ${(node as { op: string }).op}`);
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
    const outputs = [...new Set(outputKeys)];
    await graphScheduler.onNodeCompleted(graphId, nodeId, outputs, graphNodeCharge(node.op, { outputs: outputs.length, optimizations }));

    return {
      jobId: job.id,
      status: 'completed',
      resultKey: primaryKey,
      downloadUrl: primaryKey ? `/api/storage/file/${encodeURIComponent(primaryKey)}` : '',
      filename: path.basename(primaryKey),
      mimeType: primaryOutput.mimeType,
      size: primaryOutput.size,
      durationMs,
      ...nodeResultExtras(effectiveEngine.conversions, optimizations),
    };
  } catch (err: any) {
    // A retry may still succeed, and a cancelled attempt is not a failure: only the last failed attempt fails the node
    // (and, under fail_fast, the graph). A failure that cannot be retried is the last one.
    // A deadline aborts the signal too, but it is a failure of the node: the graph must settle (fail_fast fails it,
    // continue skips what depends on the node). Only a cancel or a takeover leaves the node to its own path.
    const pastDeadline = attemptSignal.reason instanceof JobTimeoutError;
    const failure: unknown = pastDeadline ? attemptSignal.reason : err;
    // Whatever an SDK, a remote or an engine quoted into the error, it leaves this node run masked.
    const reason = maskFailure(failure);
    if ((!attemptSignal.aborted || pastDeadline) && isFinalFailure({ attemptsMade: job.attemptsMade, opts: { attempts: job.opts?.attempts ?? 1 } }, failure)) {
      await graphScheduler.onNodeFailed(graphId, nodeId, reason, ...refusalCodeList(failure));
    }
    throw failure;
  } finally {
    await scope?.releaseAll();
  }
}

/** An export.url node: each input sent to its destination, which is opened here from the node's sealed secrets; the inputs it handed on. */
async function exportNodeToUrl(
  storage: IStorageBackend,
  node: ExportUrlNode,
  run: { graphId: string; nodeId: string; inputArtifacts: string[]; signal: AbortSignal }
): Promise<string[]> {
  const destination = openUrlNodeSecrets(node, graphNodeJobId(run.graphId, run.nodeId));
  for (const inputKey of run.inputArtifacts) {
    run.signal.throwIfAborted();
    await exportArtifactToUrl(storage, inputKey, destination.url, node.method || 'PUT', destination.headers, run.signal);
  }
  return run.inputArtifacts;
}

/** An export.internal node's inputs kept as results for download: each stored file copied under `results/<graphId>/`; the keys it made. */
async function promoteResults(
  storage: IStorageBackend,
  node: { graphId: string; nodeId: string; inputArtifacts: string[]; signal: AbortSignal }
): Promise<string[]> {
  const keys: string[] = [];
  for (const [index, inputKey] of node.inputArtifacts.entries()) {
    node.signal.throwIfAborted();
    const stored = await storage.getObject(inputKey);
    if (!stored) continue;

    const safeFilename = sanitizeNodeOutputFilename(stored.filename || path.basename(inputKey), `export_${index}.bin`);
    const promotedKey = nodeOutputKey('results', node.graphId, node.nodeId, index, safeFilename);
    await saveRetainedResult(storage, promotedKey, stored.buffer, stored.mimeType, safeFilename);
    keys.push(promotedKey);
  }
  return keys;
}

/** `work`, or the abort reason as soon as `signal` fires, so an optimiser that ignores the signal cannot hold the job past its deadline. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Headers the worker sets itself from the stored artifact; a customer-supplied copy would misdescribe the body. */
const EXPORT_FRAMING_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-length']);

function withoutFramingHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !EXPORT_FRAMING_HEADERS.has(name.toLowerCase())));
}

/**
 * Streams one stored artifact to the destination URL and fails unless it answers 2xx. The destination is checked before
 * the artifact is opened, and the artifact is closed whatever the request does. A redirect is not followed: the body is
 * a stream that cannot be sent again, so `safeFetch` refuses it with `OutboundRequestBlockedError`.
 */
export async function exportArtifactToUrl(
  storage: IStorageBackend,
  inputKey: string,
  url: string,
  method: string,
  customerHeaders: Record<string, string> | undefined,
  signal: AbortSignal
): Promise<void> {
  const stat = await storage.stat(inputKey);
  if (!stat) {
    throw new GraphExportError(`Input artifact "${inputKey}" not found in storage`);
  }
  await assertPublicOutboundUrl(url);
  const stream = await storage.openReadStream(inputKey);
  if (!stream) {
    throw new GraphExportError(`Input artifact "${inputKey}" not found in storage`);
  }
  const body = Readable.from(stream);
  try {
    const response = await safeFetch(url, {
      method,
      body,
      duplex: 'half',
      headers: {
        ...withoutFramingHeaders(customerHeaders),
        'Content-Type': stat.mimeType || 'application/octet-stream',
        'Content-Length': String(stat.size),
      },
      signal,
    });
    await response.body?.cancel?.().catch(() => undefined);
    if (!response.ok) {
      throw new GraphExportError(
        `Export of "${inputKey}" failed: destination answered HTTP ${response.status}`,
        response.status
      );
    }
  } finally {
    body.destroy();
    (stream as { destroy?: () => void }).destroy?.();
  }
}

/** The input files of `node`: those its job carries, else the outputs of the nodes it names; none for a node that names none. */
async function resolveInputArtifacts(graphId: string, node: GraphNode, providedArtifacts?: string[]): Promise<string[]> {
  if (providedArtifacts && providedArtifacts.length > 0) {
    return providedArtifacts;
  }
  if (!('input' in node) || !node.input) return [];
  return graphScheduler.getNodeOutputs(graphId, node.input);
}

export interface GraphArchiveExtractOptions {
  password?: string;
  skipLinks?: boolean;
  collisionPolicy?: 'error' | 'overwrite' | 'rename';
  entries?: string[];
  signal?: AbortSignal;
}

function archiveExtractOptionsOf(
  node: { entries?: string[]; options?: GraphArchiveExtractOptions },
  signal: AbortSignal
): GraphArchiveExtractOptions {
  return {
    ...node.options,
    entries: node.entries ?? node.options?.entries,
    signal,
  };
}

function finalizeDecompressedArchive(
  uncompressed: Buffer,
  compressedSize: number,
  effectiveLimits: ArchiveExtractionLimits,
  target: { forceTar: boolean; effectiveFilename: string; suffixPattern: RegExp },
  resolvedOptions: GraphArchiveExtractOptions & { limits?: ArchiveExtractionLimits }
): Promise<{ filename: string; buffer: Buffer }[]> | { filename: string; buffer: Buffer }[] {
  if (uncompressed.length > effectiveLimits.MAX_UNCOMPRESSED_SIZE) {
    throw new DecompressionLimitError(
      `Archive bomb detected: uncompressed size exceeds limit of ${effectiveLimits.MAX_UNCOMPRESSED_SIZE} bytes`
    );
  }
  if (exceedsArchiveRatio(uncompressed.length, compressedSize, effectiveLimits.MAX_RATIO)) {
    throw new DecompressionLimitError(
      `Archive bomb detected: compression ratio exceeds ${effectiveLimits.MAX_RATIO}:1 limit`
    );
  }
  if (target.forceTar || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
    return extractTarArchive(uncompressed, resolvedOptions);
  }
  const stem = path.basename(target.effectiveFilename).replace(target.suffixPattern, '') || 'decompressed.bin';
  return [{ filename: stem, buffer: uncompressed }];
}

export async function extractGraphArchiveEntries(
  effectiveFilename: string,
  archiveBuffer: Buffer,
  entriesOrOptions?: string[] | GraphArchiveExtractOptions,
  limits?: ArchiveExtractionLimits,
  options?: GraphArchiveExtractOptions
): Promise<{ filename: string; buffer: Buffer }[]> {
  const inlineOptions = entriesOrOptions && !Array.isArray(entriesOrOptions) ? entriesOrOptions : options;
  const entries = Array.isArray(entriesOrOptions) ? entriesOrOptions : inlineOptions?.entries;
  const resolvedOptions = { ...inlineOptions, entries, limits };
  const effectiveLimits = limits ?? ARCHIVE_SECURITY_LIMITS;
  const ext = artifactExtension(effectiveFilename, effectiveFilename);
  if (ext === 'tar' || ext === 'tar.gz' || ext === 'tgz' || ext === 'gz') {
    const uncompressed = ext === 'tar' ? archiveBuffer : await gunzipStreamingWithLimits(archiveBuffer, limits);
    if (ext === 'gz' && uncompressed.subarray(257, 262).toString('ascii') !== 'ustar') {
      const stem = path.basename(effectiveFilename).replace(/\.gz$/i, '') || 'decompressed.bin';
      return [{ filename: stem, buffer: uncompressed }];
    }
    return extractTarArchive(uncompressed, resolvedOptions);
  }
  if (isWrapperSource(ext)) {
    const unpacked = unpackWrapperSource(ext, archiveBuffer, effectiveLimits);
    if (unpacked.isTar) return extractTarArchive(unpacked.payload, resolvedOptions);
    const stem = path.basename(effectiveFilename).replace(/\.(?:bz2|bz|lz|lzo)$/i, '') || 'decompressed.bin';
    return [{ filename: stem, buffer: unpacked.payload }];
  }
  if (ext === 'tar.xz' || ext === 'txz' || ext === 'xz') {
    const uncompressed = await decompressXz(archiveBuffer, resolvedOptions);
    return finalizeDecompressedArchive(uncompressed, archiveBuffer.length, effectiveLimits, { forceTar: ext !== 'xz', effectiveFilename, suffixPattern: /\.xz$/i }, resolvedOptions);
  }
  if (ext === 'tar.zst' || ext === 'tzst' || ext === 'zst' || ext === 'zstd') {
    const uncompressed = await decompressZstdNative(archiveBuffer, {
      signal: resolvedOptions.signal,
      maxOutputBytes: effectiveLimits.MAX_UNCOMPRESSED_SIZE,
    });
    return finalizeDecompressedArchive(uncompressed, archiveBuffer.length, effectiveLimits, { forceTar: ext === 'tar.zst' || ext === 'tzst', effectiveFilename, suffixPattern: /\.(?:zst|zstd)$/i }, resolvedOptions);
  }
  if (ext === '7z' || ext === 'tar.7z') {
    const extracted = await extract7zArchiveAsync(archiveBuffer, resolvedOptions);
    if (ext === 'tar.7z' && extracted.length === 1 && extracted[0].buffer.subarray(257, 262).toString('ascii') === 'ustar') {
      return extractTarArchive(extracted[0].buffer, resolvedOptions);
    }
    return extracted;
  }
  if (ext === 'rar') return extractRarArchive(archiveBuffer, resolvedOptions);
  return extractZipArchive(archiveBuffer, resolvedOptions);
}
