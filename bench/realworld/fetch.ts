/**
 * Fetches corpus files into a local cache and checks every digest. A cached file is reused only when its SHA-256 still
 * matches the manifest; anything else is fetched again, and a digest mismatch after fetching fails the run.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchBytes } from './http';
import type { CorpusFile } from './manifest';
import { inflateEntry, localHeaderLength } from './zip-range';

const LOCAL_HEADER_PROBE_BYTES = 30;
/** Largest file the corpus may hold; larger entries are rejected when the manifest is built. */
export const MAX_CORPUS_FILE_BYTES = 32 * 1024 * 1024;

export class DigestMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestMismatchError';
  }
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The file's bytes from its origin, before any digest check. */
export async function download(file: CorpusFile): Promise<Buffer> {
  const origin = file.origin;
  if (origin.kind === 'file') return fetchBytes(origin.url, null, MAX_CORPUS_FILE_BYTES);
  const head = await fetchBytes(origin.archive, [origin.offset, origin.offset + LOCAL_HEADER_PROBE_BYTES - 1], LOCAL_HEADER_PROBE_BYTES);
  const dataStart = origin.offset + localHeaderLength(head);
  const data = origin.compressedSize === 0 ? Buffer.alloc(0) : await fetchBytes(origin.archive, [dataStart, dataStart + origin.compressedSize - 1], MAX_CORPUS_FILE_BYTES);
  return inflateEntry({ name: origin.entry, method: origin.method, compressedSize: origin.compressedSize, size: file.size, localHeaderOffset: origin.offset }, data);
}

/** Path of the verified file in `cacheDir`, fetching it when absent or stale. */
export async function ensureCached(file: CorpusFile, cacheDir: string): Promise<string> {
  const target = path.join(cacheDir, file.id);
  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === file.sha256) return target;
  const bytes = await download(file);
  const digest = sha256(bytes);
  if (digest !== file.sha256) throw new DigestMismatchError(`${file.id}: SHA-256 ${digest}, manifest says ${file.sha256}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const partial = `${target}.part`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, target);
  return target;
}

/** Runs `task` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
