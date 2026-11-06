import { CorruptStreamError, PayloadLimitError } from '../../types';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../bounded-inflate';
import { decodeXmlBytes } from '../package-access';
import { childElements, parseXmlTree, type XmlElement } from '../xml-tree';
import { xpsImagePixels } from './xps-image-header';
import { withinNameBuffer, XPS_MAX_PART_BYTES, xpsAbsolutePath } from './xps-reader';

/**
 * What the parts a fixed page names cost the renderer. A package keeps an image, a colour profile, a font or a resource
 * dictionary once however many pages use it, so the inflate budget of the package counts it once. GhostXPS decodes an image
 * again for every brush that names it, on every page, while it keeps a font after the first page that loads it: on the pinned
 * 10.08.0 build on the Linux arm64 test machine, 10 pages that draw one 2.85 MB JPEG (2000 x 2000 pixels) took 5.8 s and 100
 * pages took 59.8 s, linear at 0.58 s a page, while 300 pages of 40 lines of text in one 760 KB font took 0.46 s and one page
 * 0.016 s. Ten thousand small pages that all name one large image therefore ask for ten thousand decodes of it and hold a worker
 * slot until the run limit. The sum over brushes of the bytes of the images and colour profiles each names (each ImageBrush of a
 * page, and a brush of a resource dictionary once for every `{StaticResource key}` of the page that names its key), with fonts
 * and dictionaries counted once, is the document budget that bounds that work. A colour profile is counted like an image; it was
 * not measured.
 *
 * Bytes do not bound the decoding of an image that is small and large: a smooth JPEG of 4 megapixels and 39 KB costs 0.16 s
 * a page, so 10,000 pages that name it stay under the byte budget and are bounded only by the run limit. So every image is
 * also charged by the pixels its header declares, for every brush that names it (xps-image-header.ts), against the pixels the
 * job's own run limit can decode.
 *
 * Which parts are read follows GhostXPS (GhostPDL xps/xpsimage.c `xps_find_image_brush_source_part` and `xps_parse_image_brush`,
 * lines 413 to 483; xps/xpsresource.c; xps/xpszip.c `xps_read_zip_part`): a part is read when a brush names it, a resource
 * dictionary entry nobody uses is never read, a name is resolved without decoding it (xps/xpsmem.c `xps_absolute_path`), and a
 * part held in pieces (`name/[0].piece` ... `name/[n].last.piece`) is joined.
 */

const LABEL = 'XPS';
/**
 * The most bytes of images and colour profiles all pages together may name, counting a part again for every brush that names
 * it: twice the inflate budget of a package. At the measured 5 MB a second of a dense JPEG that is about 100 seconds of
 * decoding, inside the 120 second default run limit. All the distinct images of a package together are at most the 256 MiB
 * inflate budget, so the budget lets each of them be drawn twice on average.
 */
export const XPS_MAX_REPEATED_BYTES = 2 * MAX_DOCUMENT_INFLATE_BYTES;
/**
 * The pixels GhostXPS decodes in a second at the fastest rate measured on images whose bytes are too few for the byte budget to
 * count (GhostXPS 10.08.0 built by scripts/install-ghostxps.sh, `pdfwrite`, on the 4 vCPU Linux arm64 test VM; the page time is the
 * slope between packages of 10 and 40 pages that name one image, which leaves out the start of the program): a smooth 4 megapixel
 * PNG 0.171 s a page (23.4 million pixels a second), a 4 megapixel TIFF 0.17 to 0.21 s (19 to 23), a smooth 36 megapixel JPEG 1.56
 * s (23.1) and a smooth 4 megapixel JPEG 0.264 s (15.2). A package whose pixels cannot be decoded in the run limit at this rate
 * cannot finish whatever its images are, so only such a package is refused; one that is slower to decode than this (a dense image)
 * is bounded by the byte budget above.
 */
export const XPS_PIXELS_PER_SECOND = 23_400_000;
const MS_PER_SECOND = 1_000;

