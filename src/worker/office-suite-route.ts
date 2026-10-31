import fs from 'node:fs';
import { CompoundFileStructureError, ConversionFailedError, CorruptStreamError, EncryptedOfficeDocumentError, EngineUnavailableError, SheetLimitError } from '../lib/types';
import { LegacyOfficeFormatError } from '../lib/conversions/office/legacy-office-errors';
import { CFBF_MAX_FILE_BYTES } from '../lib/compound-file-kind';
import { assertWorkbookFitsXls } from '../lib/conversions/office/xls-limits';
import { writeTransientWorkbook } from '../lib/conversions/data';
import { readRawInputBuffer } from './worker-output';
import { repairPptPersistIdSeed } from '../lib/conversions/office/ppt-reader';
import { isEncryptedLegacyOffice, legacyOfficeInput } from './office-input-checks';
import {
  CGM_ENCODING_PROBE_BYTES,
  OFFICE_SUITE_SOURCE_FORMATS,
  isOfficeSuiteOnlySource,
  legacyReaderRetryInterchange,
  officeSuiteApplication,
  officeSuiteInterchange,
  officeSuiteReadsBytes,
  officeReadingFormat,
  officeSuiteWritesText,
} from '../lib/conversions/office/office-suite-sources';
import { OOXML_VARIANT_FAMILY } from '../lib/conversions/ooxml-variants';
import { metafileFrameDocument } from '../lib/conversions/office/metafile-frame-document';
import { isEmptyMetafile, metafileLeadingBytes, readMetafilePage, type MetafileFormat } from '../lib/conversions/office/metafile-page-frame';
import { startsWithBytes } from '../lib/conversions/package-access';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../lib/conversions/page-range';
import { pdfFirstPageHasInk } from './pdf-ink';
import { selectsPages } from './poppler-ppm';
import { SandboxedProcessError, rethrowSandboxUnavailable } from './sandbox';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/**
 * Which conversions the office suite (LibreOffice) performs for the worker: the sources it reads, the targets it writes
 * itself, the targets it reaches through an interchange file that the in-process converter of that format finishes, and the
 * typed answers for the documents it cannot read.
 */

export const OFFICE_FORMATS: ReadonlySet<string> = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf']);

/**
 * Sources LibreOffice reads and renders: the Office formats plus PowerPoint templates, Keynote presentations and
 * OpenDocument drawings, none of which the in-process engine can render, and the formats only the office suite imports.
 * Targets are still limited to OFFICE_FORMATS (and PDF), because LibreOffice cannot write the other formats.
 */
export const OFFICE_NATIVE_SOURCES: ReadonlySet<string> = new Set([
  ...OFFICE_FORMATS,
  'potx',
  'key',
  'odg',
  'odd',
  // Macro-enabled, template and slideshow variants: LibreOffice opens them like their plain formats, without running macros.
  ...Object.keys(OOXML_VARIANT_FAMILY),
  // Binary and OpenDocument templates and slide shows, and the formats only the office suite imports (Works, WordPerfect, OpenOffice.org 1.x, Numbers, Publisher, e-books).
  ...OFFICE_SUITE_SOURCE_FORMATS,
]);

/** Whether LibreOffice has no export filter for the pair, since a document is only converted into its own application's formats (and PDF): a text document cannot be saved as a presentation, nor a workbook as a text document. */
function crossesLibreOfficeApplications(src: string, tgt: string): boolean {
  const from = officeSuiteApplication(src);
  const to = officeSuiteApplication(tgt);
  return from !== undefined && to !== undefined && from !== to;
}

/** Whether the office suite writes the target in the one pass that opens the source: PDF, the Office formats of the source's own application, and plain text for its word processors. */
export function officeSuiteWritesTarget(src: string, tgt: string): boolean {
  const writes = tgt === 'pdf' || OFFICE_FORMATS.has(tgt) || officeSuiteWritesText(src, tgt);
  return OFFICE_NATIVE_SOURCES.has(src) && writes && !crossesLibreOfficeApplications(src, tgt);
}

/**
 * The interchange format the office suite has to write first for a target it does not write itself, or undefined when the
 * suite writes the target, when it is made from the source file or from a PDF of it (`madeWithoutInterchange`: the page chain
 * renders images from a PDF, an archive packs the file as it is) or when the source has no interchange format.
 */
