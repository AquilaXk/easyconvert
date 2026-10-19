import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SandboxUnavailableError } from '../types';
import { HelperHost, HelperSlot } from './helper-process';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  type SandboxedExecutionOptions,
  type SandboxedExecutionResult,
} from './process-sandbox';
import {
  encodeFrame,
  FrameReader,
  isBadFrame,
  type LauncherErrorDetail,
  type LauncherReply,
  type LauncherRequest,
  type LaunchedRunOptions,
} from './sandbox-launcher-protocol';

/**
 * Starts sandboxed programs from a small helper process instead of from this one.
 *
 * Node starts a program with fork(), which copies the page tables of the whole process: on a Linux host the start of
 * a program takes about 4 ms per gigabyte the process has mapped, on top of the roughly 2 ms a small PDF tool needs to
 * run. A worker that holds a few hundred megabytes of documents, fonts and models therefore spends more time starting
 * qpdf than qpdf spends working. The helper (sandbox-launcher-child.ts) stays small, and its fork costs the same
 * whatever this process holds. It starts every program through executeSandboxedBinary, so the environment, the network
 * namespace, the resource limits, the time limit and the output limit are the ones the caller asked for.
 *
 * The helper starts on first use, in the background: until it has said it is ready a program runs directly, as it did
 * before, so no request waits for a process to boot. A helper that dies fails the requests it held (the programs
 * it had started die with it) and the next request runs directly while a new helper starts.
 *
 * The helper is not free: a request and its reply cross two pipes, which adds wake-ups, and the output is copied once
 * more. So a program is started through it only when the fork it saves costs more than that: the saving grows with the
 * memory this process has mapped, the copy with the size of the output (see launchPays).
 *
 * `SANDBOX_LAUNCHER=off` turns the helper off.
 */

export const SANDBOX_LAUNCHER_ENV = 'SANDBOX_LAUNCHER';

const CHILD_FILE = 'sandbox-launcher-child';
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');
/** The helper holds no document of its own: pipes and a few buffers. */
const CHILD_HEAP_MB = 128;
/**
 * Cost model of the choice between starting a program here and through the helper, fitted to runs of qpdf on small PDFs
 * on a 4-core Linux VM (a worker's memory was varied from 110 to 430 MB, and PDFs from 20 to 445 KB):
 *  - a fork costs 4.2 ms per gigabyte of resident memory above BASELINE_RESIDENT_BYTES. The first part of a process is
 *    code and read-only data that a fork does not copy, and the helper's own wake-ups cost about as much as the fork of
 *    that part, so the two cancel: at the baseline the helper and the direct start take the same time;
 *  - the helper moves the output once more on its way back, through a pipe that holds 64 KB at a time: the copies and
 *    the wake-ups of the many reads cost up to 2.5 ms per megabyte, measured on 150 and 445 KB outputs in the parity
 *    run, where the break-even was lower than a copy alone would give.
 */
const FORK_MS_PER_BYTE = 4.2e-9;
const BASELINE_RESIDENT_BYTES = 112 * 1024 * 1024;
const COPY_MS_PER_BYTE = 2.5e-6;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
/** Without a hint the output is taken to be a quarter of the limit (the callers size the limit as a multiple of the input). */
const DEFAULT_OUTPUT_SHARE = 4;
/** Longest the helper may take to boot and say it is ready. */
const BOOT_TIMEOUT_MS = 30_000;

export type LaunchedExecutionOptions = Pick<
  SandboxedExecutionOptions,
  'timeoutMs' | 'maxBuffer' | 'env' | 'cwd' | 'networkIsolated' | 'strictIsolation' | 'sandboxOptions' | 'memoryLimitMb' | 'maxFileSize' | 'rlimits' | 'signal'
> & {
  stdin?: Buffer | null;
  /** About how many bytes the program prints; what the helper has to copy back. Defaults to a quarter of `maxBuffer`. */
  expectedOutputBytes?: number;
};

export function sandboxLauncherEnabled(): boolean {
  return process.env[SANDBOX_LAUNCHER_ENV]?.trim().toLowerCase() !== 'off';
}

