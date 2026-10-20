import os from 'node:os';
import path from 'node:path';
import { HelperHost, HelperSlot, type PendingJob } from '../../security/helper-process';
import {
  detectSandboxEnvironment,
  getSanitizedEnvironment,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  type SandboxedExecutionResult,
} from '../../security/process-sandbox';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../../security/sandbox-launcher';
import { resolveBinaryPath } from './utils';

/**
 * qpdf jobs from a process that holds libqpdf already loaded (native/qpdf-runner).
 *
 * Starting the qpdf program costs more than a small page operation: 1.26 ms of the 2.14 ms of an extraction are the dynamic
 * linker and the initialisers of its libraries. The runner loads libqpdf once and forks a child per job that calls the library
 * entry point of the command line with the same arguments, so the output, the messages on standard error and the exit status
 * are the program's. Every child makes a user namespace and a network namespace of its own before it reads a byte of the
 * document, and shares nothing with another job (see the header of native/qpdf-runner/qpdf-runner.c).
 *
 * The runner is an addition, never a requirement. A job goes through it only when it is up and the job is one it can take; in
 * every other case, and whenever the runner cannot start the job or says it cannot isolate it, the job is started the way it always
 * was (launchSandboxedBinary), with the same sandbox and the same typed errors. `QPDF_RUNNER=off` turns the runner off.
 */

export const QPDF_RUNNER_ENV = 'QPDF_RUNNER';
export const QPDF_RUNNER_PATH_ENV = 'QPDF_RUNNER_PATH';
/** The library the runner loads, for a host that keeps libqpdf out of the standard places (and for the tests, which load a stand-in). */
export const QPDF_RUNNER_LIB_ENV = 'QPDF_RUNNER_LIB';

const RUNNER_CANDIDATES = ['/usr/local/bin/qpdf-runner', '/usr/bin/qpdf-runner'];
const FRAME_RUN = 1;
const FRAME_CANCEL = 2;
const FRAME_READY = 10;
const FRAME_RESULT = 11;
const KIND_EXITED = 0;
const KIND_TIMEOUT = 1;
const KIND_OUTPUT_LIMIT = 2;
const KIND_SETUP = 3;
const KIND_CANCELLED = 4;
const KIND_REJECTED = 5;
const FRAME_PREFIX_BYTES = 5;
/** The longest reply the host reads: the output cap (1 GiB) and a few fixed fields. */
const MAX_REPLY_BYTES = (1 << 30) + 1024;
/** What the runner reads of a request (qpdf-runner.c): a frame, a string, the arguments, the environment and the standard input. */
const MAX_REQUEST_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 4096;
const MAX_STDIN_BYTES = 32 * 1024;
const MAX_U32 = 0xffff_ffff;
/** The most output the runner takes a job to print (the length of a reply is 32 bits). */
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;
const SIGKILL = 9;
const SIGSEGV = 11;
const SIGXFSZ = 25;
const SIGNAL_NAMES: Readonly<Record<number, NodeJS.Signals>> = { [SIGKILL]: 'SIGKILL', [SIGSEGV]: 'SIGSEGV', [SIGXFSZ]: 'SIGXFSZ', 6: 'SIGABRT', 15: 'SIGTERM', 24: 'SIGXCPU' };

export function qpdfRunnerEnabled(): boolean {
  return process.env[QPDF_RUNNER_ENV]?.trim().toLowerCase() !== 'off';
}

/** Raised for a job the runner could not take or could not isolate: the caller starts it the usual way. */
export class RunnerDeclined extends Error {}

// --- Frames ---------------------------------------------------------------------------------------------------------------

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(value))));
  return out;
}

function frame(type: number, id: number, ...body: Buffer[]): Buffer[] {
  const length = FRAME_PREFIX_BYTES + body.reduce((sum, part) => sum + part.length, 0);
  const head = Buffer.alloc(9);
  head.writeUInt32BE(length, 0);
  head.writeUInt8(type, 4);
  head.writeUInt32BE(id, 5);
  return [head, ...body.filter((part) => part.length > 0)];
}

interface RunRequest {
  timeoutMs: number;
  maxOutput: number;
  limitAsBytes: number;
  limitFsizeBytes: number;
  limitCpuSeconds: number;
  cwd: string;
  argv: string[];
  env: string[];
  stdin: Buffer;
}

