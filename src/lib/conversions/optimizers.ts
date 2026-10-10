import { UnsupportedOptionError } from '../types';
import type { ConversionOptions } from '../types';
import { OPTIMIZABLE_FORMATS, optimizeUnavailableMessage } from '../jobs/optimize-formats';

export type OptimizerFunction = (
  buffer: Buffer,
  options: ConversionOptions
) => Promise<{ buffer: Buffer; optimized: boolean }>;

/** The optimiser of each format in `OPTIMIZABLE_FORMATS`, which graph validation consults at submission. */
const OPTIMIZER_ENTRIES: ReadonlyArray<readonly [string, OptimizerFunction]> = [];

export const OPTIMIZERS: ReadonlyMap<string, OptimizerFunction> = new Map(OPTIMIZER_ENTRIES);

export function getOptimizer(format: string): OptimizerFunction {
  const normalized = (format || '').trim().replace(/^\./, '').toLowerCase();
  const optimizer = OPTIMIZERS.get(normalized);
  if (!optimizer) {
    throw new UnsupportedOptionError(optimizeUnavailableMessage(normalized));
  }
  return optimizer;
}

export { OPTIMIZABLE_FORMATS };
