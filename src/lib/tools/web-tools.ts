import path from 'node:path';
import {
  create7zArchiveAsync,
  createTarArchive,
  createZipArchive,
  rotatePdfPages,
  splitPdfPages,
} from '../conversions';
import { ARCHIVE_SECURITY_LIMITS } from '../conversions/archive';
import { ARCHIVE_COMPRESSION_LEVEL_DEFAULT } from '../conversions/archive-compression-level';
import { gzipInBlocks } from '../conversions/deflate-blocks';
import type { ArchiveExtractionLimits } from '../conversions/archive-extraction-safety';
import { mergePdfBuffers } from '../jobs';
import { ARCHIVE_CREATE_FORMATS } from '../jobs/graph-operations';
import { extractGraphArchiveEntries } from '../queue/graph/node-executor';
import { sanitizeNodeOutputFilename } from '../queue/graph/node-jobs';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '../plan-limits';
import { getFormatByExtension } from '../registry';
import { assertNotSpoofedFile } from '../security/file-guard';
import {
  MAX_EXTRACTED_BYTES,
  MAX_EXTRACTED_ENTRIES,
  MAX_TOOL_FILES,
  MAX_TOOL_OPTIONS_CHARS,
  MAX_TOOL_OUTPUT_BYTES,
  MIN_MERGE_FILES,
  type WebTool,
  type WebToolOptions,
} from './tool-names';
import type { ConversionRefusalCode } from '../refusal-codes';
import {
  ConversionFailedError,
  type PdfProtectOptions,
  type PdfRotateOptions,
  type PdfRotationDegrees,
  type PdfWatermarkOptions,
} from '../types';
import { protectPdf } from '../conversions/pdf-postprocess/protect';
import { unlockPdf } from '../conversions/pdf-postprocess/unlock';
import { applyPdfWatermark } from '../conversions/pdf-postprocess/watermark';
import { deletePdfPages, extractPdfPages } from '../conversions/pdf-postprocess/page-ops';

/** The refusals of a tool run that no engine error names; a code is the key of a sentence in the interface. */
export type WebToolRefusalCode = Extract<
  ConversionRefusalCode,
  'file_required' | 'empty_file' | 'too_few_files' | 'too_many_files' | 'input_over_limit' | 'unsupported_input' | 'invalid_options' | 'spoofed_file'
>;

export class WebToolRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: WebToolRefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'WebToolRefusal';
  }
}

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

export interface WebToolFile {
  name: string;
  buffer: Buffer;
}

export interface ExtractedEntry {
  name: string;
  size: number;
  mimeType: string;
  buffer: Buffer;
}

export type WebToolOutput =
  | { kind: 'file'; filename: string; mimeType: string; buffer: Buffer }
  | { kind: 'entries'; entries: ExtractedEntry[] };

const ARCHIVE_INPUT_EXTENSIONS = [
  'zip',
  '7z',
  'rar',
  'tar',
  'tar.gz',
  'tgz',
  'tar.bz2',
  'tbz2',
  'tbz',
  'tar.xz',
  'txz',
  'tar.zst',
  'tzst',
  'bz2',
  'xz',
  'zst',
  'gz',
] as const;
const COMPOUND_ARCHIVE_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'] as const;
const PDF_EXTENSION = 'pdf';
const OPAQUE_MIME_TYPE = 'application/octet-stream';
const DEFAULT_ARCHIVE_FORMAT = 'zip';

/** The tools that take exactly one file. */
const SINGLE_FILE_TOOLS: ReadonlySet<WebTool> = new Set<WebTool>([
  'archive-extract',
  'split',
  'rotate',
  'protect',
  'unlock',
  'watermark',
  'extract-pages',
  'delete-pages',
]);

function extensionOfName(name: string): string {
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(compound)) {
      return compound.slice(1);
    }
  }
  return path.extname(lower).replace(/^\./, '');
}

/** The archive extension or format id a tool reads a file as; `tgz` is read as `tar.gz`. */
function archiveExtensionOf(name: string): string | undefined {
  const ext = extensionOfName(name);
  return (ARCHIVE_INPUT_EXTENSIONS as readonly string[]).includes(ext) ? ext : undefined;
}

