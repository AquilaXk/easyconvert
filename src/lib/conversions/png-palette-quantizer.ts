import type { Sharp } from 'sharp';
import { executeSandboxedBinary, rethrowSandboxUnavailable, SandboxedProcessError } from '../security/process-sandbox';
import type { ConversionOptions } from '../types';
import { findDecoderTool, loggableDiagnostic } from './image-decoder-tools';
import { maxInputPixels } from './image-input-limits';
import { rgbaRaster, writtenSizeOf } from './image-rgba-raster';
import { deflateIndexedRows } from './png-indexed-deflate';
import { chunkOf, readChunks } from './png-photo-bands';

/**
 * The palette of a picture written to an indexed PNG (the compress page, and every other conversion that asks for a palette), chosen by
 * quantizr (DarthSim, MIT, https://github.com/DarthSim/quantizr) in a separate program of ours, `quantizr-pixels` (scripts/quantizr-pixels).
 * The worker decodes the picture itself and hands the program the 8-bit RGBA pixels on its standard input, so the program never sees
 * uploaded bytes; it answers the palette and one index a pixel on its standard output. The indexed PNG is written here, with the chunks
 * that the image library would have written for the same pipeline (profile, EXIF, resolution) taken from a one-pixel picture of it.
 *
 * It is an extra over the image library's own quantiser, which stays the answer of a worker without the program, of a picture past
 * `QUANTIZR_MAX_PIXELS` and of a run that fails: none of them fails the conversion. Only a host that cannot confine its children refuses
 * (the sandbox's rule for every program), and a cancelled conversion stops. Entry 253 of docs/policy-decisions.md has the measurements.
 */

const QUANTIZR_PATH_ENV = 'QUANTIZR_PIXELS_PATH';
const QUANTIZR_EXECUTABLE_NAMES = ['quantizr-pixels'];

/**
 * The dithering level handed to the program when the request dithers (the default). The library's own scale runs from 0 to 1 and its
 * default of 1 writes 4 to 6 percent more bytes than the image library's quantiser on photographs and screenshots, at 0.6 dB less PSNR,
 * where 0.25 writes 6 percent fewer at 0.08 dB less (entry 253).
 */
export const QUANTIZR_DITHER_LEVEL = 0.25;

/** The most pixels the program is given: its own bound (scripts/quantizr-pixels/src/main.rs), which a larger picture would exceed. */
export const QUANTIZR_MAX_PIXELS = 36_000_000;
const QUANTIZR_TIMEOUT_MS = 60_000;
/**
 * The program holds the pixels (4 bytes a pixel), the indices and a histogram of the colours, which is largest for noise, where every pixel has
 * its own: 36 megapixels of random pixels took 0.98 GB and 8.2 s on the Linux VM and 1.87 GB (52 bytes a pixel) and 9 s on the Mac (entry 253). The limit leaves room above both.
 */
const MEMORY_BASE_MB = 256;
const MEMORY_PER_PIXEL_BYTES = 64;
const BYTES_PER_MB = 1024 * 1024;
const RGBA_CHANNELS = 4;
const HEADER_BYTES = 8;
const COUNT_BYTES = 4;
const MAX_COLOURS = 256;
const OPAQUE = 255;

const PNG_COLOUR_TYPE_PALETTE = 3;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_BYTES = 13;
/** The chunks of the template that the writer replaces; every other one tells how the picture looks and is kept. */
const REPLACED_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

export interface IndexedPicture {
  width: number;
  height: number;
  /** The palette entries, four bytes (RGBA, straight alpha) each. */
  palette: Buffer;
  /** One palette index a pixel, row after row. */
  indices: Buffer;
}

export function findQuantizr(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(QUANTIZR_PATH_ENV, QUANTIZR_EXECUTABLE_NAMES, env);
}

export interface QuantizeRequest {
  colours: number;
  /** The dithering level of the program's own scale, 0 to 1. */
  dither: number;
  signal?: AbortSignal;
}

