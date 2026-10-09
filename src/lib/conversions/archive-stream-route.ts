import { hasTarMagicBlock, isTarHeaderBlock } from './archive-extraction-safety';

/**
 * The one place that decides how an archive-to-archive pair is served without extracting to disk.
 *
 * Three pairs have a cheaper shape than "extract everything, then pack everything again":
 *  - a single-stream compressor (xz, gzip, bzip2) to tar is stream decompression; the unpacked tar is read and vetted
 *    entry by entry and written again from those entries (never passed through), and a one-member tar is written
 *    around the bytes when the payload is not a tar;
 *  - 7z to tar streams the members out of 7-Zip in file-table order and writes them into the tar as they arrive;
 *  - tar to 7z reads the tar in process and hands 7-Zip a staging tree it can compress at once.
 *
 * Both engines (the native worker route and the in-process converter) read these tables, so a format never ends up
 * treated as a tarball by one engine and as a plain stream by the other.
 */

const TAR_BLOCK_BYTES = 512;

/** The 7-Zip archive type that decodes a single-stream compressor. */
export type StreamCompressor = 'xz' | 'gzip' | 'bzip2';

export interface StreamSource {
  compressor: StreamCompressor;
  /** The registry name says the payload is a tar (`tar.xz`, `tgz`, ...), not just a stream that may hold one. */
  tarball: boolean;
}

const STREAM_SOURCES: ReadonlyMap<string, StreamSource> = new Map<string, StreamSource>([
  ['xz', { compressor: 'xz', tarball: false }],
  ['txz', { compressor: 'xz', tarball: true }],
  ['tar.xz', { compressor: 'xz', tarball: true }],
  ['gz', { compressor: 'gzip', tarball: false }],
  ['gzip', { compressor: 'gzip', tarball: false }],
  ['tgz', { compressor: 'gzip', tarball: true }],
  ['tar.gz', { compressor: 'gzip', tarball: true }],
  ['bz2', { compressor: 'bzip2', tarball: false }],
  ['bzip2', { compressor: 'bzip2', tarball: false }],
  ['tbz2', { compressor: 'bzip2', tarball: true }],
  ['tar.bz2', { compressor: 'bzip2', tarball: true }],
]);

export type NativeArchiveRoute =
  | { kind: 'stream-to-tar'; source: StreamSource }
  | { kind: 'seven-zip-to-tar' }
  | { kind: 'tar-to-seven-zip' };

/** The request fields that decide whether a route applies. */
export interface ArchiveRouteRequest {
  password?: string;
  /** The request must not hold archive bytes in memory; every streaming route buffers them. */
  zeroHeap?: boolean;
  entries?: string[];
  archiveParts?: unknown[];
}

/**
 * The streaming route for a pair, or null when the general extract-then-pack pipeline serves it. A password, a
 * selective-entry request and a multi-volume input need that pipeline's listing, filtering and spanning, and a
 * zero-heap request needs its disk-backed streams, so they never take a streaming route.
 */
export function planNativeArchiveRoute(src: string, tgt: string, request: ArchiveRouteRequest): NativeArchiveRoute | null {
  if (request.password) return null;
  if (request.zeroHeap) return null;
  if (request.entries && request.entries.length > 0) return null;
  if (request.archiveParts && request.archiveParts.length > 0) return null;
  if (tgt === 'tar') {
    const source = STREAM_SOURCES.get(src);
    if (source) return { kind: 'stream-to-tar', source };
    if (src === '7z') return { kind: 'seven-zip-to-tar' };
    return null;
  }
  if (src === 'tar' && tgt === '7z') return { kind: 'tar-to-seven-zip' };
  return null;
}

/**
 * What unpacked bytes look like from their first block alone:
 *  - `tar`: the `ustar` magic (POSIX, GNU, pax).
 *  - `maybe-tar`: no magic but a valid header checksum (a v7 tar). This is the test 7-Zip applies before it opens a
 *    file as a tar, and the checksum is eight octal digits that must equal the sum of the block, so nothing that is
 *    not a tar header passes it by accident.
 *  - `plain`: neither.
 * Both tar kinds are read as tars; one that then fails to read is damaged, never an ordinary payload.
 */
export type UnpackedKind = 'tar' | 'maybe-tar' | 'plain';

export function classifyUnpacked(unpacked: Uint8Array): UnpackedKind {
  if (unpacked.length < TAR_BLOCK_BYTES) return 'plain';
  const first = unpacked.subarray(0, TAR_BLOCK_BYTES);
  if (hasTarMagicBlock(first)) return 'tar';
  return isTarHeaderBlock(first) ? 'maybe-tar' : 'plain';
}