function refuseFileCount(tool: WebTool, count: number): void {
  if (count === 0) throw new WebToolRefusal(HTTP_BAD_REQUEST, 'file_required', 'Missing required "files" in multipart request.');
  if (SINGLE_FILE_TOOLS.has(tool)) {
    if (count > 1) throw new WebToolRefusal(HTTP_BAD_REQUEST, 'too_many_files', `This tool takes one file; the request has ${count}.`);
    return;
  }
  if (count > MAX_TOOL_FILES) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'too_many_files', `A run takes at most ${MAX_TOOL_FILES} files; the request has ${count}.`);
  }
  if (tool === 'merge' && count < MIN_MERGE_FILES) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'too_few_files', `A merge needs at least ${MIN_MERGE_FILES} files; the request has ${count}.`);
  }
}

const pdfExtensionOf = (name: string): string | undefined => (extensionOfName(name) === PDF_EXTENSION ? PDF_EXTENSION : undefined);

function expectedExtension(tool: WebTool, name: string): { extension?: string; kind: string } {
  if (tool === 'archive-extract') {
    return {
      extension: archiveExtensionOf(name),
      kind: 'an archive (ZIP, 7Z, RAR, TAR, TAR.GZ/TGZ, TAR.BZ2/TBZ2/TBZ, TAR.XZ/TXZ, TAR.ZST/TZST, BZ2, XZ, ZST or GZ)',
    };
  }
  return { extension: pdfExtensionOf(name), kind: 'a PDF' };
}

function refuseUnreadableInput(tool: WebTool, file: WebToolFile): void {
  if (file.buffer.length === 0) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'empty_file', `The file "${file.name}" is empty.`);
  }
  if (tool === 'archive-create') return;
  const { extension, kind } = expectedExtension(tool, file.name);
  if (extension === undefined) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'unsupported_input', `The file "${file.name}" is not ${kind}.`);
  }
  try {
    assertNotSpoofedFile(file.buffer, extension, file.name);
  } catch (error) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'spoofed_file', error instanceof Error ? error.message : 'The file does not match its extension.');
  }
}

/** Refuses an upload list whose file count, aggregate byte size, or filenames violate tool limits before allocating file buffers. */
export function assertToolUploadMetadata(tool: WebTool, uploads: readonly { name: string; size: number }[]): void {
  refuseFileCount(tool, uploads.length);
  const total = uploads.reduce((sum, file) => sum + file.size, 0);
  if (total > SINGLE_REQUEST_FILE_MAX_BYTES) {
    throw new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', 'The files together are larger than one request takes.');
  }
  for (const file of uploads) {
    if (file.size === 0) {
      throw new WebToolRefusal(HTTP_BAD_REQUEST, 'empty_file', `The file "${file.name}" is empty.`);
    }
    if (tool === 'archive-create') continue;
    const { extension, kind } = expectedExtension(tool, file.name);
    if (extension === undefined) {
      throw new WebToolRefusal(HTTP_BAD_REQUEST, 'unsupported_input', `The file "${file.name}" is not ${kind}.`);
    }
  }
}

/** Refuses a run whose files are the wrong number, the wrong kind, empty or together over the size of one request. */
export function assertToolInput(tool: WebTool, files: readonly WebToolFile[]): void {
  refuseFileCount(tool, files.length);
  const total = files.reduce((sum, file) => sum + file.buffer.length, 0);
  if (total > SINGLE_REQUEST_FILE_MAX_BYTES) {
    throw new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', 'The files together are larger than one request takes.');
  }
  for (const file of files) refuseUnreadableInput(tool, file);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function refuseOptions(message: string): never {
  throw new WebToolRefusal(HTTP_BAD_REQUEST, 'invalid_options', message);
}

/** A page specification the engines read: text, of a length the options field already bounds. */
function pageSpecOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') refuseOptions(`"${name}" must be text.`);
  return value;
}

function splitOptionsOf(value: unknown, top: Record<string, unknown>): WebToolOptions {
  if (value !== undefined && !isPlainObject(value)) refuseOptions('"split" must be an object.');
  const target = isPlainObject(value) ? value : top;
  const { ranges, everyNPages } = target;
  if (everyNPages !== undefined && (typeof everyNPages !== 'number' || !Number.isInteger(everyNPages))) {
    refuseOptions('"split.everyNPages" must be a whole number.');
  }
  const result: WebToolOptions = {
    split: { ranges: pageSpecOf(ranges, 'split.ranges'), everyNPages: everyNPages as number | undefined },
  };
  if (typeof top.password === 'string') result.password = top.password;
  if (top.confirmEditRights === true) result.confirmEditRights = true;
  return result;
}

