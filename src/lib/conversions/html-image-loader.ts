import sharp from 'sharp';
import { ConversionFailedError } from '../types';
import type { HtmlElement } from './html-blocks';
import {
  findExternalImages,
  normalizeUrl,
  OmittedExternalImages,
  quoted,
  srcsetCandidates,
  stripControls,
  type ExternalImage,
  type HtmlResourcePolicy,
  type SrcsetCandidate,
} from './html-omitted-resources';
import { currentImageFetchSession, IMAGE_FETCH_LIMITS, ImageFetchRefusal, type FetchedImage, type ImageFetchSession } from './html-image-fetch';

/**
 * Loads the external images of an HTML tree before it is rendered and puts them into the tree as base64 data: URIs, so
 * both renderers (the in-process one and the staging for LibreOffice) see only embedded images and never touch the
 * network. This is the only place that fetches; the fetching itself, with its guards against request forgery, is in
 * html-image-fetch.ts.
 *
 * - `<img src>` and `<img srcset>`: one candidate is loaded (see pickCandidate).
 * - `<picture><source srcset>`: the first source of a supported type that loads replaces the picture's `<img>`, as a
 *   browser would; the other sources are dropped.
 * - An absolute http or https `<base href>` is honoured for the relative image URLs, as a browser does, with the same
 *   guards; the `<base>` element is removed from the tree afterwards (nothing renders it).
 * - An image that cannot be loaded (refused address, failed or oversize fetch, not an image, not an absolute http or
 *   https URL) is left out of the tree and reported; with `requireResources` it is a 400 instead.
 */

/** What the renderers can embed, so the loader never hands them more than they accept. */
export interface ImageCaps {
  /** Most images one document embeds, data: URIs already in it included. */
  maxImages: number;
  /** Most pixels in one image. */
  maxImagePixels: number;
  /** Most pixels in all images of the document. */
  maxDocumentPixels: number;
}

const PICTURE_TAG = 'picture';
const SOURCE_TAG = 'source';
const IMAGE_TAG = 'img';
const BASE_TAG = 'base';
const SRC_ATTRIBUTE = 'src';
const DATA_URI_PREFIX = /^data:/i;
const HTTP_URL = /^https?:\/\//i;
/** Attributes of an `<img>` that choose or size the image to load; the loaded data replaces them. */
const REPLACED_IMAGE_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'srcset', 'sizes']);
/** Source types a picture can use here; a source of another type (AVIF, SVG) is skipped, as an unsupporting browser does. */
const SUPPORTED_SOURCE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
/** Viewport width, in CSS pixels, that `w` descriptors are compared with (a print page). */
const PRINT_VIEWPORT_WIDTH = 800;
const NOT_ABSOLUTE = 'only absolute http and https images are loaded';

function descriptorDensity(descriptor: string): number {
  const density = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
  if (density) return Number(density[1]);
  const width = /^(\d+)w$/i.exec(descriptor);
  if (width) return Number(width[1]) / PRINT_VIEWPORT_WIDTH;
  return 1;
}

/**
 * The one srcset candidate to load: the lowest density that is at least 1x (a `w` descriptor counts as its width over
 * an 800 px page), else the highest density there is. Ties go to the earlier candidate.
 */
export function pickCandidate(candidates: readonly SrcsetCandidate[]): SrcsetCandidate | undefined {
  let best: SrcsetCandidate | undefined;
  let bestDensity = 0;
  for (const candidate of candidates) {
    const density = descriptorDensity(candidate.descriptor);
    const better =
      best === undefined ||
      (bestDensity < 1 && density > bestDensity) ||
      (density >= 1 && (bestDensity < 1 || density < bestDensity));
    if (better) {
      best = candidate;
      bestDensity = density;
    }
  }
  return best;
}

/** The URL an element asks for: its picked srcset candidate, else its src; empty when it names none. */
function requestedUrl(element: HtmlElement): string {
  const candidate = pickCandidate(srcsetCandidates(stripControls(element.attrs.get('srcset') ?? '')).filter((entry) => normalizeUrl(entry.url) !== ''));
  if (candidate) return normalizeUrl(candidate.url);
  return normalizeUrl(element.attrs.get(SRC_ATTRIBUTE) ?? '');
}

