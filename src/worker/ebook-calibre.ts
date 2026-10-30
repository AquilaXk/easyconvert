import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ARCHIVE_SECURITY_LIMITS } from '../lib/conversions/archive';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../lib/conversions/bounded-inflate';
import { calibreEngineUnavailable } from '../lib/conversions/calibre-ebook-targets';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { fitsWindows1252 } from '../lib/conversions/office/windows-1252';
import { writeZipFile, type ZipEntryInput } from '../lib/conversions/zip-writer';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import {
  ConversionFailedError,
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
 * The route: a source that calibre reads itself (an e-book of its own family) is handed over as it is; every other
 * source is first written as EPUB by this project's own converters (`CalibreDeps.convert`, the whole worker conversion
 * of the pair), which calibre reads best, and then converted. Calibre runs with a configuration, cache and temporary
 * directory of its own inside the job directory (so no plug-in, setting or earlier job reaches it), no network, the
 * address space, file size, output and time limits of the other native programs, and the process group is killed on a
 * timeout or an abort. The route has one deadline: a PDB book needs two runs, and the second gets the time the first left.
 * Its failure is a typed `ConversionFailedError`; a worker without the program answers with an unavailable engine and
 * never writes a file of its own.
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
 *    delivered as one ZIP file, named `<name>.zip` because that is what it is.
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
const ZIP_FORMAT = 'zip';
const TEXT_SCAN_CHUNK_BYTES = 1024 * 1024;
/** Largest e-book handed to calibre, as it is or as the EPUB of another source: the budget of one document everywhere else. */
const MAX_BOOK_BYTES = MAX_DOCUMENT_INFLATE_BYTES;
const MAX_OEB_FILES = ARCHIVE_SECURITY_LIMITS.MAX_FILES;
const MAX_OEB_BYTES = MAX_DOCUMENT_INFLATE_BYTES;
const DRM_PATTERN = /\bDRMError\b|protected by DRM/i;
const PDB_ENCODING_WINDOWS_1252 = 'cp1252';
const PDB_ENCODING_UTF8 = 'utf-8';

/** Sources calibre has an input plug-in for and that are handed to it unchanged: the Palm, Kindle and Sony families. */
const CALIBRE_NATIVE_SOURCES: ReadonlySet<string> = new Set(['mobi', 'azw', 'azw3', 'pdb', 'lrf']);

interface OutputSignature {
  offset: number;
  bytes: Buffer;
}
const PALMDB_TYPE_CREATOR_OFFSET = 60;
const MOBIPOCKET_SIGNATURE: OutputSignature = { offset: PALMDB_TYPE_CREATOR_OFFSET, bytes: Buffer.from('BOOKMOBI', 'latin1') };
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

/** What one conversion shares between its calibre runs: the program, the job directory, the environment, and the one deadline of the route. */
interface CalibreRun {
  program: string;
  dir: string;
  environment: Record<string, string>;
  request: CalibreRequest;
  limitMs: number;
  deadlineAt: number;
}

/** How a target is written: its options, what is decided from the book first, what is made of calibre's output, and what the file must start with. */
interface CalibreTarget {
  args: readonly string[];
  prepare?: (run: CalibreRun, bookPath: string) => Promise<readonly string[]>;
  finalize?: (outputPath: string, run: CalibreRun) => Promise<string>;
  /** The format of the delivered file, when it is not the target (the OEB folder is delivered as a ZIP). */
  deliveredAs?: string;
  signature?: OutputSignature;
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
  const last = stderr.replaceAll(dir, '<tmp>').trim().split('\n').at(-1)?.trim() ?? '';
  return last === '' ? '' : `: ${last.slice(0, MAX_STDERR_CHARS)}`;
}

