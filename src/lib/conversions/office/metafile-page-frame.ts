/**
 * The page of an EMF or WMF file: the frame its header declares, in points.
 *
 * The reference import filter makes the page of a metafile the frame of its header and not the box of what is drawn. The
 * rules below are its rules (behaviour only, the source is GPL; Inkscape 1.4 `src/extension/internal/emf-inout.cpp` lines
 * 1832-1878 and `wmf-inout.cpp` lines 1602-1666, `src/3rdparty/libuemf/uwmf.c` `wmfheader_get` and `U_WMRRECSAFE_get`):
 *
 * - EMF: the page is rclFrame of EMR_HEADER ([MS-EMF] 2.2.9), in 0.01 mm, both edges inside the frame (+1 on each axis). A file
 *   whose description is "Adobe Systems" and whose record after the header is EMR_SETMAPMODE with MM_ANISOTROPIC was written
 *   by Adobe Illustrator, which stores the frame 30/25.4 too large (`AI_hack`, emf-inout.cpp 1486-1502 and 1856-1862).
 * - WMF: the page is the destination box of META_PLACEABLE ([MS-WMF] 2.3.2.3) over its logical units per inch (0 counts as
 *   1440), both edges inside the box. With no placeable header or an empty box, the first META_SETWINDOWEXT record gives the
 *   box (0, 0, x, y); a file that ends first is A4 landscape.
 *
 * What the reference leaves open is bounded here, and a header outside the bounds gives no page (the caller then keeps the
 * office suite's own page): the sizes a PDF page may have (PDF 32000-1 Annex C implementation limits, 3 to 14400 units), the
 * area the raster chain draws at its default resolution without leaving the page-bitmap limit, the header sizes of the format,
 * and the records of a WMF read once, each at least as long as a record header and inside the first mebibyte of the file.
 * Only the first bytes of a file are read (`metafileLeadingBytes`), so a caller holding the file on disk reads no more.
 */

const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;
/** The smallest and largest page a PDF reader is required to handle (PDF 32000-1 Annex C.2, "Page size": 3 to 14,400 units). */
export const MIN_METAFILE_PAGE_POINTS = 3;
export const MAX_METAFILE_PAGE_POINTS = 14_400;
/**
 * The most a page may cover, in square points: the page whose raw RGB bitmap at the default raster resolution (150 dpi,
 * `resolvePdfRasterDpi`) is the largest the PNG route holds in memory (`PPM_PAGE_MAX_BYTES`, 128 MiB, `src/worker/poppler-ppm.ts`),
 * which is 3,210 points on a side for a square page and holds an A0 sheet (2,384 by 3,370 points, 8.0 million of the 10.3 million).
 * A header can name any size, and the JPEG and TIFF pages are drawn without a bound on their bitmap, so a larger page keeps the
 * office suite's own A4 page, which has always fitted.
 */
const RASTER_PAGE_MAX_BYTES = 128 * 1024 * 1024;
const RASTER_DEFAULT_DPI = 150;
const RASTER_CHANNELS = 3;
export const MAX_METAFILE_PAGE_AREA_POINTS = RASTER_PAGE_MAX_BYTES / RASTER_CHANNELS / (RASTER_DEFAULT_DPI / POINTS_PER_INCH) ** 2;

export type MetafileFormat = 'emf' | 'wmf';

export interface MetafilePage {
  widthPt: number;
  heightPt: number;
}

const EMR_HEADER = 1;
const EMR_SETMAPMODE = 17;
const MM_ANISOTROPIC = 8;
/** EMR_HEADER without a description ([MS-EMF] 2.2.9: Type, Size, Bounds, Frame, RecordSignature, Version, Bytes, Records, Handles, Reserved, nDescription, offDescription, nPalEntries, Device, Millimeters). */
const EMF_HEADER_BYTES = 88;
/** The reader looks at the header and the record after it; a real header is 88 bytes and its description (a producer's name) a few dozen, so a header larger than this has no page. */
const EMF_LEADING_MAX_BYTES = 64 * 1024;
const EMF_SIGNATURE_OFFSET = 40;
const EMF_SIGNATURE = 0x464d4520;
const EMF_FRAME_OFFSET = 24;
const EMF_DESCRIPTION_LENGTH_OFFSET = 60;
const EMF_DESCRIPTION_OFFSET_OFFSET = 64;
const EMF_SETMAPMODE_RECORD_BYTES = 12;
const EMF_FRAME_UNITS_PER_MM = 100;
const ADOBE_PRODUCER = 'Adobe Systems';
const ADOBE_FRAME_SCALE = MM_PER_INCH / (10 * 3);

