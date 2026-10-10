import fs from 'node:fs';
import JSZip from 'jszip';
import type { WorkerConversionResult } from '../../worker/engines';
import { InvalidConversionOutputError } from '../types';

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
/** Declared type of a conversion that delivers several files in one archive (a workbook written one text file per sheet). */
const ARCHIVE_MIME_TYPE = 'application/zip';

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

function isContainer(sample: Buffer): boolean {
  return BINARY_CONTAINER_SIGNATURES.some((signature) => sample.subarray(0, signature.length).equals(signature));
}

/** Whether a declared archive of text files is a readable ZIP whose members are all text, not containers. */
async function isTextArchive(result: Pick<WorkerConversionResult, 'filePath' | 'buffer'>): Promise<boolean> {
  const zip = await JSZip.loadAsync(result.buffer).catch(() => null);
  if (zip === null) return false;
  for (const member of Object.values(zip.files)) {
    if (member.dir) continue;
    if (isContainer((await member.async('nodebuffer')).subarray(0, SAMPLE_BYTES))) return false;
  }
  return true;
}

/**
 * The last check on a conversion before it is returned. A text target is never binary container bytes: a result that
 * holds them fails with a typed 500, except the declared ZIP of a split conversion whose members are all text. A text
 * target with nothing in it (a blank document, an empty sheet) is a valid empty file, returned with an `emptyOutput`
 * warning in its metadata. Targets that carry their own structure are checked by their writers.
 */
export async function checkConversionOutput<T extends Pick<WorkerConversionResult, 'filePath' | 'buffer' | 'size' | 'metadata'> & { mimeType?: string }>(
  result: T,
  source: string,
  target: string
): Promise<T> {
  if (!TEXT_TARGETS.has(target) || source === target) return result;
  if (result.mimeType === ARCHIVE_MIME_TYPE) {
    if (await isTextArchive(result)) return result;
    throw new InvalidConversionOutputError(source, target);
  }
  const sample = sampleOf(result);
  const length = result.filePath ? result.size : result.buffer.length;
  if (isContainer(sample)) throw new InvalidConversionOutputError(source, target);
  if (CONTENT_TARGETS.has(target) && length <= SAMPLE_BYTES && isBlank(sample)) {
    return { ...result, metadata: { ...result.metadata, emptyOutput: true } };
  }
  return result;
}
