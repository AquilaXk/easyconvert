import path from 'node:path';
import { executeSandboxedBinary, SandboxedProcessError } from '../security/process-sandbox';
import {
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
import { withExifChunk } from './image-jxl-exif';
import { declaredJxlSize } from './image-jxl-header';
import { rawDecodableMetadata, type RawDecodable } from './image-jxl-metadata';
import { hasLearnedPng, learnFromDecoderPng, pngFromNetpbm, rawOutputName } from './image-jxl-raw';
import { assertInputPixels } from './image-input-limits';
import { MAX_DECODED_ANIMATION_BYTES } from './image-limits';

/**
 * JPEG XL pictures (ISO/IEC 18181), a bare codestream or a file in the ISO base media container, decoded by libjxl's `djxl` and
 * handed on as a lossless PNG, or as an APNG when the picture is an animation (the image pipeline then keeps the first frame for a
 * still target and every frame for GIF and WebP). `djxl` is run as an unmodified separate program under the process sandbox with no
 * network, on a file in a private directory. It turns the pixels by the orientation of the codestream header, writes the colour
 * profile into the PNG (an ICC profile, or the sRGB, gamma and chromaticity chunks), and writes more than 8 bits per sample as 16.
 * The size is read from the header before the decoder starts, so a small file that declares a huge picture is refused unread.
 * A plain picture whose metadata has been seen before is taken from the decoder as the samples of a Netpbm file and wrapped in a PNG with
 * the same colour chunks, which saves the compression of the PNG (image-jxl-raw.ts).
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const DJXL_PATH_ENV = 'DJXL_PATH';
const DJXL_EXECUTABLE_NAMES = ['djxl'] as const;
const JXL_LABEL = 'JPEG XL';
const DJXL_THREADS = '--num_threads=2';
/** The decoder takes the kind of file from the bytes; the output format from the name. */
const INPUT_FILE = 'in.jxl';

/** Largest sample of the PNG the decoder writes is 16 bits of four channels. */
const OUTPUT_BYTES_PER_PIXEL = 8;
const OUTPUT_OVERHEAD_BYTES = 64 * 1024;


/** Where `djxl` is installed, or null. */
export function findDjxl(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(DJXL_PATH_ENV, DJXL_EXECUTABLE_NAMES, env);
}

export { declaredJxlSize };

/** Runs `djxl` on the picture in `jobDir`, which writes `output` there. */
function runDjxl(djxl: string, jobDir: string, output: string, maxOutputBytes: number, signal?: AbortSignal): Promise<unknown> {
  return executeSandboxedBinary(djxl, [INPUT_FILE, output, DJXL_THREADS, '--quiet'], {
    cwd: jobDir,
    workDir: jobDir,
    timeoutMs: DECODER_TIMEOUT_MS,
    maxBuffer: DECODER_MAX_DIAGNOSTIC_BYTES,
    maxFileSize: maxOutputBytes,
    memoryLimitMb: DECODER_MEMORY_LIMIT_MB,
    networkIsolated: true,
    signal,
  });
}

/**
 * The PNG of the samples `djxl` writes as a Netpbm file (see image-jxl-raw.ts), or null when the decoder cannot write one for this
 * picture or the file is not the one the headers promised; the picture is then decoded to a PNG as it always was.
 */
async function decodeViaNetpbm(djxl: string, jobDir: string, plan: RawDecodable, pixels: number, maxOutputBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
  const output = rawOutputName(plan, DECODER_OUTPUT_NAME);
  try {
    await runDjxl(djxl, jobDir, output, maxOutputBytes, signal);
  } catch (err) {
    if (err instanceof SandboxedProcessError) return null;
    throw describeDecoderFailure(err, 'djxl', JXL_LABEL, DECODER_TIMEOUT_MS);
  }
  return pngFromNetpbm(djxl, plan, await readDecodedFile(path.join(jobDir, output), maxOutputBytes, JXL_LABEL), pixels);
}

/** Decodes a JPEG XL picture to a PNG (an APNG for an animation) with `djxl`. */
export async function decodeWithDjxl(input: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const djxl = findDjxl();
  if (djxl === null) throw decoderUnavailable('djxl', 'libjxl-tools');
  const { width, height } = declaredJxlSize(input);
  assertInputPixels(width, height);
  // An animation holds many frames of the declared size, which the header does not count; the bound for them is the one of any decoded animation.
  const maxOutputBytes = Math.max(width * height * OUTPUT_BYTES_PER_PIXEL + OUTPUT_OVERHEAD_BYTES, MAX_DECODED_ANIMATION_BYTES);
  const plan = rawDecodableMetadata(input);
  const output = `${DECODER_OUTPUT_NAME}.png`;
  return withDecoderJob(input, INPUT_FILE, async (jobDir) => {
    if (plan !== null && hasLearnedPng(djxl, plan)) {
      const fromSamples = await decodeViaNetpbm(djxl, jobDir, plan, width * height, maxOutputBytes, signal);
      if (fromSamples !== null) return fromSamples;
    }
    try {
      await runDjxl(djxl, jobDir, output, maxOutputBytes, signal);
    } catch (err) {
      throw describeDecoderFailure(err, 'djxl', JXL_LABEL, DECODER_TIMEOUT_MS);
    }
    const png = await readDecodedFile(path.join(jobDir, output), maxOutputBytes, JXL_LABEL);
    if (plan !== null) learnFromDecoderPng(djxl, plan, png);
    return withExifChunk(png);
  });
}
