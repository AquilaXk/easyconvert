import zlib from 'node:zlib';
import { inflateChunkHint } from './archive-zip-reader';

/**
 * Raw deflate of one buffer in blocks that are compressed at the same time (the scheme of pigz): each block after the first
 * starts with the last 32 KiB of the data before it as a preset dictionary, so matches reach across the cuts, and each
 * block but the last ends with a sync flush (an empty stored block), which leaves the stream on a byte boundary so the
 * pieces join as plain bytes into one valid deflate stream (RFC 1951). The checksum of the whole is taken by the caller
 * over the whole buffer, so no CRC-32 combination is needed.
 *
 * The layout depends on the length alone (blocks of {@link DEFLATE_BLOCK_BYTES}), never on the number of cores, so the
 * same input gives the same bytes on every machine. The pieces are compressed by the thread pool, one task each.
 */

/** Size of a block. Smaller blocks add a flush (about 5 bytes) and a fresh set of Huffman tables each. */
export const DEFLATE_BLOCK_BYTES = 256 * 1024;
const DICTIONARY_BYTES = 32 * 1024;

/**
 * The zlib level that carries a product `compressionLevel` (0 to 9). The levels the product offered were 7-Zip's: its
 * deflate at levels 1 to 4 is the fast parser and from level 5 the optimal parser, whose output (321 978 bytes on the
 * benchmark input) zlib reaches at its level 8 (322 913) and level 9 does not improve on at that size. Levels 1 to 4 are
 * zlib's own, whose sizes match 7-Zip's fast parser, and 7 to 9 take zlib's strongest level.
 */
const ZLIB_LEVEL_OF_PRODUCT_LEVEL: readonly number[] = [0, 1, 2, 3, 4, 8, 8, 9, 9, 9];

export function zlibLevelFor(productLevel: number): number {
  return ZLIB_LEVEL_OF_PRODUCT_LEVEL[productLevel];
}

function deflatePiece(piece: Uint8Array, level: number, dictionary: Uint8Array | undefined, last: boolean): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zlib.deflateRaw(
      piece,
      {
        level,
        chunkSize: inflateChunkHint(piece.length),
        dictionary,
        finishFlush: last ? zlib.constants.Z_FINISH : zlib.constants.Z_SYNC_FLUSH,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
  });
}

/** Raw deflate stream of `data` at a zlib level (0 to 9); a buffer of at most one block is compressed in one piece. */
export async function deflateRawInBlocks(data: Uint8Array, level: number): Promise<Buffer> {
  const pieces = Math.max(1, Math.ceil(data.length / DEFLATE_BLOCK_BYTES));
  if (pieces === 1) return deflatePiece(data, level, undefined, true);
  const jobs: Promise<Buffer>[] = [];
  for (let index = 0; index < pieces; index++) {
    const start = index * DEFLATE_BLOCK_BYTES;
    const end = Math.min(data.length, start + DEFLATE_BLOCK_BYTES);
    const dictionary = index === 0 ? undefined : data.subarray(Math.max(0, start - DICTIONARY_BYTES), start);
    jobs.push(deflatePiece(data.subarray(start, end), level, dictionary, index === pieces - 1));
  }
  return Buffer.concat(await Promise.all(jobs));
}

/** Raw deflate stream of `data` at a product level (the mapping of {@link zlibLevelFor}). */
export async function deflateRawBlocks(data: Uint8Array, productLevel: number): Promise<Buffer> {
  return deflateRawInBlocks(data, zlibLevelFor(productLevel));
}

// ---------------------------------------------------------------------------
// gzip member (RFC 1952)
// ---------------------------------------------------------------------------

/** A buffer of at most this many bytes is gzipped on the calling thread: a pool round trip costs more than the work. */
const GZIP_SYNC_MAX_BYTES = 64 * 1024;
const GZIP_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const GZIP_METHOD_DEFLATE = 8;
const GZIP_XFL_BEST = 2;
const GZIP_XFL_FASTEST = 4;
const GZIP_OS_UNIX = 3;
const UINT32_MODULUS = 0x100000000;

/** The header of a gzip member without a name or a time, as zlib writes it (the extra-flags byte names level 9 and the fastest levels). */
function gzipHeader(level: number): Buffer {
  const header = Buffer.alloc(GZIP_HEADER_BYTES);
  header[0] = 0x1f;
  header[1] = 0x8b;
  header[2] = GZIP_METHOD_DEFLATE;
  header[8] = level === 9 ? GZIP_XFL_BEST : level < 2 ? GZIP_XFL_FASTEST : 0;
  header[9] = GZIP_OS_UNIX;
  return header;
}

/**
 * One gzip member of `data` at a zlib level, deflated in parallel blocks ({@link deflateRawInBlocks}) when it is large; the
 * CRC-32 is zlib's, taken once over the whole. A buffer of up to 64 KiB is `zlib.gzipSync`'s output, byte for byte.
 */
export async function gzipInBlocks(data: Uint8Array, level: number): Promise<Buffer> {
  if (data.length <= GZIP_SYNC_MAX_BYTES) return zlib.gzipSync(data, { level });
  const deflated = await deflateRawInBlocks(data, level);
  const trailer = Buffer.alloc(GZIP_TRAILER_BYTES);
  trailer.writeUInt32LE(zlib.crc32(data), 0);
  trailer.writeUInt32LE(data.length % UINT32_MODULUS, 4);
  return Buffer.concat([gzipHeader(level), deflated, trailer]);
}
