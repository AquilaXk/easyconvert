import fs from 'node:fs';
import { ConversionFailedError, CorruptStreamError, EncryptedOfficeDocumentError, EngineUnavailableError } from '../lib/types';
import { LegacyOfficeFormatError } from '../lib/conversions/office/legacy-office-errors';
import { LEGACY_OFFICE_MAX_INPUT_BYTES } from '../lib/conversions/office/legacy-office-limits';
import { repairPptPersistIdSeed } from '../lib/conversions/office/ppt-reader';
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
import { readMetafilePage, type MetafileFormat } from '../lib/conversions/office/metafile-page-frame';
import { startsWithBytes } from '../lib/conversions/package-access';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../lib/conversions/page-range';
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

/** The bytes of an input, or undefined when it is a file larger than a legacy Office document may be. */
function inputBytes(input: Buffer | WorkerVfsPayload): Buffer | undefined {
  if (Buffer.isBuffer(input)) return input;
  if (input.inputBuffer) return input.inputBuffer;
  if (input.inputPath === undefined || fs.statSync(input.inputPath).size > LEGACY_OFFICE_MAX_INPUT_BYTES) return undefined;
  return fs.readFileSync(input.inputPath);
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
    const bytes = inputBytes(input);
    repaired = bytes && repairPptPersistIdSeed(bytes);
  } catch (prepareError) {
    if (prepareError instanceof EncryptedOfficeDocumentError) throw prepareError;
    return undefined;
  }
  if (repaired === undefined) return undefined;
  return Buffer.isBuffer(input) ? repaired : { outputPath: input.outputPath, inputBuffer: repaired };
}

type OfficeSuiteRun = (input: Buffer | WorkerVfsPayload, sourceFormat: string, targetFormat: string, options?: WorkerEngineOptions, originalFilename?: string) => Promise<WorkerConversionResult | null>;

/** `run`, and once more on the input `presentationRetryInput` returns when the office suite could not load a presentation. */
export function withPresentationRetry(run: OfficeSuiteRun): OfficeSuiteRun {
  return async (input, sourceFormat, targetFormat, options, originalFilename) => {
    try {
      return await run(input, sourceFormat, targetFormat, options, originalFilename);
    } catch (err) {
      const retry = presentationRetryInput(input, sourceFormat, err);
      if (retry === undefined) throw err;
      return run(retry, sourceFormat, targetFormat, options, originalFilename);
    }
  };
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
    const bytes = inputBytes(input);
    const page = bytes && readMetafilePage(bytes, format);
    if (!bytes || !page) return run(input, sourceFormat, targetFormat, options, originalFilename);
    const drawing = await metafileFrameDocument(bytes, format, page);
    const staged: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? drawing : { inputBuffer: drawing, outputPath: input.outputPath };
    return run(staged, FRAME_DRAWING_FORMAT, targetFormat, options, originalFilename);
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
  const writerOptions = { ...(writesTarget ? options : { ...options, outputPath: undefined }), throwOnUnavailable: true } as WorkerEngineOptions;
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

/** The signature every OLE2 compound file starts with (MS-CFB section 2.2): the container of Word, Excel and PowerPoint 97-2003 files. */
const OLE2_SIGNATURE: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** The start of a Word 5.0 for Macintosh file (a Word binary that is no compound file), which the office suite reads and the in-process reader refuses. */
const WORD_5_MACINTOSH_SIGNATURE: readonly number[] = [0xfe, 0x37, 0x00, 0x23];
const LEGACY_BINARY_SIGNATURES: ReadonlyArray<readonly number[]> = [OLE2_SIGNATURE, WORD_5_MACINTOSH_SIGNATURE];
const LONGEST_SIGNATURE_BYTES = Math.max(CGM_ENCODING_PROBE_BYTES, ...LEGACY_BINARY_SIGNATURES.map((signature) => signature.length));

/** The first bytes of the input, read without loading the file when it is not in memory. */
function leadingBytes(input: Buffer | WorkerVfsPayload): Buffer {
  if (Buffer.isBuffer(input)) return input.subarray(0, LONGEST_SIGNATURE_BYTES);
  if (input.inputBuffer) return input.inputBuffer.subarray(0, LONGEST_SIGNATURE_BYTES);
  if (input.inputPath === undefined) return Buffer.alloc(0);
  const descriptor = fs.openSync(input.inputPath, 'r');
  try {
    const head = Buffer.alloc(LONGEST_SIGNATURE_BYTES);
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

/**
 * A legacy binary Office document (Word, Excel, PowerPoint, and their templates and slide shows) that the strict in-process
 * reader refuses as malformed is read by the office suite instead, which reads damaged files the way the application that
 * wrote them does. Only a file that starts like a legacy binary document is handed over: the office suite also loads the
 * HTML, RTF and text that real files carry under these extensions, and those bodies go through the staged HTML path (with its
 * image fetch guard) or the reader of their own format, never straight to the suite. When the office suite cannot read the
 * document either, the reader's own refusal stands (undefined here).
 */
export async function retryRefusedLegacyDocument(deps: OfficeSuiteRouteDeps, request: OfficeSuiteRequest, refusal: unknown): Promise<WorkerConversionResult | undefined> {
  const interchange = legacyReaderRetryInterchange(request.src, request.tgt);
  const refused = refusal instanceof LegacyOfficeFormatError || refusal instanceof CorruptStreamError;
  if (interchange === undefined || !refused || request.options.signal?.aborted) return undefined;
  const head = leadingBytes(request.input);
  if (!LEGACY_BINARY_SIGNATURES.some((signature) => startsWithBytes(head, signature))) return undefined;
  try {
    const retried = await convertThroughInterchange(deps, request, interchange);
    return { ...retried, fallbackChain: [...(retried.fallbackChain ?? []), `in-process reader refused the document: ${(refusal as Error).message}`] };
  } catch (retryError) {
    if (request.options.signal?.aborted) throw retryError;
    return undefined;
  }
}
