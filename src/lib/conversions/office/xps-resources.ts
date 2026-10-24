import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../../types';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../bounded-inflate';
import { decodeXmlBytes, resolvePackagePath } from '../package-access';
import { parseXmlTree, type XmlElement } from '../xml-tree';
import { descendantsOf, XPS_MAX_PART_BYTES } from './xps-reader';

/**
 * What the parts a fixed page names cost the renderer. A package keeps an image, a colour profile, a font or a resource
 * dictionary once however many pages use it, so the inflate budget of the package counts it once. GhostXPS decodes an image
 * again for every page that draws it, while it keeps a font after the first page that loads it: on the pinned 10.08.0 build
 * on the Linux arm64 test machine, 10 pages that draw one 2.85 MB JPEG (2000 x 2000 pixels) took 5.8 s and 100 pages took
 * 59.8 s, linear at 0.58 s a page, while 300 pages of 40 lines of text in one 760 KB font took 0.46 s and one page 0.016 s.
 * Ten thousand small pages that all name one large image therefore ask for ten thousand decodes of it and hold a worker
 * slot until the run limit. The sum over pages of the bytes of the images and colour profiles each page names (the parts it
 * names itself and those of the resource dictionaries it names), with fonts and dictionaries counted once, is the document
 * budget that bounds that work. A colour profile is counted like an image; it was not measured.
 */

const LABEL = 'XPS';
/**
 * The most bytes of images and colour profiles all pages together may name, counting a part again for every page that names
 * it: twice the inflate budget of a package. At the measured 5 MB a second of a dense JPEG that is about 100 seconds of
 * decoding, inside the 120 second default run limit. All the distinct images of a package together are at most the 256 MiB
 * inflate budget, so the budget lets each of them be drawn twice on average.
 */
export const XPS_MAX_REPEATED_BYTES = 2 * MAX_DOCUMENT_INFLATE_BYTES;
/** What naming a part costs at least, whatever its size: looking it up and opening it. It bounds the number of references one budget can hold. */
const MIN_REFERENCE_COST_BYTES = 1_024;
const FONT_ATTRIBUTE = 'FontUri';
const IMAGE_ATTRIBUTE = 'ImageSource';
const DICTIONARY_ELEMENT = 'ResourceDictionary';
const DICTIONARY_ATTRIBUTE = 'Source';
/** A colour such as `ContextColor /Resources/profile.icc 1,0.5,0.2` names its ICC profile after the keyword. */
const CONTEXT_COLOR_PREFIX = 'ContextColor ';
const WHITESPACE = /\s+/;
/** An image source is a part name, or a markup such as `{ColorConvertedBitmap /Resources/image.png /Resources/profile.icc}` that names several. */
const IMAGE_SOURCE_SEPARATORS = /[\s{}]+/;

/** The bytes of every part of a package by its name in lower case, as XPS part names ignore case. */
export type XpsPartBytes = ReadonlyMap<string, Buffer>;

/** The key a part is looked up by: XPS part names ignore case. */
export function partKey(name: string): string {
  return name.toLowerCase();
}

interface PartReferences {
  /** The images and colour profiles named, by key: the parts the renderer decodes again for every page. */
  readonly repeated: string[];
  /** The fonts and resource dictionaries named, by key: the parts the renderer loads once. */
  readonly once: string[];
  /** The resource dictionaries named, by key; they are also in `once`. */
  readonly dictionaries: string[];
}

function directoryOf(part: string): string {
  return part.slice(0, part.lastIndexOf('/') + 1);
}

/** The key of the part a reference names, or undefined when it names nothing inside the package (a markup word, a URI that leaves the package). */
function keyOfReference(holderDirectory: string, reference: string): string | undefined {
  if (reference === '') return undefined;
  try {
    return partKey(resolvePackagePath(holderDirectory, reference));
  } catch (error) {
    if (error instanceof ConversionFailedError) return undefined;
    throw error;
  }
}

interface ElementReferences {
  repeated: string[];
  fonts: string[];
  dictionary: string | undefined;
}

