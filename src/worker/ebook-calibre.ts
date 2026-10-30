import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ARCHIVE_SECURITY_LIMITS } from '../lib/conversions/archive';
import type { ArchiveExtractionLimits } from '../lib/conversions/archive-extraction-safety';
import { readZipDirectory, readZipEntries } from '../lib/conversions/archive-zip-reader';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../lib/conversions/bounded-inflate';
import { calibreEngineUnavailable } from '../lib/conversions/calibre-ebook-targets';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { fitsWindows1252 } from '../lib/conversions/office/windows-1252';
import { writeZipFile, type ZipEntryInput } from '../lib/conversions/zip-writer';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import {
  ConversionFailedError,
  CorruptStreamError,
  CpuTaskTimeoutError,
  EncryptedOfficeDocumentError,
  InvalidConversionOutputError,
  PayloadLimitError,
} from '../lib/types';
import { rethrowSandboxUnavailable, SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from './sandbox';
import { createConversionResult, handOffOutput, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/**
 * The Palm, Kindle, Sony and Open eBook targets (MOBI, AZW3, PDB, LRF, OEB) are written by calibre's `ebook-convert`
 * (GPL-3.0, an unmodified program started as a separate sandboxed process; nothing of calibre is copied or linked).
 *
 * The route: a source that calibre reads itself (an e-book of its own family, or an EPUB) is handed over as it is; every
 * other source is first written as EPUB by this project's own converters (`CalibreDeps.convert`, the whole worker
 * conversion of the pair), which calibre reads best, and then converted. Calibre runs with a configuration, cache and
 * temporary directory of its own inside the job directory (so no plug-in, setting or earlier job reaches it), no
 * network, the address space, file size, output and time limits of the other native programs, and the process group is
 * killed on a timeout or an abort. Its failure is a typed `ConversionFailedError`; a worker without the program answers
 * with an unavailable engine and never writes a file of its own.
 *
 * Options per target (https://manual.calibre-ebook.com/generated/en/ebook-convert.html):
 *  - MOBI: `--mobi-file-type old` (section "MOBI Output Options": "By default calibre generates MOBI files that contain the old
 *    MOBI 6 format. This format is compatible with all devices"; `both` adds the KF8 half, which AZW3 already covers).
 *  - AZW3: the defaults of the AZW3 writer (KF8).
 *  - PDB: `--format doc`, the PalmDOC records of section "PDB Output Options" (`ereader` and `ztxt` are the other formats).
 *    Text is written in Windows-1252, the PalmDOC code page and calibre's default `--pdb-output-encoding`; a book with a
 *    character that code page lacks is written in UTF-8 instead, which keeps its text (calibre's own `?` substitution is
 *    a loss of text that nothing signals).
 *  - LRF: the defaults of the LRF writer ("LRF Output Options").
 *  - OEB: the defaults of the OEB writer ("OEB Output Options"), which writes a folder (an OPF package with XHTML); the folder is
 *    delivered as one ZIP file.
 *  - MOBI and AZW3 also pass `--no-inline-toc` ("Don't add Table of Contents to the book"): the navigation is the NCX/KF8
 *    index, and a contents page written into the text would be words the source does not have.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** The address space of the program: Python and Qt map far more than they use, and a 1 GiB limit still converts a short book. */
const MEMORY_LIMIT_MB = 4096;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** Calibre prints its progress log on the standard output and writes the book to a file. */
const EXPECTED_PIPED_OUTPUT_BYTES = 64 * 1024;
const TEMP_PREFIX = 'easyconvert-calibre-';
const BOOK_NAME = 'book';
const OUTPUT_NAME = 'converted';
const TEXT_SCAN_NAME = 'text-scan.txt';
const EPUB_FORMAT = 'epub';
const TEXT_SCAN_CHUNK_BYTES = 1024 * 1024;
/** Largest e-book handed to calibre as it is, and the inflate budget of the EPUB it reads: the budget of one document everywhere else. */
const MAX_BOOK_BYTES = MAX_DOCUMENT_INFLATE_BYTES;
const PACKAGE_LIMITS: ArchiveExtractionLimits = {
  MAX_FILES: ARCHIVE_SECURITY_LIMITS.MAX_FILES,
  MAX_UNCOMPRESSED_SIZE: MAX_DOCUMENT_INFLATE_BYTES,
  MAX_RATIO: ARCHIVE_SECURITY_LIMITS.MAX_RATIO,
};
const MAX_OEB_FILES = ARCHIVE_SECURITY_LIMITS.MAX_FILES;
const MAX_OEB_BYTES = MAX_DOCUMENT_INFLATE_BYTES;
/** An OEB folder is delivered as a ZIP: no registered media type names a zipped OEB package. */
const OEB_MIME_TYPE = 'application/zip';
const DRM_PATTERN = /\bDRMError\b|protected by DRM/i;
const PDB_ENCODING_WINDOWS_1252 = 'cp1252';
const PDB_ENCODING_UTF8 = 'utf-8';

/** Sources calibre has an input plug-in for and that are handed to it unchanged: the Palm, Kindle and Sony families, FictionBook and EPUB. */
const CALIBRE_NATIVE_SOURCES: ReadonlySet<string> = new Set(['mobi', 'azw', 'azw3', 'pdb', 'lrf', 'fb2', EPUB_FORMAT]);

const TARGET_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  mobi: ['--mobi-file-type', 'old', '--no-inline-toc'],
  azw3: ['--no-inline-toc'],
  pdb: ['--format', 'doc'],
  lrf: [],
  oeb: [],
};

interface OutputSignature {
  offset: number;
  bytes: Buffer;
}
const PALMDB_TYPE_CREATOR_OFFSET = 60;
/** PalmDB type and creator (the Palm database header, bytes 60 to 67): a Mobipocket book is `BOOKMOBI`, a PalmDOC book `TEXtREAd`. */
const OUTPUT_SIGNATURES: Readonly<Record<string, OutputSignature>> = {
  mobi: { offset: PALMDB_TYPE_CREATOR_OFFSET, bytes: Buffer.from('BOOKMOBI', 'latin1') },
  azw3: { offset: PALMDB_TYPE_CREATOR_OFFSET, bytes: Buffer.from('BOOKMOBI', 'latin1') },
  pdb: { offset: PALMDB_TYPE_CREATOR_OFFSET, bytes: Buffer.from('TEXtREAd', 'latin1') },
  lrf: { offset: 0, bytes: Buffer.from([0x4c, 0x00, 0x52, 0x00, 0x46, 0x00, 0x00, 0x00]) },
};
const OEB_PACKAGE_FILE = /\.opf$/i;

/** What the route runs on: the whole worker conversion of a source into EPUB, and the clean-up of its temporary output. */
export interface CalibreDeps {
  convert(input: Buffer | WorkerVfsPayload, src: string, target: string, options: WorkerEngineOptions, originalFilename: string): Promise<WorkerConversionResult>;
  discardOutput(filePath: string | undefined, input: Buffer | WorkerVfsPayload, options: WorkerEngineOptions): void;
}

export interface CalibreRequest {
  input: Buffer | WorkerVfsPayload;
  src: string;
  tgt: string;
  options: WorkerEngineOptions;
  originalFilename: string;
}

/** The run limit of the job: its own stage limit, or the default, and never more than the ceiling. */
function runTimeoutMs(options: WorkerEngineOptions): number {
  return Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** The directories and settings calibre gets: all inside the job directory, so no plug-in, setting or cache of another job or of the host reaches it. */
function calibreEnvironment(dir: string): Record<string, string> {
  const home = path.join(dir, 'home');
  const temp = path.join(dir, 'tmp');
  const config = path.join(dir, 'config');
  const cache = path.join(dir, 'cache');
  const runtime = path.join(dir, 'runtime');
  for (const created of [home, temp, config, cache, runtime]) fs.mkdirSync(created, { mode: 0o700 });
  return {
    HOME: home,
    TMPDIR: temp,
    CALIBRE_TEMP_DIR: temp,
    CALIBRE_CONFIG_DIRECTORY: config,
    CALIBRE_CACHE_DIRECTORY: cache,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: home,
    XDG_RUNTIME_DIR: runtime,
    QT_QPA_PLATFORM: 'offscreen',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
}

/** The last line calibre printed about a failure, without the job directory. */
function failureDetail(stderr: string, dir: string): string {
  const lines = stderr.replaceAll(dir, '<tmp>').trim().split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  return last === '' ? '' : `: ${last.slice(0, MAX_STDERR_CHARS)}`;
}

/** The typed error of a run that failed: its limits, a protected book, or what calibre printed about the file. */
function toCalibreError(err: unknown, src: string, tgt: string, dir: string): unknown {
  if (err instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError(`.${src} to .${tgt} conversion`, err.timeoutMs);
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`calibre exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) {
    if (DRM_PATTERN.test(err.stderr)) return new EncryptedOfficeDocumentError(`The .${src} book is protected by DRM and cannot be converted.`);
    return new ConversionFailedError(`calibre could not convert the .${src} file to .${tgt}${failureDetail(err.stderr, dir)}`);
  }
  return err;
}

async function runCalibre(program: string, args: readonly string[], dir: string, environment: Record<string, string>, request: CalibreRequest): Promise<void> {
  const limits: LaunchedExecutionOptions = {
    timeoutMs: runTimeoutMs(request.options),
    maxBuffer: request.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    memoryLimitMb: MEMORY_LIMIT_MB,
    networkIsolated: true,
    signal: request.options.signal,
    cwd: dir,
    env: environment,
    expectedOutputBytes: EXPECTED_PIPED_OUTPUT_BYTES,
  };
  try {
    await launchSandboxedBinary(program, [...args], limits);
  } catch (err) {
    rethrowSandboxUnavailable(err);
    throw toCalibreError(err, request.src, request.tgt, dir);
  }
}

/** The EPUB inflated under the archive limits of the conversion (entry count, ratio, 256 MiB) with every name checked, and written again as a plain ZIP. */
async function repackEpub(input: Buffer, destination: string): Promise<void> {
  const entries = await readZipEntries(input, readZipDirectory(input, PACKAGE_LIMITS), { limits: PACKAGE_LIMITS });
  const names = new Set<string>();
  for (const { filename } of entries) {
    if (names.has(filename)) throw new CorruptStreamError(`The EPUB holds the entry "${filename}" more than once.`);
    names.add(filename);
  }
  await writeZipFile(destination, entries.map(({ filename, buffer }): ZipEntryInput => ({ name: filename, data: buffer, method: 'auto' })));
}

function inputSize(input: Buffer | WorkerVfsPayload): number {
  if (Buffer.isBuffer(input)) return input.length;
  if (input.inputBuffer) return input.inputBuffer.length;
  return input.inputPath ? fs.statSync(input.inputPath).size : 0;
}

/** Puts the e-book calibre reads in the job directory under a name of its own (calibre picks its reader by the extension) and returns its path. */
async function stageNativeBook(input: Buffer | WorkerVfsPayload, src: string, dir: string): Promise<string> {
  const size = inputSize(input);
  if (size > MAX_BOOK_BYTES) throw new PayloadLimitError(`The .${src} file is ${size} bytes, more than the ${MAX_BOOK_BYTES} bytes that can be converted.`);
  const staged = path.join(dir, `${BOOK_NAME}.${src}`);
  if (src === EPUB_FORMAT) {
    await repackEpub(readRawInputBuffer(input), staged);
  } else if (!Buffer.isBuffer(input) && !input.inputBuffer && input.inputPath) {
    fs.copyFileSync(input.inputPath, staged);
  } else {
    fs.writeFileSync(staged, readRawInputBuffer(input));
  }
  return staged;
}

/** Writes the source as EPUB with the project's converters and puts it in the job directory. */
async function stageEpubOfSource(deps: CalibreDeps, request: CalibreRequest, dir: string): Promise<string> {
  const { input, src, options, originalFilename } = request;
  const source: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? input : { ...input, outputPath: undefined };
  const epubOptions = { ...options, outputPath: undefined, inProcessFallback: undefined } as WorkerEngineOptions;
  const written = await deps.convert(source, src, EPUB_FORMAT, epubOptions, originalFilename);
  try {
    const staged = path.join(dir, `${BOOK_NAME}.${EPUB_FORMAT}`);
    fs.writeFileSync(staged, written.buffer);
    return staged;
  } finally {
    deps.discardOutput(written.filePath, input, options);
  }
}

/** Whether Windows-1252 holds every character of the text file, read in chunks so that a long book is never one string. */
function textFitsWindows1252(textPath: string): boolean {
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.allocUnsafe(TEXT_SCAN_CHUNK_BYTES);
  const descriptor = fs.openSync(textPath, 'r');
  try {
    for (let read = fs.readSync(descriptor, chunk, 0, chunk.length, null); read > 0; read = fs.readSync(descriptor, chunk, 0, chunk.length, null)) {
      if (!fitsWindows1252(decoder.write(chunk.subarray(0, read)))) return false;
    }
    return fitsWindows1252(decoder.end());
  } finally {
    fs.closeSync(descriptor);
  }
}

/** The encoding of a PalmDOC book: calibre's default code page when it holds the whole text, else UTF-8 (see the note on PDB above). */
async function pdbEncoding(program: string, bookPath: string, dir: string, environment: Record<string, string>, request: CalibreRequest): Promise<string> {
  const scanPath = path.join(dir, TEXT_SCAN_NAME);
  await runCalibre(program, [bookPath, scanPath], dir, environment, request);
  if (!fs.existsSync(scanPath)) throw new ConversionFailedError(`calibre wrote no text of the .${request.src} file.`);
  const fits = textFitsWindows1252(scanPath);
  fs.rmSync(scanPath, { force: true });
  return fits ? PDB_ENCODING_WINDOWS_1252 : PDB_ENCODING_UTF8;
}

function readHead(filePath: string, length: number): Buffer {
  const head = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    return head.subarray(0, fs.readSync(descriptor, head, 0, length, 0));
  } finally {
    fs.closeSync(descriptor);
  }
}

interface OebFile {
  name: string;
  size: number;
}

/** The files of the OEB folder calibre wrote; a link, a device, more files than the archive limit or more bytes than a document may inflate to is refused. */
function listOebFiles(root: string): OebFile[] {
  const files: OebFile[] = [];
  let totalBytes = 0;
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop() as string;
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const entryPath = relative === '' ? name : `${relative}/${name}`;
      const stat = fs.lstatSync(path.join(root, entryPath));
      if (stat.isDirectory()) pending.push(entryPath);
      else if (!stat.isFile()) throw new ConversionFailedError('calibre wrote an OEB folder that holds something other than files.');
      else files.push({ name: entryPath, size: stat.size });
      totalBytes += stat.isFile() ? stat.size : 0;
      if (files.length > MAX_OEB_FILES || totalBytes > MAX_OEB_BYTES) throw new PayloadLimitError('The OEB folder is larger than a converted document may be.');
    }
  }
  return files;
}

/** The ZIP entries of the OEB files, each file opened when the writer reaches it so that no more than one is open at a time. */
async function* oebZipEntries(root: string, files: readonly OebFile[]): AsyncGenerator<ZipEntryInput> {
  for (const { name, size } of files) {
    yield { name, data: fs.createReadStream(path.join(root, name)), declaredSize: size, method: 'auto' };
  }
}

/** Packs the OEB folder as one ZIP file and returns the path of the file. */
async function packOebFolder(folder: string, destination: string, src: string): Promise<string> {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new ConversionFailedError(`calibre wrote no OEB folder for the .${src} file.`);
  const files = listOebFiles(folder);
  if (!files.some((file) => OEB_PACKAGE_FILE.test(file.name))) throw new InvalidConversionOutputError(src, 'oeb');
  await writeZipFile(destination, oebZipEntries(folder, files));
  return destination;
}

/** Proves that the file calibre wrote is of the format asked for (the PalmDB type and creator, the LRF magic) before it is handed out. */
function assertOutputFormat(outputPath: string, src: string, tgt: string): void {
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new ConversionFailedError(`calibre wrote no .${tgt} file for the .${src} file.`);
  const signature = OUTPUT_SIGNATURES[tgt];
  if (signature === undefined) return;
  const head = readHead(outputPath, signature.offset + signature.bytes.length);
  if (!head.subarray(signature.offset).equals(signature.bytes)) throw new InvalidConversionOutputError(src, tgt);
}

function baseNameOf(originalFilename: string): string {
  return originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Writes the source as MOBI, AZW3, PDB, LRF or OEB with calibre. `program` is the `ebook-convert` the worker found, or null
 * when it is not installed: the pair then fails with an unavailable engine, before the source is read.
 */
export async function convertWithCalibre(deps: CalibreDeps, request: CalibreRequest, program: string | null): Promise<WorkerConversionResult> {
  const { input, src, tgt, options, originalFilename } = request;
  if (program === null) throw calibreEngineUnavailable('ebook-convert (calibre) is not installed or not in PATH');
  const startTime = Date.now();
  return withSandboxDir(TEMP_PREFIX, async (dir) => {
    const environment = calibreEnvironment(dir);
    const bookPath = CALIBRE_NATIVE_SOURCES.has(src) ? await stageNativeBook(input, src, dir) : await stageEpubOfSource(deps, request, dir);
    const outputPath = path.join(dir, `${OUTPUT_NAME}.${tgt}`);
    const targetArguments = [...TARGET_ARGUMENTS[tgt]];
    if (tgt === 'pdb') targetArguments.push('--pdb-output-encoding', await pdbEncoding(program, bookPath, dir, environment, request));
    await runCalibre(program, [bookPath, outputPath, ...targetArguments], dir, environment, request);
    const packed = tgt === 'oeb' ? await packOebFolder(outputPath, path.join(dir, `${OUTPUT_NAME}.zip`), src) : outputPath;
    assertOutputFormat(packed, src, tgt);
    const persistedPath = handOffOutput(packed, tgt, options, Buffer.isBuffer(input) ? undefined : input);
    const result = createConversionResult(persistedPath, tgt, baseNameOf(originalFilename), 'native-calibre', Date.now() - startTime);
    if (tgt === 'oeb') result.mimeType = OEB_MIME_TYPE;
    return result;
  });
}
