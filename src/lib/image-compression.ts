import { canonicalFormat } from './format-aliases';
import type { ConversionOptions } from './types';

/** The images a compress page makes smaller by converting them to their own format: JPG by quality, PNG by palette. */
export const COMPRESSED_IMAGE_FORMATS: readonly string[] = ['png', 'jpg'];

/**
 * Whether a conversion is the compression of an image: PNG to PNG or JPG to JPG. A file named `.jpeg` or `.jfif` is a JPG
 * (`/compress-jpg` takes it too), so the names a format goes by count as the format.
 */
export function isImageCompression(sourceFormat: string, targetFormat: string): boolean {
  const format = canonicalFormat(sourceFormat.toLowerCase());
  return format === canonicalFormat(targetFormat.toLowerCase()) && COMPRESSED_IMAGE_FORMATS.includes(format);
}

/**
 * The quality at and above which a PNG keeps the full 256-colour palette: the 85 % the options dialog shows for a PNG until the
 * person moves the slider, so that every step below the default takes colours away.
 */
export const FULL_PALETTE_QUALITY = 85;
const FULL_PALETTE_COLORS = 256;
const MIN_PALETTE_COLORS = 2;

/** The palette size a PNG quality asks for: 256 colours from the default quality up, then in proportion to the square of the quality. */
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

/**
 * The options that change nothing in the file but its weight: the quality. A size, a filter or stripping the metadata asks for a
 * change in the content, so the result is the person's, whatever its weight (the input would keep the metadata asked to go).
 */
const PLAIN_COMPRESSION_OPTIONS: readonly string[] = ['quality'];

/** Whether a compression asked for nothing but a smaller file, so that an input it cannot make smaller is the right answer. */
export function isPlainCompression(sourceFormat: string, targetFormat: string, options: ConversionOptions): boolean {
  return isImageCompression(sourceFormat, targetFormat) && Object.entries(options).every(([key, value]) => value === undefined || PLAIN_COMPRESSION_OPTIONS.includes(key));
}
