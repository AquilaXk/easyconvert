import { UnsupportedOptionError } from '../types';
import type { ConversionOptions } from '../types';

export type OptimizerFunction = (
  buffer: Buffer,
  options: ConversionOptions
) => Promise<{ buffer: Buffer; optimized: boolean }>;

/**
 * The formats that have a real optimiser, as [format id, optimiser] pairs. Re-encoding with default
 * settings or returning the input is not optimisation, so a format is listed only once its optimiser
 * measurably shrinks the file or reports `optimized: false`. No format qualifies yet; the optimisers
 * tracked in the compress work register themselves here.
 */
const OPTIMIZER_ENTRIES: ReadonlyArray<readonly [string, OptimizerFunction]> = [];

export const OPTIMIZERS: ReadonlyMap<string, OptimizerFunction> = new Map(OPTIMIZER_ENTRIES);

function normalizeFormat(format: string): string {
  return (format || '').trim().replace(/^\./, '').toLowerCase();
}

/** The problem detail for `optimize` on a format without an optimiser: what is supported and where to go instead. */
export function optimizeUnavailableMessage(format: string): string {
  const supported = [...OPTIMIZERS.keys()];
  const supportedText = supported.length > 0 ? `Supported formats: ${supported.join(', ')}.` : 'No format has an optimiser yet.';
  return `optimize is not available for ${normalizeFormat(format)}. ${supportedText} Use the conversion options (for example quality or resolution on a convert node) to shrink a file.`;
}

export function hasOptimizer(format: string): boolean {
  return OPTIMIZERS.has(normalizeFormat(format));
}

export function getOptimizer(format: string): OptimizerFunction {
  const optimizer = OPTIMIZERS.get(normalizeFormat(format));
  if (!optimizer) {
    throw new UnsupportedOptionError(optimizeUnavailableMessage(format));
  }
  return optimizer;
}
