import type { Block, DocumentModel, Inline } from './model';
import { bodyBlocks, walkRuns } from './support';

/**
 * Gives every anchor of a document a name its writers can emit once: an XML name (EPUB `id`, Word and ODF bookmark
 * names), unique in the document, with the links that point at it following it.
 *
 * HTML allows what these formats do not: an id twice (the first element is the link target), an id with a space or any
 * other character an XML name lacks, and a link whose fragment is the id percent-escaped (`#my%20part` for `id="my part"`).
 * The first anchor of a source name keeps the name (made valid); a later one with the same source name, or one whose valid
 * name is taken, gets the next free `-2`, `-3` suffix. A link finds its anchor by the fragment as written first, then
 * percent-decoded, as a browser does; a link with no anchor is left as it is and the writers drop it.
 */

/** Characters of an XML name outside the ASCII ones: letters, from the Latin-1 supplement on, of the scripts of the pages we read. */
const NAME_CHARACTER_OUTSIDE_ASCII = '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u3040-\\uD7FF';
const INVALID_NAME_CHARACTER = new RegExp(`[^A-Za-z0-9_.\\-${NAME_CHARACTER_OUTSIDE_ASCII}]`, 'g');
const NAME_START = new RegExp(`^[A-Za-z_${NAME_CHARACTER_OUTSIDE_ASCII}]`);
const FIRST_SUFFIX = 2;
const FRAGMENT_MARK = '#';

/** `name` as an XML name: every character a name lacks becomes `_`, and a name that does not start like one gets a leading `_`. */
function xmlName(name: string): string {
  const cleaned = name.replace(INVALID_NAME_CHARACTER, '_');
  return NAME_START.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** A fragment with its percent escapes decoded; one with a malformed escape is kept as written, as URL parsing keeps it. */
function decodedFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch (error) {
    if (error instanceof URIError) return fragment;
    throw error;
  }
}

/**
 * The names of the anchors of one document, given in document order: each source name gets the XML name that is free,
 * and a link finds the name of the anchor it points at. `isReserved` names the ids the writer makes up itself (heading
 * and note ids), which no anchor may take.
 */
export class AnchorNames {
  private readonly taken = new Set<string>();
  private readonly firstBySource = new Map<string, string>();
  private readonly nextSuffix = new Map<string, number>();

  constructor(private readonly isReserved: (name: string) => boolean = () => false) {}

  private isTaken(name: string): boolean {
    return this.taken.has(name) || this.isReserved(name);
  }

  /** The unique name of the next anchor, which was written `source`. */
  claim(source: string): string {
    let name = xmlName(source);
    if (this.firstBySource.has(source) || this.isTaken(name)) {
      const base = name;
      // Names taken stay taken, so the suffixes below the one the last duplicate of `base` got are all in use.
      let suffix = this.nextSuffix.get(base) ?? FIRST_SUFFIX;
      for (; this.isTaken(name); suffix += 1) name = `${base}-${suffix}`;
      this.nextSuffix.set(base, suffix);
    }
    this.taken.add(name);
    if (!this.firstBySource.has(source)) this.firstBySource.set(source, name);
    return name;
  }

  /** The name of the anchor a link with this fragment points at (as written first, then percent-decoded), or undefined when there is none. */
  find(fragment: string): string | undefined {
    return this.firstBySource.get(fragment) ?? this.firstBySource.get(decodedFragment(fragment));
  }
}

/**
 * Renames the anchors of `model` and the links to them in place. `isReserved` names the ids the writer makes up itself
 * (heading and note ids), which no anchor may take. Running it again changes nothing.
 */
export function uniqueAnchors(model: DocumentModel, isReserved: (name: string) => boolean = () => false): void {
  const runs: Inline[] = [];
  const collect = (blocks: readonly Block[]): void => walkRuns(blocks, (run) => runs.push(run));
  collect(bodyBlocks(model));
  for (const note of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) collect(note.blocks);

  const names = new AnchorNames(isReserved);
  for (const run of new Set(runs)) {
    if (run.anchor !== undefined) run.anchor = names.claim(run.anchor);
  }
  for (const run of new Set(runs)) {
    if (run.href === undefined || !run.href.startsWith(FRAGMENT_MARK)) continue;
    const target = names.find(run.href.slice(FRAGMENT_MARK.length));
    if (target !== undefined) run.href = `${FRAGMENT_MARK}${target}`;
  }
}
