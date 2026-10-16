import path from 'node:path';
import { executeSandboxedBinary } from '../security/process-sandbox';
import { ConversionFailedError } from '../types';
import {
  DECODER_INPUT_NAME,
  DECODER_MAX_DIAGNOSTIC_BYTES,
  DECODER_MEMORY_LIMIT_MB,
  DECODER_OUTPUT_NAME,
  DECODER_TIMEOUT_MS,
  decoderUnavailable,
  describeDecoderFailure,
  findDecoderTool,
  readDecodedFile,
  withDecoderJob,
} from './image-decoder-tools';
import { assertInputPixels, InputPixelLimitError, maxInputPixels } from './image-input-limits';

/**
 * Pictures that the image library has no loader for, decoded by ImageMagick's own coders (PSD, XCF, TGA, PCX, DDS,
 * the PNM family, HEIC and HEIF through libheif, and old-style JPEG TIFF through libtiff) and handed on as a lossless
 * PNG, or as a TIFF when the file holds several pages. ImageMagick is run as an unmodified separate program under the
 * process sandbox with no network, on a file in a private directory. The coder is named on the command line, so the
 * format is never guessed from the content (no script, URL or delegate coder can be reached), and a warning counts
 * as a failure: a file that ends early is refused, not answered with the part that was read.
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const MAGICK_PATH_ENV = 'MAGICK_PATH';
/** `magick` is ImageMagick 7; `convert` is the command of version 6, and of the compatibility alias of version 7. */
const MAGICK_EXECUTABLE_NAMES = ['magick', 'magick-im7.q16', 'convert', 'convert-im6.q16'] as const;

/** How many of the pictures in the file the result holds. */
export type MagickScenes =
  /** The first picture: the merged image of a layered file. */
  | 'first'
  /** Every picture composited on the canvas, the layers of a GIMP project. */
  | 'flatten'
  /** Every picture as a page of one TIFF. */
  | 'all';

export interface MagickSource {
  /** ImageMagick's name of the coder that reads the format. */
  coder: string;
  /** The format in the words of an error message. */
  label: string;
  scenes: MagickScenes;
  /**
   * The coder reports harmless findings as warnings (libtiff names every private tag it does not know), so a warning does not
   * fail the run; the library's errors still do.
   */
  tolerateWarnings?: true;
}

export interface MagickDecoded {
  buffer: Buffer;
  format: 'png' | 'tiff';
}

const FIRST_SCENE = '[0]';
const OUTPUT_CODERS: Readonly<Record<MagickScenes, 'png' | 'tiff'>> = { first: 'png', flatten: 'png', all: 'tiff' };
/** Rows of the size probe: width, height and the canvas the picture sits on, one row per picture. */
const SIZE_FORMAT = '%w %h %W %H\\n';
const SIZE_ROW = /^(\d+) (\d+) (\d+) (\d+)$/;
/** Largest sample the result holds is 16 bits of four channels; a PNG or a Deflate TIFF is never larger than that plus headers. */
const OUTPUT_BYTES_PER_PIXEL = 8;
const OUTPUT_OVERHEAD_BYTES = 64 * 1024;
const MAGICK_TIME_LIMIT_SECONDS = 100;
/**
 * Resource limits ImageMagick applies to itself, beyond the sandbox's: pixels past `memory` and `map` spill to a disk file
 * of at most `disk`, `thread` bounds the OpenMP team, `time` (seconds) stops a run that does not end.
 */
const MAGICK_LIMITS: readonly string[] = [
  '-limit', 'memory', '1GiB',
  '-limit', 'map', '2GiB',
  '-limit', 'area', '1GiB',
  '-limit', 'disk', '8GiB',
  '-limit', 'thread', '2',
  '-limit', 'time', String(MAGICK_TIME_LIMIT_SECONDS),
];
/** Makes a warning a failure. */
const STRICT_READ = '-regard-warnings';
const FLATTEN_ON_TRANSPARENT = ['-background', 'none', '-flatten'] as const;
/** Fastest PNG compression (zlib level 1, no row filter): the result is read once by the next step, not stored. */
const FAST_COMPRESSION = ['-quality', '10'] as const;
const LOSSLESS_TIFF = ['-compress', 'Zip'] as const;

/** Where ImageMagick is installed, or null. */
export function findMagick(env: NodeJS.ProcessEnv = process.env): string | null {
  return findDecoderTool(MAGICK_PATH_ENV, MAGICK_EXECUTABLE_NAMES, env);
}

