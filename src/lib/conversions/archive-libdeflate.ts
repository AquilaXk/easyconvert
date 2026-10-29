import zlib from 'node:zlib';
import { executeSandboxedBinary, rethrowSandboxUnavailable } from '../security/process-sandbox';
import { CPU_POOL_TASK_TIMEOUT_MS } from '../workers/cpu-pool';
import { resolveBinaryPath } from './pdf-postprocess/utils';

/**
 * Raw deflate of one large buffer by the `libdeflate-gzip` command (MIT; Debian and Ubuntu package `libdeflate-tools`),
 * run through the sandboxed process runner with the data on stdin. libdeflate hashes three-byte matches and parses lazily
 * (levels 1 to 9) or near-optimally (10 to 12): at the level the default maps to it is no larger than `gzip -6` and 1.7 to
 * 3 times faster, while the platform's zlib (four-byte hash) writes up to 3.6 percent more than `gzip -6` on binary data
 * (docs/policy-decisions.md, entry 30). The command writes a gzip member, so the stream inside it is cut out: the callers
 * write their own framing (a ZIP entry, or a gzip header that names the file) around the raw deflate stream.
 */

const LIBDEFLATE_GZIP_ENV = 'LIBDEFLATE_GZIP_PATH';
const LIBDEFLATE_GZIP_BINARY = 'libdeflate-gzip';
const LIBDEFLATE_GZIP_CANDIDATES = ['/usr/bin/libdeflate-gzip', '/usr/local/bin/libdeflate-gzip', '/opt/homebrew/bin/libdeflate-gzip'];

/**
 * The libdeflate level that carries each product `compressionLevel` (1 to 9; 0 is stored and never encoded). Levels 1 to 5
 * keep their number: libdeflate N is smaller than `gzip -N` and faster. The default (6) is libdeflate 7, the lowest level
 * that is no larger than `gzip -6` on all twelve Silesia files (level 6 is 0.95 percent larger on `reymont` and 0.05 percent
 * on `sao`) and still 1.7 to 3 times faster than `gzip -6`. The levels above it are the strongest tiers: 9 costs what zlib 9
 * does for a smaller stream, 10 and 12 are libdeflate's near-optimal parser (2 to 3 percent smaller than level 9).
 */
const LIBDEFLATE_LEVEL_OF_PRODUCT_LEVEL: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [6, 7],
  [7, 9],
  [8, 10],
  [9, 12],
]);

const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const GZIP_METHOD_DEFLATE = 8;
const GZIP_FIXED_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const GZIP_CRC_OFFSET_FROM_END = 8;
const GZIP_ISIZE_OFFSET_FROM_END = 4;
const UINT32_MODULUS = 0x100000000;
/** Most a deflate stream adds to incompressible input: a 5-byte stored-block header per 65535 bytes. */
const STORED_BLOCK_BYTES = 65535;
const STORED_BLOCK_HEADER_BYTES = 5;
/** Room beyond the worst case for the gzip framing and anything the command prints to stdout. */
const OUTPUT_SLACK_BYTES = 1024;

/** The command did not give a verified deflate stream: not installed, failed, timed out or wrote framing that does not match the input. */
export class NativeDeflateError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'NativeDeflateError';
  }
}

export interface NativeDeflateRuntime {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Location of `libdeflate-gzip`, or null when it is not installed (an override that names no file counts as not installed). */
export function getLibdeflateGzipPath(): string | null {
  return resolveBinaryPath(LIBDEFLATE_GZIP_ENV, LIBDEFLATE_GZIP_CANDIDATES, LIBDEFLATE_GZIP_BINARY);
}

function worstCaseOutputBytes(inputBytes: number): number {
  return inputBytes + Math.ceil(inputBytes / STORED_BLOCK_BYTES) * STORED_BLOCK_HEADER_BYTES + GZIP_FIXED_HEADER_BYTES + GZIP_TRAILER_BYTES + OUTPUT_SLACK_BYTES;
}

/**
 * The deflate stream inside a gzip member written for `data`, after the member's framing has been checked against it: the
 * fixed 10-byte header without optional fields, and a trailer whose CRC-32 and length are those of `data`.
 */
function rawDeflateOfMember(member: Buffer, data: Uint8Array): Buffer {
  if (member.length < GZIP_FIXED_HEADER_BYTES + GZIP_TRAILER_BYTES) throw new NativeDeflateError('libdeflate-gzip wrote a truncated gzip member.');
  if (member[0] !== GZIP_ID1 || member[1] !== GZIP_ID2 || member[2] !== GZIP_METHOD_DEFLATE || member[3] !== 0) {
    throw new NativeDeflateError('libdeflate-gzip wrote a gzip header that is not the plain 10-byte form.');
  }
  const crc = member.readUInt32LE(member.length - GZIP_CRC_OFFSET_FROM_END);
  const size = member.readUInt32LE(member.length - GZIP_ISIZE_OFFSET_FROM_END);
  if (size !== data.length % UINT32_MODULUS || crc !== zlib.crc32(data)) {
    throw new NativeDeflateError('libdeflate-gzip wrote a gzip trailer that does not match its input.');
  }
  return member.subarray(GZIP_FIXED_HEADER_BYTES, member.length - GZIP_TRAILER_BYTES);
}

/**
 * Raw deflate stream of `data` at a product level (1 to 9). Throws NativeDeflateError for any outcome other than a verified
 * stream, so the caller can hand the request to the 7-Zip route; an abort and a missing sandbox are rethrown as they are.
 */
export async function deflateRawWithLibdeflate(data: Uint8Array, productLevel: number, runtime: NativeDeflateRuntime = {}): Promise<Buffer> {
  const level = LIBDEFLATE_LEVEL_OF_PRODUCT_LEVEL.get(productLevel);
  if (level === undefined) throw new RangeError(`No libdeflate level for product compression level ${productLevel}.`);
  const binary = getLibdeflateGzipPath();
  if (binary === null) throw new NativeDeflateError('libdeflate-gzip is not installed.');
  let member: Buffer;
  try {
    const run = await executeSandboxedBinary(binary, [`-${level}`], {
      stdin: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      maxBuffer: worstCaseOutputBytes(data.length),
      timeoutMs: runtime.timeoutMs ?? CPU_POOL_TASK_TIMEOUT_MS,
      networkIsolated: true,
      signal: runtime.signal,
    });
    member = run.stdout;
  } catch (error) {
    if (runtime.signal?.aborted) throw error;
    rethrowSandboxUnavailable(error);
    throw new NativeDeflateError(`libdeflate-gzip failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return rawDeflateOfMember(member, data);
}