/** The most pixels of images all pages together may name, counting an image again for every brush that names it, in a run of `timeoutMs`. */
export function maxRepeatedPixels(timeoutMs: number): number {
  return Math.floor((timeoutMs * XPS_PIXELS_PER_SECOND) / MS_PER_SECOND);
}

/** What naming a part costs at least, whatever its size: looking it up and opening it. It bounds the number of references one budget can hold. */
const MIN_REFERENCE_COST_BYTES = 1_024;
/**
 * The most times anything can be used before the byte budget is gone, whatever it costs, since each use of a part costs at least
 * MIN_REFERENCE_COST_BYTES: a count past it is kept at it, which keeps the product of nested uses a finite number that is still over
 * the budget.
 */
const MAX_USES = Math.floor(XPS_MAX_REPEATED_BYTES / MIN_REFERENCE_COST_BYTES) + 1;
/** The most resource entries all pages together may reach through their keys, each counted once for every page that reaches it: one for each reference the byte budget can hold. */
const MAX_ENTRY_VISITS = Math.floor(XPS_MAX_REPEATED_BYTES / MIN_REFERENCE_COST_BYTES);
const FONT_ATTRIBUTE = 'FontUri';
const IMAGE_ATTRIBUTE = 'ImageSource';
const DICTIONARY_ELEMENT = 'ResourceDictionary';
const DICTIONARY_ATTRIBUTE = 'Source';
const KEY_ATTRIBUTE = 'Key';
/** A colour such as `ContextColor /Resources/profile.icc 1,0.5,0.2` names its ICC profile after the keyword. */
const CONTEXT_COLOR_PREFIX = 'ContextColor ';
const WHITESPACE = /\s+/;
/** An attribute that uses a resource of a dictionary by its key: `{StaticResource key}` (xpsresource.c `xps_parse_resource_reference`). */
const STATIC_RESOURCE_PREFIX = '{StaticResource ';
/** An image source that names a colour profile besides the image: `{ColorConvertedBitmap /Resources/image.png /Resources/profile.icc}` (xpsimage.c line 421). */
const COLOR_CONVERTED_BITMAP_PREFIX = '{ColorConvertedBitmap';

/** The bytes of every part of a package by its name in lower case, as XPS part names ignore case. */
export type XpsPartBytes = ReadonlyMap<string, Buffer>;

/** The key a part is looked up by: XPS part names ignore case. */
export function partKey(name: string): string {
  return name.toLowerCase();
}

/** How many times each part, or each resource key, is named. */
type Counts = Map<string, number>;

