import type JSZip from 'jszip';
import { CorruptStreamError, DecompressionLimitError } from '../types';
import { InflateBudget, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';

/**
 * Reads one entry of a ZIP package while it inflates, counting the decoded bytes and aborting past the cap. Every
 * reader of an attacker-supplied ZIP-based package (OOXML, ODF, HWPX, EPUB) goes through here instead of calling
 * `JSZip.file(...).async(...)`, which decodes the whole entry first and trusts the declared size of the central
 * directory. The caps never rely on a declared size: a lying header is refused as soon as the stream passes it.
 */

/**
 * Most bytes one package entry that is parsed (XML, text, relationships) may decode to (128 MiB, the cap of a DOCX XML
 * part). A reader that parses a part holds it as a string or a tree, so the cap sits far above any real document
 * part. A worksheet may be larger: a sheet of a million rows is hundreds of MB, so sheets are held to the 256 MiB
 * budget of the workbook instead.
 */
export const MAX_ZIP_ENTRY_BYTES = 2 * MAX_STREAM_INFLATE_BYTES;

/**
 * Most bytes one embedded media part (a picture or a video in a deck or document) may decode to: the 1 GiB of the
 * largest upload, and a ceiling for the per-document media budget. Media is copied or handed to an image decoder
 * rather than parsed, and a presentation with a 100 MiB video or photograph is ordinary, so the parsed-part cap
 * (`MAX_ZIP_ENTRY_BYTES`) does not apply to it. No ratio to the compressed size is applied either, because
 * uncompressed TIFF and BMP pictures deflate far past 100:1; a reader bounds the media of a whole document with a
 * budget instead, counting each part once.
 */
export const MAX_ZIP_MEDIA_BYTES = 1024 * 1024 * 1024;

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
    // With a declared size the bytes go straight into one buffer, so a large part is not held twice while it is joined.
    let target: Buffer | undefined;
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      target = undefined;
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
      } else if (declared !== undefined) {
        target ??= Buffer.allocUnsafe(declared);
        chunk.copy(target, total - chunk.length);
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
      const bytes = target ? target.subarray(0, total) : Buffer.concat(chunks);
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
