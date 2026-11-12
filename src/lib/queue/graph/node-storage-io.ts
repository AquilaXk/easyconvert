import path from 'node:path';
import { Readable } from 'node:stream';
import type { Job } from '../bullmq-engine';
import type { IStorageBackend } from '../../storage/oci-storage';
import { ConversionFailedError, ImportBudgetExceededError, type ConversionJobData, type ConversionJobResult } from '../../types';
import { detectFormatFromFilename } from '../../registry';
import {
  budgetRefusalDetail,
  dailyLimitReachedDetail,
  largerThanLeftDetail,
  withLinkImportMeter,
  type LinkImportMeter,
} from '../../api-keys/anonymous-upload-budget';
import { maxFileBytes, planOfCaller, type Plan } from '../../plan-limits';
import { credentialsVault, type CustomerStorageCredentials } from '../../storage/credentials-vault';
import { createStorageAdapter } from '../../storage/adapters';
import { S3StorageAdapter } from '../../storage/adapters/s3';
import { SftpStorageAdapter } from '../../storage/adapters/sftp';
import { StorageNotFoundError, StorageSizeLimitError } from '../../storage/adapters/adapter-interface';
import {
  StorageCredentialNotFoundError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  StorageUnavailableError,
  customerStorageFailure,
} from '../../storage/customer-storage-errors';
import { DEFAULT_STORAGE_IMPORT_OBJECTS, MAX_STORAGE_IMPORT_OBJECTS } from '../../storage/customer-storage-limits';
import { exportDestination, exportedFileNames } from '../../jobs/storage-export-names';
import { joinRemotePath } from '../../storage/customer-storage-paths';
import { listS3Files } from '../../storage/s3-customer-listing';
import { tierForOwner } from '../enqueue';
import { tierMaxDeadlineMs } from '../job-deadline';
import { INTERMEDIATE_TTL_MS, meterStream } from './node-url-import';
import { nodeOutputKey, sanitizeNodeOutputFilename } from './node-jobs';
import { openStorageNodeCredentials } from './sealed-nodes';
import type { ExportS3Node, ExportSftpNode, ImportS3Node, ImportSftpNode } from './types';

/**
 * The nodes that read from and write to the customer's own store: `import.s3` and `export.s3` (any S3-compatible endpoint, over
 * the SigV4 client with the connection pinned to a public address) and `import.sftp` and `export.sftp` (the OpenSSH client, which is
 * told the one address that passed the check). Credentials come from a saved credential of the graph's owner or, sealed with the
 * node, from the request; they are opened here, in memory, and never stored back, logged or returned. A transient failure is tried
 * again with a jittered, doubling wait; a verdict on the customer's settings (credentials, endpoint, name, size) is final.
 */

type StorageKind = 's3' | 'sftp';
type StorageNode = ImportS3Node | ImportSftpNode | ExportS3Node | ExportSftpNode;
type StorageJob = Job<ConversionJobData, ConversionJobResult>;

/** Tries of one file's transfer, and the wait before the second (doubling, jittered, at most `RETRY_MAX_DELAY_MS`). */
const TRANSFER_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;

/** The files of the customer's store a node reads or writes, whichever protocol it speaks. */
interface CustomerStore {
  /** The files of a prefix or directory by remote path, at most `max`; more throws `StorageListingLimitError`. */
  list(listed: string, max: number): Promise<Array<{ path: string; size: number }>>;
  size(remotePath: string): Promise<number>;
  /** `maxBytes` is the most an adapter that stages the file before streaming it may stage. */
  download(remotePath: string, options: { maxBytes: number }): Promise<NodeJS.ReadableStream>;
  upload(remotePath: string, body: NodeJS.ReadableStream, meta: { contentType: string; size: number }): Promise<{ size: number; etag?: string }>;
}

function s3Store(adapter: S3StorageAdapter): CustomerStore {
  return {
    list: async (prefix, max) => (await listS3Files(adapter, prefix, max)).map((file) => ({ path: file.key, size: file.size })),
    size: async (key) => {
      const head = await adapter.head(key);
      if (!head) throw new StorageNotFoundError(key, 's3');
      return head.size;
    },
    download: (key) => adapter.downloadStream(key),
    upload: (key, body, meta) => adapter.uploadStream(key, body, meta),
  };
}

