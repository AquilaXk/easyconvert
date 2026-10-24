import type { Readable } from 'node:stream';
import type { IStorageBackend } from './oci-storage';
import { HEADER_WINDOW_BYTES } from '../format-signatures';

/** Enough leading bytes for every magic-number check the registry performs. */
export const OBJECT_HEADER_BYTES = HEADER_WINDOW_BYTES;

/**
 * Up to `length` bytes of a stored object from `offset` without reading the rest of it; null when the object does not exist.
 * The caller keeps the range inside the object (`size` from `stat`), as a read past its end is an error of the store.
 */
export async function readObjectRange(
  storage: Pick<IStorageBackend, 'openReadStream'>,
  key: string,
  offset: number,
  length: number
): Promise<Buffer | null> {
  const stream = await storage.openReadStream(key, { start: offset, end: offset + length - 1 });
  if (!stream) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(piece);
      total += piece.length;
      if (total >= length) break;
    }
  } finally {
    (stream as Readable).destroy();
  }
  return Buffer.concat(chunks, total).subarray(0, length);
}

/**
 * The first bytes of a stored object (at most `maxBytes`) without reading the rest of it, so a
 * file can be checked against its declared format whether it lives on local disk or in the object
 * store. Returns null when the object does not exist; an empty object yields an empty buffer.
 */
export async function readObjectHeader(
  storage: Pick<IStorageBackend, 'stat' | 'openReadStream'>,
  key: string,
  maxBytes: number = OBJECT_HEADER_BYTES
): Promise<Buffer | null> {
  const stat = await storage.stat(key);
  if (!stat) return null;
  if (stat.size === 0) return Buffer.alloc(0);
  return readObjectRange(storage, key, 0, Math.min(stat.size, maxBytes));
}
