import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RemotePartProgressRecord {
  partNumber: number;
  etag: string;
  size: number;
}

export interface RemoteFlushCheckpoint {
  parts: RemotePartProgressRecord[];
  flushedBytes: number;
  uploadOffset: number;
  cursor: number;
  completed: boolean;
  headerProbeBase64?: string;
}

/**
 * Reads up to `length` bytes starting at `position` from an open file descriptor,
 * looping across short POSIX reads without buffering beyond `length`.
 */
export async function readHandleSlice(
  handle: fs.promises.FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RangeError(`Invalid file read position: ${position}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid file read length: ${length}`);
  }
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(buf, totalRead, length - totalRead, position + totalRead);
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  return totalRead === length ? buf : Buffer.from(buf.subarray(0, totalRead));
}

/**
 * Opens `filePath` read-only and reads up to `length` bytes from `position`.
 */
export async function readFileSlice(filePath: string, position: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RangeError(`Invalid file read position: ${position}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid file read length: ${length}`);
  }
  if (length === 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    return await readHandleSlice(handle, position, length);
  } finally {
    await handle.close();
  }
}

/**
 * Writes the full `data` buffer to `handle` (starting at `position` when provided), looping across short POSIX writes.
 */
export async function writeAllToHandle(
  handle: fs.promises.FileHandle,
  data: Buffer,
  position?: number
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    const { bytesWritten } =
      position === undefined
        ? await handle.write(data, offset, remaining)
        : await handle.write(data, offset, remaining, position + offset);
    if (bytesWritten === 0) {
      throw new Error('Short write (0 bytes) while persisting TUS staged data');
    }
    offset += bytesWritten;
  }
}

/**
 * Atomically writes UTF-8 `content` to `targetPath` via a sibling `.tmp` handle, `writeAllToHandle`, close, and rename.
 */
export async function writeTextFileAtomic(targetPath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const payload = Buffer.from(content, 'utf-8');
  let handle: fs.promises.FileHandle | null = await fs.promises.open(tempPath, 'w');
  let renamed = false;
  try {
    await writeAllToHandle(handle, payload);
    const toClose = handle;
    handle = null;
    await toClose.close();
    await fs.promises.rename(tempPath, targetPath);
    renamed = true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Atomically replaces `binPath` with `tail` via a sibling temporary file and rename.
 */
export async function writeTailFileAtomic(binPath: string, tail: Buffer): Promise<void> {
  const tempPath = `${binPath}.${crypto.randomBytes(6).toString('hex')}.tail`;
  try {
    await fs.promises.writeFile(tempPath, tail);
    await fs.promises.rename(tempPath, binPath);
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Atomically compacts `binPath` to `[startOffset, startOffset + length)` in bounded `sliceLimit` steps.
 */
export async function compactTailFromFile(
  binPath: string,
  startOffset: number,
  length: number,
  sliceLimit: number
): Promise<void> {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new RangeError(`Invalid compaction startOffset: ${startOffset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid compaction length: ${length}`);
  }
  if (!Number.isSafeInteger(sliceLimit) || sliceLimit <= 0) {
    throw new RangeError(`Invalid compaction sliceLimit: ${sliceLimit}`);
  }
  if (length === 0) {
    await writeTailFileAtomic(binPath, Buffer.alloc(0));
    return;
  }
  const tempPath = `${binPath}.${crypto.randomBytes(6).toString('hex')}.tail`;
  let src: fs.promises.FileHandle | null = await fs.promises.open(binPath, 'r');
  let dst: fs.promises.FileHandle | null = null;
  let renamed = false;
  try {
    dst = await fs.promises.open(tempPath, 'w');
    let copied = 0;
    while (copied < length) {
      const want = Math.min(sliceLimit, length - copied);
      const chunk = await readHandleSlice(src, startOffset + copied, want);
      if (chunk.length !== want) {
        throw new Error(`Short read while compacting TUS staged tail: expected ${want} bytes, got ${chunk.length}`);
      }
      await writeAllToHandle(dst, chunk);
      copied += chunk.length;
    }
    const dstToClose = dst;
    dst = null;
    await dstToClose.close();
    const srcToClose = src;
    src = null;
    await srcToClose.close();
    await fs.promises.rename(tempPath, binPath);
    renamed = true;
  } finally {
    if (dst) await dst.close().catch(() => undefined);
    if (src) await src.close().catch(() => undefined);
    if (!renamed) await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Streams `binPath` directly from an open file descriptor in `partSize` slices,
 * invoking `uploadPart` and `onPartUploaded` incrementally without buffering the whole file.
 */
export async function uploadFileSlicesInParts(params: {
  binPath: string;
  partSize: number;
  maxCursor: number;
  minSliceBytes: number;
  initialParts: readonly RemotePartProgressRecord[];
  uploadPart: (partNumber: number, slice: Buffer) => Promise<RemotePartProgressRecord> | RemotePartProgressRecord;
  onPartUploaded?: (parts: RemotePartProgressRecord[], cursor: number, isFinalSlice: boolean) => Promise<void>;
  onShortRead: (actualReadTotal: number) => Error;
}): Promise<{ parts: RemotePartProgressRecord[]; cursor: number; leftover: Buffer }> {
  const { binPath, partSize, maxCursor, minSliceBytes, initialParts, uploadPart, onPartUploaded, onShortRead } = params;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new RangeError(`Invalid partSize: ${partSize}`);
  }
  if (!Number.isSafeInteger(maxCursor) || maxCursor < 0) {
    throw new RangeError(`Invalid maxCursor: ${maxCursor}`);
  }
  if (!Number.isSafeInteger(minSliceBytes) || minSliceBytes <= 0) {
    throw new RangeError(`Invalid minSliceBytes: ${minSliceBytes}`);
  }
  const parts = [...initialParts];
  if (maxCursor === 0) {
    return { parts, cursor: 0, leftover: Buffer.alloc(0) };
  }
  let cursor = 0;
  const handle = await fs.promises.open(binPath, 'r');
  try {
    while (maxCursor - cursor >= minSliceBytes) {
      const sliceLen = Math.min(partSize, maxCursor - cursor);
      const slice = await readHandleSlice(handle, cursor, sliceLen);
      if (slice.length !== sliceLen) {
        throw onShortRead(cursor + slice.length);
      }
      const uploaded = await uploadPart(parts.length + 1, slice);
      parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag, size: uploaded.size });
      cursor += sliceLen;
      if (onPartUploaded) {
        await onPartUploaded(parts, cursor, cursor >= maxCursor);
      }
    }
    const leftoverLen = maxCursor - cursor;
    const leftover = leftoverLen > 0 ? await readHandleSlice(handle, cursor, leftoverLen) : Buffer.alloc(0);
    if (leftover.length !== leftoverLen) {
      throw onShortRead(cursor + leftover.length);
    }
    return { parts, cursor, leftover };
  } finally {
    await handle.close();
  }
}
