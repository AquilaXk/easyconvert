import fs from 'node:fs';
import path from 'node:path';
import { executeSandboxedBinary, type SandboxedExecutionResult } from '../security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError } from '../types';
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
/**
 * Environment variable that names the directory of the ImageMagick policy (`policy.xml`); a value is authoritative. Without it
 * the worker image's directory is used, then the repository's, which is where development and CI run from.
 */
export const MAGICK_POLICY_DIR_ENV = 'MAGICK_POLICY_DIR';
const POLICY_FILE = 'policy.xml';
const POLICY_DIRECTORY_CANDIDATES: readonly string[] = ['/etc/easyconvert/imagemagick', path.join(process.cwd(), 'docker', 'imagemagick')];
/** `magick` is ImageMagick 7; `convert` is the command of version 6, and of the compatibility alias of version 7. */
const MAGICK_EXECUTABLE_NAMES = ['magick', 'magick-im7.q16', 'convert', 'convert-im6.q16'] as const;

/** What of the file the result holds. */
export type MagickResult =
  /** The first picture, as a PNG: the merged image of a layered file. */
  | { kind: 'first' }
  /** Every picture as a page of one TIFF. */
  | { kind: 'pages' }
  /**
   * Every picture drawn on a canvas of this size, as a PNG: the layers of a GIMP project. The canvas is the one the file's header
   * states; ImageMagick's own is not trusted, because for the files of GIMP 3 (XCF 19 and later) it takes the first layer's size
   * and crops every other layer.
   */
  | { kind: 'canvas'; width: number; height: number };

export interface MagickSource {
  /** ImageMagick's name of the coder that reads the format. */
  coder: string;
  /** The format in the words of an error message. */
  label: string;
  result: MagickResult;
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
/** Rows of the size probe: width and height, one row per picture. */
const SIZE_FORMAT = '%w %h\\n';
const SIZE_ROW = /^(\d+) (\d+)$/;
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
  '-limit', 'disk', '2GiB',
  '-limit', 'thread', '2',
  '-limit', 'time', String(MAGICK_TIME_LIMIT_SECONDS),
];
/** Makes a warning a failure. */
const STRICT_READ = '-regard-warnings';
/** Fastest PNG compression (zlib level 1, no row filter): the result is read once by the next step, not stored. */
const FAST_COMPRESSION = ['-quality', '10'] as const;
const LOSSLESS_TIFF = ['-compress', 'Zip'] as const;

/** Largest output of the size probe, which writes one short line per picture. */
const PROBE_MAX_BYTES = 1024 * 1024;

/** Where the ImageMagick policy is kept, or null when no directory holds a `policy.xml`. */
export function findMagickPolicyDirectory(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const override = env[MAGICK_POLICY_DIR_ENV];
  const candidates = override !== undefined && override !== '' ? [override] : POLICY_DIRECTORY_CANDIDATES;
  return candidates.find((dir) => path.isAbsolute(dir) && fs.existsSync(path.join(dir, POLICY_FILE))) ?? null;
}

/** Where ImageMagick is installed, or null. */
export function findMagick(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(MAGICK_PATH_ENV, MAGICK_EXECUTABLE_NAMES, env);
}

interface SceneSize {
  width: number;
  height: number;
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
    const [width, height] = (row as RegExpExecArray).slice(1).map(Number);
    return { width, height };
  });
}

/** Pixels the run decodes (each picture, and the canvas a composite is drawn on), each held to the input pixel limit and all of them together. */
function checkedPixels(sizes: readonly SceneSize[], result: MagickResult): number {
  const drawn = result.kind === 'canvas' ? [{ width: result.width, height: result.height }] : [];
  let pixels = 0;
  for (const size of [...sizes, ...drawn]) {
    assertInputPixels(size.width, size.height);
    pixels += size.width * size.height;
  }
  if (pixels > maxInputPixels()) throw new InputPixelLimitError(maxInputPixels());
  return pixels;
}

/** The coder and the file, and which picture of it is read. */
function inputSpecifier(source: MagickSource): string {
  return `${source.coder}:${DECODER_INPUT_NAME}${source.result.kind === 'first' ? FIRST_SCENE : ''}`;
}

