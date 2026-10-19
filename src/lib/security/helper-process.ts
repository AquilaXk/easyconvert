import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { getSanitizedEnvironment, killProcessGroup, SandboxedTimeoutError, type SandboxedExecutionResult } from './process-sandbox';

/**
 * What the helper processes of this process have in common: the sandbox launcher (sandbox-launcher.ts) and the qpdf runner
 * (conversions/pdf-postprocess/qpdf-runner.ts). Each is a long-lived child that takes jobs over a pipe and answers them; they differ in the
 * frames they speak and in how a job lost with the helper is reported, and share everything else:
 *  - the child itself: started directly, in a process group of its own, with the sanitized environment, kept alive for this process only
 *    while a job is open, and ended after an idle time or on request (closing its input first, a kill if it does not go);
 *  - the jobs it holds: a time limit with an allowance for the reply, a cancel on abort that the caller hears of only when the helper says the
 *    job is dead, and one place where a job is settled, whoever settles it;
 *  - the slot that starts it in the background, gives up on a boot that takes too long and does not start another at once after a helper that
 *    never booted or ended by itself.
 */

/** A helper that has served nothing for this long ends; the next job starts one. */
const IDLE_MS = 60_000;
/** Wall-clock a reply may take beyond the job's own time limit before the helper is judged lost. */
const REPLY_ALLOWANCE_MS = 10_000;
/** After a cancel is sent, the helper has this long to say the job is dead before the caller is told anyway. */
const CANCEL_ALLOWANCE_MS = 2000;
/** The helper has this long after its input is closed to end the programs it started and go, before it is killed. */
const STOP_GRACE_MS = 2000;
/** After a helper that never booted, or ended by itself, jobs run the usual way for this long before another helper is tried. */
const RESTART_BACKOFF_MS = 30_000;

/** The parts of a job held while the helper runs it; a host adds its own fields. */
export type PendingJob<Extra extends object = object> = Extra & {
  resolve(result: SandboxedExecutionResult): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  detach(): void;
  /** Set once the caller aborted: the job then ends with this reason, whatever the helper answers. */
  aborted?: { reason: unknown; timer: NodeJS.Timeout };
};

export interface HelperCommand {
  binary: string;
  args: string[];
}

/** Why a job is lost when the helper ends, as the host words it (`reason` says how the helper ended). */
export type LostJobError = (reason: string) => Error;

export interface JobSpec<Extra extends object> {
  id: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  /** Asks the helper to kill the job. */
  cancel(): void;
  resolve(result: SandboxedExecutionResult): void;
  reject(error: unknown): void;
  extra: Extra;
}

type Handle = { ref?: () => void; unref?: () => void } | null | undefined;

/** One running helper. A host extends it with the reading of the helper's replies (`onData`) and the error of a job lost with it. */
export abstract class HelperHost<Extra extends object = object> {
  readonly process: ChildProcess;
  protected readonly pending = new Map<number, PendingJob<Extra>>();
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

  /** `name` is how the helper is called in the messages of the jobs it takes down ("the launcher", "the runner"). */
  protected constructor(
    command: HelperCommand,
    private readonly name: string,
    private readonly lostJobError: LostJobError
  ) {
    // Directly, without a shell, in its own process group, with the standard streams and the sanitized environment only.
    this.process = spawn(command.binary, command.args, {
      cwd: os.tmpdir(),
      env: getSanitizedEnvironment({}, false),
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      detached: true,
    });
    // Referenced while it boots, so that a caller waiting for it keeps this process alive; it is let go once it is ready and idle.
    this.process.stdin?.on('error', () => undefined);
    this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.once('exit', () => this.end(`${this.name} ended`));
    this.process.once('error', () => this.end(`${this.name} could not be started`));
  }

  protected abstract onData(chunk: Buffer): void;

  get pid(): number | undefined {
    return this.process.pid;
  }

  protected allocateId(): number {
    return this.nextId++;
  }

  /** While jobs are open the helper keeps this process alive; with none it does not. */
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

  private releaseWhenIdle(): void {
    if (this.pending.size === 0 && !this.ended) {
      this.setReferenced(false);
      this.armIdle();
    }
  }

