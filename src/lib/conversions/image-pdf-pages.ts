import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import type { ConversionOptions } from '../types';
import { paletteAlphaPlane, splitAlphaPlanes } from './png-scanlines';
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
const PNG_COLOR_TYPE_PALETTE = 3;
const PNG_COLOR_TYPE_GRAY_ALPHA = 4;
const PNG_COLOR_TYPE_RGBA = 6;
const PNG_PALETTE_ENTRY_BYTES = 3;
/** ISO 32000-1 Table 10 (FlateDecode): predictor 15 is "PNG, the filter type of each row is in the row", as in a PNG's own data stream. */
const PNG_PREDICTOR = 15;
const OPAQUE = 255;

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
  embed(document: { ref(dictionary?: object): PdfReference }): void;
}

interface ParsedPng {
  width: number;
  height: number;
  bits: number;
  colorType: number;
  interlaced: boolean;
  /** The PLTE chunk. */
  palette: Buffer | null;
  /** The tRNS chunk. */
  transparency: Buffer | null;
  /** The IDAT chunks: together one zlib stream of filtered rows. */
  idat: Buffer[];
}

/** What the image XObject of a picture is made of; the objects are those PDFKit's PNG reader writes for the same PNG. */
interface PictureParts {
  width: number;
  height: number;
  /** `/BitsPerComponent` of the image. */
  bits: number;
  /** Grey or RGB, or the PLTE chunk of a palette picture (an `/Indexed /DeviceRGB` space). */
  colorSpace: 'DeviceGray' | 'DeviceRGB' | { palette: Buffer };
  /** The `/DecodeParms` of a stream that is the PNG's own data, null for a stream the planes were rebuilt into. */
  predictor: { colors: number; bits: number } | null;
  data: Buffer;
  /** The zlib stream of 8-bit alpha samples, for the `/SMask`. */
  softMask: Buffer | null;
}

