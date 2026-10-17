import fs from 'node:fs';
import path from 'node:path';
import {
  CpuTaskTimeoutError,
  EngineUnavailableError,
  UnprocessableCadInputError,
  type ConversionOptions,
} from '../types';
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
 * STEP and IGES input and output. The in-process engine has no B-rep kernel: `cad-convert` (native/cad-convert, our own
 * small program linked dynamically to the unmodified Open CASCADE libraries, LGPL-2.1 with the exception) reads the file
 * into the document model, writes STEP and IGES from the B-rep itself and meshes STL and OBJ from it, all in
 * millimetres. It runs as a separate process in the worker sandbox with a time, memory, file-size and network limit, and
 * its absence is an error: there is no other path that reads these files.
 */

/** Source formats the program reads, by the name it takes. */
const READABLE_SOURCES: Readonly<Record<string, 'step' | 'iges'>> = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges' };
/** Targets the program writes, by the name it takes. */
const WRITABLE_TARGETS: Readonly<Record<string, 'step' | 'iges' | 'stl' | 'obj'>> = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges', stl: 'stl', obj: 'obj' };

/** Media type of each target extension. */
export const OCCT_CONVERTER_MIME: Readonly<Record<string, string>> = {
  step: 'model/step',
  stp: 'model/step',
  iges: 'model/iges',
  igs: 'model/iges',
  stl: 'model/stl',
  obj: 'model/obj',
};

const PROGRAM_NAME = 'cad-convert';
const PROGRAM_PATH_VARIABLE = 'CAD_CONVERT_PATH';
const PROGRAM_CANDIDATES = ['/usr/local/bin/cad-convert', '/usr/bin/cad-convert', '/opt/homebrew/bin/cad-convert'];
/** One model may take this long; the job's own deadline can shorten it. Meshing and writing a large assembly is the slow part. */
const PROGRAM_DEFAULT_TIMEOUT_MS = 120_000;
/** The kernel holds the whole model and its mesh in memory. */
const PROGRAM_MEMORY_LIMIT_MB = 2048;
/** The largest output accepted. */
const PROGRAM_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const PROGRAM_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_DETAIL_CHARS = 200;
const SHELL_NOT_EXECUTABLE = 126;
const OUTPUT_TOO_LARGE = 'The model is larger than the CAD converter may write.';
const SHELL_NOT_FOUND = 127;
const UNPRINTABLE = /[^\x20-\x7e]/g;
const ERROR_LINE = /^cad-convert: error: (.*)$/m;
/** The error line of a program that ran out of memory: `memory` is its code. */
const MEMORY_ERROR_LINE = /^cad-convert: error: memory:/m;

/** Length units the program writes in, by the `outputUnit` option; millimetres when the request names none. */
const OUTPUT_UNITS: ReadonlySet<string> = new Set(['mm', 'cm', 'm', 'in']);
const DEFAULT_OUTPUT_UNIT = 'mm';

export type OcctConverterOptions = Pick<ConversionOptions, 'signal' | 'timeoutMs' | 'outputUnit'> & JobDeadlined;

/** Whether the program reads a file of this extension. */
export function isOcctSource(format: string): boolean {
  return Object.hasOwn(READABLE_SOURCES, format);
}

function programBinary(): string {
  const binary = resolveBinaryPath(PROGRAM_PATH_VARIABLE, PROGRAM_CANDIDATES, PROGRAM_NAME);
  if (binary === null) {
    throw new EngineUnavailableError(PROGRAM_NAME, 'cad-convert (Open CASCADE) is not installed or not in PATH');
  }
  return binary;
}

/** The error line the program printed, with the scratch directory and every unprintable character removed. */
function diagnostic(stderr: string, sandboxDir: string): string {
  const line = ERROR_LINE.exec(stderr.replaceAll(sandboxDir, '<tmp>'))?.[1];
  if (line === undefined) return '';
  return ` (${line.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function toProgramError(error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('CAD converter', timeoutMs);
  // The sandbox reports a signal SIGSEGV or SIGKILL of a memory-limited process as a memory error: running out of the limit
  // and crashing on a damaged file look the same to it, and the message says both.
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableCadInputError('The CAD converter ran out of memory or crashed on this model.');
  if (error instanceof SandboxedBufferLimitError) {
    // The sandbox reports a file that grew past its size limit (SIGXFSZ) with the same error as too much diagnostic output; the limit tells them apart.
    if (error.limitBytes === PROGRAM_MAX_OUTPUT_BYTES) return new UnprocessableCadInputError(OUTPUT_TOO_LARGE);
    return new UnprocessableCadInputError('The CAD converter printed more diagnostics than the limit allows: the file is damaged.');
  }
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(PROGRAM_NAME, 'cad-convert (Open CASCADE) could not be started');
    }
    if (MEMORY_ERROR_LINE.test(error.stderr)) {
      return new UnprocessableCadInputError(`The CAD converter ran out of memory: the model needs more than the ${PROGRAM_MEMORY_LIMIT_MB} MB it may use.`);
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return new UnprocessableCadInputError(`The CAD converter could not convert this model: it ${how}${diagnostic(error.stderr, sandboxDir)}.`);
  }
  return error;
}

/**
 * Converts a STEP or IGES file to STEP, IGES, binary STL or OBJ. Fails with a typed 422 for a file the kernel cannot read,
 * a model with nothing to write and a program that crashes or runs out of memory, a typed timeout when it overruns its
 * time, and an engine-unavailable error (503, retried on another worker) when the program is missing. Never returns an
 * estimate: a failed conversion is an error.
 */
export async function convertCadWithOcct(input: Buffer, sourceFormat: string, targetFormat: string, options: OcctConverterOptions = {}): Promise<Buffer> {
  const from = READABLE_SOURCES[sourceFormat];
  const to = WRITABLE_TARGETS[targetFormat];
  if (from === undefined || to === undefined) {
    throw new UnprocessableCadInputError(`The CAD converter does not convert .${sourceFormat} to .${targetFormat}.`);
  }
  const unit = options.outputUnit ?? DEFAULT_OUTPUT_UNIT;
  if (!OUTPUT_UNITS.has(unit)) {
    throw new UnprocessableCadInputError(`The output unit '${unit}' is not one of mm, cm, m and in.`);
  }
  const binary = programBinary();
  const timeoutMs = stageTimeoutMs(options, PROGRAM_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, `input.${sourceFormat}`);
    const outputPath = path.join(sandboxDir, `output.${targetFormat}`);
    fs.writeFileSync(inputPath, input, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, ['--from', from, '--to', to, '--unit', unit, inputPath, outputPath], {
        cwd: sandboxDir,
        timeoutMs,
        maxBuffer: PROGRAM_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: PROGRAM_MAX_OUTPUT_BYTES,
        memoryLimitMb: PROGRAM_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (error) {
      throw toProgramError(error, sandboxDir, timeoutMs);
    }
    if (!fs.existsSync(outputPath)) {
      throw new UnprocessableCadInputError('The CAD converter wrote no model from this file.');
    }
    const size = fs.statSync(outputPath).size;
    if (size === 0) throw new UnprocessableCadInputError('The CAD converter wrote an empty file.');
    if (size >= PROGRAM_MAX_OUTPUT_BYTES) throw new UnprocessableCadInputError(OUTPUT_TOO_LARGE);
    return fs.readFileSync(outputPath);
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}