export function interchangeNeeded(src: string, tgt: string, madeWithoutInterchange: boolean): string | undefined {
  if (officeSuiteWritesTarget(src, tgt) || madeWithoutInterchange) return undefined;
  return officeSuiteInterchange(src, tgt);
}

/** First page of the printed document, in the PDF export's page range syntax. */
const FIRST_PAGE_RANGE = '1';

/**
 * Limit of each stage of the page chain (the suite's PDF, the page count, the drawing of the pages) when the request names none. The stages
 * default to 45 s, which is the 99.9th percentile of the corpus runs and is right for a document of a few pages; but the layout of a
 * long document alone takes 31 s on an idle 4-core machine for the 4,874 pages of `govdocs1-010383.rtf`, 41 s next to 4 busy loops and
 * more than 45 s next to 8, so the stage ended with a time-limit error (422) before the page count was known and the request could not
 * be refused with the 413 that names it. 120 s is the ceiling the stages already have; the job deadline still holds each stage to the
 * time the job has left, which is what ends a runaway.
 */
export const OFFICE_PAGE_CHAIN_STAGE_TIMEOUT_MS = 120_000;

/**
 * The options of a document that becomes page images (the office suite writes the PDF, Poppler draws the pages): a request
 * renders at most `OFFICE_PAGE_IMAGE_MAX_PAGES` pages whatever application opens the source, and each stage may run for
 * `OFFICE_PAGE_CHAIN_STAGE_TIMEOUT_MS` unless the server set another limit. A spreadsheet that asks for the first
 * page (`multiPageOutput: "first"`, no page selection) also has the suite print that page only, which skips the layout and the
 * PDF of every other page; a text document or a presentation is laid out whole before any page is written, so that cut gains
 * nothing there. The limits are set here, over whatever the request carried.
 */
export function withOfficePageBounds(src: string, options: WorkerEngineOptions): WorkerEngineOptions {
  const bounded = { ...options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES, timeoutMs: options.timeoutMs ?? OFFICE_PAGE_CHAIN_STAGE_TIMEOUT_MS };
  if (officeSuiteApplication(src) !== 'calc') return bounded;
  const firstPageOnly = options.multiPageOutput === 'first' && !selectsPages(options);
  return { ...bounded, pdfExportPageRange: firstPageOnly ? FIRST_PAGE_RANGE : undefined };
}

/** LibreOffice's stderr when it wrote nothing for a file. */
const LIBREOFFICE_NO_OUTPUT_PATTERN = /^LibreOffice execution completed without producing expected output file/;
/** LibreOffice's stderr when it cannot load the file, or loads it as another kind of document (a text file named .ppt) that has no export filter for the target. */
const LIBREOFFICE_LOAD_FAILURE_PATTERN = /source file could not be loaded|no export filter for/;
const LIBREOFFICE_NOT_LOADED_PATTERN = /source file could not be loaded/;
/**
 * LibreOffice's stderr when the office suite itself stops on the document: an import filter that gives up ("Unspecified
 * Application Error") or a crash of its layout (a fatal signal). Another run on the same document stops the same way.
 */
const LIBREOFFICE_STOPPED_PATTERN = /Unspecified Application Error|Fatal exception: Signal/;

/** LibreOffice ran and wrote nothing, could not load the file, or stopped on it: the file is damaged or not that kind of document (typed 400). */
export function asUnreadableDocument(err: unknown, src: string): unknown {
  if (!OFFICE_NATIVE_SOURCES.has(src)) return err;
  if (err instanceof Error && !(err instanceof ConversionFailedError) && LIBREOFFICE_NO_OUTPUT_PATTERN.test(err.message)) {
    return new ConversionFailedError(`LibreOffice could not read the .${src} file: it is damaged or not a valid ${src.toUpperCase()} document.`);
  }
  if (err instanceof SandboxedProcessError && LIBREOFFICE_LOAD_FAILURE_PATTERN.test(err.message)) {
    return new ConversionFailedError(`LibreOffice could not read the .${src} file: it is damaged, encrypted or not a valid ${src.toUpperCase()} document.`);
  }
  if (err instanceof SandboxedProcessError && LIBREOFFICE_STOPPED_PATTERN.test(err.message)) {
    return new ConversionFailedError(
      `LibreOffice stopped while reading the .${src} file: the office suite fails on the content of this document, so it cannot be converted.`
    );
  }
  return err;
}

