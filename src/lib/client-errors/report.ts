/**
 * The report a browser sends when the converter UI crashes (docs/policy-decisions.md, entry 384). The browser and the route share
 * these limits: the browser cuts a report to them before it sends, the route cuts it again, since a request can come from anywhere.
 */

export const CLIENT_ERROR_PATH = '/api/client-errors';

/** The most bytes of a report the route reads. A report cut to the limits below is under 5 KB. */
export const CLIENT_ERROR_MAX_BODY_BYTES = 8 * 1024;

/** The most reports one page load sends. */
export const CLIENT_ERROR_REPORTS_PER_PAGE_LOAD = 5;

export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'boundary'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export const MAX_NAME_CHARS = 40;
export const MAX_MESSAGE_CHARS = 300;
/** The characters of a stack the browser sends and the route reads; the route keeps `MAX_STACK_FRAMES` frames of it. */
export const MAX_STACK_CHARS = 3000;
export const MAX_STACK_FRAMES = 8;
export const MAX_PATH_CHARS = 200;

/** What the browser sends: the fields of an error that name no file, person or request, as the browser read them. */
export interface ClientErrorReport {
  kind: ClientErrorKind;
  name: string;
  message: string;
  stack?: string;
  /** The hash Next.js gives an error of a server component, which the server log of that error carries too. */
  digest?: string;
  /** The path of the page, without its query string or fragment. */
  path: string;
  /** The commit the running build was made from. */
  release?: string;
}