function bump(counts: Counts, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/** What one keyed entry of a resource dictionary names and uses. */
interface EntryReferences {
  /** The images and colour profiles the entry names, by key: decoded each time the entry is parsed. */
  readonly images: Counts;
  /** The keys the entry uses with `{StaticResource key}`, and how many times each: the renderer parses the entry that key names again for every one. */
  readonly uses: Counts;
}

interface PartReferences {
  /** The images and colour profiles named outside any resource entry, by key: the parts the renderer decodes again for each naming. */
  readonly drawn: Counts;
  /** The keys used outside any resource entry with `{StaticResource key}`, and how many times. */
  readonly uses: Counts;
  /** What each keyed entry of a resource dictionary names and uses, by the entry's key. */
  readonly entries: Map<string, EntryReferences>;
  /** The fonts and resource dictionaries named, by key: the parts the renderer loads once. */
  readonly once: string[];
  /** The resource dictionaries named, by key; they are also in `once`. */
  readonly dictionaries: string[];
}

function emptyReferences(): PartReferences {
  return { drawn: new Map(), uses: new Map(), entries: new Map(), once: [], dictionaries: [] };
}

function directoryOf(part: string): string {
  return part.slice(0, part.lastIndexOf('/') + 1);
}

/** The key of the part GhostXPS reads for `name`, held by a part in `holderDirectory` (xps-reader.ts `xpsAbsolutePath`). */
function ghostXpsPartKey(holderDirectory: string, name: string): string {
  return partKey(xpsAbsolutePath(holderDirectory, name));
}

/** The key of the font part `FontUri` names: GhostXPS cuts the joined name at its last `#`, which gives the number of the face in a collection (xps/xpsglyphs.c lines 682 to 688). */
function ghostXpsFontKey(holderDirectory: string, name: string): string {
  const path = xpsAbsolutePath(holderDirectory, name);
  const faceAt = path.lastIndexOf('#');
  return partKey(faceAt === -1 ? path : path.slice(0, faceAt));
}

/**
 * The part names an ImageSource holds, as GhostXPS splits it (xps/xpsimage.c `xps_find_image_brush_source_part`, lines 413 to 450):
 * only a value that starts with `{ColorConvertedBitmap` is split, on literal spaces, into the image, the colour profile and
 * the closing brace; any other value is one part name, spaces and braces included. A markup without a space names nothing.
 */
function namesOfImageSource(source: string): string[] {
  if (!source.startsWith(COLOR_CONVERTED_BITMAP_PREFIX)) return [source];
  const markup = withinNameBuffer(source);
  const imageStart = markup.indexOf(' ') + 1;
  if (imageStart === 0) return [];
  const imageEnd = markup.indexOf(' ', imageStart);
  if (imageEnd === -1) return [markup.slice(imageStart)];
  const profile = markup.slice(imageEnd + 1);
  const close = profile.indexOf('}');
  return [markup.slice(imageStart, imageEnd), close === -1 ? profile : profile.slice(0, close)];
}

/** The key a `{StaticResource key}` attribute value uses (xpsresource.c `xps_parse_resource_reference`: the text after the prefix up to the last brace), or undefined for any other value. */
function staticResourceKey(value: string): string | undefined {
  if (!value.startsWith(STATIC_RESOURCE_PREFIX)) return undefined;
  const key = value.slice(STATIC_RESOURCE_PREFIX.length);
  const close = key.lastIndexOf('}');
  return close === -1 ? key : key.slice(0, close);
}

interface ElementReferences {
  /** The keys of the images and colour profiles the element names. */
  repeated: string[];
  /** The keys of the resources the element uses. */
  uses: string[];
  /** The key of the font the element names, if any: a part the renderer loads once. */
  once: string[];
  /** The key of the dictionary part the element takes its entries from, if any. */
  dictionary: string | undefined;
}

function referencesOfElement(element: XmlElement, directory: string): ElementReferences {
  const image = element.attrs.get(IMAGE_ATTRIBUTE);
  const repeated = image === undefined ? [] : namesOfImageSource(image).map((name) => ghostXpsPartKey(directory, name));
  const uses: string[] = [];
  for (const value of element.attrs.values()) {
    if (value.startsWith(CONTEXT_COLOR_PREFIX)) repeated.push(ghostXpsPartKey(directory, value.split(WHITESPACE)[1] ?? ''));
    const used = staticResourceKey(value);
    if (used !== undefined) uses.push(used);
  }
  const font = element.attrs.get(FONT_ATTRIBUTE);
  const source = element.local === DICTIONARY_ELEMENT ? element.attrs.get(DICTIONARY_ATTRIBUTE) : undefined;
  const dictionary = source === undefined ? undefined : ghostXpsPartKey(directory, source);
  const fontKey = font === undefined ? undefined : ghostXpsFontKey(directory, font);
  return { repeated, uses, once: fontKey === undefined ? [] : [fontKey], dictionary };
}

function entryReferences(entries: Map<string, EntryReferences>, entry: string): EntryReferences {
  let references = entries.get(entry);
  if (references === undefined) {
    references = { images: new Map(), uses: new Map() };
    entries.set(entry, references);
  }
  return references;
}

/** An element to read, and the key of the dictionary entry it belongs to (undefined outside any entry). */
interface Visit {
  element: XmlElement;
  entry: string | undefined;
}

/**
 * The parts one XML part names. An element directly under a ResourceDictionary is an entry of it when it has a key, and whatever
 * it holds is drawn only when something uses the key; an element under a dictionary without a key can never be used and is not
 * followed (xpsresource.c `xps_parse_resource_dictionary` keeps only keyed children).
 */
function referencesOf(part: string, bytes: Buffer): PartReferences {
  if (bytes.length > XPS_MAX_PART_BYTES) throw new PayloadLimitError(`"${part}" is ${bytes.length} bytes, more than the ${XPS_MAX_PART_BYTES} byte limit of a part.`);
  const root = parseXmlTree(decodeXmlBytes(bytes, `${LABEL} ${part}`), part, LABEL);
  const directory = directoryOf(part);
  const references = emptyReferences();
  const pending: Visit[] = [{ element: root, entry: undefined }];
  while (pending.length > 0) {
    const { element, entry } = pending.pop() as Visit;
    const named = referencesOfElement(element, directory);
    const inEntry = entry === undefined ? undefined : entryReferences(references.entries, entry);
    for (const key of named.repeated) bump(inEntry === undefined ? references.drawn : inEntry.images, key);
    for (const key of named.uses) bump((inEntry ?? references).uses, key);
    references.once.push(...named.once);
    if (named.dictionary !== undefined) {
      references.once.push(named.dictionary);
      references.dictionaries.push(named.dictionary);
    }
    for (const child of childElements(element)) {
      if (element.local !== DICTIONARY_ELEMENT) pending.push({ element: child, entry });
      else if (child.attrs.has(KEY_ATTRIBUTE)) pending.push({ element: child, entry: child.attrs.get(KEY_ATTRIBUTE) });
    }
  }
  return references;
}

/** A part of the package as the renderer reads it: whole, or joined from its pieces (xpszip.c `xps_read_zip_part`, lines 346 to 441). */
interface StoredPart {
  readonly size: number;
  read(): Buffer;
}

/**
 * The part `key` names: the entry of that name, or else the pieces `key/[0].piece` to `key/[n].last.piece`, which the renderer
 * reads one after the other and joins when the last of them is there. A series without its last piece, or with a hole, is no part.
 */
function lookUpPart(parts: XpsPartBytes, key: string): StoredPart | undefined {
  const whole = parts.get(key);
  if (whole !== undefined) return { size: whole.length, read: () => whole };
  const pieces: Buffer[] = [];
  let size = 0;
  for (let index = 0; ; index += 1) {
    const middle = parts.get(`${key}/[${index}].piece`);
    const piece = middle ?? parts.get(`${key}/[${index}].last.piece`);
    if (piece === undefined) return undefined;
    pieces.push(piece);
    size += piece.length;
    if (middle === undefined) return { size, read: () => Buffer.concat(pieces) };
  }
}

/** The entries of the resource dictionaries in scope that a key names (more than one when the dictionaries repeat a key). */
type EntryLookup = (key: string) => readonly EntryReferences[];

/**
 * How many times the renderer parses each entry a page reaches. It resolves `{StaticResource key}` while it parses the element that
 * holds it, so an entry is parsed once for every use of its key by the page and once more for every parse of an entry that uses it
 * (GhostPDL xps/xpsresource.c `xps_parse_resource_reference`, read for behaviour): the times of an entry are the page's own uses of
 * its key plus, for every entry that uses it, the times of that entry multiplied by how often it uses the key. The entries are
 * taken in an order in which every entry comes after all that use it (a count of the uses still to be added), so each is
 * worked out once however deep or wide the nesting, and no call goes down a level. The counts are kept at MAX_USES. Entries that
 * use each other in a loop never get there, and the renderer, which parses them without end, crashes on them (GhostXPS 10.08.0 exits
 * with a segmentation fault on a VisualBrush `A` whose Visual holds a path filled with `A`), so such a page is refused.
 */
function timesEntriesAreParsed(pageUses: Counts, lookUp: EntryLookup): Counts {
  const times: Counts = new Map();
  const unadded = new Map<string, number>();
  const reached: string[] = [];
  const reach = (key: string, uses: number): void => {
    times.set(key, uses);
    unadded.set(key, 0);
    reached.push(key);
  };
  for (const [key, uses] of pageUses) if (lookUp(key).length > 0) reach(key, Math.min(uses, MAX_USES));
  for (let next = 0; next < reached.length; next += 1) {
    for (const entry of lookUp(reached[next])) {
      for (const used of entry.uses.keys()) {
        if (lookUp(used).length === 0) continue;
        if (!times.has(used)) reach(used, 0);
        unadded.set(used, (unadded.get(used) as number) + 1);
      }
    }
    if (reached.length > MAX_ENTRY_VISITS) throw new PayloadLimitError(`The ${LABEL} page reaches more than ${MAX_ENTRY_VISITS} entries of resource dictionaries through the keys it uses.`);
  }
  const ready = reached.filter((key) => unadded.get(key) === 0);
  let ordered = 0;
  while (ready.length > 0) {
    const key = ready.pop() as string;
    ordered += 1;
    for (const entry of lookUp(key)) {
      for (const [used, count] of entry.uses) {
        if (!unadded.has(used)) continue;
        times.set(used, Math.min((times.get(used) as number) + (times.get(key) as number) * count, MAX_USES));
        unadded.set(used, (unadded.get(used) as number) - 1);
        if (unadded.get(used) === 0) ready.push(used);
      }
    }
  }
  if (ordered < reached.length) {
    const looping = reached.find((key) => (unadded.get(key) as number) > 0) as string;
    throw new CorruptStreamError(`The ${LABEL} page uses the resource "${looping}", which is part of a loop of resources that use each other.`);
  }
  return times;
}

/**
 * Refuses a document whose pages together name more than XPS_MAX_REPEATED_BYTES of images and colour profiles, or more than
 * `maxRepeatedPixels(timeoutMs)` pixels of images, which the renderer cannot decode in the run limit of the job. Each page is charged
 * the size of every existing image and colour profile for each time a brush names it (at least MIN_REFERENCE_COST_BYTES each)
 * and the pixels the header of each image declares: the brushes of the page, and those of the resource dictionaries it names
 * once for each `{StaticResource key}` of the page that names the key of one of their entries. The header of a part is read
 * once however many brushes name it, and only for a part a brush names: an entry nobody uses is not read. Fonts and dictionaries
 * are charged the first time a page names them. A dictionary that names a dictionary is charged for that one and its contents
 * are not followed, so a chain or a cycle of dictionaries costs one read each; every XML part is read once however many pages
 * name it. An entry that uses another entry charges what that one names for every parse of the first (`timesEntriesAreParsed`): the
 * uses of the page multiply down the chain of entries, and entries that use each other in a loop are refused. The reading stops at the first page over a budget. An image that a brush names, whose declared size is over the input
 * pixel limit of a still image or whose header cannot be read, is refused by itself.
 *
 * A package that lists a page it does not hold is refused first, whatever the renderer would do with it (it stops at the
 * first page it cannot read and still writes the pages before it).
 */
export async function requirePagesDrawable(pageParts: readonly string[], parts: XpsPartBytes, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const missing = pageParts.find((page) => !parts.has(partKey(page)));
  if (missing !== undefined) throw new CorruptStreamError(`The ${LABEL} document lists the fixed page "${missing}", which is not in the package.`);
  const pageKeys = new Set(pageParts.map(partKey));
  const maxPixels = maxRepeatedPixels(timeoutMs);
  const storedParts = new Map<string, StoredPart | undefined>();
  const storedPart = (key: string): StoredPart | undefined => {
    if (!storedParts.has(key)) storedParts.set(key, pageKeys.has(key) ? undefined : lookUpPart(parts, key));
    return storedParts.get(key);
  };
  /** The references with only the parts that exist and are not pages, so that a reference to nothing costs nothing wherever it is counted. */
  const existingOnly = (references: PartReferences): PartReferences => {
    const existing = (counts: Counts): Counts => new Map([...counts].filter(([key]) => storedPart(key) !== undefined));
    const entries = new Map<string, EntryReferences>();
    for (const [entry, { images, uses }] of references.entries) {
      const kept = existing(images);
      if (kept.size > 0 || uses.size > 0) entries.set(entry, { images: kept, uses });
    }
    return { ...references, drawn: existing(references.drawn), entries };
  };
  const dictionaryReferences = new Map<string, PartReferences>();
  const referencesOfDictionary = (dictionary: string): PartReferences => {
    let references = dictionaryReferences.get(dictionary);
    if (references === undefined) {
      const bytes = parts.get(dictionary);
      references = bytes === undefined ? emptyReferences() : existingOnly(referencesOf(dictionary, bytes));
      dictionaryReferences.set(dictionary, references);
    }
    return references;
  };
  const pixelsOfPart = new Map<string, number>();
  const pixelsOf = async (key: string, part: StoredPart): Promise<number> => {
    let pixels = pixelsOfPart.get(key);
    if (pixels === undefined) {
      signal?.throwIfAborted();
      pixels = await xpsImagePixels(part.read());
      pixelsOfPart.set(key, pixels);
    }
    return pixels;
  };
  const chargedOnce = new Set<string>();
  let totalBytes = 0;
  let totalPixels = 0;
  let entryVisits = 0;
  const chargeBytes = (size: number, times: number): void => {
    totalBytes += Math.max(size, MIN_REFERENCE_COST_BYTES) * times;
    if (totalBytes > XPS_MAX_REPEATED_BYTES) {
      throw new PayloadLimitError(
        `The ${LABEL} pages name more than ${XPS_MAX_REPEATED_BYTES} bytes of images and colour profiles between them (counting an image again for every brush that names it); the renderer decodes it again for each one.`
      );
    }
  };
  const chargeRepeated = async (key: string, times: number): Promise<void> => {
    const part = storedPart(key) as StoredPart;
    chargeBytes(part.size, times);
    totalPixels += (await pixelsOf(key, part)) * times;
    if (totalPixels > maxPixels) {
      throw new PayloadLimitError(
        `The ${LABEL} pages name more than ${maxPixels} pixels of images between them (counting an image again for every brush that names it); the renderer decodes ${XPS_PIXELS_PER_SECOND} at most in a second, so it cannot draw them in the ${timeoutMs / MS_PER_SECOND} seconds this job has.`
      );
    }
  };
  const chargeOnce = (key: string): void => {
    const part = storedPart(key);
    if (part !== undefined) chargeBytes(part.size, 1);
  };
  for (const page of pageParts) {
    signal?.throwIfAborted();
    const named = referencesOf(page, parts.get(partKey(page)) as Buffer);
    const own = existingOnly(named);
    const demand: Counts = new Map(own.drawn);
    const dictionaries = [...new Set(named.dictionaries)].map(referencesOfDictionary);
    const sources = [own, ...dictionaries];
    const lookUp: EntryLookup = (key) => sources.flatMap((source) => source.entries.get(key) ?? []);
    const parsed = timesEntriesAreParsed(named.uses, lookUp);
    entryVisits += parsed.size;
    if (entryVisits > MAX_ENTRY_VISITS) {
      throw new PayloadLimitError(`The ${LABEL} pages reach more than ${MAX_ENTRY_VISITS} entries of resource dictionaries between them through the keys they use.`);
    }
    for (const [key, times] of parsed) {
      for (const entry of lookUp(key)) for (const [image, count] of entry.images) bump(demand, image, Math.min(count * times, MAX_USES));
    }
    for (const [key, times] of demand) await chargeRepeated(key, times);
    for (const key of new Set([...named.once, ...dictionaries.flatMap((dictionary) => dictionary.once)])) {
      if (chargedOnce.has(key)) continue;
      chargedOnce.add(key);
      chargeOnce(key);
    }
  }
}
