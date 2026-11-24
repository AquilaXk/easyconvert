import { createSessionId, destroySessionImmediately } from './edge/opfs/storage-gc';
import { registerEdgeResultCleanup, releaseEdgeResultResources } from './edge/pipelines/opfs-streaming-pipeline';

/** How long a download URL stays valid after the click: a browser may read the blob some time after the link is followed. */
const REVOKE_DELAY_MS = 60_000;

/** Maximum ZIP size streamed to OPFS disk handles before aborting. */
export const MAX_OPFS_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

/** Maximum ZIP size buffered in JS memory when OPFS createWritable is unavailable. */
export const MAX_IN_MEMORY_ZIP_BYTES = 256 * 1024 * 1024;

interface OpfsWritableStream {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface OpfsFileHandle {
  createWritable?: () => Promise<OpfsWritableStream>;
  getFile(): Promise<File>;
}

interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
}

interface OpfsZipTarget {
  rootDir: OpfsDirectoryHandle;
  sessionId: string;
  fileHandle: OpfsFileHandle;
  writable: OpfsWritableStream;
}

function sanitizeZipLeafName(filename: string): string {
  const leaf = filename.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const cleaned = leaf.replace(/[\x00-\x1f\x7f]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
    return 'files.zip';
  }
  return cleaned;
}

/**
 * Triggers a browser download for `url` as `filename`. The anchor is attached to the document while clicked
 * because Firefox and Safari only follow an attached anchor.
 */
export function triggerAnchorDownload(url: string, filename: string): string {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return url;
}

/**
 * Saves `blob` as a file called `filename`. The link is attached to the page while it is clicked, as Firefox and Safari follow
 * only an attached link, and the URL is freed after `REVOKE_DELAY_MS`, not in the same tick, which would cancel the download.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerAnchorDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

async function openOpfsZipTarget(safeName: string): Promise<OpfsZipTarget | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return null;
  }
  let rootDir: OpfsDirectoryHandle | undefined;
  let sessionId: string | undefined;
  try {
    rootDir = (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle;
    sessionId = createSessionId();
    const easyconvertDir = await rootDir.getDirectoryHandle('easyconvert', { create: true });
    const sessionsDir = await easyconvertDir.getDirectoryHandle('sessions', { create: true });
    const sessionDir = await sessionsDir.getDirectoryHandle(sessionId, { create: true });
    const fileHandle = await sessionDir.getFileHandle(safeName, { create: true });
    if (typeof fileHandle.createWritable !== 'function') {
      await destroySessionImmediately(sessionId, rootDir).catch(() => false);
      return null;
    }
    const writable = await fileHandle.createWritable();
    return { rootDir, sessionId, fileHandle, writable };
  } catch {
    if (sessionId) {
      await destroySessionImmediately(sessionId, rootDir).catch(() => false);
    }
    return null;
  }
}

async function writeZipStreamToOpfs(stream: ReadableStream<Uint8Array>, target: OpfsZipTarget): Promise<string> {
  const reader = stream.getReader();
  let totalBytes = 0;
  let closedWritable = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_OPFS_ZIP_BYTES) {
        throw new Error(`ZIP archive exceeds the ${MAX_OPFS_ZIP_BYTES} byte OPFS download limit.`);
      }
      await target.writable.write(value as BufferSource);
    }
    await target.writable.close();
    closedWritable = true;
    const file = await target.fileHandle.getFile();
    const url = URL.createObjectURL(file);
    registerEdgeResultCleanup(url, () => destroySessionImmediately(target.sessionId));
    return url;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (!closedWritable) {
      await target.writable.abort(error).catch(() => undefined);
    }
    await destroySessionImmediately(target.sessionId, target.rootDir).catch(() => false);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function materializeInMemoryZipUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IN_MEMORY_ZIP_BYTES) {
        throw new Error(`ZIP archive exceeds the ${MAX_IN_MEMORY_ZIP_BYTES} byte in-memory download limit without OPFS.`);
      }
      chunks.push(value as BlobPart);
    }
    const blob = new Blob(chunks, { type: 'application/zip' });
    return URL.createObjectURL(blob);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Materializes a streaming ZIP ReadableStream into an object URL backed by OPFS disk storage when
 * `FileSystemFileHandle.createWritable` is available, or a size-capped in-memory Blob otherwise.
 */
export async function materializeZipStreamUrl(stream: ReadableStream<Uint8Array>, filename: string): Promise<string> {
  const safeName = sanitizeZipLeafName(filename);
  const opfsTarget = await openOpfsZipTarget(safeName);
  if (opfsTarget) {
    return writeZipStreamToOpfs(stream, opfsTarget);
  }
  return materializeInMemoryZipUrl(stream);
}

/**
 * Streams a ZIP ReadableStream to disk (OPFS) or bounded fallback storage, clicks an attached download link,
 * and frees the object URL and backing OPFS session after `REVOKE_DELAY_MS`.
 */
export async function downloadZipStream(stream: ReadableStream<Uint8Array>, filename: string): Promise<string> {
  const url = await materializeZipStreamUrl(stream, filename);
  triggerAnchorDownload(url, filename);
  setTimeout(() => {
    void releaseEdgeResultResources(url);
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
  return url;
}
