/**
 * The engines a request may name with `engine` (docs/policy-decisions.md, entry 267): the in-process converter and the
 * programs the worker runs as separate processes. An id is stable across releases; the display name is for pages and docs.
 */
export const ENGINE_NAMES = {
  easyconvert: 'EasyConvert (built-in)',
  libreoffice: 'LibreOffice',
  ffmpeg: 'FFmpeg',
  poppler: 'Poppler',
  '7zip': '7-Zip',
  ghostscript: 'Ghostscript',
  ghostxps: 'GhostXPS',
  djvulibre: 'DjVuLibre',
  calibre: 'calibre',
  librsvg: 'librsvg',
  libraw: 'LibRaw',
} as const;

export type EngineId = keyof typeof ENGINE_NAMES;

/** The id of the in-process converter, the only engine that is not a separate program. */
export const BUILT_IN_ENGINE = 'easyconvert' satisfies EngineId;

export const ENGINE_IDS = Object.keys(ENGINE_NAMES) as readonly EngineId[];

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && Object.hasOwn(ENGINE_NAMES, value);
}

/**
 * Whether a route of the worker may run for the engine a request chose: any route when none was chosen, else only the routes of
 * that engine. The built-in converter owns no native route, so choosing it skips every one of them.
 */
export function engineAllowsRoute(chosen: string | undefined, route: EngineId): boolean {
  return chosen === undefined || chosen === route;
}
