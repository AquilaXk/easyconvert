import { isMainThread } from 'node:worker_threads';
import {
  ConversionFailedError,
  DataEncodingError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
  EngineUnavailableError,
  FontCoverageError,
  PayloadLimitError,
  SheetLimitError,
  UnsupportedOptionError,
  UnsupportedTargetError,
  type ConversionOptions,
  type ConversionResult,
} from '../types';
import { isCodeOf, CONVERSION_REFUSAL_CODES, type ConversionRefusalCode } from '../refusal-codes';
import { runCpuTask, shareBytes } from '../workers/cpu-pool';
import { reportConversionWarning } from './conversion-warnings';

/**
 * Structured-data conversions on a CPU pool thread. Parsing a table or a document builds every value of it as a JavaScript value,
 * about a second for each 10 MB of JSON and for each megabyte of YAML, so a text of `DATA_POOL_MIN_BYTES` or more is converted on a
 * pool thread and the event loop of the worker (the heartbeat of its job, health checks) keeps turning. The thread holds a heap of
 * its own (the pool's 1 GiB limit), so a text that still asks for more fails that thread with a payload limit instead of the worker.
 *
 * What crosses the thread boundary is data. The input is copied once into shared memory and read by the thread without another copy,
 * the output is handed back by transfer, the warnings the conversion reported travel with it, and a refusal travels as its class, its
 * message and its position, so the routes answer the same status as they do for a conversion on the calling thread.
 */

/** Texts shorter than this convert on the calling thread: a thread takes longer to reach than the conversion takes (under 100 ms). */
export const DATA_POOL_MIN_BYTES = 128 * 1024;

export type DataTaskKind = 'convert' | 'workbook';

/** What the pool thread needs: structured data only, the input in shared memory. */
export interface DataTaskPayload {
  task: DataTaskKind;
  input: Uint8Array;
  sourceFormat: string;
  targetFormat: string;
  options: ConversionOptions;
  originalFilename: string;
}

/** A refusal as data: the class by name, and what its constructor needs. */
export interface DataTaskFailure {
  name: string;
  message: string;
  refusalCode?: string;
  status?: number;
  line?: number;
  column?: number;
  row?: number;
  codePoint?: number;
  engineName?: string;
  reason?: string;
}

export type DataTaskOutcome =
  | { ok: { buffer: Uint8Array; mimeType: string; filename: string; warnings: string[] } }
  | { failure: DataTaskFailure };

export function failureOf(error: unknown): DataTaskFailure | null {
  if (!(error instanceof ConversionFailedError)) return null;
  const known = error as ConversionFailedError & Partial<DataTaskFailure>;
  return {
    name: error.name,
    message: error.message,
    refusalCode: known.refusalCode,
    status: known.status,
    line: known.line,
    column: known.column,
    row: known.row,
    codePoint: known.codePoint,
    engineName: known.engineName,
    reason: known.reason,
  };
}

/** The error of a failure: the class of a typed refusal with its position, else a conversion failure that keeps the name and the code. */
export function errorOf(failure: DataTaskFailure): Error {
  const { message } = failure;
  switch (failure.name) {
    case 'DataParseError':
      return new DataParseError(message, { line: failure.line, column: failure.column, row: failure.row });
    case 'DataLimitExceededError':
      return new DataLimitExceededError(message);
    case 'DataEncodingError':
      return new DataEncodingError(message);
    case 'DataRepresentationError':
      return new DataRepresentationError(message);
    case 'UnsupportedOptionError':
      return new UnsupportedOptionError(message);
    case 'UnsupportedTargetError':
      return new UnsupportedTargetError(message);
    case 'PayloadLimitError':
      return new PayloadLimitError(message);
    case 'SheetLimitError':
      return new SheetLimitError(message);
    case 'FontCoverageError':
      return new FontCoverageError(message, failure.codePoint ?? 0);
    case 'EngineUnavailableError':
      return new EngineUnavailableError(failure.engineName ?? 'data', failure.reason);
    default: {
      const error = new ConversionFailedError(message);
      error.name = failure.name;
      if (isCodeOf(CONVERSION_REFUSAL_CODES, failure.refusalCode)) (error as { refusalCode: ConversionRefusalCode }).refusalCode = failure.refusalCode;
      if (failure.status !== undefined) (error as ConversionFailedError & { status?: number }).status = failure.status;
      return error;
    }
  }
}

/** The options a thread can receive: the caller's signal stays with the caller, and an option that cannot be copied keeps the conversion on this thread. */
function transferableOptions(options: ConversionOptions): ConversionOptions | null {
  const { signal: _signal, ...rest } = options;
  try {
    return structuredClone(rest);
  } catch {
    return null;
  }
}

/**
 * Runs a data conversion on a pool thread when the input is large enough and this is the main thread; returns `null` when the caller
 * is to convert on its own thread. The result of a `workbook` task is the workbook alone.
 */
export async function convertOnDataThread(
  task: 'convert',
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions,
  originalFilename: string
): Promise<ConversionResult | null>;
export async function convertOnDataThread(
  task: 'workbook',
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions,
  originalFilename: string
): Promise<Buffer | null>;
export async function convertOnDataThread(
  task: DataTaskKind,
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions,
  originalFilename: string
): Promise<ConversionResult | Buffer | null> {
  if (input.length < DATA_POOL_MIN_BYTES || !isMainThread) return null;
  const clonable = transferableOptions(options);
  if (clonable === null) return null;
  const payload: DataTaskPayload = { task, input: await shareBytes(input), sourceFormat, targetFormat, options: clonable, originalFilename };
  const outcome = await runCpuTask<DataTaskOutcome>('dataConversion', payload, { signal: options.signal });
  if ('failure' in outcome) throw errorOf(outcome.failure);
  const { buffer: bytes, mimeType, filename, warnings } = outcome.ok;
  for (const line of warnings) reportConversionWarning(line);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return task === 'workbook' ? buffer : { buffer, mimeType, filename, size: buffer.length };
}
