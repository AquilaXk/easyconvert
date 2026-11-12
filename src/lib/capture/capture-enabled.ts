import { normalizeGraphNodes, type JobGraph } from '../jobs/graph';
import { CaptureUnavailableError } from './website-capture-errors';

/** The graph operation of a website capture. */
const CAPTURE_OPERATION = 'capture.website';
/** The formats a page is captured as. */
export const CAPTURE_OUTPUT_FORMATS: readonly string[] = ['pdf', 'png', 'jpg'];

/**
 * Whether this server captures websites: only when `CAPTURE_WEBSITE_ENABLED` is `true`. It is off by default (docs/policy-decisions.md,
 * entry 270): the browser keeps the network of the worker and its confinement has not been run, so the operator turns it on.
 */
export function websiteCaptureEnabled(): boolean {
  return process.env.CAPTURE_WEBSITE_ENABLED?.trim().toLowerCase() === 'true';
}

/** Refuses a graph that captures a website when the server has capture off (CaptureUnavailableError, 422), before anything is reserved. */
export function assertGraphCaptureAllowed(graph: JobGraph | undefined): void {
  if (websiteCaptureEnabled() || graph === undefined) return;
  if (Object.values(normalizeGraphNodes(graph)).some((node) => node.op === CAPTURE_OPERATION)) throw new CaptureUnavailableError();
}