function parseRotationsList(list: unknown[]): Array<{ rotation: PdfRotationDegrees; pages?: string }> {
  return list.map((item, idx) => {
    if (!isPlainObject(item)) refuseOptions(`"rotate.rotations[${idx}]" must be an object.`);
    if (typeof item.angle !== 'number') {
      refuseOptions('The web tool takes one rotation and its pages.');
    }
    const rot = item.angle;
    if (rot !== 90 && rot !== 180 && rot !== 270) {
      refuseOptions(`"rotate.rotations[${idx}].angle" must be 90, 180 or 270.`);
    }
    return { rotation: rot as PdfRotationDegrees, pages: pageSpecOf(item.pages, `rotate.rotations[${idx}].pages`) };
  });
}

function rotateOptionsOf(value: unknown, top: Record<string, unknown>): WebToolOptions {
  if (value !== undefined && !isPlainObject(value)) refuseOptions('"rotate" must be an object.');
  const target = isPlainObject(value) ? value : top;
  if (Array.isArray(target.rotations)) {
    const result: WebToolOptions = {
      rotate: { rotations: parseRotationsList(target.rotations) },
    };
    if (typeof top.password === 'string') result.password = top.password;
    if (top.confirmEditRights === true) result.confirmEditRights = true;
    return result;
  }
  const rotation = target.rotation ?? 90;
  if (rotation !== 90 && rotation !== 180 && rotation !== 270) {
    refuseOptions('"rotate.rotation" must be 90, 180 or 270.');
  }
  const result: WebToolOptions = {
    rotate: { rotation: rotation as PdfRotationDegrees, pages: pageSpecOf(target.pages, 'rotate.pages') },
  };
  if (typeof top.password === 'string') result.password = top.password;
  if (top.confirmEditRights === true) result.confirmEditRights = true;
  return result;
}

function protectOptionsOf(value: unknown, top: Record<string, unknown>): WebToolOptions {
  const target = isPlainObject(value) ? value : top;
  const keyLength = target.keyLength ?? 256;
  if (keyLength !== 128 && keyLength !== 256) refuseOptions('"protect.keyLength" must be 128 or 256.');
  return {
    protect: {
      userPassword: typeof target.userPassword === 'string' ? target.userPassword : undefined,
      ownerPassword: typeof target.ownerPassword === 'string' ? target.ownerPassword : undefined,
      keyLength: keyLength as 128 | 256,
      permissions: isPlainObject(target.permissions) ? (target.permissions as PdfProtectOptions['permissions']) : undefined,
    },
    password: typeof top.password === 'string' ? top.password : undefined,
    confirmEditRights: top.confirmEditRights === true,
  };
}

function unlockOptionsOf(value: unknown, top: Record<string, unknown>): WebToolOptions {
  const target = isPlainObject(value) ? value : top;
  let password: string | undefined;
  if (typeof target.password === 'string') {
    password = target.password;
  } else if (typeof top.password === 'string') {
    password = top.password;
  }
  const confirmEditRights = target.confirmEditRights === true || top.confirmEditRights === true;
  return { unlock: { password, confirmEditRights }, password, confirmEditRights };
}

function watermarkOptionsOf(value: unknown, top: Record<string, unknown>): WebToolOptions {
  const target = isPlainObject(value) ? value : top;
  return {
    watermark: {
      text: typeof target.text === 'string' ? target.text : 'CONFIDENTIAL',
      fontSize: typeof target.fontSize === 'number' ? target.fontSize : undefined,
      fontColor: typeof target.fontColor === 'string' ? target.fontColor : undefined,
      opacity: typeof target.opacity === 'number' ? target.opacity : undefined,
      rotation: typeof target.rotation === 'number' ? target.rotation : undefined,
      position: typeof target.position === 'string' ? (target.position as PdfWatermarkOptions['position']) : undefined,
      layer: target.layer === 'under' ? 'under' : 'over',
      pages: pageSpecOf(target.pages, 'watermark.pages'),
    },
    password: typeof top.password === 'string' ? top.password : undefined,
    confirmEditRights: top.confirmEditRights === true,
  };
}