/**
 * What follows the office suite's failure to load a PowerPoint 97-2003 presentation. An encrypted presentation is intact, so the
 * typed 422 for an encrypted document is thrown in place of the suite's "damaged" answer. A presentation whose persistIdSeed lies
 * below its persist directory (see `repairPptPersistIdSeed`) is returned with the seed corrected, to run the suite on again.
 * Undefined when the failure is another one, the presentation is neither, or the input cannot be read for either check, so that
 * the suite's own error stands.
 */
export function presentationRetryInput(input: Buffer | WorkerVfsPayload, src: string, err: unknown): Buffer | WorkerVfsPayload | undefined {
  if (officeReadingFormat(src) !== 'ppt' || asUnreadableDocument(err, src) === err) return undefined;
  let repaired: Buffer | undefined;
  try {
    const bytes = legacyOfficeInput(input);
    repaired = bytes && repairPptPersistIdSeed(bytes);
  } catch (prepareError) {
    if (prepareError instanceof EncryptedOfficeDocumentError) throw prepareError;
    return undefined;
  }
  if (repaired === undefined) return undefined;
  return Buffer.isBuffer(input) ? repaired : { outputPath: input.outputPath, inputBuffer: repaired };
}

export type OfficeSuiteRun = (input: Buffer | WorkerVfsPayload, sourceFormat: string, targetFormat: string, options?: WorkerEngineOptions, originalFilename?: string) => Promise<WorkerConversionResult | null>;

/**
 * `run`, with what follows the office suite's failure to load a legacy binary document. A presentation whose persist id seed is wrong
 * runs once more on the input `presentationRetryInput` returns. A workbook or Word document that the suite could not load, or could
 * not load on that second run, gets the typed 422 for an encrypted document in place of the "damaged" answer when it is encrypted.
 * The suite decrypts a workbook that uses the default password of the format and loads it like any other (`xlroot.cxx`
 * `RequestEncryptionData` tries it first), so the file goes to the suite whatever its FilePass record says. A file that is encrypted
 * and could not be loaded is intact and needs a password: the answer is the one the in-process readers give.
 */
export function withLegacyOfficeRecovery(run: OfficeSuiteRun): OfficeSuiteRun {
  return async (input, sourceFormat, targetFormat, options, originalFilename) => {
    const answerFor = (err: unknown): unknown =>
      officeSuiteCouldNotLoad(err) && OFFICE_NATIVE_SOURCES.has(sourceFormat) && encryptedInput(input, sourceFormat)
        ? new SuiteEncryptedDocumentError(`The ${sourceFormat.toUpperCase()} file is encrypted or password protected, so its content cannot be read.`)
        : err;
    try {
      return await run(input, sourceFormat, targetFormat, options, originalFilename);
    } catch (err) {
      const retry = presentationRetryInput(input, sourceFormat, err);
      if (retry === undefined) throw answerFor(err);
      try {
        return await run(retry, sourceFormat, targetFormat, options, originalFilename);
      } catch (retryErr) {
        throw answerFor(retryErr);
      }
    }
  };
}

/**
 * The office suite's answer that it could not load an encrypted document: it has already tried the default password, so the
 * reader's refusal of the same file is not retried on the suite (`isEncryptedWorkbookRefusal`).
 */
class SuiteEncryptedDocumentError extends EncryptedOfficeDocumentError {}

/** The suite wrote nothing or could not load the file. A stop or a crash of the suite on the document is its own answer, never "encrypted". */
function officeSuiteCouldNotLoad(err: unknown): boolean {
  if (err instanceof Error && !(err instanceof ConversionFailedError) && LIBREOFFICE_NO_OUTPUT_PATTERN.test(err.message)) return true;
  return err instanceof SandboxedProcessError && LIBREOFFICE_NOT_LOADED_PATTERN.test(err.message);
}

/** Whether the input is an encrypted legacy document; a file that cannot be read for the check is not called encrypted. */
function encryptedInput(input: Buffer | WorkerVfsPayload, sourceFormat: string): boolean {
  try {
    return isEncryptedLegacyOffice(input, sourceFormat);
  } catch {
    return false;
  }
}

/** The metafile sources whose page the frame of the header decides, and the drawing format the office suite opens for them. */
const METAFILE_FRAME_SOURCES: ReadonlySet<string> = new Set<MetafileFormat>(['emf', 'wmf']);
const FRAME_DRAWING_FORMAT = 'odg';

