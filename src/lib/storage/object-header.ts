import type { Readable } from 'node:stream';
import type { IStorageBackend } from './oci-storage';

/** Enough leading bytes for every magic-number check the registry performs. */
export const OBJECT_HEADER_BYTES = 64 * 1024;

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

  const want = Math.min(stat.size, maxBytes);
  const stream = await storage.openReadStream(key, { start: 0, end: want - 1 });
  if (!stream) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(piece);
      total += piece.length;
      if (total >= want) break;
    }
  } finally {
    (stream as Readable).destroy();
  }
  return Buffer.concat(chunks, total).subarray(0, want);
}
