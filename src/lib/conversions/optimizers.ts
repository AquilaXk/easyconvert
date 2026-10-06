import { UnsupportedOptionError } from '../types';
import type { ConversionOptions } from '../types';

export type OptimizerFunction = (
  buffer: Buffer,
  options: ConversionOptions
) => Promise<{ buffer: Buffer; optimized: boolean }>;

export const OPTIMIZERS = new Map<string, OptimizerFunction>();

export function getOptimizer(format: string): OptimizerFunction {
  const normalized = (format || '').trim().replace(/^\./, '').toLowerCase();
  const optimizer = OPTIMIZERS.get(normalized);
  if (!optimizer) {
    throw new UnsupportedOptionError(`optimize is not available for ${normalized}`);
  }
  return optimizer;
}
