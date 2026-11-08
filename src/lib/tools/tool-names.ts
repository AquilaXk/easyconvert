// No imports: the OpenAPI document, the routes and the interface all read these names.

/**
 * The tools of the web application that work on several files or on the pages of one: each is one run, charged one
 * conversion, and runs the code of the job graph node of the same name (`merge`, `archive.create`, `archive.extract`,
 * `pdf.split-pages`, `pdf.rotate-pages`).
 */
export const WEB_TOOLS = ['merge', 'archive-create', 'archive-extract', 'split', 'rotate'] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

export function isWebTool(value: string): value is WebTool {
  return (WEB_TOOLS as readonly string[]).includes(value);
}

/** The fewest files a merge takes: with one there is nothing to join. */
export const MIN_MERGE_FILES = 2;

/** The most files one merge or one archive takes. */
export const MAX_TOOL_FILES = 50;
/** The most entries an unpacked archive lists. */
export const MAX_EXTRACTED_ENTRIES = 1000;


/** The tool's own options, as the `options` field of a request carries them. */
export interface WebToolOptions {
  /** Archive create: the format of the archive. */
  format?: string;
  split?: { ranges?: string; everyNPages?: number };
  rotate?: { rotation?: 90 | 180 | 270; pages?: string };
}

/** The options a tool runs with until the person changes them: ZIP, every page for a split, a quarter turn for a rotation. */
export function defaultToolOptions(tool: WebTool): WebToolOptions {
  if (tool === 'archive-create') return { format: 'zip' };
  if (tool === 'rotate') return { rotate: { rotation: 90 } };
  return {};
}

/** The tools that have options to choose. */
export const TOOLS_WITH_OPTIONS: ReadonlySet<WebTool> = new Set<WebTool>(['archive-create', 'split', 'rotate']);
