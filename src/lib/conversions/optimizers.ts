import { UnsupportedOptionError } from '../types';
import type { ConversionOptions } from '../types';
import { OPTIMIZABLE_FORMATS, optimizeUnavailableMessage } from '../jobs/optimize-formats';
import { compressPdf } from './pdf-postprocess/compress';

/** What the job lets one optimiser run use: its abort signal, and the time left to the job deadline. */
export interface OptimizerRun {
  /** Fires at the job deadline, on cancel and on takeover; an optimiser stops its work, and any child process, when it does. */
  signal: AbortSignal;
  /** Milliseconds left until the job deadline; undefined when the job has none. Every stage is held to it. */
  remainingMs?: number;
}

export type OptimizerFunction = (
  buffer: Buffer,
  options: ConversionOptions,
  run: OptimizerRun
) => Promise<{ buffer: Buffer; optimized: boolean }>;

export type OptimizerRegistry = ReadonlyMap<string, OptimizerFunction>;

/** PDF: the profile of `options.optimize`, with the password and rights confirmation the node carries for an encrypted input. */
const optimizePdf: OptimizerFunction = (buffer, options, run) =>
  compressPdf(
    buffer,
    options.optimize,
    { password: options.password, confirmEditRights: options.confirmEditRights },
    { signal: run.signal, remainingMs: run.remainingMs }
  );

/** The optimiser of each format in `OPTIMIZABLE_FORMATS`, which graph validation consults at submission. */
const OPTIMIZER_ENTRIES: ReadonlyArray<readonly [string, OptimizerFunction]> = [['pdf', optimizePdf]];

export const OPTIMIZERS: OptimizerRegistry = new Map(OPTIMIZER_ENTRIES);

export function getOptimizer(format: string, registry: OptimizerRegistry = OPTIMIZERS): OptimizerFunction {
  const normalized = (format || '').trim().replace(/^\./, '').toLowerCase();
  const optimizer = registry.get(normalized);
  if (!optimizer) {
    throw new UnsupportedOptionError(optimizeUnavailableMessage(normalized));
  }
  return optimizer;
}

export { OPTIMIZABLE_FORMATS };
