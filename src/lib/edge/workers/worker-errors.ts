import {
  ConversionFailedError,
  CorruptStreamError,
  DataEncodingError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
  DecompressionLimitError,
  UnsupportedOptionError,
} from '../../types';

/**
 * Errors cross the Worker boundary as plain data (structured clone drops the class), so the
 * worker sends `{ name, message, row?, line?, column? }` and the main thread rebuilds the typed
 * error: a DataEncodingError thrown in the worker is still a DataEncodingError for the caller.
 */
export interface SerializedWorkerError {
  name: string;
  message: string;
  row?: number;
  line?: number;
  column?: number;
}

/**
 * The browser edge tier cannot convert this input or target: a container it has no demuxer for, a codec the
 * platform has no decoder or encoder for, or a configuration the muxers cannot describe truthfully. The tier
 * router answers it by running the server tier; it is never an invitation to produce substitute output.
 */
export class EdgeUnsupportedError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeUnsupportedError';
  }
}

/**
 * The browser storage the conversion writes to is full. It is a verdict on this device, not on the file, so the
 * server tier runs; the partial output is deleted and the work is never restarted in memory.
 */
export class EdgeStorageQuotaError extends EdgeUnsupportedError {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeStorageQuotaError';
  }
}

type MessageOnlyError = new (message: string) => ConversionFailedError;

/** Typed errors rebuilt by name; DataParseError is handled separately for its location. */
const MESSAGE_ONLY_ERRORS: ReadonlyMap<string, MessageOnlyError> = new Map<string, MessageOnlyError>([
  ['ConversionFailedError', ConversionFailedError],
  ['CorruptStreamError', CorruptStreamError],
  ['DataEncodingError', DataEncodingError],
  ['DataLimitExceededError', DataLimitExceededError],
  ['DataRepresentationError', DataRepresentationError],
  ['DecompressionLimitError', DecompressionLimitError],
  ['EdgeStorageQuotaError', EdgeStorageQuotaError],
  ['EdgeUnsupportedError', EdgeUnsupportedError],
  ['UnsupportedOptionError', UnsupportedOptionError],
]);

const FALLBACK_MESSAGE = 'OPFS VFS streaming execution failed';

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function serializeWorkerError(err: unknown): SerializedWorkerError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err ?? FALLBACK_MESSAGE) };
  const serialized: SerializedWorkerError = { name: err.name, message: err.message || FALLBACK_MESSAGE };
  if (err instanceof DataParseError) {
    serialized.row = err.row;
    serialized.line = err.line;
    serialized.column = err.column;
  }
  return serialized;
}

export function rehydrateWorkerError(payload: unknown): Error {
  const data = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<SerializedWorkerError>;
  const message = typeof data.message === 'string' && data.message !== '' ? data.message : FALLBACK_MESSAGE;
  const name = typeof data.name === 'string' ? data.name : 'Error';
  if (name === 'DataParseError') {
    return new DataParseError(message, {
      row: optionalNumber(data.row),
      line: optionalNumber(data.line),
      column: optionalNumber(data.column),
    });
  }
  const ErrorClass = MESSAGE_ONLY_ERRORS.get(name);
  if (ErrorClass) return new ErrorClass(message);
  const error = new Error(message);
  error.name = name;
  return error;
}
