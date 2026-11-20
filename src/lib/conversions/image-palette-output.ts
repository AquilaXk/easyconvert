import type { Sharp } from 'sharp';
import { ConversionOptions, UnsupportedOptionError } from '../types';
import { encodeBmp8 } from './bmp';
import { applyOklabQuantizationAndDitherAsync, quantizeImageAsync, type DitherKind } from './color-quantizer';
import { encodeGif } from './gif-writer';
import type { ContentClass } from './image-content';
import { HDR_FLOAT_PIXEL_BUDGET, QUANTIZER_PIXEL_BUDGET, assertPixelBudget, type PixelBudget } from './image-input-limits';
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
  return pipeline.gif({ colours, dither: options.dither !== false ? 1.0 : 0.0 }).toBuffer();
}

/** The 8-bit BMP of the pipeline, its palette chosen by the Oklab quantizer. */
export async function encodeBmp8Output(pipeline: Sharp, options: ConversionOptions): Promise<Buffer> {
  await assertPixelBudgetBeforeDecode(pipeline, options, QUANTIZER_PIXEL_BUDGET);
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
  const colours = Math.min(256, Math.max(2, options.colors || 256));
  const res = await oklabPaletteRaster(data, info.width, info.height, colours, options);
  return encodeBmp8(res.indexed, res.palette, info.width, info.height);
}
