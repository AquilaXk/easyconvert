import { spawn, type ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getSanitizedEnvironment, killProcessGroup, resolveSandboxedCommand } from '../security/process-sandbox';
import { EngineUnavailableError } from '../types';
import {
  FRAME_PREFIX_BYTES,
  IMAGE_FETCH_LIMITS,
  ImageFetchRefusal,
  jsonFrame,
  MAX_FRAME_BYTES,
  SUPPORTED_TYPES_TEXT,
  sniffImageType,
  type FetchedImage,
  type ImageFetchLimits,
  type ImageFetchReply,
  type ImageFetchRequest,
  type ImageFetchTestRules,
} from './html-image-types';

export { IMAGE_FETCH_LIMITS, ImageFetchRefusal, sniffImageType };
export type { FetchedImage, ImageFetchLimits, ImageFetchTestRules };

/**
 * Fetches the images an HTML document names, for the converter that stages them as local data. The network is never
 * touched by the worker process: the fetches run in a child process (html-image-fetch-child.ts, guards in
 * html-image-fetch-core.ts) that starts with a stripped environment (no credentials or tokens, no proxy), only the
 * three standard streams, and its own resource limits. A session starts one child and sends it the URLs one after
 * another as length-prefixed frames on stdin; it returns the image bytes with a verdict on stdout, so the worker
 * holds no code path that connects to a host named by a document. The child is killed when the job is aborted, when
 * a fetch overruns, and when the session ends; if it dies on its own the session restarts it once. A deployment
 * that must not give the worker egress turns the feature off with HTML_IMAGE_FETCH=off.
 *
 * The session counts, sizes and times the fetches of one job; its caps hold across the routes a job may try.
 */

/** Name of the switch that turns image loading off (`off`); anything else, or nothing, leaves it on. */
export const HTML_IMAGE_FETCH_ENV = 'HTML_IMAGE_FETCH';
export const IMAGES_TURNED_OFF = 'loading images is turned off on this server';

export function imageFetchEnabled(): boolean {
  return (process.env[HTML_IMAGE_FETCH_ENV] ?? '').trim().toLowerCase() !== 'off';
}

const CHILD_FILE = 'html-image-fetch-child';
const ENGINE_NAME = 'html-image-fetcher';
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');
/** V8 heap ceiling of the child; the images it holds are at most the per-image cap. */
const CHILD_HEAP_MB = 256;
/** Wall-clock a reply may take beyond the fetch's own time limit, before the child is killed. */
const REPLY_ALLOWANCE_MS = 3000;
const CHILD_CPU_SECONDS = 120;
const CHILD_FILE_SIZE_BYTES = 8 * 1024 * 1024;
/** A child that has served nothing for this long is stopped (a session that is never closed leaves none behind). */
const IDLE_MS = 5000;
/** Times a child that died on its own is started again within one session. */
const MAX_CRASH_RESTARTS = 1;

type ChildEntry = { binary: string; args: string[] };

let childEntry: ChildEntry | undefined;

/** How to start the child: the bundled file next to this module or under `dist/`, otherwise the source through tsx. */
function resolveChildEntry(): ChildEntry {
  if (childEntry) return childEntry;
  const heap = `--max-old-space-size=${CHILD_HEAP_MB}`;
  const compiled = [path.join(__dirname, `${CHILD_FILE}.js`), path.join(process.cwd(), 'dist', `${CHILD_FILE}.js`)].find((candidate) =>
    fs.existsSync(candidate)
  );
  if (compiled) {
    childEntry = { binary: process.execPath, args: [heap, compiled] };
    return childEntry;
  }
  const source = [path.join(__dirname, `${CHILD_FILE}.ts`), path.join(process.cwd(), 'src', 'lib', 'conversions', `${CHILD_FILE}.ts`)].find(
    (candidate) => fs.existsSync(candidate)
  );
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
  throw new EngineUnavailableError(ENGINE_NAME, `build ${CHILD_FILE}.js with "npm run build:image-fetcher" or install the development dependencies`);
}

let testRules: ImageFetchTestRules | undefined;

/**
 * Sets fixed name-server answers and extra permitted addresses for the child, for the length of a test. Returns the
 * function that puts the production rules back. Nothing in the product calls this.
 */
export function overrideImageFetchRules(rules: ImageFetchTestRules): () => void {
  const previous = testRules;
  testRules = rules;
  return () => {
    testRules = previous;
  };
}

function timedOut(): ImageFetchRefusal {
  return new ImageFetchRefusal('loading the image took too long');
}

/** The child ended before it answered. */
class ChildCrashed extends Error {}
/** The child did not answer in time. */
class ChildTimedOut extends Error {}
/** The child sent something that is not a reply. */
class ChildProtocolError extends Error {}

interface ChildReply {
  header: ImageFetchReply;
  bytes: Buffer;
}