  /** Records a job the host is about to send: its time limit, its cancel on abort, and the helper kept alive for it. */
  protected enroll(spec: JobSpec<Extra>): void {
    const { id, timeoutMs, signal } = spec;
    const timer = setTimeout(() => {
      // The helper is silent past the time limit it was given: it is lost, and so is every job it holds.
      this.fail(id, new SandboxedTimeoutError(timeoutMs));
      this.stop(true);
    }, timeoutMs + REPLY_ALLOWANCE_MS);
    // On abort the helper is asked to kill the job and the caller hears of it when the helper says it is dead, so that what a caller's
    // `finally` removes (a decrypted copy, a password file) is not removed under a live program, as on the direct path. A helper that
    // does not answer in time is not waited for longer.
    const onAbort = (): void => {
      const pending = this.pending.get(id);
      if (!pending || pending.aborted) return;
      const reason = signal?.reason ?? new Error('The operation was aborted');
      pending.aborted = { reason, timer: setTimeout(() => this.fail(id, reason), CANCEL_ALLOWANCE_MS) };
      spec.cancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.pending.set(id, { ...spec.extra, resolve: spec.resolve, reject: spec.reject, timer, detach: () => signal?.removeEventListener('abort', onAbort) });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.setReferenced(true);
  }

  protected write(parts: readonly Buffer[]): void {
    if (this.ended) return;
    const stream = this.process.stdin;
    if (!stream) return;
    stream.cork();
    for (const part of parts) stream.write(part);
    stream.uncork();
  }

  /** Takes a job out of the held ones, whoever settles it: its timers end and the helper is let go when it was the last. */
  protected settle(id: number): PendingJob<Extra> | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.aborted) clearTimeout(pending.aborted.timer);
    pending.detach();
    this.releaseWhenIdle();
    return pending;
  }

  protected fail(id: number, error: unknown): void {
    this.settle(id)?.reject(error);
  }

  /** The helper said it is ready. */
  protected markReady(): void {
    this.ready = true;
    this.wasReady = true;
    this.releaseWhenIdle();
    this.onReady();
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A job the helper held died with it (its children die with their parent).
    for (const id of [...this.pending.keys()]) {
      this.fail(id, this.pending.get(id)?.aborted?.reason ?? this.lostJobError(reason));
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
    this.end(`${this.name} was stopped`);
    // Its input is closed first so that it can end the programs it started; the kill follows once it had the chance.
    const stopped = this.process;
    setTimeout(() => {
      if (stopped.exitCode === null && stopped.signalCode === null) killProcessGroup(stopped.pid, 'SIGKILL');
    }, STOP_GRACE_MS).unref();
  }
}

/** The one helper of a host kind: started on first use in the background, replaced after it ends, not replaced at once after it failed. */
export class HelperSlot<Host extends HelperHost<object>> {
  private host: Host | null = null;
  private starting: Promise<boolean> | null = null;
  private retryAfter = 0;

  /**
   * `enabled` says whether the helper is switched on; `create` starts one, or returns null when it cannot be (nothing to run);
   * `bootTimeoutMs` is the longest it may take to say it is ready.
   */
  constructor(
    private readonly enabled: () => boolean,
    private readonly create: () => Host | null,
    private readonly bootTimeoutMs: number
  ) {}

  /** The helper when it is ready. */
  get ready(): Host | null {
    return this.host?.ready === true ? this.host : null;
  }

  /** Starts the helper if there is none and resolves true once it is ready; false when it is off, missing or could not start. */
  start(): Promise<boolean> {
    if (!this.enabled()) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    if (Date.now() < this.retryAfter) return Promise.resolve(false);
    const created = this.create();
    if (!created) return Promise.resolve(false);
    this.host = created;
    this.starting = new Promise<boolean>((resolve) => {
      const boot = setTimeout(() => {
        created.stop();
        resolve(false);
      }, this.bootTimeoutMs);
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

  /** Ends the helper and the programs it still runs. */
  stop(): void {
    this.retryAfter = 0;
    const current = this.host;
    this.host = null;
    current?.stop();
  }

  /** The helper, ready or not; for the state the tests read. */
  get current(): Host | null {
    return this.host;
  }
}
