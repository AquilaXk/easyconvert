import type JSZip from 'jszip';
import { CorruptStreamError, DecompressionLimitError } from '../types';
import { InflateBudget, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';

/**
 * Reads one entry of a ZIP package while it inflates, counting the decoded bytes and aborting past the cap. Every
 * reader of an attacker-supplied ZIP-based package (OOXML, ODF, HWPX, EPUB) goes through here instead of calling
 * `JSZip.file(...).async(...)`, which decodes the whole entry first and trusts the declared size of the central
 * directory. The caps never rely on a declared size: a lying header is refused as soon as the stream passes it.
 */

/** Most bytes one package entry may decode to (64 MiB). */
export const MAX_ZIP_ENTRY_BYTES = MAX_STREAM_INFLATE_BYTES;

export interface ZipEntryReadOptions {
  /** What is being read, for error messages. Defaults to the entry name. */
  label?: string;
  /** Cap in place of `MAX_ZIP_ENTRY_BYTES`, for entries whose format allows more or far less. */
  maxBytes?: number;
  /** Package budget the decoded bytes are charged to, for readers that open many entries of one package. */
  budget?: InflateBudget;
}

function declaredSize(entry: JSZip.JSZipObject): number | undefined {
  const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : undefined;
}

/** The decoded bytes of `entry`; more than the cap is a DecompressionLimitError (413), a broken or lying entry a CorruptStreamError (400). */
export function readZipEntryBytes(entry: JSZip.JSZipObject, options: ZipEntryReadOptions = {}): Promise<Buffer> {
  const label = options.label ?? `ZIP entry '${entry.name}'`;
  const budgetRemaining = options.budget ? options.budget.remaining : Number.POSITIVE_INFINITY;
  const entryCap = options.maxBytes ?? MAX_ZIP_ENTRY_BYTES;
  const cap = Math.min(entryCap, budgetRemaining);
  const declared = declaredSize(entry);
  const overLimit = (): DecompressionLimitError =>
    new DecompressionLimitError(
      budgetRemaining < entryCap
        ? `${label} would exceed the decoded-byte budget of ${options.budget?.limit} bytes for the whole package.`
        : `${label} decodes to more than the limit of ${entryCap} bytes.`
    );
  if (declared !== undefined && declared > cap) {
    return Promise.reject(overLimit());
  }
  return new Promise<Buffer>((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer');
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      stream.pause();
      (stream as unknown as { destroy?: () => void }).destroy?.();
      reject(error);
    };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        fail(overLimit());
      } else if (declared !== undefined && total > declared) {
        fail(new CorruptStreamError(`${label} decodes to more than the ${declared} bytes it declares.`));
      } else {
        chunks.push(chunk);
      }
    });
    stream.on('error', (error: Error) => {
      fail(new CorruptStreamError(`${label} is not a valid compressed entry: ${error instanceof Error ? error.message : String(error)}`));
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      const bytes = Buffer.concat(chunks);
      if (declared !== undefined && bytes.length !== declared) {
        reject(new CorruptStreamError(`${label} decodes to ${bytes.length} bytes but declares ${declared}.`));
        return;
      }
      try {
        options.budget?.charge(bytes.length, label);
      } catch (error) {
        reject(error);
        return;
      }
      resolve(bytes);
    });
  });
}

/** The UTF-8 text of `entry`, read under the same caps as {@link readZipEntryBytes}. */
export async function readZipEntryText(entry: JSZip.JSZipObject, options: ZipEntryReadOptions = {}): Promise<string> {
  return (await readZipEntryBytes(entry, options)).toString('utf-8');
}
