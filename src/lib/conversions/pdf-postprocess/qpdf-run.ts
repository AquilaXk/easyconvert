import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineUnavailableError, InvalidPageRangeError, PdfPostprocessError } from '../../types';
import {
  SandboxedBufferLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  type SandboxedExecutionResult,
} from '../../security/process-sandbox';
import { executeSandboxedBinary } from '../../../worker/sandbox';
import { getQpdfBinaryPath } from './qpdf-path';

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
/** qpdf rewrites a document into one of about its own size; the output cap is this multiple of the input (with a floor). */
const QPDF_OUTPUT_SIZE_FACTOR = 4;
const QPDF_MIN_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Stderr and a part of stdout that is not the document share the buffer; this much is kept for diagnostics. */
const QPDF_STDERR_SLACK_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 300;
/** qpdf's message for a page number past the end: `... number 9 out of range`. */
const OUT_OF_RANGE_PATTERN = /number (\d+) out of range/;

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
    return await operation({ qpdf, dir, inputPath, maxOutputBytes: maxOutputBytesFor(pdf) });
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
    return await operation({ qpdf, dir, inputPath, maxOutputBytes: maxOutputBytesFor(pdf) });
  } finally {
    fs.rmSync(inputPath, { force: true });
  }
}

/** Maps a qpdf failure to the typed error of this layer; the message never carries a path of the sandbox. */
export function toQpdfError(error: unknown, workspace: Pick<QpdfWorkspace, 'dir' | 'inputPath'>, action: string): unknown {
  if (error instanceof SandboxedBufferLimitError) {
    return new PdfPostprocessError(`${action} failed: the result exceeds the allowed size.`);
  }
  if (error instanceof SandboxedTimeoutError) {
    return new PdfPostprocessError(`${action} failed: it took longer than ${QPDF_RUN_TIMEOUT_MS / 1000} seconds.`);
  }
  if (!(error instanceof SandboxedProcessError)) return error;
  const outOfRange = OUT_OF_RANGE_PATTERN.exec(error.stderr);
  if (outOfRange) {
    return new InvalidPageRangeError(`Page ${outOfRange[1]} is out of range: the document has fewer pages.`);
  }
  const detail = error.stderr.replaceAll(workspace.inputPath, '<input>').replaceAll(workspace.dir, '<tmp>').trim().split('\n')[0]?.slice(0, MAX_DIAGNOSTIC_CHARS) ?? '';
  const reason = detail ? ` (${detail})` : '';
  return new PdfPostprocessError(`${action} failed: qpdf could not process the document${reason}.`);
}

export interface QpdfInvocation {
  args: string[];
  /** Standard input of qpdf: an argument file (`@-`) or a password (`--password-file=-`). */
  stdin?: Buffer;
  /** Names the failure: `Splitting the PDF`. */
  action: string;
  /** The working directory; defaults to the workspace directory. */
  cwd?: string;
  signal?: AbortSignal;
}

/** Runs qpdf in the workspace and returns what it prints; `--warning-exit-0` is added, as a recovered document is a result. */
export async function runQpdf(workspace: QpdfWorkspace, invocation: QpdfInvocation): Promise<SandboxedExecutionResult> {
  try {
    return await executeSandboxedBinary(workspace.qpdf, ['--warning-exit-0', ...invocation.args], {
      cwd: invocation.cwd ?? workspace.dir,
      timeoutMs: QPDF_RUN_TIMEOUT_MS,
      maxBuffer: workspace.maxOutputBytes + QPDF_STDERR_SLACK_BYTES,
      networkIsolated: true,
      stdin: invocation.stdin,
      signal: invocation.signal,
    });
  } catch (error) {
    throw toQpdfError(error, workspace, invocation.action);
  }
}

/** Runs qpdf and returns the PDF it wrote to standard output; an empty result is a failure, never a document. */
export async function runQpdfToBuffer(workspace: QpdfWorkspace, invocation: QpdfInvocation): Promise<Buffer> {
  const { stdout } = await runQpdf(workspace, invocation);
  if (stdout.length === 0) {
    throw new PdfPostprocessError(`${invocation.action} failed: qpdf produced no output.`);
  }
  return stdout;
}