/** A string as the runner reads it: its bytes, which hold no NUL (a C string would end there) and are not longer than it takes. */
function text(value: string, what: string): Buffer[] {
  if (value.includes('\0')) throw new RunnerDeclined(`${what} holds a NUL`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_STRING_BYTES) throw new RunnerDeclined(`${what} is longer than ${MAX_STRING_BYTES} bytes`);
  return [u32(bytes.length), bytes];
}

function assertWithin(value: number, most: number, what: string): void {
  if (!Number.isFinite(value) || value < 0 || value > most) throw new RunnerDeclined(`${what} is out of range`);
}

/**
 * The frame of a job. A job past what the runner takes (a frame, string, argument count or standard input past its limits, a NUL in a
 * string, a working directory that is not absolute) is declined here, before anything is sent: the runner would refuse it, and a NUL
 * would end a path early.
 */
export function encodeRun(id: number, request: RunRequest): Buffer[] {
  assertWithin(request.timeoutMs, MAX_U32, 'the time limit');
  assertWithin(request.limitCpuSeconds, MAX_U32, 'the CPU limit');
  assertWithin(request.limitAsBytes, Number.MAX_SAFE_INTEGER, 'the address-space limit');
  assertWithin(request.limitFsizeBytes, Number.MAX_SAFE_INTEGER, 'the file-size limit');
  if (!(request.maxOutput >= 1 && request.maxOutput <= MAX_OUTPUT_BYTES)) throw new RunnerDeclined('the output limit is out of range');
  if (!request.cwd.startsWith('/')) throw new RunnerDeclined('the working directory is not absolute');
  if (request.argv.length === 0 || request.argv.length > MAX_ARGUMENTS) throw new RunnerDeclined('the number of arguments is out of range');
  if (request.env.length > MAX_ARGUMENTS) throw new RunnerDeclined('the environment has too many entries');
  if (request.stdin.length > MAX_STDIN_BYTES) throw new RunnerDeclined(`the standard input is longer than ${MAX_STDIN_BYTES} bytes`);
  const body = [
    u32(request.timeoutMs),
    u64(request.maxOutput),
    u64(request.limitAsBytes),
    u64(request.limitFsizeBytes),
    u32(request.limitCpuSeconds),
    ...text(request.cwd, 'the working directory'),
    u32(request.argv.length),
    ...request.argv.flatMap((argument) => text(argument, 'an argument')),
    u32(request.env.length),
    ...request.env.flatMap((entry) => text(entry, 'an environment entry')),
    u32(request.stdin.length),
    request.stdin,
  ];
  if (FRAME_PREFIX_BYTES + body.reduce((sum, part) => sum + part.length, 0) > MAX_REQUEST_FRAME_BYTES) throw new RunnerDeclined('the request is longer than a frame');
  return frame(FRAME_RUN, id, ...body);
}

interface Reply {
  type: number;
  id: number;
  body: Buffer;
}

/**
 * Cuts the bytes the runner writes into frames. A frame is joined once, when the last of its bytes has arrived: the length it needs is
 * read from its first four bytes and the chunks wait until they add up to it, so a reply of 100 MB that comes in 64 KB reads is copied
 * once and not once per read.
 */
export class ReplyReader {
  private chunks: Buffer[] = [];
  private total = 0;
  /** The bytes of the frame being read, its length field included; 0 until that field has arrived. */
  private needed = 0;

  push(chunk: Buffer): Reply[] {
    this.chunks.push(chunk);
    this.total += chunk.length;
    const replies: Reply[] = [];
    for (;;) {
      if (this.needed === 0) {
        if (this.total < 4) break;
        const length = this.peekLength();
        if (length < FRAME_PREFIX_BYTES || length > MAX_REPLY_BYTES) throw new Error('the runner sent a frame of an impossible length');
        this.needed = 4 + length;
      }
      if (this.total < this.needed) break;
      const joined = this.join();
      replies.push({ type: joined.readUInt8(4), id: joined.readUInt32BE(5), body: joined.subarray(9, this.needed) });
      const rest = joined.subarray(this.needed);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
      this.needed = 0;
    }
    return replies;
  }

  /** The length field, which may be split over the first chunks. */
  private peekLength(): number {
    let length = 0;
    let read = 0;
    for (const chunk of this.chunks) {
      for (let at = 0; at < chunk.length && read < 4; at++, read++) length = length * 256 + chunk[at];
      if (read === 4) break;
    }
    return length;
  }

  private join(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.total)];
    return this.chunks[0];
  }
}

interface JobResult {
  kind: number;
  exitStatus: number;
  signal: number;
  stdout: Buffer;
  stderr: Buffer;
}

