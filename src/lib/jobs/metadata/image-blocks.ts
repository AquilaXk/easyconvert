import zlib from 'node:zlib';
import { tiffBlockOf } from './exif';

/**
 * The EXIF block and the XMP packet of a JPEG or a PNG as the file stores them, and the file with either one replaced. The bytes
 * of the picture are never decoded or encoded: a block is cut out of the container and another put in its place, so the pixels stay
 * what they were.
 */

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const JPEG_APP0 = 0xe0;
const JPEG_APP1 = 0xe1;
const JPEG_MARKER_PREFIX = 0xff;
const MARKER_BYTES = 2;
const LENGTH_BYTES = 2;
/** The longest payload of one JPEG segment: its length field counts itself. */
const JPEG_MAX_PAYLOAD = 0xffff - LENGTH_BYTES;
const EXIF_SIGNATURE = Buffer.from('Exif\0\0', 'latin1');
const XMP_SIGNATURE = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
/** Markers that stand alone, without a length. */
const STANDALONE_MARKERS: ReadonlySet<number> = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD = 12;
const PNG_EXIF = 'eXIf';
const PNG_TEXT = 'iTXt';
const PNG_DATA = 'IDAT';
const PNG_HEADER = 'IHDR';
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';

/** A file that cannot be walked as the container its name says: cut short, or not that container. */
export class ImageContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageContainerError';
  }
}

/** What a container holds of each block: the TIFF structure of the EXIF block and the text of the XMP packet. */
export interface EmbeddedBlocks {
  exif: Buffer | null;
  xmp: string | null;
}

interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF that starts the segment, and the offset after its last byte. */
  start: number;
  end: number;
  payload: Buffer;
}

/** The segments before the picture data (up to the start of the scan). */
function jpegSegments(file: Buffer): JpegSegment[] {
  if (file.length < MARKER_BYTES || !file.subarray(0, MARKER_BYTES).equals(JPEG_SOI)) throw new ImageContainerError('The file is not a JPEG.');
  const segments: JpegSegment[] = [];
  let at = MARKER_BYTES;
  while (at + MARKER_BYTES <= file.length) {
    if (file[at] !== JPEG_MARKER_PREFIX) throw new ImageContainerError('The JPEG has bytes between its segments.');
    const marker = file[at + 1];
    if (marker === JPEG_MARKER_PREFIX) {
      at += 1;
      continue;
    }
    if (marker === JPEG_SOS || marker === JPEG_EOI) break;
    if (STANDALONE_MARKERS.has(marker)) {
      at += MARKER_BYTES;
      continue;
    }
    if (at + MARKER_BYTES + LENGTH_BYTES > file.length) throw new ImageContainerError('The JPEG is cut short.');
    const length = file.readUInt16BE(at + MARKER_BYTES);
    const end = at + MARKER_BYTES + length;
    if (length < LENGTH_BYTES || end > file.length) throw new ImageContainerError('The JPEG is cut short.');
    segments.push({ marker, start: at, end, payload: file.subarray(at + MARKER_BYTES + LENGTH_BYTES, end) });
    at = end;
  }
  return segments;
}

const startsWith = (payload: Buffer, signature: Buffer): boolean => payload.length >= signature.length && payload.subarray(0, signature.length).equals(signature);

interface PngChunk {
  type: string;
  start: number;
  end: number;
  data: Buffer;
}

function pngChunks(file: Buffer, until: string | null): PngChunk[] {
  if (file.length < PNG_SIGNATURE.length || !file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new ImageContainerError('The file is not a PNG.');
  const chunks: PngChunk[] = [];
  let at = PNG_SIGNATURE.length;
  while (at + PNG_CHUNK_OVERHEAD <= file.length) {
    const length = file.readUInt32BE(at);
    const end = at + PNG_CHUNK_OVERHEAD + length;
    if (end > file.length) throw new ImageContainerError('The PNG is cut short.');
    const type = file.toString('latin1', at + 4, at + 8);
    chunks.push({ type, start: at, end, data: file.subarray(at + 8, at + 8 + length) });
    if (type === until) break;
    at = end;
  }
  return chunks;
}

/** The iTXt text of the XMP packet: keyword, a 0, the compression flag and method, two NUL-ended strings, then the text. */
function xmpOfItxt(data: Buffer): string | null {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 0 || data.toString('latin1', 0, keywordEnd) !== PNG_XMP_KEYWORD) return null;
  const compressed = data[keywordEnd + 1] === 1;
  let at = keywordEnd + 3;
  for (let strings = 0; strings < 2; strings++) {
    const end = data.indexOf(0, at);
    if (end < 0) return null;
    at = end + 1;
  }
  const text = data.subarray(at);
  return (compressed ? zlib.inflateSync(text, { maxOutputLength: 1024 * 1024 }) : text).toString('utf8');
}

