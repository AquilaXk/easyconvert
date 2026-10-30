import { CorruptStreamError, CpuTaskTimeoutError, DecompressionLimitError, type ConversionOptions } from '../types';
import {
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { CPU_POOL_TASK_TIMEOUT_MS } from '../workers/cpu-pool';
import { stageTimeoutMs } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';

const XZ_BINARY = 'xz';
const XZ_ENV = 'XZ_PATH';
const XZ_CANDIDATES = ['/usr/bin/xz', '/usr/local/bin/xz', '/opt/homebrew/bin/xz'];

/** Location of `xz`, or null when it is not installed (an override that names no file counts as not installed). */
export function getXzBinaryPath(): string | null {
  return resolveBinaryPath(XZ_ENV, XZ_CANDIDATES, XZ_BINARY);
}

const BYTES_PER_MIB = 1024 * 1024;

/**
 * One thread for every native run. From xz 5.6 the default is all cores: `xz -9 -vv` reports 14,990 MiB required with
 * 12 threads against 674 MiB with `-T1`, the stream it writes differs, and RLIMIT_CPU counts the CPU time of every
 * thread. The address-space limits below were measured with this option, so they hold only with it.
 */
const XZ_SINGLE_THREAD = '-T1';

/**
 * Address space the native `xz` may map to compress. The xz(1) memory table puts preset -9 at 674 MiB; measured with
 * `prlimit --as`, -9 fails at 500 MiB and passes at 700 MiB, so 1 GiB leaves room for the C library and the stack.
 */
const COMPRESS_ADDRESS_SPACE_BYTES = 1024 * BYTES_PER_MIB;

/**
 * Memory the native `xz` may use to decode: far above any preset (the largest, -9, needs 65 MiB), far below the
 * 1.5 GiB a header can announce. A stream that asks for more is refused with a 413.
 */
const DECODE_MEMLIMIT_BYTES = 256 * BYTES_PER_MIB;

/** The decoder's own limit plus the C library, the stack and the buffers around the dictionary. */
const DECODE_ADDRESS_SPACE_BYTES = DECODE_MEMLIMIT_BYTES + 256 * BYTES_PER_MIB;

/** xz(1) EXIT STATUS: 1 is an error (a refused stream), 2 a warning (for example a reserved integrity check). */
const XZ_EXIT_ERROR = 1;
const XZ_MEMORY_REFUSAL = /memory usage limit reached|cannot allocate memory/i;
const XZ_UNSUPPORTED_OPTIONS = /unsupported options/i;

/**
 * Runs the native `xz` on uploaded bytes in the process sandbox (network and user namespaces, sanitized environment,
 * no shell) with the address space and CPU time capped, the stage limit held to the time the job has left, and the
 * job's signal. The output is a pipe, so `maxBuffer` is its size cap. A run past the stage limit is a
 * CpuTaskTimeoutError, the type `dispatch.ts` gives other tools that outrun their limit.
 */
async function runNativeXz(
  xzBin: string,
  args: string[],
  stdin: Buffer,
  options: ConversionOptions,
  addressSpaceBytes: number,
  maxBuffer: number,
  task: string
): Promise<Buffer> {
  const timeoutMs = stageTimeoutMs(options, CPU_POOL_TASK_TIMEOUT_MS);
  try {
    const run = await executeSandboxedBinary(xzBin, args, {
      stdin,
      maxBuffer,
      timeoutMs,
      networkIsolated: true,
      signal: options.signal,
      rlimits: { asBytes: addressSpaceBytes, cpuSeconds: Math.ceil(timeoutMs / 1000) },
    });
    return run.stdout;
  } catch (error) {
    if (error instanceof SandboxedTimeoutError && !options.signal?.aborted) throw new CpuTaskTimeoutError(task, error.timeoutMs);
    throw error;
  }
}

/**
 * Rethrows what no other engine may answer for: the job's abort, a host that cannot confine the child
 * (SandboxUnavailableError) and a run past its time limit. Returns for any other failure of the native run.
 */
export function rethrowUnlessFallback(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw error;
  rethrowSandboxUnavailable(error);
  if (error instanceof CpuTaskTimeoutError) throw error;
}

/**
 * The typed refusal for a stream the native decoder ran on and rejected, or null when the native run said nothing
 * about the stream. Exit 1 with "Unsupported options" (a build older than the filter the file uses) and exit 2 (a
 * warning such as a reserved integrity check) are left to the in-process reader, which names those cases.
 */
function decodeRefusal(error: unknown, maxOutputBytes: number): Error | null {
  if (error instanceof SandboxedBufferLimitError) {
    return new DecompressionLimitError(`Archive bomb detected: uncompressed size exceeds limit of ${maxOutputBytes} bytes (500MB)`);
  }
  const memoryRefusal = new DecompressionLimitError(
    `Invalid XZ archive: decoding needs more than the ${DECODE_MEMLIMIT_BYTES / BYTES_PER_MIB} MiB memory limit`
  );
  if (error instanceof SandboxedMemoryLimitError) return memoryRefusal;
  if (!(error instanceof SandboxedProcessError) || error.exitCode !== XZ_EXIT_ERROR) return null;
  if (XZ_MEMORY_REFUSAL.test(error.stderr)) return memoryRefusal;
  if (XZ_UNSUPPORTED_OPTIONS.test(error.stderr)) return null;
  return new CorruptStreamError(`Invalid XZ archive: ${error.stderr.trim() || 'the stream was refused'}`);
}

/**
 * Compresses with the native `xz` at `level`, or returns null when it is not installed or its run failed for a reason
 * the pure encoder may answer (it ran out of memory or died). The abort, an unconfined host and a run past the stage
 * limit are thrown.
 */
export async function compressWithNativeXz(
  level: number,
  input: Buffer,
  options: ConversionOptions,
  maxOutputBytes: number
): Promise<Buffer | null> {
  const xzBin = getXzBinaryPath();
  if (!xzBin) return null;
  try {
    return await runNativeXz(
      xzBin,
      [XZ_SINGLE_THREAD, `-${level}`, '-c', '-q'],
      input,
      options,
      COMPRESS_ADDRESS_SPACE_BYTES,
      maxOutputBytes,
      '.xz compression'
    );
  } catch (error) {
    rethrowUnlessFallback(error, options.signal);
    return null;
  }
}

/**
 * Decodes with the native `xz`, or returns null when it is not installed or cannot judge the stream (see
 * `decodeRefusal`). A stream it ran on and refused is thrown as a typed error: output past `maxOutputBytes` or a
 * decoder past its memory limit is a 413, a damaged stream is a CorruptStreamError, and a run past the stage limit is
 * a CpuTaskTimeoutError. The abort and an unconfined host are thrown too.
 */
export async function decompressWithNativeXz(input: Buffer, options: ConversionOptions, maxOutputBytes: number): Promise<Buffer | null> {
  const xzBin = getXzBinaryPath();
  if (!xzBin) return null;
  try {
    return await runNativeXz(
      xzBin,
      ['-d', XZ_SINGLE_THREAD, '-c', '-q', `--memlimit-decompress=${DECODE_MEMLIMIT_BYTES}`],
      input,
      options,
      DECODE_ADDRESS_SPACE_BYTES,
      maxOutputBytes,
      '.xz decompression'
    );
  } catch (error) {
    rethrowUnlessFallback(error, options.signal);
    const refusal = decodeRefusal(error, maxOutputBytes);
    if (refusal) throw refusal;
    return null;
  }
}
