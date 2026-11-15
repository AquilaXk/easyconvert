// No imports: the OpenAPI document, the routes and the interface all read these names.

/**
 * The tools of the web application that work on several files or on the pages of one: each is one run, charged one
 * conversion, and runs the code of the job graph node of the same name (`merge`, `archive.create`, `archive.extract`,
 * `pdf.split-pages`, `pdf.rotate-pages`).
 */
export const WEB_TOOLS = [
  'merge',
  'archive-create',
  'archive-extract',
  'split',
  'rotate',
  'protect',
  'unlock',
  'watermark',
  'extract-pages',
  'delete-pages',
  'reorder-pages',
  'archive-inspect',
  'zip-repair',
] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

/** The fewest files a merge takes: with one there is nothing to join. */
export const MIN_MERGE_FILES = 2;

/** The most files one merge or one archive takes. */
export const MAX_TOOL_FILES = 50;
/** The most entries an unpacked archive lists. */
export const MAX_EXTRACTED_ENTRIES = 1000;
/** The most bytes an unpacked archive lists: the listing travels as base64 in JSON, about four times this in memory. */
export const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;
/** The most bytes the file a tool answers may hold. */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The longest `options` field a tool run takes. */
export const MAX_TOOL_OPTIONS_CHARS = 8 * 1024;


/** The tool's own options, as the `options` field of a request carries them. */
export interface WebToolOptions {
  /** Archive create: the format of the archive. */
  format?: string;
  split?: { ranges?: string; everyNPages?: number };
  rotate?: {
    rotation?: 90 | 180 | 270;
    pages?: string;
    rotations?: Array<{ rotation?: 90 | 180 | 270; angle?: 90 | 180 | 270; pages?: string }>;
  };
  protect?: {
    userPassword?: string;
    ownerPassword?: string;
    keyLength?: 128 | 256;
    permissions?: {
      print?: 'none' | 'low' | 'full';
      modify?: 'none' | 'assembly' | 'annotate' | 'form' | 'all';
      extract?: boolean;
      annotate?: boolean;
    };
  };
  unlock?: { password?: string; confirmEditRights?: boolean };
  watermark?: {
    text?: string;
    fontSize?: number;
    fontColor?: string;
    opacity?: number;
    rotation?: number;
    position?:
      | 'tile'
      | 'top-left'
      | 'top-center'
      | 'top-right'
      | 'center-left'
      | 'center'
      | 'center-right'
      | 'bottom-left'
      | 'bottom-center'
      | 'bottom-right';
    layer?: 'over' | 'under';
    pages?: string;
    password?: string;
    confirmEditRights?: boolean;
  };
  extractPages?: { pages?: string; password?: string; confirmEditRights?: boolean };
  deletePages?: { pages?: string; password?: string; confirmEditRights?: boolean };
  reorderPages?: { order?: string | number[]; password?: string; confirmEditRights?: boolean };
  archiveInspect?: { password?: string };
  zipRepair?: Record<string, unknown>;
  password?: string;
  confirmEditRights?: boolean;
  pages?: string;
  order?: string | number[];
}

/** The options a tool runs with until the person changes them: ZIP, every page for a split, a quarter turn for a rotation. */
export function defaultToolOptions(tool: WebTool): WebToolOptions {
  if (tool === 'archive-create') return { format: 'zip' };
  if (tool === 'rotate') return { rotate: { rotation: 90 } };
  return {};
}

/** The tools that have options to choose. */
export const TOOLS_WITH_OPTIONS: ReadonlySet<WebTool> = new Set<WebTool>([
  'archive-create',
  'archive-extract',
  'archive-inspect',
  'delete-pages',
  'extract-pages',
  'protect',
  'reorder-pages',
  'rotate',
  'split',
  'unlock',
  'watermark',
]);
