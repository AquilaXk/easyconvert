import fs from 'node:fs';
import path from 'node:path';
import { pandocEngineUnavailable, pandocReader, pandocWriter } from '../lib/conversions/pandoc-pairs';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { safeOutputStem } from '../lib/conversions/page-range';
import { sourceBytesAsText } from '../lib/conversions/office/text-source';
import { endOfRun, recordEngineOutput } from '../lib/engine-output';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { OUTPUT_READ_FLAGS, sandboxOutputSize } from '../lib/security/sandbox-output';
import { ConversionFailedError, CpuTaskTimeoutError, InvalidConversionOutputError, PayloadLimitError } from '../lib/types';
import { rethrowSandboxUnavailable, SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from './sandbox';
import { createConversionResult, handOffOutput, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/**
 * Markdown, plain text and HTML to LaTeX, and Markdown to reStructuredText, written by pandoc 3.1.11 (GPL-2.0-or-later, the pinned
 * release program run unmodified as a separate sandboxed process; nothing of pandoc is copied or linked). The reference converts the
 * same pairs with the same version; its formats list gives no option for HTML or plain text and the Markdown flavour only for Markdown,
 * so the program runs with its defaults: `--from markdown` for Markdown and plain text (pandoc reads a `.txt` file as Markdown), `--from
 * html`, `--to latex` or `--to rst`, a fragment and not a standalone document (pandoc makes a LaTeX file standalone only when told to).
 *
 * `--sandbox` makes pandoc read no file and fetch nothing but the input it is handed (an `include`, an image or a `\input` is not followed
 * and a resource is never downloaded). The program runs with no network, a configuration, home and temporary directory of the job (so no
 * user data directory or earlier job reaches it), the address space, output and time limits of the other native programs, and the
 * process group is killed on a timeout or an abort. The source is read here as the other text routes read it (UTF-8, or UTF-16 with a byte
 * order mark; a container or a null byte is refused) and handed over as UTF-8, which is all pandoc reads.
 */

const TEMP_PREFIX = 'easyconvert-pandoc-';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** The Haskell runtime of the release program starts and converts a long book within 1 GiB of address space (measured); the limit is generous. */
const MEMORY_LIMIT_MB = 2048;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
/** Pandoc prints nothing on standard output when it writes to a file. */
const EXPECTED_PIPED_OUTPUT_BYTES = 4 * 1024;
/** Largest source handed to pandoc: its Markdown parser is not linear on every input, and a longer text has a longer time to run than the limit allows. */
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const SOURCE_NAME = 'source.txt';
const OUTPUT_NAME = 'converted';
const NUL_SCAN_BYTES = 64 * 1024;

export interface PandocRequest {
  input: Buffer | WorkerVfsPayload;
  src: string;
  tgt: string;
  options: WorkerEngineOptions;
  originalFilename: string;
}

function baseNameOf(originalFilename: string): string {
  return safeOutputStem(originalFilename);
}

/** The directories and settings pandoc gets: all inside the job directory, so no data directory of the host or of another job reaches it. */
function pandocEnvironment(dir: string): Record<string, string> {
  const home = path.join(dir, 'home');
  const temp = path.join(dir, 'tmp');
  for (const created of [home, temp]) fs.mkdirSync(created, { mode: 0o700 });
  return { HOME: home, TMPDIR: temp, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: temp, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}

/** The typed error of a run that failed: its limits, or what pandoc printed about the source. */
function toPandocError(err: unknown, request: PandocRequest, limitMs: number): unknown {
  const { src, tgt } = request;
  if (err instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError(`.${src} to .${tgt} conversion`, limitMs);
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`pandoc exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) {
    recordEngineOutput('pandoc', `${src}-to-${tgt}`, err.stderr);
    return new ConversionFailedError(`pandoc could not convert the .${src} file to .${tgt}: ${endOfRun(err)}.`);
  }
  return err;
}

/** Decodes the source the way the other text routes do and writes it as UTF-8 in the job directory. */
function stageSource(input: Buffer | WorkerVfsPayload, src: string, dir: string): string {
  const bytes = readRawInputBuffer(input);
  if (bytes.length > MAX_SOURCE_BYTES) throw new PayloadLimitError(`The .${src} file is ${bytes.length} bytes, more than the ${MAX_SOURCE_BYTES} bytes that can be converted.`);
  const staged = path.join(dir, SOURCE_NAME);
  fs.writeFileSync(staged, sourceBytesAsText(bytes, src), 'utf-8');
  return staged;
}

/** The first bytes of the file pandoc wrote: LaTeX and reStructuredText are text, so a NUL byte is not what the program writes. */
function assertTextOutput(outputPath: string, src: string, tgt: string): void {
  const size = sandboxOutputSize(outputPath);
  if (size === null) throw new ConversionFailedError(`pandoc wrote no .${tgt} file for the .${src} file.`);
  const head = Buffer.alloc(Math.min(NUL_SCAN_BYTES, size));
  const descriptor = fs.openSync(outputPath, OUTPUT_READ_FLAGS);
  try {
    fs.readSync(descriptor, head, 0, head.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (head.includes(0)) throw new InvalidConversionOutputError(src, tgt);
}

/**
 * Writes the source as LaTeX or reStructuredText with pandoc. The declared source format is checked against its bytes first (`assertNotSpoofed`).
 * `program` is the pandoc the worker found, or null when it is not installed: the pair then fails with an unavailable engine, before the source is
 * read.
 */
export async function convertWithPandoc(request: PandocRequest, program: string | null, assertNotSpoofed: (input: Buffer | WorkerVfsPayload, src: string, filename: string) => void): Promise<WorkerConversionResult> {
  const { input, src, tgt, options, originalFilename } = request;
  assertNotSpoofed(input, src, originalFilename);
  if (program === null) throw pandocEngineUnavailable('pandoc is not installed or not in PATH');
  const startTime = Date.now();
  return withSandboxDir(TEMP_PREFIX, async (dir) => {
    const sourcePath = stageSource(input, src, dir);
    const outputPath = path.join(dir, `${OUTPUT_NAME}.${tgt}`);
    const limitMs = Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const limits: LaunchedExecutionOptions = {
      timeoutMs: limitMs,
      maxBuffer: MAX_STDERR_BYTES,
      maxFileSize: MAX_OUTPUT_BYTES,
      memoryLimitMb: MEMORY_LIMIT_MB,
      networkIsolated: true,
      signal: options.signal,
      cwd: dir,
      workDir: dir,
      env: pandocEnvironment(dir),
      expectedOutputBytes: EXPECTED_PIPED_OUTPUT_BYTES,
    };
    try {
      await launchSandboxedBinary(program, ['--sandbox', '--from', pandocReader(src), '--to', pandocWriter(tgt), '--output', outputPath, sourcePath], limits);
    } catch (err) {
      rethrowSandboxUnavailable(err);
      throw toPandocError(err, request, limitMs);
    }
    assertTextOutput(outputPath, src, tgt);
    const persistedPath = await handOffOutput(outputPath, tgt, options, Buffer.isBuffer(input) ? undefined : input);
    return createConversionResult(persistedPath, tgt, baseNameOf(originalFilename), 'native-pandoc', Date.now() - startTime);
  });
}
