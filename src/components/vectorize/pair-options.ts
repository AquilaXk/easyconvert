import type { ConversionOptions } from '@/lib/types';
import { sanitizeOptionsForPair as sanitizeWorkbenchOptions } from '@/components/workbench/options/options-capabilities';
import { isVectorizePair, sanitizeVectorizeOptions } from '@/lib/conversions/raster-vectorize-options';

/**
 * The options a queue item keeps for its pair. A raster picture traced to SVG keeps only the tracer's options, which the
 * picture options (size, quality) do not apply to; every other pair keeps what the workbench keeps for it.
 */
export function sanitizeOptionsForPair(options: ConversionOptions, sourceFormat: string, targetFormat: string): ConversionOptions {
  if (!isVectorizePair(sourceFormat, targetFormat)) return sanitizeWorkbenchOptions(options, sourceFormat, targetFormat);
  const vectorize = sanitizeVectorizeOptions(options.vectorize);
  return vectorize === undefined ? {} : { vectorize };
}