function referencesOfElement(element: XmlElement): ElementReferences {
  const repeated: string[] = [];
  const image = element.attrs.get(IMAGE_ATTRIBUTE);
  if (image !== undefined) repeated.push(...image.split(IMAGE_SOURCE_SEPARATORS));
  for (const value of element.attrs.values()) {
    if (value.startsWith(CONTEXT_COLOR_PREFIX)) repeated.push(value.split(WHITESPACE)[1] ?? '');
  }
  const font = element.attrs.get(FONT_ATTRIBUTE);
  const dictionary = element.local === DICTIONARY_ELEMENT ? element.attrs.get(DICTIONARY_ATTRIBUTE) : undefined;
  return { repeated, fonts: font === undefined ? [] : [font], dictionary };
}

/** The parts one XML part names: the images and colour profiles, the fonts, and the resource dictionaries of its elements. */
function referencesOf(part: string, bytes: Buffer): PartReferences {
  if (bytes.length > XPS_MAX_PART_BYTES) throw new PayloadLimitError(`"${part}" is ${bytes.length} bytes, more than the ${XPS_MAX_PART_BYTES} byte limit of a part.`);
  const root = parseXmlTree(decodeXmlBytes(bytes, `${LABEL} ${part}`), part, LABEL);
  const directory = directoryOf(part);
  const references: PartReferences = { repeated: [], once: [], dictionaries: [] };
  const keysOf = (names: readonly string[]): string[] => names.flatMap((name) => keyOfReference(directory, name) ?? []);
  for (const element of [root, ...descendantsOf(root)]) {
    const named = referencesOfElement(element);
    references.repeated.push(...keysOf(named.repeated));
    references.once.push(...keysOf(named.fonts));
    const dictionaries = keysOf(named.dictionary === undefined ? [] : [named.dictionary]);
    references.once.push(...dictionaries);
    references.dictionaries.push(...dictionaries);
  }
  return references;
}

/**
 * Refuses a document whose pages together name more than XPS_MAX_REPEATED_BYTES of images and colour profiles. Each page is
 * charged the size of every distinct existing image and colour profile it names (at least MIN_REFERENCE_COST_BYTES each):
 * its own, and those of the resource dictionaries it names. Fonts and dictionaries are charged the first time a page names
 * them. A dictionary that names a dictionary is charged for that one and its contents are not followed, so a chain or a cycle
 * of dictionaries costs one read each; every XML part is read once however many pages name it. The reading stops at the
 * first page over the budget.
 *
 * A package that lists a page it does not hold is refused first, whatever the renderer would do with it (it stops at the
 * first page it cannot read and still writes the pages before it).
 */
export function requirePagesDrawable(pageParts: readonly string[], parts: XpsPartBytes, signal?: AbortSignal): void {
  const missing = pageParts.find((page) => !parts.has(partKey(page)));
  if (missing !== undefined) throw new CorruptStreamError(`The ${LABEL} document lists the fixed page "${missing}", which is not in the package.`);
  const pageKeys = new Set(pageParts.map(partKey));
  const dictionaryReferences = new Map<string, PartReferences>();
  const referencesOfDictionary = (dictionary: string): PartReferences => {
    let references = dictionaryReferences.get(dictionary);
    if (references === undefined) {
      const bytes = parts.get(dictionary);
      references = bytes === undefined ? { repeated: [], once: [], dictionaries: [] } : referencesOf(dictionary, bytes);
      dictionaryReferences.set(dictionary, references);
    }
    return references;
  };
  const chargedOnce = new Set<string>();
  let total = 0;
  const charge = (key: string): void => {
    const bytes = pageKeys.has(key) ? undefined : parts.get(key);
    if (bytes === undefined) return;
    total += Math.max(bytes.length, MIN_REFERENCE_COST_BYTES);
    if (total > XPS_MAX_REPEATED_BYTES) {
      throw new PayloadLimitError(
        `The ${LABEL} pages name more than ${XPS_MAX_REPEATED_BYTES} bytes of images and colour profiles between them (counting an image again for every page that names it); the renderer decodes it once per page.`
      );
    }
  };
  for (const page of pageParts) {
    signal?.throwIfAborted();
    const named = referencesOf(page, parts.get(partKey(page)) as Buffer);
    const repeated = new Set(named.repeated);
    const once = new Set(named.once);
    for (const dictionary of named.dictionaries) {
      const contents = referencesOfDictionary(dictionary);
      for (const key of contents.repeated) repeated.add(key);
      for (const key of contents.once) once.add(key);
    }
    for (const key of repeated) charge(key);
    for (const key of once) {
      if (chargedOnce.has(key)) continue;
      chargedOnce.add(key);
      charge(key);
    }
  }
}
