import type { SharpOptions } from 'sharp';

/**
 * The segment structure of a JPEG stream: where it ends, and whether its first scan was reached. A stream that ends inside the
 * entropy-coded data is decoded for the part it holds (`truncatedJpegDecodeOptions`); one that ends before the first scan has no pixels.
 */

export const JPEG_SOI_MARKER = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_TEM = 0x01;
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;
const JPEG_SOI = 0xd8;
const JPEG_MARKER_BYTES = 2;

export interface JpegStreamWalk {
  /** Offset just past the EOI marker, or -1 when the stream ends without one. */
  end: number;
  /** True once a start-of-scan header has been read in full, so the entropy-coded data of a scan began. */
  scanStarted: boolean;
}

function isRestartMarker(marker: number): boolean {
  return marker >= JPEG_RST_FIRST && marker <= JPEG_RST_LAST;
}

/** Offset of the next marker in the entropy-coded data that starts at `pos` (a stuffed 0xFF00 and a restart marker belong to the data). */
function skipEntropyCodedData(buffer: Buffer, from: number): number {
  let pos = from;
  while (pos + 1 < buffer.length) {
    const next = buffer[pos + 1];
    if (buffer[pos] === JPEG_MARKER_PREFIX && next !== 0 && !isRestartMarker(next)) break;
    pos += 1;
  }
  return pos;
}

/**
 * Walks the segments of the JPEG stream that starts at `start`. Walking segments (instead of searching for the first EOI bytes)
 * keeps an Exif thumbnail nested inside an APPn segment from ending the stream early.
 */
export function walkJpegStream(buffer: Buffer, start: number): JpegStreamWalk {
  let pos = start + JPEG_MARKER_BYTES;
  let scanStarted = false;
  while (pos + 1 < buffer.length) {
    if (buffer[pos] !== JPEG_MARKER_PREFIX) return { end: -1, scanStarted };
    const marker = buffer[pos + 1];
    if (marker === JPEG_MARKER_PREFIX) {
      pos += 1;
      continue;
    }
    if (marker === JPEG_EOI) return { end: pos + JPEG_MARKER_BYTES, scanStarted };
    if (marker === JPEG_TEM || marker === JPEG_SOI || isRestartMarker(marker)) {
      pos += JPEG_MARKER_BYTES;
      continue;
    }
    if (pos + 3 >= buffer.length) return { end: -1, scanStarted };
    pos += JPEG_MARKER_BYTES + buffer.readUInt16BE(pos + JPEG_MARKER_BYTES);
    if (marker === JPEG_SOS) {
      scanStarted = pos <= buffer.length;
      pos = skipEntropyCodedData(buffer, pos);
    }
  }
  return { end: -1, scanStarted };
}

/** Offset just past the EOI marker of the JPEG stream that starts at `start`, or -1 when the stream is truncated. */
export function findJpegEnd(buffer: Buffer, start: number): number {
  return walkJpegStream(buffer, start).end;
}

/**
 * Decoder options for a JPEG that ends inside its scan data, which the reference service's decoder (libjpeg under ImageMagick) reads
 * as far as it goes and fills the rest of: libjpeg reports "Premature end of JPEG file" as a warning, not an error. The library's default
 * turns every warning into a failure, so this one case opens with `failOn: 'none'`; a complete stream keeps the default, and a stream that
 * ends before its first scan keeps it too (nothing in it can be decoded, and the library refuses it).
 */
export function truncatedJpegDecodeOptions(buffer: Buffer): SharpOptions {
  if (!buffer.subarray(0, JPEG_SOI_MARKER.length).equals(JPEG_SOI_MARKER)) return {};
  const { end, scanStarted } = walkJpegStream(buffer, 0);
  return end === -1 && scanStarted ? { failOn: 'none' } : {};
}
