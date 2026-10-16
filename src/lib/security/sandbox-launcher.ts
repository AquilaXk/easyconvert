import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { SandboxUnavailableError } from '../types';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  killProcessGroup,
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
/** Wall-clock a reply may take beyond the run's own time limit before the helper is judged lost. */
const REPLY_ALLOWANCE_MS = 10_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
/** Without a hint the output is taken to be a quarter of the limit (the callers size the limit as a multiple of the input). */
const DEFAULT_OUTPUT_SHARE = 4;
/** A helper that has served nothing for this long ends; the next request starts one. */
const IDLE_MS = 60_000;
/** Longest the helper may take to boot and say it is ready. */
const BOOT_TIMEOUT_MS = 30_000;
/** After a helper ended before it was ready, programs run directly for this long before another is tried. */
const RESTART_BACKOFF_MS = 30_000;

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

/** How to start the helper: the bundled file next to this module or under `dist/`, otherwise the source through tsx; null when neither exists. */
function resolveChildEntry(): ChildEntry | null {
  if (childEntry !== undefined) return childEntry;
  const heap = `--max-old-space-size=${CHILD_HEAP_MB}`;
  const compiled = [path.join(__dirname, `${CHILD_FILE}.js`), path.join(process.cwd(), 'dist', `${CHILD_FILE}.js`)].find((candidate) => fs.existsSync(candidate));
  if (compiled) {
    childEntry = { binary: process.execPath, args: [heap, compiled] };
    return childEntry;
  }
  const source = [path.join(__dirname, `${CHILD_FILE}.ts`), path.join(process.cwd(), 'src', 'lib', 'security', `${CHILD_FILE}.ts`)].find((candidate) => fs.existsSync(candidate));
  let tsxApi: string | null = null;
  try {
    tsxApi = createRequire(path.join(process.cwd(), 'package.json')).resolve(TSX_REGISTER_SPECIFIER);
  } catch {
    tsxApi = null;
  }
  if (source && tsxApi) {
    const bootstrap = `require(${JSON.stringify(tsxApi)}).register(); require(${JSON.stringify(source)});`;
    childEntry = { binary: process.execPath, args: [heap, '-e', bootstrap] };
    return childEntry;
  }
  childEntry = null;
  return childEntry;
}

interface Pending {
  resolve(result: SandboxedExecutionResult): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  detach(): void;
}