const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
/** META_PLACEABLE: Key, HWmf, BoundingBox (four INT16), Inch, Reserved, Checksum. */
const WMF_PLACEABLE_BYTES = 22;
const WMF_BOX_OFFSET = 6;
const WMF_INCH_OFFSET = 14;
const DEFAULT_WMF_UNITS_PER_INCH = 1440;
/** META_HEADER: Type (1 in memory, 2 on disk), HeaderSize, Version, Size (two words), NumberOfObjects, MaxRecord, NumberOfMembers. */
const WMF_HEADER_BYTES = 18;
const WMF_METAFILE_TYPES: readonly number[] = [1, 2];
const WMF_HEADER_SIZE_WORDS_OFFSET = 2;
/** A record is its size in words (4 bytes) and its function (2 bytes), then the parameters. */
const WMF_RECORD_HEADER_BYTES = 6;
const WMF_SETWINDOWEXT_RECORD_BYTES = 10;
const WMF_FUNCTION_OFFSET = 4;
/** The function numbers of META_EOF and META_SETWINDOWEXT are told apart by their low byte (uwmf.h enumerates them so). */
const WMF_EOF_FUNCTION = 0x00;
const WMF_SETWINDOWEXT_FUNCTION = 0x0c;
const A4_LANDSCAPE_MM = { width: 297, height: 210 };
/**
 * The records of a WMF are read from the first mebibyte of the file: the reference reads them all, but the window extent is an
 * early record of every file measured (the 3rd, 5th and 7th record, within the first 26 KiB, of the three real WMF files
 * of the real-world corpus: lo-visio_import_source, lo-testroundrect and tika-testwmf), and a scan of the whole file would walk the
 * 44 million six-byte records that 256 MiB can hold. A file whose records run past this give no page.
 */
const WMF_LEADING_MAX_BYTES = 1024 * 1024;

function pageOf(widthPt: number, heightPt: number): MetafilePage | undefined {
  const inRange = (points: number): boolean => Number.isFinite(points) && points >= MIN_METAFILE_PAGE_POINTS && points <= MAX_METAFILE_PAGE_POINTS;
  return inRange(widthPt) && inRange(heightPt) && widthPt * heightPt <= MAX_METAFILE_PAGE_AREA_POINTS ? { widthPt, heightPt } : undefined;
}

/** Whether the record after the header of an Enhanced Metafile is the anisotropic map mode and its description names Adobe's producer. */
function isAdobeIllustratorFile(emf: Buffer, headerBytes: number): boolean {
  const units = emf.readUInt32LE(EMF_DESCRIPTION_LENGTH_OFFSET);
  const offset = emf.readUInt32LE(EMF_DESCRIPTION_OFFSET_OFFSET);
  if (units < ADOBE_PRODUCER.length || offset < EMF_HEADER_BYTES || offset + units * 2 > headerBytes) return false;
  const description = emf.subarray(offset, offset + units * 2).toString('utf16le');
  const producerEnds = units === ADOBE_PRODUCER.length || description.charCodeAt(ADOBE_PRODUCER.length) === 0;
  if (!description.startsWith(ADOBE_PRODUCER) || !producerEnds) return false;
  const next = headerBytes;
  if (next + EMF_SETMAPMODE_RECORD_BYTES > emf.length) return false;
  return emf.readUInt32LE(next) === EMR_SETMAPMODE && emf.readUInt32LE(next + 8) === MM_ANISOTROPIC;
}

function emfPage(file: Buffer): MetafilePage | undefined {
  const emf = file.subarray(0, EMF_LEADING_MAX_BYTES);
  if (emf.length < EMF_HEADER_BYTES || emf.readUInt32LE(0) !== EMR_HEADER || emf.readUInt32LE(EMF_SIGNATURE_OFFSET) !== EMF_SIGNATURE) return undefined;
  const headerBytes = emf.readUInt32LE(4);
  if (headerBytes < EMF_HEADER_BYTES || headerBytes % 4 !== 0 || headerBytes > emf.length) return undefined;
  let width = emf.readInt32LE(EMF_FRAME_OFFSET + 8) - emf.readInt32LE(EMF_FRAME_OFFSET) + 1;
  let height = emf.readInt32LE(EMF_FRAME_OFFSET + 12) - emf.readInt32LE(EMF_FRAME_OFFSET + 4) + 1;
  if (isAdobeIllustratorFile(emf, headerBytes)) {
    width *= ADOBE_FRAME_SCALE;
    height *= ADOBE_FRAME_SCALE;
  }
  const pointsPerUnit = POINTS_PER_INCH / MM_PER_INCH / EMF_FRAME_UNITS_PER_MM;
  return pageOf(width * pointsPerUnit, height * pointsPerUnit);
}

