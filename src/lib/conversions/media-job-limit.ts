/** The time limit of a media job, which the encoder settings are also sized against (media-vp9-effort.ts). */

/** Longest a media job may run when the caller names no tier ceiling. */
export const DEFAULT_MEDIA_TIER_MAX_MS = 180_000;

/**
 * Computes dynamic transcoding timeout: min(tierMax, 3 * durationSeconds + 60) in milliseconds.
 */
export function computeMediaTimeoutMs(durationSeconds: number, tierMaxMs = DEFAULT_MEDIA_TIER_MAX_MS): number {
  const duration = Math.max(0, durationSeconds || 0);
  const baseTimeoutMs = Math.round((3 * duration + 60) * 1000);
  return Math.max(10000, Math.min(tierMaxMs, baseTimeoutMs));
}
