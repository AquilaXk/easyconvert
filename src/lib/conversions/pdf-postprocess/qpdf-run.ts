import { recordEngineOutput } from '../../engine-output';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineUnavailableError, InvalidPageRangeError, PdfPostprocessError } from '../../types';
import {
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  type SandboxedExecutionResult,
} from '../../security/process-sandbox';
import { readSandboxResult, SandboxOutputMissingError } from '../../security/sandbox-output';
import { getQpdfBinaryPath } from './qpdf-path';
import { launchQpdf } from './qpdf-runner';
import { PAGE_TREE_LOOP_MESSAGE, reportsPageTreeLoop } from './page-tree-loop';

/**
 * One qpdf run on a PDF held in memory, shared by the PDF page operations, protection and the edit gate.
 *
 * The PDF is written once into a private (0700) directory and qpdf writes its result to standard output, so nothing
 * but the input exists on disk: no output copy to create, read back and remove, and no wrapper process, because the
 * output limit is the stdout buffer instead of a file size limit. Secrets (an argument file with passwords) go in
 * through standard input and never touch the disk.
 */

/** Longest qpdf may spend on one run; a hostile document cannot hold a job beyond it. */
export const QPDF_RUN_TIMEOUT_MS = 60_000;
export const QPDF_MEMORY_LIMIT_MB = 512;
/** qpdf rewrites a document into one of about its own size; the output cap is this multiple of the input (with a floor). */
const QPDF_OUTPUT_SIZE_FACTOR = 4;
const QPDF_MIN_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Stderr and a part of stdout that is not the document share the buffer; this much is kept for diagnostics. */
const QPDF_STDERR_SLACK_BYTES = 1024 * 1024;
/** qpdf's message for a page number past the end: `... number 9 out of range`. */
const OUT_OF_RANGE_PATTERN = /number (\d+) out of range/;

/**
 * A document of this size or more is written by qpdf to a file of the workspace directory, and read back from it, instead of being printed on standard
 * output. qpdf prints to standard output without a buffer (one `write` per token, 2,511 of them for a 445 KB result), and each write into a pipe wakes
 * the reader: 2.2 ms of a 445 KB result on the benchmark VM against 0.4 ms for a file, which qpdf writes in blocks of 4 KB. Below this size the few
 * writes cost less than the directory and the file (entry 391).
 */
export const QPDF_OUTPUT_FILE_MIN_BYTES = 64 * 1024;

/** How qpdf writes the PDFs a user keeps: streams deflated and the objects packed into object streams, its smallest ordinary output. */
export const QPDF_COMPACT_OUTPUT_ARGS: readonly string[] = ['--object-streams=generate', '--compress-streams=y'];

export interface QpdfWorkspace {
  qpdf: string;
  /** The working directory of qpdf: a private directory of its own for `withQpdfWorkspace`, the temp directory for `withQpdfInputFile`. */
  dir: string;
  /** The input PDF, written once. */
  inputPath: string;
  /** Most bytes one run of this workspace may print. */
  maxOutputBytes: number;
  /** Size of the input PDF; a run that prints the document prints about this much. */
  inputBytes: number;
  /** The files a run of this workspace may touch: its private directory, or for an input file in the temp directory that file alone and no directory. */
  files: { workDir: string | null; readDirs: string[] };
}

export function requireQpdfBinary(): string {
  const qpdf = getQpdfBinaryPath();
  if (!qpdf) {
    throw new EngineUnavailableError('qpdf', 'qpdf binary is not installed or not in PATH');
  }
  return qpdf;
}

function maxOutputBytesFor(pdf: Buffer): number {
  return Math.max(pdf.length * QPDF_OUTPUT_SIZE_FACTOR, QPDF_MIN_OUTPUT_BYTES);
}

