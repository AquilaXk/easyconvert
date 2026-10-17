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
import { isType1Format, readType1Font, type Type1Font } from './font-type1';

export { isType1Format };

/**
 * PostScript Type 1 input. The in-process font engine reads SFNT containers only, and a Type 1 outline is a different program (a charstring
 * of Type 1 operators with hints and flex), so FontForge (fontforge-nox, GPL-3.0-or-later) reads the font and writes it as an OpenType font
 * with CFF outlines, which the SFNT pipeline then turns into every target. It runs unmodified as a separate process in the worker sandbox
 * with a time, memory, file-size and network limit; the script is fixed text and the font and the result are named by arguments, so nothing
 * of the uploaded file is ever part of a command. Its absence is an error: there is no other path that reads these files.
 */

const PROGRAM_NAME = 'fontforge';
const PROGRAM_PATH_VARIABLE = 'FONTFORGE_PATH';
const PROGRAM_CANDIDATES = ['/usr/bin/fontforge', '/usr/local/bin/fontforge', '/opt/homebrew/bin/fontforge'];
/** FontForge's native scripting language, with the font and the result as the script's first and second argument. */
const SCRIPT_LANGUAGE = '-lang=ff';
const SCRIPT = 'Open($1); Generate($2)';
/** A Type 1 font reads in well under a second; the job's own deadline can shorten this. */
const PROGRAM_DEFAULT_TIMEOUT_MS = 60_000;
const PROGRAM_MEMORY_LIMIT_MB = 1024;
const PROGRAM_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const PROGRAM_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_DETAIL_CHARS = 200;
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const UNPRINTABLE = /[^\x20-\x7e]/g;
const OUTPUT_TOO_LARGE = 'The font is larger than FontForge may write.';
const OTTO = 'OTTO';
const SFNT_HEADER_BYTES = 12;
const SFNT_RECORD_BYTES = 16;
const SFNT_TABLE_COUNT_OFFSET = 4;
const MAXP_GLYPH_COUNT_OFFSET = 4;

export type FontForgeOptions = Pick<ConversionOptions, 'signal' | 'timeoutMs'> & JobDeadlined;

function programBinary(): string {
  const binary = resolveBinaryPath(PROGRAM_PATH_VARIABLE, PROGRAM_CANDIDATES, PROGRAM_NAME);
  if (binary === null) {
    throw new EngineUnavailableError(PROGRAM_NAME, 'FontForge (fontforge-nox) is not installed or not in PATH');
  }
  return binary;
}

/** The last line FontForge printed, with the scratch directory and every unprintable character removed. */
function diagnostic(stderr: string, sandboxDir: string): string {
  const lines = stderr.replaceAll(sandboxDir, '<tmp>').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const last = lines.at(-1);
  return last === undefined ? '' : ` (${last.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function toProgramError(error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('FontForge', timeoutMs);
  // The sandbox reports a signal SIGSEGV or SIGKILL of a memory-limited process as a memory error: running out of the limit
  // and crashing on a damaged font look the same to it, and the message says both.
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableFontInputError('FontForge ran out of memory or crashed on this font.');
  if (error instanceof SandboxedBufferLimitError) {
    // The sandbox reports a file that grew past its size limit (SIGXFSZ) with the same error as too much diagnostic output; the limit tells them apart.
    if (error.limitBytes === PROGRAM_MAX_OUTPUT_BYTES) return new UnprocessableFontInputError(OUTPUT_TOO_LARGE);
    return new UnprocessableFontInputError('FontForge printed more diagnostics than the limit allows: the font is damaged.');
  }
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(PROGRAM_NAME, 'FontForge could not be started');
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return new UnprocessableFontInputError(`FontForge could not convert this font: it ${how}${diagnostic(error.stderr, sandboxDir)}.`);
  }
  return error;
}

/** The glyph count in the 'maxp' table of an OpenType file, or null when the file has no such table. */
function glyphCountOf(sfnt: Buffer): number | null {
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

/** The OpenType file FontForge wrote, accepted only if it is whole: an OpenType font that holds every glyph the Type 1 font does. */
function checkedResult(sfnt: Buffer, expectedGlyphs: number): Buffer {
  if (sfnt.length < SFNT_HEADER_BYTES || sfnt.toString('latin1', 0, 4) !== OTTO) {
    throw new UnprocessableFontInputError('FontForge wrote something that is not an OpenType font.');
  }
  const written = glyphCountOf(sfnt);
  if (written === null) {
    throw new UnprocessableFontInputError('FontForge wrote an OpenType font without a glyph count.');
  }
  // FontForge exits with success on a font it reads as empty or in part: a font with fewer glyphs than the source is a loss, not a result.
  if (written < expectedGlyphs) {
    throw new UnprocessableFontInputError(`FontForge read ${written} of the ${expectedGlyphs} glyphs of this font, so the result would lose glyphs.`);
  }
  return sfnt;
}

/**
 * Converts a Type 1 font to an OpenType font with CFF outlines (a 'OTTO' file). Fails with a typed 422 for a font FontForge cannot read,
 * one it reads with fewer glyphs than the file holds, and a program that crashes or runs out of memory; a typed timeout when it overruns
 * its time; and an engine-unavailable error (503, retried on another worker) when the program is missing. Never returns an estimate.
 */
export async function type1ToOpenType(font: Type1Font, options: FontForgeOptions = {}): Promise<Buffer> {
  const binary = programBinary();
  const timeoutMs = stageTimeoutMs(options, PROGRAM_DEFAULT_TIMEOUT_MS);
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, 'input.pfb');
    const outputPath = path.join(sandboxDir, 'output.otf');
    fs.writeFileSync(inputPath, font.fontFile, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, [SCRIPT_LANGUAGE, '-c', SCRIPT, inputPath, outputPath], {
        cwd: sandboxDir,
        env: { HOME: sandboxDir },
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
      throw new UnprocessableFontInputError('FontForge wrote no font from this file.');
    }
    const size = fs.statSync(outputPath).size;
    if (size === 0) throw new UnprocessableFontInputError('FontForge wrote an empty file.');
    if (size >= PROGRAM_MAX_OUTPUT_BYTES) throw new UnprocessableFontInputError(OUTPUT_TOO_LARGE);
    return checkedResult(fs.readFileSync(outputPath), font.glyphCount);
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

/** A PFA or PFB file as an OpenType font with CFF outlines: checked by the Type 1 reader, converted by FontForge, checked again. */
export async function type1FileToOpenType(file: Buffer, options: FontForgeOptions = {}): Promise<Buffer> {
  return type1ToOpenType(readType1Font(file), options);
}