/** The blocks of a JPEG or PNG file; null for a block it has not. */
export function readEmbeddedBlocks(file: Buffer, container: 'jpeg' | 'png'): EmbeddedBlocks {
  if (container === 'jpeg') {
    const segments = jpegSegments(file).filter((segment) => segment.marker === JPEG_APP1);
    const exif = segments.find((segment) => startsWith(segment.payload, EXIF_SIGNATURE));
    const xmp = segments.find((segment) => startsWith(segment.payload, XMP_SIGNATURE));
    return {
      exif: exif ? tiffBlockOf(exif.payload) : null,
      xmp: xmp ? xmp.payload.subarray(XMP_SIGNATURE.length).toString('utf8') : null,
    };
  }
  const chunks = pngChunks(file, PNG_DATA);
  const exif = chunks.find((chunk) => chunk.type === PNG_EXIF);
  let xmp: string | null = null;
  for (const chunk of chunks.filter((candidate) => candidate.type === PNG_TEXT)) {
    xmp = xmpOfItxt(chunk.data);
    if (xmp !== null) break;
  }
  return { exif: exif ? tiffBlockOf(exif.data) : null, xmp };
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  if (payload.length > JPEG_MAX_PAYLOAD) throw new ImageContainerError('The block is larger than one JPEG segment holds.');
  const head = Buffer.alloc(MARKER_BYTES + LENGTH_BYTES);
  head[0] = JPEG_MARKER_PREFIX;
  head[1] = marker;
  head.writeUInt16BE(payload.length + LENGTH_BYTES, MARKER_BYTES);
  return Buffer.concat([head, payload]);
}

/** The JPEG with its EXIF block and/or XMP packet set to the given ones (a block left out stays as the file has it). */
function withJpegBlocks(file: Buffer, blocks: Partial<{ exif: Buffer; xmp: Buffer }>): Buffer {
  const segments = jpegSegments(file);
  const exifSegment = jpegSegmentOf(segments, EXIF_SIGNATURE);
  const xmpSegment = jpegSegmentOf(segments, XMP_SIGNATURE);
  const made = (signature: Buffer, block: Buffer): Buffer => jpegSegment(JPEG_APP1, Buffer.concat([signature, block]));

  // The segments that exist are replaced from the last to the first, so the offsets of the ones before stay as they were read.
  let out = file;
  const replaced = [
    { segment: xmpSegment, signature: XMP_SIGNATURE, block: blocks.xmp },
    { segment: exifSegment, signature: EXIF_SIGNATURE, block: blocks.exif },
  ].sort((a, b) => (b.segment?.start ?? 0) - (a.segment?.start ?? 0));
  for (const { segment, signature, block } of replaced) {
    if (segment && block) out = Buffer.concat([out.subarray(0, segment.start), made(signature, block), out.subarray(segment.end)]);
  }
  const added: Buffer[] = [];
  if (blocks.exif && !exifSegment) added.push(made(EXIF_SIGNATURE, blocks.exif));
  if (blocks.xmp && !xmpSegment) added.push(made(XMP_SIGNATURE, blocks.xmp));
  if (added.length === 0) return out;
  // A new block follows the JFIF header when the file starts with one, otherwise it comes first.
  const first = segments[0];
  const at = first?.marker === JPEG_APP0 ? first.end : MARKER_BYTES;
  return Buffer.concat([out.subarray(0, at), ...added, out.subarray(at)]);
}

function jpegSegmentOf(segments: readonly JpegSegment[], signature: Buffer): JpegSegment | undefined {
  return segments.find((segment) => segment.marker === JPEG_APP1 && startsWith(segment.payload, signature));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(PNG_CHUNK_OVERHEAD + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

function xmpChunk(packet: Buffer): Buffer {
  return pngChunk(PNG_TEXT, Buffer.concat([Buffer.from(`${PNG_XMP_KEYWORD}\0\0\0\0\0`, 'latin1'), packet]));
}

/** The PNG with its eXIf chunk and/or XMP iTXt chunk set; a new one goes right after the header chunk, before the picture data. */
function withPngBlocks(file: Buffer, blocks: Partial<{ exif: Buffer; xmp: Buffer }>): Buffer {
  const chunks = pngChunks(file, null);
  if (chunks[0]?.type !== PNG_HEADER) throw new ImageContainerError('The PNG does not start with its header chunk.');
  const existingExif = chunks.find((chunk) => chunk.type === PNG_EXIF);
  const existingXmp = chunks.find((chunk) => chunk.type === PNG_TEXT && xmpOfItxt(chunk.data) !== null);
  const pieces: Buffer[] = [file.subarray(0, PNG_SIGNATURE.length)];
  for (const chunk of chunks) {
    if (chunk === existingExif && blocks.exif) pieces.push(pngChunk(PNG_EXIF, blocks.exif));
    else if (chunk === existingXmp && blocks.xmp) pieces.push(xmpChunk(blocks.xmp));
    else pieces.push(file.subarray(chunk.start, chunk.end));
    if (chunk.type === PNG_HEADER) {
      if (blocks.exif && !existingExif) pieces.push(pngChunk(PNG_EXIF, blocks.exif));
      if (blocks.xmp && !existingXmp) pieces.push(xmpChunk(blocks.xmp));
    }
  }
  const last = chunks[chunks.length - 1];
  pieces.push(file.subarray(last.end));
  return Buffer.concat(pieces);
}

/** The file with the EXIF block and/or the XMP packet given replacing (or added to) the ones it has. */
export function withEmbeddedBlocks(file: Buffer, container: 'jpeg' | 'png', blocks: Partial<{ exif: Buffer; xmp: Buffer }>): Buffer {
  return container === 'jpeg' ? withJpegBlocks(file, blocks) : withPngBlocks(file, blocks);
}
