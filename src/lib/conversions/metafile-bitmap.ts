import { CadGeometryUnavailableError } from '../types';
import { encodeDib, rgb24DibBytes } from './metafile-dib';
import type { PixelRect } from './svg-raster-regions';

/**
 * A rectangle of a page as a picture, written as the bitmap record of EMF (EMR_STRETCHDIBITS, MS-EMF 2.3.1.7) or WMF
 * (META_STRETCHDIB, MS-WMF 2.3.1.5): a device-independent bitmap (`encodeDib`: a colour table of 1, 4 or 8 bits, run-length coded
 * when shorter, else 24 bits) drawn with SRCCOPY. The layouts follow the writers of the office suite (`emfwr.cxx` `EMFWriter::ImplWriteBmpRecord`, `wmfwr.cxx` `WMFWriter::WMFRecord_StretchDIB`).
 */

/** What the picture of a region holds: top-down RGB rows (3 bytes a pixel), `width` by `height` pixels, standing for `rect` of the page. */
export interface RegionBitmap {
  rect: PixelRect;
  width: number;
  height: number;
  rgb: Buffer;
}

const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const EMR_STRETCHDIBITS = 81;
/** Type, Size, Bounds (16), xDest, yDest, xSrc, ySrc, cxSrc, cySrc (24), four offsets and sizes (16), Usage, ROP (8), cxDest, cyDest (8). */
const EMF_STRETCHDIBITS_HEADER_BYTES = 80;
const META_STRETCHDIB = 0x0f43;
/** RecordSize (4), RecordFunction (2), RasterOperation (4), ColorUsage (2), eight 16-bit rectangle fields. */
const WMF_STRETCHDIB_HEADER_BYTES = 28;
const INT16_MAX = 0x7fff;

/** EMR_STRETCHDIBITS: the bitmap drawn on `rect` (scaled by `scale` into the logical units of the file). */
export function emfStretchDib(bitmap: RegionBitmap, scale: number): Buffer {
  const { dib, infoBytes, bitsBytes } = encodeDib(bitmap);
  const record = Buffer.alloc(EMF_STRETCHDIBITS_HEADER_BYTES + dib.length);
  const x = Math.round(bitmap.rect.x0 * scale);
  const y = Math.round(bitmap.rect.y0 * scale);
  const width = Math.round((bitmap.rect.x1 - bitmap.rect.x0) * scale);
  const height = Math.round((bitmap.rect.y1 - bitmap.rect.y0) * scale);
  record.writeUInt32LE(EMR_STRETCHDIBITS, 0);
  record.writeUInt32LE(record.length, 4);
  // Bounds are inclusive device coordinates.
  record.writeInt32LE(x, 8);
  record.writeInt32LE(y, 12);
  record.writeInt32LE(x + width - 1, 16);
  record.writeInt32LE(y + height - 1, 20);
  record.writeInt32LE(x, 24);
  record.writeInt32LE(y, 28);
  record.writeInt32LE(0, 32);
  record.writeInt32LE(0, 36);
  record.writeInt32LE(bitmap.width, 40);
  record.writeInt32LE(bitmap.height, 44);
  record.writeUInt32LE(EMF_STRETCHDIBITS_HEADER_BYTES, 48); // offBmiSrc
  record.writeUInt32LE(infoBytes, 52); // cbBmiSrc: the header and the colour table
  record.writeUInt32LE(EMF_STRETCHDIBITS_HEADER_BYTES + infoBytes, 56); // offBitsSrc
  record.writeUInt32LE(bitsBytes, 60); // cbBitsSrc
  record.writeUInt32LE(DIB_RGB_COLORS, 64);
  record.writeUInt32LE(SRCCOPY, 68);
  record.writeInt32LE(width, 72);
  record.writeInt32LE(height, 76);
  dib.copy(record, EMF_STRETCHDIBITS_HEADER_BYTES);
  return record;
}

function int16(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || Math.abs(rounded) > INT16_MAX) {
    throw new CadGeometryUnavailableError(`A page region at ${rounded} does not fit the 16-bit metafile range.`);
  }
  return rounded;
}

/** META_STRETCHDIB: the bitmap drawn on `rect` (scaled by `scale` into the logical units of the file). */
export function wmfStretchDib(bitmap: RegionBitmap, scale: number): Buffer {
  const { dib } = encodeDib(bitmap);
  const record = Buffer.alloc(WMF_STRETCHDIB_HEADER_BYTES + dib.length);
  record.writeUInt32LE(record.length / 2, 0);
  record.writeUInt16LE(META_STRETCHDIB, 4);
  record.writeUInt32LE(SRCCOPY, 6);
  record.writeUInt16LE(DIB_RGB_COLORS, 10);
  record.writeInt16LE(int16(bitmap.height), 12); // SrcHeight
  record.writeInt16LE(int16(bitmap.width), 14); // SrcWidth
  record.writeInt16LE(0, 16); // YSrc
  record.writeInt16LE(0, 18); // XSrc
  record.writeInt16LE(int16((bitmap.rect.y1 - bitmap.rect.y0) * scale), 20); // DestHeight
  record.writeInt16LE(int16((bitmap.rect.x1 - bitmap.rect.x0) * scale), 22); // DestWidth
  record.writeInt16LE(int16(bitmap.rect.y0 * scale), 24); // yDst
  record.writeInt16LE(int16(bitmap.rect.x0 * scale), 26); // xDst
  dib.copy(record, WMF_STRETCHDIB_HEADER_BYTES);
  return record;
}

/** The most a bitmap takes in a record (as 24 bits, which no layout is longer than), for the output cap, before any record is built. */
export function stretchDibRecordBytes(bitmap: Pick<RegionBitmap, 'width' | 'height'>, format: 'emf' | 'wmf'): number {
  return (format === 'emf' ? EMF_STRETCHDIBITS_HEADER_BYTES : WMF_STRETCHDIB_HEADER_BYTES) + rgb24DibBytes(bitmap);
}