type ChildEntry = { binary: string; args: string[] };

let childEntry: ChildEntry | null | undefined;

/** How the helper is started (the command and arguments), or null when it cannot be; exported for the tests that run the helper on its own. */
export function sandboxLauncherChildEntry(): ChildEntry | null {
  return resolveChildEntry();
}

/** The command that runs the helper from the source through tsx, or null when tsx cannot be found. */
function sourceEntry(source: string, heap: string, searchFrom: readonly string[]): ChildEntry | null {
  let tsxApi: string | null = null;
  try {
    tsxApi = createRequire(path.join(searchFrom[0], 'package.json')).resolve(TSX_REGISTER_SPECIFIER, { paths: [...searchFrom] });
  } catch {
    tsxApi = null;
  }
  if (!tsxApi) return null;
  return { binary: process.execPath, args: [heap, '-e', `require(${JSON.stringify(tsxApi)}).register(); require(${JSON.stringify(source)});`] };
}

const modifiedAt = (file: string): number => fs.statSync(file).mtimeMs;

/**
 * How to start the helper, or null when it cannot be:
 *  1. the source beside this module, through tsx: whoever runs the source (development, tests) gets the helper of the
 *     source, never a build under `dist/` that may be older;
 *  2. the bundled file next to this module or under `dist/` of the working directory, unless the working directory also
 *     holds a newer source;
 *  3. the source under `src/` of the working directory, through tsx.
 */
export function resolveLauncherChildEntry(moduleDir: string, cwd: string): ChildEntry | null {
  const heap = `--max-old-space-size=${CHILD_HEAP_MB}`;
  const searchFrom = [cwd, moduleDir, __dirname];
  const beside = path.join(moduleDir, `${CHILD_FILE}.ts`);
  if (fs.existsSync(beside)) {
    const entry = sourceEntry(beside, heap, searchFrom);
    if (entry) return entry;
  }
  const cwdSource = path.join(cwd, 'src', 'lib', 'security', `${CHILD_FILE}.ts`);
  const sourceTime = fs.existsSync(cwdSource) ? modifiedAt(cwdSource) : 0;
  const compiled = [path.join(moduleDir, `${CHILD_FILE}.js`), path.join(cwd, 'dist', `${CHILD_FILE}.js`)].find(
    (candidate) => fs.existsSync(candidate) && modifiedAt(candidate) >= sourceTime
  );
  if (compiled) return { binary: process.execPath, args: [heap, compiled] };
  return fs.existsSync(cwdSource) ? sourceEntry(cwdSource, heap, searchFrom) : null;
}

function resolveChildEntry(): ChildEntry | null {
  if (childEntry === undefined) childEntry = resolveLauncherChildEntry(__dirname, process.cwd());
  return childEntry;
}