function pageOpsOptionsOf(tool: 'extract-pages' | 'delete-pages', value: unknown, top: Record<string, unknown>): WebToolOptions {
  const target = isPlainObject(value) ? value : top;
  const password = typeof top.password === 'string' ? top.password : undefined;
  const confirmEditRights = top.confirmEditRights === true;
  const pages = pageSpecOf(target.pages ?? top.pages, `${tool}.pages`) ?? '1';
  return tool === 'extract-pages'
    ? { extractPages: { pages }, password, confirmEditRights }
    : { deletePages: { pages }, password, confirmEditRights };
}

/**
 * The options of a request, as much of them as the tool reads: the field is bounded, and only the keys of the tool are
 * copied, so nothing else the body names reaches an engine.
 */
export function parseToolOptions(tool: WebTool, raw: string | undefined): WebToolOptions {
  if (!raw) return tool === 'rotate' ? rotateOptionsOf(undefined, {}) : {};
  if (raw.length > MAX_TOOL_OPTIONS_CHARS) refuseOptions(`The "options" field may be at most ${MAX_TOOL_OPTIONS_CHARS} characters.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuseOptions('Invalid JSON format for "options" parameter.');
  }
  if (!isPlainObject(parsed)) refuseOptions('The "options" field must be a JSON object.');
  switch (tool) {
    case 'archive-create': {
      const format = parsed.format ?? DEFAULT_ARCHIVE_FORMAT;
      if (typeof format !== 'string' || !ARCHIVE_CREATE_FORMATS.has(format)) refuseOptions(`"format" must be one of ${[...ARCHIVE_CREATE_FORMATS].join(', ')}.`);
      return { format };
    }
    case 'split':
      return splitOptionsOf(parsed.split, parsed);
    case 'rotate':
      return rotateOptionsOf(parsed.rotate, parsed);
    case 'protect':
      return protectOptionsOf(parsed.protect, parsed);
    case 'unlock':
      return unlockOptionsOf(parsed.unlock, parsed);
    case 'watermark':
      return watermarkOptionsOf(parsed.watermark, parsed);
    case 'extract-pages':
    case 'delete-pages':
      return pageOpsOptionsOf(tool, parsed[tool], parsed);
    case 'archive-extract':
    case 'merge': {
      const result: WebToolOptions = {};
      if (typeof parsed.password === 'string') result.password = parsed.password;
      return result;
    }
  }
}

const mimeTypeOfName = (name: string): string => getFormatByExtension(extensionOfName(name))?.mimeType ?? OPAQUE_MIME_TYPE;

async function createArchive(files: readonly WebToolFile[], format: string, signal?: AbortSignal): Promise<WebToolOutput> {
  const entries = files.map((file) => ({ filename: file.name, buffer: file.buffer }));
  const filename = `archive.${format}`;
  const mimeType = getFormatByExtension(format)?.mimeType ?? OPAQUE_MIME_TYPE;
  if (format === 'zip') return fileOutput(filename, mimeType, (await createZipArchive(entries, {}, filename)).buffer);
  if (format === '7z') return fileOutput(filename, mimeType, (await create7zArchiveAsync(entries, {}, filename, { signal })).buffer);
  const tar = createTarArchive(entries, {}, 'archive.tar').buffer;
  return fileOutput(filename, mimeType, format === 'tar.gz' ? await gzipInBlocks(tar, ARCHIVE_COMPRESSION_LEVEL_DEFAULT) : tar);
}

/** The caps of an extraction for an answer: the entries and the inflated bytes the answer lists, counted as they are unpacked. */
export const WEB_EXTRACTION_LIMITS: ArchiveExtractionLimits = {
  MAX_FILES: MAX_EXTRACTED_ENTRIES,
  MAX_UNCOMPRESSED_SIZE: MAX_EXTRACTED_BYTES,
  MAX_RATIO: ARCHIVE_SECURITY_LIMITS.MAX_RATIO,
};

function tooLargeToList(): WebToolRefusal {
  return new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', `The files in the archive are larger than the ${MAX_EXTRACTED_BYTES / (1024 * 1024)} MiB one answer lists.`);
}

/** The files of an archive, unpacked under the caps of the answer; a TAR that passes them is a 413 as the other formats are. */
async function unpacked(archive: WebToolFile, password?: string, signal?: AbortSignal): Promise<{ filename: string; buffer: Buffer }[]> {
  try {
    return await extractGraphArchiveEntries(archive.name, archive.buffer, { password, signal }, WEB_EXTRACTION_LIMITS);
  } catch (error) {
    if (error instanceof ConversionFailedError && error.message.startsWith('Archive bomb detected')) throw tooLargeToList();
    throw error;
  }
}

export function fileOutput(filename: string, mimeType: string, buffer: Buffer): WebToolOutput {
  if (buffer.length > MAX_TOOL_OUTPUT_BYTES) {
    throw new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', `The result is larger than the ${MAX_TOOL_OUTPUT_BYTES / (1024 * 1024)} MiB one answer carries.`);
  }
  return { kind: 'file', filename, mimeType, buffer };
}

function listedEntries(extracted: readonly { filename: string; buffer: Buffer }[]): ExtractedEntry[] {
  if (extracted.length > MAX_EXTRACTED_ENTRIES) {
    throw new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', `The archive holds ${extracted.length} files; at most ${MAX_EXTRACTED_ENTRIES} are listed.`);
  }
  const total = extracted.reduce((sum, entry) => sum + entry.buffer.length, 0);
  if (total > MAX_EXTRACTED_BYTES) throw tooLargeToList();
  const used = new Set<string>();
  return extracted.map((entry, index) => {
    const leaf = sanitizeNodeOutputFilename(entry.filename, `file_${index + 1}`);
    const { name: stem, ext } = path.parse(leaf);
    let name = leaf;
    for (let copy = 1; used.has(name); copy++) name = `${stem} (${copy})${ext}`;
    used.add(name);
    return { name, size: entry.buffer.length, mimeType: mimeTypeOfName(name), buffer: entry.buffer };
  });
}

/**
 * Runs `tool` on `files`, already checked by `assertToolInput`, with the code of the job graph node of the same name.
 */
export async function runWebTool(
  tool: WebTool,
  files: readonly WebToolFile[],
  options: WebToolOptions,
  signal?: AbortSignal
): Promise<WebToolOutput> {
  const [first] = files;
  const base = path.parse(first.name).name;
  const access = {
    password: options.password ?? options.unlock?.password,
    confirmEditRights: options.confirmEditRights ?? options.unlock?.confirmEditRights,
    signal,
  };
  switch (tool) {
    case 'merge':
      return fileOutput(
        'merged.pdf',
        'application/pdf',
        await mergePdfBuffers(files.map((file) => file.buffer), {
          signal,
          names: files.map((file) => file.name),
          confirmEditRights: access.confirmEditRights,
          passwords: access.password ? files.map(() => access.password!) : undefined,
        })
      );
    case 'archive-create':
      return createArchive(files, options.format ?? DEFAULT_ARCHIVE_FORMAT, signal);
    case 'archive-extract':
      return { kind: 'entries', entries: listedEntries(await unpacked(first, options.password, signal)) };
    case 'split':
      return fileOutput(`${base}-split.zip`, 'application/zip', await splitPdfPages(first.buffer, options.split, access, base, signal));
    case 'rotate':
      return fileOutput(`${base}-rotated.pdf`, 'application/pdf', await rotatePdfPages(first.buffer, options.rotate as PdfRotateOptions, access, signal));
    case 'protect':
      return fileOutput(`${base}-protected.pdf`, 'application/pdf', await protectPdf(first.buffer, options.protect as PdfProtectOptions, access));
    case 'unlock':
      return fileOutput(`${base}-unlocked.pdf`, 'application/pdf', await unlockPdf(first.buffer, access));
    case 'watermark':
      return fileOutput(`${base}-watermarked.pdf`, 'application/pdf', await applyPdfWatermark(first.buffer, options.watermark as PdfWatermarkOptions, access));
    case 'extract-pages':
      return fileOutput(`${base}-extracted.pdf`, 'application/pdf', await extractPdfPages(first.buffer, options.extractPages?.pages ?? options.pages ?? '1', access));
    case 'delete-pages':
      return fileOutput(`${base}-deleted.pdf`, 'application/pdf', await deletePdfPages(first.buffer, options.deletePages?.pages ?? options.pages ?? '1', access));
  }
}

export { WEB_TOOLS, type WebTool, type WebToolOptions } from './tool-names';