/**
 * `run`, with a metafile written as PDF drawn on a page of the size of its header's frame. The office suite opens a metafile
 * on an A4 page, centred, at the size it prefers or reduced to fit, while the reference import filter makes the page the
 * frame (`metafile-page-frame.ts`). The picture is therefore handed over as a drawing of that page that holds it as it is
 * (`metafile-frame-document.ts`). A file that is no metafile, or whose header declares no frame inside the bounds, goes to
 * the office suite as it is, which then answers for it as before.
 */
export function withMetafileFrame(run: OfficeSuiteRun): OfficeSuiteRun {
  return async (input, sourceFormat, targetFormat, options, originalFilename) => {
    if (targetFormat !== 'pdf' || !METAFILE_FRAME_SOURCES.has(sourceFormat)) return run(input, sourceFormat, targetFormat, options, originalFilename);
    const format = sourceFormat as MetafileFormat;
    const page = readMetafilePage(leadingBytes(input, metafileLeadingBytes(format)), format);
    const bytes = page && legacyOfficeInput(input);
    if (!bytes || !page) return run(input, sourceFormat, targetFormat, options, originalFilename);
    options?.signal?.throwIfAborted();
    const drawing = await metafileFrameDocument(bytes, format, page);
    options?.signal?.throwIfAborted();
    const staged: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? drawing : { inputBuffer: drawing, outputPath: input.outputPath };
    return run(staged, FRAME_DRAWING_FORMAT, targetFormat, options, originalFilename);
  };
}

/** Whether the first page of a PDF that a run wrote, drawn by the `pdftoppm` given, has anything on it but paper. */
type PdfInkProbe = (pdf: WorkerConversionResult, pdftoppm: string, options: WorkerEngineOptions) => Promise<boolean>;

/** The size of an input in bytes, whether it is held in memory or in a file. */
function inputSize(input: Buffer | WorkerVfsPayload): number {
  if (Buffer.isBuffer(input)) return input.length;
  if (input.inputBuffer) return input.inputBuffer.length;
  return input.inputPath === undefined ? 0 : fs.statSync(input.inputPath).size;
}

/**
 * `run`, with a metafile written as PDF refused when the page it drew holds no ink. The office suite loads an EMF or WMF whose
 * header is valid and whose records are not records (or draw nothing) without a failure and writes a blank page, which the
 * reference import filter does not do: Inkscape 1.4 stops at the first record that is not a record (`emf-inout.cpp`
 * `myEnhMetaFileProc` lines 1680 to 1693 set `file_status` to 0, `Emf::open` lines 3588 to 3597 then opens no document; the same
 * in `wmf-inout.cpp` lines 1703 to 1718 and 3167 to 3174) and writes no PDF. A file that is a header and its end record is not
 * junk: the reference opens it and writes an empty page, so it is handed on without a look (`isEmptyMetafile`). The page is looked
 * at where the PDF is made, so the page chain behind PNG, JPEG and the other targets is held to it as well. A metafile is one page;
 * a PDF with several pages is never judged by its first. `discardOutput` removes a PDF that is not handed on, and a worker without
 * `pdftoppm` (what `resolvePdftoppm` finds) answers an unavailable engine rather than hand out a PDF it could not look at.
 */
export function withMetafileInk(
  run: OfficeSuiteRun,
  resolvePdftoppm: () => string | null,
  discardOutput: OfficeSuiteRouteDeps['discardOutput'],
  hasInk: PdfInkProbe = pdfFirstPageHasInk
): OfficeSuiteRun {
  return async (input, sourceFormat, targetFormat, options, originalFilename) => {
    const written = await run(input, sourceFormat, targetFormat, options, originalFilename);
    if (!written || targetFormat !== 'pdf' || !METAFILE_FRAME_SOURCES.has(sourceFormat)) return written;
    const format = sourceFormat as MetafileFormat;
    let drawn = false;
    try {
      if (isEmptyMetafile(leadingBytes(input, metafileLeadingBytes(format)), inputSize(input), format)) return written;
      const pdftoppm = resolvePdftoppm();
      if (!pdftoppm) throw new EngineUnavailableError('pdftoppm', 'pdftoppm binary is not installed or not in PATH');
      drawn = await hasInk(written, pdftoppm, options ?? {});
    } catch (err) {
      discardOutput(written.filePath, input, options ?? {});
      throw err;
    }
    if (drawn) return written;
    discardOutput(written.filePath, input, options ?? {});
    throw new ConversionFailedError(`The .${sourceFormat} file draws nothing: the office suite found no picture in it, so the PDF would be a blank page.`);
  };
}

