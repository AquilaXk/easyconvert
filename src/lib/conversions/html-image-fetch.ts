import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { EngineUnavailableError } from '../types';
import {
  IMAGE_FETCH_LIMITS,
  ImageFetchRefusal,
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
 * touched by the worker process: each fetch runs in a child process (html-image-fetch-child.ts, guards in
 * html-image-fetch-core.ts) that starts with a stripped environment (no credentials or tokens, no proxy), only the
 * three standard streams, and its own resource limits. It receives one URL on stdin and returns the image bytes with
 * a verdict on stdout, so the worker holds no code path that connects to a host named by a document. A deployment
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
/** Wall-clock the child may spend on top of the fetch itself (starting node), before it is killed. */
const CHILD_START_ALLOWANCE_MS = 5000;
const CHILD_CPU_SECONDS = 60;
const CHILD_FILE_SIZE_BYTES = 8 * 1024 * 1024;
/** Room for the reply line before the image bytes. */
const REPLY_LINE_ALLOWANCE = 1024;

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

function parseReply(stdout: Buffer, allowed: number): FetchedImage {
  const newline = stdout.indexOf(0x0a);
  if (newline < 0) throw new ImageFetchRefusal('the image could not be loaded');
  let reply: ImageFetchReply;
  try {
    reply = JSON.parse(stdout.subarray(0, newline).toString('utf8')) as ImageFetchReply;
  } catch {
    throw new ImageFetchRefusal('the image could not be loaded');
  }
  if (!reply.ok) throw new ImageFetchRefusal(typeof reply.reason === 'string' ? reply.reason : 'the image could not be loaded');
  const bytes = stdout.subarray(newline + 1);
  // The child is not trusted with the verdict: the size and the signature are checked again here.
  const mime = sniffImageType(bytes);
  if (bytes.length === 0 || bytes.length > allowed || mime === null || mime !== reply.mime) {
    throw new ImageFetchRefusal(`the response is not a ${SUPPORTED_TYPES_TEXT} image`);
  }
  return { bytes: Buffer.from(bytes), mime };
}

export interface ImageFetchSessionOptions {
  /** The job's signal: once it fires, no further fetch starts and one in flight is killed. */
  signal?: AbortSignal;
}

/** The fetches of one job: they share the count, size and time caps, and the same URL is fetched once. */
export class ImageFetchSession {
  private readonly limits: ImageFetchLimits;
  private readonly deadline: number;
  private readonly results = new Map<string, Promise<FetchedImage>>();
  private attempts = 0;
  private totalBytes = 0;

  constructor(
    limits: Partial<ImageFetchLimits> = {},
    private readonly options: ImageFetchSessionOptions = {}
  ) {
    this.limits = { ...IMAGE_FETCH_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.totalMs;
  }

  /** The image at an absolute http or https URL. Rejects with ImageFetchRefusal; an aborted job rejects with its abort reason. */
  fetch(reference: string): Promise<FetchedImage> {
    const known = this.results.get(reference);
    if (known) return known;
    const started = this.start(reference);
    this.results.set(reference, started);
    return started;
  }

  private async start(reference: string): Promise<FetchedImage> {
    this.options.signal?.throwIfAborted();
    if (!imageFetchEnabled()) throw new ImageFetchRefusal(IMAGES_TURNED_OFF);
    if (this.attempts >= this.limits.maxImages) {
      throw new ImageFetchRefusal(`the limit of ${this.limits.maxImages} images per document was reached`);
    }
    this.attempts++;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    const image = await this.runChild(reference, Math.min(this.limits.perFetchMs, remaining));
    this.totalBytes += image.bytes.length;
    return image;
  }

  private async runChild(reference: string, timeoutMs: number): Promise<FetchedImage> {
    const allowed = Math.min(this.limits.maxImageBytes, this.limits.maxTotalBytes - this.totalBytes);
    const tooLargeReason =
      allowed < this.limits.maxImageBytes
        ? `the images together would pass the total size of ${this.limits.maxTotalBytes} bytes`
        : `the image is larger than ${this.limits.maxImageBytes} bytes`;
    const request: ImageFetchRequest = {
      url: reference,
      maxBytes: allowed,
      tooLargeReason,
      timeoutMs,
      maxRedirects: this.limits.maxRedirects,
      ...(testRules ? { testRules } : {}),
    };
    const entry = resolveChildEntry();
    try {
      const result = await executeSandboxedBinary(entry.binary, entry.args, {
        stdin: Buffer.from(JSON.stringify(request), 'utf8'),
        env: {},
        networkIsolated: false,
        timeoutMs: timeoutMs + CHILD_START_ALLOWANCE_MS,
        maxBuffer: allowed + REPLY_LINE_ALLOWANCE,
        rlimits: { cpuSeconds: CHILD_CPU_SECONDS, fsizeBytes: CHILD_FILE_SIZE_BYTES },
        signal: this.options.signal,
      });
      return parseReply(result.stdout, allowed);
    } catch (error) {
      if (error instanceof ImageFetchRefusal || this.options.signal?.aborted) throw error;
      if (error instanceof SandboxedTimeoutError) throw timedOut();
      if (error instanceof SandboxedBufferLimitError) throw new ImageFetchRefusal(tooLargeReason);
      if (error instanceof SandboxedMemoryLimitError || error instanceof SandboxedProcessError) {
        throw new ImageFetchRefusal('the image could not be loaded');
      }
      throw error;
    }
  }
}

const jobSessions = new AsyncLocalStorage<ImageFetchSession>();

/** Runs `work` with one fetch session for everything inside it, so the caps hold for a whole job whichever route it takes. */
export function runWithImageFetchSession<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  return jobSessions.run(new ImageFetchSession({}, { signal }), work);
}

/** The session of the job being converted, or a new one (with the caller's signal) outside any job. */
export function currentImageFetchSession(signal?: AbortSignal): ImageFetchSession {
  return jobSessions.getStore() ?? new ImageFetchSession({}, { signal });
}
