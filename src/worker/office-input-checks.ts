import fs from 'node:fs';
import { assertOpenDocumentGraphic, assertXlsNotEncrypted } from '../lib/conversions/office';
import { OOXML_VARIANT_FAMILY, ooxmlVariantAsPlainPackage } from '../lib/conversions/ooxml-variants';
import { getMaxInMemoryBytes } from '../lib/storage/errors';
import type { WorkerVfsPayload } from './worker-types';

/**
 * What the worker proves about an office input before LibreOffice starts, and the form it is handed over in: a macro-enabled
 * package without its macros, a drawing that is an OpenDocument drawing package, a legacy workbook that is not encrypted.
 */

/** Sources only LibreOffice renders: an unreadable file is the client's, so it answers a typed 400 instead of an untyped failure. */
const DRAWING_SOURCES: ReadonlySet<string> = new Set(['odg', 'odd']);
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
/** The input as a buffer when it is held in memory or small enough to be read (files too big for memory go straight to LibreOffice). */
function inputAsBuffer(input: Buffer | WorkerVfsPayload): Buffer | undefined {
  if (Buffer.isBuffer(input)) return input;
  if (input.inputBuffer) return input.inputBuffer;
  if (input.inputPath && fs.existsSync(input.inputPath) && fs.statSync(input.inputPath).size <= getMaxInMemoryBytes()) {
    return fs.readFileSync(input.inputPath);
  }
  return undefined;
}

/** Proves, before LibreOffice starts, that a drawing is an OpenDocument drawing package. */
export async function assertDrawingPackage(input: Buffer | WorkerVfsPayload, src: string): Promise<void> {
  if (!DRAWING_SOURCES.has(src)) return;
  const buffer = inputAsBuffer(input);
  if (buffer) await assertOpenDocumentGraphic(buffer, src);
}

/** Sources that are Excel 97-2003 workbooks (BIFF8): the workbook and its template. */
const BIFF_WORKBOOK_SOURCES: ReadonlySet<string> = new Set(['xls', 'xlt']);
/**
 * Answers an encrypted legacy workbook with the same typed error (HTTP 422) on every route. The in-process reader
 * raises it for the text targets; LibreOffice would only report that the source could not be loaded, which is
 * indistinguishable from a damaged file, so the FilePass record is looked for before it starts.
 */
export function assertWorkbookNotEncrypted(input: Buffer | WorkerVfsPayload, src: string): void {
  if (!BIFF_WORKBOOK_SOURCES.has(src)) return;
  const buffer = inputAsBuffer(input);
  if (buffer) assertXlsNotEncrypted(buffer);
}