function toError(detail: LauncherErrorDetail, payload: Buffer): Error {
  switch (detail.kind) {
    case 'process': {
      const stdoutBytes = detail.stdoutBytes ?? 0;
      return new SandboxedProcessError(
        detail.message,
        detail.exitCode ?? null,
        payload.toString('utf8', stdoutBytes),
        detail.signal ?? null,
        payload.toString('utf8', 0, stdoutBytes)
      );
    }
    case 'timeout':
      return new SandboxedTimeoutError(detail.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    case 'buffer':
      return new SandboxedBufferLimitError(detail.limitBytes ?? 0);
    case 'memory':
      return new SandboxedMemoryLimitError(detail.limitMb ?? 0);
    case 'unavailable':
      return new SandboxUnavailableError(detail.message);
    default:
      return new Error(detail.message);
  }
}

/** One running helper. */
class LauncherHost extends HelperHost {
  private readonly reader = new FrameReader<LauncherReply>();

  constructor(entry: ChildEntry) {
    super(entry, 'the launcher', (reason) => new SandboxedProcessError(`Sandboxed execution error: ${reason}`, null, reason));
  }

  run(binary: string, args: string[], options: LaunchedExecutionOptions): Promise<SandboxedExecutionResult> {
    return new Promise<SandboxedExecutionResult>((resolve, reject) => {
      const id = this.allocateId();
      const { stdin, signal, ...rest } = options;
      const runOptions: LaunchedRunOptions = { ...rest, strictIsolation: options.strictIsolation ?? process.env.STRICT_SANDBOX === 'true' };
      const request: LauncherRequest = { type: 'run', id, binary, args, hasStdin: Boolean(stdin), options: runOptions };
      this.enroll({ id, timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, signal, cancel: () => this.send({ type: 'cancel', id }), resolve, reject, extra: {} });
      this.send(request, stdin ?? undefined);
    });
  }

  private send(header: LauncherRequest, payload?: Buffer): void {
    this.write(encodeFrame(header, ...(payload ? [payload] : [])));
  }

  protected onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch {
      this.stop(true);
      return;
    }
    for (const frame of frames) {
      if (isBadFrame(frame)) {
        // A reply that can be attributed fails its own request; one that cannot leaves nothing to trust.
        if (frame.id === undefined || !this.pending.has(frame.id)) {
          this.stop(true);
          return;
        }
        this.fail(frame.id, new SandboxedProcessError(`Sandboxed execution error: the launcher sent a reply that could not be read (${frame.reason})`, null, frame.reason));
        continue;
      }
      const { header, payload } = frame;
      if (header.type === 'ready') {
        this.markReady();
      } else if (this.pending.get(header.id)?.aborted) {
        // Answered after the caller aborted (the program ended on its own, or was killed): the caller aborted.
        this.fail(header.id, this.pending.get(header.id)?.aborted?.reason);
      } else if (header.type === 'result') {
        this.settle(header.id)?.resolve({
          stdout: payload.subarray(0, header.stdoutBytes),
          stderr: payload.subarray(header.stdoutBytes),
          exitCode: header.exitCode,
          durationMs: header.durationMs,
          sandboxed: header.sandboxed,
          sandboxType: header.sandboxType,
        });
      } else {
        this.fail(header.id, toError(header.error, payload));
      }
    }
  }
}

const slot = new HelperSlot<LauncherHost>(
  sandboxLauncherEnabled,
  () => {
    const entry = resolveChildEntry();
    return entry ? new LauncherHost(entry) : null;
  },
  BOOT_TIMEOUT_MS
);
let launchedCount = 0;
let directCount = 0;

/** Starts the helper if there is none and resolves true once it is ready; false when it is turned off, missing or could not start. */
export function startSandboxLauncher(): Promise<boolean> {
  return slot.start();
}

/** Ends the helper and the programs it still runs. */
export function stopSandboxLauncher(): void {
  slot.stop();
}

export function sandboxLauncherState(): { ready: boolean; pid: number | undefined; launched: number; direct: number } {
  const ready = slot.ready;
  return { ready: ready !== null, pid: ready?.pid, launched: launchedCount, direct: directCount };
}

/** Whether the fork saved by the helper costs more than the helper does, for a process of this size and an output of this size. */
export function launchPays(residentBytes: number, expectedOutputBytes: number): boolean {
  return (residentBytes - BASELINE_RESIDENT_BYTES) * FORK_MS_PER_BYTE > expectedOutputBytes * COPY_MS_PER_BYTE;
}

/**
 * Like executeSandboxedBinary, started from the helper when one is ready and it pays. The result and the errors are the same.
 * Standard input is a Buffer or nothing.
 */
export function launchSandboxedBinary(binary: string, args: string[], options: LaunchedExecutionOptions = {}): Promise<SandboxedExecutionResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES;
  const { expectedOutputBytes = maxBuffer / DEFAULT_OUTPUT_SHARE, ...forwarded } = options;
  const current = slot.ready;
  if (!current) void slot.start();
  if (!current || options.signal?.aborted || !sandboxLauncherEnabled() || !launchPays(process.memoryUsage.rss(), expectedOutputBytes)) {
    directCount++;
    return executeSandboxedBinary(binary, args, forwarded);
  }
  launchedCount++;
  return current.run(binary, args, forwarded);
}