/** The size in bytes of the record at `offset`, or 0 when it is shorter than a record or runs past the end (`U_WMRRECSAFE_get`). */
function wmfRecordBytes(wmf: Buffer, offset: number): number {
  if (offset + WMF_RECORD_HEADER_BYTES > wmf.length) return 0;
  const bytes = wmf.readUInt32LE(offset) * 2;
  return bytes < WMF_RECORD_HEADER_BYTES || offset + bytes > wmf.length ? 0 : bytes;
}

/** The first META_SETWINDOWEXT of the records from `offset`, or the A4 landscape box when the file ends first; undefined when a record is invalid. */
function firstWindowExtent(wmf: Buffer, offset: number, unitsPerInch: number): { width: number; height: number } | undefined {
  for (let at = offset; ; ) {
    const bytes = wmfRecordBytes(wmf, at);
    if (bytes === 0) return undefined;
    const fn = wmf.readUInt8(at + WMF_FUNCTION_OFFSET);
    if (fn === WMF_SETWINDOWEXT_FUNCTION) {
      if (bytes < WMF_SETWINDOWEXT_RECORD_BYTES) return undefined;
      return { width: wmf.readInt16LE(at + 8), height: wmf.readInt16LE(at + 6) };
    }
    if (fn === WMF_EOF_FUNCTION) {
      return { width: Math.round((unitsPerInch * A4_LANDSCAPE_MM.width) / MM_PER_INCH), height: Math.round((unitsPerInch * A4_LANDSCAPE_MM.height) / MM_PER_INCH) };
    }
    at += bytes;
  }
}

function wmfPage(file: Buffer): MetafilePage | undefined {
  const wmf = file.subarray(0, WMF_LEADING_MAX_BYTES);
  const placeable = wmf.length >= 4 && wmf.readUInt32LE(0) === WMF_PLACEABLE_KEY;
  const headerAt = placeable ? WMF_PLACEABLE_BYTES : 0;
  if (headerAt + WMF_HEADER_BYTES > wmf.length || !WMF_METAFILE_TYPES.includes(wmf.readUInt16LE(headerAt))) return undefined;
  const headerBytes = wmf.readUInt16LE(headerAt + WMF_HEADER_SIZE_WORDS_OFFSET) * 2;
  if (headerBytes < WMF_HEADER_BYTES || headerAt + headerBytes > wmf.length) return undefined;
  const unitsPerInch = (placeable ? wmf.readUInt16LE(WMF_INCH_OFFSET) : 0) || DEFAULT_WMF_UNITS_PER_INCH;
  let [left, top, right, bottom] = placeable ? [0, 2, 4, 6].map((at) => wmf.readInt16LE(WMF_BOX_OFFSET + at)) : [0, 0, 0, 0];
  if (right === 0 && left === 0) {
    const extent = firstWindowExtent(wmf, headerAt + headerBytes, unitsPerInch);
    if (extent === undefined) return undefined;
    [left, top, right, bottom] = [0, 0, extent.width, extent.height];
  }
  const pointsPerUnit = POINTS_PER_INCH / unitsPerInch;
  return pageOf((right - left + 1) * pointsPerUnit, (bottom - top + 1) * pointsPerUnit);
}

/** How many leading bytes of a file of the format `readMetafilePage` reads: a caller that holds the file on disk needs no more to ask for its page. */
export function metafileLeadingBytes(format: MetafileFormat): number {
  return format === 'emf' ? EMF_LEADING_MAX_BYTES : WMF_LEADING_MAX_BYTES;
}

/** The page of the metafile in points, or undefined when its header does not declare one inside the bounds above. */
export function readMetafilePage(metafile: Buffer, format: MetafileFormat): MetafilePage | undefined {
  return format === 'emf' ? emfPage(metafile) : wmfPage(metafile);
}
