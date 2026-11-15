import { EngineUnavailableError } from '../types';

/**
 * The pairs that only pandoc converts (docs/policy-decisions.md, "Markdown, plain text and HTML to LaTeX and reStructuredText"): the
 * reference writes them with pandoc 3.1.11, and the in-process engine has no writer for either target. The worker runs the pinned
 * release program unmodified in the process sandbox; a worker without it answers with an unavailable engine and never writes a file of
 * its own.
 */
const PANDOC_READERS: Readonly<Record<string, string>> = { md: 'markdown', txt: 'markdown', html: 'html' };
const PANDOC_WRITERS: Readonly<Record<string, string>> = { tex: 'latex', rst: 'rst' };
/** The pairs the reference lists: there is no HTML or plain text to reStructuredText pair. */
const PANDOC_PAIRS: ReadonlySet<string> = new Set(['md->rst', 'md->tex', 'html->tex', 'txt->tex']);

/** The name the unavailable-engine error carries, and the key of the program in the worker's binary table. */
export const PANDOC_ENGINE_NAME = 'pandoc';

export function isPandocPair(source: string, target: string): boolean {
  return PANDOC_PAIRS.has(`${source.toLowerCase()}->${target.toLowerCase()}`);
}

/** The reader pandoc is told for a source: pandoc reads a `.txt` file as Markdown, as it does when it takes the format from the file name. */
export function pandocReader(source: string): string {
  return PANDOC_READERS[source.toLowerCase()];
}

export function pandocWriter(target: string): string {
  return PANDOC_WRITERS[target.toLowerCase()];
}

/** The error of a path that has no pandoc: the in-process engine, or a worker where the program is not installed. */
export function pandocEngineUnavailable(detail: string): EngineUnavailableError {
  return new EngineUnavailableError(PANDOC_ENGINE_NAME, detail);
}

/** The refusal of the in-process engine for a pair only pandoc writes. */
export function assertNotPandocPair(source: string, target: string): void {
  if (!isPandocPair(source, target)) return;
  throw pandocEngineUnavailable(`Converting .${source.toLowerCase()} to .${target.toLowerCase()} needs the native pandoc engine; the in-process engine has no writer for it.`);
}
