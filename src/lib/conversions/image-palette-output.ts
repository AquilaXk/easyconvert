import sharp, { type Sharp } from 'sharp';
import { ConversionOptions, UnsupportedOptionError } from '../types';
import { encodeBmp8 } from './bmp';
import { applyOklabQuantizationAndDitherAsync, quantizeImageAsync, type DitherKind } from './color-quantizer';
import { encodeGif, GIF_MAX_COLORS } from './gif-writer';
import { encodeColourLimitedAnimation, encodeExactColourGif, libraryWritesColours } from './image-gif-colours';
import { quantizedBmp8 } from './bmp-palette-quantizer';
import { quantizedIconPng } from './ico-palette-quantizer';
import { quantizesInScript, type ContentClass } from './image-content';
import { GIF_PHOTO_PIXEL_BUDGET, HDR_FLOAT_PIXEL_BUDGET, QUANTIZER_PIXEL_BUDGET, assertPixelBudget, type PixelBudget } from './image-input-limits';
import { rgbaRaster, withinQuantizerBudget, writtenSizeOf } from './image-rgba-raster';

/**
 * The palettes of a GIF and of an 8-bit BMP: which quantiser writes them for a request, and the checks of the pixel budget that come before
 * any decode. The routes are `convertImage`'s, kept here so that the function that dispatches on the target stays within its size.
 */

/** The custom quantizers work on a single frame; applying them to a stacked animation would merge its frames. */
export function assertAnimatableOptions(options: ConversionOptions): void {
  if (options.quantizer === 'oklab' || options.ditherMethod === 'riemersma' || options.ditherMethod === 'blue-noise') {
    throw new UnsupportedOptionError(
      'The oklab quantizer, riemersma and blue-noise dithering work on one frame and cannot be applied to an animated GIF; remove them or select a single frame with the "page" option'
    );
  }
}

/** The dither the request names for the Oklab palette quantizer; error diffusion in linear light by default. */
function ditherKindOf(options: ConversionOptions): DitherKind {
  if (options.dither === false) return 'none';
  if (options.ditherMethod === 'blue-noise') return 'blue-noise';
  if (options.ditherMethod === 'riemersma') return 'riemersma';
  return 'floyd-steinberg';
}

/**
 * Palette and indices of an RGBA raster by the Oklab quantizer, with the raster rebuilt from them (each pixel
 * keeps its own alpha). The raster is refused from its size, before the per-pixel work, when it is over the
 * quantizer budget.
 */
export async function oklabPaletteRaster(data: Buffer, width: number, height: number, colours: number, options: ConversionOptions) {
  assertPixelBudget(width, height, QUANTIZER_PIXEL_BUDGET);
  const kind = ditherKindOf(options);
  const result = await applyOklabQuantizationAndDitherAsync({ data, width, height }, colours, kind !== 'none', kind === 'none' ? 'floyd-steinberg' : kind, options.signal);
  return { palette: result.palette, indexed: result.indexed, rgba: Buffer.from(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength) };
}

export async function assertPixelBudgetBeforeDecode(
  pipeline: Sharp,
  options: ConversionOptions,
  budget: PixelBudget = HDR_FLOAT_PIXEL_BUDGET
): Promise<void> {
  const target = await writtenSizeOf(pipeline, options);
  if (target !== null) assertPixelBudget(target.width, target.height, budget);
}

/**
 * How much farther than its nearest palette colour a photograph's pixel may be from the colour of the pixel before it for the
 * GIF to keep that colour (see `QuantizeOptions.runTolerance`). 0.25 takes the camera samples of the benchmark below the standard
 * converter's size (a 960 x 540 file 7 percent smaller than without it) for 0.0006 of SSIM and 0.2 dB, far inside the 0.007 and 2 dB
 * they lead that converter by.
 */
const GIF_PHOTO_RUN_TOLERANCE = 0.25;

