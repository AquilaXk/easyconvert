import { CadGeometryUnavailableError } from '../types';
import { CGM_CLASS, CGM_ID, CGM_MAX_PARAMETER_BYTES, POINT_BYTES, cgmElement, cgmIntegers, cgmPoints } from './cgm-binary';
import { encodeDib, rgb24DibBytes } from './metafile-dib';
import type { PixelRect } from './svg-raster-regions';

/**
 * A rectangle of a page as a picture, written as the bitmap record of EMF (EMR_STRETCHDIBITS, MS-EMF 2.3.1.7) or WMF
 * (META_STRETCHDIB, MS-WMF 2.3.1.5): a device-independent bitmap (`encodeDib`: a colour table of 1, 4 or 8 bits, run-length coded
 * when shorter, else 24 bits) drawn with SRCCOPY, or as the cell array of a CGM (`cgmCellArray`). The layouts follow the writers of the office suite (`emfwr.cxx` `EMFWriter::ImplWriteBmpRecord`, `wmfwr.cxx` `WMFWriter::WMFRecord_StretchDIB`).
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

/** Bytes of a cell array's parameters before the cells: three points, the two counts, the colour precision and the representation. */
const CGM_CELL_ARRAY_HEADER_BYTES = 3 * POINT_BYTES + 4 * 2;
/**
 * The local colour precision of a cell of direct colour: 24, the 8 bits of each of three components, which is what the office suite's
 * reader takes for a 24-bit direct colour cell (`icgm/bitmap.cxx` `ImplGetDimensions`); it reads 8 as a 256-colour index and draws nothing of a direct colour cell
 * written so. Readers that take the components' width from the metafile's colour precision (8) read the same three octets.
 */
const CGM_CELL_COLOUR_PRECISION = 24;
/** Packed list mode (ISO 8632-3 clause 8.6.9): the cells of a row one after another, each row ending on a word boundary. */
const CGM_PACKED_LIST = 1;
const CGM_PACKED_CELL_BYTES = 3;
/** The command header and the length word of an element. */
const CGM_ELEMENT_HEADER_BYTES = 4;
/** The widest tile: one row of it and the header fit one element. */
const CGM_MAX_TILE_WIDTH = Math.floor((CGM_MAX_PARAMETER_BYTES - CGM_CELL_ARRAY_HEADER_BYTES) / CGM_PACKED_CELL_BYTES) - 1;

function cgmRowBytes(width: number): number {
  const bytes = width * CGM_PACKED_CELL_BYTES;
  return bytes + (bytes % 2);
}

/** The rows of a tile `width` cells wide that fit one element. */
function cgmTileRows(width: number): number {
  return Math.floor((CGM_MAX_PARAMETER_BYTES - CGM_CELL_ARRAY_HEADER_BYTES) / cgmRowBytes(width));
}

/**
 * The cell arrays of a CGM that draw the bitmap on `rect` (scaled by `scale`). An element holds `CGM_MAX_PARAMETER_BYTES` and the office
 * suite's reader reads no partitions, so a bitmap is strips of whole rows (the reader joins strips that meet), and a bitmap wider than
 * one row of an element is cut into columns as well. A cell array has the corner points P (top left), Q (bottom right) and R (top
 * right, the end of the first row) in the VDC space of the picture (`vdcExtent`), whose y axis points down, and the cells row by row from the top as direct colours of 8 bits.
 */
export function cgmCellArrays(bitmap: RegionBitmap, scale: number): Buffer[] {
  const { x0, y0, x1, y1 } = bitmap.rect;
  const edgeX = (column: number) => (x0 + ((x1 - x0) * column) / bitmap.width) * scale;
  const edgeY = (row: number) => (y0 + ((y1 - y0) * row) / bitmap.height) * scale;
  const tileWidth = Math.min(bitmap.width, CGM_MAX_TILE_WIDTH);
  const arrays: Buffer[] = [];
  for (let left = 0; left < bitmap.width; left += tileWidth) {
    const width = Math.min(tileWidth, bitmap.width - left);
    const rowBytes = cgmRowBytes(width);
    const tileRows = cgmTileRows(width);
    for (let top = 0; top < bitmap.height; top += tileRows) {
      const height = Math.min(tileRows, bitmap.height - top);
      const cells = Buffer.alloc(rowBytes * height);
      for (let row = 0; row < height; row++) {
        const from = ((top + row) * bitmap.width + left) * CGM_PACKED_CELL_BYTES;
        bitmap.rgb.copy(cells, row * rowBytes, from, from + width * CGM_PACKED_CELL_BYTES);
      }
      const p = { x: edgeX(left), y: edgeY(top) };
      const q = { x: edgeX(left + width), y: edgeY(top + height) };
      const r = { x: q.x, y: p.y };
      const counts = cgmIntegers(width, height, CGM_CELL_COLOUR_PRECISION, CGM_PACKED_LIST);
      arrays.push(cgmElement(CGM_CLASS.primitive, CGM_ID.cellArray, Buffer.concat([cgmPoints([p, q, r]), counts, cells])));
    }
  }
  return arrays;
}

/** The most a bitmap takes in a record (as 24 bits, which no layout is longer than), for the output cap, before any record is built. */
export function stretchDibRecordBytes(bitmap: Pick<RegionBitmap, 'width' | 'height'>, format: 'emf' | 'wmf' | 'cgm'): number {
  if (format === 'cgm') {
    const tiles = Math.ceil(bitmap.width / CGM_MAX_TILE_WIDTH);
    const width = Math.ceil(bitmap.width / tiles);
    return tiles * Math.ceil(bitmap.height / cgmTileRows(width)) * (CGM_ELEMENT_HEADER_BYTES + CGM_CELL_ARRAY_HEADER_BYTES) + cgmRowBytes(bitmap.width) * bitmap.height;
  }
  return (format === 'emf' ? EMF_STRETCHDIBITS_HEADER_BYTES : WMF_STRETCHDIB_HEADER_BYTES) + rgb24DibBytes(bitmap);
}
