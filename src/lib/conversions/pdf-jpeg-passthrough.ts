import zlib from 'node:zlib';
import {
  concatTransformationMatrix,
  drawObject,
  PDFArray,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  type PDFRef,
} from 'pdf-lib';
import { ConversionFailedError } from '../types';
import { assertInputPixels } from './image-input-limits';

/**
 * JPEG into PDF without re-encoding: the file's bytes become the stream of an image XObject with
 * `/Filter /DCTDecode` (ISO 32000-1 7.4.8), which every PDF reader decodes itself. Only baseline, extended
 * sequential and progressive JPEGs of 8 bits with 1, 3 or 4 components qualify (SOF0, SOF1, SOF2); anything
 * else, and any file whose header cannot be read, is left to the decode-and-re-encode path.
 *
 * The colour space follows the component count (DeviceGray, DeviceRGB, DeviceCMYK); an embedded ICC profile of
 * the matching colour model becomes `/ICCBased`; a CMYK JPEG that carries the Adobe APP14 marker stores its
 * samples inverted (Photoshop convention), which `/Decode [1 0 1 0 1 0 1 0]` undoes. The page is the size the
 * picture says it is (pixels and density, 72 per inch when it says nothing), and an EXIF orientation is a
 * transformation matrix on the picture, never a re-encode (EXIF 2.32 / CIPA DC-008, tag 0x0112).
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const MARKER_PREFIX = 0xff;
const TEM = 0x01;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;
/** Frame types a PDF DCTDecode filter reads: baseline, extended sequential, progressive (all Huffman coded). */
const PDF_FRAME_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2]);
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const SEGMENT_LENGTH_BYTES = 2;
const SOF_FIXED_BYTES = 6;
const SOF_COMPONENT_BYTES = 3;
const MIN_COMPONENTS = 1;
const SUPPORTED_COMPONENTS: ReadonlySet<number> = new Set([1, 3, 4]);
const SAMPLE_PRECISION = 8;
/** `ICC_PROFILE\0` plus a sequence number and a count: the prefix of every APP2 chunk of a profile. */
const ICC_TAG = Buffer.from('ICC_PROFILE\0', 'latin1');
const ICC_CHUNK_HEADER_BYTES = ICC_TAG.length + 2;
const MAX_ICC_CHUNKS = 255;
/** Largest profile accepted from a JPEG; an APP2 chunk holds under 64 KiB so this is 255 chunks at most. */
export const JPEG_ICC_MAX_BYTES = 16 * 1024 * 1024;
const ICC_HEADER_BYTES = 128;
const ICC_COLOR_SPACE_OFFSET = 16;
const ICC_SIGNATURE_OFFSET = 36;
const ICC_PROFILE_COMPONENTS: Readonly<Record<string, number>> = { 'RGB ': 3, GRAY: 1, CMYK: 4 };
const ADOBE_TAG = 'Adobe';
const ADOBE_MIN_BYTES = 12;
const POINTS_PER_INCH = 72;
/** Largest page side the common readers accept (ISO 32000-1 Annex C.2: 14400 units). */
const PDF_MAX_PAGE_POINTS = 14_400;
const CM_PER_INCH = 2.54;
const DEFAULT_DENSITY_DPI = 72;
/** EXIF: the tags this reads, in IFD0. */
const EXIF_TAG_ORIENTATION = 0x0112;
const EXIF_TAG_X_RESOLUTION = 0x011a;
const EXIF_TAG_Y_RESOLUTION = 0x011b;
const EXIF_TAG_RESOLUTION_UNIT = 0x0128;
const EXIF_TYPE_SHORT = 3;
const EXIF_TYPE_RATIONAL = 5;
const MAX_IFD_ENTRIES = 1024;
const IFD_ENTRY_BYTES = 12;
const EXIF_UNIT_INCH = 2;
const EXIF_UNIT_CM = 3;
const JFIF_UNIT_INCH = 1;
const JFIF_UNIT_CM = 2;