function toError(detail: LauncherErrorDetail): Error {
  switch (detail.kind) {
    case 'process':
      return new SandboxedProcessError(detail.message, detail.exitCode ?? null, detail.stderr ?? '', detail.signal ?? null, detail.stdout ?? '');
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

type Handle = { ref?: () => void; unref?: () => void } | null | undefined;

/** One running helper. */
class LauncherHost {
  readonly process: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly reader = new FrameReader<LauncherReply>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private referenced = true;
  ended = false;
  ready = false;
  /** Whether it ever said so: a helper that ended before that did not boot. */
  wasReady = false;
  onEnd: () => void = () => undefined;
  onReady: () => void = () => undefined;

  constructor(entry: ChildEntry) {
    // Directly, without a shell, in its own process group, with the standard streams and the sanitized environment only.
    this.process = spawn(entry.binary, entry.args, {
      cwd: os.tmpdir(),
      env: getSanitizedEnvironment({}, false),
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      detached: true,
    });
    // Referenced while it boots, so that a caller waiting for it keeps this process alive; it is let go once it is ready and idle.
    this.process.stdin?.on('error', () => undefined);
    this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.once('exit', () => this.end('the launcher ended'));
    this.process.once('error', () => this.end('the launcher could not be started'));
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  /** While requests are open the helper keeps this process alive; with none it does not. */
  private setReferenced(on: boolean): void {
    if (on === this.referenced) return;
    this.referenced = on;
    const handles: Handle[] = [this.process, this.process.stdout as Handle, this.process.stdin as Handle];
    for (const handle of handles) {
      if (on) handle?.ref?.();
      else handle?.unref?.();
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    this.idleTimer.unref();
  }

  run(binary: string, args: string[], options: LaunchedExecutionOptions): Promise<SandboxedExecutionResult> {
    return new Promise<SandboxedExecutionResult>((resolve, reject) => {
      const id = this.nextId++;
      const { stdin, signal, ...rest } = options;
      const runOptions: LaunchedRunOptions = { ...rest, strictIsolation: options.strictIsolation ?? process.env.STRICT_SANDBOX === 'true' };
      const request: LauncherRequest = { type: 'run', id, binary, args, hasStdin: Boolean(stdin), options: runOptions };
      const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      const timer = setTimeout(() => {
        // The helper is silent past the time limit it was given: it is lost, and so is every request it holds.
        this.fail(id, new SandboxedTimeoutError(timeoutMs));
        this.stop();
      }, timeoutMs + REPLY_ALLOWANCE_MS);
      const onAbort = (): void => {
        this.fail(id, signal?.reason ?? new Error('The operation was aborted'));
        this.send({ type: 'cancel', id });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, detach: () => signal?.removeEventListener('abort', onAbort) });
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.setReferenced(true);
      this.send(request, stdin ?? undefined);
    });
  }

  private send(header: LauncherRequest, payload?: Buffer): void {
    if (this.ended) return;
    const stream = this.process.stdin;
    if (!stream) return;
    stream.cork();
    for (const part of encodeFrame(header, ...(payload ? [payload] : []))) stream.write(part);
    stream.uncork();
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.detach();
    if (this.pending.size === 0 && !this.ended) {
      this.setReferenced(false);
      this.armIdle();
    }
    return pending;
  }

  private fail(id: number, error: unknown): void {
    this.settle(id)?.reject(error);
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch {
      this.stop();
      return;
    }
    for (const { header, payload } of frames) {
      if (header.type === 'ready') {
        this.ready = true;
        this.wasReady = true;
        if (this.pending.size === 0) {
          this.setReferenced(false);
          this.armIdle();
        }
        this.onReady();
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
        this.fail(header.id, toError(header.error));
      }
    }
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const id of [...this.pending.keys()]) {
      this.fail(id, new SandboxedProcessError(`Sandboxed execution error: ${reason}`, null, reason));
    }
    this.onEnd();
  }

  /** Ends the helper: closing its input makes it close its programs, and it is killed if it does not go. */
  stop(): void {
    try {
      this.process.stdin?.end();
    } catch {
      // already closed
    }
    this.end('the launcher was stopped');
    // Its input is closed first so that it can end the programs it started; the kill follows once it had the chance.
    const stopped = this.process;
    setTimeout(() => {
      if (stopped.exitCode === null && stopped.signalCode === null) killProcessGroup(stopped.pid, 'SIGKILL');
    }, STOP_GRACE_MS).unref();
  }
}

const STOP_GRACE_MS = 2000;

let host: LauncherHost | null = null;
let starting: Promise<boolean> | null = null;
let retryAfter = 0;
let launchedCount = 0;
let directCount = 0;

/** Starts the helper if there is none and resolves true once it is ready; false when it is turned off, missing or could not start. */
export function startSandboxLauncher(): Promise<boolean> {
  if (!sandboxLauncherEnabled()) return Promise.resolve(false);
  if (host?.ready) return Promise.resolve(true);
  if (starting) return starting;
  if (Date.now() < retryAfter) return Promise.resolve(false);
  const entry = resolveChildEntry();
  if (!entry) return Promise.resolve(false);
  const created = new LauncherHost(entry);
  host = created;
  starting = new Promise<boolean>((resolve) => {
    const boot = setTimeout(() => {
      created.stop();
      resolve(false);
    }, BOOT_TIMEOUT_MS);
    boot.unref();
    created.onReady = () => {
      clearTimeout(boot);
      resolve(true);
    };
    created.onEnd = () => {
      clearTimeout(boot);
      if (host === created) host = null;
      if (!created.wasReady) retryAfter = Date.now() + RESTART_BACKOFF_MS;
      resolve(false);
    };
  }).finally(() => {
    starting = null;
  });
  return starting;
}

/** Ends the helper and the programs it still runs. */
export function stopSandboxLauncher(): void {
  const current = host;
  host = null;
  current?.stop();
}

export function sandboxLauncherState(): { ready: boolean; pid: number | undefined; launched: number; direct: number } {
  return { ready: host?.ready === true, pid: host?.ready ? host.pid : undefined, launched: launchedCount, direct: directCount };
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
  const current = host?.ready === true ? host : null;
  if (!current) void startSandboxLauncher();
  if (!current || options.signal?.aborted || !sandboxLauncherEnabled() || !launchPays(process.memoryUsage.rss(), expectedOutputBytes)) {
    directCount++;
    return executeSandboxedBinary(binary, args, forwarded);
  }
  launchedCount++;
  return current.run(binary, args, forwarded);
}
