import { executeSandboxedBinary, rethrowSandboxUnavailable, SandboxedBufferLimitError, SandboxedProcessError } from '../security/process-sandbox';
import type { ConversionOptions, ConversionResult } from '../types';
import { availableCpus } from '../workers/available-cpus';
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

/**
 * Set on the options of a conversion whose source file is a PNG and whose target is a PNG (and only by `convertImageSource`): the file
 * the encoder writes is then optimised, and the encoder writes the cheapest file for it. A symbol, so that it cannot come out of request
 * JSON; a PNG that another decoder made from a JPEG XL or a camera file never carries it, since that conversion is not a compression of a PNG.
 */
export const OPTIMISE_PNG_RESULT = Symbol.for('easyconvert.optimisePngResult');

/** Whether the conversion is a PNG written from a PNG (see `OPTIMISE_PNG_RESULT`). */
export function isMarkedForOptimiser(options: ConversionOptions): boolean {
  return (options as Record<symbol, unknown>)[OPTIMISE_PNG_RESULT] === true;
}

/** The options with the mark that the file of this PNG to PNG conversion is optimised. */
export function markedForOptimiser(options: ConversionOptions): ConversionOptions {
  return { ...options, [OPTIMISE_PNG_RESULT]: true } as ConversionOptions;
}

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const OXIPNG_PATH_ENV = 'OXIPNG_PATH';
const OXIPNG_EXECUTABLE_NAMES = ['oxipng'] as const;

/**
 * oxipng's options by kind of file (Linux arm64, two threads, 55 pictures; entry 232 has the table). A palette picture is a byte per pixel or
 * less, so a run at `-o2` costs 50 to 200 ms and takes 12 percent off the files of the compress page. Of its four filter strategies only the
 * entropy one ever won on those files (`-f 0,6` writes 11.70 percent against 11.73 for 0,1,6,7 in 14 percent less time), and the colour
 * type reductions of a file that already has a palette find nothing (`--nc --ng`, 2 percent less time again; `--nb` also stops a palette of 16 colours or fewer from being packed into 4, 2 or 1 bits, so it stays off the list); the
 * preset below (`-o1`) takes 8.8 percent off in half the time and is not chosen: the files of the compress page are smaller than the
 * reference's in 54 of 55 cases only with the full preset. A full-colour picture is three or four times larger, and `-o1` (two filters, libdeflate level 10) takes the same
 * bytes off as `-o2` to within a point for 15 to 45 percent less time.
 */
export const OXIPNG_PALETTE_ARGUMENTS: readonly string[] = ['-o', '2', '-f', '0,6', '--nc', '--ng'];
export const OXIPNG_FULL_COLOUR_ARGUMENTS: readonly string[] = ['-o', '1'];
/**
 * A palette picture past 8 MB decoded (8 megapixels) is run at `-o1`: a 13.5-megapixel one takes 2.1 s against 3.5 s for the same 5.48 MB, and a
 * 24-megapixel one 3.3 s against 5.7 s for 10.50 MB against 10.67 MB, so `-o2` costs time and no bytes there.
 */
export const OXIPNG_LARGE_PALETTE_ARGUMENTS: readonly string[] = ['-o', '1'];
export const OXIPNG_LARGE_PALETTE_BYTES = 8 * 1024 * 1024;
/** The most threads of one run: oxipng tries the filters side by side, and a third thread saves 5 percent. */
const OXIPNG_MAX_THREADS = 2;
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

/**
 * Whether the PNG that a conversion writes from a picture of `width` x `height` pixels (`bytesPerPixel` as the encoder holds them: a palette
 * index is one) is handed to the optimiser: both ends are PNG, the program is installed, and the picture is within its size limit. The
 * encoder then writes the cheapest file the optimiser can read, since it inflates the file and writes every row again.
 */
export function optimiserFollows(source: string, target: string, width: number, height: number, bytesPerPixel: number, palette: boolean): boolean {
  if (source !== 'png' || target !== 'png' || findOxipng() === null) return false;
  return height * (width * bytesPerPixel + 1) <= (palette ? OXIPNG_MAX_PALETTE_RAW_BYTES : OXIPNG_MAX_FULL_COLOUR_RAW_BYTES);
}

function argumentsOf(header: { decodedBytes: number; palette: boolean }): readonly string[] {
  if (!header.palette) return OXIPNG_FULL_COLOUR_ARGUMENTS;
  return header.decodedBytes > OXIPNG_LARGE_PALETTE_BYTES ? OXIPNG_LARGE_PALETTE_ARGUMENTS : OXIPNG_PALETTE_ARGUMENTS;
}

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
      ['-q', ...argumentsOf(header), '--threads', String(Math.max(1, Math.min(OXIPNG_MAX_THREADS, availableCpus()))), '--timeout', String(OXIPNG_SOFT_TIMEOUT_SECONDS), '--stdout', '-'],
      {
        stdin: png,
        // A filter on standard input and output: it touches no file.
        workDir: null,
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