export type JpegOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface JpegPdfPlan {
  width: number;
  height: number;
  components: 1 | 3 | 4;
  /** True when an Adobe APP14 marker is present: a CMYK or YCCK JPEG then holds inverted samples. */
  adobe: boolean;
  /** An embedded ICC profile whose colour model matches the component count, else undefined. */
  icc?: Buffer;
  dpiX: number;
  dpiY: number;
  orientation: JpegOrientation;
}

/** Walks the markers of a JPEG header up to the first scan, with bounds checks; null when it is not a plain JPEG. */
export function planJpegPassthrough(data: Buffer): JpegPdfPlan | null {
  if (data.length < 4 || data[0] !== MARKER_PREFIX || data[1] !== SOI) return null;
  let width = 0;
  let height = 0;
  let components = 0;
  let adobe = false;
  let dpiX = DEFAULT_DENSITY_DPI;
  let dpiY = DEFAULT_DENSITY_DPI;
  let exifDensity: { x: number; y: number } | null = null;
  let jfifDensity: { x: number; y: number } | null = null;
  let orientation: JpegOrientation = 1;
  const iccChunks = new Map<number, Buffer>();
  let iccCount = 0;
  let sawFrame = false;
  let offset = 2;
  while (offset + 2 <= data.length) {
    if (data[offset] !== MARKER_PREFIX) return null;
    let marker = data[offset + 1];
    if (marker === 0) return null;
    offset += 2;
    while (marker === MARKER_PREFIX && offset < data.length) {
      // Fill bytes: any number of 0xFF may precede a marker code.
      marker = data[offset];
      offset += 1;
    }
    if (marker === SOI || marker === TEM || (marker >= RST_FIRST && marker <= RST_LAST)) continue;
    if (marker === EOI) break;
    if (offset + SEGMENT_LENGTH_BYTES > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < SEGMENT_LENGTH_BYTES || offset + length > data.length) return null;
    const body = data.subarray(offset + SEGMENT_LENGTH_BYTES, offset + length);
    if (marker === SOS) break;
    if (PDF_FRAME_MARKERS.has(marker)) {
      if (sawFrame || body.length < SOF_FIXED_BYTES) return null;
      if (body[0] !== SAMPLE_PRECISION) return null;
      height = body.readUInt16BE(1);
      width = body.readUInt16BE(3);
      components = body[5];
      if (body.length !== SOF_FIXED_BYTES + components * SOF_COMPONENT_BYTES) return null;
      sawFrame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // A frame of another coding process (lossless, hierarchical, arithmetic): not readable by a PDF.
      return null;
    } else if (marker === APP0 && body.length >= 14 && body.toString('latin1', 0, 5) === 'JFIF\0') {
      const unit = body[7];
      const xd = body.readUInt16BE(8);
      const yd = body.readUInt16BE(10);
      if (xd > 0 && yd > 0 && unit === JFIF_UNIT_INCH) jfifDensity = { x: xd, y: yd };
      if (xd > 0 && yd > 0 && unit === JFIF_UNIT_CM) jfifDensity = { x: xd * CM_PER_INCH, y: yd * CM_PER_INCH };
    } else if (marker === APP1 && body.length > 6 && body.toString('latin1', 0, 6) === 'Exif\0\0') {
      const exif = readExif(body.subarray(6));
      if (exif.orientation) orientation = exif.orientation;
      if (exif.density) exifDensity = exif.density;
    } else if (marker === APP2 && body.length >= ICC_CHUNK_HEADER_BYTES && body.subarray(0, ICC_TAG.length).equals(ICC_TAG)) {
      const sequence = body[ICC_TAG.length];
      const count = body[ICC_TAG.length + 1];
      if (sequence < 1 || count < 1 || sequence > count) return null;
      iccCount = Math.max(iccCount, count);
      if (iccChunks.has(sequence) || iccChunks.size >= MAX_ICC_CHUNKS) return null;
      iccChunks.set(sequence, body.subarray(ICC_CHUNK_HEADER_BYTES));
    } else if (marker === APP14 && body.length >= ADOBE_MIN_BYTES && body.toString('latin1', 0, ADOBE_TAG.length) === ADOBE_TAG) {
      adobe = true;
    }
    offset += length;
  }
  if (!sawFrame || width < 1 || height < 1 || !SUPPORTED_COMPONENTS.has(components) || components < MIN_COMPONENTS) return null;
  const density = exifDensity ?? jfifDensity;
  if (density) {
    dpiX = density.x;
    dpiY = density.y;
  }
  return {
    width,
    height,
    components: components as 1 | 3 | 4,
    adobe,
    icc: assembleProfile(iccChunks, iccCount, components),
    dpiX,
    dpiY,
    orientation,
  };
}

