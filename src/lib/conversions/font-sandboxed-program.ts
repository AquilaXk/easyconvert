import fs from 'node:fs';
import path from 'node:path';
import { CpuTaskTimeoutError, EngineUnavailableError, UnprocessableFontInputError, type ConversionOptions } from '../types';
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
import { stageTimeoutMs, type JobDeadlined } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';

/**
 * A command-line font reader that runs as a separate program in the worker sandbox: the font goes in as a file of the scratch directory, the
 * program writes another file, and nothing of the uploaded file is ever part of a command. The programs are FontForge (PostScript Type 1
 * input) and libeot's `eot2ttf` (MicroType Express compressed EOT input); both are bounded the same way, in time, memory, output size and
 * diagnostic size, and a missing program is an error, never an estimate.
 */

export interface FontProgramSpec {
  /** The executable name, also the engine name of the typed engine-unavailable error. */
  readonly name: string;
  /** How the program is called in messages. */
  readonly label: string;
  /** The environment variable that fixes its path. */
  readonly pathVariable: string;
  readonly candidates: readonly string[];
  readonly notInstalled: string;
  /** A font reads in well under a second; the job's own deadline can shorten this. */
  readonly defaultTimeoutMs: number;
}

export interface FontProgramRun {
  readonly input: Buffer;
  readonly inputFile: string;
  readonly outputFile: string;
  /** The arguments after the program name, given the paths of the input and output files in the scratch directory. */
  readonly args: (inputPath: string, outputPath: string) => string[];
}

export type FontProgramOptions = Pick<ConversionOptions, 'signal' | 'timeoutMs'> & JobDeadlined;

const PROGRAM_MEMORY_LIMIT_MB = 1024;
export const FONT_PROGRAM_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const PROGRAM_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_DETAIL_CHARS = 200;
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const UNPRINTABLE = /[^\x20-\x7e]/g;
export const SFNT_HEADER_BYTES = 12;
const SFNT_RECORD_BYTES = 16;
const SFNT_TABLE_COUNT_OFFSET = 4;
const MAXP_GLYPH_COUNT_OFFSET = 4;

function programBinary(spec: FontProgramSpec): string {
  const binary = resolveBinaryPath(spec.pathVariable, [...spec.candidates], spec.name);
  if (binary === null) throw new EngineUnavailableError(spec.name, spec.notInstalled);
  return binary;
}

/** The last line the program printed, with the scratch directory and every unprintable character removed. */
function diagnostic(stderr: string, sandboxDir: string): string {
  const lines = stderr.replaceAll(sandboxDir, '<tmp>').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const last = lines.at(-1);
  return last === undefined ? '' : ` (${last.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function toProgramError(spec: FontProgramSpec, error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError(spec.label, timeoutMs);
  // The sandbox reports a signal SIGSEGV, SIGABRT or SIGKILL of a memory-limited process as a memory error: running out of the limit
  // and crashing on a damaged font look the same to it, and the message says both.
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableFontInputError(`${spec.label} ran out of memory or crashed on this font.`);
  if (error instanceof SandboxedBufferLimitError) {
    // The sandbox reports a file that grew past its size limit (SIGXFSZ) with the same error as too much diagnostic output; the limit tells them apart.
    if (error.limitBytes === FONT_PROGRAM_MAX_OUTPUT_BYTES) return new UnprocessableFontInputError(`The font is larger than ${spec.label} may write.`);
    return new UnprocessableFontInputError(`${spec.label} printed more diagnostics than the limit allows: the font is damaged.`);
  }
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(spec.name, `${spec.label} could not be started`);
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return new UnprocessableFontInputError(`${spec.label} could not convert this font: it ${how}${diagnostic(error.stderr, sandboxDir)}.`);
  }
  return error;
}

/**
 * Runs the program on the input file and returns the file it wrote. Fails with a typed 422 for a font the program cannot read, one that makes
 * it crash or run out of memory, and one that writes nothing, an empty file or a file past the output limit; a typed timeout when it overruns
 * its time; and an engine-unavailable error (503, retried on another worker) when the program is missing.
 */
export async function runFontProgram(spec: FontProgramSpec, run: FontProgramRun, options: FontProgramOptions): Promise<Buffer> {
  const binary = programBinary(spec);
  const timeoutMs = stageTimeoutMs(options, spec.defaultTimeoutMs);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, run.inputFile);
    const outputPath = path.join(sandboxDir, run.outputFile);
    fs.writeFileSync(inputPath, run.input, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, run.args(inputPath, outputPath), {
        cwd: sandboxDir,
        // The scratch directory is also where the program puts anything it writes to a temporary file, as the other sandboxed programs do.
        env: { HOME: sandboxDir, TMPDIR: sandboxDir, TMP: sandboxDir, TEMP: sandboxDir },
        timeoutMs,
        maxBuffer: PROGRAM_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: FONT_PROGRAM_MAX_OUTPUT_BYTES,
        memoryLimitMb: PROGRAM_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      throw toProgramError(spec, error, sandboxDir, timeoutMs);
    }
    if (!fs.existsSync(outputPath)) throw new UnprocessableFontInputError(`${spec.label} wrote no font from this file.`);
    const size = fs.statSync(outputPath).size;
    if (size === 0) throw new UnprocessableFontInputError(`${spec.label} wrote an empty file.`);
    if (size >= FONT_PROGRAM_MAX_OUTPUT_BYTES) throw new UnprocessableFontInputError(`The font is larger than ${spec.label} may write.`);
    return fs.readFileSync(outputPath);
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

/** The glyph count in the 'maxp' table of an OpenType file, or null when the file has no such table. */
export function sfntGlyphCount(sfnt: Buffer): number | null {
  if (sfnt.length < SFNT_HEADER_BYTES) return null;
  const tables = sfnt.readUInt16BE(SFNT_TABLE_COUNT_OFFSET);
  for (let index = 0; index < tables; index++) {
    const record = SFNT_HEADER_BYTES + index * SFNT_RECORD_BYTES;
    if (record + SFNT_RECORD_BYTES > sfnt.length) return null;
    if (sfnt.toString('latin1', record, record + 4) === 'maxp') {
      const offset = sfnt.readUInt32BE(record + 8);
      return offset + MAXP_GLYPH_COUNT_OFFSET + 2 <= sfnt.length ? sfnt.readUInt16BE(offset + MAXP_GLYPH_COUNT_OFFSET) : null;
    }
  }
  return null;
}
