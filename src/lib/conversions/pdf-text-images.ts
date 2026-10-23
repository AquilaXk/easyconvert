import type { PDFDict, PDFDocument, PDFStream } from 'pdf-lib';
import { PayloadLimitError } from '../types';
import { assertInputPixels } from './image-input-limits';
import { pdfjsImageToPng } from './pdf-rasterizer';
import {
  PDF_CONTENT_MAX_IMAGE_BYTES,
  PDF_CONTENT_MAX_PAGE_STREAM_BYTES,
  type PdfContentImage,
} from './pdf-text-types';

/** pdf-lib takes 27 ms to load, so a thread loads it for its first page with images and not when it starts (see pdf-text-host.ts). sharp, 11 ms, still loads with the module through image-input-limits. */
type PdfLib = typeof import('pdf-lib');

/**
 * The files of the images a page places: the PDF's own JPEG stream, byte for byte, when the image is a plain JPEG
 * (DCTDecode alone, 8-bit gray or RGB, no mask), otherwise a PNG of the pixels pdfjs decoded. The JPEG streams
 * are found with pdf-lib: the page's `Do` operators, in drawing order, name the image XObjects, and they are matched
 * to the placements pdfjs reported by position and pixel size. Any page where that does not line up (images inside
 * forms, inline images) takes the PNG route for all its images.
 */

const JPEG_SOI = [0xff, 0xd8];
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_START_OF_SCAN = 0xda;
const JPEG_END_OF_IMAGE = 0xd9;
const JPEG_FIRST_SOF = 0xc0;
const JPEG_LAST_SOF = 0xcf;
const JPEG_NOT_SOF = new Set([0xc4, 0xc8, 0xcc]);
const JPEG_ADOBE_APP14 = 0xee;
const SEGMENT_HEADER_BYTES = 2;
const SOF_COMPONENTS_OFFSET = 7;
const BITS_PER_COMPONENT = 8;
const DO_OPERATOR = /\/([^\s/<>[\](){}%]+)\s+Do(?![A-Za-z0-9*'"])/g;
const NAME_ESCAPE = /#([0-9a-fA-F]{2})/g;
const GRAY_OR_RGB = new Set(['DeviceGray', 'DeviceRGB']);

interface JpegCandidate {
  pixelWidth: number;
  pixelHeight: number;
  /** The stream when it can be passed through, else null. */
  jpeg: Uint8Array | null;
}

function nameOf(lib: PdfLib, value: unknown): string | undefined {
  return value instanceof lib.PDFName ? value.decodeText() : undefined;
}

function numberOf(lib: PdfLib, value: unknown): number | undefined {
  return value instanceof lib.PDFNumber ? value.asNumber() : undefined;
}

/** Components of a baseline or progressive JPEG, or 0 for anything else (CMYK data needs more than 3). */
function jpegComponents(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== JPEG_SOI[0] || bytes[1] !== JPEG_SOI[1]) return 0;
  let at = 2;
  let components = 0;
  let adobeTransform: number | null = null;
  while (at + SEGMENT_HEADER_BYTES < bytes.length) {
    if (bytes[at] !== JPEG_MARKER_PREFIX) return 0;
    const marker = bytes[at + 1];
    if (marker === JPEG_START_OF_SCAN || marker === JPEG_END_OF_IMAGE) break;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < SEGMENT_HEADER_BYTES) return 0;
    if (marker >= JPEG_FIRST_SOF && marker <= JPEG_LAST_SOF && !JPEG_NOT_SOF.has(marker)) components = bytes[at + 2 + SOF_COMPONENTS_OFFSET] ?? 0;
    if (marker === JPEG_ADOBE_APP14) adobeTransform = 0;
    at += SEGMENT_HEADER_BYTES + length;
  }
  // Adobe-marked three-component data may be in an unusual colour space; keep only plain JFIF-style files.
  if (adobeTransform !== null) return 0;
  return components === 1 || components === 3 ? components : 0;
}

function decodedStream(lib: PdfLib, stream: PDFStream, limit: { left: number }): Uint8Array | null {
  if (!(stream instanceof lib.PDFRawStream)) return null;
  const bytes = lib.decodePDFRawStream(stream).decode();
  limit.left -= bytes.length;
  return limit.left < 0 ? null : bytes;
}

function filterIsOnlyDct(lib: PdfLib, dict: PDFDict): boolean {
  const filter = dict.lookup(lib.PDFName.of('Filter'));
  if (filter instanceof lib.PDFName) return filter.decodeText() === 'DCTDecode';
  if (filter instanceof lib.PDFArray && filter.size() === 1) return nameOf(lib, filter.lookup(0)) === 'DCTDecode';
  return false;
}

function candidateOf(lib: PdfLib, stream: PDFStream): JpegCandidate | null {
  const { PDFName } = lib;
  const dict = stream.dict;
  const pixelWidth = numberOf(lib, dict.lookup(PDFName.of('Width')));
  const pixelHeight = numberOf(lib, dict.lookup(PDFName.of('Height')));
  if (pixelWidth === undefined || pixelHeight === undefined) return null;
  const plain =
    filterIsOnlyDct(lib, dict) &&
    GRAY_OR_RGB.has(nameOf(lib, dict.lookup(PDFName.of('ColorSpace'))) ?? '') &&
    numberOf(lib, dict.lookup(PDFName.of('BitsPerComponent'))) === BITS_PER_COMPONENT &&
    !dict.has(PDFName.of('SMask')) &&
    !dict.has(PDFName.of('Mask')) &&
    !dict.has(PDFName.of('Decode')) &&
    !dict.has(PDFName.of('ImageMask'));
  if (!plain || !(stream instanceof lib.PDFRawStream)) return { pixelWidth, pixelHeight, jpeg: null };
  const bytes = stream.getContents();
  return { pixelWidth, pixelHeight, jpeg: jpegComponents(bytes) > 0 ? bytes : null };
}