/** Joins the APP2 chunks of a profile; undefined when they are incomplete or the profile is not for this component count. */
function assembleProfile(chunks: Map<number, Buffer>, count: number, components: number): Buffer | undefined {
  if (count === 0 || chunks.size !== count) return undefined;
  const parts: Buffer[] = [];
  let total = 0;
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const part = chunks.get(sequence);
    if (!part) return undefined;
    total += part.length;
    if (total > JPEG_ICC_MAX_BYTES) {
      throw new ConversionFailedError(`The JPEG's embedded ICC profile is over ${JPEG_ICC_MAX_BYTES} bytes.`);
    }
    parts.push(part);
  }
  const profile = Buffer.concat(parts);
  if (profile.length < ICC_HEADER_BYTES || profile.readUInt32BE(0) !== profile.length) return undefined;
  if (profile.toString('latin1', ICC_SIGNATURE_OFFSET, ICC_SIGNATURE_OFFSET + 4) !== 'acsp') return undefined;
  const model = profile.toString('latin1', ICC_COLOR_SPACE_OFFSET, ICC_COLOR_SPACE_OFFSET + 4);
  return ICC_PROFILE_COMPONENTS[model] === components ? profile : undefined;
}

interface ExifFields {
  orientation?: JpegOrientation;
  density?: { x: number; y: number };
}