/** The worker functions the routes below run on, passed in so this module does not import the orchestrator that uses it. */
export interface OfficeSuiteRouteDeps {
  /** One LibreOffice run: the source written as `target` (null when no output came). */
  writeWithOfficeSuite(input: Buffer | WorkerVfsPayload, src: string, target: string, options: WorkerEngineOptions, originalFilename: string): Promise<WorkerConversionResult | null>;
  /** The whole conversion of a file in memory, as the orchestrator runs it. */
  convert(input: Buffer | WorkerVfsPayload, src: string, target: string, options: WorkerEngineOptions, originalFilename: string): Promise<WorkerConversionResult>;
  /** Deletes an engine's temporary output unless it is the destination the request named. */
  discardOutput(filePath: string | undefined, input: Buffer | WorkerVfsPayload, options: WorkerEngineOptions): void;
}

/** A conversion request as the worker received it. */
export interface OfficeSuiteRequest {
  input: Buffer | WorkerVfsPayload;
  src: string;
  tgt: string;
  options: WorkerEngineOptions;
  originalFilename: string;
}

/**
 * A format only the office suite reads, converted to a target it does not write: LibreOffice writes the interchange file
 * (never to the requested output path), then the converter of that format writes the target, so the result is what the same
 * conversion of a native file of the interchange format gives. A missing office suite is an unavailable engine: there is
 * no in-process reader to fall back to.
 */
export async function convertThroughInterchange(deps: OfficeSuiteRouteDeps, request: OfficeSuiteRequest, interchange: string): Promise<WorkerConversionResult> {
  const { input, src, tgt, options, originalFilename } = request;
  const requestedOutput = Buffer.isBuffer(input) ? undefined : input.outputPath;
  const writesTarget = interchange === tgt;
  const source: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) || writesTarget ? input : { ...input, outputPath: undefined };
  const writerOptions = { ...(writesTarget ? options : { ...options, libreOfficeFilter: undefined, outputPath: undefined }), throwOnUnavailable: true } as WorkerEngineOptions;
  let written: WorkerConversionResult | null;
  try {
    written = await deps.writeWithOfficeSuite(source, src, interchange, writerOptions, originalFilename);
  } catch (err) {
    rethrowSandboxUnavailable(err);
    throw asUnreadableDocument(err, src);
  }
  if (!written) throw new EngineUnavailableError('soffice', `LibreOffice produced no .${interchange} file for the .${src} source`);
  // The suite writes the target itself (the text of a document): nothing is left for the in-process converter.
  if (writesTarget) return written;
  try {
    const next: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? written.buffer : { inputBuffer: written.buffer, outputPath: requestedOutput };
    return await deps.convert(next, interchange, tgt, { ...options, inProcessFallback: undefined }, originalFilename);
  } finally {
    deps.discardOutput(written.filePath, input, options);
  }
}

/** The one BIFF8 target and the OOXML workbook format its source is checked in before the office suite exports it. */
export const BIFF8_TARGET = 'xls';
const XLSX_FORMAT = 'xlsx';

/** Whether a source is an OOXML workbook (XLSX or one of its macro-enabled and template variants), whose cells are read as they are. */
function isOoxmlWorkbook(src: string): boolean {
  return src === XLSX_FORMAT || OOXML_VARIANT_FAMILY[src] === XLSX_FORMAT;
}

/**
 * The bytes of a source workbook, for the check against the BIFF8 sheet. A file larger than the check reads is refused (413): passing
 * it on unchecked would let the export cut it.
 */
function workbookBytes(input: Buffer | WorkerVfsPayload): Buffer {
  const bytes = legacyOfficeInput(input);
  if (bytes === undefined) {
    throw new SheetLimitError(`The workbook is larger than the ${CFBF_MAX_FILE_BYTES} bytes the check against the .xls sheet bounds reads, so it is not exported.`);
  }
  return bytes;
}

