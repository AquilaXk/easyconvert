import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { SandboxUnavailableError } from '../types';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  getUnshareCapability,
  killProcessGroup,
  needsNamespacesBeyondNetwork,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  type SandboxedExecutionOptions,
  type SandboxedExecutionResult,
  type UnshareIsolationOptions,
} from './process-sandbox';
import {
  encodeFrame,
  FrameReader,
  isBadFrame,
  PARENT_NETNS_ENV,
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
 * A program that asks for network isolation is started on a host the same way, but the isolation costs a process start
 * and a namespace per program when each is wrapped in its own `unshare`. So the programs that ask for it are served by a
 * second kind of helper that is itself started under `unshare -r -n`: it sits in a user and network namespace of its own,
 * proves that to itself when it boots (sandbox-launcher-child.ts), and its programs inherit the namespace instead of
 * creating another. A host that cannot create the namespaces has no such helper, and those programs keep the wrapper of
 * their own (or the refusal of strict isolation), as they do on the direct path.
 *
 * The helper is not free: a request and its reply cross two pipes, which adds wake-ups, and the output is copied once
 * more. So a program is started through it only when what it saves costs more than that: the saving grows with the
 * memory this process has mapped and, for an isolated helper, with the `unshare` it spares; the copy with the size of
 * the output (see launchPays).
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
/**
 * What the `unshare -r -n` in front of a program costs, in milliseconds: the start of `unshare`, the two namespaces and the
 * start of the program after it. It was 0.27 ms for a program that does nothing and 0.35 ms for qpdf, on the same VM.
 * The lower is used, so that the saving is never overstated.
 */
const NETWORK_ISOLATION_WRAPPER_MS = 0.27;
/** Wall-clock a reply may take beyond the run's own time limit before the helper is judged lost. */
const REPLY_ALLOWANCE_MS = 10_000;
/** After a cancel is sent, the helper has this long to say the program is dead before the caller is told anyway. */
const CANCEL_ALLOWANCE_MS = 2000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
/** Without a hint the output is taken to be a quarter of the limit (the callers size the limit as a multiple of the input). */
const DEFAULT_OUTPUT_SHARE = 4;
/** A helper that has served nothing for this long ends; the next request starts one. */
const IDLE_MS = 60_000;
/** Longest the helper may take to boot and say it is ready. */
const BOOT_TIMEOUT_MS = 30_000;
/** After a helper that never booted, or ended by itself, programs run directly for this long before another is tried. */
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

interface Pending {
  resolve(result: SandboxedExecutionResult): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  detach(): void;
  /** Set once the caller aborted: the request then ends with this reason, whatever the helper answers. */
  aborted?: { reason: unknown; timer: NodeJS.Timeout };
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

type Handle = { ref?: () => void; unref?: () => void } | null | undefined;

/**
 * `open`: the helper starts programs as the worker would. `netns`: the helper itself runs in a user and network namespace of
 * its own (started under `unshare`), and so serves the programs that ask for network isolation without a wrapper each.
 */
type HelperKind = 'open' | 'netns';

const NETNS_LINK = '/proc/self/ns/net';

/** The command that runs the helper under the `unshare` the host has shown it can use (the same arguments as the wrapper of a program). */
function underUnshare(entry: ChildEntry): ChildEntry {
  const capability = getUnshareCapability();
  return { binary: capability.path, args: [...capability.args, '--', entry.binary, ...entry.args] };
}

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
  /** Whether this process ended it (idle, stop, boot timeout) rather than the helper ending by itself. */
  stoppedOnPurpose = false;
  onEnd: () => void = () => undefined;
  onReady: () => void = () => undefined;

  constructor(
    entry: ChildEntry,
    readonly kind: HelperKind
  ) {
    const command = kind === 'netns' ? underUnshare(entry) : entry;
    // Directly, without a shell, in its own process group, with the standard streams and the sanitized environment only.
    this.process = spawn(command.binary, command.args, {
      cwd: os.tmpdir(),
      env: getSanitizedEnvironment(kind === 'netns' ? { [PARENT_NETNS_ENV]: fs.readlinkSync(NETNS_LINK) } : {}, false),
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
        this.stop(true);
      }, timeoutMs + REPLY_ALLOWANCE_MS);
      // On abort the helper is asked to kill the program and the caller hears of it when the helper says it is dead, so
      // that what a caller's `finally` removes (a decrypted copy, a password file) is not removed under a live program,
      // as on the direct path. A helper that does not answer in time is not waited for longer.
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (!pending || pending.aborted) return;
        const reason = signal?.reason ?? new Error('The operation was aborted');
        pending.aborted = { reason, timer: setTimeout(() => this.fail(id, reason), CANCEL_ALLOWANCE_MS) };
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
    if (pending.aborted) clearTimeout(pending.aborted.timer);
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
        // A helper started to hold the network isolation of its programs that cannot show it is no use: its programs would skip the wrapper for nothing.
        if (this.kind === 'netns' && !header.netIsolated) {
          this.stop(true);
          return;
        }
        this.ready = true;
        this.wasReady = true;
        if (this.pending.size === 0) {
          this.setReferenced(false);
          this.armIdle();
        }
        this.onReady();
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

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const id of [...this.pending.keys()]) {
      this.fail(id, this.pending.get(id)?.aborted?.reason ?? new SandboxedProcessError(`Sandboxed execution error: ${reason}`, null, reason));
    }
    this.onEnd();
  }

  /** Ends the helper: closing its input makes it close its programs, and it is killed if it does not go. */
  stop(abnormal = false): void {
    this.stoppedOnPurpose = !abnormal;
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

/** One kind of helper: the process that runs (or boots) and the pause after one that failed. */
class HelperSlot {
  host: LauncherHost | null = null;
  private starting: Promise<boolean> | null = null;
  private retryAfter = 0;

  constructor(private readonly kind: HelperKind) {}

  /** Starts the helper if there is none and resolves true once it is ready; false when it is turned off, missing or could not start. */
  start(): Promise<boolean> {
    if (!sandboxLauncherEnabled()) return Promise.resolve(false);
    if (this.host?.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    if (Date.now() < this.retryAfter) return Promise.resolve(false);
    const entry = resolveChildEntry();
    if (!entry) return Promise.resolve(false);
    let created: LauncherHost;
    try {
      created = new LauncherHost(entry, this.kind);
    } catch {
      // The namespace of this process cannot be read (no /proc): no helper of this kind can be told from the worker.
      this.retryAfter = Date.now() + RESTART_BACKOFF_MS;
      return Promise.resolve(false);
    }
    this.host = created;
    this.starting = new Promise<boolean>((resolve) => {
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
        if (this.host === created) this.host = null;
        // A helper that never booted, or ended without being stopped (killed, out of memory, a protocol error), is not replaced at once.
        if (!created.wasReady || !created.stoppedOnPurpose) this.retryAfter = Date.now() + RESTART_BACKOFF_MS;
        resolve(false);
      };
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop(): void {
    this.retryAfter = 0;
    const current = this.host;
    this.host = null;
    current?.stop();
  }
}

const slots: Record<HelperKind, HelperSlot> = { open: new HelperSlot('open'), netns: new HelperSlot('netns') };
let launchedCount = 0;
let directCount = 0;

/** Whether this host lets the launcher create the user and network namespaces a helper of the `netns` kind sits in. */
function canHoldNetworkNamespace(): boolean {
  return process.platform === 'linux' && getUnshareCapability().available;
}

/**
 * The helper that serves a run: the `netns` kind for a run that asks for network isolation and needs no namespace beyond
 * the user and network ones, where the host can create them; the `open` kind otherwise, whose programs get the
 * isolation (or the refusal of strict isolation) from the wrapper of their own.
 */
function slotFor(networkIsolated: boolean, sandboxOptions?: UnshareIsolationOptions): HelperSlot {
  return networkIsolated && !needsNamespacesBeyondNetwork(sandboxOptions) && canHoldNetworkNamespace() ? slots.netns : slots.open;
}

/**
 * Starts the helper that serves programs which do (`networkIsolated`) or do not ask for network isolation, if there is
 * none, and resolves true once it is ready; false when it is turned off, missing or could not start.
 */
export function startSandboxLauncher(networkIsolated = false): Promise<boolean> {
  return slotFor(networkIsolated).start();
}

/** Ends the helpers and the programs they still run. */
export function stopSandboxLauncher(): void {
  for (const slot of Object.values(slots)) slot.stop();
}

/** The helper that serves programs which do (`networkIsolated`) or do not ask for network isolation; the counts are those of both. */
export function sandboxLauncherState(networkIsolated = false): { ready: boolean; pid: number | undefined; launched: number; direct: number } {
  const { host } = slotFor(networkIsolated);
  return { ready: host?.ready === true, pid: host?.ready ? host.pid : undefined, launched: launchedCount, direct: directCount };
}

/**
 * Whether what the helper saves costs more than the helper does, for a process of this size and an output of this size:
 * the fork it spares (in proportion to `residentBytes`) and, when `sparesWrapper`, the `unshare` in front of the program.
 */
export function launchPays(residentBytes: number, expectedOutputBytes: number, sparesWrapper = false): boolean {
  const savedMs = (residentBytes - BASELINE_RESIDENT_BYTES) * FORK_MS_PER_BYTE + (sparesWrapper ? NETWORK_ISOLATION_WRAPPER_MS : 0);
  return savedMs > expectedOutputBytes * COPY_MS_PER_BYTE;
}

/**
 * Like executeSandboxedBinary, started from the helper when one is ready and it pays. The result and the errors are the same.
 * Standard input is a Buffer or nothing.
 */
export function launchSandboxedBinary(binary: string, args: string[], options: LaunchedExecutionOptions = {}): Promise<SandboxedExecutionResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES;
  const { expectedOutputBytes = maxBuffer / DEFAULT_OUTPUT_SHARE, ...forwarded } = options;
  const slot = slotFor(options.networkIsolated !== false, options.sandboxOptions);
  const current = slot.host?.ready === true ? slot.host : null;
  if (!current) void slot.start();
  if (!current || options.signal?.aborted || !sandboxLauncherEnabled() || !launchPays(process.memoryUsage.rss(), expectedOutputBytes, current.kind === 'netns')) {
    directCount++;
    return executeSandboxedBinary(binary, args, forwarded);
  }
  launchedCount++;
  return current.run(binary, args, forwarded);
}