/** The GIF of one frame (or, with `keepsAnimation`, of the stacked frames of an animation) of the pipeline. */
export async function encodeGifOutput(pipeline: Sharp, options: ConversionOptions, content: ContentClass | undefined, keepsAnimation: boolean): Promise<Buffer> {
  const colours = Math.min(256, Math.max(2, options.colors || 256));
  if (options.quantizer === 'oklab' || options.ditherMethod === 'riemersma' || options.ditherMethod === 'blue-noise') {
    if (keepsAnimation) {
      assertAnimatableOptions(options);
    }
    await assertPixelBudgetBeforeDecode(pipeline, options, QUANTIZER_PIXEL_BUDGET);
    const { data, info } = await rgbaRaster(pipeline);
    // The quantizer's palette goes into the GIF as it is: the image library is not asked to quantize again.
    const indexed = await quantizeImageAsync(data, info.width, info.height, colours, { dither: ditherKindOf(options), transparency: 'threshold', signal: options.signal });
    return encodeGif({ width: info.width, height: info.height, ...indexed });
  }
  if (content === 'photo' && !keepsAnimation && options.dither === undefined && (await withinQuantizerBudget(pipeline, options))) {
    // A photograph that asks for no dithering in particular: the Oklab quantizer's palette, each pixel mapped to its
    // nearest colour. Error diffusion is noise to LZW (25 percent more bytes on the camera samples of the benchmark) and
    // does not raise SSIM or PSNR there; the image library's palette quantizer spends the same bytes on both.
    const { data, info } = await rgbaRaster(pipeline);
    const indexed = await quantizeImageAsync(data, info.width, info.height, colours, { dither: 'none', transparency: 'threshold', runTolerance: GIF_PHOTO_RUN_TOLERANCE, signal: options.signal });
    return encodeGif({ width: info.width, height: info.height, ...indexed });
  }
  // The image library's writer takes the colour count as a bit depth: an animation below 256 colours, or a still picture of a count that is
  // not 2, 4, 16 or 256, is first reduced to the count here (image-gif-colours.ts).
  if (keepsAnimation && colours < GIF_MAX_COLORS) return encodeColourLimitedAnimation(pipeline, options, colours);
  if (!keepsAnimation && !libraryWritesColours(colours)) {
    await assertPixelBudgetBeforeDecode(pipeline, options, GIF_PHOTO_PIXEL_BUDGET);
    return encodeExactColourGif(pipeline, options, colours);
  }
  return pipeline.gif({ colours, dither: options.dither !== false ? 1.0 : 0.0 }).toBuffer();
}

/** The 8-bit BMP of the pipeline: a dithered one has its palette chosen by quantizr-pixels (entry 366), any other the Oklab quantizer's, which also writes it where the program does not answer. */
export async function encodeBmp8Output(pipeline: Sharp, options: ConversionOptions): Promise<Buffer> {
  await assertPixelBudgetBeforeDecode(pipeline, options, QUANTIZER_PIXEL_BUDGET);
  const colours = Math.min(256, Math.max(2, options.colors || 256));
  const quantizrBmp = quantizesInScript(options) || options.dither === false ? null : await quantizedBmp8(pipeline, { colours, options });
  if (quantizrBmp !== null) return quantizrBmp;
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
  const res = await oklabPaletteRaster(data, info.width, info.height, colours, options);
  return encodeBmp8(res.indexed, res.palette, info.width, info.height);
}

/**
 * The indexed PNG of an 8-bit ICO, its size taken from the pipeline (the icon resize is already in it). A dithered icon of 64 x 64 pixels or more has its
 * palette chosen by quantizr-pixels, alpha included (entry 376); any other icon (the Oklab, Riemersma and blue-noise requests, no dithering, a smaller
 * icon, and where the program is missing or fails) takes the Oklab quantizer's palette, written by the image library from the raster that already holds it.
 */
export async function encodeIconPng(pipeline: Sharp, options: ConversionOptions): Promise<{ png: Buffer; width: number; height: number }> {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const colours = Math.min(256, Math.max(2, options.colors || 256));
  const quantized = quantizesInScript(options) || options.dither === false ? null : await quantizedIconPng(data, info.width, info.height, { colours, signal: options.signal });
  if (quantized !== null) return { png: quantized, width: info.width, height: info.height };
  const { rgba } = await oklabPaletteRaster(data, info.width, info.height, colours, options);
  // The raster already holds only the palette's colours: the encoder must not dither or re-quantize it.
  const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ palette: true, colours, dither: 0, compressionLevel: 8 })
    .toBuffer();
  return { png, width: info.width, height: info.height };
}
