/**
 * The formats whose `optimize` node has a real optimiser behind it. Re-encoding with default settings or
 * returning the input is not optimisation, so a format is listed only once its optimiser measurably shrinks
 * the file or reports `optimized: false`. PDF qualifies (profiles `web`, `print`, `archive` and `max`); the other
 * optimisers register here and in `conversions/optimizers.ts` as they are built. This module has no runtime
 * dependencies so graph validation, which also runs on the edge, can consult it.
 */
export const OPTIMIZABLE_FORMATS: readonly string[] = ['pdf'];

function normalizeFormat(format: string): string {
  return (format || '').trim().replace(/^\./, '').toLowerCase();
}

export function hasOptimizer(format: string): boolean {
  return OPTIMIZABLE_FORMATS.includes(normalizeFormat(format));
}

/** The problem detail for `optimize` on a format without an optimiser: what is supported and where to go instead. */
export function optimizeUnavailableMessage(format: string): string {
  const supportedText =
    OPTIMIZABLE_FORMATS.length > 0 ? `Supported formats: ${OPTIMIZABLE_FORMATS.join(', ')}.` : 'No format has an optimiser yet.';
  return `optimize is not available for ${normalizeFormat(format)}. ${supportedText} Use the conversion options (for example quality or resolution on a convert node) to shrink a file.`;
}
