/**
 * Hand-written EXIF Orientation fixture builder and reader (CIPA DC-008 / TIFF 6.0 IFD0). It does not use
 * the converter or sharp, so it is an independent oracle for orientation handling.
 */

const TAG_ORIENTATION = 0x0112;
const TYPE_SHORT = 3;
const TIFF_MAGIC = 42;
const IFD_ENTRY_BYTES = 12;
const IFD0_OFFSET = 8;

const JPEG_SOI = 0xffd8;
const JPEG_APP0 = 0xffe0;
const JPEG_APP1 = 0xffe1;
const JPEG_SOS = 0xffda;
const JPEG_MARKER_BYTES = 2;
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD = 12;
const RIFF_HEADER_BYTES = 12;
const RIFF_CHUNK_HEADER_BYTES = 8;

export const ORIENTATION_VALUES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Minimal little-endian TIFF block holding exactly one IFD0 entry: Orientation. */
export function buildTiffWithOrientation(orientation: number): Buffer {
  const tiff = Buffer.alloc(IFD0_OFFSET + 2 + IFD_ENTRY_BYTES + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(TIFF_MAGIC, 2);
  tiff.writeUInt32LE(IFD0_OFFSET, 4);
  tiff.writeUInt16LE(1, IFD0_OFFSET);
  const entry = IFD0_OFFSET + 2;
  tiff.writeUInt16LE(TAG_ORIENTATION, entry);
  tiff.writeUInt16LE(TYPE_SHORT, entry + 2);
  tiff.writeUInt32LE(1, entry + 4);
  tiff.writeUInt16LE(orientation, entry + 8);
  return tiff;
}

/** Inserts an EXIF APP1 segment with the given Orientation into a JPEG, after its JFIF APP0 when present. */
export function injectExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  if (jpeg.readUInt16BE(0) !== JPEG_SOI) throw new Error('not a JPEG');
  let insertAt = JPEG_MARKER_BYTES;
  if (jpeg.readUInt16BE(insertAt) === JPEG_APP0) {
    insertAt += JPEG_MARKER_BYTES + jpeg.readUInt16BE(insertAt + JPEG_MARKER_BYTES);
  }
  const payload = Buffer.concat([EXIF_HEADER, buildTiffWithOrientation(orientation)]);
  const segment = Buffer.alloc(JPEG_MARKER_BYTES + 2 + payload.length);
  segment.writeUInt16BE(JPEG_APP1, 0);
  segment.writeUInt16BE(2 + payload.length, JPEG_MARKER_BYTES);
  payload.copy(segment, JPEG_MARKER_BYTES + 2);
  return Buffer.concat([jpeg.subarray(0, insertAt), segment, jpeg.subarray(insertAt)]);
}

/** Reads IFD0 Orientation from a bare TIFF block; undefined when the tag is absent. */
export function readTiffOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < IFD0_OFFSET) return undefined;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const little = order === 'II';
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== TIFF_MAGIC) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * IFD_ENTRY_BYTES;
    if (entry + IFD_ENTRY_BYTES > tiff.length) return undefined;
    if (u16(entry) === TAG_ORIENTATION) return u16(entry + 8);
  }
  return undefined;
}

function exifPayloadToTiff(payload: Buffer): Buffer {
  return payload.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER) ? payload.subarray(EXIF_HEADER.length) : payload;
}

function jpegOrientation(jpeg: Buffer): number | undefined {
  let pos = JPEG_MARKER_BYTES;
  while (pos + JPEG_MARKER_BYTES + 2 <= jpeg.length) {
    const marker = jpeg.readUInt16BE(pos);
    if (marker === JPEG_SOS) return undefined;
    const length = jpeg.readUInt16BE(pos + JPEG_MARKER_BYTES);
    const payload = jpeg.subarray(pos + JPEG_MARKER_BYTES + 2, pos + JPEG_MARKER_BYTES + length);
    if (marker === JPEG_APP1 && payload.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)) {
      return readTiffOrientation(exifPayloadToTiff(payload));
    }
    pos += JPEG_MARKER_BYTES + length;
  }
  return undefined;
}

function pngOrientation(png: Buffer): number | undefined {
  let pos = PNG_SIGNATURE_BYTES;
  while (pos + PNG_CHUNK_OVERHEAD <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    if (type === 'eXIf') return readTiffOrientation(exifPayloadToTiff(png.subarray(pos + 8, pos + 8 + length)));
    pos += PNG_CHUNK_OVERHEAD + length;
  }
  return undefined;
}

function webpOrientation(webp: Buffer): number | undefined {
  let pos = RIFF_HEADER_BYTES;
  while (pos + RIFF_CHUNK_HEADER_BYTES <= webp.length) {
    const type = webp.toString('latin1', pos, pos + 4);
    const length = webp.readUInt32LE(pos + 4);
    if (type === 'EXIF') {
      return readTiffOrientation(exifPayloadToTiff(webp.subarray(pos + RIFF_CHUNK_HEADER_BYTES, pos + RIFF_CHUNK_HEADER_BYTES + length)));
    }
    pos += RIFF_CHUNK_HEADER_BYTES + length + (length % 2);
  }
  return undefined;
}

/**
 * Reads the EXIF Orientation stored in an encoded JPEG, PNG, WebP or TIFF without decoding pixels.
 * Returns undefined when the file carries no Orientation tag.
 */
export function readExifOrientation(encoded: Buffer): number | undefined {
  if (encoded.length >= JPEG_MARKER_BYTES && encoded.readUInt16BE(0) === JPEG_SOI) return jpegOrientation(encoded);
  if (encoded.subarray(1, 4).toString('latin1') === 'PNG') return pngOrientation(encoded);
  if (encoded.toString('latin1', 0, 4) === 'RIFF' && encoded.toString('latin1', 8, 12) === 'WEBP') {
    return webpOrientation(encoded);
  }
  return readTiffOrientation(encoded);
}
