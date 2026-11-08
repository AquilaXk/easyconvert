import type { ConversionOptions } from './types';

/** The images a compress page makes smaller by converting them to their own format: JPG by quality, PNG by palette. */
export const COMPRESSED_IMAGE_FORMATS: readonly string[] = ['png', 'jpg'];

/** Whether a conversion is the compression of an image: PNG to PNG or JPG to JPG. */
export function isImageCompression(sourceFormat: string, targetFormat: string): boolean {
  const format = sourceFormat.toLowerCase();
  return format === targetFormat.toLowerCase() && COMPRESSED_IMAGE_FORMATS.includes(format);
}

/** The quality at and above which a PNG keeps the full 256-colour palette. */
const FULL_PALETTE_QUALITY = 80;
const FULL_PALETTE_COLORS = 256;
const MIN_PALETTE_COLORS = 2;

/** The palette size a PNG quality asks for: 256 colours from quality 80 up, then in proportion to the square of the quality. */
export function paletteColorsForQuality(quality: number): number {
  if (quality >= FULL_PALETTE_QUALITY) return FULL_PALETTE_COLORS;
  const scaled = Math.round(FULL_PALETTE_COLORS * (quality / FULL_PALETTE_QUALITY) ** 2);
  return Math.max(MIN_PALETTE_COLORS, scaled);
}

/**
 * The options the server gets for a conversion. A PNG has no quality of its own, so the quality of a PNG compression becomes
 * the size of its palette, which the server encoder honours; every other conversion goes as the options say.
 */
export function serverOptionsFor(sourceFormat: string, targetFormat: string, options: ConversionOptions): ConversionOptions {
  if (!isImageCompression(sourceFormat, targetFormat) || targetFormat.toLowerCase() !== 'png') return options;
  const { quality = FULL_PALETTE_QUALITY, ...rest } = options;
  return { ...rest, palette: true, colors: paletteColorsForQuality(quality) };
}
