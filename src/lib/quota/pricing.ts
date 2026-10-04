/**
 * Deterministic Resource Pricing Units Calculation Engine (D3)
 *
 * Implements deterministic calculation of billing units per job node:
 *   units = max(1, ceil(inputMB / 100)) * classMultiplier
 *
 * For duration-based media transcoding:
 *   units *= max(1, ceil(durationSeconds / 60))
 */

export type ResourceClass = 'light' | 'cpu' | 'memory' | 'gpu';

export const CLASS_MULTIPLIERS: Readonly<Record<ResourceClass, number>> = Object.freeze({
  light: 1,
  cpu: 2,
  memory: 3,
  gpu: 4,
});

export interface JobUsagePricingParams {
  /** Input byte length */
  inputBytes: number;
  /** Hardware resource profile needed for the task */
  resourceClass?: ResourceClass;
  /** Media playback duration in seconds (if applicable) */
  durationSeconds?: number;
  /** Whether the conversion involves audio/video timeline transcoding */
  isMedia?: boolean;
}

/**
 * Deterministically computes billing units according to the D3 formula.
 */
export function computeJobUnits(params: JobUsagePricingParams): number {
  const safeBytes = Math.max(0, Number.isFinite(params.inputBytes) ? params.inputBytes : 0);
  const inputMB = safeBytes / (1024 * 1024);
  const sizeFactor = Math.max(1, Math.ceil(inputMB / 100));

  const targetClass: ResourceClass = params.resourceClass ?? 'light';
  const classMultiplier = CLASS_MULTIPLIERS[targetClass] ?? 1;

  let units = sizeFactor * classMultiplier;

  if (params.isMedia && params.durationSeconds !== undefined && Number.isFinite(params.durationSeconds)) {
    const durationSeconds = Math.max(0, params.durationSeconds);
    if (durationSeconds > 0) {
      const durationFactor = Math.max(1, Math.ceil(durationSeconds / 60));
      units *= durationFactor;
    }
  }

  return units;
}