/** Runs `operation` with `pdf` written to a private directory that is removed when it settles, whatever the outcome. */
export async function withQpdfWorkspace<T>(pdf: Buffer, operation: (workspace: QpdfWorkspace) => Promise<T>): Promise<T> {
  const qpdf = requireQpdfBinary();
  // mkdtemp creates the directory exclusively, with a random name, readable by this user only.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-qpdf_'));
  try {
    const inputPath = path.join(dir, 'input.pdf');
    fs.writeFileSync(inputPath, pdf, { mode: 0o600 });
    return await operation({ qpdf, dir, inputPath, maxOutputBytes: maxOutputBytesFor(pdf), inputBytes: pdf.length, files: { workDir: dir, readDirs: [] } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Like withQpdfWorkspace for a run that prints its result on standard output and so needs no directory: the input is one
 * file with an unguessable name, created exclusively and readable by this user only, and removed when the run settles.
 */
export async function withQpdfInputFile<T>(pdf: Buffer, operation: (workspace: QpdfWorkspace) => Promise<T>): Promise<T> {
  const qpdf = requireQpdfBinary();
  const dir = os.tmpdir();
  const inputPath = path.join(dir, `easyconvert-qpdf_${crypto.randomUUID()}.pdf`);
  const fd = fs.openSync(inputPath, 'wx', 0o600);
  try {
    try {
      fs.writeSync(fd, pdf);
    } finally {
      fs.closeSync(fd);
    }
    return await operation({ qpdf, dir, inputPath, maxOutputBytes: maxOutputBytesFor(pdf), inputBytes: pdf.length, files: { workDir: null, readDirs: [inputPath] } });
  } finally {
    fs.rmSync(inputPath, { force: true });
  }
}

/** Maps a qpdf failure to the typed error of this layer; the message never carries a path of the sandbox. */
export function toQpdfError(error: unknown, action: string): unknown {
  if (error instanceof SandboxedBufferLimitError) {
    return new PdfPostprocessError(`${action} failed: the result exceeds the allowed size.`);
  }
  if (error instanceof SandboxedMemoryLimitError) {
    return new PdfPostprocessError(`${action} failed: the document exceeds the ${QPDF_MEMORY_LIMIT_MB} MB memory limit.`);
  }
  if (error instanceof SandboxedTimeoutError) {
    // The limit of the run: the default, or the time that was left to the deadline of the job.
    return new PdfPostprocessError(`${action} failed: it took longer than ${Math.ceil(error.timeoutMs / 1000)} seconds.`);
  }
  if (!(error instanceof SandboxedProcessError)) return error;
  const outOfRange = OUT_OF_RANGE_PATTERN.exec(error.stderr);
  if (outOfRange) {
    return new InvalidPageRangeError(`Page ${outOfRange[1]} is out of range: the document has fewer pages.`);
  }
  if (reportsPageTreeLoop(error.stderr)) return new PdfPostprocessError(`${action} failed: qpdf could not process the document (${PAGE_TREE_LOOP_MESSAGE}).`);
  recordEngineOutput('qpdf', action, error.stderr);
  return new PdfPostprocessError(`${action} failed: qpdf could not process the document.`);
}

/** What stops a qpdf run: the signal of the job (cancel, takeover, deadline) and the time limit of the run. */
export interface QpdfRunLimits {
  signal?: AbortSignal;
  /** `QPDF_RUN_TIMEOUT_MS` when omitted. A run that must end by the deadline of a job is given the time left to it. */
  timeoutMs?: number;
}

export interface QpdfInvocation extends QpdfRunLimits {
  args: string[];
  /** Standard input of qpdf: an argument file (`@-`) or a password (`--password-file=-`). */
  stdin?: Buffer;
  /** Names the failure: `Splitting the PDF`. */
  action: string;
  /** The working directory; defaults to the workspace directory. */
  cwd?: string;
  /** About how many bytes qpdf prints: nothing for a run that writes files, about the document for one that prints it. */
  expectedOutputBytes?: number;
  /** The most bytes qpdf may write to a file of its own (RLIMIT_FSIZE); none when omitted. */
  maxFileSize?: number;
}

/** An invocation whose document `runQpdfToBuffer` collects: the arguments and the argument file are given the place the document goes to. */
export interface QpdfBufferInvocation extends Omit<QpdfInvocation, 'args' | 'stdin' | 'expectedOutputBytes' | 'maxFileSize'> {
  /** The arguments of the run, with `output` where qpdf is told where to write (`-` for standard output, or the path of a file). */
  args: (output: string) => string[];
  /** Standard input of qpdf, when it holds the output too (an argument file). */
  stdin?: (output: string) => Buffer;
}

/** Runs qpdf in the workspace and returns what it prints; `--warning-exit-0` is added, as a recovered document is a result. */
export async function runQpdf(workspace: QpdfWorkspace, invocation: QpdfInvocation): Promise<SandboxedExecutionResult> {
  try {
    return await launchQpdf(workspace.qpdf, ['--warning-exit-0', ...invocation.args], {
      cwd: invocation.cwd ?? workspace.dir,
      ...workspace.files,
      timeoutMs: invocation.timeoutMs ?? QPDF_RUN_TIMEOUT_MS,
      maxBuffer: workspace.maxOutputBytes + QPDF_STDERR_SLACK_BYTES,
      memoryLimitMb: QPDF_MEMORY_LIMIT_MB,
      networkIsolated: true,
      stdin: invocation.stdin,
      signal: invocation.signal,
      expectedOutputBytes: invocation.expectedOutputBytes ?? 0,
      maxFileSize: invocation.maxFileSize,
    });
  } catch (error) {
    throw toQpdfError(error, invocation.action);
  }
}

/**
 * `withQpdfWorkspace` for a document that qpdf writes to a file (see QPDF_OUTPUT_FILE_MIN_BYTES), `withQpdfInputFile` for a smaller one, which is
 * printed on standard output and needs no directory.
 */
export function withQpdfDocument<T>(pdf: Buffer, operation: (workspace: QpdfWorkspace) => Promise<T>): Promise<T> {
  return pdf.length >= QPDF_OUTPUT_FILE_MIN_BYTES ? withQpdfWorkspace(pdf, operation) : withQpdfInputFile(pdf, operation);
}

const QPDF_STDOUT = '-';

let outputCounter = 0;

/** The failure of a run that ended without a document, on standard output or in the file. */
const noOutput = (action: string): PdfPostprocessError => new PdfPostprocessError(`${action} failed: qpdf produced no output.`);

/**
 * Runs qpdf and returns the PDF it wrote; an empty result is a failure, never a document. The invocation is given where the document goes: standard
 * output, or a file of the workspace directory when the document is large (the file is removed again, whatever the outcome). The size of the
 * file is limited like the output on standard output.
 */
export async function runQpdfToBuffer(workspace: QpdfWorkspace, invocation: QpdfBufferInvocation): Promise<Buffer> {
  if (workspace.files.workDir === null || workspace.inputBytes < QPDF_OUTPUT_FILE_MIN_BYTES) {
    const { stdout } = await runQpdf(workspace, { ...invocation, args: invocation.args(QPDF_STDOUT), stdin: invocation.stdin?.(QPDF_STDOUT), expectedOutputBytes: workspace.inputBytes });
    if (stdout.length === 0) throw noOutput(invocation.action);
    return stdout;
  }
  const outputPath = path.join(workspace.dir, `output-${outputCounter++}.pdf`);
  try {
    await runQpdf(workspace, { ...invocation, args: invocation.args(outputPath), stdin: invocation.stdin?.(outputPath), maxFileSize: workspace.maxOutputBytes });
    // One descriptor, judged: a link or a pipe left by the program is refused and cannot block the worker, a file past the cap is not read.
    const document = readSandboxResult(outputPath, workspace.maxOutputBytes);
    if (document.length === 0) throw noOutput(invocation.action);
    return document;
  } catch (error) {
    throw error instanceof SandboxOutputMissingError ? noOutput(invocation.action) : toQpdfError(error, invocation.action);
  } finally {
    // Recursive: the program may leave a directory here, which a plain remove refuses and so would hide the error of the read. A link is removed, never followed.
    fs.rmSync(outputPath, { force: true, recursive: true });
  }
}