/** The program's answer for the pixels, or null when it is not installed, fails, or answers something that does not fit the picture. */
export async function quantizePixels(rgba: Buffer, width: number, height: number, request: QuantizeRequest): Promise<IndexedPicture | null> {
  const program = findQuantizr();
  if (program === null) return null;
  const pixels = width * height;
  if (rgba.length !== pixels * RGBA_CHANNELS) return null;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, COUNT_BYTES);
  try {
    const run = await executeSandboxedBinary(program, ['--colors', String(request.colours), '--dither', String(request.dither)], {
      stdin: Buffer.concat([header, rgba]),
      // A filter on standard input and output: it touches no file.
      workDir: null,
      timeoutMs: QUANTIZR_TIMEOUT_MS,
      maxBuffer: COUNT_BYTES + MAX_COLOURS * RGBA_CHANNELS + pixels,
      spoolStdout: true,
      memoryLimitMb: MEMORY_BASE_MB + Math.ceil((pixels * MEMORY_PER_PIXEL_BYTES) / BYTES_PER_MB),
      networkIsolated: true,
      signal: request.signal,
    });
    const picture = pictureOf(run.stdout, width, height);
    if (picture === null) console.warn('[png-palette-quantizer] quantizr-pixels answered something that does not fit the picture');
    return picture;
  } catch (error) {
    request.signal?.throwIfAborted();
    rethrowSandboxUnavailable(error);
    console.warn(`[png-palette-quantizer] quantizr-pixels did not quantize a picture: ${describeFailure(error)}`);
    return null;
  }
}

/** The palette and the indices of an answer, or null when its parts do not add up to the picture. */
function pictureOf(answer: Buffer, width: number, height: number): IndexedPicture | null {
  if (answer.length < COUNT_BYTES) return null;
  const count = answer.readUInt32LE(0);
  const indicesAt = COUNT_BYTES + count * RGBA_CHANNELS;
  if (count < 1 || count > MAX_COLOURS || answer.length !== indicesAt + width * height) return null;
  return { width, height, palette: answer.subarray(COUNT_BYTES, indicesAt), indices: answer.subarray(indicesAt) };
}

function describeFailure(error: unknown): string {
  if (error instanceof SandboxedProcessError) return loggableDiagnostic(error.stderr);
  return error instanceof Error ? error.message : String(error);
}

/** Bits a palette index takes in a PNG: the smallest of 1, 2, 4 and 8 that holds `colours` entries. */
function bitDepthOf(colours: number): 1 | 2 | 4 | 8 {
  if (colours <= 2) return 1;
  if (colours <= 4) return 2;
  return colours <= 16 ? 4 : 8;
}

/** The rows of the picture behind a filter byte of 0 each, with the indices packed into `depth` bits, high bits first. */
function scanlinesOf(picture: IndexedPicture, depth: 1 | 2 | 4 | 8): Buffer {
  const { width, height, indices } = picture;
  const rowBytes = Math.ceil((width * depth) / 8);
  const out = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1) + 1;
    if (depth === 8) {
      indices.copy(out, start, y * width, (y + 1) * width);
      continue;
    }
    const perByte = 8 / depth;
    for (let x = 0; x < width; x += 1) {
      const shift = 8 - depth * ((x % perByte) + 1);
      out[start + Math.floor(x / perByte)] |= indices[y * width + x] << shift;
    }
  }
  return out;
}

/**
 * The indexed PNG of a quantised picture. `template` is a PNG made from the same pipeline whatever its size: its chunks other than the
 * header, the palette, the transparency and the pixel data go into the file, ahead of the palette, so that the profile, the EXIF block
 * and the resolution are the ones the image library writes. The rows are written without filters and deflated by `deflateIndexedRows`.
 */