function decodeResult(body: Buffer): JobResult {
  const stdoutBytes = body.readUInt32BE(12);
  const stderrBytes = body.readUInt32BE(16);
  if (body.length !== 20 + stdoutBytes + stderrBytes) throw new Error('the runner sent a result of the wrong size');
  return {
    kind: body.readUInt32BE(0),
    exitStatus: body.readInt32BE(4),
    signal: body.readInt32BE(8),
    stdout: body.subarray(20, 20 + stdoutBytes),
    stderr: body.subarray(20 + stdoutBytes),
  };
}

// --- Errors ---------------------------------------------------------------------------------------------------------------

/** The failure of a program that ran and did not succeed, as executeSandboxedBinary reports it. */
function processFailure(result: JobResult, options: LaunchedExecutionOptions): Error {
  const signal = result.signal === 0 ? null : (SIGNAL_NAMES[result.signal] ?? (`SIG${result.signal}` as NodeJS.Signals));
  const memoryLimitMb = options.memoryLimitMb ?? (options.rlimits?.asBytes ? Math.round(options.rlimits.asBytes / BYTES_PER_MB) : undefined);
  if ((result.signal === SIGKILL || result.signal === SIGSEGV) && memoryLimitMb && memoryLimitMb > 0) return new SandboxedMemoryLimitError(memoryLimitMb);
  if (result.signal === SIGXFSZ) return new SandboxedBufferLimitError(options.maxFileSize || options.rlimits?.fsizeBytes || options.maxBuffer || DEFAULT_MAX_BUFFER_BYTES);
  const stderrText = result.stderr.toString('utf8').trim();
  let summary: string;
  if (signal !== null) summary = stderrText ? `Process terminated by signal ${signal}: ${stderrText}` : `Process terminated by signal ${signal}`;
  else summary = stderrText || `Process exited with code ${result.exitStatus}`;
  return new SandboxedProcessError(summary, signal === null ? result.exitStatus : null, result.stderr.toString('utf8'), signal, result.stdout.toString('utf8'));
}

// --- The runner process ---------------------------------------------------------------------------------------------------

/** What the runner job holds beyond the common parts: the options its errors are worded from, and when it started. */
interface RunnerJob {
  options: LaunchedExecutionOptions;
  startedAt: number;
}

class RunnerHost extends HelperHost<RunnerJob> {
  private readonly reader = new ReplyReader();
  version = '';

  constructor(binary: string) {
    const library = process.env[QPDF_RUNNER_LIB_ENV]?.trim();
    // A job the runner held died with it: the caller starts it the usual way.
    super({ binary, args: library ? ['--lib', library] : [] }, 'the runner', (reason) => new RunnerDeclined(reason));
  }

  run(binary: string, args: string[], options: LaunchedExecutionOptions): Promise<SandboxedExecutionResult> {
    return new Promise<SandboxedExecutionResult>((resolve, reject) => {
      const id = this.allocateId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      const environment = getSanitizedEnvironment(options.env ?? {}, true);
      const request: RunRequest = {
        timeoutMs,
        maxOutput: options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES,
        limitAsBytes: options.rlimits?.asBytes ?? (options.memoryLimitMb ? options.memoryLimitMb * BYTES_PER_MB : 0),
        limitFsizeBytes: options.rlimits?.fsizeBytes ?? options.maxFileSize ?? 0,
        limitCpuSeconds: options.rlimits?.cpuSeconds ?? 0,
        cwd: options.cwd ?? os.tmpdir(),
        argv: [path.basename(binary), ...args],
        env: Object.entries(environment).flatMap(([key, value]) => (typeof value === 'string' ? [`${key}=${value}`] : [])),
        stdin: options.stdin ?? Buffer.alloc(0),
      };
      // Declined here, before a timer or a pending entry exists, when the job is past what the runner takes.
      const parts = encodeRun(id, request);
      this.enroll({ id, timeoutMs, signal: options.signal, cancel: () => this.write(frame(FRAME_CANCEL, id)), resolve, reject, extra: { options, startedAt: Date.now() } });
      this.write(parts);
    });
  }

  protected onData(chunk: Buffer): void {
    let replies: Reply[];
    try {
      replies = this.reader.push(chunk);
    } catch {
      this.stop(true);
      return;
    }
    for (const reply of replies) {
      try {
        this.handle(reply);
      } catch {
        // A reply that cannot be read leaves nothing to trust.
        this.stop(true);
        return;
      }
    }
  }

