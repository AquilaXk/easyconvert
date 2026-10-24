import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../../types';
import { MAX_DOCUMENT_INFLATE_BYTES } from '../bounded-inflate';
import { decodeXmlBytes, resolvePackagePath } from '../package-access';
import { childElements, parseXmlTree, type XmlElement } from '../xml-tree';
import { xpsImagePixels } from './xps-image-header';
import { XPS_MAX_PART_BYTES } from './xps-reader';

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
/** The buffers that hold a part name in GhostXPS are 1,024 bytes (`char partname[1024]`), so a name is cut at 1,023 bytes and a terminator. */
const GHOSTXPS_NAME_BYTES = 1_023;

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

interface PartReferences {
  /** The images and colour profiles named outside any resource entry, by key: the parts the renderer decodes again for each naming. */
  readonly drawn: Counts;
  /** The images and colour profiles named inside each keyed entry of a resource dictionary, by the entry's key: decoded each time a page uses the entry. */
  readonly entries: Map<string, Counts>;
  /** The keys the part uses with `{StaticResource key}`, and how many times. */
  readonly uses: Counts;
  /** The fonts and resource dictionaries named, by key: the parts the renderer loads once. */
  readonly once: string[];
  /** The resource dictionaries named, by key; they are also in `once`. */
  readonly dictionaries: string[];
}

function directoryOf(part: string): string {
  return part.slice(0, part.lastIndexOf('/') + 1);
}

function withinNameBuffer(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= GHOSTXPS_NAME_BYTES ? text : bytes.subarray(0, GHOSTXPS_NAME_BYTES).toString('utf8');
}

/**
 * The key of the part that GhostXPS reads for `name`, held by a part in `holderDirectory`: `xps_absolute_path` and `xps_clean_path`
 * (xps/xpsmem.c lines 60 to 132). A name that starts with a slash is the part name, any other follows the directory of the holder;
 * empty and `.` elements go and `..` removes the element before it, and at the root it is dropped. The name is not decoded (a
 * `%20` is three characters of the name) and keeps a `#` or a space as they are.
 */
function ghostXpsPartKey(holderDirectory: string, name: string): string {
  const baseUri = holderDirectory === '' ? '' : `/${holderDirectory.slice(0, -1)}`;
  const kept: string[] = [];
  for (const element of withinNameBuffer(name.startsWith('/') ? name : `${baseUri}/${name}`).split('/')) {
    if (element === '' || element === '.') continue;
    if (element === '..') kept.pop();
    else kept.push(element);
  }
  return partKey(kept.join('/'));
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
    if (value.startsWith(CONTEXT_COLOR_PREFIX)) repeated.push(...(keyOfReference(directory, value.split(WHITESPACE)[1] ?? '') ?? []));
    const used = staticResourceKey(value);
    if (used !== undefined) uses.push(used);
  }
  const font = element.attrs.get(FONT_ATTRIBUTE);
  const source = element.local === DICTIONARY_ELEMENT ? element.attrs.get(DICTIONARY_ATTRIBUTE) : undefined;
  const dictionary = source === undefined ? undefined : keyOfReference(directory, source);
  const fontKey = font === undefined ? undefined : keyOfReference(directory, font);
  return { repeated, uses, once: fontKey === undefined ? [] : [fontKey], dictionary };
}

function countsOfEntry(entries: Map<string, Counts>, entry: string): Counts {
  let counts = entries.get(entry);
  if (counts === undefined) {
    counts = new Map();
    entries.set(entry, counts);
  }
  return counts;
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
  const references: PartReferences = { drawn: new Map(), entries: new Map(), uses: new Map(), once: [], dictionaries: [] };
  const pending: Visit[] = [{ element: root, entry: undefined }];
  while (pending.length > 0) {
    const { element, entry } = pending.pop() as Visit;
    const named = referencesOfElement(element, directory);
    const into = entry === undefined ? references.drawn : countsOfEntry(references.entries, entry);
    for (const key of named.repeated) bump(into, key);
    for (const key of named.uses) bump(references.uses, key);
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

/**
 * Refuses a document whose pages together name more than XPS_MAX_REPEATED_BYTES of images and colour profiles, or more than
 * `maxRepeatedPixels(timeoutMs)` pixels of images, which the renderer cannot decode in the run limit of the job. Each page is charged
 * the size of every existing image and colour profile for each time a brush names it (at least MIN_REFERENCE_COST_BYTES each)
 * and the pixels the header of each image declares: the brushes of the page, and those of the resource dictionaries it names
 * once for each `{StaticResource key}` of the page that names the key of one of their entries. The header of a part is read
 * once however many brushes name it, and only for a part a brush names: an entry nobody uses is not read. Fonts and dictionaries
 * are charged the first time a page names them. A dictionary that names a dictionary is charged for that one and its contents
 * are not followed, so a chain or a cycle of dictionaries costs one read each; every XML part is read once however many pages
 * name it. The reading stops at the first page over a budget. An image that a brush names, whose declared size is over the input
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
    const entries = new Map<string, Counts>();
    for (const [entry, counts] of references.entries) {
      const kept = existing(counts);
      if (kept.size > 0) entries.set(entry, kept);
    }
    return { ...references, drawn: existing(references.drawn), entries };
  };
  const dictionaryReferences = new Map<string, PartReferences>();
  const referencesOfDictionary = (dictionary: string): PartReferences => {
    let references = dictionaryReferences.get(dictionary);
    if (references === undefined) {
      const bytes = parts.get(dictionary);
      references = bytes === undefined ? { drawn: new Map(), entries: new Map(), uses: new Map(), once: [], dictionaries: [] } : existingOnly(referencesOf(dictionary, bytes));
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
    for (const source of [own, ...dictionaries]) {
      const candidates = named.uses.size <= source.entries.size ? named.uses.keys() : source.entries.keys();
      for (const entry of candidates) {
        const times = named.uses.get(entry);
        const counts = source.entries.get(entry);
        if (times === undefined || counts === undefined) continue;
        for (const [key, count] of counts) bump(demand, key, count * times);
      }
    }
    for (const [key, times] of demand) await chargeRepeated(key, times);
    for (const key of new Set([...named.once, ...dictionaries.flatMap((dictionary) => dictionary.once)])) {
      if (chargedOnce.has(key)) continue;
      chargedOnce.add(key);
      chargeOnce(key);
    }
  }
}
