import fs from 'node:fs';
import type { WorkerConversionResult } from '../../worker/engines';
import { InvalidConversionOutputError, NoConvertibleContentError } from '../types';

/** Targets whose bytes are text a reader opens as such. */
const TEXT_TARGETS: ReadonlySet<string> = new Set(['txt', 'md', 'csv', 'tsv', 'html']);
/** Text targets that are empty when the input held nothing to write; HTML always carries a page skeleton. */
const CONTENT_TARGETS: ReadonlySet<string> = new Set(['txt', 'md', 'csv', 'tsv']);

/** Leading bytes of the binary containers an engine can hand back instead of text: ZIP, OLE compound file, 7z, PDF, gzip. */
const BINARY_CONTAINER_SIGNATURES: readonly Buffer[] = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  Buffer.from('%PDF-', 'latin1'),
  Buffer.from([0x1f, 0x8b]),
];
const UTF8_BOM_LENGTH = 3;
/** Leading bytes read to judge an output; a longer output than this is never judged empty. */
const SAMPLE_BYTES = 64 * 1024;

function isBlank(buffer: Buffer): boolean {
  const start = buffer.length >= UTF8_BOM_LENGTH && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? UTF8_BOM_LENGTH : 0;
  return buffer.toString('utf-8', start).trim() === '';
}

/** The leading bytes of a result, read from its file when the engine left it on disk. */
function sampleOf(result: Pick<WorkerConversionResult, 'filePath' | 'buffer' | 'size'>): Buffer {
  if (!result.filePath) return result.buffer.subarray(0, SAMPLE_BYTES);
  const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, result.size));
  const handle = fs.openSync(result.filePath, 'r');
  try {
    fs.readSync(handle, sample, 0, sample.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  return sample;
}

/**
 * The last check on a conversion before it is returned: a text target is never empty and never binary container bytes.
 * A job whose input holds nothing to write fails with a typed 422; one whose engine returned container bytes for a text
 * target fails with a typed 500. Targets that carry their own structure are checked by their writers.
 */
export function assertUsableOutput(result: Pick<WorkerConversionResult, 'filePath' | 'buffer' | 'size'>, source: string, target: string): void {
  if (!TEXT_TARGETS.has(target) || source === target) return;
  const sample = sampleOf(result);
  const length = result.filePath ? result.size : result.buffer.length;
  if (CONTENT_TARGETS.has(target) && length <= SAMPLE_BYTES && isBlank(sample)) throw new NoConvertibleContentError(source, target);
  if (BINARY_CONTAINER_SIGNATURES.some((signature) => sample.subarray(0, signature.length).equals(signature))) {
    throw new InvalidConversionOutputError(source, target);
  }
}
