import pako from 'pako';

/**
 * The first bytes of what a gzip member (RFC 1952) holds, read with `pako` (a zlib port in plain JavaScript) instead of
 * Node's zlib so that the signature table of the format registry, which client components import too, stays free of Node
 * built-ins. The compressed window is pushed in small slices, each with a sync flush so that what it decoded is handed over
 * at once rather than when a 16 KiB output chunk fills, and the read stops as soon as the byte budget is reached, so a
 * stream that expands far past it is never inflated further.
 *
 * A stream that is not valid gzip gives `undefined`, and so does a window that holds no decoded byte at all (an incomplete
 * header, say), because there is nothing to judge; input that ends inside the stream gives the bytes decoded so far,
 * because the window the registry reads is a prefix of the file.
 */

/** zlib `windowBits`: 15 bits of window plus 16 to read the gzip wrapper only (a zlib or raw stream is an error). */
const GZIP_WINDOW_BITS = 15 + 16;
/** A slice of this many compressed bytes expands to about a quarter of a megabyte at most (deflate's ratio is below 1032). */
const INPUT_SLICE_BYTES = 256;
const OUTPUT_CHUNK_BYTES = 16 * 1024;
const NO_ERROR = 0;
/** zlib flush mode 2: hand over everything decoded so far. */
const Z_SYNC_FLUSH = 2;

export function gunzipHead(member: Uint8Array, budget: number): Uint8Array | undefined {
  const inflater = new pako.Inflate({ windowBits: GZIP_WINDOW_BITS, chunkSize: OUTPUT_CHUNK_BYTES });
  const head = new Uint8Array(budget);
  let produced = 0;
  inflater.onData = (chunk) => {
    const bytes = chunk as Uint8Array;
    const kept = Math.min(bytes.length, budget - produced);
    head.set(bytes.subarray(0, kept), produced);
    produced += kept;
  };
  for (let at = 0; at < member.length && produced < budget && inflater.err === NO_ERROR; at += INPUT_SLICE_BYTES) {
    inflater.push(member.subarray(at, at + INPUT_SLICE_BYTES), Z_SYNC_FLUSH);
  }
  return inflater.err === NO_ERROR && produced > 0 ? head.subarray(0, produced) : undefined;
}