function warningPolicy(source: MagickSource): string[] {
  return source.tolerateWarnings === true ? [] : [STRICT_READ];
}

/** What every run of one conversion shares. */
interface MagickJob {
  magick: string;
  /** The directory of the policy, which every run reads before any other. */
  policyDir: string;
  jobDir: string;
  source: MagickSource;
  signal: AbortSignal | undefined;
}

/**
 * One sandboxed ImageMagick run in the job directory; a failure is the conversion's typed error. The policy is the repository's,
 * and the pixel cache that spills past the memory limit is written inside the job directory, which is removed with it.
 */
async function runMagick(job: MagickJob, args: readonly string[], maxFileSize: number): Promise<SandboxedExecutionResult> {
  const { magick, policyDir, jobDir, source, signal } = job;
  try {
    return await executeSandboxedBinary(magick, [...MAGICK_LIMITS, ...warningPolicy(source), ...args], {
      cwd: jobDir,
      env: { MAGICK_CONFIGURE_PATH: policyDir, MAGICK_TEMPORARY_PATH: jobDir },
      timeoutMs: DECODER_TIMEOUT_MS,
      maxBuffer: DECODER_MAX_DIAGNOSTIC_BYTES,
      maxFileSize,
      memoryLimitMb: DECODER_MEMORY_LIMIT_MB,
      networkIsolated: true,
      signal,
    });
  } catch (err) {
    throw describeDecoderFailure(err, 'magick', source.label, DECODER_TIMEOUT_MS);
  }
}

/** The pixels the picture declares, read from its header without decoding it, before the run that decodes it. */
async function declaredPixels(job: MagickJob): Promise<number> {
  const run = await runMagick(job, ['-ping', inputSpecifier(job.source), '-format', SIZE_FORMAT, 'info:'], PROBE_MAX_BYTES);
  return checkedPixels(parseSceneSizes(run.stdout.toString('utf-8'), job.source.label), job.source.result);
}

/** The operators and the writer that give the result its form: a canvas is set and drawn on, a PNG is written fast, TIFF pages deflate. */
function resultArguments(result: MagickResult): { format: 'png' | 'tiff'; arguments: string[] } {
  if (result.kind === 'pages') return { format: 'tiff', arguments: [...LOSSLESS_TIFF] };
  // The canvas size is set and the offsets of the layers kept, then every layer is drawn on a transparent canvas of that size.
  const operators = result.kind === 'canvas' ? ['-repage', `${result.width}x${result.height}`, '-background', 'none', '-flatten'] : [];
  return { format: 'png', arguments: [...operators, ...FAST_COMPRESSION] };
}

/** Decodes `input` with ImageMagick; see the module comment for what the result holds. */
export async function decodeWithMagick(input: Buffer, source: MagickSource, signal?: AbortSignal): Promise<MagickDecoded> {
  const magick = findMagick();
  if (magick === null) throw decoderUnavailable('magick', 'ImageMagick');
  // Without its policy the run would rest on the coder prefix alone: the conversion is refused instead.
  const policyDir = findMagickPolicyDirectory();
  if (policyDir === null) throw new EngineUnavailableError('magick', `its policy (${POLICY_FILE} in docker/imagemagick) is not installed`);
  return withDecoderJob(input, DECODER_INPUT_NAME, async (jobDir) => {
    const job: MagickJob = { magick, policyDir, jobDir, source, signal };
    const maxOutputBytes = (await declaredPixels(job)) * OUTPUT_BYTES_PER_PIXEL + OUTPUT_OVERHEAD_BYTES;
    const { format, arguments: resultOptions } = resultArguments(source.result);
    await runMagick(job, [inputSpecifier(source), ...resultOptions, `${format}:${DECODER_OUTPUT_NAME}`], maxOutputBytes);
    const buffer = await readDecodedFile(path.join(jobDir, DECODER_OUTPUT_NAME), maxOutputBytes, source.label);
    return { buffer, format };
  });
}