function sftpStore(adapter: SftpStorageAdapter): CustomerStore {
  return {
    list: async (directory, max) => (await adapter.listDirectory(directory, max)).map((file) => ({ path: joinRemotePath(directory, file.name), size: file.size })),
    size: async (remotePath) => {
      const head = await adapter.head(remotePath);
      if (!head) throw new StorageNotFoundError(remotePath, 'sftp');
      return head.size;
    },
    download: (remotePath, options) => adapter.downloadStream(remotePath, options),
    upload: (remotePath, body, meta) => adapter.uploadStream(remotePath, body, meta),
  };
}

const KIND_OF_OPERATION: Readonly<Record<StorageNode['op'], StorageKind>> = {
  'import.s3': 's3',
  'export.s3': 's3',
  'import.sftp': 'sftp',
  'export.sftp': 'sftp',
};

/**
 * The credentials of a node: the inline ones opened from its sealed blob, or the saved credential it names, which only its owner
 * may use. The credential must be of the node's own kind. A reference that is unknown, expired, another account's or of another kind
 * is one failure, so a caller learns nothing about credentials that are not theirs.
 */
async function resolveCredentials(node: StorageNode, jobId: string, owner: string | undefined): Promise<CustomerStorageCredentials> {
  const kind = KIND_OF_OPERATION[node.op];
  const inline = openStorageNodeCredentials(node, jobId);
  if (inline) return { ...inline, type: kind } as unknown as CustomerStorageCredentials;
  const notFound = () => new StorageCredentialNotFoundError(`The saved credential of node "${node.op}" was not found, has expired, or is not a ${kind} credential of this account.`);
  if (!node.credentialRef || !owner) throw notFound();
  const saved = await credentialsVault.get(node.credentialRef, owner);
  if (!saved || saved.type !== kind) throw notFound();
  return saved;
}

async function openStore(node: StorageNode, jobId: string, owner: string | undefined): Promise<CustomerStore> {
  const credentials = await resolveCredentials(node, jobId, owner);
  try {
    const adapter = createStorageAdapter(credentials);
    return adapter instanceof S3StorageAdapter ? s3Store(adapter) : sftpStore(adapter as SftpStorageAdapter);
  } catch (err) {
    throw customerStorageFailure(err);
  }
}

function retryDelayMs(attempt: number): number {
  return Math.floor(Math.random() * Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)) + 1);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `run` as the typed failure of the store; a transient one is run again, from the start, up to TRANSFER_ATTEMPTS times. */
async function withTransientRetry<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const failure = customerStorageFailure(err);
      if (!(failure instanceof StorageUnavailableError && failure.retryable) || attempt >= TRANSFER_ATTEMPTS) throw failure;
      await wait(retryDelayMs(attempt), signal);
    }
  }
}

function importLimit(node: ImportS3Node | ImportSftpNode): number {
  return Math.min(node.maxObjects ?? DEFAULT_STORAGE_IMPORT_OBJECTS, MAX_STORAGE_IMPORT_OBJECTS);
}

interface RemoteFile {
  path: string;
  size: number;
  /** The name of the stored file: the base name of a single file, the path under the prefix or directory (with `_` for `/`) of a listed one. */
  name: string;
}

/** The files an import node names: its one file, or the files under its prefix or directory (an empty one is a failure). */
async function filesToImport(node: ImportS3Node | ImportSftpNode, store: CustomerStore, signal: AbortSignal): Promise<RemoteFile[]> {
  const single = node.op === 'import.s3' ? node.key : node.path;
  if (single !== undefined) {
    const size = await withTransientRetry(signal, () => store.size(single));
    return [{ path: single, size, name: path.posix.basename(single) }];
  }
  const listed = (node.op === 'import.s3' ? node.prefix : node.directory) ?? '';
  const found = await withTransientRetry(signal, () => store.list(listed, importLimit(node)));
  if (found.length === 0) throw new StorageObjectNotFoundError(`No file was found ${node.op === 'import.s3' ? 'under the prefix' : 'in the folder'} the node names.`);
  const root = listed === '' || listed.endsWith('/') ? listed : `${listed}/`;
  return found.map((file) => {
    const relative = file.path.startsWith(root) ? file.path.slice(root.length) : file.path;
    return { ...file, name: (relative || path.posix.basename(file.path)).replaceAll('/', '_') };
  });
}

