import { Readable } from 'node:stream';
import os from 'node:os';
import { executeSandboxedBinary, rethrowSandboxUnavailable } from '../security/process-sandbox';
import { CPU_POOL_TASK_TIMEOUT_MS } from '../workers/cpu-pool';
import { resolveBinaryPath } from './pdf-postprocess/utils';

/**
 * A bzip2 stream of one large buffer written by the `lbzip2` command (GPL-3.0-or-later; Debian and Ubuntu package
 * `lbzip2`), run unmodified as a separate process through the sandboxed process runner with the data on stdin. lbzip2 sorts
 * each block with a suffix-array based transform that is 1.6 times faster than the sort of `bzip2` on one thread, and it
 * spreads the blocks of a larger input over the cores. It writes one ordinary bzip2 stream with the blocks of the level asked
 * for, which `bzip2 -d` and 7-Zip read (docs/policy-decisions.md, entry 50).
 *
 * It serves inputs of up to {@link LBZIP2_MAX_BLOCKS} blocks. lbzip2 lays its blocks out differently from `bzip2 -9` on input
 * with long runs: Silesia `nci` came out as 75 blocks where `bzip2 -9` writes 39, 2 percent larger and past the parity
 * allowance. On one or two blocks the size stays within 1 percent of `bzip2 -9` on every Silesia file. 7-Zip's encoder keeps
 * the blocks of `bzip2 -9` and runs them on all cores, so it serves the larger inputs, where several blocks run at once.
 */

const LBZIP2_ENV = 'LBZIP2_PATH';
const LBZIP2_BINARY = 'lbzip2';
const LBZIP2_CANDIDATES = ['/usr/bin/lbzip2', '/usr/local/bin/lbzip2', '/opt/homebrew/bin/lbzip2'];

const BZIP2_BLOCK_UNIT_BYTES = 100_000;
/** The largest block size multiplier, and the level from which it applies; below it 7-Zip's mapping is kept so the blocks do not change. */
const BZIP2_MAX_BLOCK_UNITS = 9;
const BZIP2_FULL_BLOCK_LEVEL = 5;
const BZIP2_MIN_BLOCK_UNITS = 1;

const BZIP2_MAGIC = Buffer.from('BZh', 'latin1');
const BZIP2_STREAM_HEADER_BYTES = 4;
/** Stream header, an end-of-stream marker (6 bytes) and the combined CRC (4 bytes): the shortest stream of an empty input. */
const BZIP2_MIN_STREAM_BYTES = 14;
const ASCII_DIGIT_ZERO = 0x30;
/** bzip2's worst case on incompressible data is 1 % and 600 bytes; the multiple and the slack leave room above it. */
const BZIP2_WORST_CASE_MULTIPLE = 1.05;
const OUTPUT_SLACK_BYTES = 4096;

/** Most blocks of its level an input may fill and still be written by lbzip2 (see the note above). */
export const LBZIP2_MAX_BLOCKS = 2;

/** The command did not give a bzip2 stream: not installed, failed, timed out or wrote bytes that are not a stream. */
export class NativeBzip2Error extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'NativeBzip2Error';
  }
}

export interface NativeBzip2Runtime {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Location of `lbzip2`, or null when it is not installed (an override that names no file counts as not installed). */
export function getLbzip2Path(): string | null {
  return resolveBinaryPath(LBZIP2_ENV, LBZIP2_CANDIDATES, LBZIP2_BINARY);
}

/** The bzip2 block size (1 to 9, in units of 100 kB) the product's `compressionLevel` (0 to 9) writes; 7-Zip's mapping. */
export function bzip2BlockUnitsOfLevel(productLevel: number): number {
  if (productLevel >= BZIP2_FULL_BLOCK_LEVEL) return BZIP2_MAX_BLOCK_UNITS;
  return Math.max(BZIP2_MIN_BLOCK_UNITS, 2 * productLevel - 1);
}

/** Largest input, in bytes, that {@link bzip2WithLbzip2} is used for at a product level. */
export function lbzip2MaxInputBytes(productLevel: number): number {
  return LBZIP2_MAX_BLOCKS * bzip2BlockUnitsOfLevel(productLevel) * BZIP2_BLOCK_UNIT_BYTES;
}

function worstCaseOutputBytes(inputBytes: number): number {
  return Math.ceil(inputBytes * BZIP2_WORST_CASE_MULTIPLE) + OUTPUT_SLACK_BYTES;
}

/** The stream header says bzip2 with the block size asked for, and the stream is long enough to hold an end marker. */
function assertBzip2Framing(stream: Buffer, blockUnits: number): void {
  if (stream.length < BZIP2_MIN_STREAM_BYTES) throw new NativeBzip2Error('lbzip2 wrote a truncated stream.');
  if (!stream.subarray(0, BZIP2_MAGIC.length).equals(BZIP2_MAGIC) || stream[BZIP2_STREAM_HEADER_BYTES - 1] !== ASCII_DIGIT_ZERO + blockUnits) {
    throw new NativeBzip2Error('lbzip2 wrote a stream header that is not bzip2 with the block size asked for.');
  }
}

/**
 * The bzip2 stream of `segments` joined (never copied into one buffer first: they are piped in order) at a product level.
 * Throws NativeBzip2Error for any outcome other than a stream with the right framing, so the caller can hand the request to the
 * 7-Zip route; an abort and a missing sandbox are rethrown as they are.
 */
export async function bzip2WithLbzip2(segments: readonly Uint8Array[], inputBytes: number, productLevel: number, runtime: NativeBzip2Runtime = {}): Promise<Buffer> {
  const binary = getLbzip2Path();
  if (binary === null) throw new NativeBzip2Error('lbzip2 is not installed.');
  const blockUnits = bzip2BlockUnitsOfLevel(productLevel);
  let stream: Buffer;
  try {
    const run = await executeSandboxedBinary(binary, ['-c', `-${blockUnits}`, '-n', String(os.availableParallelism())], {
      stdin: Readable.from(segments, { objectMode: false }),
      maxBuffer: worstCaseOutputBytes(inputBytes),
      timeoutMs: runtime.timeoutMs ?? CPU_POOL_TASK_TIMEOUT_MS,
      networkIsolated: true,
      signal: runtime.signal,
    });
    stream = run.stdout;
  } catch (error) {
    if (runtime.signal?.aborted) throw error;
    rethrowSandboxUnavailable(error);
    throw new NativeBzip2Error(`lbzip2 failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  assertBzip2Framing(stream, blockUnits);
  return stream;
}
