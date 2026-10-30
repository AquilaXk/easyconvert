import path from 'node:path';
import { CorruptStreamError, CpuTaskTimeoutError, DecompressionLimitError, UnsupportedArchiveMethodError, type ConversionOptions } from '../types';
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
const XZ_EXIT_WARNING = 2;
const XZ_MEMORY_REFUSAL = /memory usage limit reached|cannot allocate memory/i;
const XZ_STDIN_PREFIX = /^\(stdin\):\s*/;
/** The decode runs without `-q`: it hides warnings, and a warning is how xz reports an unsupported integrity check (exit 2). */
const XZ_UNSUPPORTED_CHECK = /unsupported type of integrity check/i;
/** The signals of a crashed decoder. Any other signal (a stop from outside) says nothing about the stream. */
const CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(['SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE']);

interface NativeXzJob {
  xzBin: string;
  args: string[];
  addressSpaceBytes: number;
  /** What a run past the stage limit is reported as (CpuTaskTimeoutError). */
  task: string;
}

/** What the sandboxed run did: the bytes xz wrote, or the failure of the run itself. */
type NativeXzRun = { stdout: Buffer } | { failure: unknown };

/**
 * Runs the native `xz` on uploaded bytes in the process sandbox (network and user namespaces, sanitized environment,
 * no shell) with the address space and CPU time capped, the stage limit held to the time the job has left, and the
 * job's signal. The output is a pipe, so `maxBuffer` is its size cap. What no other engine may answer for is thrown:
 * the job's abort, a host that cannot confine the child (SandboxUnavailableError) and a run past the stage limit,
 * which is a CpuTaskTimeoutError, the type `dispatch.ts` gives other tools that outrun their limit. Any other failure
 * is returned for the caller to classify.
 */
async function runNativeXz(job: NativeXzJob, stdin: Buffer, options: ConversionOptions, maxBuffer: number): Promise<NativeXzRun> {
  const timeoutMs = stageTimeoutMs(options, CPU_POOL_TASK_TIMEOUT_MS);
  try {
    const run = await executeSandboxedBinary(job.xzBin, job.args, {
      stdin,
      maxBuffer,
      timeoutMs,
      networkIsolated: true,
      signal: options.signal,
      rlimits: { asBytes: job.addressSpaceBytes, cpuSeconds: Math.ceil(timeoutMs / 1000) },
    });
    return { stdout: run.stdout };
  } catch (failure) {
    if (options.signal?.aborted) throw failure;
    rethrowSandboxUnavailable(failure);
    if (failure instanceof SandboxedTimeoutError) throw new CpuTaskTimeoutError(job.task, failure.timeoutMs);
    return { failure };
  }
}

/**
 * The message xz itself wrote, or null when the first line of stderr is not xz's. xz starts its diagnostics with the
 * name it was started under and a colon (`/usr/bin/xz: (stdin): Compressed data is corrupt`, or `xz: ...` where the C
 * library keeps only the base name); the `unshare` and `prlimit` wrappers start theirs with their own names, and a
 * failure of a wrapper says nothing about the stream. Only the first line is kept and the `(stdin): ` that names the
 * input is dropped.
 */
function xzOwnMessage(stderr: string, xzBin: string): string | null {
  const firstLine = stderr.split('\n', 1)[0].trim();
  const prefix = [xzBin, path.basename(xzBin)].map((name) => `${name}:`).find((candidate) => firstLine.startsWith(candidate));
  if (prefix === undefined) return null;
  return firstLine.slice(prefix.length).trim().replace(XZ_STDIN_PREFIX, '');
}

/**
 * The typed refusal for a stream the native decoder ran on and rejected, or null when the native run said nothing
 * about the stream. Refused: output past the byte cap, a decoder past its memory limit, a death by a crash signal,
 * an exit 2 whose own message reports an unsupported integrity check (a 422, the only exit 2 an upload chooses; the
 * in-process reader would decode the streams before it on the event loop) and an exit 1 whose message is xz's own,
 * "Unsupported options" included (the shipped xz knows every filter the reader knows, so a stream it rejects that way
 * is damaged). Left to the in-process reader, which names the case: any other exit 2, any other signal, a wrapper's
 * failure and a process that could not start.
 */
function decodeRefusal(failure: unknown, maxOutputBytes: number, xzBin: string): Error | null {
  const memoryRefusal = new DecompressionLimitError(
    `The XZ stream needs more than the ${DECODE_MEMLIMIT_BYTES / BYTES_PER_MIB} MiB decoder memory limit`
  );
  if (failure instanceof SandboxedBufferLimitError) {
    return new DecompressionLimitError(
      `Archive bomb detected: uncompressed size exceeds limit of ${maxOutputBytes} bytes (${Math.round(maxOutputBytes / BYTES_PER_MIB)}MB)`
    );
  }
  if (failure instanceof SandboxedMemoryLimitError) return memoryRefusal;
  if (!(failure instanceof SandboxedProcessError)) return null;
  if (failure.signal !== null) {
    return CRASH_SIGNALS.has(failure.signal) ? new CorruptStreamError(`Invalid XZ archive: the decoder was stopped by ${failure.signal}`) : null;
  }
  if (failure.exitCode !== XZ_EXIT_ERROR && failure.exitCode !== XZ_EXIT_WARNING) return null;
  const message = xzOwnMessage(failure.stderr, xzBin);
  if (message === null) return null;
  if (failure.exitCode === XZ_EXIT_WARNING) {
    return XZ_UNSUPPORTED_CHECK.test(message) ? new UnsupportedArchiveMethodError(`XZ archive: ${message}`) : null;
  }
  if (XZ_MEMORY_REFUSAL.test(message)) return memoryRefusal;
  return new CorruptStreamError(`Invalid XZ archive: ${message || 'the stream was refused'}`);
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
  const job = { xzBin, args: [XZ_SINGLE_THREAD, `-${level}`, '-c', '-q'], addressSpaceBytes: COMPRESS_ADDRESS_SPACE_BYTES, task: '.xz compression' };
  const run = await runNativeXz(job, input, options, maxOutputBytes);
  return 'stdout' in run ? run.stdout : null;
}

/**
 * Decodes with the native `xz`, or returns null when it is not installed or cannot judge the stream (see
 * `decodeRefusal`). A stream it ran on and refused is thrown as a typed error: output past `maxOutputBytes` or a
 * decoder past its memory limit is a 413, a damaged stream or a death by signal is a CorruptStreamError, and a run
 * past the stage limit is a CpuTaskTimeoutError. The abort and an unconfined host are thrown too.
 */
export async function decompressWithNativeXz(input: Buffer, options: ConversionOptions, maxOutputBytes: number): Promise<Buffer | null> {
  const xzBin = getXzBinaryPath();
  if (!xzBin) return null;
  const job = {
    xzBin,
    args: ['-d', XZ_SINGLE_THREAD, '-c', `--memlimit-decompress=${DECODE_MEMLIMIT_BYTES}`],
    addressSpaceBytes: DECODE_ADDRESS_SPACE_BYTES,
    task: '.xz decompression',
  };
  const run = await runNativeXz(job, input, options, maxOutputBytes);
  if ('stdout' in run) return run.stdout;
  const refusal = decodeRefusal(run.failure, maxOutputBytes, xzBin);
  if (refusal) throw refusal;
  return null;
}