  private handle(reply: Reply): void {
    if (reply.type === FRAME_READY) {
      const length = reply.body.readUInt32BE(0);
      this.version = reply.body.toString('utf8', 4, 4 + length);
      this.markReady();
      return;
    }
    if (reply.type !== FRAME_RESULT) throw new Error('the runner sent an unknown frame');
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    if (pending.aborted) {
      this.fail(reply.id, pending.aborted.reason);
      return;
    }
    const result = decodeResult(reply.body);
    this.settle(reply.id);
    this.complete(pending, result);
  }

  private complete(pending: PendingJob<RunnerJob>, result: JobResult): void {
    const { options } = pending;
    switch (result.kind) {
      case KIND_EXITED:
        if (result.exitStatus === 0 && result.signal === 0) {
          const sandbox = detectSandboxEnvironment();
          pending.resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
            durationMs: Date.now() - pending.startedAt,
            sandboxed: sandbox.sandboxType !== 'host',
            sandboxType: sandbox.sandboxType,
          });
        } else {
          pending.reject(processFailure(result, options));
        }
        return;
      case KIND_TIMEOUT:
        pending.reject(new SandboxedTimeoutError(options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS));
        return;
      case KIND_OUTPUT_LIMIT:
        pending.reject(new SandboxedBufferLimitError(options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES));
        return;
      case KIND_CANCELLED:
        pending.reject(new Error('The operation was aborted'));
        return;
      case KIND_SETUP:
      case KIND_REJECTED:
      default:
        pending.reject(new RunnerDeclined(result.stderr.toString('utf8') || `setup failed (${result.kind})`));
    }
  }
}

let ranCount = 0;
let fallbackCount = 0;

/** The runner program: the path in the environment, else the standard places; null when there is none. */
function runnerBinary(): string | null {
  return resolveBinaryPath(QPDF_RUNNER_PATH_ENV, RUNNER_CANDIDATES, 'qpdf-runner');
}

// A runner that never booted (no library, no program), or ended without being stopped, is not replaced at once.
const slot = new HelperSlot<RunnerHost>(
  qpdfRunnerEnabled,
  () => {
    const binary = runnerBinary();
    return binary ? new RunnerHost(binary) : null;
  },
  BOOT_TIMEOUT_MS
);

/** Starts the runner if there is none and resolves true once it is ready; false when it is off, missing or could not start. */
export function startQpdfRunner(): Promise<boolean> {
  return slot.start();
}

/** Ends the runner and the jobs it still runs. */
export function stopQpdfRunner(): void {
  slot.stop();
}

export function qpdfRunnerState(): { ready: boolean; pid: number | undefined; version: string; ran: number; fallbacks: number } {
  const ready = slot.ready;
  return { ready: ready !== null, pid: ready?.pid, version: slot.current?.version ?? '', ran: ranCount, fallbacks: fallbackCount };
}

/** Whether the runner can take this job: qpdf itself, isolated, with the limits and the standard input it knows. */
function runnerCanTake(binary: string, options: LaunchedExecutionOptions): boolean {
  if (path.basename(binary) !== 'qpdf') return false;
  if (options.networkIsolated === false || options.sandboxOptions !== undefined || options.rlimits?.nproc !== undefined) return false;
  if (options.signal?.aborted) return false;
  return (options.stdin?.length ?? 0) <= MAX_STDIN_BYTES && (options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES) <= MAX_OUTPUT_BYTES;
}

/**
 * Like launchSandboxedBinary for a qpdf run, started by the runner when it is up and takes the job. The result and the errors are
 * those of the usual way, which also starts the job whenever the runner declines it or cannot isolate it.
 */
export async function launchQpdf(binary: string, args: string[], options: LaunchedExecutionOptions = {}): Promise<SandboxedExecutionResult> {
  const current = slot.ready;
  if (!current) void slot.start();
  if (!current || !qpdfRunnerEnabled() || !runnerCanTake(binary, options)) {
    fallbackCount++;
    return launchSandboxedBinary(binary, args, options);
  }
  try {
    const result = await current.run(binary, args, options);
    ranCount++;
    return result;
  } catch (error) {
    if (!(error instanceof RunnerDeclined)) {
      // The job ran and failed (or was stopped): that is its outcome, the same as the usual way's.
      ranCount++;
      throw error;
    }
    fallbackCount++;
    return launchSandboxedBinary(binary, args, options);
  }
}
