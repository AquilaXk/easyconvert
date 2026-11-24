import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy, { type BusboyFileStream, type BusboyInstance } from '@fastify/busboy';
import { SINGLE_REQUEST_BODY_MAX_BYTES } from '../plan-limits';
import { PayloadLimitError, RequestAbortedError } from '../types';
import { SMALL_REQUEST_BODY_MAX_BYTES } from './request-body-limit';

/** Maximum total multipart request body bytes streamed when Content-Length is absent. */
export const MAX_MULTIPART_BODY_BYTES = SINGLE_REQUEST_BODY_MAX_BYTES;
/** Maximum non-file field bytes (above 1 MiB JSON bound so boundedJsonFieldProblem still answers typed 413). */
export const MAX_MULTIPART_FIELD_BYTES = 2 * SMALL_REQUEST_BODY_MAX_BYTES;
export const MAX_MULTIPART_FIELD_NAME_BYTES = 256;
export const MAX_MULTIPART_FILES = 128;
export const MAX_MULTIPART_FIELDS = 128;
export const MAX_MULTIPART_PARTS = 256;
export const MAX_MULTIPART_HEADER_PAIRS = 128;

const DEFAULT_PART_MIME = 'application/octet-stream';
const SCRATCH_PREFIX = 'easyconvert-multipart-';
const ABORT_SENTINEL = Symbol('multipart-parse-aborted');

/** Whether a request declares a `multipart/form-data` body. */
export const isMultipartBody = (req: Request): boolean =>
  (req.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');

/** A multipart body read whole: its form, or the parser/stream error for a body that is truncated or not well-formed multipart. */
export type MultipartRead = { form: FormData; malformed?: undefined } | { malformed: Error; form?: undefined };

type MultipartSlot =
  | { name: string; kind: 'field'; value: string }
  | { name: string; kind: 'file'; promise: Promise<File> };

interface MultipartParseState {
  scratchDirPromise?: Promise<string>;
  scratchDirPath?: string;
  activeFileStreams: Set<BusboyFileStream>;
  activeWriteStreams: Set<fs.WriteStream>;
  slots: MultipartSlot[];
  fileTasks: Promise<void>[];
  nextFileIndex: number;
  fatalError?: Error;
  malformedError?: Error;
  parseAbort: AbortController;
}

const parsedMultipartCache = new WeakMap<Request, Promise<MultipartRead>>();
const scratchDirsByRequest = new WeakMap<Request, string>();
const registryTokensByRequest = new WeakMap<Request, object>();
const scratchDirRegistry = new FinalizationRegistry<string>((dir) => {
  void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function failState(state: MultipartParseState, kind: 'fatal' | 'malformed', error: Error): void {
  if (kind === 'fatal' && !state.fatalError) {
    state.fatalError = error;
  } else if (kind === 'malformed' && !state.malformedError && !state.fatalError) {
    state.malformedError = error;
  }
  if (!state.parseAbort.signal.aborted) {
    state.parseAbort.abort(error);
  }
}

function trackScratchDir(req: Request, dir: string): void {
  scratchDirsByRequest.set(req, dir);
  const token = {};
  registryTokensByRequest.set(req, token);
  scratchDirRegistry.register(req, dir, token);
}

function ensureScratchDir(state: MultipartParseState): Promise<string> {
  if (!state.scratchDirPromise) {
    state.scratchDirPromise = fs.promises
      .mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX))
      .then((dir) => {
        state.scratchDirPath = dir;
        return dir;
      });
  }
  return state.scratchDirPromise;
}

async function waitForWriteStreamClose(ws: fs.WriteStream): Promise<void> {
  if (ws.closed) return;
  await new Promise<void>((resolve) => {
    ws.once('close', resolve);
  });
}

async function spillFileToDisk(
  state: MultipartParseState,
  stream: BusboyFileStream,
  filename: string,
  mimeType: string,
  index: number
): Promise<File> {
  const dir = await ensureScratchDir(state);
  if (state.parseAbort.signal.aborted) {
    throw state.fatalError ?? state.malformedError ?? new Error('Multipart parse aborted.');
  }
  const partPath = path.join(dir, `part-${index}.bin`);
  const ws = fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 });
  state.activeWriteStreams.add(ws);
  try {
    await pipeline(stream, ws, { signal: state.parseAbort.signal });
  } catch (err: unknown) {
    if (!state.parseAbort.signal.aborted && !state.fatalError && !state.malformedError) {
      failState(state, 'fatal', toError(err));
    }
    throw toError(err);
  } finally {
    await waitForWriteStreamClose(ws);
    state.activeWriteStreams.delete(ws);
    state.activeFileStreams.delete(stream);
  }
  if (stream.truncated) {
    const err = new TypeError('Multipart file part was truncated.');
    failState(state, 'malformed', err);
    throw err;
  }
  const resolvedMime = mimeType || DEFAULT_PART_MIME;
  const blob = await fs.openAsBlob(partPath, { type: resolvedMime });
  return new File([blob], filename ?? '', { type: resolvedMime });
}

