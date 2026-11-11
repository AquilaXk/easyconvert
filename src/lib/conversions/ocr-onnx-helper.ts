import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  getProcessRssMb,
  getSanitizedEnvironment,
  killProcessGroup,
  memoryWatchPid,
  resolveSandboxedCommand,
} from '../security/process-sandbox';
import { OcrEngineUnavailableError } from '../types';
import { availableCpus } from '../workers/available-cpus';
import { olderThanSource } from '../workers/compiled-worker';
import { Semaphore } from '../workers/semaphore';
import { prepareOnnxInput, type OnnxPrepareOptions } from './ocr-onnx-input';
import {
  ONNX_OCR_DETECTOR_FILE,
  ONNX_OCR_DICTIONARY_FILE,
  ONNX_OCR_MODEL_DIR_ENV,
  ONNX_OCR_RECOGNIZER_FILE,
  type OnnxPageInput,
} from './ocr-onnx';
import { encodeFrame, FrameReader, type OnnxReply, type OnnxRunRequest } from './ocr-onnx-protocol';
import { ocrQueue } from './ocr-cli';
import type { OcrBBox, OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';

/**
 * Runs the ONNX Korean OCR engine (ocr-onnx.ts) in helper processes instead of in the web or worker process.
 *
 * The models are native code (onnxruntime) fed with files and arrays, so a defect in it must not be able to reach what the worker
 * holds. Each helper (ocr-onnx-child.ts) is started the way the other native programs are (resolveSandboxedCommand): in a user,
 * network and PID namespace of its own, under the Landlock ruleset of pid-init, with no environment but the sanitized one, no
 * credentials, an address-space limit, a CPU-time limit, no core file, and a file-size limit that leaves it no room to write. The
 * worker decodes the page (the encoded image is the untrusted part), so a helper receives raw pixels and answers with lines and word
 * boxes, which are checked again here before the rest of the product reads them.
 *
 * Starting a helper costs the loading of two models (about 0.5 s of CPU) before its first page, so helpers are kept: one reads
 * one page at a time, an idle one ends after IDLE_TTL_MS, and one that has read MAX_PAGES_PER_HELPER pages is replaced, which bounds
 * what one native heap can accumulate and how many pages share one address space. Setting the page count to 1 reads every page in a
 * fresh process.
 *
 * Without the models, the `onnxruntime-node` package or the helper program, or with EASYCONVERT_OCR_ONNX=off, the engine is
 * unavailable and the caller says so (OnnxOcrUnavailableError); a page that a helper fails on (it was killed, ran out of time or
 * memory) is OnnxOcrFailedError. A host that cannot confine its children is refused (SandboxUnavailableError is not caught here).
 */

export const ONNX_OCR_SWITCH_ENV = 'EASYCONVERT_OCR_ONNX';
/** The directory the worker image keeps the models in; EASYCONVERT_OCR_ONNX_DIR names another one. */
export const ONNX_OCR_DEFAULT_MODEL_DIR = '/opt/ocr-onnx';

/** Why the engine cannot be used, as a code a result and a log line can carry. */
export type OnnxOcrUnavailableReason = 'switched-off' | 'models-missing' | 'runtime-missing' | 'helper-missing' | 'helper-not-starting';
/** Why a page the engine was given was not read. */
export type OnnxOcrFailureReason = 'helper-lost' | 'timeout' | 'memory' | 'rejected';

export class OnnxOcrUnavailableError extends OcrEngineUnavailableError {
  constructor(
    readonly reason: OnnxOcrUnavailableReason,
    message: string
  ) {
    super(message);
    this.name = 'OnnxOcrUnavailableError';
  }
}

export class OnnxOcrFailedError extends OcrEngineUnavailableError {
  constructor(
    readonly reason: OnnxOcrFailureReason,
    message: string
  ) {
    super(message);
    this.name = 'OnnxOcrFailedError';
  }
}

// --- Limits ---------------------------------------------------------------------------------------------------------

const CHILD_FILE = 'ocr-onnx-child';
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');
/** V8 heap ceiling of a helper: it holds a page's lines and a few JSON strings; the pixels and the tensors are outside the heap. */
const CHILD_HEAP_MB = 192;
/** Resident memory past which a helper is killed. A page of the measurement set peaked at 0.66 GB with the detector side cut to 1280 pixels. */
export const ONNX_HELPER_RSS_LIMIT_MB = 1536;
/**
 * Address space of a helper. Node and onnxruntime map 6.1 GB of it at a 0.5 GB resident peak on a 4-core host (thread stacks, one allocator
 * arena per thread and the runtime's reservations; measured), so the limit is 10 GB: it stops a runaway mapping, and the resident limit above
 * is the one that bounds the memory a page uses.
 */
export const ONNX_HELPER_ADDRESS_SPACE_MB = 10_240;
/** Wall-clock of one page, from the moment its helper starts reading it. */
export const ONNX_PAGE_TIMEOUT_MS = 90_000;
/** CPU seconds a helper may use over its life: its page count times the page time limit, times the threads it runs. */
const CPU_SECONDS_PER_PAGE = 120;
const BOOT_TIMEOUT_MS = 45_000;
/** A helper that has read nothing for this long ends. */
export const ONNX_HELPER_IDLE_TTL_MS = 60_000;
/** A helper is replaced after this many pages. */
export const ONNX_HELPER_MAX_PAGES = 50;
/** After a helper that did not start, none is started for this long. */
const RESTART_BACKOFF_MS = 30_000;
const MEMORY_POLL_MS = 200;
const STOP_GRACE_MS = 2000;
/** Pages that may wait for a helper before more are refused. */
const MAX_QUEUED_PAGES = 64;
/** A page the helper reads is at most this many lines and words; the detector is capped at 2000 boxes. */
const MAX_REPLY_LINES = 2048;
const MAX_REPLY_WORDS = 200_000;
const MAX_TEXT_CHARS = 4096;
/** What is kept of a message the helper sends with an error: it reaches a log line and an error a caller sees. */
const MAX_HELPER_MESSAGE_CHARS = 300;
/** What is kept of the helper's standard error when it fails to start. */
const MAX_STDERR_BYTES = 2048;

export interface OnnxHelperPlan {
  helpers: number;
  threads: number;
}

/**
 * How many helpers run at once and how many threads each reads with, for `cpus` available cores: three cores or more to a helper
 * (a helper reads a page about as fast with 3 threads as with 4, and each holds 0.7 GB), at most three helpers, at most six threads.
 */
export function onnxHelperPlan(cpus: number = availableCpus()): OnnxHelperPlan {
  const helpers = Math.max(1, Math.min(3, Math.floor(cpus / 3)));
  return { helpers, threads: Math.max(1, Math.min(6, Math.floor(cpus / helpers))) };
}

// --- Availability ---------------------------------------------------------------------------------------------------

export function onnxOcrModelDirectory(): string {
  return process.env[ONNX_OCR_MODEL_DIR_ENV]?.trim() || ONNX_OCR_DEFAULT_MODEL_DIR;
}

export function onnxOcrSwitchedOff(): boolean {
  return (process.env[ONNX_OCR_SWITCH_ENV] ?? '').trim().toLowerCase() === 'off';
}

function modelsPresent(dir: string): boolean {
  return [ONNX_OCR_DETECTOR_FILE, ONNX_OCR_RECOGNIZER_FILE, ONNX_OCR_DICTIONARY_FILE].every((name) => fs.existsSync(path.join(dir, name)));
}

function runtimePresent(): boolean {
  try {
    createRequire(path.join(process.cwd(), 'package.json')).resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

type ChildEntry = { binary: string; args: string[] };

let childEntry: ChildEntry | null | undefined;

/** How to start a helper: the bundled file next to this module or under `dist/`, otherwise the source through tsx; null when neither exists. */
function resolveChildEntry(): ChildEntry | null {
  if (childEntry !== undefined) return childEntry;
  const heap = `--max-old-space-size=${CHILD_HEAP_MB}`;
  const compiled = [path.join(__dirname, `${CHILD_FILE}.js`), path.join(process.cwd(), 'dist', `${CHILD_FILE}.js`)].find((candidate) => fs.existsSync(candidate));
  const source = [path.join(__dirname, `${CHILD_FILE}.ts`), path.join(process.cwd(), 'src', 'lib', 'conversions', `${CHILD_FILE}.ts`)].find((candidate) =>
    fs.existsSync(candidate)
  );
  let tsxApi: string | null = null;
  try {
    tsxApi = createRequire(path.join(process.cwd(), 'package.json')).resolve(TSX_REGISTER_SPECIFIER);
  } catch {
    tsxApi = null;
  }
  if (compiled && !(tsxApi && olderThanSource(compiled, source))) childEntry = { binary: process.execPath, args: [heap, compiled] };
  else if (source && tsxApi) childEntry = { binary: process.execPath, args: [heap, '-e', `require(${JSON.stringify(tsxApi)}).register(); require(${JSON.stringify(source)});`] };
  else childEntry = null;
  return childEntry;
}

/** Why the engine cannot be used here, or null when a helper can be started. Cheap: files and a module lookup. */
export function onnxOcrUnavailableReason(modelDir: string = onnxOcrModelDirectory()): { reason: OnnxOcrUnavailableReason; message: string } | null {
  if (onnxOcrSwitchedOff()) return { reason: 'switched-off', message: `The ONNX OCR engine is switched off (${ONNX_OCR_SWITCH_ENV}=off).` };
  if (!modelsPresent(modelDir)) return { reason: 'models-missing', message: `The ONNX OCR models (${ONNX_OCR_DETECTOR_FILE}, ${ONNX_OCR_RECOGNIZER_FILE}, ${ONNX_OCR_DICTIONARY_FILE}) are not in '${modelDir}'.` };
  if (!runtimePresent()) return { reason: 'runtime-missing', message: "The ONNX OCR engine needs the 'onnxruntime-node' package, which is not installed." };
  if (!resolveChildEntry()) return { reason: 'helper-missing', message: `The ONNX OCR helper (${CHILD_FILE}.js) is not built; run "npm run build:ocr-onnx-child".` };
  return null;
}

// --- One helper -----------------------------------------------------------------------------------------------------

class HelperEnded extends Error {}

/** One printable line of at most MAX_HELPER_MESSAGE_CHARS: what the helper says about itself is data, not something to log whole. */
function boundedText(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_HELPER_MESSAGE_CHARS);
}

/**
 * The reply a frame header is, or null when it is not one. The header is whatever JSON the helper wrote: a plain object with a string `type`
 * and, for a result or an error, a whole-number `id`; an error also has a known `kind` and a text `message` (cut to a line).
 */
function replyOf(header: unknown): OnnxReply | null {
  if (typeof header !== 'object' || header === null || Array.isArray(header)) return null;
  const { type, id, kind, message, result } = header as Record<string, unknown>;
  if (type === 'ready') return { type: 'ready' };
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  if (type === 'result') return { type: 'result', id, result: result as OcrResult };
  if (type === 'error' && (kind === 'unavailable' || kind === 'failed') && typeof message === 'string') return { type: 'error', id, kind, message: boundedText(message) };
  return null;
}

interface Waiting {
  id: number;
  resolve(reply: OnnxReply): void;
  reject(error: unknown): void;
}

/** One running helper: boots (loads the models), then reads one page at a time. */
class OnnxHelper {
  private readonly process: ChildProcess;
  private readonly reader = new FrameReader<OnnxReply>(1024);
  private waiting: Waiting | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private memoryTimer: NodeJS.Timeout | null = null;
  private readonly levelsAboveProgram: number;
  private nextId = 1;
  private stderr: Buffer = Buffer.alloc(0);
  pages = 0;
  ended = false;
  busy = false;
  private bootWaiters: Array<(ready: boolean) => void> = [];
  private ready = false;
  onEnd: () => void = () => undefined;

  constructor(entry: ChildEntry, modelDir: string, threads: number) {
    const cpuSeconds = ONNX_HELPER_MAX_PAGES * CPU_SECONDS_PER_PAGE * threads;
    const command = resolveSandboxedCommand(entry.binary, [...entry.args, '--', `--models=${modelDir}`, `--threads=${threads}`], {
      networkIsolated: true,
      // The address space is not the resident memory (that is watched below): the runtime reserves far more than it uses.
      rlimits: { asBytes: ONNX_HELPER_ADDRESS_SPACE_MB * 1024 * 1024, cpuSeconds, fsizeBytes: 1024 * 1024, coreBytes: 0 },
      // It writes no file. It reads its models and the application it runs from (the bundle and the runtime's native module below the working directory of the worker).
      workDir: null,
      readDirs: process.cwd() === path.parse(process.cwd()).root ? [modelDir] : [modelDir, process.cwd()],
    });
    this.levelsAboveProgram = command.levelsAboveProgram;
    // Directly, without a shell, in its own process group, with the three standard streams and the sanitized environment only.
    this.process = spawn(command.binary, command.args, {
      cwd: os.tmpdir(),
      env: getSanitizedEnvironment({}, true),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    // The first bytes of its standard error are kept for the message of a helper that does not start (a seccomp refusal or a missing library
    // says so there); the rest is read and dropped so that the pipe never fills.
    this.process.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderr.length < MAX_STDERR_BYTES) this.stderr = Buffer.concat([this.stderr, chunk]).subarray(0, MAX_STDERR_BYTES);
    });
    // Referenced while it boots and while it reads a page, so that a caller waiting for it keeps this process alive; let go when idle.
    this.process.stdin?.on('error', () => undefined);
    this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.once('exit', () => this.end(new HelperEnded('the OCR helper ended')));
    this.process.once('error', () => this.end(new HelperEnded('the OCR helper could not be started')));
    const boot = setTimeout(() => this.kill(new HelperEnded('the OCR helper did not become ready in time')), BOOT_TIMEOUT_MS);
    boot.unref();
    this.bootWaiters.push(() => clearTimeout(boot));
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  /** The first bytes the helper wrote to its standard error, as one printable line. */
  get stderrText(): string {
    return boundedText(this.stderr.toString('utf8'));
  }

  /** While a page is being read the helper keeps this process alive; idle, it does not. */
  private unref(): void {
    this.process.unref();
    (this.process.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (this.process.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    (this.process.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  }

  private ref(): void {
    this.process.ref();
    (this.process.stdout as unknown as { ref?: () => void } | null)?.ref?.();
    (this.process.stdin as unknown as { ref?: () => void } | null)?.ref?.();
    (this.process.stderr as unknown as { ref?: () => void } | null)?.ref?.();
  }

  /** Resolves true when the helper said it is ready, false when it ended first. */
  whenReady(signal?: AbortSignal): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.ended) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => reject(signal?.reason ?? new Error('The operation was aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.bootWaiters.push((ready) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(ready);
      });
    });
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch {
      this.kill(new HelperEnded('the OCR helper sent something that is not a frame'));
      return;
    }
    for (const frame of frames) {
      const header = replyOf(frame.header);
      if (!header) {
        this.kill(new HelperEnded('the OCR helper sent a reply that is not valid'));
        return;
      }
      if (header.type === 'ready') {
        if (this.ready) {
          this.kill(new HelperEnded('the OCR helper said it was ready twice'));
          return;
        }
        this.ready = true;
        const waiters = this.bootWaiters;
        this.bootWaiters = [];
        for (const wake of waiters) wake(true);
        this.armIdle();
      } else if (this.waiting && header.id === this.waiting.id) {
        const waiting = this.waiting;
        this.waiting = null;
        waiting.resolve(header);
      } else {
        this.kill(new HelperEnded('the OCR helper answered a page that was not asked for'));
      }
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(new HelperEnded('the OCR helper was idle')), ONNX_HELPER_IDLE_TTL_MS);
    this.idleTimer.unref();
  }

  /** Reads one page; rejects with OnnxOcrFailedError when the helper is lost, too slow or too large, and with the signal's reason when it aborts. */
  async read(input: OnnxPageInput, language: string, recoverSpaces: boolean, timeoutMs: number, signal?: AbortSignal): Promise<OnnxReply> {
    if (this.ended) throw new OnnxOcrFailedError('helper-lost', 'The OCR helper had ended before the page was sent.');
    this.busy = true;
    this.ref();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const id = this.nextId++;
    const request: OnnxRunRequest = { type: 'run', id, width: input.width, height: input.height, detector: { width: input.detector.width, height: input.detector.height }, language, recoverSpaces };
    const payload = Buffer.concat([input.rgb, input.detector.rgb]);
    let onAbort: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      signal?.throwIfAborted();
      return await new Promise<OnnxReply>((resolve, reject) => {
        this.waiting = { id, resolve, reject };
        timer = setTimeout(() => {
          this.kill(new OnnxOcrFailedError('timeout', `The OCR helper did not read the page within ${timeoutMs} ms.`));
        }, timeoutMs);
        onAbort = () => this.kill(signal?.reason ?? new Error('The operation was aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        this.memoryTimer = setInterval(() => {
          const pid = this.process.pid;
          if (!pid) return;
          const rssMb = getProcessRssMb(memoryWatchPid(pid, this.levelsAboveProgram));
          if (rssMb !== null && rssMb > ONNX_HELPER_RSS_LIMIT_MB) this.kill(new OnnxOcrFailedError('memory', `The OCR helper used more than ${ONNX_HELPER_RSS_LIMIT_MB} MB.`));
        }, MEMORY_POLL_MS);
        for (const part of encodeFrame(request, payload)) this.process.stdin?.write(part);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (this.memoryTimer) clearInterval(this.memoryTimer);
      this.memoryTimer = null;
      this.waiting = null;
      this.busy = false;
      this.pages++;
      if (!this.ended) {
        this.armIdle();
        this.unref();
      }
    }
  }

  private end(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    const waiters = this.bootWaiters;
    this.bootWaiters = [];
    for (const wake of waiters) wake(false);
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error instanceof HelperEnded ? new OnnxOcrFailedError('helper-lost', `${error.message}.`) : error);
    this.onEnd();
  }

  /** Kills the helper and its process group; the page it holds ends with `error`. */
  kill(error: Error): void {
    this.end(error);
    killProcessGroup(this.process.pid, 'SIGKILL');
    try {
      this.process.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  /** Ends the helper by closing its input; it is killed if it does not go. */
  stop(): void {
    this.end(new HelperEnded('the OCR helper was stopped'));
    try {
      this.process.stdin?.end();
    } catch {
      // already closed
    }
    const stopped = this.process;
    setTimeout(() => {
      if (stopped.exitCode === null && stopped.signalCode === null) killProcessGroup(stopped.pid, 'SIGKILL');
    }, STOP_GRACE_MS).unref();
  }
}

// --- The pool -------------------------------------------------------------------------------------------------------

export interface OnnxOcrPoolOptions {
  plan?: OnnxHelperPlan;
  modelDir?: string;
  /** How a helper is started; the product uses the helper program (ocr-onnx-child). */
  entry?: ChildEntry;
  maxPagesPerHelper?: number;
  pageTimeoutMs?: number;
}

export class OnnxOcrPool {
  private readonly helpers = new Set<OnnxHelper>();
  private readonly slots: Semaphore;
  private readonly plan: OnnxHelperPlan;
  private retryAfter = 0;

  constructor(private readonly options: OnnxOcrPoolOptions = {}) {
    this.plan = options.plan ?? onnxHelperPlan();
    this.slots = new Semaphore(this.plan.helpers, ocrQueue(MAX_QUEUED_PAGES, 'ONNX OCR pages'));
  }

  /** The helpers that exist now, for the state tests read. */
  get size(): number {
    return this.helpers.size;
  }

  private modelDir(): string {
    return this.options.modelDir ?? onnxOcrModelDirectory();
  }

  private async acquire(signal?: AbortSignal): Promise<OnnxHelper> {
    const maxPages = this.options.maxPagesPerHelper ?? ONNX_HELPER_MAX_PAGES;
    for (const helper of this.helpers) {
      if (!helper.busy && !helper.ended && helper.pages >= maxPages) helper.stop();
    }
    // The helper is reserved before anything is awaited, so that a page that arrives while this one waits cannot be given the same helper.
    for (const helper of this.helpers) {
      if (helper.busy || helper.ended) continue;
      helper.busy = true;
      return helper;
    }
    if (Date.now() < this.retryAfter) throw new OnnxOcrUnavailableError('helper-not-starting', 'The ONNX OCR helper did not start a moment ago; it is not tried again yet.');
    const entry = this.options.entry ?? resolveChildEntry();
    if (!entry) throw new OnnxOcrUnavailableError('helper-missing', `The ONNX OCR helper (${CHILD_FILE}.js) is not built.`);
    // resolveSandboxedCommand throws SandboxUnavailableError on a host that cannot confine the helper: not caught, the request is refused.
    const helper = new OnnxHelper(entry, this.modelDir(), this.plan.threads);
    helper.busy = true;
    this.helpers.add(helper);
    helper.onEnd = () => this.helpers.delete(helper);
    let ready: boolean;
    try {
      ready = await helper.whenReady(signal);
    } catch (error) {
      // The job was aborted while the helper was starting: the page is not read, and the helper goes on to boot for the next one.
      helper.busy = false;
      throw error;
    }
    if (!ready) {
      this.retryAfter = Date.now() + RESTART_BACKOFF_MS;
      const said = helper.stderrText;
      throw new OnnxOcrUnavailableError(
        'helper-not-starting',
        `The ONNX OCR helper ended before it was ready (the models or the runtime could not be loaded)${said ? `: ${said}` : ''}.`
      );
    }
    return helper;
  }

  /** Reads one prepared page with the next free helper. */
  async read(input: OnnxPageInput, options: { language: string; recoverSpaces?: boolean; signal?: AbortSignal }): Promise<OcrResult> {
    return this.slots.run(async () => {
      options.signal?.throwIfAborted();
      const helper = await this.acquire(options.signal);
      const reply = await helper.read(input, options.language, options.recoverSpaces !== false, this.options.pageTimeoutMs ?? ONNX_PAGE_TIMEOUT_MS, options.signal);
      if (reply.type === 'error') {
        if (reply.kind === 'unavailable') throw new OnnxOcrUnavailableError('helper-not-starting', `The ONNX OCR helper could not read: ${reply.message}`);
        throw new OnnxOcrFailedError('rejected', `The ONNX OCR helper could not read the page: ${reply.message}`);
      }
      if (reply.type !== 'result') throw new OnnxOcrFailedError('helper-lost', 'The OCR helper sent an unexpected reply.');
      return checkedResult(reply.result, input.width, input.height, options.language);
    }, options.signal);
  }

  /** Ends every helper. */
  shutdown(): void {
    for (const helper of [...this.helpers]) helper.stop();
    this.helpers.clear();
  }
}

let shared: OnnxOcrPool | null = null;

export function getSharedOnnxOcrPool(): OnnxOcrPool {
  shared ??= new OnnxOcrPool();
  return shared;
}

/** Ends the shared helpers; call on process shutdown. */
export function shutdownOnnxOcrHelpers(): void {
  shared?.shutdown();
  shared = null;
}

// --- The reply is checked, not trusted ------------------------------------------------------------------------------

function fail(what: string): never {
  throw new OnnxOcrFailedError('rejected', `The OCR helper's reply is not a page reading (${what}).`);
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(what);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS) fail(what);
  return value;
}

function box(value: unknown, width: number, height: number): OcrBBox {
  const raw = value as Partial<OcrBBox> | null;
  if (!raw || typeof raw !== 'object') fail('a box');
  const x = finite(raw.x, 'a box');
  const y = finite(raw.y, 'a box');
  const w = finite(raw.width, 'a box');
  const h = finite(raw.height, 'a box');
  if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > width + 1 || y + h > height + 1) fail('a box outside the page');
  return { x, y, width: w, height: h };
}

/**
 * Rebuilds a helper's reply from the fields the product reads, each checked for type and range: the helper is a process that read
 * an untrusted image, so what it says is not taken as it comes.
 */
export function checkedResult(raw: unknown, width: number, height: number, language: string): OcrResult {
  const result = raw as { lineBlocks?: unknown } | null;
  if (!result || typeof result !== 'object' || !Array.isArray(result.lineBlocks)) fail('no lines');
  if (result.lineBlocks.length > MAX_REPLY_LINES) fail('too many lines');
  let wordTotal = 0;
  const lineBlocks: OcrLineBlock[] = result.lineBlocks.map((entry: unknown) => {
    const block = entry as Partial<OcrLineBlock> | null;
    if (!block || typeof block !== 'object' || !Array.isArray(block.words)) fail('a line');
    wordTotal += block.words.length;
    if (wordTotal > MAX_REPLY_WORDS) fail('too many words');
    const words: OcrWord[] = block.words.map((w: unknown) => {
      const word = w as Partial<OcrWord> | null;
      if (!word || typeof word !== 'object') fail('a word');
      const confidence = finite(word.confidence, 'a confidence');
      if (confidence < 0 || confidence > 1) fail('a confidence');
      return { text: text(word.text, 'a word'), confidence, bbox: box(word.bbox, width, height) };
    });
    const line: OcrLineBlock = { text: text(block.text, 'a line'), bbox: box(block.bbox, width, height), words };
    if (block.baseline) {
      line.baseline = { x0: finite(block.baseline.x0, 'a baseline'), y0: finite(block.baseline.y0, 'a baseline'), x1: finite(block.baseline.x1, 'a baseline'), y1: finite(block.baseline.y1, 'a baseline') };
    }
    if (block.rowHeight !== undefined) line.rowHeight = finite(block.rowHeight, 'a row height');
    if (block.angleDegrees !== undefined) line.angleDegrees = finite(block.angleDegrees, 'an angle');
    return line;
  });
  const words = lineBlocks.flatMap((block) => block.words);
  const characters = words.reduce((sum, word) => sum + word.text.length, 0);
  return {
    text: lineBlocks.map((block) => block.text).join('\n'),
    confidence: characters === 0 ? null : words.reduce((sum, word) => sum + (word.confidence ?? 0) * word.text.length, 0) / characters,
    confidenceCalibrated: false,
    wordCount: words.length,
    lines: lineBlocks.map((block) => block.text),
    lineBlocks,
    imageWidth: width,
    imageHeight: height,
    language,
  };
}

// --- The call the OCR pipeline makes --------------------------------------------------------------------------------

export interface OnnxPageOptions extends OnnxPrepareOptions {
  language: string;
  recoverSpaces?: boolean;
  signal?: AbortSignal;
}

/**
 * Reads one page (an encoded image) with the ONNX engine in a helper process. The result is in the pixels of the page as displayed,
 * with the raw recognizer scores as confidences (calibration is the caller's). Throws OnnxOcrUnavailableError when the engine cannot be
 * used here, OnnxOcrFailedError when the helper failed on this page, and the errors of decoding an image as the other engines do.
 */
export async function recognizePageWithOnnxHelper(imageBuffer: Buffer, options: OnnxPageOptions, pool: OnnxOcrPool = getSharedOnnxOcrPool()): Promise<OcrResult> {
  const unavailable = onnxOcrUnavailableReason();
  if (unavailable) throw new OnnxOcrUnavailableError(unavailable.reason, unavailable.message);
  const input = await prepareOnnxInput(imageBuffer, options);
  options.signal?.throwIfAborted();
  return pool.read(input, options);
}