/** One running fetcher child: sends a request, reads the framed reply. One request at a time. */
class FetcherChild {
  readonly process: ChildProcess;
  private received = Buffer.alloc(0);
  private waiting: { allowed: number; resolve(reply: ChildReply): void; reject(error: Error): void } | null = null;
  private ended = false;

  constructor(entry: ChildEntry) {
    const command = resolveSandboxedCommand(entry.binary, entry.args, {
      networkIsolated: false,
      rlimits: { cpuSeconds: CHILD_CPU_SECONDS, fsizeBytes: CHILD_FILE_SIZE_BYTES },
    });
    // Directly, without a shell, in its own process group, with only the standard streams and the sanitized environment.
    this.process = spawn(command.binary, command.args, {
      cwd: os.tmpdir(),
      env: getSanitizedEnvironment({}, false),
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      detached: true,
    });
    this.process.unref();
    (this.process.stdout as unknown as { unref?: () => void }).unref?.();
    (this.process.stdin as unknown as { unref?: () => void }).unref?.();
    this.process.stdin?.on('error', () => undefined);
    this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.once('exit', () => this.end(new ChildCrashed('the fetcher ended')));
    this.process.once('error', () => this.end(new ChildCrashed('the fetcher could not be started')));
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get alive(): boolean {
    return !this.ended;
  }

  request(request: ImageFetchRequest, allowed: number, waitMs: number): Promise<ChildReply> {
    return new Promise<ChildReply>((resolve, reject) => {
      if (this.ended) {
        reject(new ChildCrashed('the fetcher ended'));
        return;
      }
      const timer = setTimeout(() => {
        this.end(new ChildTimedOut('the fetcher did not answer in time'));
        this.kill();
      }, waitMs);
      const settle = <T>(action: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        action(value);
      };
      this.waiting = { allowed, resolve: settle(resolve), reject: settle(reject) };
      this.process.stdin?.write(jsonFrame(request));
    });
  }

  kill(): void {
    killProcessGroup(this.process.pid, 'SIGKILL');
    try {
      this.process.kill('SIGKILL');
    } catch {
      // already gone
    }
    this.end(new ChildCrashed('the fetcher was stopped'));
  }

  /** Ends the child by closing its stdin; it exits when it has nothing left to do. */
  close(): void {
    try {
      this.process.stdin?.end();
    } catch {
      // already closed
    }
    this.kill();
  }

  private end(error: Error): void {
    if (this.ended && !this.waiting) return;
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  private onData(chunk: Buffer): void {
    this.received = Buffer.concat([this.received, chunk]);
    const waiting = this.waiting;
    if (!waiting || this.received.length < FRAME_PREFIX_BYTES) return;
    const headerLength = this.received.readUInt32BE(0);
    if (headerLength > MAX_FRAME_BYTES) {
      this.protocolError();
      return;
    }
    const headerEnd = FRAME_PREFIX_BYTES + headerLength;
    if (this.received.length < headerEnd) return;
    let header: ImageFetchReply;
    try {
      header = JSON.parse(this.received.subarray(FRAME_PREFIX_BYTES, headerEnd).toString('utf8')) as ImageFetchReply;
    } catch {
      this.protocolError();
      return;
    }
    const length = header.ok ? header.length : 0;
    if (header.ok && (!Number.isInteger(length) || length < 0 || length > waiting.allowed)) {
      this.protocolError();
      return;
    }
    if (this.received.length < headerEnd + length) return;
    const bytes = Buffer.from(this.received.subarray(headerEnd, headerEnd + length));
    this.received = Buffer.alloc(0);
    this.waiting = null;
    waiting.resolve({ header, bytes });
  }

  private protocolError(): void {
    this.end(new ChildProtocolError('the fetcher sent something that is not a reply'));
    this.kill();
  }
}

function imageOf(reply: ChildReply): FetchedImage {
  if (!reply.header.ok) throw new ImageFetchRefusal(typeof reply.header.reason === 'string' ? reply.header.reason : 'the image could not be loaded');
  // The child is not trusted with the verdict: the signature is checked again here.
  const mime = sniffImageType(reply.bytes);
  if (reply.bytes.length === 0 || mime === null || mime !== reply.header.mime) {
    throw new ImageFetchRefusal(`the response is not a ${SUPPORTED_TYPES_TEXT} image`);
  }
  return { bytes: reply.bytes, mime };
}

export interface ImageFetchSessionOptions {
  /** The job's signal: once it fires, no further fetch starts and one in flight is killed. */
  signal?: AbortSignal;
}

/** The fetches of one job: they share one child, the count, size and time caps, and the same URL is fetched once. */
export class ImageFetchSession {
  private readonly limits: ImageFetchLimits;
  private readonly deadline: number;
  private readonly results = new Map<string, Promise<FetchedImage>>();
  private queue: Promise<unknown> = Promise.resolve();
  private child: FetcherChild | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private totalBytes = 0;
  private crashRestarts = 0;
  private broken = false;
  private started = 0;
  private readonly onAbort = (): void => this.stopChild();

  constructor(
    limits: Partial<ImageFetchLimits> = {},
    private readonly options: ImageFetchSessionOptions = {}
  ) {
    this.limits = { ...IMAGE_FETCH_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.totalMs;
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  /** How many child processes this session has started. */
  get childrenStarted(): number {
    return this.started;
  }

  /** The process id of the running child, if any. */
  get childPid(): number | undefined {
    return this.child?.alive ? this.child.pid : undefined;
  }

  /** The image at an absolute http or https URL. Rejects with ImageFetchRefusal; an aborted job rejects with its abort reason. */
  fetch(reference: string): Promise<FetchedImage> {
    const known = this.results.get(reference);
    if (known) return known;
    const started = this.enqueue(() => this.start(reference));
    this.results.set(reference, started);
    return started;
  }

  /** Ends the session: the child is stopped. Fetches already finished keep their results. */
  close(): void {
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.stopChild();
  }

  /** The fetches go to one child one at a time, in the order they were asked for. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private stopChild(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.close();
    this.child = null;
  }

  private throwIfAborted(): void {
    const signal = this.options.signal;
    if (signal?.aborted) throw signal.reason ?? new Error('The operation was aborted');
  }

  private async start(reference: string): Promise<FetchedImage> {
    this.throwIfAborted();
    if (!imageFetchEnabled()) throw new ImageFetchRefusal(IMAGES_TURNED_OFF);
    if (this.attempts >= this.limits.maxImages) {
      throw new ImageFetchRefusal(`the limit of ${this.limits.maxImages} images per document was reached`);
    }
    this.attempts++;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    const image = await this.ask(reference, Math.min(this.limits.perFetchMs, remaining));
    this.totalBytes += image.bytes.length;
    return image;
  }

  private ensureChild(): FetcherChild {
    if (this.child?.alive) return this.child;
    this.child = new FetcherChild(resolveChildEntry());
    this.started++;
    return this.child;
  }

  private async ask(reference: string, timeoutMs: number): Promise<FetchedImage> {
    const allowed = Math.min(this.limits.maxImageBytes, this.limits.maxTotalBytes - this.totalBytes);
    const request: ImageFetchRequest = {
      url: reference,
      maxBytes: allowed,
      tooLargeReason:
        allowed < this.limits.maxImageBytes
          ? `the images together would pass the total size of ${this.limits.maxTotalBytes} bytes`
          : `the image is larger than ${this.limits.maxImageBytes} bytes`,
      timeoutMs,
      maxRedirects: this.limits.maxRedirects,
      ...(testRules ? { testRules } : {}),
    };
    for (;;) {
      if (this.broken) throw new ImageFetchRefusal('the image could not be loaded');
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const child = this.ensureChild();
      try {
        return imageOf(await child.request(request, allowed, timeoutMs + REPLY_ALLOWANCE_MS));
      } catch (error) {
        this.throwIfAborted();
        if (error instanceof ImageFetchRefusal) throw error;
        this.child = null;
        child.kill();
        if (error instanceof ChildTimedOut) throw timedOut();
        if (error instanceof ChildCrashed && this.crashRestarts < MAX_CRASH_RESTARTS) {
          this.crashRestarts++;
          continue;
        }
        this.broken = true;
        throw new ImageFetchRefusal('the image could not be loaded');
      } finally {
        this.idleTimer = setTimeout(() => this.stopChild(), IDLE_MS);
        this.idleTimer.unref();
      }
    }
  }
}

const jobSessions = new AsyncLocalStorage<ImageFetchSession>();

/** Runs `work` with one fetch session for everything inside it, so the caps hold for a whole job whichever route it takes. */
export async function runWithImageFetchSession<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const session = new ImageFetchSession({}, { signal });
  try {
    return await jobSessions.run(session, work);
  } finally {
    session.close();
  }
}

/** The session of the job being converted, or a new one (with the caller's signal) outside any job; the caller closes that one. */
export function currentImageFetchSession(signal?: AbortSignal): ImageFetchSession {
  return jobSessions.getStore() ?? new ImageFetchSession({}, { signal });
}

/** Runs `work` with the session of the job being converted, or with a session of its own that ends with the work. */
export async function withImageFetchSession<T>(signal: AbortSignal | undefined, work: (session: ImageFetchSession) => Promise<T>): Promise<T> {
  const inJob = jobSessions.getStore();
  if (inJob) return work(inJob);
  const own = new ImageFetchSession({}, { signal });
  try {
    return await work(own);
  } finally {
    own.close();
  }
}
