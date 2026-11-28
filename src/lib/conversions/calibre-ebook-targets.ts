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

/**
 * The e-book containers that only calibre reads (docs/policy-decisions.md, "CHM, LIT and TCR books" and entry 465 for SNB): the worker
 * hands the book to `ebook-convert` as it is and calibre writes every target, the in-process targets (EPUB, PDF, RTF and text)
 * included. calibre 8.5.0 reads no SNB file (its reader compares the byte names of the archive with text names), so the worker image
 * applies upstream's fix to the installed reader while it is built (scripts/calibre-patches).
 */
export const CALIBRE_ONLY_SOURCES: ReadonlySet<string> = new Set(['chm', 'lit', 'tcr', 'snb']);

/** The targets calibre writes for those sources besides the five above; a ZIP of the container's files is the archive route's. */
const CALIBRE_ONLY_SOURCE_TARGETS: ReadonlySet<string> = new Set(['epub', 'pdf', 'rtf', 'txt']);

/** Whether only calibre converts the pair: it writes the target, or it is the only program that reads the source into a target of the in-process engine. */
export function isCalibreOnlyPair(source: string, target: string): boolean {
  const tgt = target.toLowerCase();
  return CALIBRE_EBOOK_TARGETS.has(tgt) || (CALIBRE_ONLY_SOURCES.has(source.toLowerCase()) && CALIBRE_ONLY_SOURCE_TARGETS.has(tgt));
}

/** The error of a path that has no `ebook-convert`: the in-process engine, or a worker where the program is not installed. */
export function calibreEngineUnavailable(detail: string): EngineUnavailableError {
  return new EngineUnavailableError(CALIBRE_ENGINE_NAME, detail);
}
