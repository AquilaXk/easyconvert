import fs from 'node:fs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { assertBmpHeaderWithinLimit, isBmp, isDib } from '../lib/conversions/bmp';
import { InflateBudget } from '../lib/conversions/bounded-inflate';
import { assertEmbeddableImageWithinLimit, assertInputPixels, isPngOrJpeg, rethrowInputPixelLimit } from '../lib/conversions/image-input-limits';
import { assertOpenDocumentGraphic, xlsHasFilePass } from '../lib/conversions/office';
import { isEncryptedWordDocument } from '../lib/conversions/office/doc-reader';
import { maxDocumentMediaBytes } from '../lib/conversions/office/media-limits';
import { CFBF_MAX_FILE_BYTES } from '../lib/compound-file-kind';
import { officeReadingFormat } from '../lib/conversions/office/office-suite-sources';
import { OOXML_VARIANT_FAMILY, ooxmlVariantAsPlainPackage } from '../lib/conversions/ooxml-variants';
import { ZIP_LOCAL_HEADER_SIGNATURE, startsWithBytes } from '../lib/conversions/package-access';
import { MAX_ZIP_MEDIA_BYTES, readZipEntryBytes } from '../lib/conversions/zip-entry-reader';
import { getMaxInMemoryBytes } from '../lib/storage/errors';
import type { WorkerVfsPayload } from './worker-types';

/**
 * What the worker proves about an office input before LibreOffice starts, and the form it is handed over in: a macro-enabled
 * package without its macros, a drawing that is an OpenDocument drawing package; and, once LibreOffice could not load a legacy
 * binary workbook or document, whether the file is encrypted.
 */

const DRAWING_SOURCES: ReadonlySet<string> = new Set(['odg', 'odd']);
const OFFICE_MEDIA_PREFIXES = ['word/media/', 'ppt/media/', 'xl/media/', 'pictures/', 'data/', 'thumbnails/', 'media/'];
const OFFICE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp', '.dib'];

function isOfficeMediaEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    OFFICE_MEDIA_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    OFFICE_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
}
/**
 * The package a macro-enabled variant is handed to LibreOffice as: the plain package without its macro project, so no
 * macro is ever in reach of the office suite. Inputs that are not in memory and other formats are handed over as they are.
 */
export async function officeInputWithoutMacros(input: Buffer | WorkerVfsPayload, src: string): Promise<Buffer | WorkerVfsPayload> {
  const family = OOXML_VARIANT_FAMILY[src];
  const buffer = family === undefined ? undefined : inputAsBuffer(input);
  if (family === undefined || buffer === undefined) return input;
  const plain = await ooxmlVariantAsPlainPackage(buffer, src, family);
  return plain.droppedMacros ? plain.buffer : input;
}
/**
 * The input as a buffer when it is held in memory, or is a file of at most `maxBytes` that exists; undefined for a larger or missing file,
 * which goes on to the office suite as it is.
 */
export function boundedInput(input: Buffer | WorkerVfsPayload, maxBytes: number): Buffer | undefined {
  if (Buffer.isBuffer(input)) return input;
  if (input.inputBuffer) return input.inputBuffer;
  if (input.inputPath === undefined) return undefined;
  // A missing input is a fault of the job, not a large file: statSync throws it as itself.
  return fs.statSync(input.inputPath).size > maxBytes ? undefined : fs.readFileSync(input.inputPath);
}

/** The input of a legacy binary Office document, read as far as the in-process readers of those formats read (`CFBF_MAX_FILE_BYTES`). */
export function legacyOfficeInput(input: Buffer | WorkerVfsPayload): Buffer | undefined {
  return boundedInput(input, CFBF_MAX_FILE_BYTES);
}

/** Whether the input is a file that is not there; the checks run after or before the office suite, which answers for a missing input. */
function isMissingFile(input: Buffer | WorkerVfsPayload): boolean {
  return !Buffer.isBuffer(input) && !input.inputBuffer && input.inputPath !== undefined && !fs.existsSync(input.inputPath);
}

/** The input of a package that is read whole before the office suite sees it: as large as a job holds in memory. */
function inputAsBuffer(input: Buffer | WorkerVfsPayload): Buffer | undefined {
  return isMissingFile(input) ? undefined : boundedInput(input, getMaxInMemoryBytes());
}

/** Proves, before LibreOffice starts, that a drawing is an OpenDocument drawing package. */
export async function assertDrawingPackage(input: Buffer | WorkerVfsPayload, src: string): Promise<void> {
  if (!DRAWING_SOURCES.has(src)) return;
  const buffer = inputAsBuffer(input);
  if (buffer) await assertOpenDocumentGraphic(buffer, src);
}

export async function assertOfficeEmbeddedImagesWithinLimit(input: Buffer | WorkerVfsPayload): Promise<void> {
  const buffer = inputAsBuffer(input);
  if (!buffer || !startsWithBytes(buffer, ZIP_LOCAL_HEADER_SIGNATURE)) return;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return;
  }
  const budget = new InflateBudget(maxDocumentMediaBytes());
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !isOfficeMediaEntry(name)) continue;
    const bytes = await readZipEntryBytes(entry, { maxBytes: MAX_ZIP_MEDIA_BYTES, budget });
    const lowerName = name.toLowerCase();
    if (isBmp(bytes) || ((lowerName.endsWith('.dib') || lowerName.endsWith('.bmp')) && isDib(bytes))) {
      assertBmpHeaderWithinLimit(bytes);
      continue;
    }
    await assertEmbeddableImageWithinLimit(bytes);
    if (!isPngOrJpeg(bytes)) {
      try {
        const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
        if (meta.width !== undefined && meta.height !== undefined) {
          assertInputPixels(meta.width, meta.height);
        }
      } catch (err) {
        rethrowInputPixelLimit(err);
      }
    }
  }
}

/**
 * Whether a legacy workbook (a FilePass record) or Word document (the encrypted flag of its file information block) is encrypted. LibreOffice
 * decrypts the workbooks that use the default password of the format and cannot load the others, and it reports those like a
 * damaged file, so this is asked after it failed. A file that is not held in memory, or is another format, is not judged.
 */
export function isEncryptedLegacyOffice(input: Buffer | WorkerVfsPayload, src: string): boolean {
  const reading = officeReadingFormat(src);
  if (reading !== 'xls' && reading !== 'doc') return false;
  // Asked after the suite failed: a file that is gone is not called encrypted, and the suite's own error stands.
  if (isMissingFile(input)) return false;
  const buffer = legacyOfficeInput(input);
  if (buffer === undefined) return false;
  return reading === 'xls' ? xlsHasFilePass(buffer) : isEncryptedWordDocument(buffer);
}
