import type { ConversionOptions } from '../types';
import { isImageCompression, paletteColorsForQuality } from '../image-compression';

/**
 * A PNG has no quality of its own. For a PNG to PNG conversion the quality is the size of the palette the picture is written with
 * (see `paletteColorsForQuality`), which is how the compress page asks for it. The mapping is made here, on the server, so that a call
 * of the API with `quality` gets the same file as the page. A request that names the palette itself (`palette`, `colors`,
 * `colorDepth`, `quantizer`) is left as it is: the quality is only the default for what was not asked.
 */
export function pngQualityAsPalette(sourceFormat: string, targetFormat: string, options: ConversionOptions): ConversionOptions {
  const { quality, ...rest } = options;
  if (typeof quality !== 'number' || !Number.isFinite(quality)) return options;
  if (!isImageCompression(sourceFormat, targetFormat) || targetFormat.toLowerCase() !== 'png') return options;
  if (options.palette !== undefined || options.colors !== undefined || options.colorDepth !== undefined || options.quantizer !== undefined) return options;
  return { ...rest, palette: true, colors: paletteColorsForQuality(quality) };
}
