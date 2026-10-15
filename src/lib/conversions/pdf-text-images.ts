import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { PayloadLimitError } from '../types';
import { assertInputPixels } from './image-input-limits';
import { pdfjsImageToPng } from './pdf-rasterizer';
import {
  PDF_CONTENT_MAX_IMAGE_BYTES,
  PDF_CONTENT_MAX_PAGE_STREAM_BYTES,
  type PdfContentImage,
} from './pdf-text-types';

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

function nameOf(value: unknown): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return value instanceof PDFNumber ? value.asNumber() : undefined;
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

function decodedStream(stream: PDFStream, limit: { left: number }): Uint8Array | null {
  if (!(stream instanceof PDFRawStream)) return null;
  const bytes = decodePDFRawStream(stream).decode();
  limit.left -= bytes.length;
  return limit.left < 0 ? null : bytes;
}

function filterIsOnlyDct(dict: PDFDict): boolean {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return filter.decodeText() === 'DCTDecode';
  if (filter instanceof PDFArray && filter.size() === 1) return nameOf(filter.lookup(0)) === 'DCTDecode';
  return false;
}

function candidateOf(stream: PDFStream): JpegCandidate | null {
  const dict = stream.dict;
  const pixelWidth = numberOf(dict.lookup(PDFName.of('Width')));
  const pixelHeight = numberOf(dict.lookup(PDFName.of('Height')));
  if (pixelWidth === undefined || pixelHeight === undefined) return null;
  const plain =
    filterIsOnlyDct(dict) &&
    GRAY_OR_RGB.has(nameOf(dict.lookup(PDFName.of('ColorSpace'))) ?? '') &&
    numberOf(dict.lookup(PDFName.of('BitsPerComponent'))) === BITS_PER_COMPONENT &&
    !dict.has(PDFName.of('SMask')) &&
    !dict.has(PDFName.of('Mask')) &&
    !dict.has(PDFName.of('Decode')) &&
    !dict.has(PDFName.of('ImageMask'));
  if (!plain || !(stream instanceof PDFRawStream)) return { pixelWidth, pixelHeight, jpeg: null };
  const bytes = stream.getContents();
  return { pixelWidth, pixelHeight, jpeg: jpegComponents(bytes) > 0 ? bytes : null };
}

/** Reads the PDF's image XObjects page by page with pdf-lib. */
class JpegCatalog {
  private document: PDFDocument | null | undefined;

  constructor(private readonly bytes: Uint8Array) {}

  private async open(): Promise<PDFDocument | null> {
    if (this.document === undefined) {
      try {
        this.document = await PDFDocument.load(this.bytes, { ignoreEncryption: false, throwOnInvalidObject: false, updateMetadata: false });
      } catch {
        this.document = null;
      }
    }
    return this.document;
  }

  /** The image XObjects the page's own content draws, in drawing order; null when they cannot be read. */
  async imagesOfPage(pageIndex: number): Promise<JpegCandidate[] | null> {
    const document = await this.open();
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
      const bytes = decodedStream(stream, limit);
      if (bytes === null) return null;
      text += `${Buffer.from(bytes).toString('latin1')}\n`;
    }
    const candidates: JpegCandidate[] = [];
    for (const match of text.matchAll(DO_OPERATOR)) {
      const name = match[1].replace(NAME_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      const target = xobjects.lookup(PDFName.of(name));
      if (!(target instanceof PDFStream)) continue;
      if (nameOf(target.dict.lookup(PDFName.of('Subtype'))) !== 'Image') continue;
      const candidate = candidateOf(target);
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

interface ObjectStore {
  has(id: string): boolean;
  get(id: string): unknown;
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

  async attach(pageIndex: number, objs: ObjectStore, images: PdfContentImage[], sources: ImageSource[]): Promise<void> {
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
      const decoded = source.inline ?? (source.objId !== undefined && objs.has(source.objId) ? objs.get(source.objId) : undefined);
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
