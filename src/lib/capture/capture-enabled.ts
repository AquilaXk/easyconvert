import { normalizeGraphNodes, type JobGraph } from '../jobs/graph';
import { CaptureUnavailableError } from './website-capture-errors';

/** The graph operation of a website capture. */
const CAPTURE_OPERATION = 'capture.website';
/** The formats a page is captured as. */
export const CAPTURE_OUTPUT_FORMATS: readonly string[] = ['pdf', 'png', 'jpg'];

/**
 * Whether this server captures websites: on by default (`CAPTURE_WEBSITE_ENABLED` unset or blank defaults to `true`,
 * docs/policy-decisions.md, entries 270, 436 and 443). When set, `'true'` keeps it enabled while `'false'` or any
 * unrecognized non-boolean value disables it as a fail-closed kill-switch.
 */
export function websiteCaptureEnabled(): boolean {
  const raw = process.env.CAPTURE_WEBSITE_ENABLED?.trim().toLowerCase();
  return !raw ? true : raw === 'true';
}

/** Refuses a graph that captures a website when the server has capture off (CaptureUnavailableError, 422), before anything is reserved. */
export function assertGraphCaptureAllowed(graph: JobGraph | undefined): void {
  if (websiteCaptureEnabled() || graph === undefined) return;
  if (Object.values(normalizeGraphNodes(graph)).some((node) => node.op === CAPTURE_OPERATION)) throw new CaptureUnavailableError();
}