/**
 * An XLSX workbook checked against the BIFF8 sheet (65,536 rows, 256 columns, `assertWorkbookFitsXls`) and exported by the office
 * suite's `MS Excel 97` filter. The workbook never goes to the output path of the request, which only this export writes.
 */
async function exportCheckedWorkbook(deps: OfficeSuiteRouteDeps, request: OfficeSuiteRequest, workbook: Buffer): Promise<WorkerConversionResult> {
  const { input, src, tgt, options, originalFilename } = request;
  await assertWorkbookFitsXls(workbook);
  const next: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? workbook : { inputBuffer: workbook, outputPath: input.outputPath };
  let written: WorkerConversionResult | null;
  try {
    written = await deps.writeWithOfficeSuite(next, XLSX_FORMAT, tgt, { ...options, throwOnUnavailable: true }, originalFilename);
  } catch (err) {
    rethrowSandboxUnavailable(err);
    throw err;
  }
  if (!written) throw new EngineUnavailableError('soffice', `LibreOffice produced no .${tgt} file for the .${src} source`);
  return written;
}

/**
 * A source the office suite reads but whose cells are not read in process (ODS, Numbers): the suite writes it as an XLSX workbook
 * first, which holds what the suite loaded, and that workbook is checked and exported.
 */
async function exportThroughSuiteWorkbook(deps: OfficeSuiteRouteDeps, request: OfficeSuiteRequest): Promise<WorkerConversionResult> {
  const { input, src, options, originalFilename } = request;
  const source: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? input : { ...input, outputPath: undefined };
  let workbook: WorkerConversionResult | null;
  try {
    // The filter names the final .xls export, not this XLSX pass, which would write BIFF8 bytes where the workbook check reads XLSX.
    workbook = await deps.writeWithOfficeSuite(source, src, XLSX_FORMAT, { ...options, libreOfficeFilter: undefined, outputPath: undefined, throwOnUnavailable: true } as WorkerEngineOptions, originalFilename);
  } catch (err) {
    rethrowSandboxUnavailable(err);
    throw asUnreadableDocument(err, src);
  }
  if (!workbook) throw new EngineUnavailableError('soffice', `LibreOffice produced no .${XLSX_FORMAT} file for the .${src} source`);
  try {
    return await exportCheckedWorkbook(deps, request, workbook.buffer);
  } finally {
    deps.discardOutput(workbook.filePath, input, options);
  }
}

/**
 * The conversion of a request that targets `.xls`. Every source reaches the office suite's export as an XLSX workbook checked against
 * the BIFF8 sheet, so that nothing is cut: a table the in-process engine reads (CSV, TSV, JSON, Parquet, Kingsoft) is written by
 * the engine's own writer, stored, an OOXML workbook is checked as it is and converted by `convertDirectly`, and any other source the suite reads goes
 * through the XLSX workbook the suite writes of it. A request for any other target is `convertDirectly` alone.
 */
export async function convertXlsTarget(
  deps: OfficeSuiteRouteDeps,
  request: OfficeSuiteRequest,
  convertDirectly: () => Promise<WorkerConversionResult>
): Promise<WorkerConversionResult> {
  const { input, src, tgt, options, originalFilename } = request;
  if (tgt !== BIFF8_TARGET) return convertDirectly();
  if (!officeSuiteReadsInputAndWrites(src, tgt, input)) {
    return exportCheckedWorkbook(deps, request, await writeTransientWorkbook(readRawInputBuffer(input), src, options));
  }
  if (!isOoxmlWorkbook(src)) return exportThroughSuiteWorkbook(deps, request);
  await assertWorkbookFitsXls(workbookBytes(input));
  return convertDirectly();
}

/** The signature every OLE2 compound file starts with (MS-CFB section 2.2): the container of Word, Excel and PowerPoint 97-2003 files. */
const OLE2_SIGNATURE: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** The start of a Word 5.0 for Macintosh file (a Word binary that is no compound file), which the office suite reads and the in-process reader refuses. */
const WORD_5_MACINTOSH_SIGNATURE: readonly number[] = [0xfe, 0x37, 0x00, 0x23];
const LEGACY_BINARY_SIGNATURES: ReadonlyArray<readonly number[]> = [OLE2_SIGNATURE, WORD_5_MACINTOSH_SIGNATURE];
const LONGEST_SIGNATURE_BYTES = Math.max(CGM_ENCODING_PROBE_BYTES, ...LEGACY_BINARY_SIGNATURES.map((signature) => signature.length));