type ImportBudget = { owner: string; plan: Plan; limitBytes: number; deadlineMs: number };

/** The failure of a download the store itself stopped at `cap` bytes: the plan's file limit, or what the owner's day has left when that is less. */
function capReached(cap: number, budget: ImportBudget): Error {
  return cap < budget.limitBytes
    ? new ImportBudgetExceededError(dailyLimitReachedDetail(budget.plan))
    : new StorageObjectTooLargeError(`A file in the store passed the ${budget.limitBytes}-byte file limit of the plan while it was fetched.`);
}

/** What stopped a source stream, as a failure of the store: an adapter error is typed by `customerStorageFailure`, any other (a reset socket) is the store not answering. */
function sourceFailure(err: unknown): unknown {
  const typed = customerStorageFailure(err);
  return typed instanceof Error && !(typed instanceof ConversionFailedError) ? new StorageUnavailableError(typed.message, true) : typed;
}

/**
 * One try at one file under its own meter, so that the plan's file limit is judged on the bytes of this try and the bytes of every
 * try are still charged to the owner's day. An adapter that stages the file first (SFTP) is told the most it may stage, the smaller of
 * the file limit and what the day has left, so a server that lists a few bytes and serves gigabytes fills nothing past that.
 */
async function importAttempt(
  storage: IStorageBackend,
  file: RemoteFile,
  store: CustomerStore,
  target: { key: string; filename: string; mimeType: string },
  budget: ImportBudget,
  meter: LinkImportMeter
): Promise<void> {
  const overflow = meter.declared(file.size);
  if (overflow) {
    throw overflow.kind === 'too-large'
      ? new StorageObjectTooLargeError(`A file in the store is ${file.size} bytes, above the ${budget.limitBytes}-byte file limit of the plan.`)
      : new ImportBudgetExceededError(largerThanLeftDetail(overflow.leftBytes));
  }
  const cap = Math.min(budget.limitBytes, meter.leftBytes);
  let downloaded: NodeJS.ReadableStream;
  try {
    downloaded = await store.download(file.path, { maxBytes: cap });
  } catch (err) {
    if (!(err instanceof StorageSizeLimitError)) throw err;
    await meter.count(cap);
    throw capReached(cap, budget);
  }
  const source = downloaded instanceof Readable ? downloaded : Readable.from(downloaded);
  let sourceError: unknown;
  source.once('error', (err) => {
    sourceError = err;
  });
  const { stream, stopReason } = meterStream(source, meter, (verdict) =>
    verdict === 'too-large'
      ? new StorageObjectTooLargeError(`A file in the store passed the ${budget.limitBytes}-byte file limit of the plan while it was read.`)
      : new ImportBudgetExceededError(dailyLimitReachedDetail(budget.plan))
  );
  try {
    await storage.saveObjectFromStream(target.key, stream, { filename: target.filename, mimeType: target.mimeType }, INTERMEDIATE_TTL_MS);
  } catch (err) {
    // the storage backend wraps the error of the stream it consumed in its own: what stopped the stream is what failed the file
    throw stopReason() ?? (sourceError === undefined ? err : sourceFailure(sourceError));
  }
}

