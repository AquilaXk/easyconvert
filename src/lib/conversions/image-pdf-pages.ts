import PDFDocument from 'pdfkit';
import type { ConversionOptions } from '../types';
import { pageSizePoints, withinPageLimit, type PageSize, type PrintDensity } from './image-print-density';

/**
 * A PDF with one picture to the page. A page is the picture at its stored print size (pixels x 72 / dpi on each axis, see
 * image-print-density.ts), scaled evenly to 14400 points on its longer side when it would be longer; the pixels are the picture's own,
 * placed over the whole picture rectangle. A requested landscape orientation turns a portrait page, and the picture is then fitted
 * inside it and centred.
 */

/** One PDF page: the oriented picture as PNG, its pixel size and the density it is shown at. */
export interface PdfPageImage {
  png: Buffer;
  width: number;
  height: number;
  density: PrintDensity;
}

interface PagePlacement {
  page: PageSize;
  /** Where the picture goes: its size on the page and the offset of its top-left corner. */
  picture: PageSize & { x: number; y: number };
}

function placementOf(image: PdfPageImage, orientation: ConversionOptions['orientation']): PagePlacement {
  const size = withinPageLimit(pageSizePoints(image.width, image.height, image.density));
  const isLandscape = orientation === 'landscape' || (size.width > size.height && !orientation);
  // The size is already [width, height] in the final orientation, so no layout swap is applied.
  const page = isLandscape ? { width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) } : size;
  const scale = Math.min(page.width / size.width, page.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { page, picture: { width, height, x: (page.width - width) / 2, y: (page.height - height) / 2 } };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_CRC_BYTES = 4;
const PNG_IHDR_BYTES = 13;
const PNG_COLOR_TYPE_GRAY = 0;
const PNG_COLOR_TYPE_RGB = 2;
/** ISO 32000-1 Table 10 (FlateDecode): predictor 15 is "PNG, the filter type of each row is in the row", as in a PNG's own data stream. */
const PNG_PREDICTOR = 15;

/** The parts of a PDFKit reference this file uses (PDFKit's typings leave it out). */
interface PdfReference {
  data: Record<string, unknown>;
  end(chunk?: Buffer): void;
}

/** What PDFKit's `image` takes in place of a buffer: a width, a height, a label for the page's resources, and `embed`, which sets `obj`. */
interface EmbeddedPicture {
  label: string;
  width: number;
  height: number;
  obj?: PdfReference;
  embed(document: { ref(dictionary: object): PdfReference }): void;
}

interface PlainPng {
  width: number;
  height: number;
  bits: number;
  colors: 1 | 3;
  /** The concatenated IDAT chunks: one zlib stream of filtered rows. */
  data: Buffer;
}

/**
 * The size, depth and image data of a PNG that is opaque (grey or RGB with no palette and no colour key) and not interlaced, or null
 * for any other PNG, which PDFKit's reader embeds (it separates an alpha channel into a soft mask, decodes an interlaced image, builds a palette).
 */
function readPlainPng(png: Buffer): PlainPng | null {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  let header: Omit<PlainPng, 'data'> | null = null;
  const idat: Buffer[] = [];
  let at = PNG_SIGNATURE.length;
  while (at + PNG_CHUNK_HEADER_BYTES <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const start = at + PNG_CHUNK_HEADER_BYTES;
    if (start + length + PNG_CHUNK_CRC_BYTES > png.length) return null;
    if (type === 'IHDR') {
      if (length !== PNG_IHDR_BYTES) return null;
      const colorType = png[start + 9];
      const interlaced = png[start + 12] !== 0;
      if (interlaced || (colorType !== PNG_COLOR_TYPE_GRAY && colorType !== PNG_COLOR_TYPE_RGB)) return null;
      header = {
        width: png.readUInt32BE(start),
        height: png.readUInt32BE(start + 4),
        bits: png[start + 8],
        colors: colorType === PNG_COLOR_TYPE_RGB ? 3 : 1,
      };
    } else if (type === 'PLTE' || type === 'tRNS' || type === 'acTL') {
      return null;
    } else if (type === 'IDAT') {
      idat.push(png.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    at = start + length + PNG_CHUNK_CRC_BYTES;
  }
  return header === null || idat.length === 0 ? null : { ...header, data: Buffer.concat(idat) };
}

/**
 * The picture as a PDF image XObject whose stream is the PNG's own data (`/FlateDecode` with a PNG predictor), the object PDFKit's PNG
 * reader writes for the same PNG. That reader copies the data into an array with one element per byte, which is eight bytes of heap
 * for each byte of a noisy picture; this one keeps the buffers.
 */
function embeddedPicture(plain: PlainPng, label: string): EmbeddedPicture {
  let data: Buffer | undefined = plain.data;
  const picture: EmbeddedPicture = {
    label,
    width: plain.width,
    height: plain.height,
    embed(document) {
      const object = document.ref({
        Type: 'XObject',
        Subtype: 'Image',
        BitsPerComponent: plain.bits,
        Width: plain.width,
        Height: plain.height,
        Filter: 'FlateDecode',
      });
      const parameters = document.ref({ Predictor: PNG_PREDICTOR, Colors: plain.colors, BitsPerComponent: plain.bits, Columns: plain.width });
      object.data.DecodeParms = parameters;
      parameters.end();
      object.data.ColorSpace = plain.colors === 3 ? 'DeviceRGB' : 'DeviceGray';
      object.end(data);
      data = undefined;
      picture.obj = object;
    },
  };
  return picture;
}

/** The PDF of `images`, one page each in order. */
export function assemblePicturePdf(images: readonly PdfPageImage[], orientation: ConversionOptions['orientation']): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const placements = images.map((image) => placementOf(image, orientation));
    const doc = new PDFDocument({ size: [placements[0].page.width, placements[0].page.height], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    images.forEach((image, index) => {
      const { page, picture } = placements[index];
      if (index > 0) doc.addPage({ size: [page.width, page.height], margin: 0 });
      const plain = readPlainPng(image.png);
      // PDFKit's `image` takes any object with a size and an `embed` (its own image classes), which its typings do not list.
      const source = plain === null ? image.png : (embeddedPicture(plain, `P${index + 1}`) as unknown as Buffer);
      doc.image(source, picture.x, picture.y, { width: picture.width, height: picture.height });
    });
    doc.end();
  });
}