/** The first `count` bytes of the input (the longest signature by default), read without loading the file when it is not in memory. */
function leadingBytes(input: Buffer | WorkerVfsPayload, count = LONGEST_SIGNATURE_BYTES): Buffer {
  if (Buffer.isBuffer(input)) return input.subarray(0, count);
  if (input.inputBuffer) return input.inputBuffer.subarray(0, count);
  if (input.inputPath === undefined) return Buffer.alloc(0);
  const descriptor = fs.openSync(input.inputPath, 'r');
  try {
    const head = Buffer.alloc(Math.min(count, fs.fstatSync(descriptor).size));
    return head.subarray(0, fs.readSync(descriptor, head, 0, head.length, 0));
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Whether the office suite reads this input: every source of its table, but not a clear-text CGM, which the in-process parser reads. */
export function officeSuiteReadsInput(src: string, input: Buffer | WorkerVfsPayload): boolean {
  return OFFICE_NATIVE_SOURCES.has(src) && (!isOfficeSuiteOnlySource(src) || officeSuiteReadsBytes(src, leadingBytes(input)));
}

/** Whether the office suite reads this input and writes `tgt` in the one pass that opens it. */
export function officeSuiteReadsInputAndWrites(src: string, tgt: string, input: Buffer | WorkerVfsPayload): boolean {
  return officeSuiteReadsInput(src, input) && officeSuiteWritesTarget(src, tgt);
}

/** The in-process reader's refusal of an encrypted workbook, which the office suite may still read: it decrypts one that uses the default password of the format. */
function isEncryptedWorkbookRefusal(src: string, refusal: unknown): boolean {
  return refusal instanceof EncryptedOfficeDocumentError && !(refusal instanceof SuiteEncryptedDocumentError) && officeReadingFormat(src) === 'xls';
}

/**
 * The refusal, or the parser error a reader wrapped it around (its `cause`), is a compound file whose table of contents is destroyed.
 * That is no damage the office suite repairs: for the real workbooks whose directory runs past the file it wrote their bytes as text.
 */
function isDestroyedStructure(refusal: unknown): boolean {
  return refusal instanceof CompoundFileStructureError || (refusal instanceof Error && refusal.cause instanceof CompoundFileStructureError);
}

/**
 * A legacy binary Office document (Word, Excel, PowerPoint, and their templates and slide shows) that the strict in-process
 * reader refuses as malformed, or a workbook it refuses as encrypted, is read by the office suite instead, which reads damaged files the way the application that
 * wrote them does. Only a file that starts like a legacy binary document is handed over: the office suite also loads the
 * HTML, RTF and text that real files carry under these extensions, and those bodies go through the staged HTML path (with its
 * image fetch guard) or the reader of their own format, never straight to the suite. When the office suite cannot read the
 * document either, the reader's own refusal stands (undefined here).
 */
export async function retryRefusedLegacyDocument(deps: OfficeSuiteRouteDeps, request: OfficeSuiteRequest, refusal: unknown): Promise<WorkerConversionResult | undefined> {
  const interchange = legacyReaderRetryInterchange(request.src, request.tgt);
  const readerRefusal = refusal instanceof LegacyOfficeFormatError || refusal instanceof CorruptStreamError || isEncryptedWorkbookRefusal(request.src, refusal);
  const refused = readerRefusal && !isDestroyedStructure(refusal);
  if (interchange === undefined || !refused || request.options.signal?.aborted) return undefined;
  const head = leadingBytes(request.input);
  if (!LEGACY_BINARY_SIGNATURES.some((signature) => startsWithBytes(head, signature))) return undefined;
  try {
    const retried = await convertThroughInterchange(deps, request, interchange);
    return { ...retried, fallbackChain: [...(retried.fallbackChain ?? []), `in-process reader refused the document: ${(refusal as Error).message}`] };
  } catch (retryError) {
    if (request.options.signal?.aborted) throw retryError;
    // For an encrypted workbook the suite's run is the only way to read it: a failure that is not the suite's verdict on the file
    // (an unavailable engine, a time or memory limit) is answered as itself, so it stays retryable, never as a lasting "encrypted".
    if (isEncryptedWorkbookRefusal(request.src, refusal) && !(retryError instanceof EncryptedOfficeDocumentError)) throw retryError;
    return undefined;
  }
}
