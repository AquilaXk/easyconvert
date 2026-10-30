import { EngineUnavailableError } from '../types';

/**
 * The e-book formats that only calibre's `ebook-convert` writes (docs/policy-decisions.md, "E-book targets written by
 * calibre"). The in-process engine has no writer for them, so a worker without the program answers with an unavailable
 * engine and never with a file of its own making.
 */
export const CALIBRE_EBOOK_TARGETS: ReadonlySet<string> = new Set(['mobi', 'azw3', 'pdb', 'lrf', 'oeb']);

/** The name the unavailable-engine error carries, and the key of the program in the worker's binary table. */
export const CALIBRE_ENGINE_NAME = 'ebook-convert';

export function isCalibreEbookTarget(target: string): boolean {
  return CALIBRE_EBOOK_TARGETS.has(target.toLowerCase());
}

/** The error of a path that has no `ebook-convert`: the in-process engine, or a worker where the program is not installed. */
export function calibreEngineUnavailable(detail: string): EngineUnavailableError {
  return new EngineUnavailableError(CALIBRE_ENGINE_NAME, detail);
}