function countEmbeddedImages(element: HtmlElement): number {
  let count = 0;
  for (const child of element.children) {
    if (typeof child === 'string') continue;
    if (child.tag === IMAGE_TAG && DATA_URI_PREFIX.test(normalizeUrl(child.attrs.get(SRC_ATTRIBUTE) ?? ''))) count++;
    count += countEmbeddedImages(child);
  }
  return count;
}

function isSupportedSourceType(source: HtmlElement): boolean {
  const type = (source.attrs.get('type') ?? '').split(';')[0].trim().toLowerCase();
  return type === '' || SUPPORTED_SOURCE_TYPES.has(type);
}

interface PreparedImage {
  dataUri: string;
  pixels: number;
}

/** Checks the fetched bytes decode as the image their signature says, within the pixel caps, and embeds them as PNG or JPEG. */
async function prepareImage(fetched: FetchedImage, caps: ImageCaps): Promise<PreparedImage> {
  const expected = fetched.mime.slice('image/'.length);
  try {
    const metadata = await sharp(fetched.bytes, { limitInputPixels: false }).metadata();
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (metadata.format !== expected || pixels <= 0) throw new ImageFetchRefusal('the image is not valid');
    if (pixels > caps.maxImagePixels) {
      throw new ImageFetchRefusal(`the image is ${metadata.width}x${metadata.height} pixels, above the limit of ${caps.maxImagePixels} pixels`);
    }
    const decoder = sharp(fetched.bytes, { limitInputPixels: caps.maxImagePixels });
    if (fetched.mime === 'image/png' || fetched.mime === 'image/jpeg') {
      await decoder.raw().toBuffer();
      return { dataUri: `data:${fetched.mime};base64,${fetched.bytes.toString('base64')}`, pixels };
    }
    // GIF and WebP are redrawn as PNG (first frame), the form both renderers accept.
    const redrawn = await decoder.png().toBuffer();
    if (redrawn.length > IMAGE_FETCH_LIMITS.maxImageBytes) {
      throw new ImageFetchRefusal(`the image is larger than ${IMAGE_FETCH_LIMITS.maxImageBytes} bytes once decoded`);
    }
    return { dataUri: `data:image/png;base64,${redrawn.toString('base64')}`, pixels };
  } catch (error) {
    if (error instanceof ImageFetchRefusal) throw error;
    throw new ImageFetchRefusal('the image could not be decoded');
  }
}

function withData(original: HtmlElement | undefined, dataUri: string): HtmlElement {
  const attrs = new Map<string, string>();
  for (const [name, value] of original?.attrs ?? []) if (!REPLACED_IMAGE_ATTRIBUTES.has(name)) attrs.set(name, value);
  attrs.set(SRC_ATTRIBUTE, dataUri);
  return { tag: IMAGE_TAG, attrs, children: [] };
}

export function unloadableImageRefusal(reference: string, reason: string | null): ConversionFailedError {
  if (reason === null || reason === NOT_ABSOLUTE) {
    return new ConversionFailedError(
      `HTML image "${quoted(reference)}" is an external reference that cannot be loaded (${NOT_ABSOLUTE}); embed it as a data: URI`
    );
  }
  return new ConversionFailedError(`HTML image "${quoted(reference)}" could not be loaded: ${reason}`);
}

/**
 * The document's base URL when its first `<base href>` is an absolute http or https URL; that element is removed from
 * the tree. A base of any other kind is left where it is, for the staging to refuse as it does any such reference.
 */