/** The orientation and resolution of IFD0 of an EXIF block (a TIFF header and directories), bounds-checked. */
function readExif(tiff: Buffer): ExifFields {
  if (tiff.length < 8) return {};
  const littleEndian = tiff.toString('latin1', 0, 2) === 'II';
  if (!littleEndian && tiff.toString('latin1', 0, 2) !== 'MM') return {};
  const u16 = (at: number): number => (littleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (littleEndian ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return {};
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return {};
  const entries = u16(ifd);
  if (entries > MAX_IFD_ENTRIES || ifd + 2 + entries * IFD_ENTRY_BYTES > tiff.length) return {};
  let orientation: number | undefined;
  let resolution: { x?: number; y?: number } = {};
  let unit = EXIF_UNIT_INCH;
  for (let i = 0; i < entries; i += 1) {
    const at = ifd + 2 + i * IFD_ENTRY_BYTES;
    const tag = u16(at);
    const type = u16(at + 2);
    if (tag === EXIF_TAG_ORIENTATION && type === EXIF_TYPE_SHORT) orientation = u16(at + 8);
    else if (tag === EXIF_TAG_RESOLUTION_UNIT && type === EXIF_TYPE_SHORT) unit = u16(at + 8);
    else if ((tag === EXIF_TAG_X_RESOLUTION || tag === EXIF_TAG_Y_RESOLUTION) && type === EXIF_TYPE_RATIONAL) {
      const valueAt = u32(at + 8);
      if (valueAt + 8 <= tiff.length) {
        const denominator = u32(valueAt + 4);
        const value = denominator === 0 ? 0 : u32(valueAt) / denominator;
        if (tag === EXIF_TAG_X_RESOLUTION) resolution = { ...resolution, x: value };
        else resolution = { ...resolution, y: value };
      }
    }
  }
  const fields: ExifFields = {};
  if (orientation !== undefined && orientation >= 1 && orientation <= 8) fields.orientation = orientation as JpegOrientation;
  const scale = unit === EXIF_UNIT_CM ? CM_PER_INCH : 1;
  if (resolution.x && resolution.y && (unit === EXIF_UNIT_INCH || unit === EXIF_UNIT_CM)) {
    fields.density = { x: resolution.x * scale, y: resolution.y * scale };
  }
  return fields;
}

/** Size of the picture on the page, in points, after the orientation is applied. */
export function pictureSizePoints(plan: JpegPdfPlan): { width: number; height: number } {
  const w = (plan.width * POINTS_PER_INCH) / plan.dpiX;
  const h = (plan.height * POINTS_PER_INCH) / plan.dpiY;
  return plan.orientation >= 5 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * The matrix [a b c d e f] that maps the unit square of an image XObject (origin bottom-left, first row on top)
 * to a picture of `width` x `height` points as the EXIF orientation says it is shown.
 */
export function orientationMatrix(orientation: JpegOrientation, width: number, height: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-width, 0, 0, height, width, 0];
    case 3:
      return [-width, 0, 0, -height, width, height];
    case 4:
      return [width, 0, 0, -height, 0, height];
    case 5:
      return [0, -height, -width, 0, width, height];
    case 6:
      return [0, -height, width, 0, 0, height];
    case 7:
      return [0, height, width, 0, 0, 0];
    case 8:
      return [0, height, -width, 0, width, 0];
    default:
      return [width, 0, 0, height, 0, 0];
  }
}

export interface JpegPageOptions {
  /** Force the page to portrait or landscape; the picture is fitted inside and centred. */
  orientation?: 'portrait' | 'landscape';
}

function colorSpaceOf(doc: PDFDocument, plan: JpegPdfPlan): PDFName | PDFArray {
  const deviceName = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' }[plan.components];
  const device = PDFName.of(deviceName);
  if (plan.icc === undefined) return device;
  const profile = doc.context.stream(zlib.deflateSync(plan.icc), { N: plan.components, Alternate: deviceName, Filter: 'FlateDecode' });
  return doc.context.obj([PDFName.of('ICCBased'), doc.context.register(profile)]);
}

/** One-page PDF holding the JPEG bytes unchanged. Throws InputPixelLimitError when the JPEG declares too many pixels. */
export async function buildJpegPdf(data: Buffer, plan: JpegPdfPlan, options: JpegPageOptions = {}): Promise<Buffer> {
  assertInputPixels(plan.width, plan.height);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const dictionary: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: plan.width,
    Height: plan.height,
    ColorSpace: colorSpaceOf(doc, plan),
    BitsPerComponent: SAMPLE_PRECISION,
    Filter: 'DCTDecode',
  };
  if (plan.components === 4 && plan.adobe) dictionary.Decode = doc.context.obj([1, 0, 1, 0, 1, 0, 1, 0]);
  const image: PDFRef = doc.context.register(doc.context.stream(data, dictionary as Parameters<typeof doc.context.stream>[1]));

  let picture = pictureSizePoints(plan);
  // Readers handle pages up to 14400 points (200 inches) a side; a larger picture is scaled down to fit.
  const shrink = Math.min(1, PDF_MAX_PAGE_POINTS / Math.max(picture.width, picture.height));
  picture = { width: picture.width * shrink, height: picture.height * shrink };
  let page = { width: picture.width, height: picture.height };
  if (options.orientation === 'landscape' && page.width < page.height) page = { width: page.height, height: page.width };
  if (options.orientation === 'portrait' && page.width > page.height) page = { width: page.height, height: page.width };
  // Fit inside the page, centred; a page the size of the picture leaves it at scale 1.
  const scale = Math.min(page.width / picture.width, page.height / picture.height);
  const placed = { width: picture.width * scale, height: picture.height * scale };
  const [a, b, c, d, e, f] = orientationMatrix(plan.orientation, placed.width, placed.height);
  const offsetX = (page.width - placed.width) / 2;
  const offsetY = (page.height - placed.height) / 2;

  const pdfPage = doc.addPage([page.width, page.height]);
  pdfPage.node.setXObject(PDFName.of('Im0'), image);
  pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e + offsetX, f + offsetY), drawObject('Im0'), popGraphicsState());
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