interface SceneSize {
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
}

function parseSceneSizes(output: string, label: string): SceneSize[] {
  const rows = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => SIZE_ROW.exec(line));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    throw new ConversionFailedError(`Invalid image: the ${label} header could not be decoded`);
  }
  return rows.map((row) => {
    const [width, height, canvasWidth, canvasHeight] = (row as RegExpExecArray).slice(1).map(Number);
    return { width, height, canvasWidth, canvasHeight };
  });
}

/** Pixels the run decodes (each picture, and the canvas a composite is drawn on), each held to the input pixel limit and all of them together. */
function checkedPixels(sizes: readonly SceneSize[], scenes: MagickScenes): number {
  let pixels = 0;
  for (const size of sizes) {
    assertInputPixels(size.width, size.height);
    pixels += size.width * size.height;
  }
  if (scenes === 'flatten') {
    const { canvasWidth, canvasHeight } = sizes[0];
    assertInputPixels(canvasWidth, canvasHeight);
    pixels += canvasWidth * canvasHeight;
  }
  if (pixels > maxInputPixels()) throw new InputPixelLimitError(maxInputPixels());
  return pixels;
}

/** The pixels the picture declares, read from its header without decoding it, before the run that decodes it. */
async function declaredPixels(magick: string, jobDir: string, source: MagickSource, signal: AbortSignal | undefined): Promise<number> {
  const selected = `${source.coder}:${DECODER_INPUT_NAME}${source.scenes === 'first' ? FIRST_SCENE : ''}`;
  try {
    const run = await executeSandboxedBinary(magick, [...MAGICK_LIMITS, ...warningPolicy(source), '-ping', selected, '-format', SIZE_FORMAT, 'info:'], {
      cwd: jobDir,
      timeoutMs: DECODER_TIMEOUT_MS,
      maxBuffer: DECODER_MAX_DIAGNOSTIC_BYTES,
      memoryLimitMb: DECODER_MEMORY_LIMIT_MB,
      networkIsolated: true,
      signal,
    });
    return checkedPixels(parseSceneSizes(run.stdout.toString('utf-8'), source.label), source.scenes);
  } catch (err) {
    if (err instanceof ConversionFailedError) throw err;
    throw describeDecoderFailure(err, 'magick', source.label, DECODER_TIMEOUT_MS);
  }
}

function warningPolicy(source: MagickSource): string[] {
  return source.tolerateWarnings === true ? [] : [STRICT_READ];
}

function decodeArguments(source: MagickSource): string[] {
  const selected = `${source.coder}:${DECODER_INPUT_NAME}${source.scenes === 'first' ? FIRST_SCENE : ''}`;
  const output = OUTPUT_CODERS[source.scenes];
  const operators = source.scenes === 'flatten' ? FLATTEN_ON_TRANSPARENT : [];
  const writer = output === 'png' ? FAST_COMPRESSION : LOSSLESS_TIFF;
  return [...MAGICK_LIMITS, ...warningPolicy(source), selected, ...operators, ...writer, `${output}:${DECODER_OUTPUT_NAME}`];
}

/** Decodes `input` with ImageMagick; see the module comment for what the result holds. */
export async function decodeWithMagick(input: Buffer, source: MagickSource, signal?: AbortSignal): Promise<MagickDecoded> {
  const magick = findMagick();
  if (magick === null) throw decoderUnavailable('magick', 'ImageMagick');
  return withDecoderJob(input, DECODER_INPUT_NAME, async (jobDir) => {
    const pixels = await declaredPixels(magick, jobDir, source, signal);
    const maxOutputBytes = pixels * OUTPUT_BYTES_PER_PIXEL + OUTPUT_OVERHEAD_BYTES;
    try {
      await executeSandboxedBinary(magick, decodeArguments(source), {
        cwd: jobDir,
        timeoutMs: DECODER_TIMEOUT_MS,
        maxBuffer: DECODER_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: maxOutputBytes,
        memoryLimitMb: DECODER_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal,
      });
    } catch (err) {
      throw describeDecoderFailure(err, 'magick', source.label, DECODER_TIMEOUT_MS);
    }
    const buffer = await readDecodedFile(path.join(jobDir, DECODER_OUTPUT_NAME), maxOutputBytes, source.label);
    return { buffer, format: OUTPUT_CODERS[source.scenes] };
  });
}