function takeDocumentBase(root: HtmlElement): URL | null {
  const visit = (parent: HtmlElement): URL | null => {
    for (const [index, child] of parent.children.entries()) {
      if (typeof child === 'string') continue;
      if (child.tag === BASE_TAG && child.attrs.has('href')) {
        const href = normalizeUrl(child.attrs.get('href') ?? '');
        if (!HTTP_URL.test(href)) return null;
        try {
          const base = new URL(href);
          parent.children[index] = '';
          return base;
        } catch {
          return null;
        }
      }
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(root);
}

class ImageLoader {
  /** For each picture whose image came from a source, the index of the child that now holds it. */
  private readonly pictures = new Map<HtmlElement, number>();
  private room: number;
  private pixels = 0;

  constructor(
    private readonly policy: HtmlResourcePolicy,
    private readonly omitted: OmittedExternalImages,
    private readonly caps: ImageCaps,
    private readonly session: ImageFetchSession,
    private readonly base: URL | null,
    embedded: number
  ) {
    this.room = caps.maxImages - embedded;
  }

  async load(image: ExternalImage): Promise<void> {
    const element = image.parent.children[image.index] as HtmlElement;
    if (image.parent.tag === PICTURE_TAG) {
      await this.loadPictureMember(image, element);
      return;
    }
    const loaded = await this.attempt(image.reference, requestedUrl(element));
    image.parent.children[image.index] = loaded === null ? '' : withData(element, loaded);
  }

  /** A `<source>` or `<img>` of a `<picture>`: the first source that loads becomes the picture's image. */
  private async loadPictureMember(image: ExternalImage, element: HtmlElement): Promise<void> {
    const picture = image.parent;
    const winner = this.pictures.get(picture);
    if (element.tag === IMAGE_TAG) {
      if (winner !== undefined) {
        // An earlier source provides the image, in this element or in the picture's first one; a second one is dropped.
        if (image.index !== winner) picture.children[image.index] = '';
      } else {
        const loaded = await this.attempt(image.reference, requestedUrl(element));
        picture.children[image.index] = loaded === null ? '' : withData(element, loaded);
      }
      return;
    }
    picture.children[image.index] = '';
    if (winner !== undefined || !isSupportedSourceType(element)) return;
    const loaded = await this.attempt(image.reference, requestedUrl(element));
    if (loaded === null) return;
    const fallback = picture.children.findIndex((child) => typeof child !== 'string' && child.tag === IMAGE_TAG);
    const target = fallback >= 0 ? fallback : image.index;
    this.pictures.set(picture, target);
    picture.children[target] = withData(fallback >= 0 ? (picture.children[fallback] as HtmlElement) : undefined, loaded);
  }

  /** The data: URI of the image at `url`, or null once the failure is reported (or throws with requireResources). */
  private async attempt(reference: string, url: string): Promise<string | null> {
    try {
      return await this.dataUri(url);
    } catch (error) {
      if (!(error instanceof ImageFetchRefusal)) throw error;
      if (this.policy.requireResources) throw unloadableImageRefusal(reference, error.message === NOT_ABSOLUTE ? null : error.message);
      this.omitted.add(reference, error.message);
      return null;
    }
  }

  /** The absolute URL of a reference: as written, or resolved against the document's base; null when it has none. */
  private absoluteUrl(url: string): string | null {
    if (HTTP_URL.test(url)) return url;
    if (this.base === null || url === '') return null;
    try {
      const resolved = new URL(url, this.base);
      return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
    } catch {
      return null;
    }
  }

  private async dataUri(reference: string): Promise<string> {
    if (DATA_URI_PREFIX.test(reference)) return reference;
    const url = this.absoluteUrl(reference);
    if (url === null) throw new ImageFetchRefusal(NOT_ABSOLUTE);
    if (this.room <= 0) throw new ImageFetchRefusal(`the document already holds the most images it can embed (${this.caps.maxImages})`);
    const prepared = await prepareImage(await this.session.fetch(url), this.caps);
    if (this.pixels + prepared.pixels > this.caps.maxDocumentPixels) {
      throw new ImageFetchRefusal(`the images of the document would pass ${this.caps.maxDocumentPixels} pixels together`);
    }
    this.room--;
    this.pixels += prepared.pixels;
    return prepared.dataUri;
  }
}

/**
 * Replaces every external image of the tree by the image it names, loaded and embedded, or removes it and records why
 * (see the module comment). Throws ConversionFailedError for an image that cannot be loaded when `requireResources`.
 */
export async function loadExternalImages(
  root: HtmlElement,
  policy: HtmlResourcePolicy,
  omitted: OmittedExternalImages,
  caps: ImageCaps
): Promise<void> {
  const base = takeDocumentBase(root);
  const images = findExternalImages(root);
  if (images.length === 0) return;
  const loader = new ImageLoader(policy, omitted, caps, currentImageFetchSession(policy.signal), base, countEmbeddedImages(root));
  // One after another on purpose: the size, count and time caps are shared, so the order decides which image is left out.
  for (const image of images) await loader.load(image); // NOSONAR S9382
}
