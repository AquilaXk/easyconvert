import { normalizeGraphNodes, type JobGraph } from '../jobs/graph';
import { CaptureUnavailableError } from './website-capture-errors';

/** The graph operation of a website capture. */
const CAPTURE_OPERATION = 'capture.website';
/** The formats a page is captured as. */
export const CAPTURE_OUTPUT_FORMATS: readonly string[] = ['pdf', 'png', 'jpg'];

/**
 * Whether this server captures websites: only when `CAPTURE_WEBSITE_ENABLED` is `true`. It stays off by default
 * (docs/policy-decisions.md, entries 270 and 436) until the CI container job confirms Debian 13 Qt 6.8 under the
 * relay-only network namespace and file confinement.
 */
export function websiteCaptureEnabled(): boolean {
  return process.env.CAPTURE_WEBSITE_ENABLED?.trim().toLowerCase() === 'true';
}

/** Refuses a graph that captures a website when the server has capture off (CaptureUnavailableError, 422), before anything is reserved. */
export function assertGraphCaptureAllowed(graph: JobGraph | undefined): void {
  if (websiteCaptureEnabled() || graph === undefined) return;
  if (Object.values(normalizeGraphNodes(graph)).some((node) => node.op === CAPTURE_OPERATION)) throw new CaptureUnavailableError();
}