async function cleanupParseResources(state: MultipartParseState, bb: BusboyInstance): Promise<void> {
  for (const stream of state.activeFileStreams) {
    stream.destroy();
  }
  for (const ws of state.activeWriteStreams) {
    ws.destroy();
  }
  if (!bb.destroyed) {
    bb.destroy();
  }
  await Promise.allSettled(state.fileTasks);
  const dir =
    state.scratchDirPath ??
    (state.scratchDirPromise ? await state.scratchDirPromise.catch(() => undefined) : undefined);
  state.scratchDirPath = undefined;
  if (dir) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function attachBusboyHandlers(bb: BusboyInstance, state: MultipartParseState): Promise<void> {
  const rejectMalformed = (message: string): void => {
    failState(state, 'malformed', new TypeError(message));
  };

  bb.on('error', (err) => failState(state, 'malformed', toError(err)));
  bb.on('filesLimit', () => rejectMalformed('Multipart request exceeds maximum number of files.'));
  bb.on('fieldsLimit', () => rejectMalformed('Multipart request exceeds maximum number of fields.'));
  bb.on('partsLimit', () => rejectMalformed('Multipart request exceeds maximum number of parts.'));

  bb.on('field', (fieldname, value, fieldnameTruncated, valueTruncated) => {
    if (
      fieldname === undefined ||
      fieldnameTruncated ||
      Buffer.byteLength(fieldname) > MAX_MULTIPART_FIELD_NAME_BYTES
    ) {
      rejectMalformed('Multipart field name is missing or exceeds maximum size.');
      return;
    }
    if (valueTruncated) {
      failState(state, 'fatal', new PayloadLimitError('Multipart form field exceeds maximum size.'));
      return;
    }
    state.slots.push({ name: fieldname, kind: 'field', value });
  });

  bb.on('file', (fieldname, stream, filename, _transferEncoding, mimeType) => {
    state.activeFileStreams.add(stream);
    stream.on('error', (err) => failState(state, 'malformed', toError(err)));
    stream.on('limit', () => rejectMalformed('Multipart file part was truncated.'));
    stream.once('close', () => state.activeFileStreams.delete(stream));

    if (state.parseAbort.signal.aborted) {
      stream.resume();
      return;
    }
    if (fieldname === undefined || Buffer.byteLength(fieldname) > MAX_MULTIPART_FIELD_NAME_BYTES) {
      stream.resume();
      rejectMalformed('Multipart file field name is missing or exceeds maximum size.');
      return;
    }

    const idx = state.nextFileIndex++;
    const filePromise = spillFileToDisk(state, stream, filename, mimeType, idx);
    state.slots.push({ name: fieldname, kind: 'file', promise: filePromise });
    state.fileTasks.push(filePromise.then(() => undefined, () => undefined));
  });

  return new Promise<void>((resolve) => {
    const done = () => resolve();
    bb.once('finish', done);
    if (state.parseAbort.signal.aborted) {
      done();
    } else {
      state.parseAbort.signal.addEventListener('abort', done, { once: true });
    }
  });
}

async function writeChunkToBusboy(
  bb: BusboyInstance,
  chunk: Uint8Array,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || bb.destroyed || bb.writableEnded) return;
  if (bb.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      bb.off('drain', finish);
      bb.off('close', finish);
      bb.off('error', finish);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    bb.once('drain', finish);
    bb.once('close', finish);
    bb.once('error', finish);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function pumpBodyToBusboy(
  body: ReadableStream<Uint8Array>,
  bb: BusboyInstance,
  req: Request,
  state: MultipartParseState
): Promise<void> {
  const reader = body.getReader();
  const abortWait = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(ABORT_SENTINEL);
    if (state.parseAbort.signal.aborted) onAbort();
    else state.parseAbort.signal.addEventListener('abort', onAbort, { once: true });
  });
  abortWait.catch(() => undefined);

  let totalBytes = 0;
  try {
    for (;;) {
      if (state.parseAbort.signal.aborted) break;
      const result = await Promise.race([reader.read(), abortWait]);
      if (result.done) {
        if (!state.parseAbort.signal.aborted && !bb.destroyed) {
          bb.end();
        }
        break;
      }
      const chunk = result.value;
      if (!chunk || chunk.byteLength === 0) continue;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_MULTIPART_BODY_BYTES) {
        failState(state, 'fatal', new PayloadLimitError('Multipart request body exceeds the single-request size limit.'));
        break;
      }
      await writeChunkToBusboy(bb, chunk, state.parseAbort.signal);
    }
  } catch (err: unknown) {
    if (err !== ABORT_SENTINEL) {
      if (req.signal.aborted) {
        failState(state, 'fatal', new RequestAbortedError({ cause: err }));
      } else {
        failState(state, 'malformed', toError(err));
      }
    }
  } finally {
    if (state.parseAbort.signal.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function buildOrderedFormData(state: MultipartParseState): Promise<FormData> {
  const form = new FormData();
  for (const slot of state.slots) {
    if (slot.kind === 'field') {
      form.append(slot.name, slot.value);
    } else {
      form.append(slot.name, await slot.promise);
    }
  }
  return form;
}

function hasInvalidEmptyBoundary(contentType: string): boolean {
  return /;\s*boundary\s*=\s*(?:""\s*(?:;|$)|\s*(?:;|$))/i.test(contentType);
}

function createBusboyParser(contentType: string): BusboyInstance {
  if (hasInvalidEmptyBoundary(contentType)) {
    throw new TypeError('Multipart: Boundary is empty.');
  }
  return new Busboy({
    headers: { 'content-type': contentType },
    defCharset: 'utf8',
    preservePath: true,
    isPartAFile: (_fieldName, _contentType, fileName) => fileName !== undefined,
    limits: {
      fieldNameSize: MAX_MULTIPART_FIELD_NAME_BYTES,
      fieldSize: MAX_MULTIPART_FIELD_BYTES,
      fields: MAX_MULTIPART_FIELDS,
      files: MAX_MULTIPART_FILES,
      parts: MAX_MULTIPART_PARTS,
      headerPairs: MAX_MULTIPART_HEADER_PAIRS,
    },
  });
}

async function streamIntoBusboy(
  req: Request,
  body: ReadableStream<Uint8Array>,
  bb: BusboyInstance
): Promise<MultipartRead> {
  const state: MultipartParseState = {
    activeFileStreams: new Set(),
    activeWriteStreams: new Set(),
    slots: [],
    fileTasks: [],
    nextFileIndex: 0,
    parseAbort: new AbortController(),
  };
  const onReqAbort = () => {
    failState(state, 'fatal', new RequestAbortedError({ cause: req.signal.reason }));
  };
  req.signal.addEventListener('abort', onReqAbort, { once: true });

  try {
    const settled = attachBusboyHandlers(bb, state);
    await Promise.all([pumpBodyToBusboy(body, bb, req, state), settled]);
    if (!state.parseAbort.signal.aborted) {
      await Promise.all(state.fileTasks);
    }
    if (req.signal.aborted) {
      throw new RequestAbortedError({ cause: state.fatalError ?? req.signal.reason });
    }
    if (state.fatalError) {
      throw state.fatalError;
    }
    if (state.malformedError) {
      await cleanupParseResources(state, bb);
      return { malformed: state.malformedError };
    }

    const form = await buildOrderedFormData(state);
    if (state.scratchDirPath) {
      trackScratchDir(req, state.scratchDirPath);
    }
    return { form };
  } catch (error: unknown) {
    await cleanupParseResources(state, bb);
    if (req.signal.aborted && !(error instanceof RequestAbortedError)) {
      throw new RequestAbortedError({ cause: error });
    }
    if (error instanceof PayloadLimitError || error instanceof RequestAbortedError) {
      throw error;
    }
    if (state.fatalError) {
      throw state.fatalError;
    }
    if (state.malformedError) {
      return { malformed: state.malformedError };
    }
    throw error;
  } finally {
    req.signal.removeEventListener('abort', onReqAbort);
  }
}

async function parseMultipartOnce(req: Request): Promise<MultipartRead> {
  if (Object.hasOwn(req, 'formData')) {
    try {
      return { form: await req.formData() };
    } catch (error: unknown) {
      if (req.signal.aborted) throw new RequestAbortedError({ cause: error });
      return { malformed: toError(error) };
    }
  }
  if (req.signal.aborted) {
    throw new RequestAbortedError({ cause: req.signal.reason });
  }
  if (!req.body) {
    return { malformed: new TypeError('Request body is empty or not multipart/form-data.') };
  }

  const contentType = req.headers.get('content-type') ?? '';
  let bb: BusboyInstance;
  try {
    bb = createBusboyParser(contentType);
  } catch (error: unknown) {
    await req.body.cancel().catch(() => undefined);
    if (req.signal.aborted) throw new RequestAbortedError({ cause: error });
    return { malformed: toError(error) };
  }

  return streamIntoBusboy(req, req.body, bb);
}

/**
 * Reads the multipart body of `req` at most once per request instance, streaming uploaded file parts into an isolated
 * scratch directory (`0o700` dir, `0o600` files) wrapped as lazy disk-backed `File` instances via `fs.openAsBlob`.
 * Callers must invoke `releaseMultipartForm(req)` in `finally` after reading any file payloads.
 */
export function readMultipartForm(req: Request): Promise<MultipartRead> {
  let cached = parsedMultipartCache.get(req);
  if (!cached) {
    cached = parseMultipartOnce(req);
    cached.catch(() => {});
    parsedMultipartCache.set(req, cached);
  }
  return cached;
}

/** Releases cached parse state and removes any disk-spilled multipart scratch directory created for `req`. */
export async function releaseMultipartForm(req: Request): Promise<void> {
  parsedMultipartCache.delete(req);
  const token = registryTokensByRequest.get(req);
  if (token) {
    registryTokensByRequest.delete(req);
    scratchDirRegistry.unregister(token);
  }
  const dir = scratchDirsByRequest.get(req);
  if (dir) {
    scratchDirsByRequest.delete(req);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The text of the form field `name`; undefined when the field is missing or holds a file. */
export function formText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The first of the text fields `names` that the form holds as a file part. `formText` reads such a field as missing, which is
 * right for a required field but would drop an option or a webhook the caller sent, and convert without it.
 */
export function fileSentAsText<Name extends string>(form: FormData, names: readonly Name[]): Name | undefined {
  return names.find((name) => {
    const value = form.get(name);
    return value !== null && typeof value !== 'string';
  });
}