export async function writeIndexedPng(picture: IndexedPicture, template: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const { width, height, palette, indices } = picture;
  const colours = palette.length / RGBA_CHANNELS;
  if (!Number.isInteger(colours) || colours < 1 || colours > MAX_COLOURS) throw new Error(`The palette of ${palette.length} bytes does not hold 1 to ${MAX_COLOURS} entries.`);
  if (indices.length !== width * height) throw new Error(`The ${indices.length} indices do not make a ${width} x ${height} picture.`);
  if (indices.some((index) => index >= colours)) throw new Error(`An index points past the ${colours} palette entries.`);
  const depth = bitDepthOf(colours);

  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = PNG_COLOUR_TYPE_PALETTE;

  const entries = Buffer.alloc(colours * 3);
  const alphas = Buffer.alloc(colours);
  for (let i = 0; i < colours; i += 1) {
    palette.copy(entries, i * 3, i * RGBA_CHANNELS, i * RGBA_CHANNELS + 3);
    alphas[i] = palette[i * RGBA_CHANNELS + 3];
  }
  let transparent = colours;
  while (transparent > 0 && alphas[transparent - 1] === OPAQUE) transparent -= 1;

  const pieces: Uint8Array[] = [PNG_SIGNATURE, chunkOf('IHDR', [header])];
  for (const chunk of readChunks(template).filter((kept) => !REPLACED_CHUNKS.has(kept.type))) pieces.push(chunk.bytes);
  pieces.push(chunkOf('PLTE', [entries]));
  if (transparent > 0) pieces.push(chunkOf('tRNS', [alphas.subarray(0, transparent)]));
  pieces.push(chunkOf('IDAT', [await deflateIndexedRows(scanlinesOf(picture, depth), signal)]), chunkOf('IEND', []));
  return Buffer.concat(pieces);
}

export interface PalettePngRequest {
  colours: number;
  /** Whether the request dithers; the level is `QUANTIZR_DITHER_LEVEL`. */
  dither: boolean;
  /** The deflate level of the image library's own file, which a worker without the program or a failed run writes (`palettePngLevel`); the program's file has its own deflater. */
  level: number;
  options: ConversionOptions;
  /** The most pixels the program is given; a larger picture is left to the image library. */
  maxPixels?: number;
}

/**
 * The indexed PNG of the pipeline, its palette chosen by the program, or null when the image library should write it: no program, a picture
 * past the pixel limit, or a run that did not give a palette. The pipeline is not consumed.
 */
export async function quantizedPalettePng(pipeline: Sharp, request: PalettePngRequest): Promise<Buffer | null> {
  if (findQuantizr() === null) return null;
  const size = await writtenSizeOf(pipeline, request.options);
  const limit = Math.min(request.maxPixels ?? QUANTIZR_MAX_PIXELS, maxInputPixels());
  if (size === null || size.width * size.height > limit) return null;
  const { data, info } = await rgbaRaster(pipeline.clone());
  const picture = await quantizePixels(data, info.width, info.height, {
    colours: request.colours,
    dither: request.dither ? QUANTIZR_DITHER_LEVEL : 0,
    signal: request.options.signal,
  });
  if (picture === null) return null;
  const template = await pipeline.clone().extract({ left: 0, top: 0, width: 1, height: 1 }).png({ palette: true, compressionLevel: 0 }).toBuffer();
  return writeIndexedPng(picture, template, request.options.signal);
}

/**
 * The indexed PNG of the pipeline: the program's palette when it gives one, otherwise the image library's own quantiser at the same
 * dithering (its scale runs from 0 to 1, with 1 the default) and deflate level.
 */
export async function writePalettePng(pipeline: Sharp, request: PalettePngRequest): Promise<Buffer> {
  const quantized = await quantizedPalettePng(pipeline, request);
  if (quantized !== null) return quantized;
  return pipeline.png({ palette: true, colours: request.colours, dither: request.dither ? 1.0 : 0.0, compressionLevel: request.level }).toBuffer();
}
