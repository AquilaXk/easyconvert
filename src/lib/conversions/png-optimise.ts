import { executeSandboxedBinary, rethrowSandboxUnavailable, SandboxedBufferLimitError, SandboxedProcessError } from '../security/process-sandbox';
import type { ConversionResult } from '../types';
import { findDecoderTool, loggableDiagnostic } from './image-decoder-tools';

/**
 * The lossless optimiser of a PNG file: oxipng (Joshua Holmer and contributors, MIT), run as an unmodified separate program in the process
 * sandbox with no network, on the bytes of the file through its standard input and output. It decodes the file, tries the lossless
 * reductions of the picture (to a palette of at most 256 colours, to grey, without an opaque alpha plane, to fewer bits per sample or
 * per palette index, with the palette in the order that compresses best), writes the rows with the filters its trials pick and deflates
 * them with libdeflate at a high level. Every step keeps each pixel value, so the picture that comes out is the picture that went in.
 *
 * The step is an extra: a file it cannot make smaller, a program that is not installed, a failed or timed-out run and a file too large to
 * be worth the time all give the input back unchanged, so a conversion never fails or grows because of it. Only a host that cannot confine
 * its children refuses (the sandbox's rule for every program), and a cancelled conversion stops.
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const OXIPNG_PATH_ENV = 'OXIPNG_PATH';
const OXIPNG_EXECUTABLE_NAMES = ['oxipng'] as const;

/**
 * oxipng's own optimisation presets (`-o`, 0 the fastest, 6 the slowest). A palette picture is a byte per pixel or less, so the preset that
 * tries four filters and deflates at libdeflate level 11 costs 50 to 200 ms and takes 12 percent off the files of the compress page (7 percent
 * without the palette reductions or without the filter trials, 4 percent with deflate level 9); a full-colour picture is three or four times
 * larger, and the next preset down (two filters, level 10) takes the same bytes off to within a point for 15 to 45 percent less time.
 */
export const OXIPNG_LEVEL_PALETTE = 2;
export const OXIPNG_LEVEL_FULL_COLOUR = 1;
/** Threads of one run: oxipng tries the filters side by side. */
const OXIPNG_THREADS = 2;
/** A run that has not finished in this time is stopped and the input kept. */
export const OXIPNG_TIMEOUT_MS = 60_000;
/** oxipng stops starting new trials after this many seconds, so that it ends before the sandbox has to kill it. */
const OXIPNG_SOFT_TIMEOUT_SECONDS = 40;
/** Diagnostics the program may print; more is runaway output. */
const OXIPNG_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_END_BYTES = 33;
const MEMORY_BASE_MB = 256;
/** Resident memory measured at -o2 is about 7 times the decoded picture; the limit leaves room above that. */
const MEMORY_PER_RAW_MB = 10;
const MEMORY_LIMIT_MAX_MB = 3072;
/**
 * Decoded pictures larger than this are not optimised: the trials cost seconds for a few percent (Linux arm64, two threads: a 24-megapixel
 * palette picture, 72 MB decoded, 3.3 s at -o1 and 5.7 s at -o2; a 12-megapixel full-colour one, 37 MB, 5.2 s at -o1; a 24-megapixel one,
 * 72 MB, 10.7 s). A palette picture is a byte a pixel, so its limit is a larger picture than a full-colour one's.
 */
export const OXIPNG_MAX_PALETTE_RAW_BYTES = 80 * 1024 * 1024;
export const OXIPNG_MAX_FULL_COLOUR_RAW_BYTES = 24 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;
const BIT_DEPTH_OFFSET = 24;
const COLOUR_TYPE_OFFSET = 25;
const COLOUR_TYPE_PALETTE = 3;
const CHANNELS_OF_COLOUR_TYPE: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Where oxipng is installed, or null. */
export function findOxipng(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(OXIPNG_PATH_ENV, OXIPNG_EXECUTABLE_NAMES, env);
}

/** The bytes of the decoded picture the header names and whether it has a palette, or null when the bytes do not start with a PNG header. */
export function readPngHeader(png: Buffer): { decodedBytes: number; palette: boolean } | null {
  if (png.length < IHDR_END_BYTES || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const colourType = png[COLOUR_TYPE_OFFSET];
  const channels = CHANNELS_OF_COLOUR_TYPE[colourType];
  if (channels === undefined) return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return { decodedBytes: height * (Math.ceil((width * channels * png[BIT_DEPTH_OFFSET]) / 8) + 1), palette: colourType === COLOUR_TYPE_PALETTE };
}

export interface OptimiseOptions {
  signal?: AbortSignal;
}

/**
 * The PNG, optimised without changing a pixel: the smaller file when the program makes it smaller, otherwise the very bytes that came in.
 */
export async function optimisePng(png: Buffer, options: OptimiseOptions = {}): Promise<Buffer> {
  const program = findOxipng();
  if (program === null) return png;
  const header = readPngHeader(png);
  if (header === null || header.decodedBytes > (header.palette ? OXIPNG_MAX_PALETTE_RAW_BYTES : OXIPNG_MAX_FULL_COLOUR_RAW_BYTES)) return png;
  const raw = header.decodedBytes;
  try {
    const result = await executeSandboxedBinary(
      program,
      ['-q', '-o', String(header.palette ? OXIPNG_LEVEL_PALETTE : OXIPNG_LEVEL_FULL_COLOUR), '--threads', String(OXIPNG_THREADS), '--timeout', String(OXIPNG_SOFT_TIMEOUT_SECONDS), '--stdout', '-'],
      {
        stdin: png,
        timeoutMs: OXIPNG_TIMEOUT_MS,
        // The program writes the input back when it finds nothing smaller: one byte more than the input is the most a good run writes.
        maxBuffer: png.length + 1,
        spoolStdout: true,
        memoryLimitMb: Math.min(MEMORY_LIMIT_MAX_MB, MEMORY_BASE_MB + Math.ceil(raw / BYTES_PER_MB) * MEMORY_PER_RAW_MB),
        networkIsolated: true,
        signal: options.signal,
      }
    );
    const optimised = result.stdout;
    return optimised.length > 0 && optimised.length < png.length && optimised.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? optimised : png;
  } catch (error) {
    options.signal?.throwIfAborted();
    rethrowSandboxUnavailable(error);
    // More output than the input is a file the program could not make smaller.
    if (error instanceof SandboxedBufferLimitError) return png;
    console.warn(`[png-optimise] oxipng did not optimise a picture: ${describeFailure(error)}`);
    return png;
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof SandboxedProcessError) return loggableDiagnostic(error.stderr);
  return error instanceof Error ? error.message : String(error);
}

/** The result of a conversion whose PNG file is optimised; the other fields stay. */
export async function withOptimisedPng(result: ConversionResult, options: OptimiseOptions = {}): Promise<ConversionResult> {
  const buffer = await optimisePng(result.buffer, options);
  return buffer === result.buffer ? result : { ...result, buffer, size: buffer.length };
}
