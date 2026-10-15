import fs from 'node:fs';
import path from 'node:path';
import { WorkerOutputMissingError } from '../lib/types';

/** V8 Buffer max size is 2GB - 1 byte (2147483647). */
const MAX_SINGLE_BUFFER_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/** `fs` error codes meaning that no file exists at the path any more. */
const MISSING_FILE_ERROR_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Reads a worker result's persisted output file into memory. `sizeBytes` is the size recorded when the
 * output was persisted. A file that disappeared since then fails with `WorkerOutputMissingError`: a missing
 * output is never answered with an empty buffer.
 */
export function readPersistedOutput(filePath: string, sizeBytes: number): Buffer {
  if (sizeBytes > MAX_SINGLE_BUFFER_BYTES) {
    throw new RangeError(
      `Cannot read file (${sizeBytes} bytes) into single Node.js Buffer because it exceeds 2GB V8 buffer limit. Use filePath streaming instead.`
    );
  }
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && MISSING_FILE_ERROR_CODES.has(code)) {
      throw new WorkerOutputMissingError(path.basename(filePath));
    }
    throw err;
  }
}