/** Reads the PDF's image XObjects page by page with pdf-lib. */
class JpegCatalog {
  private document: PDFDocument | null | undefined;

  constructor(private readonly bytes: Uint8Array) {}

  private async open(lib: PdfLib): Promise<PDFDocument | null> {
    if (this.document === undefined) {
      try {
        this.document = await lib.PDFDocument.load(this.bytes, { ignoreEncryption: false, throwOnInvalidObject: false, updateMetadata: false });
      } catch {
        this.document = null;
      }
    }
    return this.document;
  }

  /** The image XObjects the page's own content draws, in drawing order; null when they cannot be read. */
  async imagesOfPage(pageIndex: number): Promise<JpegCandidate[] | null> {
    const lib = await import('pdf-lib');
    const { PDFArray, PDFDict, PDFName, PDFStream } = lib;
    const document = await this.open(lib);
    if (!document || pageIndex >= document.getPageCount()) return null;
    const leaf = document.getPage(pageIndex).node;
    const resources = leaf.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const contents = leaf.Contents();
    if (!xobjects || !contents) return [];
    const streams: PDFStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const entry = contents.lookup(i);
        if (entry instanceof PDFStream) streams.push(entry);
      }
    } else {
      streams.push(contents);
    }
    const limit = { left: PDF_CONTENT_MAX_PAGE_STREAM_BYTES };
    let text = '';
    for (const stream of streams) {
      const bytes = decodedStream(lib, stream, limit);
      if (bytes === null) return null;
      text += `${Buffer.from(bytes).toString('latin1')}\n`;
    }
    const candidates: JpegCandidate[] = [];
    for (const match of text.matchAll(DO_OPERATOR)) {
      const name = match[1].replace(NAME_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      const target = xobjects.lookup(PDFName.of(name));
      if (!(target instanceof PDFStream)) continue;
      if (nameOf(lib, target.dict.lookup(PDFName.of('Subtype'))) !== 'Image') continue;
      const candidate = candidateOf(lib, target);
      if (candidate === null) return null;
      candidates.push(candidate);
    }
    return candidates;
  }
}

/** What the operator list says about how an image is painted, kept beside the placement. */
export interface ImageSource {
  objId?: string;
  inline?: unknown;
}

/** pdf.js's `PDFObjects`: `get(id)` reads a delivered object, `get(id, callback)` calls back once it is delivered. */
interface ObjectPool {
  has(id: string): boolean;
  get(id: string, callback?: (data: unknown) => void): unknown;
}

/** The two object tables of a pdf.js page: its own, and the one shared by the pages of the document. */
export interface PagePools {
  objs: ObjectPool;
  commonObjs: ObjectPool;
}

/** pdf.js keeps a picture that several pages paint in the shared table, under an id that starts with this (src/display/canvas.js, executeOperatorList). */
const COMMON_ID_PREFIX = 'g_';

/**
 * A decoded picture as pdf.js delivers it. The worker decodes a picture in a task of its own and posts it to the page
 * after the operator list has resolved, so it may not be there yet when the list is read. pdf.js's own renderer waits for
 * it at the list's `dependency` operator (`objsPool.get(id, callback)`) and so does this. A picture that cannot be decoded
 * arrives as null, so the wait always ends; a document that never delivers one runs into the thread's deadline.
 */
function deliveredPicture(pools: PagePools, id: string): Promise<unknown> {
  const pool = id.startsWith(COMMON_ID_PREFIX) ? pools.commonObjs : pools.objs;
  if (pool.has(id)) return Promise.resolve(pool.get(id));
  return new Promise((resolve) => {
    pool.get(id, resolve);
  });
}

/** Loads what reading images needs (pdf-lib), for a thread that is about to read documents with images. */
export async function preloadImageReader(): Promise<void> {
  await import('pdf-lib');
}

/** Attaches the files of the images a document places, within a byte budget for the whole document. */
export class ImageExtractor {
  private readonly catalog: JpegCatalog;
  private bytesLeft = PDF_CONTENT_MAX_IMAGE_BYTES;

  constructor(pdf: Uint8Array) {
    this.catalog = new JpegCatalog(pdf);
  }

  private take(bytes: number): void {
    this.bytesLeft -= bytes;
    if (this.bytesLeft < 0) throw new PayloadLimitError(`The images of the PDF are more than ${PDF_CONTENT_MAX_IMAGE_BYTES} bytes.`);
  }

  async attach(pageIndex: number, pools: PagePools, images: PdfContentImage[], sources: ImageSource[]): Promise<void> {
    if (images.length === 0) return;
    const candidates = await this.catalog.imagesOfPage(pageIndex);
    const aligned =
      candidates !== null &&
      candidates.length === images.length &&
      candidates.every((candidate, index) => candidate.pixelWidth === images[index].pixelWidth && candidate.pixelHeight === images[index].pixelHeight);
    for (const [index, image] of images.entries()) {
      const passthrough = aligned ? candidates[index].jpeg : null;
      if (passthrough) {
        this.take(passthrough.length);
        image.data = passthrough;
        image.format = 'jpeg';
        continue;
      }
      const source = sources[index];
      const decoded = source.inline ?? (source.objId === undefined ? undefined : await deliveredPicture(pools, source.objId));
      if (decoded === undefined) continue;
      assertInputPixels(image.pixelWidth, image.pixelHeight);
      const png = await pdfjsImageToPng(decoded);
      if (!png) continue;
      this.take(png.png.length);
      image.data = new Uint8Array(png.png);
      image.format = 'png';
    }
  }
}