/** The chunks of a PNG, or null for an animated one (`acTL`), one that runs past its end, or data that is not a PNG. */
function parsePng(png: Buffer): ParsedPng | null {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  let header: Omit<ParsedPng, 'palette' | 'transparency' | 'idat'> | null = null;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  let at = PNG_SIGNATURE.length;
  while (at + PNG_CHUNK_HEADER_BYTES <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const start = at + PNG_CHUNK_HEADER_BYTES;
    if (start + length + PNG_CHUNK_CRC_BYTES > png.length) return null;
    if (type === 'IHDR') {
      if (length !== PNG_IHDR_BYTES) return null;
      header = {
        width: png.readUInt32BE(start),
        height: png.readUInt32BE(start + 4),
        bits: png[start + 8],
        colorType: png[start + 9],
        interlaced: png[start + 12] !== 0,
      };
    } else if (type === 'acTL') {
      return null;
    } else if (type === 'PLTE') {
      palette = png.subarray(start, start + length);
    } else if (type === 'tRNS') {
      transparency = png.subarray(start, start + length);
    } else if (type === 'IDAT') {
      idat.push(png.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    at = start + length + PNG_CHUNK_CRC_BYTES;
  }
  return header === null || idat.length === 0 ? null : { ...header, palette, transparency, idat };
}

/** The alpha of each palette index from a tRNS chunk: the entries it lists, opaque for the rest. */
function paletteAlphas(transparency: Buffer): Uint8Array {
  const alphas = new Uint8Array(256).fill(OPAQUE);
  alphas.set(transparency.subarray(0, alphas.length));
  return alphas;
}

/**
 * The image of a non-interlaced PNG as PDFKit's reader would write it, or null for a PNG that is left to that reader (a colour key in
 * a grey or RGB PNG, a PLTE chunk in a PNG that does not index it, a bit depth the PDF has no sample for).
 * - Opaque grey or RGB, and a palette picture: the PNG's own data is the stream (`/Predictor 15`), a palette as `/Indexed /DeviceRGB`; a
 *   palette alpha (tRNS) becomes a soft mask built from the indices.
 * - Grey+alpha and RGBA: the channels are split, colour into the image and alpha into the soft mask, 16-bit samples cut to their top byte.
 */
async function picturePartsOf(png: ParsedPng): Promise<PictureParts | null> {
  const { width, height, bits, colorType, palette, transparency, idat } = png;
  const base = { width, height };
  if (colorType === PNG_COLOR_TYPE_GRAY || colorType === PNG_COLOR_TYPE_RGB) {
    if (palette !== null || transparency !== null) return null;
    const colors = colorType === PNG_COLOR_TYPE_RGB ? 3 : 1;
    return { ...base, bits, colorSpace: colors === 3 ? 'DeviceRGB' : 'DeviceGray', predictor: { colors, bits }, data: Buffer.concat(idat), softMask: null };
  }
  if (colorType === PNG_COLOR_TYPE_PALETTE) {
    if (palette === null || palette.length === 0 || palette.length % PNG_PALETTE_ENTRY_BYTES !== 0) return null;
    const softMask = transparency === null ? null : await paletteAlphaPlane(idat, width, height, bits, paletteAlphas(transparency));
    return { ...base, bits, colorSpace: { palette }, predictor: { colors: 1, bits }, data: Buffer.concat(idat), softMask };
  }
  if ((colorType === PNG_COLOR_TYPE_GRAY_ALPHA || colorType === PNG_COLOR_TYPE_RGBA) && palette === null) {
    const colors = colorType === PNG_COLOR_TYPE_RGBA ? 3 : 1;
    const planes = await splitAlphaPlanes(idat, width, height, colors, bits);
    return { ...base, bits: 8, colorSpace: colors === 3 ? 'DeviceRGB' : 'DeviceGray', predictor: null, data: planes.color, softMask: planes.alpha };
  }
  return null;
}

/**
 * The picture as a PDF image XObject, the objects PDFKit's PNG reader writes for the same PNG. That reader copies the data into an array
 * with one element per byte, which is eight bytes of heap for each byte of a noisy picture; this one keeps the buffers.
 */
function embeddedPicture(parts: PictureParts, label: string): EmbeddedPicture {
  let held: PictureParts | undefined = parts;
  const picture: EmbeddedPicture = {
    label,
    width: parts.width,
    height: parts.height,
    embed(document) {
      const { bits, colorSpace, predictor, data, softMask } = held as PictureParts;
      const object = document.ref({
        Type: 'XObject',
        Subtype: 'Image',
        BitsPerComponent: bits,
        Width: parts.width,
        Height: parts.height,
        Filter: 'FlateDecode',
      });
      if (predictor !== null) {
        const parameters = document.ref({ Predictor: PNG_PREDICTOR, Colors: predictor.colors, BitsPerComponent: predictor.bits, Columns: parts.width });
        object.data.DecodeParms = parameters;
        parameters.end();
      }
      if (typeof colorSpace === 'string') {
        object.data.ColorSpace = colorSpace;
      } else {
        const palette = document.ref();
        palette.end(colorSpace.palette);
        object.data.ColorSpace = ['Indexed', 'DeviceRGB', colorSpace.palette.length / PNG_PALETTE_ENTRY_BYTES - 1, palette];
      }
      if (softMask !== null) {
        const mask = document.ref({
          Type: 'XObject',
          Subtype: 'Image',
          Height: parts.height,
          Width: parts.width,
          BitsPerComponent: 8,
          Filter: 'FlateDecode',
          ColorSpace: 'DeviceGray',
          Decode: [0, 1],
        });
        mask.end(softMask);
        object.data.SMask = mask;
      }
      object.end(data);
      held = undefined;
      picture.obj = object;
    },
  };
  return picture;
}

/**
 * What `doc.image` is given for a picture: the embedded picture of a PNG that is read here, else the PNG itself, which PDFKit's reader
 * embeds. An interlaced PNG is first written again without interlacing by the image library, which keeps its channels and depth.
 */
async function pictureSource(png: Buffer, label: string): Promise<Buffer | EmbeddedPicture> {
  let parsed = parsePng(png);
  if (parsed?.interlaced) parsed = parsePng(await sharp(png).png().toBuffer());
  const parts = parsed === null || parsed.interlaced ? null : await picturePartsOf(parsed);
  return parts === null ? png : embeddedPicture(parts, label);
}

/** The PDF of `images`, one page each in order. */
export async function assemblePicturePdf(images: readonly PdfPageImage[], orientation: ConversionOptions['orientation']): Promise<Buffer> {
  const placements = images.map((image) => placementOf(image, orientation));
  const sources = await Promise.all(images.map((image, index) => pictureSource(image.png, `P${index + 1}`)));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [placements[0].page.width, placements[0].page.height], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    sources.forEach((source, index) => {
      const { page, picture } = placements[index];
      if (index > 0) doc.addPage({ size: [page.width, page.height], margin: 0 });
      // PDFKit's `image` takes any object with a size and an `embed` (its own image classes), which its typings do not list.
      doc.image(source as Buffer, picture.x, picture.y, { width: picture.width, height: picture.height });
    });
    doc.end();
  });
}