/** One file read into intermediate storage under the owner's daily budget and the plan's file limit; each try is metered alone, and the bytes of a failed try are charged. */
async function importFile(
  storage: IStorageBackend,
  file: RemoteFile,
  store: CustomerStore,
  target: { key: string; filename: string },
  budget: ImportBudget,
  signal: AbortSignal
): Promise<void> {
  const mimeType = detectFormatFromFilename(target.filename)?.mimeType ?? 'application/octet-stream';
  await withTransientRetry(signal, async () => {
    const imported = await withLinkImportMeter(budget, (meter) => importAttempt(storage, file, store, { ...target, mimeType }, budget, meter));
    if ('refusal' in imported) throw new ImportBudgetExceededError(budgetRefusalDetail(imported.refusal, budget.plan));
  });
}

/**
 * Runs an `import.s3` or `import.sftp` node: the file it names, or at most `maxObjects` files of its prefix or directory (more is
 * refused, never cut short), each streamed into the graph's intermediate storage. Returns the stored keys in remote order.
 */
export async function importFromCustomerStorage(
  job: StorageJob,
  storage: IStorageBackend,
  node: ImportS3Node | ImportSftpNode,
  jobId: string
): Promise<string[]> {
  const { graphId, graphNodeId: nodeId, userId: owner } = job.data;
  if (!graphId || !nodeId || !owner) {
    throw new ConversionFailedError(`Import node "${nodeId}" has no owner, so its bytes cannot be charged to a daily budget.`);
  }
  const signal = job.signal;
  const store = await openStore(node, jobId, owner);
  const files = await filesToImport(node, store, signal);
  const tier = await tierForOwner(owner);
  const plan = planOfCaller({ id: owner, tier });
  const budget = { owner, plan, limitBytes: maxFileBytes(plan), deadlineMs: job.opts.timeout ?? tierMaxDeadlineMs(tier) };
  const keys: string[] = [];
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    const filename = sanitizeNodeOutputFilename(file.name, `${nodeId}-${index}.bin`);
    const key = nodeOutputKey('intermediate', graphId, nodeId, index, filename);
    await importFile(storage, file, store, { key, filename }, budget, signal);
    keys.push(key);
  }
  await job.log(`Node "${nodeId}" imported ${keys.length} file(s) from the customer's ${KIND_OF_OPERATION[node.op]} store`);
  return keys;
}

/**
 * Runs an `export.s3` or `export.sftp` node: each input is written under the node's prefix or directory by its file name, with
 * its content type, overwriting a file of that name. A file that cannot be written fails the node after its tries; the files
 * written before it stay, and each file's outcome is in the job log. Returns the inputs, which the node hands on unchanged.
 */
export async function exportToCustomerStorage(
  job: StorageJob,
  storage: IStorageBackend,
  node: ExportS3Node | ExportSftpNode,
  inputKeys: string[],
  jobId: string
): Promise<string[]> {
  const signal = job.signal;
  const store = await openStore(node, jobId, job.data.userId);
  const stats = [];
  for (const inputKey of inputKeys) {
    const stat = await storage.stat(inputKey);
    if (!stat) throw new ConversionFailedError(`Input artifact "${inputKey}" not found in storage`);
    stats.push(stat);
  }
  const names = exportedFileNames(stats.map((stat, index) => stat.filename || path.posix.basename(inputKeys[index])));
  const destination = node.op === 'export.s3' ? node.prefix : node.directory;
  for (const [index, inputKey] of inputKeys.entries()) {
    signal.throwIfAborted();
    const stat = stats[index];
    const name = names[index];
    const remotePath = exportDestination(node.op, destination, name);
    try {
      const written = await withTransientRetry(signal, async () => {
        const body = await storage.openReadStream(inputKey);
        if (!body) throw new ConversionFailedError(`Input artifact "${inputKey}" not found in storage`);
        try {
          return await store.upload(remotePath, body, { contentType: stat.mimeType || 'application/octet-stream', size: stat.size });
        } finally {
          (body as { destroy?: () => void }).destroy?.();
        }
      });
      await job.log(`Exported "${name}" (${written.size} bytes) to the customer's ${KIND_OF_OPERATION[node.op]} store`);
    } catch (err) {
      await job.log(`Export of "${name}" to the customer's ${KIND_OF_OPERATION[node.op]} store failed after ${index} of ${inputKeys.length} file(s) were written`);
      throw err;
    }
  }
  return inputKeys;
}