/** The typed error of a run that failed: its limits, a protected book, or what calibre printed about the file. */
function toCalibreError(err: unknown, run: CalibreRun): unknown {
  const { src, tgt } = run.request;
  if (err instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError(`.${src} to .${tgt} conversion`, run.limitMs);
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`calibre exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) {
    if (DRM_PATTERN.test(err.stderr)) return new EncryptedOfficeDocumentError(`The .${src} book is protected by DRM and cannot be converted.`);
    return new ConversionFailedError(`calibre could not convert the .${src} file to .${tgt}${failureDetail(err.stderr, run.dir)}`);
  }
  return err;
}

/** One calibre run, held to the time the route has left; a route that has used all of its time starts no run. */
async function runCalibre(run: CalibreRun, args: readonly string[]): Promise<void> {
  const { request } = run;
  const remainingMs = run.deadlineAt - Date.now();
  if (remainingMs <= 0) throw new CpuTaskTimeoutError(`.${request.src} to .${request.tgt} conversion`, run.limitMs);
  const limits: LaunchedExecutionOptions = {
    timeoutMs: remainingMs,
    maxBuffer: request.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    memoryLimitMb: MEMORY_LIMIT_MB,
    networkIsolated: true,
    signal: request.options.signal,
    cwd: run.dir,
    env: run.environment,
    expectedOutputBytes: EXPECTED_PIPED_OUTPUT_BYTES,
  };
  try {
    await launchSandboxedBinary(run.program, [...args], limits);
  } catch (err) {
    rethrowSandboxUnavailable(err);
    throw toCalibreError(err, run);
  }
}

function inputSize(input: Buffer | WorkerVfsPayload): number {
  if (Buffer.isBuffer(input)) return input.length;
  if (input.inputBuffer) return input.inputBuffer.length;
  return input.inputPath ? fs.statSync(input.inputPath).size : 0;
}

function assertBookSize(size: number, src: string): void {
  if (size > MAX_BOOK_BYTES) throw new PayloadLimitError(`The .${src} file is ${size} bytes, more than the ${MAX_BOOK_BYTES} bytes that can be converted.`);
}

/** Puts the e-book calibre reads in the job directory under a name of its own (calibre picks its reader by the extension) and returns its path. */
function stageNativeBook(input: Buffer | WorkerVfsPayload, src: string, dir: string): string {
  assertBookSize(inputSize(input), src);
  const staged = path.join(dir, `${BOOK_NAME}.${src}`);
  if (!Buffer.isBuffer(input) && !input.inputBuffer && input.inputPath) fs.copyFileSync(input.inputPath, staged);
  else fs.writeFileSync(staged, readRawInputBuffer(input));
  return staged;
}

/** Writes the source as EPUB with the project's converters and puts it in the job directory, from the converter's file when it left one. */
async function stageEpubOfSource(deps: CalibreDeps, request: CalibreRequest, dir: string): Promise<string> {
  const { input, src, options, originalFilename } = request;
  const source: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? input : { ...input, outputPath: undefined };
  // The dispatcher fails the pair closed because the calibre target has no in-process writer; the EPUB of the first step has one, so the flag is cleared for it.
  const epubOptions = { ...options, outputPath: undefined, inProcessFallback: undefined } as WorkerEngineOptions;
  const written = await deps.convert(source, src, EPUB_FORMAT, epubOptions, originalFilename);
  try {
    assertBookSize(written.size, EPUB_FORMAT);
    const staged = path.join(dir, `${BOOK_NAME}.${EPUB_FORMAT}`);
    if (written.filePath) fs.copyFileSync(written.filePath, staged);
    else fs.writeFileSync(staged, written.buffer);
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

/** The encoding option of a PalmDOC book: calibre's default code page when it holds the whole text, else UTF-8 (see the note on PDB above). */
async function pdbEncodingArguments(run: CalibreRun, bookPath: string): Promise<readonly string[]> {
  const scanPath = path.join(run.dir, TEXT_SCAN_NAME);
  await runCalibre(run, [bookPath, scanPath]);
  if (!fs.existsSync(scanPath)) throw new ConversionFailedError(`calibre wrote no text of the .${run.request.src} file.`);
  const fits = textFitsWindows1252(scanPath);
  fs.rmSync(scanPath, { force: true });
  return ['--pdb-output-encoding', fits ? PDB_ENCODING_WINDOWS_1252 : PDB_ENCODING_UTF8];
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
    for (const name of fs.readdirSync(path.join(root, relative)).sort((a, b) => a.localeCompare(b))) {
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
function* oebZipEntries(root: string, files: readonly OebFile[]): Generator<ZipEntryInput> {
  for (const { name, size } of files) {
    yield { name, data: fs.createReadStream(path.join(root, name)), declaredSize: size, method: 'auto' };
  }
}

/** Packs the OEB folder as one ZIP file and returns the path of the file. */
async function packOebFolder(folder: string, run: CalibreRun): Promise<string> {
  const { src, tgt } = run.request;
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new ConversionFailedError(`calibre wrote no OEB folder for the .${src} file.`);
  const files = listOebFiles(folder);
  if (!files.some((file) => OEB_PACKAGE_FILE.test(file.name))) throw new InvalidConversionOutputError(src, tgt);
  const destination = path.join(run.dir, `${OUTPUT_NAME}.${ZIP_FORMAT}`);
  await writeZipFile(destination, oebZipEntries(folder, files));
  return destination;
}

/** Proves that the file calibre wrote is of the format asked for (the PalmDB type and creator, the LRF magic) before it is handed out. */
function assertOutputFormat(outputPath: string, src: string, tgt: string, signature: OutputSignature | undefined): void {
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new ConversionFailedError(`calibre wrote no .${tgt} file for the .${src} file.`);
  if (signature === undefined) return;
  const head = readHead(outputPath, signature.offset + signature.bytes.length);
  if (!head.subarray(signature.offset).equals(signature.bytes)) throw new InvalidConversionOutputError(src, tgt);
}

/**
 * The five targets. The PalmDB type and creator (bytes 60 to 67 of the Palm database header) of a Mobipocket book is `BOOKMOBI`,
 * of a PalmDOC book `TEXtREAd`; an LRF book starts with the UTF-16LE magic "LRF".
 */
const CALIBRE_TARGETS: Readonly<Record<string, CalibreTarget>> = {
  mobi: { args: ['--mobi-file-type', 'old', '--no-inline-toc'], signature: MOBIPOCKET_SIGNATURE },
  azw3: { args: ['--no-inline-toc'], signature: MOBIPOCKET_SIGNATURE },
  pdb: {
    args: ['--format', 'doc'],
    prepare: pdbEncodingArguments,
    signature: { offset: PALMDB_TYPE_CREATOR_OFFSET, bytes: Buffer.from('TEXtREAd', 'latin1') },
  },
  lrf: { args: [], signature: { offset: 0, bytes: Buffer.from([0x4c, 0x00, 0x52, 0x00, 0x46, 0x00, 0x00, 0x00]) } },
  oeb: { args: [], finalize: packOebFolder, deliveredAs: ZIP_FORMAT },
};

function baseNameOf(originalFilename: string): string {
  return originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Writes the source as MOBI, AZW3, PDB, LRF or OEB with calibre. `program` is the `ebook-convert` the worker found, or null
 * when it is not installed: the pair then fails with an unavailable engine, before the source is converted.
 */
export async function convertWithCalibre(deps: CalibreDeps, request: CalibreRequest, program: string | null): Promise<WorkerConversionResult> {
  const { input, src, tgt, options, originalFilename } = request;
  if (program === null) throw calibreEngineUnavailable('ebook-convert (calibre) is not installed or not in PATH');
  const target = CALIBRE_TARGETS[tgt];
  const startTime = Date.now();
  const limitMs = runTimeoutMs(options);
  return withSandboxDir(TEMP_PREFIX, async (dir) => {
    const run: CalibreRun = { program, dir, environment: calibreEnvironment(dir), request, limitMs, deadlineAt: startTime + limitMs };
    const bookPath = CALIBRE_NATIVE_SOURCES.has(src) ? stageNativeBook(input, src, dir) : await stageEpubOfSource(deps, request, dir);
    const outputPath = path.join(dir, `${OUTPUT_NAME}.${tgt}`);
    const extraArguments = (await target.prepare?.(run, bookPath)) ?? [];
    await runCalibre(run, [bookPath, outputPath, ...target.args, ...extraArguments]);
    const delivered = target.finalize ? await target.finalize(outputPath, run) : outputPath;
    assertOutputFormat(delivered, src, tgt, target.signature);
    const format = target.deliveredAs ?? tgt;
    const persistedPath = handOffOutput(delivered, format, options, Buffer.isBuffer(input) ? undefined : input);
    return createConversionResult(persistedPath, format, baseNameOf(originalFilename), 'native-calibre', Date.now() - startTime);
  });
}
