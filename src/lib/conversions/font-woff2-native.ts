import fs from 'node:fs';
import path from 'node:path';
import { CpuTaskTimeoutError, type ConversionOptions } from '../types';
import {
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  cleanupWorkerSandboxDir,
  createWorkerSandboxDir,
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
} from '../../worker/sandbox';
import { CPU_POOL_TASK_TIMEOUT_MS } from '../workers/cpu-pool';
import { stageTimeoutMs } from './job-time';
import { WOFF2_MAX_DECODED_BYTES, Woff2FormatError, Woff2LimitError } from './font-woff2-primitives';

/**
 * `woff2_compress` of google/woff2 (MIT), built from the pinned source by scripts/install-woff2.sh, writes the WOFF2 file of an sfnt
 * font. It runs as a separate process in the worker sandbox (no network, a time, memory, file-size and diagnostics limit) on a file
 * only this run can read. Its absence is not an error: the in-process encoder (font-woff2.ts) answers on a machine without it, and for
 * a font it declines. (The decoder program is not used: the in-process reader is faster than the program at every size, because
 * the program pays for a process and two files, docs/policy-decisions.md entry 173.)
 *
 * A run that is declined (exit status 1, which is how the program refuses a font) returns null, and so does a program that is not
 * installed or cannot start: the caller then asks the in-process encoder, which names the reason in a typed error. A run that the
 * sandbox stops, or that the program does not survive, is an answer: the font is refused with a typed error rather than handed to a
 * second encoder.
 */

const COMPRESS_NAME = 'woff2_compress';
const COMPRESS_PATH_VARIABLE = 'WOFF2_COMPRESS_PATH';
/** Where scripts/install-woff2.sh links the program. */
const INSTALL_DIR = '/usr/local/bin';

/** The program names its result after its input: `input.ttf` becomes `input.woff2`. */
const SFNT_INPUT_NAME = 'input.ttf';
const SFNT_OUTPUT_NAME = 'input.woff2';

const PROGRAM_MEMORY_LIMIT_MB = 2048;
const PROGRAM_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
/** A WOFF2 file is never larger than the table data it carries plus a directory, so the same bound holds for the file written. */
const PROGRAM_MAX_OUTPUT_BYTES = WOFF2_MAX_DECODED_BYTES + 1024 * 1024;
const COMPRESS_TASK = 'WOFF2 encoder';

/**
 * The program the variable names, or the one the install script linked into /usr/local/bin; null when there is none (a variable that
 * names no file counts as not installed). The directories of the system and of the package managers are not searched: the 1.0.2
 * release that they carry is of 2017 and drops the overlap bit of a glyph (the flag of overlapping contours that the overlapSimple
 * bitmap carries, added to the source in 2022), so a font would change with the machine the worker ran on.
 */
function installedProgram(variable: string, name: string): string | null {
  const custom = process.env[variable];
  const program = custom ?? path.join(INSTALL_DIR, name);
  return program !== '' && fs.existsSync(program) ? program : null;
}

export function woff2CompressProgram(): string | null {
  return installedProgram(COMPRESS_PATH_VARIABLE, COMPRESS_NAME);
}

interface NativeRun {
  binary: string;
  task: string;
  what: string;
  inputName: string;
  outputName: string;
}

function limitError(run: NativeRun, detail: string): Woff2LimitError {
  return new Woff2LimitError(`${run.what} ${detail}`);
}

/** What a failed run is reported as: null for a run the program declined or could not start, a typed error for the rest. */
function failureOf(error: unknown, run: NativeRun, timeoutMs: number): Error | null {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError(run.task, timeoutMs);
  // The sandbox reports SIGSEGV and SIGKILL of a memory-limited process as a memory error: a C++ program that cannot make an allocation
  // faults, and a crash looks the same, so the message says both.
  if (error instanceof SandboxedMemoryLimitError) return limitError(run, `made the ${run.task} run out of memory (limit ${PROGRAM_MEMORY_LIMIT_MB} MB) or crash.`);
  if (error instanceof SandboxedBufferLimitError) {
    return error.kind === 'file-size'
      ? limitError(run, `makes more than the ${PROGRAM_MAX_OUTPUT_BYTES} bytes the ${run.task} may write.`)
      : new Woff2FormatError(`The ${run.task} printed more diagnostics than the limit allows.`);
  }
  if (error instanceof SandboxedProcessError) {
    if (error.signal !== null) return new Woff2FormatError(`The ${run.task} was stopped by ${error.signal}.`);
    return null;
  }
  throw error;
}

/** Runs one program on `input` in a scratch directory and returns the file it wrote, or null when it declined or is not installed. */
async function runProgram(run: NativeRun, input: Buffer, extraArgs: string[], options: Pick<ConversionOptions, 'signal' | 'timeoutMs'>): Promise<Buffer | null> {
  const timeoutMs = stageTimeoutMs(options, CPU_POOL_TASK_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, run.inputName);
    const outputPath = path.join(sandboxDir, run.outputName);
    fs.writeFileSync(inputPath, input, { mode: 0o600 });
    try {
      await executeSandboxedBinary(run.binary, [inputPath, ...extraArgs], {
        cwd: sandboxDir,
        env: { HOME: sandboxDir, TMPDIR: sandboxDir, TMP: sandboxDir, TEMP: sandboxDir },
        timeoutMs,
        maxBuffer: PROGRAM_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: PROGRAM_MAX_OUTPUT_BYTES,
        memoryLimitMb: PROGRAM_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = failureOf(error, run, timeoutMs);
      if (failure !== null) throw failure;
      return null;
    }
    if (!fs.existsSync(outputPath)) return null;
    const size = fs.statSync(outputPath).size;
    if (size === 0) return null;
    if (size >= PROGRAM_MAX_OUTPUT_BYTES) throw limitError(run, `makes more than the ${PROGRAM_MAX_OUTPUT_BYTES} bytes the ${run.task} may write.`);
    return fs.readFileSync(outputPath);
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

/** The WOFF2 file of an sfnt font at the given Brotli quality (0 to 11), or null when `woff2_compress` is not installed or declined the font. */
export async function compressWithNativeWoff2(sfnt: Buffer, quality: number, options: Pick<ConversionOptions, 'signal' | 'timeoutMs'> = {}): Promise<Buffer | null> {
  const binary = woff2CompressProgram();
  if (binary === null) return null;
  return runProgram({ binary, task: COMPRESS_TASK, what: 'The font', inputName: SFNT_INPUT_NAME, outputName: SFNT_OUTPUT_NAME }, sfnt, [String(quality)], options);
}
