import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import {
  create7zArchiveAsync,
  createTarArchive,
  createZipArchive,
  rotatePdfPages,
  splitPdfPages,
} from '../conversions';
import { mergePdfBuffers } from '../jobs';
import { ARCHIVE_CREATE_FORMATS } from '../jobs/graph-operations';
import { extractGraphArchiveEntries } from '../queue/graph/node-executor';
import { sanitizeNodeOutputFilename } from '../queue/graph/node-jobs';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '../plan-limits';
import { getFormatByExtension } from '../registry';
import { assertNotSpoofedFile } from '../security/file-guard';
import { MAX_EXTRACTED_ENTRIES, MAX_TOOL_FILES, MIN_MERGE_FILES, type WebTool, type WebToolOptions } from './tool-names';
import type { ConversionRefusalCode } from '../refusal-codes';
import type { PdfRotateOptions } from '../types';

const gzip = promisify(zlib.gzip);


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

const ARCHIVE_INPUT_EXTENSIONS = ['zip', '7z', 'rar', 'tar', 'tar.gz', 'tgz'] as const;
const PDF_EXTENSION = 'pdf';
const OPAQUE_MIME_TYPE = 'application/octet-stream';
const DEFAULT_ARCHIVE_FORMAT = 'zip';

/** The tools that take exactly one file. */
const SINGLE_FILE_TOOLS: ReadonlySet<WebTool> = new Set<WebTool>(['archive-extract', 'split', 'rotate']);

function extensionOfName(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar.gz') ? 'tar.gz' : path.extname(lower).replace(/^\./, '');
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

function refuseUnreadableInput(tool: WebTool, file: WebToolFile): void {
  if (file.buffer.length === 0) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'empty_file', `The file "${file.name}" is empty.`);
  }
  if (tool === 'archive-create') return;
  const isExtract = tool === 'archive-extract';
  const extension = isExtract ? archiveExtensionOf(file.name) : pdfExtensionOf(file.name);
  if (extension === undefined) {
    const kind = isExtract ? 'an archive (ZIP, 7Z, RAR, TAR or TAR.GZ)' : 'a PDF';
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'unsupported_input', `The file "${file.name}" is not ${kind}.`);
  }
  try {
    assertNotSpoofedFile(file.buffer, extension, file.name);
  } catch (error) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'spoofed_file', error instanceof Error ? error.message : 'The file does not match its extension.');
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

/** The options of a request: a JSON object, with the formats of an archive checked. */
export function parseToolOptions(tool: WebTool, raw: string | undefined): WebToolOptions {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'invalid_options', 'Invalid JSON format for "options" parameter.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'invalid_options', 'The "options" field must be a JSON object.');
  }
  const options = parsed as WebToolOptions;
  if (tool === 'archive-create' && options.format !== undefined && !ARCHIVE_CREATE_FORMATS.has(options.format)) {
    throw new WebToolRefusal(HTTP_BAD_REQUEST, 'invalid_options', `"format" must be one of ${[...ARCHIVE_CREATE_FORMATS].join(', ')}.`);
  }
  return options;
}

const mimeTypeOfName = (name: string): string => getFormatByExtension(extensionOfName(name))?.mimeType ?? OPAQUE_MIME_TYPE;

async function createArchive(files: readonly WebToolFile[], format: string): Promise<WebToolOutput> {
  const entries = files.map((file) => ({ filename: file.name, buffer: file.buffer }));
  const filename = `archive.${format}`;
  const mimeType = getFormatByExtension(format)?.mimeType ?? OPAQUE_MIME_TYPE;
  if (format === 'zip') return { kind: 'file', filename, mimeType, buffer: (await createZipArchive(entries, {}, filename)).buffer };
  if (format === '7z') return { kind: 'file', filename, mimeType, buffer: (await create7zArchiveAsync(entries, {}, filename)).buffer };
  const tar = createTarArchive(entries, {}, 'archive.tar').buffer;
  return { kind: 'file', filename, mimeType, buffer: format === 'tar.gz' ? await gzip(tar) : tar };
}

/** The names an unpacked archive lists: the leaf of each entry, kept clear of the others, as the job graph names its outputs. */
function listedEntries(extracted: readonly { filename: string; buffer: Buffer }[]): ExtractedEntry[] {
  if (extracted.length > MAX_EXTRACTED_ENTRIES) {
    throw new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', `The archive holds ${extracted.length} files; at most ${MAX_EXTRACTED_ENTRIES} are listed.`);
  }
  const total = extracted.reduce((sum, entry) => sum + entry.buffer.length, 0);
  if (total > SINGLE_REQUEST_FILE_MAX_BYTES) {
    throw new WebToolRefusal(HTTP_PAYLOAD_TOO_LARGE, 'input_over_limit', 'The files in the archive are larger than one answer carries.');
  }
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
 * Engine errors (a page range the document does not have, an unsafe archive, a PDF that needs a password) pass through to the route.
 */
export async function runWebTool(tool: WebTool, files: readonly WebToolFile[], options: WebToolOptions): Promise<WebToolOutput> {
  const [first] = files;
  const base = path.parse(first.name).name;
  switch (tool) {
    case 'merge':
      return { kind: 'file', filename: 'merged.pdf', mimeType: 'application/pdf', buffer: await mergePdfBuffers(files.map((file) => file.buffer)) };
    case 'archive-create':
      return createArchive(files, options.format ?? DEFAULT_ARCHIVE_FORMAT);
    case 'archive-extract':
      return { kind: 'entries', entries: listedEntries(await extractGraphArchiveEntries(first.name, first.buffer)) };
    case 'split':
      return { kind: 'file', filename: `${base}-split.zip`, mimeType: 'application/zip', buffer: await splitPdfPages(first.buffer, options.split, {}, base) };
    case 'rotate':
      return { kind: 'file', filename: `${base}-rotated.pdf`, mimeType: 'application/pdf', buffer: await rotatePdfPages(first.buffer, options.rotate as PdfRotateOptions) };
  }
}

export { isWebTool, WEB_TOOLS, type WebTool, type WebToolOptions } from './tool-names';
